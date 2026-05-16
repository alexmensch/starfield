// Global planet-body field (stellata-3re.15 / 3re.16 / bk5 prep).
//
// One instanced mesh holding every attached host's planet bodies. v1
// attaches Sol once at startup; the exoplanet epic (stellata-bk5)
// will iterate through additional hosts as their per-star
// PlanetSystem shards land.
//
// # Why a global field instead of per-host instances
//
// Bodies are PHYSICAL objects — they exist whether or not the camera
// is focused on their host. Per the unfocus-split rule (3re.15) we
// keep them rendering when the host loses focus, gated only by:
//   • per-planet apparent-magnitude visibility (3re.16);
//   • a per-host distance cull (CPU-side optimisation that skips the
//     ephemeris + buffer upload for hosts whose brightest planet is
//     already below the slider cutoff at the current camera distance).
//
// At bk5 scale (potentially hundreds of attached hosts) we cannot
// afford per-host THREE.Mesh instances. One InstancedBufferGeometry
// holds all of them; the per-host distance cull handles the bulk
// rejection.
//
// # Render passes
//
// Five materials share the geometry. Three mirror the star pipeline
// (core / disc / glow) — same uRenderMode 2/1/0, same gates, same
// halo-depth trick. The other two are a corrupt+restore pair around
// the orbit ring layer (planet-only, stellata-3re.19):
//   • disc    — per-channel-max, depth-write on (close-range resolved)
//   • glow    — additive, depth-test on (distant point glow)
//   • core    — depth-only mask at -4, colorWrite off (occludes
//               background layers behind close planet cores)
//   • corrupt — depth-only at 1.5; writes gl_FragDepth = 0.0 across the
//               planet's core region (glow >= uCoreThreshold). Forces
//               the orbit ring at renderOrder 2 to depth-fail regardless
//               of its 3D position — so near-side ring segments that
//               would otherwise pass the depth test are hidden too.
//   • restore — depth-only at 2.5; writes the planet's actual depth
//               (gl_FragCoord.z) back across the same core region so
//               disc / glow at 3 / 4 still depth-test correctly against
//               other planets and stars. depthFunc: AlwaysDepth so it
//               can overwrite the 0.0 the corrupt pass wrote.
//
// Why planets diverge from the star pipeline's 3-pass shape: the
// planet's orbit ring physically passes through the planet's body at
// the planet's current position, and the user wants the planet to
// read as a solid 2D blob bisecting the ring — from any angle, not
// just behind. Pure depth-test occlusion can't express that (near-side
// rings legitimately have smaller depth), hence the corrupt+restore
// trick. Stars don't have any layer that obviously wants this; the
// equivalent question for stars (galactic gridlines / distance-vector
// chevrons through a foreground star's halo) is filed as
// stellata-9mm.180.
//
// uRenderMode is the only divergent uniform. Everything else
// (apparent-mag math, view-space distances, perceptual-disc shaping)
// is computed once per quad regardless of which pass is drawing it.

import * as THREE from 'three';
import type { PlanetSystem } from './planet-system';
import {
  lambertianPhaseFactor,
  mallamaPhaseFactor,
  peakPhaseFactor,
  type PhaseCoefficients,
} from './phase-function';
import { applyDiscBlendDefaults } from './stellata';
import { AU_PC, KM_PC } from './astronomy-constants';
import {
  orbitalPlaneNormalFor,
  placeholderEccentricAnomaly,
  planetLocalPosition,
  solidityForType,
} from './orbit-rings-layer';
import {
  perceptualAppSizePx,
  perceptualDmEff,
  planetApparentMagnitude,
} from './perceptual-magnitude';
import {
  MIN_DISC_HIT_RADIUS_PX,
  pickFromCandidates,
  physSizePx,
  type PickCandidate,
} from './star-geometry';
import type { HoverHit } from './hover/hover-types';
import planetVert from './shaders/planet.vert.glsl?raw';
import planetFrag from './shaders/planet.frag.glsl?raw';

/**
 * Shared per-frame uniforms the body materials read from. The star
 * pipeline owns the canonical references (initialised once in
 * stellata.ts and mutated as state changes); the body materials hold
 * pointers to the same `{ value }` objects so a single update on the
 * star side propagates everywhere.
 */
export interface PlanetMaterialUniforms {
  uMaxAppMag: { value: number };
  uSizeMin: { value: number };
  uSizeMax: { value: number };
  uSizeSpan: { value: number };
  uSizeKnee: { value: number };
  uVisibleThreshold: { value: number };
  uVisibleK: { value: number };
  uCoreThreshold: { value: number };
  uDiscardThreshold: { value: number };
  uDistNMin: { value: number };
  uDistNMax: { value: number };
  uLumBiasMin: { value: number };
  uLumBiasMax: { value: number };
  uViewport: { value: THREE.Vector2 };
  uPixelRatio: { value: number };
  uFovYRad: { value: number };
}

// Initial slot capacity. v1 attaches Sol (9 planets) once; bk5 may
// grow this as exoplanet hosts come online. Resizing reallocates the
// instanced attribute buffers — relatively cheap compared to a frame.
const INITIAL_CAPACITY = 16;

