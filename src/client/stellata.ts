import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { Catalog } from './loaders/catalog-loader';
import type { DustField, DustParticleData } from './loaders/dust-loader';
import vertexShader from './shaders/star.vert.glsl?raw';
import fragmentShader from './shaders/star.frag.glsl?raw';
import perceptualDiscChunk from './shaders/perceptual-disc.glsl?raw';
import { LUT_BYTES, LUT_SIZE } from './shaders/blackbody-lut';
import {
  DustParticleLayer,
  type DustParticleSharedUniforms,
} from './dust/dust-particle-layer';

// Register the perceptual-disc chunk so star.{vert,frag} (and any
// future point-source layer) can `#include <stellata_perceptual_disc>`
// via three.js's standard ShaderChunk preprocessor. Side-effect at
// module load — runs once before any material compiles.
(THREE.ShaderChunk as Record<string, string>)['stellata_perceptual_disc'] =
  perceptualDiscChunk;
import { GalacticDisc } from './galactic/galactic-disc';
import { LocalGroupLayer } from './local-group/local-group';
import type { LgCatalog } from './local-group/local-group-loader';
import { MAX_DISTANCE_PC, CAMERA_FAR_PC } from '../../scripts/build-local-group-pure';
import { GalacticGrid } from './galactic/galactic-grid';
import { HudOverlay } from './overlays/hud-overlay';
import { GALACTIC_CENTRE_PC } from './galactic/galactic-coords';
import { MolecularClouds, renderedCloudSizePx } from './molecular-clouds/molecular-clouds';
import type { CloudCatalog } from './molecular-clouds/cloud-loader';
import { MilkyWay } from './milkyway/milkyway';
import { ObserveControls } from './camera/observe-controls';
import { mark as perfMark, measure as perfMeasure, frame as perfFrame } from './debug/perf-hud';
import {
  angularToPx as angularToPxPure,
  sortedDistRange,
} from './camera/star-geometry';
import * as starPhysics from './camera/star-physics';
import {
  ZOOM_FLOOR_FRACTION,
  VAR_TROUGH_FLOOR_FRACTION,
} from './camera/star-physics';
import { Picker } from './camera/picker';
import { AimController } from './camera/aim-controller';
import {
  WarpController,
  type WarpInfo,
  type WarpPhaseInfo,
} from './camera/warp-controller';
import { ObserveTransition } from './camera/observe-transition';
import {
  FocusController,
  type FrameAnchor,
  GLOBAL_MIN_DIST_PC,
} from './camera/focus-controller';
import { getPlanetSystem, hasPlanets, type PlanetSystem } from './solar-system/planet-system';
import { OrbitRingsLayer } from './solar-system/orbit-rings-layer';
import { PlanetBodyField } from './solar-system/planet-body-field';
import { Heliopause } from './solar-system/heliopause';
import { R_SUN_PC } from './solar-system/astronomy-constants';
// Locally used subset; other warp-timing constants re-exported below
// for external import paths still pointing at './stellata'.
import { DCAM_LOG_FLOOR_PC } from './camera/timing';
export {
  AIM_T_MAX_MS,
  AIM_T_MIN_MS,
  CAMERA_LERP_MS,
  FOCUS_LERP_MS,
  OBSERVE_TRANSITION_MS,
  WARP_REORIENT_MS,
  WARP_T_K_MS,
  WARP_T_MAX_MS,
  WARP_T_MIN_MS,
} from './camera/timing';
import { EventBus } from './util/event-bus';
import { StarPipeline } from './star-pipeline';

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
  // Milky Way analytic background. Default-on; chart mode switches to
  // outline-only rendering on this same toggle. May be force-flipped
  // off by the FPS probe on the first few frames if the device can't
  // sustain ≥30 fps with it on.
  showMilkyway: boolean;
  // Star chart mode. Only meaningful while cameraMode==='observe';
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

