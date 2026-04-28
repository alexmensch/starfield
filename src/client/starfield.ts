import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { Catalog } from './catalog-loader';
import type { DustField, DustParticleData } from './dust-loader';
import vertexShader from './shaders/star.vert.glsl?raw';
import fragmentShader from './shaders/star.frag.glsl?raw';
import dustParticleVert from './shaders/dust-particle.vert.glsl?raw';
import dustParticleFrag from './shaders/dust-particle.frag.glsl?raw';
import { GalacticDisc } from './galactic-disc';
import { GalacticGrid } from './galactic-grid';
import { GalacticArrows } from './galactic-arrows';
import { GALACTIC_CENTRE_PC } from './galactic-coords';
import { MolecularClouds, cloudViewingDistancePc } from './molecular-clouds';
import type { CloudCatalog } from './cloud-loader';
import { MilkyWay } from './milkyway';

export type MagPresetName = 'naked-eye' | 'binoculars' | 'all';

export interface FilterState {
  minDistSol: number;
  maxDistSol: number;
  maxAppMag: number;
  spectMask: number;
  highlightCon: number; // -1 = none; consumed by overlay, not shader
  sizeMin: number;      // CSS pixels — set from the active preset's angular
  sizeMax: number;      // size at the current viewport, or by manual slider.
  sizeSpan: number;
  // Active magnitude preset. Drives preset-defaults behaviour when the
  // viewport resizes — non-overridden size fields recompute against this
  // preset's angular targets so stars stay proportional to the scene
  // (especially the Milky Way disc) regardless of screen size.
  activePreset: MagPresetName;
  // Manual-override flags for the size sliders. Set by slider input,
  // cleared by the corresponding reset button (which also re-applies the
  // active preset's value). When false, the preset writes its computed
  // pixel value into the field on each preset switch and viewport resize.
  sizeMinOverridden: boolean;
  sizeMaxOverridden: boolean;
  sizeSpanOverridden: boolean;
  // Galactic coordinate sphere + Sol/GC arrows toggle. Disc is always-on
  // (fades by zoom) so it isn't gated here.
  showGalacticOverlays: boolean;
  // Molecular cloud overlay (Phase 3a). Default-on; toggle suppresses both
  // 3D rendering and hover/pick.
  showMolecularClouds: boolean;
  // Milky Way analytic background (Phase 5). Default-on; suppressed in
  // chart mode regardless. May be force-flipped off by the FPS probe on
  // the first few frames if the device can't sustain ≥30 fps with it on.
  showMilkyway: boolean;
}

export interface StarfieldOptions {
  canvas: HTMLCanvasElement;
  catalog: Catalog;
}

const ALL_SPECT_MASK = 0b111111111;

// Star size physics. The unaided eye's stellar PSF has a Gaussian-ish
// width σ ≈ 30″ set by ocular aberrations + diffraction; "perceived disc"
// is where intensity exceeds detection threshold, which from the Gaussian
// PSF model gives radius = σ × √(STAR_PHYSICS_FACTOR × Δm) for Δm
// magnitudes above threshold. STAR_PHYSICS_FACTOR = 2 ln(10) / 2.5 ≈ 1.84.
//
// Literal physics at 60° / 1080 px puts threshold disc at ~0.15 px and
// Sirius at ~0.6 px — both invisible. starExaggerationK scales σ up to
// land in a readable pixel range while preserving the √Δm curve between
// stars (so ratios stay correct against the Milky Way disc).
//
// Tunable at runtime via Starfield.setStarExaggerationK so the debug
// panel can sweep it visually. Higher = bolder, more cartoonish stars;
// lower = more austere, nearer the literal physics.
const STAR_PSF_ARCSEC = 30;
const STAR_PHYSICS_FACTOR = 1.84;
let starExaggerationK = 16;

interface MagPreset {
  maxAppMag: number;
  sizeSpan: number;
  sizeMinArcsec: number;
  sizeMaxArcsec: number;
}

// Static portion of each preset — the magnitude limit and dynamic range
// don't depend on the exaggeration constant. sizeMinArcsec / sizeMaxArcsec
// are recomputed from the current K via computeMagPresets().
const PRESET_BASE: Record<MagPresetName, { maxAppMag: number; sizeSpan: number }> = {
  // Magnitudes: naked eye 6.5 (Bortle-1 dark sky); binoculars 10.5 (typical
  // 7×50 dark sky); all 15 (matches the catalog/UI slider ceiling).
  'naked-eye':  { maxAppMag: 6.5,  sizeSpan: 8 },
  'binoculars': { maxAppMag: 10.5, sizeSpan: 12 },
  'all':        { maxAppMag: 15,   sizeSpan: 17 },
};

function computeMagPresets(): Record<MagPresetName, MagPreset> {
  const sizeMinArcsec = STAR_PSF_ARCSEC * starExaggerationK;
  const result = {} as Record<MagPresetName, MagPreset>;
  for (const name of Object.keys(PRESET_BASE) as MagPresetName[]) {
    const base = PRESET_BASE[name];
    result[name] = {
      ...base,
      sizeMinArcsec,
      sizeMaxArcsec: sizeMinArcsec * Math.sqrt(STAR_PHYSICS_FACTOR * base.sizeSpan),
    };
  }
  return result;
}

// Live binding — re-bound by setStarExaggerationK so consumers reading
// MAG_PRESETS see the latest values after a K tweak.
export let MAG_PRESETS: Record<MagPresetName, MagPreset> = computeMagPresets();

// Default minimum orbit distance from a focused star. Per-focus code below
// may bump this for binary systems so both components stay in the viewport.
const DEFAULT_MIN_DIST_PC = 0.005;

// Default vertical FOV (degrees). User-tunable via the FOV slider; the
// reset button snaps back to this value.
export const DEFAULT_FOV = 50;

// When a focused star has a binary companion, minDistance is set so the
// companion subtends at most this half-angle from the camera axis — gives
// the system a bit of viewport padding. tan(25°) ≈ 0.466; we store 1/tan.
const BINARY_VIEWPORT_HALF_ANGLE_RAD = (25 * Math.PI) / 180;
const BINARY_MIN_DIST_FACTOR = 1 / Math.tan(BINARY_VIEWPORT_HALF_ANGLE_RAD);

// Warp animation tuning. A warp has two phases:
//   1. Reorient (WARP_REORIENT_MS) — camera keeps looking at the source star
//      while spherically rotating around it from its current orbit direction
//      to the "behind A, facing B" direction, simultaneously zooming to
//      the end-offset from A. End state: A is centered, B is straight
//      ahead beyond A.
//   2. Fly — straight-line flight from pStart to pEnd with a symmetric
//      accelerate/decelerate profile. Duration scales log-linearly with
//      distance and caps at MAX.
// End offset matches the destination star's effective minDistance so the
// warp parks exactly where the user can then orbit.
export const WARP_T_MIN_MS = 5000;
export const WARP_T_MAX_MS = 20000;
export const WARP_T_K_MS = 2000;
export const WARP_REORIENT_MS = 2000;

// Arbitrary reference axis for the reorient slerp. Any fixed unit vector
// works — the two setFromUnitVectors calls each produce a quaternion rotating
// this vector to one of the two endpoints, and slerp between them gives the
// shortest-arc interpolation on the sphere.
const WARP_BASE_DIR = new THREE.Vector3(0, 0, 1);

// Aim animation: rotate the camera around `controls.target` so a chosen
// world point lands at the centre of the view. Capped at 2 s so even a
// 180° swing stays snappy; floored at 250 ms so trivial nudges still ease.
export const AIM_T_MAX_MS = 2000;
export const AIM_T_MIN_MS = 250;

export { DEFAULT_MIN_DIST_PC };

interface AimState {
  startTimeMs: number;
  durationMs: number;
  q0: THREE.Quaternion;       // rotates WARP_BASE_DIR to the start radial dir
  q1: THREE.Quaternion;       // rotates WARP_BASE_DIR to the end radial dir
  radius: number;             // |camera - target| at click; held constant
  pivot: THREE.Vector3;       // controls.target snapshot, in local frame
}

interface WarpState {
  startTimeMs: number;
  reorientMs: number;
  durationMs: number;
  A: THREE.Vector3;        // source world position (focused star or cloud centroid)
  dir0: THREE.Vector3;     // unit vector from A toward camera at warp start
  mag0: number;            // |camera - A| at warp start
  dirBack: THREE.Vector3;  // unit vector from A away from B (reorient end direction)
  pStart: THREE.Vector3;   // fly start = A + dirBack * endOffset
  pEnd: THREE.Vector3;     // fly end = B - forward * endOffset
  endOffset: number;       // arrival viewing distance for the destination
  destKind: 'star' | 'cloud';
  destIdx: number;
}

