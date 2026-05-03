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
import { HudOverlay } from './hud-overlay';
import { GALACTIC_CENTRE_PC } from './galactic-coords';
import { MolecularClouds, cloudViewingDistancePc } from './molecular-clouds';
import type { CloudCatalog } from './cloud-loader';
import { MilkyWay } from './milkyway';
import { ObserveControls } from './observe-controls';
import { mark as perfMark, measure as perfMeasure, frame as perfFrame } from './perf-hud';

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
  // Master visibility for constellation stick figures. When false the
  // overlay draws nothing regardless of `highlightCon` (which is preserved
  // so re-enabling restores the prior selection); the picker UI is also
  // disabled and the C shortcut is suppressed by their own gates.
  showConstellation: boolean;
  // Galactic coordinate sphere (grid lines on a 50 kpc sphere). Disc is
  // always-on (fades by zoom) so it isn't gated here.
  showGalacticGrid: boolean;
  // HUD: Sol/GC locator arrows in both navigate + observe modes, plus the
  // OBSERVE-mode screen-centred ring. Future HUD widgets hang off this flag.
  showHud: boolean;
  // Molecular cloud overlay (Phase 3a). Default-on; toggle suppresses both
  // 3D rendering and hover/pick.
  showMolecularClouds: boolean;
  // Milky Way analytic background (Phase 5). Default-on; in chart mode
  // it switches to outline-only rendering (gated on this same toggle).
  // May be force-flipped off by the FPS probe on the first few frames
  // if the device can't sustain ≥30 fps with it on.
  showMilkyway: boolean;
  // Star chart mode (Phase 8). Only meaningful while cameraMode==='observe';
  // chart-mode orchestrator (chart-mode.ts) ignores it otherwise. Drives
  // the paper-aesthetic palette, label rendering, isobar outlines on
  // cloud / milkyway, and flat-disc star rendering.
  chart: boolean;
}

