// Per-planet orbit-rings layer (stellata-3re.7).
//
// Renders the focused host star's planet system as a set of Keplerian
// ellipses, with the host at one focus and each ring oriented through
// the per-host orbital-plane rule (Sol = ecliptic; everything else =
// galactic plane, per stellata-3re.8). One pixel-gap visibility
// heuristic suppresses inner rings when they pile up at far framings.
//
// Sol is the only host with planet data populated in v1, but the layer
// is intentionally host-agnostic: stellata-bk5 will plug exoplanet
// systems through the same Stellata.onPlanetSystemChange event without
// requiring any change in this file. The orbital plane normal is
// resolved per-host via orbitalPlaneNormalFor().
//
// Sibling Sol-only decorations (heliopause shell, etc.) live in their
// own layers; this file stays generic so it works for any planet-
// bearing host.
//
// # Body rendering split
//
// Planet bodies do NOT live here — they're physical objects, rendered
// by the global PlanetBodyField regardless of which host the camera
// is focused on, gated only by per-planet apparent-magnitude (3re.16)
// and per-host distance cull. The orbit rings, by contrast, are a
// representational layer: they only render when their host is
// focused (stellata-3re.15 / unfocus-split rule).

import * as THREE from 'three';
import type { PlanetSystem, Planet, PlanetType } from './planet-system';
import { AU_PC, type OrbitOrientationRad } from './ephemeris';
import { GALACTIC_NORTH_POLE_ICRS } from './galactic-coords';

// Re-export AU_PC for tests + downstream callers that already imported
// it from this module. Canonical definition lives in ephemeris.ts.
export { AU_PC };

// 1 km expressed in parsecs (= AU_PC / 1.495978707e8 km/AU).
// Used to convert per-planet equatorial radii (km) into the parsec
// scale the rest of the renderer works in. Consumed by PlanetBodyField.
export const KM_PC = AU_PC / 1.495978707e8;

// J2000 obliquity of the ecliptic (IAU). Sol's orbital plane is tilted
// from the ICRS equatorial plane by this angle around the +X (vernal
// equinox) direction.
const J2000_OBLIQUITY_RAD = (23.4392911 * Math.PI) / 180;

/**
 * North ecliptic pole expressed in ICRS — the normal to Sol's orbital
 * plane. Per stellata-3re.8: `(0, sinε, cosε)`. Consumers receive a
 * cloned vector (the exported one is shared) — never mutate this in
 * place.
 */
export const ECLIPTIC_NORTH_POLE_ICRS = new THREE.Vector3(
  0,
  Math.sin(J2000_OBLIQUITY_RAD),
  Math.cos(J2000_OBLIQUITY_RAD),
);

// Visibility heuristic: ring i renders only when the on-screen pixel gap
// to both of its neighbours exceeds this threshold. Tuned at 6 px to
// suppress the inner-rocky-pile-up at far framings (camera at hundreds
// of AU staring back at the inner solar system) and let the inner rings
// re-emerge as the camera approaches sub-AU range.
export const RING_VISIBILITY_THRESHOLD_PX = 6;

// Number of vertices per ring. 128 is enough to keep even Mercury's
// ellipse smooth at maximum zoom (sub-AU focal range), while staying
// trivial for 8 hosts × N planets at GPU rates.
const RING_SEGMENTS = 128;

// Material colour and opacity. Cool blue-white at moderate alpha contrasts
// against the warm-amber galactic disc and the additive Milky Way disc
// without competing with point-source stars. Held alpha-blended (not
// additive) so rings read as faint *lines*, not glow.
const RING_COLOUR = 0x88aacc;
const RING_OPACITY = 0.5;

interface PlanetRing {
  readonly planet: Planet;
  readonly line: THREE.LineLoop;
  readonly material: THREE.LineBasicMaterial;
  // Cached for the visibility heuristic. The on-screen extent of an
  // elliptical orbit is bounded by the semi-major axis at every viewing
  // angle, so we use it as the per-ring "characteristic size" the
  // pixel-gap test compares.
  readonly semiMajorPc: number;
}