/**
 * Maximum d_v_p at which any planet of an attached host could plausibly
 * cross the magnitude cutoff. Closed-form solution of the apparent-mag
 * equation evaluated at the brightest planet's `p · (R/a)²` (the
 * geometry-independent reflectance proxy):
 *
 *   m_planet ≈ M_host + 5·log10(d/10) − 2.5·log10(p · (R/a)²)
 *
 * Set m_planet = maxAppMag and solve for d:
 *
 *   d_cull = 10 pc · √(p · (R/a)²) · 10^((maxAppMag − M_host) / 5)
 *         = 10 pc · sqrt(p) · (R/a) · 10^((maxAppMag − M_host) / 5)
 *
 * The caller folds `peakPhaseFactor(coefs)` into `brightestReflectance`
 * before passing it in (see `attachHost`). For most planets that's a
 * 1× no-op (c0 = 0 ⇒ φ(0) = 1); Saturn's c0 = −0.55 ring boost lifts
 * φ(0) to ~1.66, widening Saturn's cull by ~√1.66 ≈ 1.29×. The cull
 * remains a conservative outer bound: at any α the actual flux factor
 * is ≤ φ_peak, so a host past d_cull is genuinely sub-cutoff.
 *
 * Pure function — exported for tests.
 */
export function cullDistancePc(
  hostAbsmag: number,
  brightestReflectance: number,
  maxAppMag: number,
): number {
  if (brightestReflectance <= 0) return 0;
  const distanceFactor = 10 ** ((maxAppMag - hostAbsmag) / 5);
  return 10 * Math.sqrt(brightestReflectance) * distanceFactor;
}

interface AttachedHost {
  hostStarIdx: number;
  ps: PlanetSystem;
  hostAbsmag: number;
  /** Absolute (catalog-space) host position in pc. Static for the
   *  session — used to recompute hostLocalPos whenever worldOffset
   *  changes. */
  hostAbsPos: THREE.Vector3;
  /** Cached host-local-frame position (= hostAbsPos − worldOffset). */
  hostLocalPos: THREE.Vector3;
  /** ICRS-aligned orbital-plane orientation for this host. */
  orientation: THREE.Quaternion;
  positionsAt: ((t: number, out: Float32Array) => void) | null;
  positionsScratch: Float32Array | null;
  /** max over planets of `p · (R / a)² · peakPhaseFactor(coefs)` —
   *  the geometry-independent reflectance proxy folded with each
   *  planet's α=0 phase boost. Drives cullDistancePc. Saturn's ring
   *  c0 lifts its term above the globe-only reflectance; for every
   *  other planet peakPhaseFactor = 1. */
  brightestReflectance: number;
  /** Cached cull distance for the current maxAppMag. */
  cullDistance: number;
  /** Slot range in the global instanced buffer. */
  startInstance: number;
  count: number;
}

// Per-candidate row in the cross-host pick reducer. Extends the shared
// `PickCandidate` shape so `pickFromCandidates` in star-geometry.ts
// reduces it under the same prime/fallback contract every layered
// picker uses. `idx` is the planet-within-host index (decoded from the
// winning candidate as `hostStarIdx + idx`); the host axis rides
// through on `hostStarIdx`.
type CrossHostCandidate = PickCandidate & {
  hostStarIdx: number;
  cameraDistancePc: number;
};

// Phase factor φ(α) for a planet given viewer→planet and viewer→host
// vectors. Computes α = ∠(viewer–planet–host) and dispatches into
// Mallama (when a polynomial exists for this body) or Lambertian (the
// default fallback for Pluto + every exoplanet). Mirrors the
// `if (alphaMaxDeg > 0.0 && alphaDeg <= alphaMaxDeg)` branch in
// planet.vert.glsl exactly through the shared TS helpers.
function phaseFactorFor(
  dvx: number,
  dvy: number,
  dvz: number,
  dhx: number,
  dhy: number,
  dhz: number,
  coefs: PhaseCoefficients | undefined,
): number {
  // vphHat = planet → viewer (= −view-space planet direction). hphHat
  // = planet → host. Both normalised; cos α is the dot product.
  const lenV = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
  const lenHp = Math.sqrt(
    (dhx - dvx) ** 2 + (dhy - dvy) ** 2 + (dhz - dvz) ** 2,
  );
  if (lenV <= 0 || lenHp <= 0) return 1;
  const vphX = -dvx / lenV;
  const vphY = -dvy / lenV;
  const vphZ = -dvz / lenV;
  const hphX = (dhx - dvx) / lenHp;
  const hphY = (dhy - dvy) / lenHp;
  const hphZ = (dhz - dvz) / lenHp;
  const cosA = Math.max(-1, Math.min(1, vphX * hphX + vphY * hphY + vphZ * hphZ));
  const alpha = Math.acos(cosA);
  return coefs ? mallamaPhaseFactor(coefs, alpha) : lambertianPhaseFactor(alpha);
}

