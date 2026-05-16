// Eased-u curve options consumed by `camera-motion.ts`'s log-distance
// arrival profile. The deceleration shape is `d(u) = d0 · (dEnd/d0)^f`
// where `f = ease(u)`; swapping `ease` changes the perceptual character
// of focus-park, warp Fly, and unfocus simultaneously.
//
// Defaults to cubic-Hermite (`3u² − 2u³`) — the curve documented in
// `docs/camera-arrival.md` § Profile and pinned by `camera-motion.test.ts`.
// The other shapes are exposed by `warp-tuning.ts` for live tuning; they
// are not callable from anywhere else in the shipped code path.

export type ArrivalCurveId = 'cubic-hermite' | 'quintic-hermite' | 'power';

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

/** Resolve a curve id (and optional power parameter for `'power'`) into
 *  the corresponding ease function. Captures `p` at resolve time, so
 *  re-resolving each warp start picks up the live slider value without
 *  re-binding the per-tick math. */
export function resolveArrivalCurve(
  id: ArrivalCurveId,
  powerP: number,
): (u: number) => number {
  switch (id) {
    case 'cubic-hermite': return easeCubicHermite;
    case 'quintic-hermite': return easeQuinticHermite;
    case 'power': return (u: number) => easePower(u, powerP);
  }
}
