// Generic per-host star-system rendering layer (stellata-3re.7, .4).
//
// Renders the focused host star's planet system: per-planet orbital
// ellipse rings (3re.7) and the bodies themselves as billboarded
// quads (3re.4). The host is at the local origin under the
// floating-origin recenter from setFocus(idx), so all geometry sits
// in the local frame at (0,0,0) — no per-frame world-offset
// bookkeeping needed (unlike GalacticDisc, which lives in absolute
// space).
//
// Sol is the only host with planet data populated in v1, but the layer
// is intentionally host-agnostic: stellata-bk5 will plug exoplanet
// systems through the same Stellata.onPlanetSystemChange event without
// requiring any change in this file. The orbital plane normal is
// resolved per-host via orbitalPlaneNormalFor() — Sol's ecliptic vs
// every other host's galactic plane (stellata-3re.8).
//
// Body positions in v1 are placeholders — each planet sits on its
// own orbit ring at an evenly-spaced eccentric anomaly so eight
// bodies don't pile up on the +x axis. Real time-varying positions
// land with stellata-3re.3 (VSOP87 ephemerides via astronomia).
//
// Sibling Sol-only decorations (heliopause shell, 1 AU/50 AU scale
// rings — stellata-3re.5) live in their own layers; this file stays
// generic so it works for any planet-bearing host.

import * as THREE from 'three';
import type { PlanetSystem, Planet, PlanetType } from './planet-system';
import { GALACTIC_NORTH_POLE_ICRS } from './galactic-coords';
import planetVert from './shaders/planet.vert.glsl?raw';
import planetFrag from './shaders/planet.frag.glsl?raw';

// 1 AU expressed in parsecs.
// Source: IAU 2012 — 1 pc / 648000 / π ≈ 4.8481368e-6 pc/AU.
export const AU_PC = 4.8481368e-6;

// 1 km expressed in parsecs (= AU_PC / 1.495978707e8 km/AU).
// Used to convert per-planet equatorial radii (km) into the parsec
// scale the rest of the renderer works in.
export const KM_PC = AU_PC / 1.495978707e8;

// Pixel floor for the planet-disc shader, mirroring the star pipeline's
// appSize floor. Smaller than the star floor (which can be 2-24 px from
// the size slider) — planets are secondary visual content; we don't
// want a sub-pixel Mercury to bloom into a 6-px disc that competes
// with the bodies that genuinely deserve attention.
const PLANET_DISC_MIN_PX = 2.0;

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
// re-emerge as the camera approaches sub-AU range. Bead suggested 4–6 px;
// 6 favours a less-cluttered look without hiding genuinely separated
// rings.
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
  // EllipseCurve-style sweep: x = a·cos(t) − c, y = b·sin(t). At t=0 we
  // hit perihelion (a−c, 0) = (a(1−e), 0) on the local +x side.
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
 * eight don't pile up at perihelion (+x). Deterministic — re-running
 * with the same i and N produces the same angle, so labels and
 * future tests can rely on a stable layout. Replaced when stellata-3re.3
 * lands real VSOP87 mean anomalies.
 */
export function placeholderEccentricAnomaly(i: number, n: number): number {
  if (n <= 0) return 0;
  return (i / n) * Math.PI * 2;
}

/**
 * Local-frame position of a planet at a given eccentric anomaly.
 * Pure helper — used both by the body-instance builder and by the
 * planet-labels overlay so they read the same parametrisation. After
 * stellata-3re.3 this becomes the entry point for VSOP87 positions
 * (the orientation quaternion stays identical; only the in-plane
 * (x, y) computation changes).
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
 * Map a Sol-internal planet type to a shader solidity factor. The
 * fragment shader interpolates the inner-edge fade window between
 * fadeStart=0.5 (gas-giant softness) and fadeStart=0.95 (rocky-body
 * sharpness) on this value. Ice giants land between the two — a
 * rocky-ish core with thick gaseous mantle reads as slightly soft
 * but not as diffuse as Jupiter's banded silhouette.
 */