export class PlanetBodyField {
  readonly group: THREE.Group;
  private mono = false;
  private hidden = false;
  private hosts = new Map<number, AttachedHost>();
  private capacity = INITIAL_CAPACITY;
  private liveCount = 0;
  private worldOffset = new THREE.Vector3();
  private maxAppMag: number;
  // Shared uniform bundle — references, not copies. The picker reads
  // current values directly so it stays in lockstep with the shaders
  // and any debug-panel writes to the same `{ value }` slots.
  private magShared: PlanetMaterialUniforms;
  // Per-instance attribute buffers. Re-allocated on capacity grow.
  private bufLocalRel!: Float32Array;
  private bufHostLocalPos!: Float32Array;
  private bufRadius!: Float32Array;
  private bufColour!: Float32Array;
  private bufSolidity!: Float32Array;
  private bufAlbedo!: Float32Array;
  private bufHostAbsmag!: Float32Array;
  // Phase-curve coefficients packed as two vec4 attributes:
  //   bufPhaseA: (c0, c1, c2, c3)
  //   bufPhaseB: (c4, c5, c6, alphaMaxDeg)
  // alphaMaxDeg = 0 is the "no Mallama fit, use Lambertian" sentinel
  // — the same default Pluto and every exoplanet hit. See
  // `phase-function.ts` for the polynomial form.
  private bufPhaseA!: Float32Array;
  private bufPhaseB!: Float32Array;
  private geometry!: THREE.InstancedBufferGeometry;
  private matDisc!: THREE.ShaderMaterial;
  private matGlow!: THREE.ShaderMaterial;
  private matCore!: THREE.ShaderMaterial;
  private matCorrupt!: THREE.ShaderMaterial;
  private matRestore!: THREE.ShaderMaterial;
  private meshDisc!: THREE.Mesh;
  private meshGlow!: THREE.Mesh;
  private meshCore!: THREE.Mesh;
  private meshCorrupt!: THREE.Mesh;
  private meshRestore!: THREE.Mesh;
  // Reusable scratch — avoids per-frame allocation in update().
  private rotateTmp = new THREE.Vector3();

  constructor(magnitudeShared: PlanetMaterialUniforms) {
    this.magShared = magnitudeShared;
    this.maxAppMag = magnitudeShared.uMaxAppMag.value;
    this.group = new THREE.Group();
    this.group.visible = false;
    // PlanetBodyField sits in the renderer's local frame (no group
    // translation). iHostLocalPos delivers each host's offset from
    // world-local origin per-instance; the shader does the rest.
    this.allocateBuffers(this.capacity);
    this.buildGeometry();
    this.buildMaterials(magnitudeShared);
  }

  /**
   * Attach a planet system to the global field. Idempotent — calling
   * with an already-attached host idx replaces its data without
   * compacting the buffer (the new instance range may shift).
   *
   * `hostAbsPos` is the host's absolute (catalog-space) position in
   * pc. The class converts to local-frame each time `recenter()`
   * fires.
   */
  attachHost(
    hostStarIdx: number,
    ps: PlanetSystem,
    hostAbsmag: number,
    hostAbsPos: Readonly<THREE.Vector3>,
    solIndex: number,
    t: number,
  ): void {
    if (ps.planets.length === 0) return;
    if (this.hosts.has(hostStarIdx)) this.detachHost(hostStarIdx);

    const n = ps.planets.length;
    while (this.liveCount + n > this.capacity) {
      this.growCapacity();
    }

    const planeNormal = orbitalPlaneNormalFor(ps.hostStarIdx, solIndex);
    const orientation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      planeNormal,
    );

    let brightestReflectance = 0;
    for (const planet of ps.planets) {
      const aPc = planet.semiMajorAxisAu * AU_PC;
      const RoverA = (planet.radiusKm * KM_PC) / Math.max(aPc, 1e-30);
      // Saturn's rings raise its α=0 brightness above globe-only
      // reflectance via the Mallama c0 term — fold it into the cull
      // proxy so the cull distance widens to match. Other planets
      // have c0=0 ⇒ peak factor 1, leaving the formula unchanged.
      const peakBrightness = peakPhaseFactor(planet.phaseCoefficients);
      const refl = planet.albedo * RoverA * RoverA * peakBrightness;
      if (refl > brightestReflectance) brightestReflectance = refl;
    }

    const host: AttachedHost = {
      hostStarIdx,
      ps,
      hostAbsmag,
      hostAbsPos: new THREE.Vector3().copy(hostAbsPos),
      hostLocalPos: new THREE.Vector3().copy(hostAbsPos).sub(this.worldOffset),
      orientation,
      positionsAt: ps.positionsAt ?? null,
      positionsScratch: ps.positionsAt ? new Float32Array(n * 3) : null,
      brightestReflectance,
      cullDistance: cullDistancePc(hostAbsmag, brightestReflectance, this.maxAppMag),
      startInstance: this.liveCount,
      count: n,
    };
    this.hosts.set(hostStarIdx, host);
    this.liveCount += n;