/**
 * Resolve the orbital plane normal for a host star. Sol's planets ride
 * the ecliptic (J2000 obliquity tilt against ICRS); every other host
 * defaults to the galactic plane (per stellata-3re.8).
 *
 * `solIndex` is passed in rather than reading the catalog so this function
 * stays pure — easy to test, reusable from any layer that needs the
 * same per-host plane decision.
 */
export function orbitalPlaneNormalFor(
  hostStarIdx: number,
  solIndex: number,
): THREE.Vector3 {
  if (hostStarIdx === solIndex) return ECLIPTIC_NORTH_POLE_ICRS.clone();
  return GALACTIC_NORTH_POLE_ICRS.clone();
}

/**
 * Compute the visibility flags for a sequence of rings ordered by
 * increasing pixel radius. Pure function — extracted so the heuristic
 * can be unit-tested independently of three.js scene state.
 *
 * Ring i renders when its pixel-radius gap to both neighbours exceeds
 * `thresholdPx`. The innermost and outermost rings only have one
 * neighbour each; their single gap must exceed the threshold.
 */
export function ringVisibility(
  pixelRadii: readonly number[],
  thresholdPx: number,
): boolean[] {
  const out: boolean[] = new Array(pixelRadii.length).fill(false);
  for (let i = 0; i < pixelRadii.length; i++) {
    const gapPrev = i > 0 ? pixelRadii[i] - pixelRadii[i - 1] : Infinity;
    const gapNext = i < pixelRadii.length - 1 ? pixelRadii[i + 1] - pixelRadii[i] : Infinity;
    out[i] = Math.min(gapPrev, gapNext) > thresholdPx;
  }
  return out;
}

/**
 * Build the vertices of one Keplerian ellipse with the host star at one
 * focus and the perihelion along local +x. Pure / scene-agnostic so the
 * geometry can be unit-tested on the CPU.
 *
 * - `aPc` — semi-major axis in parsecs.
 * - `e`  — orbital eccentricity, in [0, 1).
 * - `segments` — number of points around the loop.
 * - `out` — float32 buffer of length `segments * 3` (xyz triples). The
 *   ellipse is laid out in the local xy plane (z = 0); the caller
 *   rotates it into the host's orbital plane afterwards.
 */
export function buildEllipsePoints(
  aPc: number,
  e: number,
  segments: number,
  out: Float32Array,
): void {
  const b = aPc * Math.sqrt(1 - e * e);
  const c = aPc * e;
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    out[i * 3 + 0] = aPc * Math.cos(t) - c;
    out[i * 3 + 1] = b * Math.sin(t);
    out[i * 3 + 2] = 0;
  }
}

/**
 * Placeholder eccentric anomaly for the i-th planet of an N-planet
 * system. Spreads bodies evenly around their respective orbits so all
 * N don't pile up at perihelion (+x). Used by PlanetBodyField as the
 * fallback when a host's PlanetSystem doesn't supply a positionsAt
 * resolver. Deterministic — re-running with the same i and N produces
 * the same angle.
 */
export function placeholderEccentricAnomaly(i: number, n: number): number {
  if (n <= 0) return 0;
  return (i / n) * Math.PI * 2;
}

/**
 * Local-frame position of a planet at a given eccentric anomaly.
 * Pure helper used by the placeholder fallback path in PlanetBodyField.
 *
 * `out` is mutated and returned for convenience.
 */
export function planetLocalPosition(
  semiMajorAxisAu: number,
  eccentricity: number,
  eccentricAnomaly: number,
  orientation: THREE.Quaternion,
  out: THREE.Vector3,
): THREE.Vector3 {
  const a = semiMajorAxisAu * AU_PC;
  const b = a * Math.sqrt(1 - eccentricity * eccentricity);
  const c = a * eccentricity;
  out.set(
    a * Math.cos(eccentricAnomaly) - c,
    b * Math.sin(eccentricAnomaly),
    0,
  );
  out.applyQuaternion(orientation);
  return out;
}