export interface StellataOptions {
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
// K is per-preset because the visible star population shifts with the
// magnitude limit: naked-eye reveals only the brightest few thousand
// (needs more exaggeration to feel populated), while "all" shows ~313k
// stars and benefits from a smaller K to avoid the field becoming a
// solid wash.
//
// Tunable at runtime via Stellata.setStarExaggerationK so the debug
// panel can sweep the active preset's K visually. Higher = bolder, more
// cartoonish stars; lower = more austere, nearer the literal physics.
const STAR_PSF_ARCSEC = 30;
const STAR_PHYSICS_FACTOR = 1.84;
// Per-preset exaggeration. Each magnitude preset (naked-eye, binoculars,
// all) has its own K so the disc sizing can be tuned independently for the
// star population each preset reveals. Switching presets snaps the debug
// slider to that preset's K.
const STAR_EXAGGERATION_K_DEFAULTS: Record<MagPresetName, number> = {
  'naked-eye':  12,
  'binoculars': 9,
  'all':        5,
};
let starExaggerationK: Record<MagPresetName, number> = { ...STAR_EXAGGERATION_K_DEFAULTS };

// Star-disc rendering knobs. Defaults shipped to production; debug panel
// can sweep each one independently for visual calibration. See
// star.frag.glsl for the meaning of each value — the doc lives there
// alongside the math that consumes it.
export interface StarRenderParams {
  visibleThreshold: number;
  coreThreshold: number;
  discardThreshold: number;
  distNMin: number;
  distNMax: number;
  lumBiasMin: number;
  lumBiasMax: number;
}
export const STAR_RENDER_DEFAULTS: StarRenderParams = {
  visibleThreshold: 0.2,
  coreThreshold: 0.4,
  discardThreshold: 0.02,
  distNMin: 2.2,
  distNMax: 10.0,
  lumBiasMin: 1.0,
  lumBiasMax: 0.6,
};

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
  const result = {} as Record<MagPresetName, MagPreset>;
  for (const name of Object.keys(PRESET_BASE) as MagPresetName[]) {
    const base = PRESET_BASE[name];
    const sizeMinArcsec = STAR_PSF_ARCSEC * starExaggerationK[name];
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

// Fallback orbit-controls floor when no star is focused. Sized to keep
// the camera comfortably outside any single star's physical envelope
// (Sol's photosphere at 2.25×10⁻⁸ pc, Earth's orbit at 4.85×10⁻⁶ pc) so
// approaching origin without an explicit focus anchor doesn't enter the
// extreme-close-range regime where float32 matrix cancellation drifts
// the projected center off-screen. To get closer than this, focus a
// star — `minOrbitDistForStar` then returns the per-star physical floor.
const GLOBAL_MIN_DIST_PC = 5e-3;

// Fraction of the viewport's minor axis that the focused star's disc
// fills at the manual-zoom orbit floor. 0.9 means a maximally-zoomed
// camera lands with the star covering 90% of the smaller viewport
// dimension — leaves a small ring of background visible. Both the
// vertex shader (variability headroom) and minOrbitDistForStar use
// this constant; keep them in sync.
const ZOOM_FLOOR_FRACTION = 0.9;

// Fraction of the viewport's minor axis that a destination star fills
// when the camera auto-parks at it (warp arrival, observe-exit landing,
// search-select teleport). 0.10 = the disc reads as a clear feature
// without dominating the frame, leaving room to see the surrounding
// star field. Drives minDistForStar.
const TARGET_PARK_FRACTION = 0.10;

// Default vertical FOV (degrees). User-tunable via the FOV slider; the
// reset button snaps back to this value.
export const DEFAULT_FOV = 50;

// One solar radius in parsecs. catalog.physicalRadius (and therefore
// iLogRadius) is in solar radii; the angular-diameter formula needs
// physical radius in pc to match the camera-distance units. Used both
// in stellata.ts and in the star vertex shader (uRSunPc).
//   1 R_sun = 6.957e8 m, 1 pc = 3.0857e16 m  →  R_sun = 2.2543e-8 pc
const R_SUN_PC = 2.2543e-8;

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

// OBSERVE-mode entry/exit translate animation. Travel distance is always
// minDistForStar (sub-parsec) so a fixed duration reads as a brief glide
// rather than a warp.
export const OBSERVE_TRANSITION_MS = 1200;

export type CameraMode = 'navigate' | 'observe';

interface ObserveTransitionState {
  startTimeMs: number;
  durationMs: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  // 'enter' parks the camera at the focused star (toPos = origin under the
  // floating-origin frame). 'exit' translates to the star's effective
  // minDistance along the camera's current backward direction; on
  // completion controls.target snaps to the focal star and TrackballControls
  // re-enables.
  kind: 'enter' | 'exit';
  // Only meaningful for 'exit' transitions. When true, finishObserveTransition
  // calls setFocus(null) right after the camera lands at minDistance — used by
  // the X button on the location search so the user gets the same zoom-out
  // animation whether they're returning to navigate-with-focus or fully
  // unfocusing.
  clearFocusOnExit?: boolean;
}

interface AimState {
  startTimeMs: number;
  durationMs: number;
  q0: THREE.Quaternion;       // rotates WARP_BASE_DIR to the start radial dir
  q1: THREE.Quaternion;       // rotates WARP_BASE_DIR to the end radial dir
  radius: number;             // |camera - target| at click; held constant
  pivot: THREE.Vector3;       // controls.target snapshot, in local frame
}

// OBSERVE-mode aim. Camera position is fixed; only the camera's orientation
// changes. Slerping the live camera quaternion from `q0` to `q1` rotates
// the view in place to face `pointLocal`.
interface ObserveAimState {
  startTimeMs: number;
  durationMs: number;
  q0: THREE.Quaternion;
  q1: THREE.Quaternion;
}

interface WarpState {
  startTimeMs: number;
  reorientMs: number;
  durationMs: number;
  postArrivalMs: number;   // duration of the post-arrival reorient phase
  A: THREE.Vector3;        // source world position (focused star or cloud centroid)
  dir0: THREE.Vector3;     // unit vector from A toward camera at warp start
  mag0: number;            // |camera - A| at warp start
  dirBack: THREE.Vector3;  // unit vector from A away from B (reorient end direction)
  pStart: THREE.Vector3;   // fly start = A + dirBack * endOffset
  pEnd: THREE.Vector3;     // fly end = B - forward * endOffset
  endOffset: number;       // arrival viewing distance for the destination
  destKind: 'star' | 'cloud';
  destIdx: number;
  // Warp originated from OBSERVE mode. finishWarp re-enters observe at the
  // destination star; uHideFocusIdx stays pinned to the source star for the
  // entire warp so the camera doesn't briefly render "from inside the star"
  // during the early reorient frames.
  returnToObserve: boolean;
  // Camera quaternion at warp start, in the local frame. The post-arrival
  // phase slerps from "looking at destination" (set by the fly phase) back
  // to this orientation, so the user sees the same celestial direction
  // they were looking at when they picked the destination — but from the
  // new vantage. Parallax-shifted background; nothing fancier than a
  // Shoemake-style spherical interpolation between two unit quaternions.
  startQuaternion: THREE.Quaternion;
  // Captured lazily on the first frame of the post-arrival phase so the
  // slerp starts from whatever lookAt(B) produced at fly-end without us
  // having to predict it analytically.
  flyEndQuaternion?: THREE.Quaternion;
  // Reorient-phase end orientation. Set only when the warp launches from
  // OBSERVE (mag0 ≈ 0): the existing radial-direction slerp + lookAt(A)
  // collapses to a snap because the camera starts on top of A. We slerp
  // from startQuaternion to this canonical "look at A from pStart"
  // quaternion across the reorient phase instead, so the user sees the
  // camera smoothly turn from their observe view to the fly orientation
  // before the fly phase begins. Undefined for navigate-mode warps —
  // those use lookAt(A) per frame, which keeps A perfectly centered as
  // the camera swings around it.
  reorientEndQuaternion?: THREE.Quaternion;
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
  showConstellation: true,
  showGalacticGrid: false,
  showHud: false,
  showMolecularClouds: false,
  showMilkyway: true,
  chart: false,
};

export class Stellata {
  readonly catalog: Catalog;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: TrackballControls;

  private scene: THREE.Scene;
  private discMesh: THREE.Mesh;
  private glowMesh: THREE.Mesh;
  // Core depth-mask — renders disc-pass cores depth-only before any
  // background layer so MW / clouds / grid depth-fail behind them.
  // Visibility gated each frame on (focusedStar || warping) so the draw
  // call is skipped entirely when no star can be in the disc pass.
  private coreMaskMesh: THREE.Mesh;
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
  private coreMaskMaterial: THREE.ShaderMaterial; // depth-only core mask
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

  // Sorted-by-distance-from-Sol index for the core-mask query. Distance
  // from Sol is intrinsic (computed from absolute catalog positions) and
  // therefore stable across floating-origin recenters, so this index is
  // built once at construction. Each frame we slice a window via triangle
  // inequality on the camera's distance-from-Sol, turning a 313k linear
  // scan into a few-hundred-element check.
  private sortedDistFromSol!: Float32Array;
  private sortedByDistFromSol!: Uint32Array;

  // Largest physicalRadius in the catalog, in pc. Drives shouldEnableCoreMask:
  // the core depth-mask only matters when at least one star's angular disc
  // crosses the visibility threshold, and the largest star at the closest
  // approach is the worst case.
  private maxPhysicalRadiusPc!: number;

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
  private onCameraModeHandlers: Array<(mode: CameraMode) => void> = [];

  private cameraMode: CameraMode = 'navigate';
  private observeTransition: ObserveTransitionState | null = null;
  private observeControls!: ObserveControls;

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
  private observeAimState: ObserveAimState | null = null;
  private observeAimQ = new THREE.Quaternion();

  // OBSERVE-mode "points of interest". Single-click on a star pins it.
  // Cleared on every observe → navigate transition (registered in the
  // constructor). Hard-capped at POI_HARD_CAP — adding past the cap is
  // a no-op so the cap also bounds the URL blob (poi serialisation in
  // url-state.ts is HIP-only). Insertion-ordered (Array, not Set) so
  // round-trips through URL state preserve the user's pin order.
  private pois: number[] = [];
  private onPoisHandlers: Array<(pois: readonly number[]) => void> = [];
  // Pending single-click in OBSERVE mode. Held for OBSERVE_DBL_CLICK_MS
  // so we can disambiguate single (pin a star) from double (slerp the
  // camera to the clicked direction). Navigate-mode clicks do not enter
  // this state — they dispatch immediately.
  private observePendingClick: { x: number; y: number; timer: number } | null = null;
  private static OBSERVE_DBL_CLICK_MS = 280;
  private static OBSERVE_DBL_CLICK_DIST_PX_SQ = 8 * 8;
  private static POI_HARD_CAP = 16;

  // Galactic reference layers (Phase 4c). Disc fades in by camera-distance
  // from Sol and is always-on. Grid is gated by `filter.showGalacticGrid`.
  // The HUD (Sol/GC arrows + OBSERVE-mode ring) is gated by
  // `filter.showHud`. Mono mode swaps strokes to a paper-chart palette via
  // setMonochrome on each layer (HUD is CSS-only).
  private galacticDisc: GalacticDisc;
  private galacticGrid: GalacticGrid;
  private hudOverlay: HudOverlay;

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

  constructor({ canvas, catalog }: StellataOptions) {
    this.catalog = catalog;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
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
      1e-10,
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
    this.controls.minDistance = GLOBAL_MIN_DIST_PC;
    this.controls.maxDistance = 100_000;
    this.controls.target.set(0, 0, 0);

    // OBSERVE-mode look-around controller. Starts disabled; enable() runs
    // when the camera mode flips, with TrackballControls.enabled toggled
    // off in the same step so the two schemes never compete for input.
    this.observeControls = new ObserveControls(
      canvas,
      this.camera,
      (fov) => this.setCameraFov(fov),
      () => this.camera.fov,
    );

    // Precompute log10(physicalRadius) per star for the shader (vertex
    // attribute decode: pow(10, iLogRadius) → physical radius in pc),
    // and track the catalog-wide max so shouldEnableCoreMask can reason
    // about the largest disc that could appear at close range.
    // Luminosity class is converted from Uint8 to Float32 since the
    // vertex attribute is a float; 255 (unknown) survives the conversion
    // and is handled inside the shader.
    const logRadii = new Float32Array(catalog.count);
    const lumClassF32 = new Float32Array(catalog.count);
    const distSol = new Float32Array(catalog.count);
    let maxPhysicalRadius = 0;
    for (let i = 0; i < catalog.count; i++) {
      const r = Math.max(catalog.physicalRadius[i], 1e-6);
      logRadii[i] = Math.log10(r);
      if (r > maxPhysicalRadius) maxPhysicalRadius = r;
      lumClassF32[i] = catalog.luminosityClass[i];
      const x = catalog.positions[i * 3];
      const y = catalog.positions[i * 3 + 1];
      const z = catalog.positions[i * 3 + 2];
      distSol[i] = Math.sqrt(x * x + y * y + z * z);
    }
    this.maxPhysicalRadiusPc = maxPhysicalRadius * R_SUN_PC;
    // Local-frame position buffer — starts identical to catalog.positions
    // since worldOffset is (0,0,0) at construction. Recenter rewrites this
    // in place.
    this._localPositions = new Float32Array(catalog.positions);
    // Sort indices by distance from Sol (ascending). The sorted view lets
    // shouldEnableCoreMask() walk only stars whose Sol-distance falls
    // within `[camDistFromSol - dThresh, camDistFromSol + dThresh]` —
    // typically a few-hundred-element window instead of the full catalog.
    this.sortedByDistFromSol = new Uint32Array(catalog.count);
    for (let i = 0; i < catalog.count; i++) this.sortedByDistFromSol[i] = i;
    this.sortedByDistFromSol.sort((a, b) => distSol[a] - distSol[b]);
    this.sortedDistFromSol = new Float32Array(catalog.count);
    for (let i = 0; i < catalog.count; i++) {
      this.sortedDistFromSol[i] = distSol[this.sortedByDistFromSol[i]];
    }
    // Instanced quads: one unit square per star, expanded in screen space in
    // the vertex shader. This replaces the earlier THREE.Points approach,
    // which was capped by the driver-defined gl_PointSize maximum (often
    // 64–255 px) — too small for the angular-diameter rendering to reach
    // the viewport-filling sizes we want for supergiants at close range.
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
      // Chart-mode disc sizing (Phase 8 v2). Pixel range + bright-end
      // magnitude reference; vertex shader uses these only when
      // uMonochrome > 0.5. The same constants are read JS-side by
      // chart-labels.ts to size variable rings + binary wings.
      uChartDiscMaxPx: { value: 16.0 },
      uChartDiscMinPx: { value: 1.5 },
      uChartMagBright: { value: -2.0 },
      // Camera vertical FOV in radians, mirrored from camera.fov whenever
      // setCameraFov runs. The shader needs it to convert a star's angular
      // diameter (2·atan(R/d)) into pixels.
      uFovYRad: { value: (this.camera.fov * Math.PI) / 180 },
      // Solar-radii → parsecs conversion for the physical-size formula.
      // catalog.physicalRadius is in solar radii; iLogRadius decodes back
      // to solar radii via pow(10, x); multiply by uRSunPc to get pc.
      uRSunPc: { value: R_SUN_PC },
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

      // Star-disc rendering knobs (debug-panel tunable). See star.frag.glsl
      // for what each parameter shapes; defaults here are the calibrated
      // baseline that ships in production.
      uVisibleThreshold: { value: STAR_RENDER_DEFAULTS.visibleThreshold },
      uVisibleK: { value: -Math.log(STAR_RENDER_DEFAULTS.visibleThreshold) },
      uCoreThreshold: { value: STAR_RENDER_DEFAULTS.coreThreshold },
      uDiscardThreshold: { value: STAR_RENDER_DEFAULTS.discardThreshold },
      uDistNMin: { value: STAR_RENDER_DEFAULTS.distNMin },
      uDistNMax: { value: STAR_RENDER_DEFAULTS.distNMax },
      uLumBiasMin: { value: STAR_RENDER_DEFAULTS.lumBiasMin },
      uLumBiasMax: { value: STAR_RENDER_DEFAULTS.lumBiasMax },

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
      // OBSERVE-mode focal-star suppression. Set to the focused-star catalog
      // index when the camera is parked on it; -1 disables the gate. All
      // three star passes (disc, glow, core mask) share these uniforms so
      // the suppression fires uniformly.
      uHideFocusIdx: { value: -1 },
      // Force-center the focused star at NDC (0,0). At the close-approach
      // orbit floor (~5×10⁻⁸ pc for Sol-class stars), float32 cancellation
      // in projectionMatrix * modelViewMatrix * (0,0,0,1) can drift the
      // projected center by visible pixels even though the star is
      // mathematically at view-origin (controls.target = star, lookAt
      // aligns -Z with target). This uniform names the instance to pin;
      // the shader replaces its centreClip with projectionMatrix *
      // (0, 0, -distCam, 1) to bypass the cancellation. -1 disables.
      // Updated each frame in animate() since pan can move target away.
      uPinFocusToCenter: { value: -1 },
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
    // (dense stellata density preserved). No depth write, so multiple glows
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

    // Core depth-mask: writes near depth at disc-pass star cores before any
    // background layer renders, so the Milky Way / molecular clouds /
    // galactic grid depth-fail behind close stars instead of bleeding
    // through. colorWrite off → cheaper than a colour pass and never paints
    // anything visible. Visibility gated each frame on focus / warp state
    // so this draw call is skipped when no star can be in the disc pass.
    this.coreMaskMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...sharedUniforms, uRenderMode: { value: 2 } },
      vertexShader,
      fragmentShader,
      depthWrite: true,
      depthTest: true,
      colorWrite: false,
    });

