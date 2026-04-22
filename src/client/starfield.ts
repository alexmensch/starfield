import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { Catalog } from './catalog-loader';
import vertexShader from './shaders/star.vert.glsl?raw';
import fragmentShader from './shaders/star.frag.glsl?raw';

export interface FilterState {
  minDistSol: number;
  maxDistSol: number;
  maxAppMag: number;
  spectMask: number;
  highlightCon: number; // -1 = none; consumed by overlay, not shader
  sizeMin: number;
  sizeMax: number;
  sizeSpan: number;
}

export interface StarfieldOptions {
  canvas: HTMLCanvasElement;
  catalog: Catalog;
}

const ALL_SPECT_MASK = 0b111111111;

// Warp animation tuning. A warp has two phases:
//   1. Reorient (WARP_REORIENT_MS) — camera keeps looking at the source star
//      while spherically rotating around it from its current orbit direction
//      to the "behind A, facing B" direction, simultaneously zooming to
//      WARP_END_OFFSET_PC from A. End state: A is centered, B is straight
//      ahead beyond A.
//   2. Fly — straight-line flight from pStart to pEnd with a symmetric
//      accelerate/decelerate profile. Duration scales log-linearly with
//      distance and caps at MAX.
// End offset is the same on both sides of the trip: as close as we can get
// to a star without tripping the near-plane.
export const WARP_T_MIN_MS = 5000;
export const WARP_T_MAX_MS = 20000;
export const WARP_T_K_MS = 2000;
export const WARP_REORIENT_MS = 2000;
export const WARP_END_OFFSET_PC = 0.005;

// Arbitrary reference axis for the reorient slerp. Any fixed unit vector
// works — the two setFromUnitVectors calls each produce a quaternion rotating
// this vector to one of the two endpoints, and slerp between them gives the
// shortest-arc interpolation on the sphere.
const WARP_BASE_DIR = new THREE.Vector3(0, 0, 1);

interface WarpState {
  startTimeMs: number;
  reorientMs: number;
  durationMs: number;
  A: THREE.Vector3;        // source star world position
  dir0: THREE.Vector3;     // unit vector from A toward camera at warp start
  mag0: number;            // |camera - A| at warp start
  dirBack: THREE.Vector3;  // unit vector from A away from B (reorient end direction)
  pStart: THREE.Vector3;   // fly start = A + dirBack * WARP_END_OFFSET_PC
  pEnd: THREE.Vector3;     // fly end = B - forward * WARP_END_OFFSET_PC
  destIdx: number;
}

export const DEFAULT_FILTER: FilterState = {
  minDistSol: 0,
  maxDistSol: 50_000,
  maxAppMag: 6.5,
  spectMask: ALL_SPECT_MASK,
  highlightCon: -1,
  sizeMin: 2.0,
  sizeMax: 24.0,
  sizeSpan: 6.0,
};

export class Starfield {
  readonly catalog: Catalog;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: TrackballControls;

  private scene: THREE.Scene;
  private points: THREE.Points;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;

  private filter: FilterState = { ...DEFAULT_FILTER };

  private disposed = false;
  private onFocusHandlers: Array<(starIndex: number | null) => void> = [];
  private onFrameHandlers: Array<() => void> = [];
  private onFilterHandlers: Array<(f: Readonly<FilterState>) => void> = [];
  private onVectorHandlers: Array<(toIdx: number | null) => void> = [];
  private onStateHandlers: Array<() => void> = [];
  private onWarpHandlers: Array<(active: boolean) => void> = [];

  private focusedStar: number | null = null;
  private vectorTo: number | null = null;
  private monochrome = false;
  private warpState: WarpState | null = null;

  constructor({ canvas, catalog }: StarfieldOptions) {
    this.catalog = catalog;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();

    // Near plane must be strictly smaller than controls.minDistance,
    // otherwise a maximally-zoomed-in star lands on the clip plane and
    // disappears at the closest zoom.
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.001,
      200_000,
    );
    this.camera.position.set(0, 0, 30);

