import * as THREE from 'three';

// J2000 ICRS coordinates of the galactic-frame axes:
//  - Galactic Centre (l=0, b=0): RA=266.4051°, Dec=−28.93617°
//  - North Galactic Pole (b=+90°): RA=192.85948°, Dec=27.12825°
// Values from the IAU/Hipparcos definition of the J2000 galactic frame.
const ALPHA_GC = (266.4051 * Math.PI) / 180;
const DELTA_GC = (-28.93617 * Math.PI) / 180;
const ALPHA_NGP = (192.85948 * Math.PI) / 180;
const DELTA_NGP = (27.12825 * Math.PI) / 180;

// Distance from Sol to the galactic centre. R₀ = 8.122 kpc per GRAVITY 2018,
// adopted here so Phase 5's planned analytic background can reuse this
// constant directly without a second source of truth.
export const R0_PC = 8122.0;

const gcDir = new THREE.Vector3(
  Math.cos(DELTA_GC) * Math.cos(ALPHA_GC),
  Math.cos(DELTA_GC) * Math.sin(ALPHA_GC),
  Math.sin(DELTA_GC),
).normalize();

const ngpDir = new THREE.Vector3(
  Math.cos(DELTA_NGP) * Math.cos(ALPHA_NGP),
  Math.cos(DELTA_NGP) * Math.sin(ALPHA_NGP),
  Math.sin(DELTA_NGP),
).normalize();

// Build a strictly-orthonormal galactic-frame basis in ICRS:
//   +X = toward galactic centre (l=0, b=0)
//   +Z = toward NGP (b=+90)
//   +Y = +Z × +X  (l=90, b=0; standard right-handed convention)
// gcDir and ngpDir are not exactly perpendicular at full precision, so Z is
// re-derived from (X × Y) to land exactly orthogonal to both.
const galY = new THREE.Vector3().crossVectors(ngpDir, gcDir).normalize();
const galZ = new THREE.Vector3().crossVectors(gcDir, galY).normalize();

/**
 * Galactic-frame Cartesian → ICRS Cartesian rotation. Apply to a galactic
 * vector (in the same units as the result) to get the equivalent ICRS vector.
 * Origin is unchanged — translation to Sol-centric absolute coordinates is
 * the caller's job (see GALACTIC_CENTRE_PC).
 */
export const GAL_TO_ICRS: THREE.Matrix4 =
  new THREE.Matrix4().makeBasis(gcDir, galY, galZ);

/**
 * Absolute ICRS position of the galactic centre, in parsecs. Sol sits at the
 * origin in our absolute frame, so this is simply gcDir × R₀. Use this as the
 * translation offset when placing galactic-frame geometry into the world.
 */
export const GALACTIC_CENTRE_PC: THREE.Vector3 =
  gcDir.clone().multiplyScalar(R0_PC);

/**
 * Unit vector toward the North Galactic Pole in ICRS coordinates — i.e. the
 * normal to the galactic plane. Re-orthogonalised against the GC direction
 * (= +X of the galactic basis), so it lies exactly perpendicular to the
 * adopted galactic-frame x-axis. Consumed by stellata-3re.8's "all
 * non-Sol hosts orbit in the galactic plane" rule.
 */
export const GALACTIC_NORTH_POLE_ICRS: THREE.Vector3 = galZ.clone();