    // renderOrder: core mask (-4) → background layers → discs (0) → glows (1).
    this.coreMaskMesh = new THREE.Mesh(this.geometry, this.coreMaskMaterial);
    this.coreMaskMesh.frustumCulled = false;
    this.coreMaskMesh.renderOrder = -4;
    this.coreMaskMesh.visible = false;
    this.scene.add(this.coreMaskMesh);
    this.discMesh = new THREE.Mesh(this.geometry, this.material);
    this.discMesh.frustumCulled = false;
    this.discMesh.renderOrder = 0;
    this.scene.add(this.discMesh);
    this.glowMesh = new THREE.Mesh(this.geometry, this.glowMaterial);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 1;
    this.scene.add(this.glowMesh);

    // Galactic reference layers — disc is always added; grid hides itself
    // until enabled. The HUD (ring + Sol/GC arrows) is pure SVG inside the
    // existing #overlay so it shares the distance vector's stroke + halo
    // styling and inherits the `body.warping` hide rule for free.
    this.galacticDisc = new GalacticDisc();
    this.scene.add(this.galacticDisc.group);
    this.galacticGrid = new GalacticGrid();
    this.scene.add(this.galacticGrid.group);
    const hudRing = document.getElementById('hud-ring') as unknown as SVGCircleElement;
    const solPath = document.getElementById('sol-arrow') as unknown as SVGPathElement;
    const solBg = document.getElementById('sol-arrow-bg') as unknown as SVGPathElement;
    const gcPath = document.getElementById('gc-arrow') as unknown as SVGPathElement;
    const gcBg = document.getElementById('gc-arrow-bg') as unknown as SVGPathElement;
    const solLabel = document.getElementById('sol-arrow-label') as unknown as SVGTextElement;
    const gcLabel = document.getElementById('gc-arrow-label') as unknown as SVGTextElement;
    this.hudOverlay = new HudOverlay(hudRing, solPath, solBg, gcPath, gcBg, solLabel, gcLabel);

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

    // Engage focus on Sol if it exists so measurement and per-star zoom
    // work from the start. setFocus (rather than raw field assignment)
    // wires up controls.minDistance to the per-star orbit floor and
    // snaps controls.target to local (0,0,0) — without this, the
    // unfocused GLOBAL_MIN_DIST_PC clamp set above stays in place AND
    // the pin guard fails because Sol's catalog position is
    // (5e-6, 0, 0) pc (not exactly zero), so recenterOrigin shifts
    // target by 5e-6 and breaks the lengthSq < 1e-12 invariant. Safe
    // at this point in the constructor: handlers aren't subscribed yet
    // and camera/aspect are already initialised.
    if (catalog.solIndex >= 0) this.setFocus(catalog.solIndex);

    // Compute initial pixel sizes for the active preset against the real
    // viewport. DEFAULT_FILTER carries placeholder pixel values; this call
    // replaces them with the right numbers before the first frame.
    this.recomputePresetPxSizes();

    // Clear pinned POIs on any exit out of observe. Subscribed here
    // rather than wired into each cameraMode-flip site because all three
    // exit paths (mode toggle, focus change, search-X clear) emit
    // onCameraModeChange; one listener catches them all and fires before
    // the URL writer's debounced flush.
    this.onCameraModeChange((mode) => {
      if (mode !== 'observe') this.clearPois();
    });

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

  getCameraMode(): CameraMode { return this.cameraMode; }
  isObserveTransitionActive(): boolean { return this.observeTransition !== null; }
  /** Whether the focused-star pin (uPinFocusToCenter) would engage right
   *  now, mirroring the per-frame guard in animate(). Read by the pin
   *  debug HUD (`debug.pin()`) to display live state. */
  isPinEngaged(): boolean {
    return (
      this.focusedStar !== null &&
      this.cameraMode === 'navigate' &&
      !this.warpState && !this.aimState &&
      this.controls.target.lengthSq() < 1e-12
    );
  }
  /** True while an aim animation is in flight. Mirror of getWarpActive
   *  for the camera's other interpolated transition. */
  isAimActive(): boolean { return this.aimState !== null; }

  // Eased progress of the in-flight observe-mode camera translate, or null
  // if no transition is active. `f` matches the easing inside
  // updateObserveTransition so overlays that lerp alongside the camera
  // (focus ring shrink, HUD ring grow) stay in sync visually.
  getObserveTransitionProgress(): { f: number; kind: 'enter' | 'exit' } | null {
    const s = this.observeTransition;
    if (!s) return null;
    const t = Math.min(1, (performance.now() - s.startTimeMs) / s.durationMs);
    const f = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    return { f, kind: s.kind };
  }

  onCameraModeChange(handler: (mode: CameraMode) => void) {
    this.onCameraModeHandlers.push(handler);
  }

  // ──────────────────── OBSERVE-mode points of interest ────────────────────
  //
  // Single-click on a star in OBSERVE pins it; click again to unpin. The
  // POI overlay (poi-overlay.ts) renders an on-screen label following the
  // star, and a HUD-ring arrow when it goes off-screen. Cleared automatically
  // on any observe→navigate transition.

  getPois(): readonly number[] { return this.pois; }
  onPoisChange(h: (pois: readonly number[]) => void) { this.onPoisHandlers.push(h); }

  /**
   * Toggle a POI for the given catalog index.
   *   - Sol is rejected (already represented by the dedicated #sol-arrow).
   *   - Stars without a Hipparcos ID are rejected (URL state is HIP-only,
   *     so they couldn't survive a reload anyway).
   *   - Adding past POI_HARD_CAP is a no-op (caps the URL blob; user can
   *     unpin first).
   */
  togglePoi(idx: number) {
    if (idx < 0 || idx >= this.catalog.count) return;
    if (idx === this.catalog.solIndex) {
      console.info('[POI] Sol is excluded (already shown via #sol-arrow).');
      return;
    }
    if (this.catalog.hip[idx] === 0) {
      console.info('[POI] cannot pin a star without a Hipparcos ID.');
      return;
    }
    const existing = this.pois.indexOf(idx);
    if (existing >= 0) {
      this.pois.splice(existing, 1);
      this.firePoisChange();
      return;
    }
    if (this.pois.length >= Stellata.POI_HARD_CAP) {
      console.info(`[POI] cap reached (${Stellata.POI_HARD_CAP}); unpin one first.`);
      return;
    }
    this.pois.push(idx);
    this.firePoisChange();
  }

  /**
   * Replace the current POI list. Used by URL state restore — the
   * incoming list is already validated (HIPs that resolved in idMaps).
   */
  setPois(idxs: readonly number[]) {
    const next: number[] = [];
    for (const idx of idxs) {
      if (next.length >= Stellata.POI_HARD_CAP) break;
      if (idx < 0 || idx >= this.catalog.count) continue;
      if (idx === this.catalog.solIndex) continue;
      if (this.catalog.hip[idx] === 0) continue;
      if (next.indexOf(idx) >= 0) continue;
      next.push(idx);
    }
    if (
      next.length === this.pois.length &&
      next.every((v, i) => v === this.pois[i])
    ) return;
    this.pois = next;
    this.firePoisChange();
  }

  clearPois() {
    if (this.pois.length === 0) return;
    this.pois = [];
    this.firePoisChange();
  }

  private firePoisChange() {
    for (const h of this.onPoisHandlers) h(this.pois);
    this.fireStateChange();
  }