    // TrackballControls (instead of OrbitControls) because we want
    // unconstrained rotation — no polar clamping at the zenith/nadir, so
    // the user can orbit past the poles continuously.
    this.controls = new TrackballControls(this.camera, canvas);
    this.controls.rotateSpeed = 3.0;
    this.controls.zoomSpeed = 1.1;
    this.controls.panSpeed = 0.6;
    this.controls.noPan = false;
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.15;
    this.controls.minDistance = 0.005;
    this.controls.maxDistance = 100_000;
    this.controls.target.set(0, 0, 0);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(catalog.positions, 3));
    this.geometry.setAttribute('aAbsmag', new THREE.BufferAttribute(catalog.absmag, 1));
    this.geometry.setAttribute('aCi', new THREE.BufferAttribute(catalog.ci, 1));
    this.geometry.setAttribute('aSpectClass', new THREE.BufferAttribute(catalog.spectClass, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60_000);

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uMaxAppMag: { value: this.filter.maxAppMag },
        uMinDistSol: { value: this.filter.minDistSol },
        uMaxDistSol: { value: this.filter.maxDistSol },
        uSpectMask: { value: this.filter.spectMask },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uSizeMin: { value: this.filter.sizeMin },
        uSizeMax: { value: this.filter.sizeMax },
        uSizeSpan: { value: this.filter.sizeSpan },
        uMonochrome: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // Seed focus on Sol if it exists so measurement works from the start.
    if (catalog.solIndex >= 0) this.focusedStar = catalog.solIndex;

    this.attachEvents();
    this.animate();
  }

  onFocusChange(h: (starIndex: number | null) => void) { this.onFocusHandlers.push(h); }
  onFrame(h: () => void) { this.onFrameHandlers.push(h); }
  onFilterChange(h: (f: Readonly<FilterState>) => void) { this.onFilterHandlers.push(h); }
  onVectorChange(h: (toIdx: number | null) => void) { this.onVectorHandlers.push(h); }
  onStateChange(h: () => void) { this.onStateHandlers.push(h); }
  onWarpChange(h: (active: boolean) => void) { this.onWarpHandlers.push(h); }

  getFocusedStar(): number | null { return this.focusedStar; }
  getVectorTo(): number | null { return this.vectorTo; }
  getMonochrome(): boolean { return this.monochrome; }
  getWarpActive(): boolean { return this.warpState !== null; }

  private setFocus(idx: number | null) {
    if (this.focusedStar === idx) return;
    this.focusedStar = idx;
    for (const h of this.onFocusHandlers) h(idx);
    this.fireStateChange();
  }

  setVectorTo(idx: number | null) {
    if (this.vectorTo === idx) return;
    this.vectorTo = idx;
    for (const h of this.onVectorHandlers) h(idx);
    this.fireStateChange();
  }

  unfocus() {
    if (this.focusedStar === null && this.vectorTo === null) return;
    this.setVectorTo(null);
    this.setFocus(null);
  }

  private fireStateChange() {
    for (const h of this.onStateHandlers) h();
  }

  setFilter(patch: Partial<FilterState>) {
    Object.assign(this.filter, patch);
    const u = this.material.uniforms;
    u.uMaxAppMag.value = this.filter.maxAppMag;
    u.uMinDistSol.value = this.filter.minDistSol;
    u.uMaxDistSol.value = this.filter.maxDistSol;
    u.uSpectMask.value = this.filter.spectMask;
    u.uSizeMin.value = this.filter.sizeMin;
    u.uSizeMax.value = this.filter.sizeMax;
    u.uSizeSpan.value = this.filter.sizeSpan;
    for (const h of this.onFilterHandlers) h(this.filter);
    this.fireStateChange();
  }

  getFilter(): Readonly<FilterState> { return this.filter; }

  setMonochrome(on: boolean) {
    if (this.monochrome === on) return;
    this.monochrome = on;
    this.material.uniforms.uMonochrome.value = on ? 1 : 0;
    // Additive blending over a dark canvas makes bright stars glow; multiply
    // blending over a light canvas makes darker stars "ink" the page.
    this.material.blending = on ? THREE.MultiplyBlending : THREE.AdditiveBlending;
    this.material.needsUpdate = true;
    this.renderer.setClearColor(on ? 0xf5f2ea : 0x000000, on ? 1 : 0);
    this.fireStateChange();
  }

  focusStar(starIndex: number, distancePc = 2) {
    const target = this.starWorldPosition(starIndex);
    const offset = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
      .normalize()
      .multiplyScalar(distancePc);
    if (offset.lengthSq() === 0) offset.set(0, 0, distancePc);
    this.camera.position.copy(target).add(offset);
    this.controls.target.copy(target);
    this.controls.update();
    this.setVectorTo(null);
    this.setFocus(starIndex);
  }

  setOrbitTarget(starIndex: number) {
    this.controls.target.copy(this.starWorldPosition(starIndex));
    this.controls.update();
    this.setFocus(starIndex);
  }

  // Start an animated journey from the focused star to `destIdx`. Camera
  // flies in a straight line with a symmetric accelerate/decelerate profile.
  // Orbit controls are disabled for the duration; overlays listening to
  // onWarpChange are expected to hide themselves so they don't flail against
  // the moving camera. No-ops if there's no focus, the destination equals
  // the focus, or the two stars are coincident.
  warpTo(destIdx: number) {
    if (this.warpState) return;
    const fromIdx = this.focusedStar;
    if (fromIdx === null || destIdx === fromIdx) return;
    const A = this.starWorldPosition(fromIdx);
    const B = this.starWorldPosition(destIdx);
    const AB = new THREE.Vector3().subVectors(B, A);
    const distPc = AB.length();
    if (distPc < 1e-6) return;
    const forward = AB.clone().divideScalar(distPc);

    // Reorient-end direction (from A): opposite to the travel direction, so
    // after the reorient A is in front of the camera and B is further along
    // the same line.
    const dirBack = forward.clone().negate();
    const pStart = A.clone().addScaledVector(dirBack, WARP_END_OFFSET_PC);
    const pEnd = B.clone().addScaledVector(forward, -WARP_END_OFFSET_PC);

    const p0 = this.camera.position.clone();
    const radial = new THREE.Vector3().subVectors(p0, A);
    const mag0 = radial.length();
    // If the user is somehow exactly at A (shouldn't happen; minDistance
    // guards against it), seed an arbitrary direction so the reorient still
    // runs instead of NaN-ing out.
    const dir0 = mag0 > 1e-9 ? radial.divideScalar(mag0) : dirBack.clone();

    const durationMs = Math.min(
      WARP_T_MAX_MS,
      WARP_T_MIN_MS + WARP_T_K_MS * Math.log10(1 + distPc),
    );

    this.controls.enabled = false;
    // Point orbit-target at the destination from the moment the warp begins
    // so the scale bar reflects distance-to-destination throughout the flight
    // (decreases monotonically from ~|AB| to WARP_END_OFFSET_PC). Otherwise
    // it would show distance-to-A during the flight and snap at arrival.
    // Camera orientation is controlled separately via camera.lookAt during
    // updateWarp, so the reorient phase can still keep A centered visually.
    this.controls.target.copy(B);
    this.warpState = {
      startTimeMs: performance.now(),
      reorientMs: WARP_REORIENT_MS,
      durationMs,
      A,
      dir0,
      mag0,
      dirBack,
      pStart,
      pEnd,
      destIdx,
    };
    for (const h of this.onWarpHandlers) h(true);
    this.fireStateChange();
  }

  // Jump to the end state of an in-flight warp. Equivalent to letting the
  // animation run to completion.
  skipWarp() {
    if (!this.warpState) return;
    this.finishWarp();
  }

  private finishWarp() {
    const state = this.warpState;
    if (!state) return;
    const B = this.starWorldPosition(state.destIdx);
    // Park at the configured end offset so orbit radius matches the arrival
    // we animated to — no visible snap between the last fly frame and the
    // parked state.
    const forward = new THREE.Vector3().subVectors(B, state.pStart).normalize();
    this.camera.position.copy(B).addScaledVector(forward, -WARP_END_OFFSET_PC);
    this.controls.target.copy(B);
    this.warpState = null;
    this.controls.enabled = true;
    this.controls.update();
    this.setVectorTo(null);
    this.setFocus(state.destIdx);
    for (const h of this.onWarpHandlers) h(false);
  }

  // Swing the camera to face the selected constellation while keeping the
  // orbit target and orbit radius unchanged — only the camera's position on
  // the orbit sphere moves. The aim point is the brightness-weighted
  // centroid of the figure stars as seen from the current target, so a
  // constellation looks "centered" on whichever of its members visually
  // dominate from the user's current vantage, even when the user has
  // travelled deep into 3D space.
  aimAtConstellation(conIndex: number) {
    const cons = this.catalog.constellations;
    const lines = conIndex >= 0 && conIndex < cons.length ? cons[conIndex].lines : undefined;
    if (!lines || lines.length === 0) return;

    const seen = new Set<number>();
    for (const polyline of lines) for (const i of polyline) seen.add(i);
    if (seen.size === 0) return;

    const positions = this.catalog.positions;
    const absmag = this.catalog.absmag;
    const t = this.controls.target;

    const scored: Array<{ idx: number; appMag: number }> = [];
    for (const i of seen) {
      const dx = positions[i * 3] - t.x;
      const dy = positions[i * 3 + 1] - t.y;
      const dz = positions[i * 3 + 2] - t.z;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.001);
      const appMag = absmag[i] + 5 * (Math.log10(dist) - 1);
      scored.push({ idx: i, appMag });
    }
    scored.sort((a, b) => a.appMag - b.appMag);
    const top = scored.slice(0, Math.min(8, scored.length));

    const c = new THREE.Vector3();
    for (const { idx } of top) {
      c.x += positions[idx * 3];
      c.y += positions[idx * 3 + 1];
      c.z += positions[idx * 3 + 2];
    }
    c.divideScalar(top.length);

    const dir = new THREE.Vector3().subVectors(c, t);
    if (dir.lengthSq() < 1e-6) return; // aim point coincides with target
    dir.normalize();

    const r = this.camera.position.distanceTo(t);
    // Put the camera on the opposite side of target from the centroid at the
    // current orbit radius — the forward vector (target − position) then
    // points toward the centroid.
    this.camera.position.copy(t).addScaledVector(dir, -r);
    this.controls.update();
  }

  starWorldPosition(i: number): THREE.Vector3 {
    const p = this.catalog.positions;
    return new THREE.Vector3(p[i * 3 + 0], p[i * 3 + 1], p[i * 3 + 2]);
  }

  pickStar(clientX: number, clientY: number, pixelThreshold = 16): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const ndcThresholdX = (pixelThreshold / rect.width) * 2;
    const ndcThresholdY = (pixelThreshold / rect.height) * 2;

    const camPos = this.camera.position;
    const positions = this.catalog.positions;
    const { absmag, spectClass } = this.catalog;
    const f = this.filter;
    const v = new THREE.Vector3();

    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.catalog.count; i++) {
      const x = positions[i * 3 + 0];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const distSol = Math.sqrt(x * x + y * y + z * z);
      if (distSol < f.minDistSol || distSol > f.maxDistSol) continue;
      const bit = 1 << (spectClass[i] | 0);
      if (!(f.spectMask & bit)) continue;
      const dx = x - camPos.x;
      const dy = y - camPos.y;
      const dz = z - camPos.z;
      const dCam = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.001);
      const appMag = absmag[i] + 5 * (Math.log10(dCam) - 1);
      if (appMag > f.maxAppMag) continue;

      v.set(x, y, z).project(this.camera);
      if (v.z < -1 || v.z > 1) continue;
      const pdx = (v.x - ndcX) / ndcThresholdX;
      const pdy = (v.y - ndcY) / ndcThresholdY;
      const ndcDistSq = pdx * pdx + pdy * pdy;
      if (ndcDistSq > 1) continue;

      const score = ndcDistSq + appMag * 0.0005;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private pointerDownAt: { x: number; y: number; t: number } | null = null;
  private twoFingerAngle: number | null = null;
  private gestureLastRotation = 0;

  private attachEvents() {
    window.addEventListener('resize', this.onResize);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    // Two-finger roll. Touch events for mobile; gesture* events for Safari
    // desktop trackpad. Chrome/Firefox desktop don't expose a rotate gesture,
    // so roll is unavailable there by design.
    canvas.addEventListener('touchstart', this.onTouchStart);
    canvas.addEventListener('touchmove', this.onTouchMove);
    canvas.addEventListener('touchend', this.onTouchEnd);
    canvas.addEventListener('touchcancel', this.onTouchEnd);
    canvas.addEventListener('gesturestart', this.onGestureStart as EventListener);
    canvas.addEventListener('gesturechange', this.onGestureChange as EventListener);
  }

  private onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.pointerDownAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    if (!down) return;
    if (this.warpState) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (dx * dx + dy * dy > 25) return;
    if (performance.now() - down.t > 500) return;
    const idx = this.pickStar(e.clientX, e.clientY);
    if (idx < 0) return;

    // Interaction state machine:
    //  - no focus            → focus on clicked star
    //  - click focused, no vector → unfocus (clicking again deselects)
    //  - click focused, vector drawn → clear vector (keep focus)
    //  - click vector tip    → travel there, clear vector
    //  - click other star    → draw/replace vector from focus to clicked
    if (this.focusedStar === null) {
      this.setOrbitTarget(idx);
      return;
    }
    if (idx === this.focusedStar) {
      if (this.vectorTo !== null) this.setVectorTo(null);
      else this.unfocus();
      return;
    }
    if (idx === this.vectorTo) {
      this.setVectorTo(null);
      this.setOrbitTarget(idx);
      return;
    }
    this.setVectorTo(idx);
  };

  private onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      this.twoFingerAngle = this.touchAngle(e.touches);
    } else {
      this.twoFingerAngle = null;
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    if (e.touches.length !== 2 || this.twoFingerAngle === null) return;
    const a = this.touchAngle(e.touches);
    let d = a - this.twoFingerAngle;
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    this.twoFingerAngle = a;
    this.rollCamera(-d);
  };

  private onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length !== 2) this.twoFingerAngle = null;
  };

  private touchAngle(t: TouchList): number {
    return Math.atan2(
      t[1].clientY - t[0].clientY,
      t[1].clientX - t[0].clientX,
    );
  }

  private onGestureStart = (e: Event) => {
    e.preventDefault();
    this.gestureLastRotation = 0;
  };

  private onGestureChange = (e: Event) => {
    e.preventDefault();
    const rot = (e as Event & { rotation: number }).rotation;
    const delta = ((rot - this.gestureLastRotation) * Math.PI) / 180;
    this.gestureLastRotation = rot;
    this.rollCamera(-delta);
  };

  // Rotate the camera's up vector around the view direction. TrackballControls
  // reads camera.up on every update() so the new orientation persists through
  // subsequent orbit/zoom without needing to touch the controls' internals.
  private rollCamera(angle: number) {
    const forward = new THREE.Vector3()
      .subVectors(this.controls.target, this.camera.position);
    if (forward.lengthSq() === 0) return;
    forward.normalize();
    this.camera.up.applyAxisAngle(forward, angle).normalize();
  }

  private animate = () => {
    if (this.disposed) return;
    if (this.warpState) {
      this.updateWarp();
    } else {
      this.controls.update();
    }
    this.material.uniforms.uCameraPos.value.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    for (const h of this.onFrameHandlers) h();
    requestAnimationFrame(this.animate);
  };

  private updateWarp() {
    const state = this.warpState;
    if (!state) return;
    const elapsed = performance.now() - state.startTimeMs;

    if (elapsed < state.reorientMs) {
      // Reorient phase: spherically slerp the camera's radial direction from
      // the user's starting angle around A to `dirBack`, while linearly
      // easing the distance from A from `mag0` down to WARP_END_OFFSET_PC.
      // Look-at stays locked on A so A remains centered in view the whole
      // time. Quaternion slerp robustly handles any starting angle including
      // antipodal cases (user looking at A from the B side).
      const u = elapsed / state.reorientMs;
      const f = u * u * (3 - 2 * u);

      this.warpQ0.setFromUnitVectors(WARP_BASE_DIR, state.dir0);
      this.warpQ1.setFromUnitVectors(WARP_BASE_DIR, state.dirBack);
      this.warpQ0.slerp(this.warpQ1, f);
      this.warpTmp.copy(WARP_BASE_DIR).applyQuaternion(this.warpQ0);

      const mag = state.mag0 * (1 - f) + WARP_END_OFFSET_PC * f;
      this.camera.position.copy(state.A).addScaledVector(this.warpTmp, mag);
      this.camera.lookAt(state.A);
      return;
    }

    // Fly phase: symmetric accelerate/decelerate along the A→B line.
    const flyElapsed = elapsed - state.reorientMs;
    const t = Math.min(flyElapsed / state.durationMs, 1);
    const f = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    this.camera.position.lerpVectors(state.pStart, state.pEnd, f);
    const B = this.starWorldPosition(state.destIdx);
    this.camera.lookAt(B);
    if (t >= 1) this.finishWarp();
  }

  private warpTmp = new THREE.Vector3();
  private warpQ0 = new THREE.Quaternion();
  private warpQ1 = new THREE.Quaternion();

  dispose() {
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('touchstart', this.onTouchStart);
    canvas.removeEventListener('touchmove', this.onTouchMove);
    canvas.removeEventListener('touchend', this.onTouchEnd);
    canvas.removeEventListener('touchcancel', this.onTouchEnd);
    canvas.removeEventListener('gesturestart', this.onGestureStart as EventListener);
    canvas.removeEventListener('gesturechange', this.onGestureChange as EventListener);
    this.controls.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}

export { ALL_SPECT_MASK };