/**
 * Map a planet type to a shader solidity factor. Consumed by
 * PlanetBodyField as a per-instance attribute; the planet fragment
 * shader interpolates the inner-edge fade window between gas-giant
 * softness and rocky sharpness on this value.
 */
export function solidityForType(type: PlanetType): number {
  switch (type) {
    case 'rocky': return 1.0;
    case 'ice_giant': return 0.4;
    case 'gas_giant': return 0.0;
  }
}

const COMPOSE_ORBIT_Z = new THREE.Vector3(0, 0, 1);
const COMPOSE_ORBIT_X = new THREE.Vector3(1, 0, 0);
const _composeQNode = new THREE.Quaternion();
const _composeQIncl = new THREE.Quaternion();
const _composeQPeri = new THREE.Quaternion();

/**
 * Compose `Rz(Ω)·Rx(I)·Rz(ω)` — the standard orbital-frame → host-plane
 * rotation — into `out`. Same composition `ephemeris.planetEclipticAU`
 * applies to in-plane (x', y') scalars; lifted here so ring vertices
 * (in `setPlanetSystem`) and PlanetBodyField's body positions share one
 * implementation. Returns `out` for convenience.
 */
export function composeOrbitOrientationQuat(
  oi: OrbitOrientationRad,
  out: THREE.Quaternion,
): THREE.Quaternion {
  _composeQNode.setFromAxisAngle(COMPOSE_ORBIT_Z, oi.longAscNode);
  _composeQIncl.setFromAxisAngle(COMPOSE_ORBIT_X, oi.inclination);
  _composeQPeri.setFromAxisAngle(COMPOSE_ORBIT_Z, oi.argPerihelion);
  return out.copy(_composeQNode).multiply(_composeQIncl).multiply(_composeQPeri);
}

export class OrbitRingsLayer {
  readonly group: THREE.Group;
  private rings: PlanetRing[] = [];
  private mono = false;
  private hidden = false;

  constructor() {
    this.group = new THREE.Group();
    // renderOrder = 2: between the planet outer-disc occluder (1.5)
    // and the planet disc/glow passes (3, 4). See docs/rendering.md
    // §RenderOrder ladder for the full cross-layer hierarchy.
    this.group.renderOrder = 2;
    this.group.visible = false;
  }

  /**
   * Replace the active planet system. Pass null to tear the rings down
   * (e.g. when focus clears or moves to a host without planets).
   * Geometry and materials are disposed eagerly — Three.js doesn't
   * reclaim them otherwise.
   */
  setPlanetSystem(ps: PlanetSystem | null, solIndex: number): void {
    this.disposeRings();
    if (ps === null || ps.planets.length === 0) {
      this.group.visible = false;
      return;
    }

    const planeNormal = orbitalPlaneNormalFor(ps.hostStarIdx, solIndex);
    const orientation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      planeNormal,
    );