  /**
   * Switch between the two camera modes. OBSERVE parks the camera at the
   * focused star and swaps TrackballControls for an in-place look-around
   * controller. NAVIGATE is the default orbit-camera flow.
   *
   * Defensive against:
   *   - re-entry while a transition is in flight (no-op)
   *   - request matching the current mode (no-op)
   *   - OBSERVE without a focused star (no-op — the UI gates the toggle but
   *     URL state could carry mode=observe without a focus)
   *   - OBSERVE during warp / aim (no-op — those animations own the camera)
   *
   * `animate=false` skips the transition; used by URL restore so a shared
   * link with mode=observe lands instantly at the parked pose.
   */
  setCameraMode(mode: CameraMode, opts: { animate?: boolean } = {}) {
    if (mode === this.cameraMode) return;
    if (this.warpState) return;
    if (this.observeTransition) return;
    if (mode === 'observe') {
      if (this.focusedStar === null) return;
      if (this.warpState || this.aimState) return;
      // Drop any drawn vector — measurement endpoints don't survive a
      // perspective change to "I'm standing on the source."
      this.setVectorTo(null);
      this.setVectorToCloud(null);
      this.cameraMode = 'observe';
      this.controls.enabled = false;
      if (opts.animate === false) {
        // Snap. Camera quaternion is preserved; only its position moves to
        // the focal star's local origin. Hide the focal star here since
        // there's no transition to defer to.
        this.camera.position.set(0, 0, 0);
        this.material.uniforms.uHideFocusIdx.value = this.focusedStar;
        this.observeControls.enable();
      } else {
        // Animated entry: keep the focal star visible during the glide.
        // finishObserveTransition (kind='enter') sets uHideFocusIdx once
        // the camera is parked at the star, so the star doesn't pop out
        // before the camera reaches it.
        this.observeTransition = {
          startTimeMs: performance.now(),
          durationMs: OBSERVE_TRANSITION_MS,
          fromPos: this.camera.position.clone(),
          toPos: new THREE.Vector3(0, 0, 0),
          kind: 'enter',
        };
      }
      for (const h of this.onCameraModeHandlers) h(this.cameraMode);
      this.fireStateChange();
      return;
    }

    // mode === 'navigate'
    this.startObserveExit({
      animate: opts.animate !== false,
      clearFocusOnExit: false,
    });
  }

  // Shared exit path from OBSERVE → navigate. Used by both the navigate-mode
  // toggle (focus retained) and the location-search X button
  // (clearFocusOnExit=true; setFocus(null) runs on landing). Always emits the
  // mode-change + state-change events so listeners settle once per exit
  // regardless of which path triggered it.
  private startObserveExit(opts: { animate: boolean; clearFocusOnExit: boolean }) {
    if (this.cameraMode !== 'observe') return;
    this.cameraMode = 'navigate';
    this.material.uniforms.uHideFocusIdx.value = -1;
    this.observeControls.disable();
    // Cancel any in-flight observe aim — its post-flight re-enable would
    // fight the upcoming exit transition / TrackballControls handover.
    this.observeAimState = null;

    if (!opts.animate || this.focusedStar === null) {
      // Hard switch. controls.target snaps back to the focal star's local
      // origin (or world origin when unfocused) and TrackballControls
      // re-enables.
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      this.controls.enabled = true;
      if (opts.clearFocusOnExit) this.setFocus(null);
    } else {
      // Pull back along the camera's current view direction so whatever the
      // user was just looking at stays roughly forward after exit. Distance
      // = the focal star's effective minDistance, so orbit picks up exactly
      // where it would on a fresh focus.
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const minDist = this.minDistForStar(this.focusedStar);
      this.observeTransition = {
        startTimeMs: performance.now(),
        durationMs: OBSERVE_TRANSITION_MS,
        fromPos: this.camera.position.clone(),
        toPos: forward.multiplyScalar(-minDist),
        kind: 'exit',
        clearFocusOnExit: opts.clearFocusOnExit,
      };
    }
    for (const h of this.onCameraModeHandlers) h(this.cameraMode);
    this.fireStateChange();
  }

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
    // OBSERVE depends on a focused star anchor. Any change to the anchor
    // (unfocus or switch to another star) bails out of observe immediately.
    // Snap rather than animate because a transition needs the original
    // anchor to mean anything.
    if (this.cameraMode === 'observe') {
      this.observeTransition = null;
      this.observeAimState = null;
      this.cameraMode = 'navigate';
      this.material.uniforms.uHideFocusIdx.value = -1;
      this.observeControls.disable();
      this.controls.enabled = true;
      for (const h of this.onCameraModeHandlers) h(this.cameraMode);
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
      // After recenterOrigin, the focused star is at local (0,0,0). Snap
      // controls.target to (0,0,0) and shift camera by the same delta so
      // the camera-to-target relationship is preserved — the user-visible
      // pose doesn't change. Without this, target lands at -dx (where dx
      // is whatever recenterOrigin shifted by) and the per-frame pin guard
      // (target.lengthSq < 1e-12) silently disengages whenever Sol's
      // catalog offset (5e-6 pc) or a long warp's |AB|·1e-7 Float32
      // residual leaks through. Every call site that sets target+camera
      // before setFocus relies on this snap to land cleanly.
      const t = this.controls.target;
      this.camera.position.x -= t.x;
      this.camera.position.y -= t.y;
      this.camera.position.z -= t.z;
      t.set(0, 0, 0);
    } else {
      this.recenterOrigin(this.tmpRecenter.set(0, 0, 0));
    }
    this.controls.minDistance = idx !== null ? this.minOrbitDistForStar(idx) : GLOBAL_MIN_DIST_PC;
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
  // Stellata is already rendering — uniforms flip atomically on the next
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
   *  (e.g. `stellata.milkywayLayer.setBrightness(0.4)`). */
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
   *  (`stellata.cloudLayer.setOpacity(0.5)` etc.). null until
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
    // OBSERVE doesn't draw vectors. Defensive: search "To" or URL state
    // could try to write one — drop the value rather than fight an invalid
    // overlay state.
    if (idx !== null && (this.cameraMode === 'observe' || this.observeTransition)) return;
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
    if (idx !== null && (this.cameraMode === 'observe' || this.observeTransition)) return;
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
    if (this.warpState) return;
    if (
      this.focusedStar === null && this.focusedCloud === null &&
      this.vectorTo === null && this.vectorToCloud === null
    ) return;
    this.setVectorTo(null);
    this.setVectorToCloud(null);
    // X-out from OBSERVE: clear focus FIRST so the search box empties as
    // soon as the user clicks (via onFocusChange → syncFocusUI), then
    // animate the same zoom-out the navigate-mode toggle uses. The
    // animation runs in the post-recenter (Sol-centric) frame because
    // setFocus(null) recentres the floating origin.
    if (this.cameraMode === 'observe' && this.focusedStar !== null) {
      const focalIdx = this.focusedStar;
      const minDist = this.minDistForStar(focalIdx);
      // Quaternion → forward is frame-invariant, so capture before the
      // recenter rebases coordinates.
      const forward = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(this.camera.quaternion);

      // Exit observe internals.
      this.cameraMode = 'navigate';
      this.material.uniforms.uHideFocusIdx.value = -1;
      this.observeControls.disable();
      this.observeAimState = null;

      // setFocus(null) recentres origin → camera.position translates;
      // search box clears via the onFocusChange handler. cameraMode is
      // already 'navigate' so the observe-cleanup branch inside setFocus
      // is skipped.
      this.setFocus(null);

      const fromPos = this.camera.position.clone();
      const toPos = fromPos.clone().addScaledVector(forward, -minDist);
      this.observeTransition = {
        startTimeMs: performance.now(),
        durationMs: OBSERVE_TRANSITION_MS,
        fromPos,
        toPos,
        kind: 'exit',
        // Focus has already been cleared above — nothing for
        // finishObserveTransition to clean up.
        clearFocusOnExit: false,
      };
      for (const h of this.onCameraModeHandlers) h(this.cameraMode);
      this.fireStateChange();
      return;
    }
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

