// Eased-u curve options consumed by `camera-motion.ts`'s log-distance
// arrival profile. The deceleration shape is `d(u) = d0 · (dEnd/d0)^f`
// where `f = ease(u)`; swapping `ease` changes the perceptual character
// of focus-park, warp Fly, and unfocus simultaneously.
//
// Defaults to cubic-Hermite (`3u² − 2u³`) — the curve documented in
// `docs/camera-arrival.md` § Profile and pinned by `camera-motion.test.ts`.
// The other shapes are exposed by `warp-tuning.ts` for live tuning; they
// are not callable from anywhere else in the shipped code path.

export type ArrivalCurveId =
  | 'cubic-hermite'
  | 'quintic-hermite'
  | 'power'
  | 'trapezoid'
  | 'hybrid';

/** Per-warp context the `'hybrid'` curve needs in order to resolve its
 *  trajectory. Curves that don't need it (`cubic-hermite`,
 *  `quintic-hermite`, `power`, `trapezoid`) ignore the argument.
 *
 *  `targetRadius == null` for kinds without a single geometric radius
 *  (clouds, future opaque ensembles); the hybrid then silently falls
 *  back to `easeCubicHermite`. Same effect when the trajectory is
 *  outbound (`dEnd > d0`) — the hybrid's two regimes only make sense
 *  approaching a destination, so unfocus / outbound paths fall back
 *  too. */
export interface ArrivalCurveContext {
  d0: number;
  dEnd: number;
  targetRadius: number | null;
}

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

// Clamp window for u_seam in `easeHybrid`. The auto-formula
// `log(d0/d_seam) / log(d0/d_end)` adapts the outer/inner split to the
// warp's distance range, but for short warps or extreme distance ratios
// the raw value can fall outside a usable range. Floor at 0.3 so the
// inner regime always gets meaningful time; cap at 0.85 so even very
// long warps spend at least 15 % of u in the close-approach angular
// regime.
const HYBRID_U_SEAM_MIN = 0.3;
const HYBRID_U_SEAM_MAX = 0.85;

/** Hybrid two-regime arrival profile:
 *  - **Outer** (`u ∈ [0, u_seam]`): piecewise-quadratic on LINEAR
 *    distance from `d0` to `d_seam`. Matches the pre-2br.3 main-branch
 *    "rocket impulse" feel — constant linear acceleration to τ = 0.5,
 *    constant linear deceleration after. Visual cue dominated by
 *    background-star parallax sweep, which is strong at the high linear
 *    velocity that linear-d delivers in the early/mid warp.
 *  - **Inner** (`u ∈ [u_seam, 1]`): quintic smootherstep on ANGULAR
 *    SIZE `θ = R / d` from `θ_seam = R/d_seam` to `θ_end = R/d_end`.
 *    `S''(1) = 0` gives zero acceleration at landing — clean perceptual
 *    standstill. Visual cue dominated by destination disc growth, which
 *    is what the user actually tracks once parallax has collapsed at
 *    short range.
 *
 *  The function returns the LOG-D-EQUIVALENT eased-u value
 *  (`f(u) = log(d_target(u) / d0) / log(d_end / d0)`) so the consumer
 *  (`camera-motion.ts:tickArrival`'s `d(u) = d0 · (d_end/d0)^f(u)` line)
 *  is unchanged. The hybrid geometry lives entirely inside this
 *  closure.
 *
 *  Fallback: returns `easeCubicHermite(u)` when `targetRadius` is null
 *  (clouds, future kinds without a geometric R) OR when the trajectory
 *  is outbound (`dEnd > d0`, e.g., unfocus). The seam logic only makes
 *  sense for inbound approach.
 *
 *  See `docs/camera-arrival.md` § Hybrid linear-d + angular-size
 *  profile for the design rationale and rejection of velocity-matching
 *  at non-zero v. */