export function solidityForType(type: PlanetType): number {
  switch (type) {
    case 'rocky': return 1.0;
    case 'ice_giant': return 0.4;
    case 'gas_giant': return 0.0;
  }
}

export class StarSystem {
  readonly group: THREE.Group;
  private rings: PlanetRing[] = [];
  private mono = false;
  private hidden = false;
  // Planet body mesh — one InstancedBufferGeometry holding N quads, with
  // per-instance position / radius / colour / solidity. null whenever
  // no system is attached.
  private bodyMesh: THREE.Mesh | null = null;
  private bodyGeometry: THREE.InstancedBufferGeometry | null = null;
  private bodyMaterial: THREE.ShaderMaterial | null = null;
  // Exposed for overlays (planet-labels) so they can read planet
  // positions without re-running the placeholder math themselves.
  // Length = 3·planetCount; null when no system. Layout matches the
  // PlanetSystem.planets array ordering.
  private bodyLocalPositions: Float32Array | null = null;
  private currentPlanets: readonly Planet[] = [];
  // Per-frame ephemeris drives bodyLocalPositions for hosts whose
  // PlanetSystem provides positionsAt (Sol via JPL Standish in
  // stellata-3re.3). Below: orientation quaternion + scratch buffer
  // for the in-plane→ICRS rotation, plus the active resolver.
  private currentPositionsAt: ((t: number, out: Float32Array) => void) | null = null;
  private currentOrientation: THREE.Quaternion | null = null;
  private positionsScratch: Float32Array | null = null;
  // Reusable per-planet rotation scratch — avoids per-frame allocation.
  private rotateTmp = new THREE.Vector3();

  constructor() {
    this.group = new THREE.Group();
    // Rings sit below the bodies so a ring crossing in front of (or
    // behind) a planet doesn't paint over the body silhouette. Order:
    //   -1  galactic disc
    //    0  star discs
    //    1  star glow
    //    2  orbit rings (this layer's ring children)
    //    3  planet bodies (this layer's body mesh)
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
    this.disposeBody();
    this.bodyLocalPositions = null;
    this.currentPlanets = [];
    this.currentPositionsAt = null;
    this.currentOrientation = null;
    this.positionsScratch = null;
    if (ps === null || ps.planets.length === 0) {
      this.group.visible = false;
      return;
    }

    const planeNormal = orbitalPlaneNormalFor(ps.hostStarIdx, solIndex);
    const orientation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      planeNormal,
    );

    // Cache the planets list and host orientation so the labels overlay
    // (and any future consumer) can compute the same placeholder
    // positions through planetLocalPosition() without re-deriving the
    // orientation. Stored alongside the precomputed body positions.
    this.currentPlanets = ps.planets;
    this.currentOrientation = orientation;
    this.currentPositionsAt = ps.positionsAt ?? null;
    this.bodyLocalPositions = new Float32Array(ps.planets.length * 3);
    this.positionsScratch = ps.positionsAt
      ? new Float32Array(ps.planets.length * 3)
      : null;