  // Camera FOV setter. Updates the projection matrix, mirrors the new FOV
  // into uFovYRad (drives the angular-diameter shader formula), recomputes
  // the focused star's orbit floor (which depends on FOV), rebases
  // non-overridden pixel sizes (arcsec/px depends on FOV), and fires a
  // state change so URL sync picks up the new value.
  setCameraFov(fov: number) {
    if (this.camera.fov === fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.material.uniforms.uFovYRad.value = (fov * Math.PI) / 180;
    if (this.focusedStar !== null) {
      this.controls.minDistance = this.minOrbitDistForStar(this.focusedStar);
    }
    this.recomputePresetPxSizes();
    for (const h of this.onFilterHandlers) h(this.filter);
    this.fireStateChange();
  }
  getCameraFov(): number { return this.camera.fov; }

  // Star exaggeration K setter for the debug panel. Patches the K for one
  // preset (defaulting to the active preset), recomputes MAG_PRESETS (their
  // size targets scale with K) and writes new pixel sizes into any
  // non-overridden fields so the change shows live.
  setStarExaggerationK(k: number, preset?: MagPresetName) {
    const name = preset ?? this.filter.activePreset;
    starExaggerationK[name] = k;
    MAG_PRESETS = computeMagPresets();
    this.recomputePresetPxSizes();
    // Fire even when recompute patched nothing (e.g. sizes overridden) so
    // the debug readout reflects the new K.
    for (const h of this.onFilterHandlers) h(this.filter);
    this.fireStateChange();
  }
  getStarExaggerationK(preset?: MagPresetName): number {
    return starExaggerationK[preset ?? this.filter.activePreset];
  }
  getStarExaggerationKDefault(preset?: MagPresetName): number {
    return STAR_EXAGGERATION_K_DEFAULTS[preset ?? this.filter.activePreset];
  }

  // Star-disc rendering knobs (debug panel). Patch any subset; uVisibleK
  // is recomputed whenever uVisibleThreshold changes. Both materials share
  // the same uniforms object so a single write hits the disc + glow passes.
  setStarRenderParams(patch: Partial<StarRenderParams>) {
    const u = this.material.uniforms;
    if (patch.visibleThreshold !== undefined) {
      u.uVisibleThreshold.value = patch.visibleThreshold;
      u.uVisibleK.value = -Math.log(patch.visibleThreshold);
    }
    if (patch.coreThreshold !== undefined) u.uCoreThreshold.value = patch.coreThreshold;
    if (patch.discardThreshold !== undefined) u.uDiscardThreshold.value = patch.discardThreshold;
    if (patch.distNMin !== undefined) u.uDistNMin.value = patch.distNMin;
    if (patch.distNMax !== undefined) u.uDistNMax.value = patch.distNMax;
    if (patch.lumBiasMin !== undefined) u.uLumBiasMin.value = patch.lumBiasMin;
    if (patch.lumBiasMax !== undefined) u.uLumBiasMax.value = patch.lumBiasMax;
  }
  getStarRenderParams(): StarRenderParams {
    const u = this.material.uniforms;
    return {
      visibleThreshold: u.uVisibleThreshold.value,
      coreThreshold: u.uCoreThreshold.value,
      discardThreshold: u.uDiscardThreshold.value,
      distNMin: u.uDistNMin.value,
      distNMax: u.uDistNMax.value,
      lumBiasMin: u.uLumBiasMin.value,
      lumBiasMax: u.uLumBiasMax.value,
    };
  }

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
    this.hudOverlay.setMonochrome(on);
    this.clouds?.setMonochrome(on);
    // The milky-way layer used to fully hide in chart mode, but Phase 8
    // re-purposes it to render an isobar contour. Visibility/contour
    // are now driven by the chart-mode orchestrator via
    // `setMilkywayIsobar` and `setCloudsIsobar` below — call them
    // alongside setMonochrome.
    this.fireStateChange();
  }

  /** Chart-mode isobar pass on/off for the molecular cloud layer.
   *  Wires the shader's uMaxAppMag uniform to the stellata's shared
   *  reference so the contour tracks the magnitude slider live. */
  setCloudsIsobar(on: boolean) {
    this.clouds?.setIsobar(on, this.material.uniforms.uMaxAppMag);
  }

  /** Chart-mode isobar pass on/off for the milky-way layer. */
  setMilkywayIsobar(on: boolean) {
    this.milkyway.setIsobar(on);
  }

  /** Chart-mode disc sizing parameters — JS mirror of the GPU
   *  uniforms, so chart-labels.ts can compute the same disc pixel size
   *  the vertex shader produces. Variable rings + binary wings rely on
   *  this to align with the rendered glyph. */
  getChartDiscParams(): { maxPx: number; minPx: number; magBright: number } {
    const u = this.material.uniforms;
    return {
      maxPx: u.uChartDiscMaxPx.value as number,
      minPx: u.uChartDiscMinPx.value as number,
      magBright: u.uChartMagBright.value as number,
    };
  }

