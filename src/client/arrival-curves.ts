// Eased-u curve options consumed by `camera-motion.ts`'s log-distance
// arrival profile. The deceleration shape is `d(u) = d0 · (dEnd/d0)^f`
// where `f = ease(u)`; swapping `ease` changes the perceptual character
// of focus-park, warp Fly, and unfocus simultaneously.
//
// Defaults to cubic-Hermite (`3u² − 2u³`) — the curve documented in
// `docs/camera-arrival.md` § Profile and pinned by `camera-motion.test.ts`.
// The other shapes are exposed by `warp-tuning.ts` for live tuning; they
// are not callable from anywhere else in the shipped code path.

export type ArrivalCurveId = 'cubic-hermite' | 'quintic-hermite' | 'power' | 'trapezoid';

/** Cubic-Hermite smoothstep — identical to GLSL's `smoothstep`.
 *  `f(0) = 0`, `f(1) = 1`, `f'(0) = f'(1) = 0`. C¹-continuous,
 *  smooth jerk at u = 0.5. Current shipped default. */
export function easeCubicHermite(u: number): number {
  return u * u * (3 - 2 * u);
}

/** Quintic-Hermite smootherstep — `10u³ − 15u⁴ + 6u⁵`.
 *  `f(0) = f(1) − 1 = 0`, `f'(0) = f'(1) = 0`, `f''(0) = f''(1) = 0`.
 *  C²-continuous; slower middle, gentler endpoints than cubic. */
export function easeQuinticHermite(u: number): number {
  return u * u * u * (10 + u * (-15 + u * 6));
}

/** One-sided power ease — `f = u^p`. At `p = 1` linear; `p = 2`
 *  quadratic ease-in; `p < 1` ease-out. Asymmetric — the camera lingers
 *  at one end and moves quickly at the other depending on `p`. Use for
 *  exploring whether a non-symmetric arrival reads better than a
 *  symmetric Hermite. */
export function easePower(u: number, p: number): number {
  return Math.pow(u, p);
}

// Lower bound on the trapezoid ramp widths. Below this the cruise slope
// `v = 1 / (1 − t_accel/2 − t_decel/2)` grows without practical limit
// and the quadratic ramps degenerate into a near-step. Matches the panel
// slider minimum so the curve and the UI agree on the safe operating
// range.
const TRAPEZOID_MIN_RAMP = 0.01;
// Upper bound on each ramp width. `t_accel + t_decel = 1` is the
// no-cruise case (the two quadratic ramps meet); going above splits
// the formula because the cruise segment has negative length. Each
// ramp is independently capped at 0.5 so the symmetric `(0.5, 0.5)`
// edge — which reproduces the legacy `f = 2u² | 1 − 2(1 − u)²`
// piecewise-quadratic — is exactly reachable.
const TRAPEZOID_MAX_RAMP = 0.5;

/** Trapezoidal velocity profile in eased-u space — quadratic accel ramp,
 *  linear cruise, quadratic decel ramp. C¹-continuous; `f(0) = f'(0) = 0`,
 *  `f(1) = 1`, `f'(1) = 0`. Two tunable widths set the ramp durations.
 *
 *  Cruise slope `v` is determined by the area constraint `f(1) = 1`:
 *
 *      v = 1 / (1 − t_accel/2 − t_decel/2)
 *
 *  Piecewise:
 *      u ∈ [0, t_accel]:        f(u) = (v / (2·t_accel)) · u²
 *      u ∈ [t_accel, 1-t_decel]: f(u) = v·u − v·t_accel/2
 *      u ∈ [1-t_decel, 1]:       s = (u − (1−t_decel)) / t_decel
 *                                f(u) = 1 − (v·t_decel/2) · (1 − s)²
 *
 *  The degenerate case `t_accel = t_decel = 0.5` recovers the legacy
 *  piecewise-quadratic `f = 2u² | 1 − 2(1−u)²` exactly. */
export function easeTrapezoid(u: number, tAccel: number, tDecel: number): number {
  const a = Math.min(Math.max(tAccel, TRAPEZOID_MIN_RAMP), TRAPEZOID_MAX_RAMP);
  const d = Math.min(Math.max(tDecel, TRAPEZOID_MIN_RAMP), TRAPEZOID_MAX_RAMP);
  const v = 1 / (1 - a / 2 - d / 2);
  if (u <= a) {
    return (v / (2 * a)) * u * u;
  }
  if (u >= 1 - d) {
    const s = (u - (1 - d)) / d;
    const oneMinusS = 1 - s;
    return 1 - (v * d / 2) * oneMinusS * oneMinusS;
  }
  return v * u - v * a / 2;
}

/** Resolve a curve id (with optional parameters) into the corresponding
 *  ease function. Captures the parameters at resolve time, so re-resolving
 *  each warp start picks up the live slider values without re-binding the
 *  per-tick math. */
export function resolveArrivalCurve(
  id: ArrivalCurveId,
  powerP: number,
  trapezoidTAccel: number,
  trapezoidTDecel: number,
): (u: number) => number {
  switch (id) {
    case 'cubic-hermite': return easeCubicHermite;
    case 'quintic-hermite': return easeQuinticHermite;
    case 'power': return (u: number) => easePower(u, powerP);
    case 'trapezoid':
      return (u: number) => easeTrapezoid(u, trapezoidTAccel, trapezoidTDecel);
  }
}