    const ringQuat = new THREE.Quaternion();
    const planeQuat = new THREE.Quaternion();
    for (let pIdx = 0; pIdx < ps.planets.length; pIdx++) {
      const planet = ps.planets[pIdx];
      const aPc = planet.semiMajorAxisAu * AU_PC;
      const verts = new Float32Array(RING_SEGMENTS * 3);
      buildEllipsePoints(aPc, planet.eccentricity, RING_SEGMENTS, verts);
      // Compose per-planet in-plane→host-plane rotation Rz(Ω)·Rx(I)·Rz(ω)
      // (matching the body-position math in ephemeris.planetEclipticAU)
      // with the host plane→ICRS orientation, so a single applyQuaternion
      // takes a local-xy ellipse vertex straight to ICRS-aligned local
      // space. Without the per-planet step, rings sit flat on the host
      // plane with perihelion at +x — wrong for any non-zero I or ϖ.
      ringQuat.copy(orientation);
      const o = ps.orbitOrientations?.[pIdx];
      if (o) {
        ringQuat.multiply(composeOrbitOrientationQuat(o, planeQuat));
      }
      const tmp = new THREE.Vector3();
      for (let i = 0; i < RING_SEGMENTS; i++) {
        tmp.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
        tmp.applyQuaternion(ringQuat);
        verts[i * 3 + 0] = tmp.x;
        verts[i * 3 + 1] = tmp.y;
        verts[i * 3 + 2] = tmp.z;
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      const mat = new THREE.LineBasicMaterial({
        color: RING_COLOUR,
        transparent: true,
        opacity: RING_OPACITY,
        depthTest: true,
        depthWrite: false,
      });
      const line = new THREE.LineLoop(geom, mat);
      // Frustum culling on a tiny sub-AU loop with the camera potentially
      // sitting inside it is unreliable; we already gate visibility via
      // the pixel-gap heuristic, so let the GPU clip per-vertex.
      line.frustumCulled = false;
      line.renderOrder = this.group.renderOrder;
      this.group.add(line);
      this.rings.push({ planet, line, material: mat, semiMajorPc: aPc });
    }

    this.group.visible = !this.hidden && !this.mono;
  }

  /**
   * Per-frame visibility update. The host always sits at the local
   * origin under the floating-origin recenter from setFocus(idx) (see
   * stellata-3re.15 / unfocus-split: orbit rings only render when the
   * host is the focused star, by which point worldOffset = host's
   * absolute position).
   */
  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number): void {
    if (this.hidden || this.mono || this.rings.length === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const fovYRad = (camera.fov * Math.PI) / 180;
    const dPc = camera.position.length();
    const pxPerRad = viewportHeightPx / fovYRad;
    const radii = this.rings.map(
      (r) => Math.atan(r.semiMajorPc / Math.max(dPc, 1e-30)) * pxPerRad,
    );
    const visible = ringVisibility(radii, RING_VISIBILITY_THRESHOLD_PX);
    for (let i = 0; i < this.rings.length; i++) {
      this.rings[i].line.visible = visible[i];
    }
  }

  /**
   * True when at least one orbit ring is currently being rendered.
   * The focus ring overlay reads this each frame to suppress itself
   * when the orbit rings are already identifying the focused host.
   */
  anyOrbitRingVisible(): boolean {
    if (this.hidden || this.mono || !this.group.visible) return false;
    for (const r of this.rings) {
      if (r.line.visible) return true;
    }
    return false;
  }

  /**
   * True when the orbit ring for planet `i` is currently rendering. The
   * planet-labels overlay gates label visibility on this per-planet flag
   * so labels appear only when their associated ring does.
   *
   * Crucially: labels follow rings, NOT body apparent-magnitude. A
   * planet whose body is below the slider cutoff still shows a label
   * if its ring is up — labels answer "what would I be seeing here,"
   * not "what am I currently rendering."
   */
  isOrbitRingVisible(i: number): boolean {
    if (this.hidden || this.mono || !this.group.visible) return false;
    if (i < 0 || i >= this.rings.length) return false;
    return this.rings[i].line.visible;
  }

  /**
   * Suppress the layer entirely (used during warp transitions, where
   * orbit-ring context is exactly the kind of detail the warp blur
   * intentionally drops).
   */
  setHidden(on: boolean): void {
    this.hidden = on;
    if (on) this.group.visible = false;
  }

  /**
   * Chart (mono / paper) mode hides the rings — flat hard-edged orbital
   * ellipses are a chart-mode rendering decision tracked in
   * stellata-m40.3, not this generic layer.
   */
  setMonochrome(on: boolean): void {
    this.mono = on;
    if (on) this.group.visible = false;
  }

  dispose(): void {
    this.disposeRings();
  }

  private disposeRings(): void {
    for (const r of this.rings) {
      this.group.remove(r.line);
      r.line.geometry.dispose();
      r.material.dispose();
    }
    this.rings = [];
  }
}