    // Build orbit rings ----------------------------------------------------
    for (const planet of ps.planets) {
      const aPc = planet.semiMajorAxisAu * AU_PC;
      const verts = new Float32Array(RING_SEGMENTS * 3);
      buildEllipsePoints(aPc, planet.eccentricity, RING_SEGMENTS, verts);
      // Rotate every vertex from the local xy plane into the host's
      // orbital plane in one pass; no per-frame matrix work after this.
      const tmp = new THREE.Vector3();
      for (let i = 0; i < RING_SEGMENTS; i++) {
        tmp.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
        tmp.applyQuaternion(orientation);
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

    // Build planet bodies --------------------------------------------------
    // One quad per planet via InstancedBufferGeometry — same pattern as
    // the main star pipeline, scaled down to N=8. The vertex shader
    // expands the unit quad into a billboard sized by θ·viewportH/fov.
    const n = ps.planets.length;
    const positions = this.bodyLocalPositions;
    const radii = new Float32Array(n);
    const colours = new Float32Array(n * 3);
    const solidity = new Float32Array(n);
    // Initial position fill — ephemeris path if positionsAt present,
    // else the static placeholder eccentric-anomaly layout. The per-
    // frame update() below refreshes the ephemeris path each tick.
    if (ps.positionsAt && this.positionsScratch) {
      ps.positionsAt(Date.now() / 1000, this.positionsScratch);
      this.rotateInto(this.positionsScratch, positions, orientation);
    } else {
      const tmpPos = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const p = ps.planets[i];
        const t = placeholderEccentricAnomaly(i, n);
        planetLocalPosition(p.semiMajorAxisAu, p.eccentricity, t, orientation, tmpPos);
        positions[i * 3 + 0] = tmpPos.x;
        positions[i * 3 + 1] = tmpPos.y;
        positions[i * 3 + 2] = tmpPos.z;
      }
    }
    for (let i = 0; i < n; i++) {
      const p = ps.planets[i];
      radii[i] = p.radiusKm * KM_PC;
      colours[i * 3 + 0] = p.colour[0];
      colours[i * 3 + 1] = p.colour[1];
      colours[i * 3 + 2] = p.colour[2];
      solidity[i] = solidityForType(p.type);
    }

    const bodyGeom = new THREE.InstancedBufferGeometry();
    bodyGeom.setAttribute(
      'aCorner',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
        2,
      ),
    );
    bodyGeom.setIndex([0, 1, 2, 1, 3, 2]);
    bodyGeom.setAttribute('iPosition', new THREE.InstancedBufferAttribute(positions, 3));
    bodyGeom.setAttribute('iRadiusPc', new THREE.InstancedBufferAttribute(radii, 1));
    bodyGeom.setAttribute('iColour', new THREE.InstancedBufferAttribute(colours, 3));
    bodyGeom.setAttribute('iSolidity', new THREE.InstancedBufferAttribute(solidity, 1));
    bodyGeom.instanceCount = n;
    // Disable frustum culling — the camera can sit inside the bounding
    // sphere of the body cloud (e.g. between Jupiter and Saturn) where
    // three.js's auto-bounding gets the cull wrong. Per-fragment depth
    // and the disc fade-out handle the rest.
    bodyGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const bodyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: planetVert,
      fragmentShader: planetFrag,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uViewportH: { value: 1 },
        uFovYRad: { value: 1 },
        uMinPxSize: { value: PLANET_DISC_MIN_PX },
      },
    });

    const mesh = new THREE.Mesh(bodyGeom, bodyMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = this.group.renderOrder + 1;
    this.group.add(mesh);

    this.bodyGeometry = bodyGeom;
    this.bodyMaterial = bodyMat;
    this.bodyMesh = mesh;

    this.group.visible = !this.hidden && !this.mono;
  }

  /**
   * Per-frame visibility + position update.
   *
   * `hostLocalPos` (default origin) is the host star's position in the
   * renderer's local frame. Steady-focus rendering keeps the host at
   * (0,0,0) under the floating-origin recenter from setFocus(idx);
   * during a warp the focused host stays at the origin while the warp
   * *destination* sits at a non-zero offset from worldOffset, so the
   * destination's StarSystem instance receives the destination's
   * local position here. The pixel-gap visibility heuristic uses
   * camera-to-host distance, so it naturally adapts: source rings
   * collapse as the camera flies away, destination rings spread as
   * it approaches.
   */
  update(
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
    hostLocalPos?: THREE.Vector3,
    t?: number,
  ): void {
    if (this.hidden || this.mono || (this.rings.length === 0 && !this.bodyMesh)) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    if (hostLocalPos) {
      this.group.position.copy(hostLocalPos);
    } else {
      this.group.position.set(0, 0, 0);
    }

    // Refresh body positions from the host's ephemeris resolver, when
    // present. Sol's positionsAt dispatches through ephemeris.ts which
    // caches per minute-bucket of `t` — sub-minute calls return the
    // same object reference, so the per-frame work is an 8-element
    // array copy + 8 quaternion applications.
    if (
      this.currentPositionsAt &&
      this.positionsScratch &&
      this.bodyLocalPositions &&
      this.currentOrientation &&
      this.bodyGeometry
    ) {
      this.currentPositionsAt(t ?? Date.now() / 1000, this.positionsScratch);
      this.rotateInto(this.positionsScratch, this.bodyLocalPositions, this.currentOrientation);
      const iPosition = this.bodyGeometry.attributes.iPosition as THREE.InstancedBufferAttribute;
      iPosition.needsUpdate = true;
    }

    const fovYRad = (camera.fov * Math.PI) / 180;

    // Push viewport / FOV to the body shader once per frame. The shader
    // does the per-instance angular-diameter math itself; we just feed
    // it the screen-space rate (pxPerRad = viewportH / fovY).
    if (this.bodyMaterial) {
      this.bodyMaterial.uniforms.uViewportH.value = viewportHeightPx;
      this.bodyMaterial.uniforms.uFovYRad.value = fovYRad;
    }

    if (this.rings.length === 0) return;
    // Camera-to-host distance, not camera-to-origin: when the host sits
    // off the local origin (warp destination case) the heuristic still
    // reads the correct angular sizes.
    const dPc = hostLocalPos
      ? camera.position.distanceTo(hostLocalPos)
      : camera.position.length();
    // px = θ · viewportHeight / fov_y ; θ ≈ atan(a/d). atan keeps the
    // approximation honest for the close-flyby regime where a ≳ d.
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
   * True when at least one orbit ring is currently being rendered (i.e.
   * the layer is active and the visibility heuristic let some ring
   * through). The focus ring overlay reads this each frame to suppress
   * itself when the orbit rings are already identifying the focused
   * host — both indicators on the same star is redundant chrome.
   */
  anyRingVisible(): boolean {
    if (this.hidden || this.mono || !this.group.visible) return false;
    for (const r of this.rings) {
      if (r.line.visible) return true;
    }
    return false;
  }

  /**
   * True when the orbit ring for planet `i` is currently rendering. The
   * planet-labels overlay gates label visibility on this per-planet flag
   * so labels appear only when their associated ring does — a ring
   * suppressed by the pixel-gap heuristic at far framings would have
   * meant a label floating in space attached to a body too tiny to
   * read anyway. Bodies themselves stay rendered (they sit at the
   * pixel-size floor); only the labels track the rings.
   */
  isRingVisible(i: number): boolean {
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

  /**
   * Read access to the cached planet list and their local-frame
   * positions, for overlays (planet-labels, future hover/picking) that
   * need to project planets to screen space without re-running the
   * placeholder math. Returned `positions` is the live buffer — callers
   * must not mutate. Both `null` whenever no system is attached.
   */
  getPlanets(): readonly Planet[] {
    return this.currentPlanets;
  }

  getPlanetLocalPositions(): Float32Array | null {
    return this.bodyLocalPositions;
  }

  dispose(): void {
    this.disposeRings();
    this.disposeBody();
  }

  /** Apply the host's orbital-plane orientation to a flat xyz buffer.
   *  The ephemeris path emits positions in the host's local plane
   *  frame (xy planar, z perpendicular); this rotates them onto the
   *  ICRS-aligned plane normal that the renderer's local frame uses.
   *  Both buffers are float32 xyz triples of equal length. */
  private rotateInto(
    src: Float32Array,
    dst: Float32Array,
    orientation: THREE.Quaternion,
  ): void {
    const tmp = this.rotateTmp;
    for (let i = 0; i < src.length; i += 3) {
      tmp.set(src[i], src[i + 1], src[i + 2]);
      tmp.applyQuaternion(orientation);
      dst[i + 0] = tmp.x;
      dst[i + 1] = tmp.y;
      dst[i + 2] = tmp.z;
    }
  }

  private disposeRings(): void {
    for (const r of this.rings) {
      this.group.remove(r.line);
      r.line.geometry.dispose();
      r.material.dispose();
    }
    this.rings = [];
  }

  private disposeBody(): void {
    if (this.bodyMesh) this.group.remove(this.bodyMesh);
    this.bodyGeometry?.dispose();
    this.bodyMaterial?.dispose();
    this.bodyMesh = null;
    this.bodyGeometry = null;
    this.bodyMaterial = null;
  }
}
