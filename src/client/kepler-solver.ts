// Shared Newton-Raphson solver for Kepler's equation `M = E − e·sin(E)`.
// Used by:
//   - `ephemeris.ts` (Sol's planets, JPL Standish elements; e ≲ 0.25)
//   - `binary-orbit-pure.ts` (binary stars from ORB6; e up to ~0.95)
//
// One solver, two call sites — DRY per CLAUDE.md "Extract at second
// usage" rule. The defaults (50 iterations, 1e-12 tolerance) converge
// quickly for planets (typically 3 iterations) while still handling
// highly-eccentric binaries that need a longer tail.

/** Reduce an angle in radians into the (-π, π] interval. */
export function wrapAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = a - Math.floor(a / twoPi) * twoPi;
  if (r > Math.PI) r -= twoPi;
  return r;
}

/** Solve Kepler's equation `M = E − e·sin(E)` for the eccentric anomaly
 *  E (radians). Newton iteration with a wrapped initial guess. Quadratic
 *  convergence — planets (e ≲ 0.25) hit `tol` in ~3 steps; eccentric
 *  binaries (e ≲ 0.95) take up to ~15. */
export function solveKepler(
  M: number,
  e: number,
  tol = 1e-12,
  maxIter = 50,
): number {
  const Mw = wrapAngle(M);
  // Standard initial guess. For high-e cases near periapsis this is far
  // from the true E but Newton's quadratic convergence still gets us
  // there within maxIter steps.
  let E = Mw + e * Math.sin(Mw);
  for (let i = 0; i < maxIter; i++) {
    const dE = (E - e * Math.sin(E) - Mw) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < tol) break;
  }
  return E;
}
