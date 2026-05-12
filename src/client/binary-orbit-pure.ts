// Pure math for live binary-star orbital evolution (stellata-dch.9).
// TypeScript mirror of `scripts/build-binaries.py`'s
// `solve_kepler` / `orbit_to_sky_offset` / `sky_offset_to_icrs_xyz`.
//
// The runtime (`binary-orbit.ts`, dch.10) calls these per frame against
// `Stellata.getT()` to evolve ~896 catalog binary systems. The pure
// helpers in this file have no state; dch.10 owns any per-attach caching
// (notably the J2000 baseline offset that `evaluateBinaryOffset` would
// otherwise recompute every frame).
//
// Conventions follow ORB6 sky-plane angles:
//   - i  : inclination (rad). i=0 face-on, i=π/2 edge-on.
//   - ω  : argument of periastron (rad), sky-plane.
//   - Ω  : longitude of ascending node (rad), position angle east of
//          north.
// Thiele-Innes constants project the in-plane orbit onto (north, east).

import { AU_PC, J2000_JD } from './astronomy-constants';
import { solveKepler } from './kepler-solver';
import type { OrbitalElements } from '../../scripts/catalog-pure';

export interface Vec3 { x: number; y: number; z: number; }

/** Sky-plane separation of B relative to A at JDE `tJd`, in AU. North
 *  is +X, east is +Y. Thiele-Innes formulation; single Kepler solve. */
export function evaluateOrbitSkyAU(
  elements: OrbitalElements,
  tJd: number,
): { northAU: number; eastAU: number } {
  const { P, T, e, a, i, omega, Omega } = elements;
  const M = (2 * Math.PI * (tJd - T)) / P;
  const E = solveKepler(M, e);
  const cosO = Math.cos(omega), sinO = Math.sin(omega);
  const cosN = Math.cos(Omega), sinN = Math.sin(Omega);
  const cosI = Math.cos(i);
  // Thiele-Innes constants (per unit a). x = north, y = east.
  const A = cosO * cosN - sinO * sinN * cosI;
  const B = cosO * sinN + sinO * cosN * cosI;
  const F = -sinO * cosN - cosO * sinN * cosI;
  const G = -sinO * sinN + cosO * cosN * cosI;
  const X = Math.cos(E) - e;
  const Y = Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
  return {
    northAU: a * (A * X + F * Y),
    eastAU: a * (B * X + G * Y),
  };
}

/** Convert a sky-plane separation (north, east) in pc at a system whose
 *  ICRS position is `systemXyzPc` into an ICRS Δxyz in pc. The d term
 *  in the tangent-plane projection cancels because the input is already
 *  in linear units (pc), not angular. */
export function projectSkyToICRS(
  systemXyzPc: Vec3,
  northPc: number,
  eastPc: number,
): Vec3 {
  const r = Math.hypot(systemXyzPc.x, systemXyzPc.y, systemXyzPc.z);
  if (r === 0) return { x: 0, y: 0, z: 0 };
  const dec = Math.asin(systemXyzPc.z / r);
  const ra = Math.atan2(systemXyzPc.y, systemXyzPc.x);
  const sinRa = Math.sin(ra), cosRa = Math.cos(ra);
  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  // East = +α direction; North = +δ direction.
  return {
    x: northPc * (-sinDec * cosRa) + eastPc * (-sinRa),
    y: northPc * (-sinDec * sinRa) + eastPc * cosRa,
    z: northPc * cosDec,
  };
}

/** ICRS Δxyz (pc) to apply to the stored J2000 component position to
 *  evolve it to time `tJd`. The stored xyz already places A at
 *  `X_com − q·R(J2000)` and B at `X_com + (1−q)·R(J2000)`, so the
 *  per-frame motion is ΔR(t) − R(J2000), split by side via q.
 *
 *  Two Kepler solves per call (now + J2000). For per-frame use across
 *  many systems, dch.10's `BinaryOrbitField` caches `R(J2000)` per
 *  orbit row and calls `evaluateOrbitSkyAU` directly for `R(t)`. */
export function evaluateBinaryOffset(
  elements: OrbitalElements,
  tJd: number,
  isSecondary: boolean,
  systemXyzPc: Vec3,
): Vec3 {
  const now = evaluateOrbitSkyAU(elements, tJd);
  const ref = evaluateOrbitSkyAU(elements, J2000_JD);
  // A_offset = −q · ΔR, B_offset = +(1−q) · ΔR — barycenter split.
  const sign = isSecondary ? (1 - elements.q) : -elements.q;
  const dnPc = (now.northAU - ref.northAU) * AU_PC * sign;
  const dePc = (now.eastAU - ref.eastAU) * AU_PC * sign;
  return projectSkyToICRS(systemXyzPc, dnPc, dePc);
}