  focusStar(starIndex: number, distancePc = 2) {
    if (this.warpState) return;
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
    if (this.observeTransition) return;
    // Warp launched from OBSERVE: leave cameraMode='observe' for the
    // duration so the search-row label, mode toggle, and any other
    // mode-bound UI don't flicker through navigate while the warp runs.
    // The animate loop branches off warpState first, so the cosmetic
    // mode value never reaches observeUpdateTarget. uHideFocusIdx stays
    // pinned to the source star — the reorient begins with the camera at
    // A, and unhiding it would briefly render the source disc from the
    // camera's interior.
    let returnToObserve = false;
    if (this.cameraMode === 'observe') {
      this.observeAimState = null;
      this.observeControls.disable();
      returnToObserve = destKind === 'star';
    }
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
    // Observe-mode warp starts with the camera AT A (mag0 ≈ 0) and a
    // user-chosen look direction. lookAt(A) per frame collapses to "snap to
    // facing forward" the moment the camera moves off A, so we slerp the
    // quaternion across the reorient phase instead. Endpoint = the
    // orientation lookAt(A) would produce from pStart, captured here so the
    // reorient interpolates from observe view → fly orientation smoothly.
    let reorientEndQuaternion: THREE.Quaternion | undefined;
    if (returnToObserve) {
      const m = new THREE.Matrix4().lookAt(pStart, A, this.camera.up);
      reorientEndQuaternion = new THREE.Quaternion().setFromRotationMatrix(m);
    }
    this.warpState = {
      startTimeMs: performance.now(),
      reorientMs: WARP_REORIENT_MS,
      durationMs,
      // Post-arrival slerp only runs when we're returning to OBSERVE.
      // Navigate-mode arrival re-engages TrackballControls, whose update()
      // calls camera.lookAt(target=B) every frame — applying a 1.2 s
      // parallax slerp there would just be overwritten one frame later
      // when controls re-asserts itself, leaving the user with a
      // jarring snap-back. Skipping the slerp on navigate keeps the
      // landing visually consistent with how navigate-mode focuses
      // already work.
      postArrivalMs: returnToObserve ? OBSERVE_TRANSITION_MS : 0,
      A,
      dir0,
      mag0,
      dirBack,
      pStart,
      pEnd,
      endOffset,
      destKind,
      destIdx,
      returnToObserve,
      startQuaternion: this.camera.quaternion.clone(),
      reorientEndQuaternion,
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
    // Final parked pose. Differs by destination mode:
    //   observe: camera at B, quaternion = startQuaternion (post-arrival
    //            slerp end state — same celestial direction the user was
    //            looking at warp start, now from the new vantage). The
    //            post-arrival phase already lerped position pEnd → B, so
    //            this is a no-op match against the last animation frame.
    //            swapObserveAnchor below recentres the origin onto B and
    //            its set(0,0,0) becomes a redundant snap to the same
    //            point — no hidden teleport.
    //   navigate: camera at B − endOffset · forward (orbit radius matches
    //            the arrival we animated to), lookAt(B) so the orbit
    //            invariant TrackballControls.update() will enforce next
    //            frame matches the parked pose.
    if (state.returnToObserve) {
      this.camera.position.copy(B);
      this.camera.quaternion.copy(state.startQuaternion).normalize();
    } else {
      const forward = new THREE.Vector3().subVectors(B, state.pStart).normalize();
      this.camera.position.copy(B).addScaledVector(forward, -state.endOffset);
      this.camera.lookAt(B);
    }
    this.controls.target.copy(B);
    this.warpState = null;
    // Clear both vector slots — vector destination has been reached, so
    // the measurement line should retire either way.
    this.setVectorTo(null);
    this.setVectorToCloud(null);
    if (state.destKind === 'star' && state.returnToObserve) {
      // observe→observe arrival. swapObserveAnchor updates focus, recentres
      // the floating origin, and sets uHideFocusIdx to the destination,
      // all without flipping cameraMode through navigate (which is what
      // setFocus would do, triggering an onCameraModeChange flicker).
      this.swapObserveAnchor(state.destIdx);
      this.observeControls.enable();
      // controls.enabled stays false — observe owns the camera now.
    } else {
      // navigate-mode arrival. Source-star hide expires with the warp; the
      // destination star (if any) renders normally.
      this.material.uniforms.uHideFocusIdx.value = -1;
      if (state.destKind === 'star') {
        this.setFocus(state.destIdx);
        // Re-anchor camera and target in the clean dest-local frame after
        // setFocus's recenterOrigin runs. The earlier writes used B from
        // _localPositions (Float32) while recenterOrigin's dx is computed
        // fresh in float64 — the difference leaves controls.target offset
        // by a ~|AB|·1e-7 residual, which on long warps to small stars
        // disengages the pin guard (lengthSq < 1e-12) and lands the dest
        // visibly off-centre. Snapping to clean values here avoids that.
        const forward = new THREE.Vector3().subVectors(B, state.pStart).normalize();
        this.controls.target.set(0, 0, 0);
        this.camera.position.copy(forward).multiplyScalar(-state.endOffset);
        this.camera.lookAt(this.controls.target);
      } else {
        this.setFocusedCloud(state.destIdx);
      }
      this.controls.enabled = true;
      this.controls.update();
    }
    for (const h of this.onWarpHandlers) h(false);
  }

  // Swap the OBSERVE anchor to a new star without going through setFocus's
  // observe-cleanup branch (which would flip cameraMode to navigate and
  // emit an onCameraModeChange event, briefly flickering UI bound to the
  // mode value). Used by finishWarp on observe→observe arrival.
  private swapObserveAnchor(newIdx: number) {
    const p = this.catalog.positions;
    this.recenterOrigin(this.tmpRecenter.set(
      p[newIdx * 3], p[newIdx * 3 + 1], p[newIdx * 3 + 2],
    ));
    this.focusedStar = newIdx;
    this.material.uniforms.uHideFocusIdx.value = newIdx;
    this.controls.minDistance = this.minOrbitDistForStar(newIdx);
    // Park at the new anchor's local origin — observe invariant is
    // camera at (0,0,0) under the floating origin. Quaternion preserved
    // from the post-arrival slerp end state.
    this.camera.position.set(0, 0, 0);
    for (const h of this.onFocusHandlers) h(newIdx);
    this.fireStateChange();
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
    if (this.observeTransition) return;
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
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-30);
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

    if (this.cameraMode === 'observe') {
      // Camera is parked at the focal star — just rotate the view to face
      // the centroid through the shared observe-mode aim slerp. Distance
      // doesn't matter; only the direction from camera to `c` is used.
      this.aimAt(c);
      return;
    }

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
    if (this.observeTransition) return;
    if (this.cameraMode === 'observe') {
      if (this.observeAimState) return;
      // Camera is fixed at the focal star; orientation changes only. Build
      // the target quaternion from a lookAt towards `pointLocal` and slerp
      // the live camera quaternion across the transition. controls.target
      // is regenerated from the quaternion each frame by observeUpdateTarget,
      // so we only animate the rotation.
      const aimDx = pointLocal.x - this.camera.position.x;
      const aimDy = pointLocal.y - this.camera.position.y;
      const aimDz = pointLocal.z - this.camera.position.z;
      if (aimDx * aimDx + aimDy * aimDy + aimDz * aimDz < 1e-6) return;

      const lookMat = new THREE.Matrix4().lookAt(
        this.camera.position,
        pointLocal,
        this.camera.up,
      );
      const q1 = new THREE.Quaternion().setFromRotationMatrix(lookMat);
      const q0 = this.camera.quaternion.clone();
      const dot = Math.min(1, Math.abs(q0.dot(q1)));
      if (dot > 0.99999) return;
      // Geodesic angle between two unit quaternions is 2·acos(|q0·q1|).
      const angle = 2 * Math.acos(dot);
      const durationMs = Math.max(
        AIM_T_MIN_MS,
        Math.min(AIM_T_MAX_MS, (angle / Math.PI) * AIM_T_MAX_MS),
      );

      this.observeControls.disable();
      this.observeAimState = {
        startTimeMs: performance.now(),
        durationMs,
        q0,
        q1,
      };
      return;
    }

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

  // OBSERVE-mode aim. Slerps the camera's quaternion from start to target
  // orientation while leaving its position alone, then re-enables the
  // observe input controller on completion.
  private updateObserveAim() {
    const state = this.observeAimState;
    if (!state) return;
    const elapsed = performance.now() - state.startTimeMs;
    const u = Math.min(1, elapsed / state.durationMs);
    const f = u * u * (3 - 2 * u);
    this.observeAimQ.copy(state.q0).slerp(state.q1, f);
    this.camera.quaternion.copy(this.observeAimQ);
    if (u >= 1) {
      this.observeAimState = null;
      this.observeControls.enable();
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
    const { absmag, spectClass, amplitudeMag, periodDays } = this.catalog;
    const f = this.filter;
    const v = new THREE.Vector3();
    // Floor on the prime-disc hit radius. Tiny chart-mode discs (down to
    // 1–2 px) leave a sub-pixel target that the cursor can easily miss
    // even when visually right on top of the star. Hover then falls
    // through to the proximity fallback only if no other disc has won —
    // which on a crowded chart it often has, so the small star never
    // surfaces. Floor the disc-test radius to a value the cursor can
    // realistically land within.
    const MIN_DISC_HIT_RADIUS_PX = 4;

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
      const dCam = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-30);
      const appMag = absmag[i] + 5 * (Math.log10(dCam) - 1);
      // For variables, use the bright-extreme appMag so a star whose
      // disc is only visible at peak phase remains pickable across the
      // whole cycle. Without this, a variable with static appMag just
      // above the limit gets dropped here even though the GPU shows
      // its disc whenever magMod swings negative.
      const amp = periodDays[i] > 0 ? amplitudeMag[i] : 0;
      const filterMag = appMag - amp * 0.5;
      if (filterMag > f.maxAppMag) continue;

      v.set(x, y, z).project(this.camera);
      if (v.z < -1 || v.z > 1) continue;
      const screenX = (v.x + 1) * 0.5 * viewportW;
      const screenY = (1 - v.y) * 0.5 * viewportH;
      const pxDist = Math.hypot(cursorX - screenX, cursorY - screenY);
      const pxSize = this.renderedSizePx(i);
      const hitRadius = Math.max(pxSize * 0.5, MIN_DISC_HIT_RADIUS_PX);

      if (pxDist <= hitRadius) {
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
    this.material.uniforms.uViewport.value.set(w, h);
    // Aspect change → fov_minor moves → orbit floor needs a refresh while
    // a star is focused. (FOV-only changes go through setCameraFov, which
    // does its own recompute.)
    if (this.focusedStar !== null) {
      this.controls.minDistance = this.minOrbitDistForStar(this.focusedStar);
    }
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

  // Rendered pixel diameter for a star from the current camera. Mirrors
  // the vertex-shader angular-diameter formula exactly — callers include
  // the focus-ring overlay, the disc mask, and pickStar. Variability
  // modulation is replicated with the same headroom-compression rule so
  // the mask tracks the rendered disc through a pulse.
  // Keep in sync with star.vert.glsl if the shader size computation changes.
  renderedSizePx(idx: number): number {
    const positions = this._localPositions;
    const { physicalRadius, absmag, periodDays, amplitudeMag } = this.catalog;
    const camPos = this.camera.position;
    const u = this.material.uniforms;

    const dx = positions[idx * 3] - camPos.x;
    const dy = positions[idx * 3 + 1] - camPos.y;
    const dz = positions[idx * 3 + 2] - camPos.z;
    // 1e-30 floor on dCam: keeps log10(dCam) finite in the appMag calc
    // without clamping the angular-diameter atan(R/d) at close approach.
    const dCam = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-30);
    let appMag = absmag[idx] + 5 * (Math.log10(dCam) - 1);

    const fovYRad = u.uFovYRad.value as number;
    const viewport = u.uViewport.value as THREE.Vector2;
    const angularToPx = viewport.y / Math.max(fovYRad, 1e-9);
    const R = Math.max(physicalRadius[idx], 1e-6) * R_SUN_PC;
    const baseSize = 2 * Math.atan(R / dCam) * angularToPx;
    const maxPhysSize = ZOOM_FLOOR_FRACTION * Math.min(viewport.x, viewport.y);

    // Variability — same compression rule as the shader: effective
    // amplitude is clamped so peak ≤ maxPhysSize and trough ≥ 20% of
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
      const maxUpLog10 = Math.log10(Math.max(maxPhysSize / Math.max(baseSize, 1), 1));
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

    const physSize = 2 * Math.atan((R * radiusFactor) / dCam) * angularToPx;

    return Math.max(appSize, physSize);
  }

  // Smaller of the camera's vertical and horizontal FOV in radians. The
  // disc-fill geometry uses the minor axis so the target fraction reads
  // consistently in both portrait and landscape viewports.
  private fovMinorRad(): number {
    const fovY = (this.camera.fov * Math.PI) / 180;
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * this.camera.aspect);
    return Math.min(fovX, fovY);
  }

  // Manual-zoom floor for TrackballControls when a star is focused. The
  // camera can orbit down to where the focused star's true angular disc
  // fills ZOOM_FLOOR_FRACTION of the viewport's minor axis — same on-
  // screen coverage for any star, regardless of physical radius. Solves
  // for d in `2·atan(R/d) = ZOOM_FLOOR_FRACTION · fov_minor`. Binary
  // companions still get the half-angle bump so the partner stays in
  // frame.
  private minOrbitDistForStar(idx: number): number {
    const fovMinor = this.fovMinorRad();
    const R = Math.max(this.catalog.physicalRadius[idx], 1e-9) * R_SUN_PC;
    const base = R / Math.tan((ZOOM_FLOOR_FRACTION * fovMinor) / 2);

    const comp = this.catalog.companion[idx];
    if (comp < 0) return base;
    const p = this.catalog.positions;
    const dx = p[comp * 3] - p[idx * 3];
    const dy = p[comp * 3 + 1] - p[idx * 3 + 1];
    const dz = p[comp * 3 + 2] - p[idx * 3 + 2];
    const sep = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Math.max(base, sep * BINARY_MIN_DIST_FACTOR);
  }

  // Auto-park target — used by observe-exit landing, warp source
  // departure, and warp arrival. Distance solves `2·atan(R/d) =
  // TARGET_PARK_FRACTION · fov_minor`, so every star fills the same
  // fraction of the viewport on arrival regardless of physical radius
  // (supergiants land much further out than dwarfs in absolute parsecs).
  // Floored at twice the orbit floor so the parking distance always
  // sits clearly above the manual-zoom limit. For binaries the result
  // is bumped so the companion stays within the viewport half-angle.
  minDistForStar(idx: number): number {
    const fovMinor = this.fovMinorRad();
    const R = Math.max(this.catalog.physicalRadius[idx], 1e-9) * R_SUN_PC;
    const dPark = R / Math.tan((TARGET_PARK_FRACTION * fovMinor) / 2);
    const dMin = R / Math.tan((ZOOM_FLOOR_FRACTION * fovMinor) / 2);
    const parkFloored = Math.max(dPark, 2 * dMin);

    const comp = this.catalog.companion[idx];
    if (comp < 0) return parkFloored;
    const p = this.catalog.positions;
    const dx = p[comp * 3] - p[idx * 3];
    const dy = p[comp * 3 + 1] - p[idx * 3 + 1];
    const dz = p[comp * 3 + 2] - p[idx * 3 + 2];
    const sep = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Math.max(parkFloored, sep * BINARY_MIN_DIST_FACTOR);
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
    if (this.observeTransition) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (dx * dx + dy * dy > 25) return;
    if (performance.now() - down.t > 500) return;

    // OBSERVE has its own single/double-click dispatcher: single-click
    // pins the star under the cursor as a POI, double-click slerps the
    // camera so the clicked direction lands at view centre. Single-click
    // is held for OBSERVE_DBL_CLICK_MS to give the second click a window
    // to arrive.
    if (this.cameraMode === 'observe') {
      this.handleObserveClick(e.clientX, e.clientY);
      return;
    }

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

  private handleObserveClick(x: number, y: number) {
    const pending = this.observePendingClick;
    if (pending) {
      const dx = x - pending.x;
      const dy = y - pending.y;
      if (dx * dx + dy * dy <= Stellata.OBSERVE_DBL_CLICK_DIST_PX_SQ) {
        // Second click close in time + space → double-click. Cancel the
        // pending single-click and slerp the camera instead.
        window.clearTimeout(pending.timer);
        this.observePendingClick = null;
        this.observeDoubleClick(x, y);
        return;
      }
      // Far apart → treat as a fresh first click. Fire the original
      // pending single-click immediately (so the user's first pin doesn't
      // get swallowed) and start a new pending timer for this one.
      window.clearTimeout(pending.timer);
      this.observePendingClick = null;
      this.observeSingleClick(pending.x, pending.y);
    }
    const timer = window.setTimeout(() => {
      this.observePendingClick = null;
      this.observeSingleClick(x, y);
    }, Stellata.OBSERVE_DBL_CLICK_MS);
    this.observePendingClick = { x, y, timer };
  }

  private observeSingleClick(x: number, y: number) {
    // Mirror the POI overlay visibility gate — toggling without a visible
    // ring/arrow would change state with no feedback.
    if (!this.filter.showHud || this.isObserveTransitionActive()) return;
    const idx = this.pickStar(x, y);
    if (idx < 0) return;
    this.togglePoi(idx);
  }

  // Reusable scratch for the double-click ray unproject. Allocated once.
  private dblClickRay = new THREE.Vector3();
  private dblClickAimPoint = new THREE.Vector3();

  private observeDoubleClick(x: number, y: number) {
    // Convert (clientX, clientY) → NDC → unproject → world ray direction.
    // Build a far point along the ray and feed it to aimAt — that path
    // already handles the quaternion slerp, the duration ramp, and
    // disabling observeControls for the duration.
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dblClickRay.set((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5);
    this.dblClickRay.unproject(this.camera);
    this.dblClickRay.sub(this.camera.position).normalize();
    this.dblClickAimPoint.copy(this.camera.position).addScaledVector(this.dblClickRay, 1e6);
    this.aimAt(this.dblClickAimPoint);
  }

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

  // Rotate the camera around the view direction.
  //
  // NAVIGATE: mutate camera.up — TrackballControls reads it every update()
  // and the orbit math needs the rolled vertical to persist through
  // subsequent orbit/zoom.
  //
  // OBSERVE: rotate camera.quaternion to actually roll the rendered image.
  // Also rotate camera.up by the same angle even though observe-controls.ts
  // doesn't read it: the URL state encodes camera.up, so leaving it stale
  // would lose the roll on round-trip (observe entry rebuilds the
  // quaternion from cam/tgt/up, dropping any roll baked into the
  // quaternion alone).
  private rollCamera(angle: number) {
    const forward = new THREE.Vector3()
      .subVectors(this.controls.target, this.camera.position);
    if (forward.lengthSq() === 0) return;
    forward.normalize();
    this.camera.up.applyAxisAngle(forward, angle).normalize();
    if (this.cameraMode === 'observe') {
      const q = new THREE.Quaternion().setFromAxisAngle(forward, angle);
      this.camera.quaternion.premultiply(q).normalize();
    }
  }

  // Pixel size below which a disc-pass core's bleed-through is small enough
  // that we don't bother enabling the depth mask. Conservative — at this
  // pivot a max-radius supergiant only takes a handful of pixels on screen.
  private static readonly CORE_MASK_MIN_PX = 5;

  // Should the core depth-mask render this frame? True iff at least one
  // star is close enough to the camera that its physSize term could exceed
  // CORE_MASK_MIN_PX. Derived from the live uniforms, so changing
  // exaggeration K, FOV, or viewport keeps the gate honest.
  //
  // Uses the sorted-by-distance-from-Sol index plus the triangle
  // inequality: any star within `dThresh` of the camera must have
  // |distFromSol(star) - distFromSol(camera)| <= dThresh. We binary-
  // search that window in the sorted array (typically tens to hundreds of
  // candidates) and only do the squared-distance check on those. Replaces
  // a full 313k-element linear scan that ran every frame in every mode.
  private shouldEnableCoreMask(): boolean {
    // Largest catalog star at distance d subtends 2·atan(R_max/d) radians,
    // which is CORE_MASK_MIN_PX × fov_y / viewport.y radians at the
    // threshold. Solve for d → R_max / tan(half-angle).
    const u = this.material.uniforms;
    const fovYRad = u.uFovYRad.value as number;
    const viewport = u.uViewport.value as THREE.Vector2;
    const halfAngle = (Stellata.CORE_MASK_MIN_PX * fovYRad)
      / (Math.max(viewport.y, 1) * 2);
    const dThresh = this.maxPhysicalRadiusPc / Math.max(Math.tan(halfAngle), 1e-30);
    const dThreshSq = dThresh * dThresh;

    // Camera distance from Sol in absolute space (catalog frame).
    const camAbsX = this.camera.position.x + this.worldOffset.x;
    const camAbsY = this.camera.position.y + this.worldOffset.y;
    const camAbsZ = this.camera.position.z + this.worldOffset.z;
    const camDistFromSol = Math.sqrt(
      camAbsX * camAbsX + camAbsY * camAbsY + camAbsZ * camAbsZ,
    );
    const lo = camDistFromSol - dThresh;
    const hi = camDistFromSol + dThresh;

    const sortedDist = this.sortedDistFromSol;
    const sortedIdx = this.sortedByDistFromSol;
    const n = sortedDist.length;
    // Lower bound: first index with sortedDist[i] >= lo.
    let l = 0, r = n;
    while (l < r) {
      const m = (l + r) >>> 1;
      if (sortedDist[m] < lo) l = m + 1; else r = m;
    }
    const start = l;
    // Upper bound: first index with sortedDist[i] > hi.
    l = start; r = n;
    while (l < r) {
      const m = (l + r) >>> 1;
      if (sortedDist[m] <= hi) l = m + 1; else r = m;
    }
    const end = l;

    const positions = this._localPositions;
    const cx = this.camera.position.x;
    const cy = this.camera.position.y;
    const cz = this.camera.position.z;
    for (let k = start; k < end; k++) {
      const i = sortedIdx[k];
      const dx = positions[i * 3] - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      if (dx * dx + dy * dy + dz * dz < dThreshSq) return true;
    }
    return false;
  }

  private animateStartMs = performance.now();
  private animate = () => {
    if (this.disposed) return;
    perfMark('frame.total');
    perfMark('controls.update');
    if (this.warpState) {
      this.updateWarp();
    } else if (this.aimState) {
      this.updateAim();
    } else if (this.observeAimState) {
      this.updateObserveAim();
      // Observe-mode aim slerps the camera quaternion in place. The
      // controls.target still needs the per-frame re-pin so URL state stays
      // truthful mid-flight.
      this.observeUpdateTarget();
    } else if (this.observeTransition) {
      this.updateObserveTransition();
    } else if (this.cameraMode === 'observe') {
      // Look-around input (yaw/pitch/roll/FOV) mutates the camera directly
      // via observeControls + the existing two-finger handlers. update()
      // here advances any post-release momentum from a flick. Per-frame
      // we also re-pin controls.target one parsec ahead of the camera so
      // URL state writers (which serialise camera.position + target)
      // still round-trip the look direction correctly.
      this.observeControls.update();
      this.observeUpdateTarget();
    } else {
      this.controls.update();
    }
    perfMeasure('controls.update');
    perfMark('pre-render');
    this.material.uniforms.uCameraPos.value.copy(this.camera.position);
    // Pin the focused star at NDC (0,0) only when the geometric
    // invariant holds: navigate mode, no warp/aim animation, and the
    // user hasn't panned the camera target away from the focused star
    // (target ≈ local origin). Pan moves target away from the star and
    // we want it to render at its actual projected position again.
    const pinTarget = (
      this.focusedStar !== null &&
      this.cameraMode === 'navigate' &&
      !this.warpState && !this.aimState &&
      this.controls.target.lengthSq() < 1e-12
    ) ? this.focusedStar : -1;
    this.material.uniforms.uPinFocusToCenter.value = pinTarget;
    // Advance variability clock (seconds since start). Shared with glow
    // material via sharedUniforms so both passes see the same time.
    this.material.uniforms.uTime.value = (performance.now() - this.animateStartMs) / 1000;
    perfMark('coreMask');
    this.coreMaskMesh.visible = this.shouldEnableCoreMask();
    perfMeasure('coreMask');
    this.updateGalacticLayers();
    // Milky Way analytic background. The skybox mesh is already in the
    // main scene at renderOrder = -3; this call re-anchors it to
    // camera.position and refreshes the absolute-camera-position uniform
    // for the shader's raymarch.
    this.milkyway.update(this.camera, this.worldOffset);
    perfMeasure('pre-render');
    perfMark('gpu.render');
    this.renderer.render(this.scene, this.camera);
    perfMeasure('gpu.render');
    perfMark('onFrame.total');
    for (const h of this.onFrameHandlers) h();
    perfMeasure('onFrame.total');
    perfMeasure('frame.total');
    perfFrame();
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
      this.hudOverlay.setVisible(false);
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

    if (this.filter.showGalacticGrid) {
      this.galacticGrid.group.visible = true;
      this.galacticGrid.update(this.camera.position);
    } else {
      this.galacticGrid.group.visible = false;
    }

    const focusedLocal =
      this.focusedStar !== null ? this.starLocalPosition(this.focusedStar) : null;
    const isSolFocus =
      this.focusedStar !== null && this.focusedStar === this.catalog.solIndex;
    this.hudOverlay.update({
      enabled: this.filter.showHud,
      camera: this.camera,
      target: this.controls.target,
      worldOffset: this.worldOffset,
      focusedLocal,
      hideSolArrow: isSolFocus,
      sizeMaxPx: this.filter.sizeMax,
      cameraMode: this.cameraMode,
      transition: this.getObserveTransitionProgress(),
      w: window.innerWidth,
      h: window.innerHeight,
    });

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
      if (state.reorientEndQuaternion) {
        // Observe-mode launch: slerp the camera quaternion from the user's
        // view direction to the fly-start orientation. Replaces lookAt(A),
        // which would snap to "facing forward" the instant the camera
        // leaves A.
        this.warpQ0.copy(state.startQuaternion).slerp(state.reorientEndQuaternion, f);
        this.camera.quaternion.copy(this.warpQ0).normalize();
      } else {
        this.camera.lookAt(state.A);
      }
      return;
    }

    // Fly phase: symmetric accelerate/decelerate along the A→B line.
    const flyElapsed = elapsed - state.reorientMs;
    if (flyElapsed < state.durationMs) {
      const t = flyElapsed / state.durationMs;
      const f = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
      this.camera.position.lerpVectors(state.pStart, state.pEnd, f);
      const B = state.destKind === 'star'
        ? this.starLocalPosition(state.destIdx)
        : this.cloudLocalPosition(state.destIdx);
      if (B) this.camera.lookAt(B);
      return;
    }

    // Post-arrival phase: slerp the quaternion from the fly-end "looking at
    // destination" orientation back to the warp's captured starting
    // orientation, AND for observe→observe arrivals lerp position from pEnd
    // → B so the parallax view ends with the camera exactly at the
    // destination star (rather than offset by endOffset, which would leave
    // a hidden teleport for swapObserveAnchor to absorb at finishWarp).
    // The user sees the same celestial direction they had at warp start,
    // now from the new vantage — foreground stars shift due to parallax,
    // distant Milky Way stays roughly fixed.
    const postElapsed = flyElapsed - state.durationMs;
    if (postElapsed < state.postArrivalMs) {
      const B = state.destKind === 'star'
        ? this.starLocalPosition(state.destIdx)
        : this.cloudLocalPosition(state.destIdx);
      if (!state.flyEndQuaternion) {
        // Pin the camera to the canonical fly-end pose before snapshot
        // so the slerp doesn't inherit a half-stepped frame.
        this.camera.position.copy(state.pEnd);
        if (B) this.camera.lookAt(B);
        state.flyEndQuaternion = this.camera.quaternion.clone();
      }
      // Destination star stays visible across post-arrival so the user sees
      // it throughout the parallax slerp; swapObserveAnchor at finishWarp
      // hides it on landing. uHideFocusIdx still points at the source for
      // this whole window (set at warp start, by setCameraMode('observe')'s
      // entry-end hide or a prior swapObserveAnchor) — source is far away
      // by post-arrival so its hidden state is invisible.
      const u = postElapsed / state.postArrivalMs;
      const f = u * u * (3 - 2 * u);
      this.warpQ0.copy(state.flyEndQuaternion).slerp(state.startQuaternion, f);
      this.camera.quaternion.copy(this.warpQ0).normalize();
      if (state.returnToObserve && B) {
        this.camera.position.lerpVectors(state.pEnd, B, f);
      }
      return;
    }

    this.finishWarp();
  }

  private warpTmp = new THREE.Vector3();
  private warpQ0 = new THREE.Quaternion();
  private warpQ1 = new THREE.Quaternion();

  // Symmetric ease translate from `fromPos` to `toPos`, no quaternion change.
  // Camera look direction is preserved by holding the quaternion fixed; we
  // skip controls.update() during the run so the target doesn't tug it.
  private updateObserveTransition() {
    const state = this.observeTransition;
    if (!state) return;
    const t = Math.min(1, (performance.now() - state.startTimeMs) / state.durationMs);
    const f = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    this.camera.position.lerpVectors(state.fromPos, state.toPos, f);
    if (t >= 1) this.finishObserveTransition();
  }

  private finishObserveTransition() {
    const state = this.observeTransition;
    if (!state) return;
    this.observeTransition = null;
    if (state.kind === 'enter') {
      this.camera.position.copy(state.toPos);
      // Hide the focal star now that the camera is parked at it. Deferred
      // from setCameraMode so the user sees the star throughout the glide
      // — popping it out at transition start would read as "star vanishes,
      // then camera moves into its location" rather than a continuous
      // arrival.
      if (this.focusedStar !== null) {
        this.material.uniforms.uHideFocusIdx.value = this.focusedStar;
      }
      this.observeControls.enable();
    } else {
      this.camera.position.copy(state.toPos);
      // Target = the camera's pre-exit position (= the observed star's
      // location, in whichever frame is current). The exit translates
      // backward along the camera's forward direction by minDist, so
      // fromPos lies exactly along forward at that distance, which makes
      // TrackballControls.update()'s lookAt(target) a no-op for orientation
      // and gives the user a sensible orbit pivot (the star they just left)
      // for any subsequent drag.
      //
      // Origin frame at this point depends on the caller:
      //   - setCameraMode → startObserveExit (focus retained): origin still
      //     on the focused star, fromPos = (0,0,0) = the focused star.
      //   - unfocus (focus cleared via setFocus(null) before the lerp):
      //     origin recentered to Sol, fromPos = the star's Sol-centric
      //     absolute position.
      // Setting target = (0,0,0) here was correct only for the first case;
      // in the unfocus path it pointed at Sol and TrackballControls.update()'s
      // lookAt(target) would whip the camera around to face Sol.
      this.controls.target.copy(state.fromPos);
      // Align camera.up with the camera's current local +Y. Without this,
      // lookAt(target) inside controls.update() would re-resolve roll
      // against world (0,1,0) and snap any pitch the user accumulated in
      // observe back through the horizontal plane — visible as a jump
      // proportional to how much they looked around.
      this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.controls.update();
      this.controls.enabled = true;
      if (state.clearFocusOnExit) this.setFocus(null);
    }
    this.fireStateChange();
  }

  private observeTmpFwd = new THREE.Vector3();
  private observeUpdateTarget() {
    // 1 pc ahead of the camera in its current look direction. Choice of 1 pc
    // is arbitrary — controls.target is serialised but never used as an
    // orbit pivot while OBSERVE is active. Any non-zero distance yields a
    // valid forward direction on round-trip.
    this.observeTmpFwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.controls.target.copy(this.camera.position).add(this.observeTmpFwd);
  }

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
    // Star pipeline: one shared InstancedBufferGeometry feeds the disc, glow,
    // and core-mask passes, so it's disposed once. Each pass has its own
    // ShaderMaterial.
    this.geometry.dispose();
    this.material.dispose();
    this.glowMaterial.dispose();
    this.coreMaskMaterial.dispose();
    if (this.particleMesh) {
      this.particleMesh.geometry.dispose();
      this.particleMaterial?.dispose();
    }
    this.clouds?.dispose();
    this.galacticDisc.dispose();
    this.galacticGrid.dispose();
    this.milkyway.dispose();
    this.renderer.dispose();
  }
}

export { ALL_SPECT_MASK };
