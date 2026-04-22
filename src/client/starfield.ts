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

  private focusedStar: number | null = null;
  private vectorTo: number | null = null;
  private monochrome = false;

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

  getFocusedStar(): number | null { return this.focusedStar; }
  getVectorTo(): number | null { return this.vectorTo; }
  getMonochrome(): boolean { return this.monochrome; }

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

  private attachEvents() {
    window.addEventListener('resize', this.onResize);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
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

  private animate = () => {
    if (this.disposed) return;
    this.controls.update();
    this.material.uniforms.uCameraPos.value.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    for (const h of this.onFrameHandlers) h();
    requestAnimationFrame(this.animate);
  };

  dispose() {
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}

export { ALL_SPECT_MASK };