export function easeHybrid(
  u: number,
  d0: number,
  dEnd: number,
  R: number | null,
  seamK: number,
): number {
  // Fallback paths: outbound (no "approach" to match), missing radius
  // (no angular size), or degenerate distance ratio. The cubic-Hermite
  // log-d profile is the safe behaviour for these cases.
  if (R == null || R <= 0) return easeCubicHermite(u);
  if (dEnd >= d0) return easeCubicHermite(u);

  const dSeamRaw = seamK * dEnd;
  const logRatio = Math.log(dEnd / d0);  // negative for inbound
  // d_seam might be at or beyond d0 for very short warps — skip the
  // outer regime entirely and run pure angular inner across the full
  // [d0, dEnd] range. Use d0 (not dSeamRaw) as the inner regime's
  // effective seam so the warp starts at d0 exactly.
  if (dSeamRaw >= d0) {
    return hybridInnerF(u, d0, dEnd, R, /* uSeam */ 0, /* dSeam */ d0, logRatio);
  }
  const dSeam = dSeamRaw;

  // Auto-compute u_seam from log-distance share, clamped so each
  // regime has meaningful time even at extreme distance ratios.
  const uSeamRaw = Math.log(d0 / dSeam) / Math.log(d0 / dEnd);
  const uSeam = Math.min(
    Math.max(uSeamRaw, HYBRID_U_SEAM_MIN),
    HYBRID_U_SEAM_MAX,
  );

  if (u <= uSeam) {
    return hybridOuterF(u, d0, dSeam, uSeam, logRatio);
  }
  return hybridInnerF(u, d0, dEnd, R, uSeam, dSeam, logRatio);
}

// Outer regime: piecewise-quadratic on linear distance from d0 to
// d_seam, mapped to log-d-equivalent f(u). Pulled out for readability;
// the math has three quantities (τ, d_target, f) that interact only
// through this branch.
function hybridOuterF(
  u: number,
  d0: number,
  dSeam: number,
  uSeam: number,
  logRatio: number,
): number {
  const tau = u / uSeam;
  const fOuter = tau < 0.5
    ? 2 * tau * tau
    : 1 - 2 * (1 - tau) * (1 - tau);
  const dTarget = d0 - fOuter * (d0 - dSeam);
  return Math.log(dTarget / d0) / logRatio;
}

// Inner regime: quintic smootherstep on angular size θ = R/d from
// θ_seam to θ_end. Maps σ ∈ [0, 1] across u ∈ [u_seam, 1].
function hybridInnerF(
  u: number,
  d0: number,
  dEnd: number,
  R: number,
  uSeam: number,
  dSeam: number,
  logRatio: number,
): number {
  // σ ∈ [0, 1] over the inner regime. Clamped because tiny float drift
  // at u = 1 can produce σ > 1 → S(σ) > 1 → d_target overshooting
  // d_end on the wrong side.
  const sigmaRaw = uSeam < 1 ? (u - uSeam) / (1 - uSeam) : 1;
  const sigma = Math.min(Math.max(sigmaRaw, 0), 1);
  // Quintic smootherstep: S(σ) = 10σ³ − 15σ⁴ + 6σ⁵.
  // Same polynomial as `easeQuinticHermite`; inline the call to keep
  // this branch self-contained.
  const s = sigma * sigma * sigma * (10 + sigma * (-15 + sigma * 6));
  const thetaSeam = R / dSeam;
  const thetaEnd = R / dEnd;
  const theta = thetaSeam + s * (thetaEnd - thetaSeam);
  const dTarget = R / theta;
  return Math.log(dTarget / d0) / logRatio;
}

/** Resolve a curve id (with optional parameters and per-warp context)
 *  into the corresponding ease function. Captures the parameters at
 *  resolve time, so re-resolving each warp start picks up the live
 *  slider values without re-binding the per-tick math.
 *
 *  `ctx` is consumed only by the `'hybrid'` curve. Other curves ignore
 *  it. Callers without a hybrid-aware ctx can omit it; hybrid then
 *  falls back to cubic-Hermite. */
export function resolveArrivalCurve(
  id: ArrivalCurveId,
  powerP: number,
  trapezoidTAccel: number,
  trapezoidTDecel: number,
  hybridSeamK: number,
  ctx?: ArrivalCurveContext,
): (u: number) => number {
  switch (id) {
    case 'cubic-hermite': return easeCubicHermite;
    case 'quintic-hermite': return easeQuinticHermite;
    case 'power': return (u: number) => easePower(u, powerP);
    case 'trapezoid':
      return (u: number) => easeTrapezoid(u, trapezoidTAccel, trapezoidTDecel);
    case 'hybrid': {
      // Capture d0/dEnd/R/seamK at resolve time so the closure is
      // self-contained — matches the trapezoid arm's freeze-on-resolve
      // semantics. If ctx is missing, fall back to cubic-Hermite (same
      // failure mode as null R).
      if (!ctx) return easeCubicHermite;
      const { d0, dEnd, targetRadius } = ctx;
      return (u: number) =>
        easeHybrid(u, d0, dEnd, targetRadius, hybridSeamK);
    }
  }
}