    // Initial fill — bodies, host position, and one immediate
    // ephemeris-or-placeholder pass so the first frame after attach
    // has valid iLocalRel data.
    this.writeHostStaticAttributes(host);
    this.writeHostPositions(host, t);
    this.flushAttributeRange(host.startInstance, host.count);
    this.geometry.instanceCount = this.liveCount;
    this.group.visible = !this.hidden && !this.mono;
  }

  detachHost(hostStarIdx: number): void {
    const host = this.hosts.get(hostStarIdx);
    if (!host) return;
    // Compact: shift any later hosts down to fill the gap so the
    // buffer stays packed. v1 only ever attaches Sol once and never
    // detaches, so this path is exercised by future bk5 lifecycle
    // changes — keep the implementation simple, not blazing fast.
    const tailStart = host.startInstance + host.count;
    const shiftCount = this.liveCount - tailStart;
    if (shiftCount > 0) {
      this.shiftInstancesDown(tailStart, shiftCount, host.count);
      for (const h of this.hosts.values()) {
        if (h.startInstance >= tailStart) {
          h.startInstance -= host.count;
        }
      }
    }
    this.liveCount -= host.count;
    this.geometry.instanceCount = this.liveCount;
    this.flushAllAttributes();
    this.hosts.delete(hostStarIdx);
    if (this.liveCount === 0) this.group.visible = false;
  }

  /**
   * Adjust each attached host's local-frame position when the
   * floating-origin shifts. Cheap — a vector subtract per host plus
   * a buffer write. Called once by `Stellata.recenterOrigin`.
   */
  recenter(newWorldOffset: Readonly<THREE.Vector3>): void {
    if (newWorldOffset.equals(this.worldOffset)) return;
    this.worldOffset.copy(newWorldOffset);
    for (const host of this.hosts.values()) {
      host.hostLocalPos.copy(host.hostAbsPos).sub(this.worldOffset);
      this.writeHostLocalPos(host);
    }
    this.flushAttributeRange(0, this.liveCount);
  }

  /**
   * Recompute per-host cull distances when the magnitude slider
   * moves. Stellata.ts calls this from `setFilter` whenever
   * `maxAppMag` changes.
   */
  setMaxAppMag(maxAppMag: number): void {
    if (this.maxAppMag === maxAppMag) return;
    this.maxAppMag = maxAppMag;
    for (const host of this.hosts.values()) {
      host.cullDistance = cullDistancePc(host.hostAbsmag, host.brightestReflectance, maxAppMag);
    }
  }

  /**
   * Per-frame ephemeris refresh + buffer upload. For each attached
   * host, skip the work entirely when the camera is past `cullDistance`
   * — the planets would be sub-cutoff anyway and stale iLocalRel data
   * is harmless once the host comes back into range.
   */
  update(camera: THREE.PerspectiveCamera, t: number): void {
    if (this.hidden || this.mono || this.liveCount === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    let touched = false;
    for (const host of this.hosts.values()) {
      const dToHost = camera.position.distanceTo(host.hostLocalPos);
      if (dToHost > host.cullDistance) continue;
      if (host.positionsAt) {
        this.writeHostPositions(host, t);
        touched = true;
      }
    }
    if (touched) this.flushAttributeRange(0, this.liveCount);
  }

  /**
   * Read-only slice of the focused host's planet local-frame positions.
   * Layout: 3 floats per planet, ordering matches PlanetSystem.planets.
   * Returns null when the host isn't attached.
   *
   * The planet-labels overlay reads this so labels project to the same
   * positions the body shader renders at, without re-running the
   * Keplerian math itself.
   */
  getHostLocalPositions(hostStarIdx: number): Float32Array | null {
    const host = this.hosts.get(hostStarIdx);
    if (!host) return null;
    return this.bufLocalRel.subarray(
      host.startInstance * 3,
      (host.startInstance + host.count) * 3,
    );
  }

  /**
   * Host→planet distance in pc for the host's planet at `planetIdx`,
   * using the latest cached `iLocalRel` write. iLocalRel lives in the
   * host's plane frame post-orientation, so its length is the
   * frame-independent radial separation. Returns null if the host
   * isn't attached or planetIdx is out of range.
   *
   * The hover formatter uses this for the "distance from host" line so
   * users see the live ephemeris radius (Mercury 0.31–0.47 AU across
   * its orbit) rather than the mean semi-major axis from
   * `PlanetSystem.planets[i].semiMajorAxisAu`.
   */
  planetHostDistancePc(hostStarIdx: number, planetIdx: number): number | null {
    const host = this.hosts.get(hostStarIdx);
    if (!host) return null;
    if (planetIdx < 0 || planetIdx >= host.count) return null;
    const base = (host.startInstance + planetIdx) * 3;
    const x = this.bufLocalRel[base + 0];
    const y = this.bufLocalRel[base + 1];
    const z = this.bufLocalRel[base + 2];
    return Math.sqrt(x * x + y * y + z * z);
  }

  /**
   * Per-instance apparent V mag for one of the host's planets, evaluated
   * from `cameraPosLocal` (in the renderer's local frame). Mirrors the
   * planet vertex shader's reflected-light formula exactly via
   * `planetApparentMagnitude` in perceptual-magnitude.ts (vitest-pinned)
   * and the matching per-planet phase factor in phase-function.ts.
   *
   * Returns null if the host isn't attached or planetIdx is out of
   * range. Callers should treat null the same way the shader treats
   * `appMag > uMaxAppMag + 0.5` — the planet isn't a viable hover target.
   */
  appMagFor(
    hostStarIdx: number,
    planetIdx: number,
    cameraPosLocal: Readonly<THREE.Vector3>,
  ): number | null {
    const host = this.hosts.get(hostStarIdx);
    if (!host) return null;
    if (planetIdx < 0 || planetIdx >= host.count) return null;
    return this.evalPlanetView(host, planetIdx, cameraPosLocal).appMag;
  }

  /**
   * Geometry-and-photometry of one of the host's planets evaluated from
   * a single viewer position in the local frame. Mirrors the planet
   * vertex shader's reflected-light pipeline (phase factor → apparent
   * magnitude) and produces the world-space planet position the picker
   * projects to screen — single source for the math that both
   * `appMagFor` (hover formatter feed) and `pick` (hover picker)
   * consume, so the two can't drift on phase / albedo / radius logic.
   *
   * No null branch: caller has already checked the host attached state
   * and the planetIdx range.
   */
  private evalPlanetView(
    host: AttachedHost,
    planetIdx: number,
    cameraPosLocal: Readonly<THREE.Vector3>,
  ): { appMag: number; planetX: number; planetY: number; planetZ: number; dVp: number } {
    const planet = host.ps.planets[planetIdx];
    const base = (host.startInstance + planetIdx) * 3;
    const planetX = host.hostLocalPos.x + this.bufLocalRel[base + 0];
    const planetY = host.hostLocalPos.y + this.bufLocalRel[base + 1];
    const planetZ = host.hostLocalPos.z + this.bufLocalRel[base + 2];
    const dvx = planetX - cameraPosLocal.x;
    const dvy = planetY - cameraPosLocal.y;
    const dvz = planetZ - cameraPosLocal.z;
    const dVp = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
    const dhx = host.hostLocalPos.x - cameraPosLocal.x;
    const dhy = host.hostLocalPos.y - cameraPosLocal.y;
    const dhz = host.hostLocalPos.z - cameraPosLocal.z;
    const dVh = Math.sqrt(dhx * dhx + dhy * dhy + dhz * dhz);
    // Planet→host distance is just the iLocalRel magnitude.
    const dHp = Math.sqrt(
      this.bufLocalRel[base + 0] ** 2 +
        this.bufLocalRel[base + 1] ** 2 +
        this.bufLocalRel[base + 2] ** 2,
    );
    const phi = phaseFactorFor(dvx, dvy, dvz, dhx, dhy, dhz, planet.phaseCoefficients);
    const radiusPc = planet.radiusKm * KM_PC;
    const appMag = planetApparentMagnitude(
      host.hostAbsmag,
      dVh,
      dVp,
      dHp,
      planet.albedo,
      radiusPc,
      phi,
    );
    return { appMag, planetX, planetY, planetZ, dVp };
  }

  /** Read-only handle to the PlanetSystem the field has cached for a
   *  given host, or null if the host isn't attached. The hover formatter
   *  uses this to look up `planets[]` for the winning host without
   *  forcing the engine / Stellata to re-resolve via async
   *  `getPlanetSystem`. */
  getAttachedPlanetSystem(hostStarIdx: number): PlanetSystem | null {
    const host = this.hosts.get(hostStarIdx);
    return host ? host.ps : null;
  }

  /**
   * Hover-engine pick path for the planet layer (stellata-lo5.4). Walks
   * EVERY attached host's planets — the rule per
   * [[stellata-lo5-hover-conventions]] is "visibility ⇒ hoverable", so
   * focus state plays no part in the gate. v1 only attaches Sol, so the
   * loop has one host to traverse; bk5 will iterate any registered
   * exoplanet host that has live `iLocalRel` data.
   *
   * Each candidate projects to screen, classifies prime (cursor inside
   * the rendered disc) vs fallback (cursor near the projected centre
   * within `pxThreshold`), and is reduced by the closest-cursor scorer.
   * The winner's `hostStarIdx` rides in the returned `HoverHit` so the
   * formatter can resolve `(hostStarIdx, planetIdx)` back to a Planet
   * record without re-walking the hosts.
   *
   * Disc sizing mirrors the planet vertex shader's
   * `pxSize = max(appSize, physSize)` exactly via the shared
   * perceptual + angular-diameter helpers. Planets whose appMag exceeds
   * `maxAppMag + 0.5` (the shader's soft-taper kill condition) are
   * skipped — the GPU emits no quad, so hover can't pick what isn't
   * drawn.
   */
  pick(
    camera: THREE.PerspectiveCamera,
    rect: DOMRect,
    clientX: number,
    clientY: number,
    pxThreshold: number,
  ): HoverHit | null {
    if (this.hosts.size === 0) return null;
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;
    const viewportW = rect.width;
    const viewportH = rect.height;
    const fovYRad = (camera.fov * Math.PI) / 180;
    const maxAppMag = this.magShared.uMaxAppMag.value;
    const sizeMin = this.magShared.uSizeMin.value;
    const sizeMax = this.magShared.uSizeMax.value;
    const sizeSpan = this.magShared.uSizeSpan.value;
    const sizeKnee = this.magShared.uSizeKnee.value;
    const camPos = camera.position;

    // Walk every host × planet and collect candidates that qualify for
    // either tier. Cross-host reduction is delegated to the shared
    // `pickFromCandidates` (closest-cursor wins within tier, prime
    // beats fallback) — same reducer the star and Local Group pickers
    // use, so the cross-layer disambiguator above sees consistent tier
    // semantics from every layer. The candidate carries its
    // `hostStarIdx` + `cameraDistancePc` straight through to the
    // returned HoverHit; no post-reduce re-projection.
    const candidates: CrossHostCandidate[] = [];
    const v = new THREE.Vector3();
    for (const host of this.hosts.values()) {
      for (let i = 0; i < host.count; i++) {
        const { appMag, planetX, planetY, planetZ, dVp } =
          this.evalPlanetView(host, i, camPos);
        if (dVp <= 0) continue;
        // Same kill condition as the planet vertex shader's soft-taper
        // discard: if the planet is more than half a mag below the
        // slider cutoff, the GPU emits no quad and the hover can't
        // pick what isn't drawn.
        if (appMag > maxAppMag + 0.5) continue;

        v.set(planetX, planetY, planetZ).project(camera);
        if (v.z < -1 || v.z > 1) continue;
        const screenX = (v.x + 1) * 0.5 * viewportW;
        const screenY = (1 - v.y) * 0.5 * viewportH;
        const pxDist = Math.hypot(cursorX - screenX, cursorY - screenY);

        const radiusPc = host.ps.planets[i].radiusKm * KM_PC;
        const physSize = physSizePx(radiusPc, dVp, viewportH, fovYRad);
        const dMEff = perceptualDmEff(appMag, maxAppMag, sizeSpan, sizeKnee);
        const appSize = perceptualAppSizePx(dMEff, sizeMin, sizeMax, sizeSpan);
        const pxSize = Math.max(appSize, physSize);
        const hitRadius = Math.max(pxSize * 0.5, MIN_DISC_HIT_RADIUS_PX);

        if (pxDist > hitRadius && pxDist > pxThreshold) continue;
        candidates.push({
          idx: i,
          pxDist,
          hitRadius,
          hostStarIdx: host.hostStarIdx,
          cameraDistancePc: dVp,
        });
      }
    }

    const winner = pickFromCandidates(candidates, pxThreshold);
    if (winner === null) return null;
    return {
      idx: winner.candidate.idx,
      hostStarIdx: winner.candidate.hostStarIdx,
      cameraDistancePc: winner.candidate.cameraDistancePc,
      tier: winner.tier,
    };
  }

  setMonochrome(on: boolean): void {
    this.mono = on;
    if (on) this.group.visible = false;
    else this.group.visible = !this.hidden && this.liveCount > 0;
  }

  setHidden(on: boolean): void {
    this.hidden = on;
    if (on) this.group.visible = false;
    else this.group.visible = !this.mono && this.liveCount > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.matDisc.dispose();
    this.matGlow.dispose();
    this.matCore.dispose();
    this.matCorrupt.dispose();
    this.matRestore.dispose();
  }

  // ── private ─────────────────────────────────────────────────────────

  private allocateBuffers(capacity: number): void {
    this.bufLocalRel = new Float32Array(capacity * 3);
    this.bufHostLocalPos = new Float32Array(capacity * 3);
    this.bufRadius = new Float32Array(capacity);
    this.bufColour = new Float32Array(capacity * 3);
    this.bufSolidity = new Float32Array(capacity);
    this.bufAlbedo = new Float32Array(capacity);
    this.bufHostAbsmag = new Float32Array(capacity);
    this.bufPhaseA = new Float32Array(capacity * 4);
    this.bufPhaseB = new Float32Array(capacity * 4);
  }

  private growCapacity(): void {
    const newCap = this.capacity * 2;
    const oldLocalRel = this.bufLocalRel;
    const oldHostLocal = this.bufHostLocalPos;
    const oldRadius = this.bufRadius;
    const oldColour = this.bufColour;
    const oldSolidity = this.bufSolidity;
    const oldAlbedo = this.bufAlbedo;
    const oldAbsmag = this.bufHostAbsmag;
    const oldPhaseA = this.bufPhaseA;
    const oldPhaseB = this.bufPhaseB;
    this.allocateBuffers(newCap);
    this.bufLocalRel.set(oldLocalRel);
    this.bufHostLocalPos.set(oldHostLocal);
    this.bufRadius.set(oldRadius);
    this.bufColour.set(oldColour);
    this.bufSolidity.set(oldSolidity);
    this.bufAlbedo.set(oldAlbedo);
    this.bufHostAbsmag.set(oldAbsmag);
    this.bufPhaseA.set(oldPhaseA);
    this.bufPhaseB.set(oldPhaseB);
    this.capacity = newCap;
    // Replace the geometry with a fresh one over the new buffers.
    // Materials and meshes are re-bound via three.js's normal
    // geometry-swap path.
    const old = this.geometry;
    this.buildGeometry();
    this.meshDisc.geometry = this.geometry;
    this.meshGlow.geometry = this.geometry;
    this.meshCore.geometry = this.geometry;
    this.meshCorrupt.geometry = this.geometry;
    this.meshRestore.geometry = this.geometry;
    old.dispose();
  }

  private buildGeometry(): void {
    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute(
      'aCorner',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
        2,
      ),
    );
    geom.setIndex([0, 1, 2, 1, 3, 2]);
    geom.setAttribute('iLocalRel', new THREE.InstancedBufferAttribute(this.bufLocalRel, 3));
    geom.setAttribute('iHostLocalPos', new THREE.InstancedBufferAttribute(this.bufHostLocalPos, 3));
    geom.setAttribute('iRadiusPc', new THREE.InstancedBufferAttribute(this.bufRadius, 1));
    geom.setAttribute('iColour', new THREE.InstancedBufferAttribute(this.bufColour, 3));
    geom.setAttribute('iSolidity', new THREE.InstancedBufferAttribute(this.bufSolidity, 1));
    geom.setAttribute('iAlbedoP', new THREE.InstancedBufferAttribute(this.bufAlbedo, 1));
    geom.setAttribute('iHostAbsmag', new THREE.InstancedBufferAttribute(this.bufHostAbsmag, 1));
    geom.setAttribute('iPhaseCoefsA', new THREE.InstancedBufferAttribute(this.bufPhaseA, 4));
    geom.setAttribute('iPhaseCoefsB', new THREE.InstancedBufferAttribute(this.bufPhaseB, 4));
    geom.instanceCount = this.liveCount;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geom;
  }

  private buildMaterials(sm: PlanetMaterialUniforms): void {
    const sharedPlanetUniforms = {
      uMaxAppMag: sm.uMaxAppMag,
      uSizeMin: sm.uSizeMin,
      uSizeMax: sm.uSizeMax,
      uSizeSpan: sm.uSizeSpan,
      uSizeKnee: sm.uSizeKnee,
      uVisibleThreshold: sm.uVisibleThreshold,
      uVisibleK: sm.uVisibleK,
      uCoreThreshold: sm.uCoreThreshold,
      uDiscardThreshold: sm.uDiscardThreshold,
      uDistNMin: sm.uDistNMin,
      uDistNMax: sm.uDistNMax,
      uLumBiasMin: sm.uLumBiasMin,
      uLumBiasMax: sm.uLumBiasMax,
      uViewport: sm.uViewport,
      uPixelRatio: sm.uPixelRatio,
      uFovYRad: sm.uFovYRad,
    };

    const makeMat = (mode: number, params: THREE.ShaderMaterialParameters) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: planetVert,
        fragmentShader: planetFrag,
        uniforms: { ...sharedPlanetUniforms, uRenderMode: { value: mode } },
        ...params,
      });

    this.matDisc = makeMat(1, { transparent: true });
    applyDiscBlendDefaults(this.matDisc);

    this.matGlow = makeMat(0, {
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.matCore = makeMat(2, {
      depthWrite: true,
      depthTest: true,
      colorWrite: false,
    });

    // transparent: true on corrupt + restore puts them in the
    // transparent queue so their renderOrder (1.5, 2.5) is honoured
    // relative to the orbit-rings layer (2) — opaque always draws
    // before transparent.
    this.matCorrupt = makeMat(3, {
      transparent: true,
      depthWrite: true,
      depthTest: true,
      colorWrite: false,
    });

    // depthFunc: AlwaysDepth so the restore can overwrite the 0.0 the
    // corrupt pass wrote (default LessEqual would reject planet_z > 0).
    this.matRestore = makeMat(4, {
      transparent: true,
      depthWrite: true,
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      colorWrite: false,
    });

    const makeMesh = (mat: THREE.ShaderMaterial, name: string, order: number) => {
      const m = new THREE.Mesh(this.geometry, mat);
      m.name = name;
      m.frustumCulled = false;
      m.renderOrder = order;
      return m;
    };

    this.meshCore = makeMesh(this.matCore, 'core', -4);
    this.meshCorrupt = makeMesh(this.matCorrupt, 'corrupt', 1.5);
    this.meshRestore = makeMesh(this.matRestore, 'restore', 2.5);
    this.meshDisc = makeMesh(this.matDisc, 'disc', 3);
    this.meshGlow = makeMesh(this.matGlow, 'glow', 4);

    this.group.add(this.meshCore);
    this.group.add(this.meshCorrupt);
    this.group.add(this.meshRestore);
    this.group.add(this.meshDisc);
    this.group.add(this.meshGlow);
  }

  /** One-shot fill of static per-instance attributes (radius, colour,
   *  solidity, albedo, host absmag, phase coefficients) for a
   *  freshly-attached host. */
  private writeHostStaticAttributes(host: AttachedHost): void {
    const baseScalar = host.startInstance;
    const baseVec3 = host.startInstance * 3;
    const baseVec4 = host.startInstance * 4;
    for (let i = 0; i < host.count; i++) {
      const planet = host.ps.planets[i];
      this.bufRadius[baseScalar + i] = planet.radiusKm * KM_PC;
      this.bufColour[baseVec3 + i * 3 + 0] = planet.colour[0];
      this.bufColour[baseVec3 + i * 3 + 1] = planet.colour[1];
      this.bufColour[baseVec3 + i * 3 + 2] = planet.colour[2];
      this.bufSolidity[baseScalar + i] = solidityForType(planet.type);
      this.bufAlbedo[baseScalar + i] = planet.albedo;
      this.bufHostAbsmag[baseScalar + i] = host.hostAbsmag;
      // Phase coefficients packed (c0,c1,c2,c3) | (c4,c5,c6,alphaMaxDeg).
      // Bodies without published curves write all zeros — alphaMaxDeg=0
      // is the shader's "use Lambertian" sentinel.
      // `bufPhaseA` and `bufPhaseB` are separate Float32Arrays with the
      // same vec4-shaped layout, so a single per-slot offset feeds both.
      const pc = planet.phaseCoefficients;
      const phaseOff = baseVec4 + i * 4;
      this.bufPhaseA[phaseOff + 0] = pc ? pc.c0 : 0;
      this.bufPhaseA[phaseOff + 1] = pc ? pc.c1 : 0;
      this.bufPhaseA[phaseOff + 2] = pc ? pc.c2 : 0;
      this.bufPhaseA[phaseOff + 3] = pc ? pc.c3 : 0;
      this.bufPhaseB[phaseOff + 0] = pc ? pc.c4 : 0;
      this.bufPhaseB[phaseOff + 1] = pc ? pc.c5 : 0;
      this.bufPhaseB[phaseOff + 2] = pc ? pc.c6 : 0;
      this.bufPhaseB[phaseOff + 3] = pc ? pc.alphaMaxDeg : 0;
    }
    this.writeHostLocalPos(host);
  }

  /** Write the host's renderer-local position into the iHostLocalPos
   *  slots of all of its planet instances. */
  private writeHostLocalPos(host: AttachedHost): void {
    const base = host.startInstance * 3;
    const x = host.hostLocalPos.x;
    const y = host.hostLocalPos.y;
    const z = host.hostLocalPos.z;
    for (let i = 0; i < host.count; i++) {
      this.bufHostLocalPos[base + i * 3 + 0] = x;
      this.bufHostLocalPos[base + i * 3 + 1] = y;
      this.bufHostLocalPos[base + i * 3 + 2] = z;
    }
  }

  /** Resolve planet positions at time `t` and write them to the
   *  host's iLocalRel slots. Uses the host's positionsAt resolver
   *  when present (Sol via JPL Standish), else the placeholder
   *  eccentric-anomaly layout. */
  private writeHostPositions(host: AttachedHost, t: number): void {
    const base = host.startInstance * 3;
    if (host.positionsAt && host.positionsScratch) {
      host.positionsAt(t, host.positionsScratch);
      this.rotateInto(
        host.positionsScratch,
        this.bufLocalRel,
        base,
        host.orientation,
      );
    } else {
      const tmp = this.rotateTmp;
      for (let i = 0; i < host.count; i++) {
        const p = host.ps.planets[i];
        const ea = placeholderEccentricAnomaly(i, host.count);
        planetLocalPosition(p.semiMajorAxisAu, p.eccentricity, ea, host.orientation, tmp);
        this.bufLocalRel[base + i * 3 + 0] = tmp.x;
        this.bufLocalRel[base + i * 3 + 1] = tmp.y;
        this.bufLocalRel[base + i * 3 + 2] = tmp.z;
      }
    }
  }

  /** Rotate a flat plane-frame xyz buffer into ICRS-aligned local frame
   *  and write it at `dstStart` in `dst`. */
  private rotateInto(
    src: Float32Array,
    dst: Float32Array,
    dstStart: number,
    orientation: THREE.Quaternion,
  ): void {
    const tmp = this.rotateTmp;
    const n = src.length;
    for (let i = 0; i < n; i += 3) {
      tmp.set(src[i], src[i + 1], src[i + 2]);
      tmp.applyQuaternion(orientation);
      dst[dstStart + i + 0] = tmp.x;
      dst[dstStart + i + 1] = tmp.y;
      dst[dstStart + i + 2] = tmp.z;
    }
  }

  /** Mark all instance attributes dirty so three.js uploads them on
   *  the next render. Called after any buffer mutation that affects
   *  the visible region. */
  private flushAttributeRange(_start: number, _count: number): void {
    if (!this.geometry) return;
    // three.js doesn't currently support partial-range InstancedBuffer
    // updates without `updateRanges`; full-buffer dirty is the
    // pragmatic path. At Sol-only scale this is a 7-attr × 9-instance
    // upload — fast. bk5 may need range-based updates.
    const attrs = this.geometry.attributes;
    (attrs.iLocalRel as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iHostLocalPos as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iRadiusPc as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iColour as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iSolidity as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iAlbedoP as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iHostAbsmag as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iPhaseCoefsA as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iPhaseCoefsB as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  private flushAllAttributes(): void {
    this.flushAttributeRange(0, this.liveCount);
  }

  /** Compact-down step used by detachHost(). Shifts a contiguous tail
   *  range backwards by `gap` slots in every per-instance buffer. */
  private shiftInstancesDown(tailStart: number, tailCount: number, gap: number): void {
    const shiftScalar = (buf: Float32Array, dim: number) => {
      const tailBase = tailStart * dim;
      const tailEnd = tailBase + tailCount * dim;
      buf.copyWithin(tailBase - gap * dim, tailBase, tailEnd);
    };
    shiftScalar(this.bufLocalRel, 3);
    shiftScalar(this.bufHostLocalPos, 3);
    shiftScalar(this.bufRadius, 1);
    shiftScalar(this.bufColour, 3);
    shiftScalar(this.bufSolidity, 1);
    shiftScalar(this.bufAlbedo, 1);
    shiftScalar(this.bufHostAbsmag, 1);
    shiftScalar(this.bufPhaseA, 4);
    shiftScalar(this.bufPhaseB, 4);
  }
}