type Target = { kind: 'star'; idx: number } | { kind: 'cloud'; idx: number };
function sameTarget(a: Target | null, b: Target | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.idx === b.idx;
}

export const DEFAULT_FILTER: FilterState = {
  minDistSol: 0,
  maxDistSol: 50_000,
  maxAppMag: MAG_PRESETS['naked-eye'].maxAppMag,
  spectMask: ALL_SPECT_MASK,
  highlightCon: -1,
  // sizeMin/Max placeholders — applyMagnitudePreset is called from the
  // constructor with the actual viewport to fill in real values, and again
  // on every viewport resize.
  sizeMin: 1.8,
  sizeMax: 7.0,
  sizeSpan: MAG_PRESETS['naked-eye'].sizeSpan,
  activePreset: 'naked-eye',
  sizeMinOverridden: false,
  sizeMaxOverridden: false,
  sizeSpanOverridden: false,
  showGalacticOverlays: false,
  showMolecularClouds: true,
  showMilkyway: true,
};

export class Starfield {
  readonly catalog: Catalog;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: TrackballControls;

  private scene: THREE.Scene;
  private discMesh: THREE.Mesh;
  private glowMesh: THREE.Mesh;
  // Dust particles — null until attachDustParticles() builds the geometry.
  // Rendered as instanced additive billboards over the star scene; off by
  // default (uParticleStrength = 0) for the realism-first opening view.
  private particleMesh: THREE.Mesh | null = null;
  private particleMaterial: THREE.ShaderMaterial | null = null;
  // Shared uniforms object so changing uMaxAppMag/uSpectMask/etc. affects
  // both passes. The per-pass uRenderMode differs; we split into two
  // materials but give them the same uniforms map (minus uRenderMode).
  private material: THREE.ShaderMaterial;      // disc pass (opaque)
  private glowMaterial: THREE.ShaderMaterial;  // glow pass (additive)
  private geometry: THREE.InstancedBufferGeometry;

  // Floating origin to dodge float32 catastrophic cancellation when zoomed
  // close to stars far from Sol. `worldOffset` is the absolute-space
  // coordinate that currently sits at the renderer's local origin (0,0,0).
  // `_localPositions` mirrors catalog.positions shifted by -worldOffset and
  // is the buffer bound to the iPosition instance attribute; overlays read
  // from it via the `localPositions` getter so every projection math path
  // operates in the same frame as the camera. Recentering on focus change
  // keeps all large-magnitude subtractions on the CPU side (JS Number =
  // float64), so the GPU never sees kiloparsec-scale translations in its
  // modelview matrix.
  private worldOffset = new THREE.Vector3();
  private _localPositions: Float32Array;
  private iPositionAttr!: THREE.InstancedBufferAttribute;

  private filter: FilterState = { ...DEFAULT_FILTER };

  private disposed = false;
  private onFocusHandlers: Array<(starIndex: number | null) => void> = [];
  private onCloudFocusHandlers: Array<(cloudIndex: number | null) => void> = [];
  private onFrameHandlers: Array<() => void> = [];
  private onFilterHandlers: Array<(f: Readonly<FilterState>) => void> = [];
  private onVectorHandlers: Array<(toIdx: number | null) => void> = [];
  private onVectorCloudHandlers: Array<(toCloudIdx: number | null) => void> = [];
  private onStateHandlers: Array<() => void> = [];
  private onWarpHandlers: Array<(active: boolean) => void> = [];

  private focusedStar: number | null = null;
  // "Soft" focus on a molecular cloud — mutually exclusive with focusedStar.
  // Drives the focus search box and meta bar so the user-facing "what am I
  // looking at" reads as the cloud name. Star-specific UI (focus ring,
  // distance vector, warp source, floating-origin recenter) ignores this.
  private focusedCloud: number | null = null;
  // Distance-vector destination — at most one of these is non-null at a
  // time. Mutual exclusion is enforced by setVectorTo / setVectorToCloud
  // both clearing the other slot.
  private vectorTo: number | null = null;
  private vectorToCloud: number | null = null;
  private monochrome = false;
  private warpState: WarpState | null = null;
  private aimState: AimState | null = null;
  // Scratch quaternion + direction reused by updateAim each frame so the
  // animation never allocates.
  private aimQ = new THREE.Quaternion();
  private aimTmpDir = new THREE.Vector3();

  // Galactic reference layers (Phase 4c). Disc fades in by camera-distance
  // from Sol and is always-on; grid + arrows are gated by
  // `filter.showGalacticOverlays`. Mono mode swaps strokes to a paper-chart
  // palette via setMonochrome on each layer.
  private galacticDisc: GalacticDisc;
  private galacticGrid: GalacticGrid;
  private galacticArrows: GalacticArrows;

  // Molecular cloud overlay (Phase 3a). null until attachClouds() runs;
  // the layer loads asynchronously after the catalog and search index so
  // first paint isn't gated on it.
  private clouds: MolecularClouds | null = null;

  // Milky Way analytic background (Phase 5). Constructed eagerly so the
  // band is on during first paint. Dust is wired in once the volumetric
  // texture attaches. The composite mesh lives in `this.scene` at
  // renderOrder = -2 so it draws behind everything; the analytic raymarch
  // pass renders into a private half-res RT each frame.
  private milkyway: MilkyWay;

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
      DEFAULT_FOV,
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
    this.controls.minDistance = DEFAULT_MIN_DIST_PC;
    this.controls.maxDistance = 100_000;
    this.controls.target.set(0, 0, 0);

    // Precompute log10(physicalRadius) per star for the shader, and the
    // catalog-wide min/max for uniform bounds. Done once at load so the
    // vertex shader can just do a linear mix. Luminosity class is
    // converted from Uint8 to Float32 since the vertex attribute is a
    // float; 255 (unknown) survives the conversion and is handled inside
    // the shader.
    const logRadii = new Float32Array(catalog.count);
    const lumClassF32 = new Float32Array(catalog.count);
    const distSol = new Float32Array(catalog.count);
    let logRMin = Infinity;
    let logRMax = -Infinity;
    for (let i = 0; i < catalog.count; i++) {
      const r = Math.max(catalog.physicalRadius[i], 1e-6);
      const lr = Math.log10(r);
      logRadii[i] = lr;
      if (lr < logRMin) logRMin = lr;
      if (lr > logRMax) logRMax = lr;
      lumClassF32[i] = catalog.luminosityClass[i];
      const x = catalog.positions[i * 3];
      const y = catalog.positions[i * 3 + 1];
      const z = catalog.positions[i * 3 + 2];
      distSol[i] = Math.sqrt(x * x + y * y + z * z);
    }
    // Local-frame position buffer — starts identical to catalog.positions
    // since worldOffset is (0,0,0) at construction. Recenter rewrites this
    // in place.
    this._localPositions = new Float32Array(catalog.positions);
    const physMaxPx = this.computePhysMaxPx();