// Star size physics — see SCIENCE.md § Stellar perception model.
// STAR_PHYSICS_FACTOR = 2·ln(10)/2.5. Per-preset starExaggerationK
// is tunable via Stellata.setStarExaggerationK (debug panel).
const STAR_PSF_ARCSEC = 30;
const STAR_PHYSICS_FACTOR = 1.84;
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
  // Soft-knee saturation extent (magnitudes) for the Gaussian-PSF disc
  // size formula. See uSizeKnee comment in star.vert.glsl. 0 = hard cap
  // (legacy behaviour); larger values let bright stars keep growing
  // before saturating. 16 lands ~43% size advantage for Sol over Sirius
  // when standing at the unfocused floor inside the solar system.
  sizeKnee: number;
}
export const STAR_RENDER_DEFAULTS: StarRenderParams = {
  visibleThreshold: 0.2,
  coreThreshold: 0.4,
  discardThreshold: 0.02,
  distNMin: 2.2,
  distNMax: 10.0,
  lumBiasMin: 1.0,
  lumBiasMax: 0.6,
  sizeKnee: 16,
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

// Default vertical FOV (degrees). User-tunable via the FOV slider; the
// reset button snaps back to this value.
export const DEFAULT_FOV = 50;

function makeColorLutTexture(): THREE.DataTexture {
  const rgba = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    rgba[i * 4 + 0] = LUT_BYTES[i * 3 + 0];
    rgba[i * 4 + 1] = LUT_BYTES[i * 3 + 1];
    rgba[i * 4 + 2] = LUT_BYTES[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(rgba, LUT_SIZE, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export type CameraMode = 'navigate' | 'observe';

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
  showMilkyway: true,
  chart: false,
};

// Event-bus payload map. Subscribers register via `Stellata.on(name, fn)`
// and the compiler enforces the payload type per event. `state` and
// `frame` are no-payload events.
export type StellataEventMap = {
  focus: number | null;
  cloudFocus: number | null;
  planetSystem: PlanetSystem | null;
  filter: Readonly<FilterState>;
  vector: number | null;
  vectorCloud: number | null;
  cameraMode: CameraMode;
  warp: boolean;
  focusLerp: boolean;
  pois: readonly number[];
  state: void;
  frame: void;
};

export class Stellata implements FrameAnchor {
  readonly catalog: Catalog;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: TrackballControls;

  private scene: THREE.Scene;
  // Star render pipeline — one InstancedBufferGeometry feeds three
  // ShaderMaterials (core depth-mask / disc / glow). Owns the dispose
  // contract for the densest resource cluster in the app. Per-frame
  // uniform writes still go through `starPipeline.discMaterial.uniforms`
  // from this file; the encapsulation is resource ownership only.
  private starPipeline!: StarPipeline;
  // Dust-particle render layer. Shelved for v1.0 — see
  // docs/rendering.md § "Dust extinction + the shelved particle layer".
  private dustParticles!: DustParticleLayer;

  // Floating origin to dodge float32 cancellation when zoomed close to
  // distant stars. worldOffset is the absolute coord that sits at
  // local (0,0,0); _localPositions = catalog.positions − worldOffset
  // bound to the iPosition attribute. Overlays project via the
  // `localPositions` getter so every path stays in the camera's frame.
  private worldOffset = new THREE.Vector3();
  private _localPositions: Float32Array;

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
  private bus = new EventBus<StellataEventMap>();

  private cameraMode: CameraMode = 'navigate';
  // Stellata owns the cameraMode field (read by ~20 sites) and writes
  // it through the controller's setCameraModeValue dep callback.
  private observe!: ObserveTransition;
  private observeControls!: ObserveControls;

  // null = "live" (Date.now() each call); a number = "pinned" by the
  // time-scrubber. v1 never pins.
  private pinnedT: number | null = null;

  private focus!: FocusController;
  // Distance-vector destination — at most one of these is non-null at
  // a time. Mutual exclusion enforced by setVectorTo / setVectorToCloud.
  private vectorTo: number | null = null;
  private vectorToCloud: number | null = null;
  private monochrome = false;
  private warp!: WarpController;
  private aim!: AimController;

  // OBSERVE-mode "points of interest". Single-click on a star pins it.
  // Cleared on every observe → navigate transition (registered in the
  // constructor). Hard-capped at POI_HARD_CAP — adding past the cap is
  // a no-op so the cap also bounds the URL blob (poi serialisation in
  // url-state.ts is HIP-only). Insertion-ordered (Array, not Set) so
  // round-trips through URL state preserve the user's pin order.
  private pois: number[] = [];
  // Pending single-click in OBSERVE mode. Held for OBSERVE_DBL_CLICK_MS
  // so we can disambiguate single (pin a star) from double (slerp the
  // camera to the clicked direction). Navigate-mode clicks do not enter
  // this state — they dispatch immediately.
  private observePendingClick: { x: number; y: number; timer: number } | null = null;
  private static OBSERVE_DBL_CLICK_MS = 280;
  private static OBSERVE_DBL_CLICK_DIST_PX_SQ = 8 * 8;
  private static POI_HARD_CAP = 16;

  // Galactic reference layers. Disc fades in by camera-distance
  // from Sol and is always-on. Grid is gated by `filter.showGalacticGrid`.
  // The HUD (Sol/GC arrows + OBSERVE-mode ring) is gated by
  // `filter.showHud`. Mono mode swaps strokes to a paper-chart palette via
  // setMonochrome on each layer (HUD is CSS-only).
  private galacticDisc: GalacticDisc;
  // Representational layer — only renders when the host is focused.
  private orbitRingsLayer: OrbitRingsLayer;
  // Physical layer — renders for every attached host regardless of
  // focus, gated by per-planet apparent magnitude + per-host distance cull.
  private planetBodyField: PlanetBodyField;
  // Sol-anchored asymmetric ellipsoid; visible only when Sol is the
  // focused host.
  private heliopause: Heliopause;
  private galacticGrid: GalacticGrid;
  private hudOverlay: HudOverlay;

  // null until attachLocalGroup() runs; absent layer is a no-op
  // everywhere. Shares the MW disc's FADE_INNER_PC / FADE_OUTER_PC
  // reveal curve.
  private localGroupLayer: LocalGroupLayer | null = null;

  // Molecular cloud overlay. null until attachClouds() runs;
  // the layer loads asynchronously after the catalog and search index so
  // first paint isn't gated on it.
  private clouds: MolecularClouds | null = null;

  // Milky Way analytic background. Constructed eagerly so the
  // band is on during first paint. Dust is wired in once the volumetric
  // texture attaches. The composite mesh lives in `this.scene` at
  // renderOrder = -2 so it draws behind everything; the analytic raymarch
  // pass renders into a private half-res RT each frame.
  private milkyway: MilkyWay;

  // Reference to the most recently attached DustField — kept solely so
  // dispose() can release the ~128 MiB Data3DTexture. attachDust(null)
  // clears it.
  private dust: DustField | null = null;

  // Pure target resolver; the click FSM in onPointerUp + the observe
  // single/double-click dispatchers stay here as composition-layer
  // orchestration.
  readonly picker!: Picker;

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
    // disappears at the closest zoom. Far plane (`CAMERA_FAR_PC`) is
    // paired with `MAX_DISTANCE_PC` so the build filter and camera can
    // never drift; see build-local-group-pure.ts for the definition.
    this.camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV,
      window.innerWidth / window.innerHeight,
      1e-10,
      CAMERA_FAR_PC,
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
    this.controls.maxDistance = MAX_DISTANCE_PC;
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
    // Shared uniforms — all three star passes point at the same value
    // objects, so any setFilter / theme / resize update propagates to
    // every pass without duplicate bookkeeping. uRenderMode is the only
    // divergent uniform; StarPipeline binds it per material.
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
      // Chart-mode disc sizing. Pixel range + bright-end
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
      // Variability headroom drivers (mirrored to GLSL); single source of
      // truth in the TS-side constants so the shader and the
      // renderedSizePx mirror compute the same effective amplitude.
      uMaxPhysFrac: { value: ZOOM_FLOOR_FRACTION },
      uVarTroughFrac: { value: VAR_TROUGH_FLOOR_FRACTION },
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
      uSizeKnee: { value: STAR_RENDER_DEFAULTS.sizeKnee },

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
      // Blackbody → sRGB lookup, 256×1 RGBA. Bytes are precomputed at build
      // time (Ballesteros 2012 B-V→Teff + Planck × CIE 1931 → sRGB) and
      // baked into src/client/shaders/blackbody-lut.ts; see SCIENCE.md
      // § "Star colour calibration". RGBA padding because three.js dropped
      // RGBFormat — the .a byte is unused.
      uColorLut: { value: makeColorLutTexture() },
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

    this.starPipeline = new StarPipeline({
      scene: this.scene,
      catalog,
      logRadii,
      lumClassF32,
      distSol,
      localPositions: this._localPositions,
      vertexShader,
      fragmentShader,
      sharedUniforms,
      boundingSphereRadiusPc: 60_000,
    });

    // Star-material uniforms passed by reference so floating-origin
    // recenters, resize updates, and dust loads propagate to the
    // particle pass automatically.
    this.dustParticles = new DustParticleLayer(
      this.scene,
      this.starPipeline.discMaterial.uniforms as unknown as DustParticleSharedUniforms,
    );

    // Galactic reference layers — disc is always added; grid hides itself
    // until enabled. The HUD (ring + Sol/GC arrows) is pure SVG inside the
    // existing #overlay so it shares the distance vector's stroke + halo
    // styling and inherits the `body.warping` hide rule for free.
    this.galacticDisc = new GalacticDisc();
    this.scene.add(this.galacticDisc.group);
    this.orbitRingsLayer = new OrbitRingsLayer();
    this.scene.add(this.orbitRingsLayer.group);
    this.planetBodyField = new PlanetBodyField(sharedUniforms);
    this.scene.add(this.planetBodyField.group);
    // Heliopause is Sol-anchored — added once, visibility gated on
    // focused star = Sol via the planet-system event below.
    this.heliopause = new Heliopause();
    this.scene.add(this.heliopause.group);

    // Picker resolves every layer's "what's under (x, y)?" — composed
    // by the click FSM in onPointerUp and by the hover providers.
    // Layers that attach asynchronously (clouds, Local Group) are
    // read through getters so Picker sees them as soon as they land.
    // `picker` is `readonly` — assigned via writable cast since field
    // initialisation in TS requires bypassing the readonly guard here.
    (this as { picker: Picker }).picker = new Picker({
      domElement: this.renderer.domElement,
      camera: this.camera,
      catalog: this.catalog,
      sortedByDistFromSol: this.sortedByDistFromSol,
      sortedDistFromSol: this.sortedDistFromSol,
      getLocalPositions: () => this._localPositions,
      getFilter: () => this.filter,
      getClouds: () => this.clouds,
      getLocalGroupLayer: () => this.localGroupLayer,
      getHeliopause: () => this.heliopause,
      getPlanetBodyField: () => this.planetBodyField,
      getWorldOffset: () => this.worldOffset,
      getWarpActive: () => this.warp.isActive(),
      renderedSizePxFn: (idx) => starPhysics.renderedSizePx({
        catalog: this.catalog,
        idx,
        camPos: this.camera.position,
        localPositions: this._localPositions,
        uniforms: this.starPipeline.discMaterial.uniforms as unknown as starPhysics.StarPhysicsUniforms,
        filter: this.filter,
      }),
      fovYRadRef: this.starPipeline.discMaterial.uniforms.uFovYRad as { value: number },
      viewportRef: this.starPipeline.discMaterial.uniforms.uViewport as { value: THREE.Vector2 },
    });
    // The warp / focus-lerp / observe-transition busy checks stay on
    // stellata's aimAt dispatcher because they gate behaviour the
    // controller doesn't know about.
    this.aim = new AimController({
      camera: this.camera,
      controls: this.controls,
      observeControls: this.observeControls,
      getCameraMode: () => this.cameraMode,
    });
    // FocusController implements the FocusOps / ObserveFocusOps
    // surfaces consumed by WarpController + ObserveTransition.
    // getWarp / getObserve are lazy because those controllers depend
    // back on FocusController — the construct cycle is broken by
    // deferred resolution at first request.
    this.focus = new FocusController({
      camera: this.camera,
      controls: this.controls,
      observeControls: this.observeControls,
      catalog: this.catalog,
      bus: this.bus,
      frameAnchor: this,
      aim: this.aim,
      uHideFocusIdxRef: this.starPipeline.discMaterial.uniforms.uHideFocusIdx as { value: number },
      getCameraMode: () => this.cameraMode,
      setCameraModeValue: (mode) => { this.cameraMode = mode; },
      getClouds: () => this.clouds,
      setVectorTo: (idx) => this.setVectorTo(idx),
      setVectorToCloud: (idx) => this.setVectorToCloud(idx),
      getWarp: () => this.warp,
      getObserve: () => this.observe,
    });
    this.warp = new WarpController({
      camera: this.camera,
      controls: this.controls,
      observeControls: this.observeControls,
      uHideFocusIdxRef: this.starPipeline.discMaterial.uniforms.uHideFocusIdx as { value: number },
      bus: this.bus,
      getCameraMode: () => this.cameraMode,
      isChartMode: () => this.filter.chart,
      getChartMagBright: () =>
        this.starPipeline.discMaterial.uniforms.uChartMagBright.value as number,
      focus: this.focus,
    });
    this.observe = new ObserveTransition({
      camera: this.camera,
      controls: this.controls,
      observeControls: this.observeControls,
      aim: this.aim,
      uHideFocusIdxRef: this.starPipeline.discMaterial.uniforms.uHideFocusIdx as { value: number },
      bus: this.bus,
      focus: this.focus,
      getCameraMode: () => this.cameraMode,
      setCameraModeValue: (mode) => { this.cameraMode = mode; },
    });
    // Orbit rings + heliopause are representational layers gated on
    // host-focus. Planet bodies live in PlanetBodyField and render
    // whenever inside the per-host cull distance regardless of focus.
    this.on('planetSystem', (ps) => {
      this.orbitRingsLayer.setPlanetSystem(ps, this.catalog.solIndex);
      this.heliopause.setVisible(ps !== null && ps.hostStarIdx === this.catalog.solIndex);
    });
    // Attach Sol's planet system to the global body field once at
    // startup. Bodies render from now on independent of focus, gated
    // only by apparent-mag visibility + the per-host distance cull.
    if (catalog.solIndex >= 0 && hasPlanets(catalog, catalog.solIndex)) {
      const solIdx = catalog.solIndex;
      const solAbs = new THREE.Vector3(
        catalog.positions[solIdx * 3],
        catalog.positions[solIdx * 3 + 1],
        catalog.positions[solIdx * 3 + 2],
      );
      void getPlanetSystem(catalog, solIdx).then((ps) => {
        if (ps !== null) {
          this.planetBodyField.attachHost(
            solIdx, ps, catalog.absmag[solIdx], solAbs, solIdx, this.getT(),
          );
        }
      });
    }
    this.galacticGrid = new GalacticGrid();
    this.scene.add(this.galacticGrid.group);
    const hudRing = document.getElementById('hud-ring') as unknown as SVGCircleElement;
    const solPath = document.getElementById('sol-arrow') as unknown as SVGPathElement;
    const solBg = document.getElementById('sol-arrow-bg') as unknown as SVGPathElement;
    const gcPath = document.getElementById('gc-arrow') as unknown as SVGPathElement;
    const gcBg = document.getElementById('gc-arrow-bg') as unknown as SVGPathElement;
    const solLabel = document.getElementById('sol-arrow-label') as unknown as SVGTextElement;
    const gcLabel = document.getElementById('gc-arrow-label') as unknown as SVGTextElement;
    // Clicking either label aims the camera at the named object. Sol's
    // local-frame position is just `-worldOffset` (Sol is the catalog
    // origin); GC sits at GALACTIC_CENTRE_PC in absolute space. Handlers are
    // owned by HudOverlay so its dispose() can detach them.
    this.hudOverlay = new HudOverlay(
      hudRing, solPath, solBg, gcPath, gcBg, solLabel, gcLabel,
      () => this.aimAt(this.tmpVec3b.copy(this.worldOffset).negate()),
      () => this.aimAt(this.tmpVec3b.copy(GALACTIC_CENTRE_PC).sub(this.worldOffset)),
    );

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
    if (catalog.solIndex >= 0) {
      this.focus.setFocus(catalog.solIndex);
    }
    // No camera-position park here. The bare-URL pose is fully owned by
    // first-load.ts (`applyFirstLoadView`) and `?v=` URLs apply their
    // own cam — both run before first paint in main.ts.

    // Compute initial pixel sizes for the active preset against the real
    // viewport. DEFAULT_FILTER carries placeholder pixel values; this call
    // replaces them with the right numbers before the first frame.
    this.recomputePresetPxSizes();

    // Clear pinned POIs on any exit out of observe. Subscribed here
    // rather than wired into each cameraMode-flip site because all three
    // exit paths (mode toggle, focus change, search-X clear) emit the
    // 'cameraMode' event; one listener catches them all and fires
    // before the URL writer's debounced flush.
    this.on('cameraMode', (mode) => {
      if (mode !== 'observe') this.clearPois();
    });

    this.attachEvents();
    this.animate();
  }

  /** Subscribe to any event in `StellataEventMap`. Returns an unsubscribe
   *  function. Payload type is inferred from the event name; payload-less
   *  events (`'state'`, `'frame'`) are called without a payload arg. */
  on<K extends keyof StellataEventMap>(
    name: K,
    handler: (payload: StellataEventMap[K]) => void,
  ): () => void {
    return this.bus.on(name, handler);
  }
  getFocusedStar(): number | null { return this.focus.getFocusedStar(); }
  getFocusedCloud(): number | null { return this.focus.getFocusedCloud(); }
  /** Planet system for the currently focused star, or null if the focus
   *  has none (or has not finished loading). The solar-system rendering
   *  layer gates on this — renderers also subscribe to
   *  the 'planetSystem' event to react to focus swaps. */
  getFocusedPlanetSystem(): PlanetSystem | null { return this.focus.getFocusedPlanetSystem(); }
  /** True when the orbit-rings layer is currently rendering at least one
   *  ring. Frame-coherent — `updateGalacticLayers()` runs before
   *  `'frame'` event handlers, so overlays driven by the frame loop
   *  (focus ring, etc.) read current-frame data. */
  anyOrbitRingVisible(): boolean { return this.orbitRingsLayer.anyOrbitRingVisible(); }
  /** Local-frame positions of the focused host's planets (xyz triples,
   *  length 3·N), or null if no system is attached. Reads from the
   *  global PlanetBodyField — overlays must not mutate. Used by
   *  planet-labels to project bodies to screen space. */
  getFocusedPlanetLocalPositions(): Float32Array | null {
    const ps = this.focus.getFocusedPlanetSystem();
    if (!ps) return null;
    return this.planetBodyField.getHostLocalPositions(ps.hostStarIdx);
  }
  /** True when the orbit ring for planet `i` is currently rendering on
   *  the focused host. Used by planet-labels to hide labels in lockstep
   *  with their associated rings — the body stays rendered (subject to
   *  apparent-mag visibility) regardless. */
  isOrbitRingVisible(planetIdx: number): boolean {
    return this.orbitRingsLayer.isOrbitRingVisible(planetIdx);
  }
  /** Absolute-space coordinate of the renderer's current local origin.
   *  Read-only snapshot; callers must not mutate. URL serialisation
   *  emits this so close-orbit unfocus poses (where worldOffset sits at
   *  the former focal star, not Sol — see the close-orbit unfocus contract) round-trip
   *  exactly through the float32 cam/tgt fields. */
  getWorldOffset(): Readonly<THREE.Vector3> { return this.worldOffset; }
  /** Shift the floating origin to a new absolute position. Star instance
   *  positions, camera, and controls.target are translated to preserve
   *  the user-visible pose; subsequent rendering operates in the new
   *  local frame. URL loading uses this to restore a saved worldOffset
   *  before applying cam/tgt (which then overwrite the camera/target
   *  translations the recentre produced). */
  setWorldOffset(absX: number, absY: number, absZ: number): void {
    this.recenterOrigin(this.tmpRecenter.set(absX, absY, absZ));
  }
  getVectorTo(): number | null { return this.vectorTo; }
  getVectorToCloud(): number | null { return this.vectorToCloud; }

  /** Wall-clock `t` (Unix-seconds) driving the solar-system layer.
   *  Returns the pinned value if the time-scrubber epic has set one,
   *  otherwise live `Date.now() / 1000`. Recomputed on every call —
   *  callers that need a frame-stable value should snapshot at the
   *  start of the frame. */
  getT(): number {
    return this.pinnedT ?? Date.now() / 1000;
  }
  /** Pin `t` to a specific Unix-seconds value, or pass `null` to
   *  return to live tracking. Wired for the time-scrubber epic
   * ; v1 never calls this from the UI. */
  setT(t: number | null): void {
    this.pinnedT = t;
    this.bus.emit('state');
  }
  getMonochrome(): boolean { return this.monochrome; }
  getWarpActive(): boolean { return this.warp.isActive(); }

  /** Jump to the end state of an in-flight warp. Equivalent to letting
   *  the animation run to completion. No-op when idle. Thin shim over
   *  WarpController. */
  skipWarp(): void { this.warp.skip(); }

  /** Read-only snapshot of in-flight warp state for the debug-panel
   *  warp tuning readout. Thin shim over WarpController.getWarpPhase. */
  getWarpPhase(): WarpPhaseInfo | null { return this.warp.getWarpPhase(); }

  /** Warp endpoints + destination identity for read-only consumers (e.g.
   *  the scale-bar focus indicator). B is a shared scratch slot owned by
   *  WarpController. Callers must NOT mutate either, and must not retain
   *  B across frames. Thin shim over WarpController.getWarpInfo. */
  getWarpInfo(): WarpInfo | null { return this.warp.getWarpInfo(); }

  getCameraMode(): CameraMode { return this.cameraMode; }
  // True when an observe-mode transition (enter or exit) is in flight.
  // The 'unfocus' kind is excluded — it reuses the controller's state slot
  // for a navigate-mode lerp and shouldn't surface to UI/overlay code
  // gating on observe-mode visibility.
  isObserveTransitionActive(): boolean { return this.observe.isActive(); }

  // True whenever a camera-position lerp is in flight — warp, observe
  // enter/exit, OR the navigate-mode unfocus zoom-out. URL-state writes
  // gate on this to avoid serialising transient mid-lerp poses; the end
  // of each animation schedules a final write with the settled pose.
  isCameraTransitionActive(): boolean {
    return this.warp.isActive() || this.observe.isAnyActive();
  }

  /** True while *any* camera-driving animation is in flight: warp,
   *  aim-slerp, focus-park lerp, OR an observe transition (enter / exit /
   *  navigate-close-zoom unfocus). Sites that need a uniform "the camera
   *  is currently animating" gate should call this. Several call sites in
   *  this file deliberately use a narrower predicate — those are
   *  intentional: focus-change can interrupt aim but not warp, cosmetic
   *  cloud picking is suppressed during warp only, etc. */
  isCameraBusy(): boolean { return this.focus.isCameraBusy(); }

  // Cancellation hooks for the focus-park lerp (r9q.2) and the
 // navigate-mode unfocus lerp — both must clear before a new
  // camera-changing action (focus, warp, aim, click) proceeds. Forward
  // to FocusController which owns the focus-park slot and delegates the
  // unfocus path to ObserveTransition.
  cancelFocusLerp() { this.focus.cancelFocusLerp(); }
  cancelUnfocusLerp() { this.focus.cancelUnfocusLerp(); }

  /** Threshold squared-length below which `controls.target` engages the
   *  focused-star pin. Surfaced for the pin debug HUD so the displayed
   *  rule matches the runtime constant exactly. */
  getPinEngageThresholdSq(): number { return this.focus.getPinEngageThresholdSq(); }

  /** Whether the focused-star pin (uPinFocusToCenter) would engage right
   *  now, mirroring the per-frame guard in animate(). Read by the pin
   *  section of the unified debug panel (`debug.panel()`) to display
   *  live state. See FocusController.isPinEngaged for the gating rules. */
  isPinEngaged(): boolean { return this.focus.isPinEngaged(); }

  /** True while an aim animation is in flight. Mirror of getWarpActive
   *  for the camera's other interpolated transition. */
  isAimActive(): boolean { return this.aim.isActive(); }

  // Eased progress of the in-flight observe-mode camera translate, or
  // null if no transition is active. Forwards to the controller; see
  // ObserveTransition.getProgress.
  getObserveTransitionProgress(): { f: number; kind: 'enter' | 'exit' } | null {
    return this.observe.getProgress();
  }

  // ──────────────────── OBSERVE-mode points of interest ────────────────────
  //
  // Single-click on a star in OBSERVE pins it; click again to unpin. The
  // POI overlay (poi-overlay.ts) renders an on-screen label following the
  // star, and a HUD-ring arrow when it goes off-screen. Cleared automatically
  // on any observe→navigate transition.

  getPois(): readonly number[] { return this.pois; }

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
      this.bus.emit('pois', this.pois);
      this.bus.emit('state');
      return;
    }
    if (this.pois.length >= Stellata.POI_HARD_CAP) {
      console.info(`[POI] cap reached (${Stellata.POI_HARD_CAP}); unpin one first.`);
      return;
    }
    this.pois.push(idx);
    this.bus.emit('pois', this.pois);
    this.bus.emit('state');
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
    this.bus.emit('pois', this.pois);
    this.bus.emit('state');
  }

  clearPois() {
    if (this.pois.length === 0) return;
    this.pois = [];
    this.bus.emit('pois', this.pois);
    this.bus.emit('state');
  }

  // Mode-switch entry point. Forwards to the ObserveTransition
  // controller; see camera/observe-transition.ts for the full FSM
  // (re-entry / focus-gate / animate=false guards + bus emit shape).
  // Public so the mode-pill click handler, keyboard 'O' shortcut, and
  // url-state restore can drive mode changes through a single surface.
  setCameraMode(mode: CameraMode, opts: { animate?: boolean } = {}) {
    this.observe.setMode(mode, opts);
  }

  // setFocus / setFocusedCloud / recenterFocusToStar / refreshPlanetSystem
 // moved to FocusController. The thin shims below preserve
  // the public surface for callers outside the camera/ folder (URL state,
  // search, the click FSM in onPointerUp) without re-introducing the
  // routing logic here.
  setFocus(idx: number | null) { this.focus.setFocus(idx); }
  setFocusedCloud(idx: number | null) { this.focus.setFocusedCloud(idx); }

  private tmpRecenter = new THREE.Vector3();
  // Scratch Vector3 reused for `recenterOrigin`'s return value (the
  // applied delta). Caller-visible only between successive
  // `recenterOrigin` calls; never read outside the synchronous
  // callsite. Avoids a per-recentre allocation on the warp arrival
  // path.
  private _recenterDelta = new THREE.Vector3();

  // Shift the renderer's local origin to `newOrigin` (an absolute-space
  // coordinate). The instance-position buffer is rewritten as `absolute −
  // newOrigin` in JS Number precision (= float64) before being truncated to
  // float32 — the per-axis subtractions happen in high precision first, so
  // the resulting local coordinates near the new origin retain full float32
  // resolution (~10⁻³⁸ near zero). Camera position and orbit target are
  // shifted by the same delta so the user sees no visible jump; only
  // numerical precision improves.
  //
  // Triggered automatically from FocusController.setFocus() and
  // WarpController.tryMidFlyRecentre. Don't call externally — it
  // bypasses the state-change bookkeeping that setFocus threads through.
  //
  // Returns the (dx, dy, dz) world-offset delta applied (newOrigin −
  // previous worldOffset) so callers can migrate auxiliary state
  // captured in the old frame (e.g. updateWarp's pEnd / pStart / A)
  // into the new frame without re-deriving the delta themselves.
  // Returns null on the no-op path (newOrigin equals worldOffset).
  // The returned Vector3 is shared scratch — copy if you need to
  // outlive the next recenterOrigin call.
  //
  // Public for the `FrameAnchor` seam — FocusController.recenterFocusToStar
  // and WarpController.tryMidFlyRecentre invoke it. The "don't call
  // externally" rule still applies to non-warp/non-focus callers; the
  // recentre is a state-mutation primitive, not a routine API.
  recenterOrigin(newOrigin: THREE.Vector3): THREE.Vector3 | null {
    const dx = newOrigin.x - this.worldOffset.x;
    const dy = newOrigin.y - this.worldOffset.y;
    const dz = newOrigin.z - this.worldOffset.z;
    if (dx === 0 && dy === 0 && dz === 0) return null;

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
    this.starPipeline.iPositionAttr.needsUpdate = true;

    this.camera.position.x -= dx;
    this.camera.position.y -= dy;
    this.camera.position.z -= dz;
    this.controls.target.x -= dx;
    this.controls.target.y -= dy;
    this.controls.target.z -= dz;

    this.worldOffset.copy(newOrigin);
    // Shader needs the world offset to reconstruct absolute positions for
    // dust-texture sampling (local-frame iPosition + uWorldOffset).
    (this.starPipeline.discMaterial.uniforms.uWorldOffset.value as THREE.Vector3).copy(newOrigin);
    // Each attached host's iHostLocalPos = hostAbs - worldOffset; refresh
    // them so the planet shader sees correct local-frame host positions.
    this.planetBodyField.recenter(newOrigin);
    return this._recenterDelta.set(dx, dy, dz);
  }

 // recenterFocusToStar moved to FocusController — it
  // mutates focus state (focusedStar + per-star minDistance +
  // planet-system reload), which now lives there.

  // Wire a loaded DustField into the star shader. Safe to call after the
  // Stellata is already rendering — uniforms flip atomically on the next
  // frame. Safe to call multiple times; the most recent dust wins. Pass
  // null to detach (e.g. to disable extinction for a mode toggle).
  attachDust(dust: DustField | null) {
    const u = this.starPipeline.discMaterial.uniforms;
    // Re-attach with a different DustField? Release the previous one's
    // ~128 MiB Data3DTexture before swapping the reference, otherwise
    // the old texture would leak. attachDust is called exactly once
    // today, so this guard is defensive — but the contract reads as
    // "the most recent dust wins" and that contract should hold without
    // tying it to caller discipline.
    if (this.dust !== null && this.dust !== dust) this.dust.dispose();
    this.dust = dust;
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
    this.starPipeline.discMaterial.uniforms.uExtinctionStrength.value = Math.max(0, x);
    this.milkyway.setExtinctionStrength(x);
  }

  /** Direct access to the Milky Way layer for dev-console tuning
   *  (e.g. `stellata.milkywayLayer.setBrightness(0.4)`). */
  get milkywayLayer(): MilkyWay { return this.milkyway; }

  /** Wire the loaded molecular cloud catalog into the scene. Idempotent —
   *  calling again replaces the layer. Pass null to detach. */
  /** Attach (or replace, or detach with null) the Local Group wireframe
   *  layer. Mirrors attachClouds — load is async in main.ts, the layer
   *  appears once the JSON arrives. Empty catalog detaches. */
  attachLocalGroup(catalog: LgCatalog | null) {
    if (this.localGroupLayer) {
      this.scene.remove(this.localGroupLayer.group);
      this.localGroupLayer.dispose();
      this.localGroupLayer = null;
    }
    if (catalog === null || catalog.objects.length === 0) return;
    this.localGroupLayer = new LocalGroupLayer(catalog);
    this.localGroupLayer.setMonochrome(this.monochrome);
    this.scene.add(this.localGroupLayer.group);
  }

  /** Direct access to the Local Group layer for dev-console / label
   *  wiring in main.ts. null until attachLocalGroup runs. */
  get localGroup(): LocalGroupLayer | null { return this.localGroupLayer; }

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

  /** Cloud-side analogue of focusStar — see FocusController.flyToCloud. */
  flyToCloud(idx: number, opts: { animate?: boolean } = {}) {
    this.focus.flyToCloud(idx, opts);
  }

  private tmpVec3b = new THREE.Vector3();

  /** Build the dust-particle mesh from loaded data. See bd issue
   *  stellata-zq3 + docs/rendering.md § "Dust extinction + the shelved
   *  particle layer" for the open questions before re-enabling. */
  attachDustParticles(data: DustParticleData) {
    this.dustParticles.attach(data);
  }

  /** User-facing dust-particle visibility (`stellata.setParticleStrength`
   *  console knob). 0 = hidden (default); higher = stronger additive
   *  contribution. */
  setParticleStrength(x: number) {
    this.dustParticles.setStrength(x);
  }


  // Read-only view of the local-frame star positions, bound to the GPU
  // iPosition attribute. Overlays should project through this rather than
  // catalog.positions so their math runs in the same frame as the camera.
  get localPositions(): Float32Array { return this._localPositions; }

  // Read-only view of the star-shader uniforms, typed against the subsets
  // consumed by star-physics.ts. Overlays / chart / debug surfaces that
  // call the per-star geometry helpers thread these through; keeping the
  // accessor here means the integration shell is still the single point
  // that knows the renderer's material identity.
  get uniforms(): starPhysics.StarPhysicsUniforms & starPhysics.ChartDiscUniforms {
    return this.starPipeline.discMaterial.uniforms as unknown as
      starPhysics.StarPhysicsUniforms & starPhysics.ChartDiscUniforms;
  }

  setVectorTo(idx: number | null) {
    // OBSERVE doesn't draw vectors. Defensive: search "To" or URL state
    // could try to write one — drop the value rather than fight an invalid
    // overlay state.
    if (idx !== null && (this.cameraMode === 'observe' || this.isObserveTransitionActive())) return;
    // Mutually exclusive with vectorToCloud; setting a star vector clears
    // any cloud destination.
    if (idx !== null && this.vectorToCloud !== null) {
      this.vectorToCloud = null;
      this.bus.emit('vectorCloud', null);
    }
    if (this.vectorTo === idx) return;
    this.vectorTo = idx;
    this.bus.emit('vector', idx);
    this.bus.emit('state');
  }

  setVectorToCloud(idx: number | null) {
    if (idx !== null && (this.cameraMode === 'observe' || this.isObserveTransitionActive())) return;
    // Mutually exclusive with vectorTo; setting a cloud vector clears
    // any star destination.
    if (idx !== null && this.vectorTo !== null) {
      this.vectorTo = null;
      this.bus.emit('vector', null);
    }
    if (this.vectorToCloud === idx) return;
    this.vectorToCloud = idx;
    this.bus.emit('vectorCloud', idx);
    this.bus.emit('state');
  }

  /** Click-handler entry point for "clear whatever's focused". The
   *  vector-only short-circuit lives here (vector slots are still on
   *  Stellata); everything else delegates to FocusController.unfocus. */
  unfocus(opts: { animate?: boolean } = {}) {
    if (this.warp.isActive()) return;
    const hasFocus =
      this.focus.getFocusedStar() !== null
      || this.focus.getFocusedCloud() !== null;
    if (!hasFocus && this.vectorTo === null && this.vectorToCloud === null) return;
    // Vector-only: FocusController.unfocus is a no-op without a focused
    // star or cloud, so wipe the measurement vector here directly.
    if (!hasFocus) {
      this.setVectorTo(null);
      this.setVectorToCloud(null);
      return;
    }
    this.focus.unfocus(opts);
  }

  setFilter(patch: Partial<FilterState>) {
    Object.assign(this.filter, patch);
    const u = this.starPipeline.discMaterial.uniforms;
    u.uMaxAppMag.value = this.filter.maxAppMag;
    u.uMinDistSol.value = this.filter.minDistSol;
    u.uMaxDistSol.value = this.filter.maxDistSol;
    u.uSpectMask.value = this.filter.spectMask;
    u.uSizeMin.value = this.filter.sizeMin;
    u.uSizeMax.value = this.filter.sizeMax;
    u.uSizeSpan.value = this.filter.sizeSpan;
    // Per-host distance cull on the planet body field is closed-form
    // in maxAppMag — refresh the cached cullDistancePc whenever the
    // slider moves so distant hosts stay culled at the new threshold.
    this.planetBodyField.setMaxAppMag(this.filter.maxAppMag);
    this.milkyway.setEnabled(this.filter.showMilkyway);
    this.bus.emit('filter', this.filter);
    this.bus.emit('state');
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
    this.starPipeline.discMaterial.uniforms.uFovYRad.value = (fov * Math.PI) / 180;
    const focusedStar = this.focus.getFocusedStar();
    if (focusedStar !== null) {
      this.controls.minDistance = starPhysics.minOrbitDistForStar({
        catalog: this.catalog,
        idx: focusedStar,
        fovMinorRad: starPhysics.fovMinorRad(this.camera),
      });
    }
    this.recomputePresetPxSizes();
    this.bus.emit('filter', this.filter);
    this.bus.emit('state');
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
    this.bus.emit('filter', this.filter);
    this.bus.emit('state');
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
    const u = this.starPipeline.discMaterial.uniforms;
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
    if (patch.sizeKnee !== undefined) u.uSizeKnee.value = patch.sizeKnee;
  }
  getStarRenderParams(): StarRenderParams {
    const u = this.starPipeline.discMaterial.uniforms;
    return {
      visibleThreshold: u.uVisibleThreshold.value,
      coreThreshold: u.uCoreThreshold.value,
      discardThreshold: u.uDiscardThreshold.value,
      distNMin: u.uDistNMin.value,
      distNMax: u.uDistNMax.value,
      lumBiasMin: u.uLumBiasMin.value,
      lumBiasMax: u.uLumBiasMax.value,
      sizeKnee: u.uSizeKnee.value,
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
    this.starPipeline.discMaterial.uniforms.uMonochrome.value = on ? 1 : 0;
    this.starPipeline.setMonochromeBlend(on);
    this.renderer.setClearColor(on ? 0xf5f2ea : 0x000000, on ? 1 : 0);
    this.galacticDisc.setMonochrome(on);
    this.localGroupLayer?.setMonochrome(on);
    this.galacticGrid.setMonochrome(on);
    this.hudOverlay.setMonochrome(on);
    this.clouds?.setMonochrome(on);
    this.orbitRingsLayer.setMonochrome(on);
    this.planetBodyField.setMonochrome(on);
    this.heliopause.setMonochrome(on);
    // The milky-way layer used to fully hide in chart mode, but chart
    // mode re-purposes it to render an isobar contour. Visibility/contour
    // are now driven by the chart-mode orchestrator via
    // `setMilkywayIsobar` and `setCloudsIsobar` below — call them
    // alongside setMonochrome.
    this.bus.emit('state');
  }

  /** Chart-mode isobar pass on/off for the molecular cloud layer.
   *  Wires the shader's uMaxAppMag uniform to the stellata's shared
   *  reference so the contour tracks the magnitude slider live. */
  setCloudsIsobar(on: boolean) {
    this.clouds?.setIsobar(on, this.starPipeline.discMaterial.uniforms.uMaxAppMag);
  }

  /** Chart-mode isobar pass on/off for the milky-way layer. */
  setMilkywayIsobar(on: boolean) {
    this.milkyway.setIsobar(on);
  }

  /** Focus a star — thin shim over FocusController.focusStar. The
   *  click FSM in `onPointerUp`, the typeahead, and URL state restore
   *  all call through here. */
  focusStar(starIndex: number, opts: { animate?: boolean } = {}) {
    this.focus.focusStar(starIndex, opts);
  }

  setOrbitTarget(starIndex: number) { this.focus.setOrbitTarget(starIndex); }

  /** Cloud-side analogue of setOrbitTarget — orbit pivot moves to the
   *  cloud centroid and the cloud becomes the soft focus, but the camera
   *  stays where it is. See FocusController.setOrbitTargetCloud. */
  setOrbitTargetCloud(cloudIdx: number) { this.focus.setOrbitTargetCloud(cloudIdx); }

  // makeStarFocusTarget / makeCloudFocusTarget / currentFocusTarget
 // moved to FocusController — they close over the focus
  // state (focusedStar / focusedCloud / focusedPlanetSystem) so they
  // belong where that state lives. WarpController consumes them through
  // the `FocusOps` seam.

  /** Start an animated journey from the currently focused thing (star
   *  or cloud) to the star at `destIdx`. Thin shim over WarpController. */
  warpTo(destIdx: number) {
    this.warp.warpTo(destIdx);
  }

  /** Cloud-destination warp — flies from the currently focused thing
   *  to a cloud's centroid. Thin shim over WarpController. */
  warpToCloud(destIdx: number) {
    this.warp.warpToCloud(destIdx);
  }

  /** Local-frame position of a cloud's centroid. Returns null if the
   *  cloud layer hasn't been attached yet. */
  cloudLocalPosition(cloudIdx: number): THREE.Vector3 | null {
    const out = new THREE.Vector3();
    return this.cloudLocalPositionInto(cloudIdx, out) ? out : null;
  }

  /** Non-allocating sibling of `cloudLocalPosition`: writes the cloud's
   *  local-frame centroid into `out` when the cloud exists, returns
   *  `true`. Returns `false` (and leaves `out` untouched) when no cloud
   *  layer is attached or the index is out of range. */
  cloudLocalPositionInto(cloudIdx: number, out: THREE.Vector3): boolean {
    if (!this.clouds) return false;
    const c = this.clouds.clouds[cloudIdx];
    if (!c) return false;
    out.copy(c.centerAbs).sub(this.worldOffset);
    return true;
  }

  // Swing the camera to face the selected constellation while keeping the
  // orbit target and orbit radius unchanged — only the camera's position on
  // the orbit sphere moves. The aim point is the brightness-weighted
  // centroid of the figure stars as seen from the current target, so a
  // constellation looks "centered" on whichever of its members visually
  // dominate from the user's current vantage, even when the user has
  // travelled deep into 3D space.
  aimAtConstellation(conIndex: number) {
    this.cancelUnfocusLerp();
    this.cancelFocusLerp();
    if (this.isObserveTransitionActive()) return;
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
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), DCAM_LOG_FLOOR_PC);
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
   * Smoothly rotate the camera so that `pointLocal` (a world point in
   * the renderer's local frame) ends up at the centre of the view.
   * Mode-aware: in navigate the orbit-pivot is held and the camera
   * sweeps around it; in observe the camera position is held and only
   * the quaternion rotates. Called by the Sol / GC label click handlers,
   * the constellation picker, the POI overlay, and the observe-mode
   * double-click.
   *
   * No-ops during warp, mid-aim, focus-lerp, or observe-transition. The
   * actual slerp + controls.enabled / observeControls handoff lives in
   * `AimController`; this dispatcher owns the composition-layer busy
   * gates the controller doesn't see.
   */
  aimAt(pointLocal: THREE.Vector3) {
    if (this.warp.isActive() || this.aim.isActive()) return;
    this.cancelUnfocusLerp();
    this.cancelFocusLerp();
    if (this.isObserveTransitionActive()) return;
    this.aim.aimAt(pointLocal);
  }

  // Star position in the renderer's local frame — i.e. in the same space
  // as `camera.position` and `controls.target`. This is what overlays want
  // for projection math and what the orbit camera operates in. It is NOT
  // the absolute (Sol-centric) catalog position when a star is focused;
  // use `catalog.positions[i*3..]` directly if you need absolute space
  // (e.g. distance-from-Sol labels).
  starLocalPosition(i: number): THREE.Vector3 {
    return this.starLocalPositionInto(i, new THREE.Vector3());
  }

  /** Non-allocating sibling of `starLocalPosition`: writes the local-frame
   *  position of star `i` into `out` and returns `out`. Use from per-frame
   *  callers (animate, updateWarp, overlay updates); the allocating shim
   *  above stays for cold paths and external API. */
  starLocalPositionInto(i: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this._localPositions;
    return out.set(p[i * 3 + 0], p[i * 3 + 1], p[i * 3 + 2]);
  }

  /** Cached PlanetSystem for an attached host, or null if the host
   *  isn't attached. Used by the planet hover formatter to resolve
   *  `(hostStarIdx, planetIdx)` from a pick back to a Planet record
   *  without re-running async `getPlanetSystem`. */
  getAttachedPlanetSystem(hostStarIdx: number): PlanetSystem | null {
    return this.planetBodyField.getAttachedPlanetSystem(hostStarIdx);
  }

  /** Live host→planet distance in pc for `(hostStarIdx, planetIdx)`,
   *  using the latest cached `iLocalRel`. Returns null when the host
   *  isn't attached or the index is out of range. The hover formatter
   *  calls this so the "distance from host" line tracks the ephemeris
   *  through the orbit rather than freezing at the mean semi-major
   *  axis. Decoupled from focus state per the lo5 visibility-only
   *  hover rule. */
  planetHostDistancePc(hostStarIdx: number, planetIdx: number): number | null {
    return this.planetBodyField.planetHostDistancePc(hostStarIdx, planetIdx);
  }

  /** Live apparent V mag for `(hostStarIdx, planetIdx)`, matching the
   *  planet shader's reflected-light formula at the current camera
   *  position. Returns null when the host isn't attached or the index
   *  is out of range. Decoupled from focus state per the lo5
   *  visibility-only hover rule. */
  planetApparentMag(hostStarIdx: number, planetIdx: number): number | null {
    return this.planetBodyField.appMagFor(
      hostStarIdx,
      planetIdx,
      this.camera.position,
    );
  }

  private pointerDownAt: { x: number; y: number; t: number } | null = null;
  private twoFingerAngle: number | null = null;
  private gestureLastRotation = 0;

  private attachEvents() {
    window.addEventListener('resize', this.onResize);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    // pointercancel partner for pointerdown/pointerup. Without it an
    // OS-cancelled touch (phone-call interrupt, system gesture preempt)
    // leaves pointerDownAt set, and the next genuine pointerup may satisfy
    // the click gates against a stale 'down' from a different gesture and
    // fire a phantom click.
    canvas.addEventListener('pointercancel', this.onPointerCancel);
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
    this.starPipeline.discMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.starPipeline.discMaterial.uniforms.uViewport.value.set(w, h);
    // Aspect change → fov_minor moves → orbit floor needs a refresh while
    // a star is focused. (FOV-only changes go through setCameraFov, which
    // does its own recompute.)
    const focusedStar = this.focus.getFocusedStar();
    if (focusedStar !== null) {
      this.controls.minDistance = starPhysics.minOrbitDistForStar({
        catalog: this.catalog,
        idx: focusedStar,
        fovMinorRad: starPhysics.fovMinorRad(this.camera),
      });
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

  // Pixel-per-radian conversion for the active viewport / FOV. Shared
  // by every screen-space size calc (star disc, cloud silhouette, peak-
  // amplitude disc, glsl `physSizePx` mirror).
  private angularToPx(): number {
    const u = this.starPipeline.discMaterial.uniforms;
    const viewport = u.uViewport.value as THREE.Vector2;
    return angularToPxPure(viewport.y, u.uFovYRad.value as number);
  }

  /** Cloud analogue of `renderedSizePx` — pixel diameter of the cloud's
   *  silhouette at the current camera distance. Used by the distance-vector
   *  overlay so the chevron tip lands on the cloud's rendered edge instead
   *  of the user's `sizeMax` star-size knob. Returns 0 when no cloud layer
   *  is loaded or the index is out of range. */
  renderedCloudSizePx(cloudIdx: number): number {
    if (!this.clouds) return 0;
    const cloud = this.clouds.clouds[cloudIdx];
    if (!cloud) return 0;
    const local = this._tmpRenderLocal;
    if (!this.cloudLocalPositionInto(cloudIdx, local)) return 0;
    const camPos = this.camera.position;
    const dx = local.x - camPos.x;
    const dy = local.y - camPos.y;
    const dz = local.z - camPos.z;
    const dCam = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dCam < 1e-12) {
      return renderedCloudSizePx(cloud, dCam, this.angularToPx());
    }
    // World-space unit direction from the cloud toward the camera. The
    // helper rotates this into the cloud's local frame so the silhouette
    // bound tightens for axis-aligned views (prolate end-on no longer
    // overshoots by the prolate axis ratio).
    this.tmpCloudDir.set(camPos.x - local.x, camPos.y - local.y, camPos.z - local.z)
      .multiplyScalar(1 / dCam);
    return renderedCloudSizePx(cloud, dCam, this.angularToPx(), this.tmpCloudDir);
  }
  private tmpCloudDir = new THREE.Vector3();
  // Scratch slots for the non-allocating *LocalPositionInto helpers.
  // Each is owned by one call-stack scope; values are valid only inside
  // that scope and must not be retained across method calls.
  //
  //  - _tmpAnimateLocal: owned by animate() and the methods it calls
  //    in sequence (updateGalacticLayers). Single writer in steady-state;
  //    the warp tick claimed its share when WarpController extracted in
 //.5. Adding a new writer that retains the value across
  //    another animate-stack method violates the contract.
  //  - _tmpRenderLocal: owned by per-call read methods invoked outside
  //    the animate stack (renderedCloudSizePx, etc.). Independent of
  //    _tmpAnimateLocal; never observed by code that holds a reference
  //    across calls.
  private _tmpAnimateLocal = new THREE.Vector3();
  private _tmpRenderLocal = new THREE.Vector3();

  /** Public access to the HUD overlay — for the arrow-fade debug HUD only. */
  get hud(): HudOverlay { return this.hudOverlay; }

 // parkDistForStar moved to FocusController — used by
  // ObserveTransition's ObserveFocusOps seam and the focus-park lerp.

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.pointerDownAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerCancel = () => {
    this.pointerDownAt = null;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    if (!down) return;
    if (this.warp.isActive() || this.aim.isActive()) return;
    this.cancelUnfocusLerp();
    this.cancelFocusLerp();
    if (this.isObserveTransitionActive()) return;
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
    const starIdx = this.picker.pickStar(e.clientX, e.clientY);
    const cloudIdx = starIdx >= 0 ? null : this.picker.pickCloud(e.clientX, e.clientY);
    if (starIdx < 0 && cloudIdx === null) return;

    // Unified click-state machine — clouds participate the same way as
    // stars (orbit-target on first pick, vector destination on second
    // pick from a focus, click-tip-to-travel on third pick). The two
    // special cases the user called out are: (a) focus ring stays a
    // star-only overlay (skipped naturally — no focus ring code touches
    // focusedCloud), and (b) viewing distance for clouds is
    // cloudViewingDistancePc rather than parkDistForStar.
    const focusedStar = this.focus.getFocusedStar();
    const focusedCloud = this.focus.getFocusedCloud();
    const focusedThing =
      focusedStar !== null
        ? { kind: 'star' as const, idx: focusedStar }
        : focusedCloud !== null
          ? { kind: 'cloud' as const, idx: focusedCloud }
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

    // No focus → click parks the camera at the clicked thing, matching
    // search-select and URL-restore. For stars that's parkDistForStar (10%
    // disc fill); clouds keep their orbit-target-only behaviour for now
    // (cloud focus UX is shelved — see CLAUDE.md).
    if (!focusedThing) {
      if (clickedThing.kind === 'star') this.focusStar(clickedThing.idx);
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
    // For stars, focusStar matches the search-select teleport
    // (parks at parkDistForStar(idx)). For clouds, flyToCloud is the
    // search-select analogue (cloudViewingDistancePc).
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
    const idx = this.picker.pickStar(x, y);
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
    const u = this.starPipeline.discMaterial.uniforms;
    const fovYRad = u.uFovYRad.value as number;
    const viewport = u.uViewport.value as THREE.Vector2;
    const halfAngle = (Stellata.CORE_MASK_MIN_PX * fovYRad)
      / (Math.max(viewport.y, 1) * 2);
    const dThresh = this.maxPhysicalRadiusPc / Math.max(Math.tan(halfAngle), DCAM_LOG_FLOOR_PC);
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

    const sortedIdx = this.sortedByDistFromSol;
    const { start, end } = sortedDistRange(this.sortedDistFromSol, lo, hi);

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
    if (this.warp.isActive()) {
      this.warp.tick(performance.now());
    } else if (this.aim.isActive()) {
      this.aim.tick(performance.now());
    } else if (this.focus.isFocusLerpActive()) {
      this.focus.tick(performance.now());
    } else if (this.aim.isObserveAimActive()) {
      this.aim.tickObserve(performance.now());
      // Observe-mode aim slerps the camera quaternion in place. The
      // controls.target still needs the per-frame re-pin so URL state stays
      // truthful mid-flight.
      this.observeUpdateTarget();
    } else if (this.observe.isAnyActive()) {
      this.observe.tick(performance.now());
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
    this.starPipeline.discMaterial.uniforms.uCameraPos.value.copy(this.camera.position);
    // Pin the focused star at NDC (0,0) only when the geometric
    // invariant holds: navigate mode, no warp/aim animation, and the
    // user hasn't panned the camera target away from the focused star
    // (target ≈ local origin). Pan moves target away from the star and
    // we want it to render at its actual projected position again.
    const pinTarget = this.focus.isPinEngaged() ? this.focus.getFocusedStar() : -1;
    this.starPipeline.discMaterial.uniforms.uPinFocusToCenter.value = pinTarget ?? -1;
    // Advance variability clock (seconds since start). Shared with glow
    // material via sharedUniforms so both passes see the same time.
    this.starPipeline.discMaterial.uniforms.uTime.value = (performance.now() - this.animateStartMs) / 1000;
    perfMark('coreMask');
    this.starPipeline.coreMaskMesh.visible = this.shouldEnableCoreMask();
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
    perfMark('frame.handlers');
    this.bus.emit('frame');
    perfMeasure('frame.handlers');
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
    if (this.warp.isActive()) {
      this.galacticDisc.group.visible = false;
      if (this.localGroupLayer) this.localGroupLayer.group.visible = false;
      this.galacticGrid.group.visible = false;
      this.hudOverlay.setVisible(false);
      // Orbit rings are focus-only — no warp-destination ring preview.
      // Planet bodies belong to the global PlanetBodyField; they fade
      // in naturally as the camera nears each host's cull distance.
      this.orbitRingsLayer.update(this.camera, window.innerHeight);
      this.planetBodyField.update(this.camera, this.getT());
      // Cloud layer is shelved for v1.0 (CLAUDE.md): visible=false. Flip
      // to true (or restore a FilterState flag) when re-enabling.
      this.clouds?.update(this.worldOffset, false);
      return;
    }
    this.orbitRingsLayer.update(this.camera, window.innerHeight);
    this.planetBodyField.update(this.camera, this.getT());

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
    this.localGroupLayer?.update(this.worldOffset, distFromSol);

    if (this.filter.showGalacticGrid) {
      this.galacticGrid.group.visible = true;
      this.galacticGrid.update(this.camera.position);
    } else {
      this.galacticGrid.group.visible = false;
    }

    const focusedStar = this.focus.getFocusedStar();
    const focusedLocal =
      focusedStar !== null
        ? this.starLocalPositionInto(focusedStar, this._tmpAnimateLocal)
        : null;
    const isSolFocus = focusedStar !== null && focusedStar === this.catalog.solIndex;
    // HudOverlay computes its own fade alpha from THIS frame's shaft
    // geometry — no more one-frame-lag flash when the HUD toggles on
    // (ml8 symptom 1). The distance-vector overlay does the same in its
    // 'frame' handler against its own arrow length (ml8 symptom 2 / per-
    // arrow coverage from the bead's option B).
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
      focusedDiscRadiusPx: focusedStar !== null
        ? starPhysics.renderedDiscPxAtPeak({
            catalog: this.catalog,
            idx: focusedStar,
            camPos: this.camera.position,
            localPositions: this._localPositions,
            uniforms: this.starPipeline.discMaterial.uniforms as unknown as starPhysics.StarPhysicsUniforms,
          }) * 0.5
        : 0,
      w: window.innerWidth,
      h: window.innerHeight,
    });

    // Cloud layer is shelved for v1.0 (CLAUDE.md): visible=false. Flip
    // to true (or restore a FilterState flag) when re-enabling.
    this.clouds?.update(this.worldOffset, false);
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
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    canvas.removeEventListener('touchstart', this.onTouchStart);
    canvas.removeEventListener('touchmove', this.onTouchMove);
    canvas.removeEventListener('touchend', this.onTouchEnd);
    canvas.removeEventListener('touchcancel', this.onTouchEnd);
    canvas.removeEventListener('gesturestart', this.onGestureStart as EventListener);
    canvas.removeEventListener('gesturechange', this.onGestureChange as EventListener);
    // observeControls owns its own pointer + wheel listeners; disable() is
    // idempotent so it's safe regardless of current mode.
    this.observeControls.disable();
    this.aim.dispose();
    this.warp.dispose();
    this.observe.dispose();
    this.focus.dispose();
    this.hudOverlay.dispose();
    this.controls.dispose();
    this.starPipeline.dispose();
    this.dustParticles.dispose();
    this.clouds?.dispose();
    this.localGroupLayer?.dispose();
    this.galacticDisc.dispose();
    this.galacticGrid.dispose();
    this.orbitRingsLayer.dispose();
    this.planetBodyField.dispose();
    this.heliopause.dispose();
    this.milkyway.dispose();
    // The dust voxel grid is the largest single GPU allocation in the app
    // (~128 MiB Data3DTexture). MilkyWay shares the same texture handle but
    // doesn't own it.
    this.dust?.dispose();
    this.dust = null;
    this.renderer.dispose();
    this.bus.clear();
  }
}

export { ALL_SPECT_MASK };