    // Instanced quads: one unit square per star, expanded in screen space in
    // the vertex shader. This replaces the earlier THREE.Points approach,
    // which was capped by the driver-defined gl_PointSize maximum (often
    // 64–255 px) — too small for the physical-size rendering to reach the
    // 50%-viewport ceiling we want for supergiants at close range.
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute(
      'aCorner',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
        2,
      ),
    );
    this.geometry.setIndex([0, 1, 2, 1, 3, 2]);
    this.iPositionAttr = new THREE.InstancedBufferAttribute(this._localPositions, 3);
    // iPosition is dynamic: overwritten on every recenterOrigin().
    this.iPositionAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iPosition', this.iPositionAttr);
    this.geometry.setAttribute('iAbsmag', new THREE.InstancedBufferAttribute(catalog.absmag, 1));
    this.geometry.setAttribute('iCi', new THREE.InstancedBufferAttribute(catalog.ci, 1));
    this.geometry.setAttribute('iSpectClass', new THREE.InstancedBufferAttribute(catalog.spectClass, 1));
    this.geometry.setAttribute('iLogRadius', new THREE.InstancedBufferAttribute(logRadii, 1));
    this.geometry.setAttribute('iPeriodDays', new THREE.InstancedBufferAttribute(catalog.periodDays, 1));
    this.geometry.setAttribute('iAmplitudeMag', new THREE.InstancedBufferAttribute(catalog.amplitudeMag, 1));
    this.geometry.setAttribute('iLumClass', new THREE.InstancedBufferAttribute(lumClassF32, 1));
    // Precomputed distance-from-Sol per star. The shader's distSol filter
    // used to derive this from length(iPosition), but iPosition is now
    // local-frame (camera-relative when focused) so the computed length is
    // no longer distance from Sol. Precomputing is also ~one sqrt per
    // vertex cheaper than the old path.
    this.geometry.setAttribute('iDistSol', new THREE.InstancedBufferAttribute(distSol, 1));
    this.geometry.instanceCount = catalog.count;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60_000);

    // Shared uniforms — both materials point at the same objects, so any
    // setFilter / theme / resize update propagates to both passes without
    // duplicate bookkeeping. uRenderMode is the only divergent uniform and
    // is bound directly to its material.
    const sharedUniforms = {
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
      uLogRMin: { value: logRMin },
      uLogRMax: { value: logRMax },
      uPhysMinPx: { value: 2.0 },
      uPhysMaxPx: { value: physMaxPx },
      uRefDistPc: { value: DEFAULT_MIN_DIST_PC },
      uViewport: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      // Variability time. uTime advances in real seconds; uSecondsPerDay is
      // the compression factor — lower values make catalog periods cycle
      // faster on-screen. uMinPeriodSec clamps the shortest cycle so sub-day
      // variables (RR Lyrae, Algol) don't pulse too rapidly to read. 4 s is
      // a comfortable floor — Algol's 0.57 s natural cycle becomes 4 s,
      // clearly visible but not jarring.
      uTime: { value: 0 },
      uSecondsPerDay: { value: 0.2 },
      uMinPeriodSec: { value: 4.0 },

      // Interstellar-dust extinction. Off by default (uDustEnabled = 0) —
      // attachDust() wires in the Data3DTexture progressively as chunks
      // arrive from the network and bumps uDustEnabled to 1 once the
      // texture is GPU-resident. A separate uExtinctionStrength is a
      // user-facing knob (0 = off, 1 = realism, >1 = amplified).
      //
      // The shader reconstructs absolute positions via iPosition +
      // uWorldOffset / uCameraPos + uWorldOffset, then raymarches through
      // the dust texture in ICRS heliocentric pc to integrate A_V.
      uDustTexture: { value: null as THREE.Data3DTexture | null },
      uDustBoundsPc: { value: 1250.0 },
      // Log-window decode: density = uDustDensityMin * exp(sample * uDustLogRatio).
      // Defaults are overwritten by attachDust() with the manifest's
      // autotuned range; this placeholder avoids divide-by-zero if the
      // shader runs before dust attaches.
      uDustDensityMin: { value: 1e-7 },
      uDustLogRatio: { value: Math.log(1e3) },
      uDustAvPerDensityPc: { value: 2.742 },
      uDustEnabled: { value: 0.0 },
      uExtinctionStrength: { value: 1.0 },
      uWorldOffset: { value: new THREE.Vector3() },
    };

    // Disc pass: opaque-over (premultiplied alpha) so close stars fully
    // occlude anything behind. Rendered first with depth write on so the
    // glow pass can depth-test against the disc silhouettes.
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...sharedUniforms, uRenderMode: { value: 1 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });

    // Glow pass: additive so overlapping distant stars accumulate brightness
    // (dense starfield density preserved). No depth write, so multiple glows
    // at the same pixel all contribute. Depth *test* is on so glows behind
    // a disc drawn in the disc pass are correctly occluded.
    this.glowMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...sharedUniforms, uRenderMode: { value: 0 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    // renderOrder ensures discs render first (write depth) before glows
    // (which depth-test against the disc silhouettes).
    this.discMesh = new THREE.Mesh(this.geometry, this.material);
    this.discMesh.frustumCulled = false;
    this.discMesh.renderOrder = 0;
    this.scene.add(this.discMesh);
    this.glowMesh = new THREE.Mesh(this.geometry, this.glowMaterial);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 1;
    this.scene.add(this.glowMesh);

    // Galactic reference layers — disc is always added; grid hides itself
    // until enabled. Arrows are pure SVG inside the existing #overlay so they
    // share the distance vector's stroke + halo styling and inherit the
    // `body.warping` hide rule for free.
    this.galacticDisc = new GalacticDisc();
    this.scene.add(this.galacticDisc.group);
    this.galacticGrid = new GalacticGrid();
    this.scene.add(this.galacticGrid.group);
    const solPath = document.getElementById('sol-arrow') as unknown as SVGPathElement;
    const solBg = document.getElementById('sol-arrow-bg') as unknown as SVGPathElement;
    const gcPath = document.getElementById('gc-arrow') as unknown as SVGPathElement;
    const gcBg = document.getElementById('gc-arrow-bg') as unknown as SVGPathElement;
    const solLabel = document.getElementById('sol-arrow-label') as unknown as SVGTextElement;
    const gcLabel = document.getElementById('gc-arrow-label') as unknown as SVGTextElement;
    this.galacticArrows = new GalacticArrows(solPath, solBg, gcPath, gcBg, solLabel, gcLabel);

    // Clicking either label aims the camera at the named object. Sol's
    // local-frame position is just `-worldOffset` (Sol is the catalog
    // origin); GC sits at GALACTIC_CENTRE_PC in absolute space.
    solLabel.addEventListener('click', () => {
      this.aimAt(this.tmpVec3b.copy(this.worldOffset).negate());
    });
    gcLabel.addEventListener('click', () => {
      this.aimAt(
        this.tmpVec3b.copy(GALACTIC_CENTRE_PC).sub(this.worldOffset),
      );
    });

    // Milky Way volumetric disc. A flattened ellipsoid mesh anchored at
    // the galactic centre; the fragment shader does a bounded raymarch
    // through its volume. renderOrder = -3 keeps it behind every other
    // layer. The shared uniforms map carries `uMaxAppMag` and `uSizeSpan`
    // from the star pipeline so the magnitude filter applies identically
    // to discrete stars and the diffuse glow.
    this.milkyway = new MilkyWay({
      uMaxAppMag: sharedUniforms.uMaxAppMag,
      uSizeSpan: sharedUniforms.uSizeSpan,
    });
    this.scene.add(this.milkyway.group);

    // Seed focus on Sol if it exists so measurement works from the start.
    if (catalog.solIndex >= 0) this.focusedStar = catalog.solIndex;

    // Compute initial pixel sizes for the active preset against the real
    // viewport. DEFAULT_FILTER carries placeholder pixel values; this call
    // replaces them with the right numbers before the first frame.
    this.recomputePresetPxSizes();

    this.attachEvents();
    this.animate();
  }

  onFocusChange(h: (starIndex: number | null) => void) { this.onFocusHandlers.push(h); }
  onCloudFocusChange(h: (cloudIndex: number | null) => void) { this.onCloudFocusHandlers.push(h); }
  onFrame(h: () => void) { this.onFrameHandlers.push(h); }
  onFilterChange(h: (f: Readonly<FilterState>) => void) { this.onFilterHandlers.push(h); }
  onVectorChange(h: (toIdx: number | null) => void) { this.onVectorHandlers.push(h); }
  onVectorCloudChange(h: (toCloudIdx: number | null) => void) { this.onVectorCloudHandlers.push(h); }
  onStateChange(h: () => void) { this.onStateHandlers.push(h); }
  onWarpChange(h: (active: boolean) => void) { this.onWarpHandlers.push(h); }

  getFocusedStar(): number | null { return this.focusedStar; }
  getFocusedCloud(): number | null { return this.focusedCloud; }
  getVectorTo(): number | null { return this.vectorTo; }
  getVectorToCloud(): number | null { return this.vectorToCloud; }
  getMonochrome(): boolean { return this.monochrome; }
  getWarpActive(): boolean { return this.warpState !== null; }

  private setFocus(idx: number | null) {
    // Star and cloud focus are mutually exclusive — selecting either one
    // clears the other. Both setters end up here for the cloud-clear leg
    // so the cloud-focus event always fires before the star-focus event,
    // letting UI listeners settle in the right order.
    const cloudCleared = this.focusedCloud !== null;
    if (cloudCleared) {
      this.focusedCloud = null;
      for (const h of this.onCloudFocusHandlers) h(null);
    }
    if (this.focusedStar === idx) {
      if (cloudCleared) this.fireStateChange();
      return;
    }
    this.focusedStar = idx;
    // Recenter the floating origin on every focus change. Focused: origin
    // snaps to the focused star's absolute position, so close-range rendering
    // happens with tiny coordinate values. Unfocused: origin snaps back to
    // Sol (0,0,0) so the URL-serialised camera pose is in absolute space
    // whenever no focus anchor is in play.
    if (idx !== null) {
      const p = this.catalog.positions;
      this.recenterOrigin(this.tmpRecenter.set(
        p[idx * 3], p[idx * 3 + 1], p[idx * 3 + 2],
      ));
    } else {
      this.recenterOrigin(this.tmpRecenter.set(0, 0, 0));
    }
    this.controls.minDistance = idx !== null ? this.minDistForStar(idx) : DEFAULT_MIN_DIST_PC;
    for (const h of this.onFocusHandlers) h(idx);
    this.fireStateChange();
  }

  /**
   * Set or clear the cloud "soft focus". Setting a cloud clears any star
   * focus first (which also resets the floating origin to Sol). Star-only
   * UI (focus ring, distance vector, warp) ignores this — clouds aren't
   * focusable in the way stars are; only the user-facing "what am I
   * looking at" labels track it.
   */
  setFocusedCloud(idx: number | null) {
    if (idx !== null && this.focusedStar !== null) {
      // Clear the star focus first; setFocus(null) doesn't touch
      // focusedCloud unless it was already set, so no event noise.
      this.setFocus(null);
    }
    if (this.focusedCloud === idx) return;
    this.focusedCloud = idx;
    for (const h of this.onCloudFocusHandlers) h(idx);
    this.fireStateChange();
  }

  private tmpRecenter = new THREE.Vector3();

  // Shift the renderer's local origin to `newOrigin` (an absolute-space
  // coordinate). The instance-position buffer is rewritten as `absolute −
  // newOrigin` in JS Number precision (= float64) before being truncated to
  // float32 — the per-axis subtractions happen in high precision first, so
  // the resulting local coordinates near the new origin retain full float32
  // resolution (~10⁻³⁸ near zero). Camera position and orbit target are
  // shifted by the same delta so the user sees no visible jump; only
  // numerical precision improves.
  //
  // Triggered automatically from setFocus(). Don't call externally — it
  // bypasses the state-change bookkeeping that setFocus threads through.
  private recenterOrigin(newOrigin: THREE.Vector3) {
    const dx = newOrigin.x - this.worldOffset.x;
    const dy = newOrigin.y - this.worldOffset.y;
    const dz = newOrigin.z - this.worldOffset.z;
    if (dx === 0 && dy === 0 && dz === 0) return;

    const abs = this.catalog.positions;
    const loc = this._localPositions;
    const ox = newOrigin.x, oy = newOrigin.y, oz = newOrigin.z;
    const n = this.catalog.count;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      loc[j] = abs[j] - ox;
      loc[j + 1] = abs[j + 1] - oy;
      loc[j + 2] = abs[j + 2] - oz;
    }
    this.iPositionAttr.needsUpdate = true;

    this.camera.position.x -= dx;
    this.camera.position.y -= dy;
    this.camera.position.z -= dz;
    this.controls.target.x -= dx;
    this.controls.target.y -= dy;
    this.controls.target.z -= dz;

    this.worldOffset.copy(newOrigin);
    // Shader needs the world offset to reconstruct absolute positions for
    // dust-texture sampling (local-frame iPosition + uWorldOffset).
    (this.material.uniforms.uWorldOffset.value as THREE.Vector3).copy(newOrigin);
  }

  // Wire a loaded DustField into the star shader. Safe to call after the
  // Starfield is already rendering — uniforms flip atomically on the next
  // frame. Safe to call multiple times; the most recent dust wins. Pass
  // null to detach (e.g. to disable extinction for a mode toggle).
  attachDust(dust: DustField | null) {
    const u = this.material.uniforms;
    if (dust === null) {
      u.uDustTexture.value = null;
      u.uDustEnabled.value = 0;
      this.milkyway.attachDust(null);
      return;
    }
    u.uDustTexture.value = dust.texture;
    u.uDustBoundsPc.value = dust.params.boundsHalfPc;
    u.uDustDensityMin.value = dust.params.densityMin;
    u.uDustLogRatio.value = dust.params.logRatio;
    u.uDustAvPerDensityPc.value = dust.params.avPerDensityPerPc;
    u.uDustEnabled.value = 1;
    // Share the same DustField with the Milky Way pass so the band's dust
    // attenuation shows the actual Edenhofer voxel structure (Great Rift,
    // Coalsack, etc.) rather than only the analytic slab.
    this.milkyway.attachDust(dust);
  }

  /** User-facing extinction multiplier. 0 disables; 1 = physical realism;
   *  values above 1 amplify dust visually (useful for making weak features
   *  obvious). Independent of attachDust — if no dust is loaded, this has
   *  no effect. Also drives the Milky Way background so the dust-darkened
   *  regions of the band track the same knob. */
  setExtinctionStrength(x: number) {
    this.material.uniforms.uExtinctionStrength.value = Math.max(0, x);
    this.milkyway.setExtinctionStrength(x);
  }

  /** Direct access to the Milky Way layer for dev-console tuning
   *  (e.g. `starfield.milkywayLayer.setBrightness(0.4)`). */
  get milkywayLayer(): MilkyWay { return this.milkyway; }

  /** Wire the loaded molecular cloud catalog into the scene. Idempotent —
   *  calling again replaces the layer. Pass null to detach. */
  attachClouds(catalog: CloudCatalog | null) {
    if (this.clouds) {
      this.scene.remove(this.clouds.group);
      this.clouds.dispose();
      this.clouds = null;
    }
    if (catalog === null || catalog.clouds.length === 0) return;
    this.clouds = new MolecularClouds(catalog);
    this.clouds.setMonochrome(this.monochrome);
    this.scene.add(this.clouds.group);
  }

  /** Catalog of clouds, or null if none are attached. Exposed for search
   *  index integration in main.ts. */
  getCloudCatalog(): CloudCatalog | null {
    return this.clouds ? { count: this.clouds.clouds.length, clouds: this.clouds.clouds } : null;
  }

  /** Direct access to the cloud render layer for dev-console tuning
   *  (`starfield.cloudLayer.setOpacity(0.5)` etc.). null until
   *  attachClouds runs. */
  get cloudLayer(): MolecularClouds | null { return this.clouds; }

  /** Hit-test a screen-space cursor against the cloud layer. Returns the
   *  cloud index of the nearest hit, or null if no cloud is under the
   *  cursor. Always returns null when the layer is hidden by the toggle
   *  or warping. */
  pickCloud(clientX: number, clientY: number): number | null {
    if (!this.clouds || !this.filter.showMolecularClouds || this.warpState) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = this.tmpNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.cloudRaycaster.setFromCamera(ndc, this.camera);
    return this.clouds.raycast(this.cloudRaycaster);
  }

  private cloudRaycaster = new THREE.Raycaster();
  private tmpNdc = new THREE.Vector2();

  /** Teleport the camera to a comfortable viewing distance from the
   *  cloud's centroid and make the cloud the new focus. Cloud-side
   *  analogue of focusStar — used by search-select and click-vector-tip.
   *  Clears any prior focus + measurement vector since the user has
   *  effectively "arrived" at the new target. */
  flyToCloud(idx: number) {
    if (!this.clouds) return;
    const cloud = this.clouds.clouds[idx];
    if (!cloud) return;
    if (this.warpState) return;

    // Drop any star focus first. setFocus(null) recenters the floating
    // origin to Sol, putting both camera and target back into absolute
    // ICRS space — so we can place the new view directly using the
    // cloud's absolute centroid, without subtracting worldOffset.
    if (this.focusedStar !== null) this.setFocus(null);
    this.setVectorTo(null);
    this.setVectorToCloud(null);

    const offsetDist = cloudViewingDistancePc(cloud);
    const dir = this.tmpVec3b.subVectors(this.camera.position, this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(offsetDist);

    this.controls.target.copy(cloud.centerAbs);
    this.camera.position.copy(cloud.centerAbs).add(dir);
    this.controls.update();
    this.setFocusedCloud(idx);
  }

  private tmpVec3b = new THREE.Vector3();

  /** Build the dust-particle mesh from the loaded particle data. Called
   *  once after the network fetch resolves; the mesh stays in the scene
   *  and gates on uParticleStrength + uDustEnabled. Idempotent — calling
   *  with the same data is a no-op; calling again replaces the mesh.
   *
   *  STATUS (2026-04): the particle visualisation layer is "dark code" —
   *  loaded but disabled (uParticleStrength = 0 → mesh.visible = false →
   *  zero per-frame cost). It works but the visual balance between
   *  "individual particle visible" vs "smooth fog from overlap" needs
   *  more iteration before promoting to a user-facing toggle. Kept in
   *  the codebase so future sessions can pick up where this left off
   *  without re-deriving the preprocessor/loader/shader plumbing. See
   *  NEXT_STEPS.md "Revisit dust particles" for the open questions. */
  attachDustParticles(data: DustParticleData) {
    if (this.particleMesh) {
      this.scene.remove(this.particleMesh);
      this.particleMesh.geometry.dispose();
      this.particleMaterial?.dispose();
    }

    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute(
      'aCorner',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
        2,
      ),
    );
    geom.setIndex([0, 1, 2, 1, 3, 2]);
    geom.setAttribute('iPosition', new THREE.InstancedBufferAttribute(data.positions, 3));
    geom.setAttribute('iDensity', new THREE.InstancedBufferAttribute(data.densities, 1));
    geom.instanceCount = data.count;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60_000);

    const u = this.material.uniforms;
    this.particleMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        // Share the same wrapper objects as the star material so a single
        // attachDust() / floating-origin recenter / resize update propagates
        // here too. uParticleStrength is particle-only.
        uPixelRatio: u.uPixelRatio,
        uViewport: u.uViewport,
        uWorldOffset: u.uWorldOffset,
        uDustEnabled: u.uDustEnabled,
        uDustDensityMin: u.uDustDensityMin,
        uDustLogRatio: u.uDustLogRatio,
        uParticleStrength: { value: 0.0 },
      },
      vertexShader: dustParticleVert,
      fragmentShader: dustParticleFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.particleMesh = new THREE.Mesh(geom, this.particleMaterial);
    this.particleMesh.frustumCulled = false;
    this.particleMesh.renderOrder = 2; // after disc + glow passes
    this.particleMesh.visible = false;  // hidden until strength > 0
    this.scene.add(this.particleMesh);
  }

  /** User-facing dust-particle visibility. 0 = hidden (default). 1 = a
   *  visible cloud where individual particles are clearly resolvable in
   *  diffuse regions and bright clusters mark dense cores. The mesh is
   *  hidden entirely at strength 0 so the GPU draw call is skipped. */
  setParticleStrength(x: number) {
    if (!this.particleMaterial || !this.particleMesh) return;
    const v = Math.max(0, x);
    this.particleMaterial.uniforms.uParticleStrength.value = v;
    this.particleMesh.visible = v > 0;
  }


  // Read-only view of the local-frame star positions, bound to the GPU
  // iPosition attribute. Overlays should project through this rather than
  // catalog.positions so their math runs in the same frame as the camera.
  get localPositions(): Float32Array { return this._localPositions; }

  setVectorTo(idx: number | null) {
    // Mutually exclusive with vectorToCloud; setting a star vector clears
    // any cloud destination.
    if (idx !== null && this.vectorToCloud !== null) {
      this.vectorToCloud = null;
      for (const h of this.onVectorCloudHandlers) h(null);
    }
    if (this.vectorTo === idx) return;
    this.vectorTo = idx;
    for (const h of this.onVectorHandlers) h(idx);
    this.fireStateChange();
  }

  setVectorToCloud(idx: number | null) {
    // Mutually exclusive with vectorTo; setting a cloud vector clears
    // any star destination.
    if (idx !== null && this.vectorTo !== null) {
      this.vectorTo = null;
      for (const h of this.onVectorHandlers) h(null);
    }
    if (this.vectorToCloud === idx) return;
    this.vectorToCloud = idx;
    for (const h of this.onVectorCloudHandlers) h(idx);
    this.fireStateChange();
  }

  unfocus() {
    if (
      this.focusedStar === null && this.focusedCloud === null &&
      this.vectorTo === null && this.vectorToCloud === null
    ) return;
    this.setVectorTo(null);
    this.setVectorToCloud(null);
    this.setFocus(null);
    this.setFocusedCloud(null);
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
    this.milkyway.setEnabled(this.filter.showMilkyway);
    for (const h of this.onFilterHandlers) h(this.filter);
    this.fireStateChange();
  }

  getFilter(): Readonly<FilterState> { return this.filter; }

  // Apply a magnitude preset (preset-button click). Always sets
  // activePreset + maxAppMag + sizeSpan; sizeMin/Max only if their override
  // flags are false. Use this for explicit user-driven preset changes.
  applyMagnitudePreset(name: MagPresetName) {
    const p = MAG_PRESETS[name];
    const patch: Partial<FilterState> = {
      activePreset: name,
      maxAppMag: p.maxAppMag,
    };
    if (!this.filter.sizeSpanOverridden) patch.sizeSpan = p.sizeSpan;
    const sizes = this.computePresetPxSizes(name);
    if (!this.filter.sizeMinOverridden) patch.sizeMin = sizes.sizeMinPx;
    if (!this.filter.sizeMaxOverridden) patch.sizeMax = sizes.sizeMaxPx;
    this.setFilter(patch);
  }

  // Recompute non-overridden pixel sizes from the active preset's angular
  // targets. Called on viewport resize and from the constructor — only
  // touches sizeMin/Max (the viewport-dependent fields), not maxAppMag or
  // sizeSpan, so a user's manual magnitude-slider value is preserved
  // through resize.
  private recomputePresetPxSizes() {
    const sizes = this.computePresetPxSizes(this.filter.activePreset);
    const patch: Partial<FilterState> = {};
    if (!this.filter.sizeMinOverridden) patch.sizeMin = sizes.sizeMinPx;
    if (!this.filter.sizeMaxOverridden) patch.sizeMax = sizes.sizeMaxPx;
    // Post-patch consistency: the effective max must stay >= effective min.
    // Both fields can be user-overridden independently; at low exaggeration K
    // a recomputed max can fall below a user's min override, which would
    // otherwise leave the filter in an inverted state.
    const newMin = patch.sizeMin ?? this.filter.sizeMin;
    const newMax = patch.sizeMax ?? this.filter.sizeMax;
    if (newMax < newMin) patch.sizeMax = newMin;
    if (Object.keys(patch).length > 0) this.setFilter(patch);
  }

  // Convert a preset's angular size targets to CSS pixels for the current
  // camera FOV + viewport. We use the *larger* viewport dimension as the
  // calibration reference — Three.js's camera.fov is the vertical FOV, but
  // tying calibration to height alone makes stars vanish on landscape
  // mobile (height = 390 px) while feeling right on desktops (height =
  // 1080 px). Scaling by max(w, h) gives a consistent absolute pixel size
  // regardless of orientation, at the cost of strict angular fidelity in
  // the secondary axis. 1-px floor on sizeMin since a sub-pixel disc
  // renders as nothing — and the same floor on sizeMax so it never falls
  // below sizeMin. (At low exaggeration K both raw values can be
  // sub-pixel; without the symmetric floor the saturation disc would
  // invert below the threshold disc.)
  private computePresetPxSizes(name: MagPresetName) {
    const p = MAG_PRESETS[name];
    const refDim = Math.max(window.innerWidth, window.innerHeight);
    const arcsecPerPx = (this.camera.fov * 3600) / refDim;
    const minPx = Math.max(1.0, p.sizeMinArcsec / arcsecPerPx);
    return {
      sizeMinPx: minPx,
      sizeMaxPx: Math.max(minPx, p.sizeMaxArcsec / arcsecPerPx),
    };
  }

  // Camera FOV setter. Updates the projection matrix, rebases
  // non-overridden pixel sizes (arcsec/px depends on FOV), and fires a
  // state change so URL sync picks up the new value.
  setCameraFov(fov: number) {
    if (this.camera.fov === fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.recomputePresetPxSizes();
    for (const h of this.onFilterHandlers) h(this.filter);
    this.fireStateChange();
  }
  getCameraFov(): number { return this.camera.fov; }

  // Star exaggeration K setter for the debug panel. Recomputes MAG_PRESETS
  // (their size targets scale with K) and writes new pixel sizes into any
  // non-overridden fields so the change shows live.
  setStarExaggerationK(k: number) {
    starExaggerationK = k;
    MAG_PRESETS = computeMagPresets();
    this.recomputePresetPxSizes();
  }
  getStarExaggerationK(): number { return starExaggerationK; }

  // Clear override flags for the named fields and write the active
  // preset's value into them. Used by the size and span reset buttons.
  // Only touches the named fields — a manual maxAppMag-slider tweak
  // survives intact.
  clearSizeOverrides(fields: Array<'sizeMin' | 'sizeMax' | 'sizeSpan'>) {
    const p = MAG_PRESETS[this.filter.activePreset];
    const sizes = this.computePresetPxSizes(this.filter.activePreset);
    const patch: Partial<FilterState> = {};
    for (const f of fields) {
      if (f === 'sizeMin') {
        patch.sizeMinOverridden = false;
        patch.sizeMin = sizes.sizeMinPx;
      } else if (f === 'sizeMax') {
        patch.sizeMaxOverridden = false;
        patch.sizeMax = sizes.sizeMaxPx;
      } else if (f === 'sizeSpan') {
        patch.sizeSpanOverridden = false;
        patch.sizeSpan = p.sizeSpan;
      }
    }
    this.setFilter(patch);
  }

  setMonochrome(on: boolean) {
    if (this.monochrome === on) return;
    this.monochrome = on;
    this.material.uniforms.uMonochrome.value = on ? 1 : 0;
    // Both materials share the uMonochrome uniform via sharedUniforms, so
    // one assignment covers both. Blending and depth settings differ per
    // pass, though — disc pass is opaque-over in colour mode, multiply in
    // chart mode; glow pass is additive in colour mode, multiply in chart.
    if (on) {
      this.material.blending = THREE.MultiplyBlending;
      this.material.depthWrite = false;
      this.material.depthTest = false;
      this.glowMaterial.blending = THREE.MultiplyBlending;
      this.glowMaterial.depthTest = false;
    } else {
      this.material.blending = THREE.CustomBlending;
      this.material.blendSrc = THREE.OneFactor;
      this.material.blendDst = THREE.OneMinusSrcAlphaFactor;
      this.material.blendEquation = THREE.AddEquation;
      this.material.depthWrite = true;
      this.material.depthTest = true;
      this.glowMaterial.blending = THREE.AdditiveBlending;
      this.glowMaterial.depthTest = true;
    }
    this.material.needsUpdate = true;
    this.glowMaterial.needsUpdate = true;
    this.renderer.setClearColor(on ? 0xf5f2ea : 0x000000, on ? 1 : 0);
    this.galacticDisc.setMonochrome(on);
    this.galacticGrid.setMonochrome(on);
    this.galacticArrows.setMonochrome(on);
    this.clouds?.setMonochrome(on);
    this.milkyway.setMonochrome(on);
    this.fireStateChange();
  }

  focusStar(starIndex: number, distancePc = 2) {
    const target = this.starLocalPosition(starIndex);
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
    this.controls.target.copy(this.starLocalPosition(starIndex));
    this.controls.update();
    this.setFocus(starIndex);
  }

  /** Cloud-side analogue of setOrbitTarget — orbit pivot moves to the
   *  cloud centroid and the cloud becomes the soft focus, but the camera
   *  stays where it is (no teleport). User then orbits/zooms to view it.
   *  Mirrors the click-on-star UX without teleporting. */
  setOrbitTargetCloud(cloudIdx: number) {
    if (!this.clouds) return;
    const cloud = this.clouds.clouds[cloudIdx];
    if (!cloud) return;
    // setFocusedCloud clears any star focus first, which recenters the
    // floating origin to Sol — so the cloud's absolute centroid IS its
    // local-frame coordinate after that.
    this.setFocusedCloud(cloudIdx);
    this.controls.target.copy(cloud.centerAbs);
    this.controls.update();
  }

  // Start an animated journey from the currently focused thing (star or
  // cloud) to a star at `destIdx`. Camera flies in a straight line with a
  // symmetric accelerate/decelerate profile. Orbit controls are disabled
  // for the duration; overlays listening to onWarpChange are expected to
  // hide themselves so they don't flail against the moving camera.
  // No-ops if there's no focus, the destination equals the source, or the
  // two are coincident.
  warpTo(destIdx: number) {
    const A = this.currentFocusLocalPos();
    if (!A) return;
    if (destIdx === this.focusedStar) return;
    const B = this.starLocalPosition(destIdx);
    this.startWarp(A, B, 'star', destIdx, this.minDistForStar(destIdx));
  }

  /** Cloud-destination warp — flies from the currently focused thing
   *  (star or cloud) to a cloud's centroid. Arrival distance is the
   *  cloud's recommended viewing distance (2.4 × max axis). */
  warpToCloud(destIdx: number) {
    if (!this.clouds) return;
    const cloud = this.clouds.clouds[destIdx];
    if (!cloud) return;
    if (destIdx === this.focusedCloud) return;
    const A = this.currentFocusLocalPos();
    if (!A) return;
    const B = this.tmpVec3b.copy(cloud.centerAbs).sub(this.worldOffset).clone();
    this.startWarp(A, B, 'cloud', destIdx, cloudViewingDistancePc(cloud));
  }

  /** Local-frame position of whatever is currently focused (star or
   *  cloud), or null if nothing is focused. Both warp paths read from
   *  this so the source point follows the unified focus state. */
  private currentFocusLocalPos(): THREE.Vector3 | null {
    if (this.focusedStar !== null) return this.starLocalPosition(this.focusedStar);
    if (this.focusedCloud !== null && this.clouds) {
      const c = this.clouds.clouds[this.focusedCloud];
      if (c) return c.centerAbs.clone().sub(this.worldOffset);
    }
    return null;
  }

  private startWarp(
    A: THREE.Vector3,
    B: THREE.Vector3,
    destKind: 'star' | 'cloud',
    destIdx: number,
    endOffset: number,
  ) {
    if (this.warpState) return;
    // An in-flight aim animation is superseded by warp — drop the state so
    // updateAim doesn't run after warp completes against now-stale pivot.
    this.aimState = null;
    const AB = new THREE.Vector3().subVectors(B, A);
    const distPc = AB.length();
    if (distPc < 1e-6) return;
    const forward = AB.clone().divideScalar(distPc);

    // Reorient-end direction (from A): opposite to the travel direction, so
    // after the reorient A is in front of the camera and B is further along
    // the same line.
    const dirBack = forward.clone().negate();
    const pStart = A.clone().addScaledVector(dirBack, endOffset);
    const pEnd = B.clone().addScaledVector(forward, -endOffset);

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
    // (decreases monotonically from ~|AB| to the destination's endOffset).
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
      endOffset,
      destKind,
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
    const B = state.destKind === 'star'
      ? this.starLocalPosition(state.destIdx)
      : this.cloudLocalPosition(state.destIdx);
    if (!B) {
      // Cloud was detached mid-warp (shouldn't happen in practice); bail
      // gracefully to a clean state rather than NaN-ing the camera.
      this.warpState = null;
      this.controls.enabled = true;
      for (const h of this.onWarpHandlers) h(false);
      return;
    }
    // Park at the configured end offset so orbit radius matches the arrival
    // we animated to — no visible snap between the last fly frame and the
    // parked state.
    const forward = new THREE.Vector3().subVectors(B, state.pStart).normalize();
    this.camera.position.copy(B).addScaledVector(forward, -state.endOffset);
    this.controls.target.copy(B);
    this.warpState = null;
    this.controls.enabled = true;
    this.controls.update();
    // Clear both vector slots — vector destination has been reached, so
    // the measurement line should retire either way.
    this.setVectorTo(null);
    this.setVectorToCloud(null);
    if (state.destKind === 'star') this.setFocus(state.destIdx);
    else this.setFocusedCloud(state.destIdx);
    for (const h of this.onWarpHandlers) h(false);
  }

  /** Local-frame position of a cloud's centroid. Returns null if the
   *  cloud layer hasn't been attached yet. */
  cloudLocalPosition(cloudIdx: number): THREE.Vector3 | null {
    if (!this.clouds) return null;
    const c = this.clouds.clouds[cloudIdx];
    if (!c) return null;
    return c.centerAbs.clone().sub(this.worldOffset);
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

    // Project in local frame so camera/target math stays internally
    // consistent under the floating origin.
    const positions = this._localPositions;
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

  /**
   * Smoothly rotate the camera around `controls.target` so that
   * `pointLocal` (a world point in the renderer's local frame) ends up at
   * the centre of the view. Orbit radius is preserved; orbit pivot
   * doesn't move. Called by the Sol / GC label click handlers.
   *
   * No-ops during warp, mid-aim, or when the camera is already aimed at
   * the point. Disables TrackballControls for the duration so its damping
   * doesn't fight the slerp.
   */
  aimAt(pointLocal: THREE.Vector3) {
    if (this.warpState || this.aimState) return;

    const pivot = this.controls.target;
    const offsetX = this.camera.position.x - pivot.x;
    const offsetY = this.camera.position.y - pivot.y;
    const offsetZ = this.camera.position.z - pivot.z;
    const r = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
    if (r < 1e-6) return; // camera coincident with pivot — no orbit to rotate

    const aimX = pointLocal.x - pivot.x;
    const aimY = pointLocal.y - pivot.y;
    const aimZ = pointLocal.z - pivot.z;
    const aimLen = Math.sqrt(aimX * aimX + aimY * aimY + aimZ * aimZ);
    if (aimLen < 1e-6) return; // target coincides with pivot

    // Start radial direction = camera - pivot, normalised.
    const dir0 = new THREE.Vector3(offsetX / r, offsetY / r, offsetZ / r);
    // End radial direction = -(point - pivot) normalised. Putting the
    // camera on the opposite side of pivot from the target makes the
    // forward vector (pivot - camera) point toward the target.
    const dir1 = new THREE.Vector3(-aimX / aimLen, -aimY / aimLen, -aimZ / aimLen);

    const dot = Math.max(-1, Math.min(1, dir0.dot(dir1)));
    if (dot > 0.99999) return; // already aimed

    const angle = Math.acos(dot);
    const durationMs = Math.max(
      AIM_T_MIN_MS,
      Math.min(AIM_T_MAX_MS, (angle / Math.PI) * AIM_T_MAX_MS),
    );

    const q0 = new THREE.Quaternion().setFromUnitVectors(WARP_BASE_DIR, dir0);
    const q1 = new THREE.Quaternion().setFromUnitVectors(WARP_BASE_DIR, dir1);

    this.controls.enabled = false;
    this.aimState = {
      startTimeMs: performance.now(),
      durationMs,
      q0,
      q1,
      radius: r,
      pivot: pivot.clone(),
    };
  }

  private updateAim() {
    const state = this.aimState;
    if (!state) return;
    const elapsed = performance.now() - state.startTimeMs;
    const u = Math.min(1, elapsed / state.durationMs);
    const f = u * u * (3 - 2 * u);
    this.aimQ.copy(state.q0).slerp(state.q1, f);
    this.aimTmpDir.copy(WARP_BASE_DIR).applyQuaternion(this.aimQ);
    this.camera.position
      .copy(state.pivot)
      .addScaledVector(this.aimTmpDir, state.radius);
    this.camera.lookAt(state.pivot);
    if (u >= 1) {
      this.aimState = null;
      this.controls.enabled = true;
      this.controls.update();
    }
  }

  // Star position in the renderer's local frame — i.e. in the same space
  // as `camera.position` and `controls.target`. This is what overlays want
  // for projection math and what the orbit camera operates in. It is NOT
  // the absolute (Sol-centric) catalog position when a star is focused;
  // use `catalog.positions[i*3..]` directly if you need absolute space
  // (e.g. distance-from-Sol labels).
  starLocalPosition(i: number): THREE.Vector3 {
    const p = this._localPositions;
    return new THREE.Vector3(p[i * 3 + 0], p[i * 3 + 1], p[i * 3 + 2]);
  }

  pickStar(clientX: number, clientY: number, pixelThreshold = 16): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const viewportW = rect.width;
    const viewportH = rect.height;
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;

    const camPos = this.camera.position;
    // Absolute positions drive the distance-from-Sol filter; local-frame
    // positions drive camera-relative math and screen projection (since the
    // camera lives in local frame under the floating origin).
    const absPos = this.catalog.positions;
    const locPos = this._localPositions;
    const { absmag, spectClass } = this.catalog;
    const f = this.filter;
    const v = new THREE.Vector3();

    // Two-tier picking:
    //   1. Cursor inside a star's rendered disc → prime candidate. Among
    //      prime hits, closest-to-camera wins (foreground occludes).
    //   2. Otherwise proximity within pixelThreshold, with mag bias so
    //      brighter stars win ties. Prime hits always beat fallback hits.
    let discIdx = -1;
    let discBestCamDist = Infinity;
    let fbIdx = -1;
    let fbBestScore = Infinity;

    for (let i = 0; i < this.catalog.count; i++) {
      const ax = absPos[i * 3 + 0];
      const ay = absPos[i * 3 + 1];
      const az = absPos[i * 3 + 2];
      const distSol = Math.sqrt(ax * ax + ay * ay + az * az);
      if (distSol < f.minDistSol || distSol > f.maxDistSol) continue;
      const bit = 1 << (spectClass[i] | 0);
      if (!(f.spectMask & bit)) continue;
      const x = locPos[i * 3 + 0];
      const y = locPos[i * 3 + 1];
      const z = locPos[i * 3 + 2];
      const dx = x - camPos.x;
      const dy = y - camPos.y;
      const dz = z - camPos.z;
      const dCam = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.001);
      const appMag = absmag[i] + 5 * (Math.log10(dCam) - 1);
      if (appMag > f.maxAppMag) continue;

      v.set(x, y, z).project(this.camera);
      if (v.z < -1 || v.z > 1) continue;
      const screenX = (v.x + 1) * 0.5 * viewportW;
      const screenY = (1 - v.y) * 0.5 * viewportH;
      const pxDist = Math.hypot(cursorX - screenX, cursorY - screenY);
      const pxSize = this.renderedSizePx(i);

      if (pxDist <= pxSize * 0.5) {
        if (dCam < discBestCamDist) {
          discBestCamDist = dCam;
          discIdx = i;
        }
      } else if (discIdx === -1 && pxDist <= pixelThreshold) {
        const score = pxDist + appMag * 0.05;
        if (score < fbBestScore) {
          fbBestScore = score;
          fbIdx = i;
        }
      }
    }
    return discIdx !== -1 ? discIdx : fbIdx;
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
    this.material.uniforms.uPhysMaxPx.value = this.computePhysMaxPx();
    this.material.uniforms.uViewport.value.set(w, h);
    // Line2 needs the canvas resolution for its screen-space line width.
    this.galacticGrid.setResolution(w, h);
    // The Milky Way layer renders at native resolution via the main scene
    // pass, so no per-resize bookkeeping is needed here.
    // Recompute pixel sizes from the active preset so non-overridden
    // fields stay proportional to the bulge across screen sizes and
    // orientation changes. maxAppMag/sizeSpan don't depend on viewport
    // and are deliberately untouched here so a user's manual magnitude
    // slider value survives a window resize.
    this.recomputePresetPxSizes();
  };

  // The physical-size ceiling: the biggest star in the catalog renders at
  // this pixel size when the camera is at the reference distance. 50% of
  // the smaller viewport axis (in CSS pixels) — dominant but not stuffed
  // edge-to-edge. Tune here if you want supergiants to feel bigger/smaller.
  private computePhysMaxPx(): number {
    return 0.5 * Math.min(window.innerWidth, window.innerHeight);
  }

  // Rendered pixel size (final gl_PointSize-equivalent diameter) for a star
  // from the current camera. Mirrors the vertex-shader math exactly —
  // callers include the focus-ring overlay, the disc mask, and pickStar.
  // Variability modulation + the uPhysMaxPx clamp are replicated here so
  // the mask shrinks in sync with the disc (no gap as a variable pulses).
  // Keep in sync with star.vert.glsl if the shader size computation changes.
  renderedSizePx(idx: number): number {
    const positions = this._localPositions;
    const { physicalRadius, absmag, periodDays, amplitudeMag } = this.catalog;
    const camPos = this.camera.position;
    const u = this.material.uniforms;

    const dx = positions[idx * 3] - camPos.x;
    const dy = positions[idx * 3 + 1] - camPos.y;
    const dz = positions[idx * 3 + 2] - camPos.z;
    const dCam = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.001);
    let appMag = absmag[idx] + 5 * (Math.log10(dCam) - 1);

    const logRMin = u.uLogRMin.value as number;
    const logRMax = u.uLogRMax.value as number;
    const physMinPx = u.uPhysMinPx.value as number;
    const physMaxPx = u.uPhysMaxPx.value as number;
    const refDistPc = u.uRefDistPc.value as number;
    const logSpan = Math.max(logRMax - logRMin, 0.001);
    const logR = Math.log10(Math.max(physicalRadius[idx], 1e-6));
    const logRatio = Math.max(0, Math.min(1, (logR - logRMin) / logSpan));
    const sizeAtRef = physMinPx + logRatio * (physMaxPx - physMinPx);
    const baseSize = sizeAtRef * (refDistPc / dCam);

    // Variability — same compression rule as the shader: effective
    // amplitude is clamped so peak ≤ physMaxPx and trough ≥ 20% of
    // baseSize, keeping the sinusoidal pulse smooth at both ends.
    let radiusFactor = 1;
    const period = periodDays[idx];
    const amp = amplitudeMag[idx];
    if (period > 0 && amp > 0) {
      const periodSec = Math.max(
        period * (u.uSecondsPerDay.value as number),
        u.uMinPeriodSec.value as number,
      );
      const phase = (u.uTime.value as number) / periodSec;

      const VAR_TROUGH_FLOOR_FRACTION = 0.2;
      const maxUpLog10 = Math.log10(Math.max(physMaxPx / Math.max(baseSize, 1), 1));
      const maxDownLog10 = -Math.log10(VAR_TROUGH_FLOOR_FRACTION);
      const ampLimitMag = 10 * Math.min(maxUpLog10, maxDownLog10);
      const ampEff = Math.min(amp, Math.max(0, ampLimitMag));

      const magMod = 0.5 * ampEff * Math.sin(2 * Math.PI * phase);
      appMag += magMod;
      radiusFactor = Math.pow(10, -magMod / 5);
    }

    const f = this.filter;
    // √Δm curve — must match star.vert.glsl line "appSize = mix(...sqrt(brightness))"
    // exactly, otherwise the SVG focus ring + disc mask drift from the
    // rendered star edges.
    const brightness = Math.max(
      0,
      Math.min(1, (f.maxAppMag - appMag) / Math.max(f.sizeSpan, 0.001)),
    );
    const appSize = f.sizeMin + Math.sqrt(brightness) * (f.sizeMax - f.sizeMin);

    const physSize = baseSize * radiusFactor;

    return Math.max(appSize, physSize);
  }

  // Effective minimum orbit distance from a star. For stars with a binary
  // companion, bumps the distance so the companion still fits within the
  // viewport half-angle (keeps the whole system in view at max zoom). For
  // solo stars, returns the default.
  minDistForStar(idx: number): number {
    const comp = this.catalog.companion[idx];
    if (comp < 0) return DEFAULT_MIN_DIST_PC;
    const p = this.catalog.positions;
    const dx = p[comp * 3] - p[idx * 3];
    const dy = p[comp * 3 + 1] - p[idx * 3 + 1];
    const dz = p[comp * 3 + 2] - p[idx * 3 + 2];
    const sep = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Math.max(DEFAULT_MIN_DIST_PC, sep * BINARY_MIN_DIST_FACTOR);
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.pointerDownAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    if (!down) return;
    if (this.warpState || this.aimState) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (dx * dx + dy * dy > 25) return;
    if (performance.now() - down.t > 500) return;

    // Pick a star first — they're the primary interaction target. Fall
    // back to clouds when no star is hit.
    const starIdx = this.pickStar(e.clientX, e.clientY);
    const cloudIdx = starIdx >= 0 ? null : this.pickCloud(e.clientX, e.clientY);
    if (starIdx < 0 && cloudIdx === null) return;

    // Unified click-state machine — clouds participate the same way as
    // stars (orbit-target on first pick, vector destination on second
    // pick from a focus, click-tip-to-travel on third pick). The two
    // special cases the user called out are: (a) focus ring stays a
    // star-only overlay (skipped naturally — no focus ring code touches
    // focusedCloud), and (b) viewing distance for clouds is
    // cloudViewingDistancePc rather than minDistForStar.
    const focusedThing =
      this.focusedStar !== null
        ? { kind: 'star' as const, idx: this.focusedStar }
        : this.focusedCloud !== null
          ? { kind: 'cloud' as const, idx: this.focusedCloud }
          : null;
    const clickedThing =
      starIdx >= 0
        ? { kind: 'star' as const, idx: starIdx }
        : { kind: 'cloud' as const, idx: cloudIdx as number };
    const vectorThing =
      this.vectorTo !== null
        ? { kind: 'star' as const, idx: this.vectorTo }
        : this.vectorToCloud !== null
          ? { kind: 'cloud' as const, idx: this.vectorToCloud }
          : null;

    // No focus → click sets the focus (orbit pivot). Camera stays put.
    if (!focusedThing) {
      if (clickedThing.kind === 'star') this.setOrbitTarget(clickedThing.idx);
      else this.setOrbitTargetCloud(clickedThing.idx);
      return;
    }

    // Click on the focused thing → clear vector if present, else unfocus.
    if (sameTarget(clickedThing, focusedThing)) {
      if (vectorThing) {
        this.setVectorTo(null);
        this.setVectorToCloud(null);
      } else {
        this.unfocus();
      }
      return;
    }

    // Click on the current vector destination → travel to it.
    // For stars, focusStar matches the search-select teleport (2 pc
    // viewing distance). For clouds, flyToCloud is the search-select
    // analogue (cloudViewingDistancePc).
    if (vectorThing && sameTarget(clickedThing, vectorThing)) {
      if (clickedThing.kind === 'star') this.focusStar(clickedThing.idx);
      else this.flyToCloud(clickedThing.idx);
      return;
    }

    // Otherwise, click sets the vector destination.
    if (clickedThing.kind === 'star') this.setVectorTo(clickedThing.idx);
    else this.setVectorToCloud(clickedThing.idx);
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

  private animateStartMs = performance.now();
  private animate = () => {
    if (this.disposed) return;
    if (this.warpState) {
      this.updateWarp();
    } else if (this.aimState) {
      this.updateAim();
    } else {
      this.controls.update();
    }
    this.material.uniforms.uCameraPos.value.copy(this.camera.position);
    // Advance variability clock (seconds since start). Shared with glow
    // material via sharedUniforms so both passes see the same time.
    this.material.uniforms.uTime.value = (performance.now() - this.animateStartMs) / 1000;
    this.updateGalacticLayers();
    // Milky Way analytic background. The skybox mesh is already in the
    // main scene at renderOrder = -3; this call re-anchors it to
    // camera.position and refreshes the absolute-camera-position uniform
    // for the shader's raymarch.
    this.milkyway.update(this.camera, this.worldOffset);
    this.renderer.render(this.scene, this.camera);
    for (const h of this.onFrameHandlers) h();
    requestAnimationFrame(this.animate);
  };

  // Drive the disc fade, grid attachment, and arrow projection each frame.
  // All three galactic layers are hidden during a warp — the camera is in
  // motion and their reference function is exactly the kind of context warp
  // deliberately suppresses. Molecular clouds stay visible during warp by
  // design — flying past Taurus or Orion is a feature, not a distraction.
  private updateGalacticLayers() {
    if (this.warpState) {
      this.galacticDisc.group.visible = false;
      this.galacticGrid.group.visible = false;
      this.galacticArrows.setVisible(false);
      this.clouds?.update(this.worldOffset, this.filter.showMolecularClouds);
      return;
    }

    // Refresh camera matrices before any SVG projection — controls.update()
    // mutates camera.position/quaternion but doesn't propagate to
    // matrixWorld/matrixWorldInverse. The renderer would do this for us, but
    // we project arrow tips into screen space *before* renderer.render() runs,
    // so without this call the labels lag by one frame during fast moves.
    this.camera.updateMatrixWorld();

    // Camera distance from Sol in absolute ICRS pc. Computed in JS float64 so
    // the sum stays exact even with kpc-scale worldOffset values; the disc
    // fade smoothstep that consumes it is a small range so precision matters.
    const cam = this.camera.position;
    const ax = cam.x + this.worldOffset.x;
    const ay = cam.y + this.worldOffset.y;
    const az = cam.z + this.worldOffset.z;
    const distFromSol = Math.sqrt(ax * ax + ay * ay + az * az);
    this.galacticDisc.update(this.worldOffset, distFromSol);

    if (this.filter.showGalacticOverlays) {
      this.galacticGrid.group.visible = true;
      this.galacticGrid.update(this.camera.position);
    } else {
      this.galacticGrid.group.visible = false;
    }

    const focusedLocal =
      this.focusedStar !== null ? this.starLocalPosition(this.focusedStar) : null;
    const isSolFocus =
      this.focusedStar !== null && this.focusedStar === this.catalog.solIndex;
    this.galacticArrows.update(
      this.camera,
      this.controls.target,
      this.worldOffset,
      focusedLocal,
      isSolFocus,
      this.filter.showGalacticOverlays,
      this.filter.sizeMax,
    );

    this.clouds?.update(this.worldOffset, this.filter.showMolecularClouds);
  }

  private updateWarp() {
    const state = this.warpState;
    if (!state) return;
    const elapsed = performance.now() - state.startTimeMs;

    if (elapsed < state.reorientMs) {
      // Reorient phase: spherically slerp the camera's radial direction from
      // the user's starting angle around A to `dirBack`, while linearly
      // easing the distance from A from `mag0` down to state.endOffset.
      // Look-at stays locked on A so A remains centered in view the whole
      // time. Quaternion slerp robustly handles any starting angle including
      // antipodal cases (user looking at A from the B side).
      const u = elapsed / state.reorientMs;
      const f = u * u * (3 - 2 * u);

      this.warpQ0.setFromUnitVectors(WARP_BASE_DIR, state.dir0);
      this.warpQ1.setFromUnitVectors(WARP_BASE_DIR, state.dirBack);
      this.warpQ0.slerp(this.warpQ1, f);
      this.warpTmp.copy(WARP_BASE_DIR).applyQuaternion(this.warpQ0);

      const mag = state.mag0 * (1 - f) + state.endOffset * f;
      this.camera.position.copy(state.A).addScaledVector(this.warpTmp, mag);
      this.camera.lookAt(state.A);
      return;
    }

    // Fly phase: symmetric accelerate/decelerate along the A→B line.
    const flyElapsed = elapsed - state.reorientMs;
    const t = Math.min(flyElapsed / state.durationMs, 1);
    const f = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    this.camera.position.lerpVectors(state.pStart, state.pEnd, f);
    const B = state.destKind === 'star'
      ? this.starLocalPosition(state.destIdx)
      : this.cloudLocalPosition(state.destIdx);
    if (B) this.camera.lookAt(B);
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
    this.glowMaterial.dispose();
    this.milkyway.dispose();
    this.renderer.dispose();
  }
}

export { ALL_SPECT_MASK };
