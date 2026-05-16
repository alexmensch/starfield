// Hybrid arrival profile consumed by `camera-motion.ts`'s `tickArrival`
// log-distance formula `d(u) = d0 · (dEnd/d0)^f(u)`. `f(u)` is built
// in REAL DISTANCE SPACE from a two-regime trajectory then returned as
// the log-d equivalent, so the consumer line is unchanged.
//
// Two regimes:
//
//   • Outer (u ∈ [0, u_seam]):  piecewise-quadratic on LINEAR distance
//     from d0 to d_seam.  Matches the pre-2br.3 main-branch
//     "rocket impulse" feel — constant linear acceleration to τ = 0.5,
//     constant linear deceleration after.  Visual cue is background-
//     star parallax sweep.
//
//   • Inner (u ∈ [u_seam, 1]):  quintic smootherstep on ANGULAR SIZE
//     θ = R/d from θ_seam = R/d_seam to θ_end = R/d_end.
//     S′(0) = S′(1) = 0 and S″(0) = S″(1) = 0, so the regime arrives
//     with zero velocity AND zero acceleration — clean perceptual
//     standstill.  Visual cue is destination disc growth.
//
// Both regimes arrive at the seam at v = 0, so the handoff is
// velocity-continuous without the "match non-zero velocities at a
// dWindow" constraint that killed the previously-rejected dWindow
// split design (see `docs/camera-arrival.md`).
//
// `seam_k = d_seam / d_end` is the only user-tunable knob.  Default
// 100, slider range 0–2000.  seam_k ≤ 1 (d_seam at or inside park)
// degenerates to pure outer — useful as a comparison baseline (matches
// the legacy main-branch warp's piecewise-quad on linear-d).
//
// Fallback: cubic-Hermite smoothstep on log-d.  Fires when
// `targetRadius` is null (clouds — no single geometric radius),
// when the trajectory is outbound (d_end > d0, e.g., unfocus), or
// when no context is supplied at resolve time.

/** Per-warp context the hybrid curve needs in order to resolve its
 *  trajectory.
 *
 *  `targetRadius == null` for kinds without a single geometric radius
 *  (clouds, future opaque ensembles); the hybrid then silently falls
 *  back to cubic-Hermite log-d.  Same effect when the trajectory is
 *  outbound (`dEnd > d0`) — the seam concept only makes sense for an
 *  approach. */
export interface ArrivalCurveContext {
  d0: number;
  dEnd: number;
  targetRadius: number | null;
}

// Clamp window for u_seam.  The auto-formula
// `log(d0/d_seam) / log(d0/d_end)` adapts the outer/inner split to the
// warp's distance range, but for short warps or extreme distance ratios
// the raw value can fall outside a usable range.  Floor at 0.3 so the
// inner regime always gets meaningful time; cap at 0.85 so even very
// long warps spend at least 15 % of u in the close-approach angular
// regime.
const HYBRID_U_SEAM_MIN = 0.3;
const HYBRID_U_SEAM_MAX = 0.85;

// Cubic-Hermite smoothstep — `3u² − 2u³`, identical to GLSL's
// `smoothstep`.  Used as the fallback inside the hybrid curve when
// per-warp context is unavailable (clouds, outbound, missing ctx).
// Not exported — the hybrid is the only user-facing arrival profile;
// `camera-motion.ts` keeps its own private copy as the default
// `easeUFn` when none is supplied at `newArrival` construction.
function cubicHermite(u: number): number {
  return u * u * (3 - 2 * u);
}

/** The u-value at which the outer→inner handoff fires.
 *
 *  Sentinel return values:
 *    `1` — pure-outer regime (seam_k ≤ 1, no meaningful inner).
 *    `0` — pure-inner regime (d_seam ≥ d0, no meaningful outer).
 *   `-1` — hybrid falls back to cubic-Hermite (no regime split applies).
 *
 *  Otherwise returns a value in `[HYBRID_U_SEAM_MIN, HYBRID_U_SEAM_MAX]`.
 *
 *  Consumers use this for two things: live debug indicators (which
 *  regime is the camera in right now?) and the eased-u dispatch inside
 *  `easeHybrid`.  Exported so the warp panel readout can compute the
 *  same value `easeHybrid` does without re-deriving the formula. */
export function hybridUSeam(
  d0: number,
  dEnd: number,
  R: number | null,
  seamK: number,
): number {
  if (R == null || R <= 0) return -1;
  if (dEnd >= d0) return -1;
  const dSeamRaw = seamK * dEnd;
  // seam_k ≤ 1 puts d_seam at or inside parkDist — there's no
  // meaningful inner regime.  Run pure linear-d piecewise-quad across
  // the full warp (degenerates to the pre-2br.3 main-branch behaviour,
  // a useful comparison baseline).
  if (dSeamRaw <= dEnd) return 1;
  // d_seam ≥ d0 — already inside the seam radius at warp start.  Skip
  // outer and run pure inner.
  if (dSeamRaw >= d0) return 0;
  const uSeamRaw = Math.log(d0 / dSeamRaw) / Math.log(d0 / dEnd);
  return Math.min(Math.max(uSeamRaw, HYBRID_U_SEAM_MIN), HYBRID_U_SEAM_MAX);
}

/** Hybrid two-regime arrival profile.  See module docstring for the
 *  geometry and `docs/camera-arrival.md` § Profile for the design
 *  rationale and the worked numerical examples.
 *
 *  Returns the log-d-equivalent eased-u value:
 *      `f(u) = log(d_target(u) / d0) / log(d_end / d0)`
 *  so the consumer (`tickArrival`'s `d(u) = d0 · (d_end/d0)^f(u)` line)
 *  stays unchanged. */
export function easeHybrid(
  u: number,
  d0: number,
  dEnd: number,
  R: number | null,
  seamK: number,
): number {
  // Fallback: outbound, missing radius, or degenerate distance ratio.
  if (R == null || R <= 0) return cubicHermite(u);
  if (dEnd >= d0) return cubicHermite(u);

  const dSeamRaw = seamK * dEnd;
  const logRatio = Math.log(dEnd / d0);  // negative for inbound

  // seam_k ≤ 1 → pure linear-d outer covering the full [d0, d_end]
  // range.  Equivalent to u_seam = 1 (no inner regime).
  if (dSeamRaw <= dEnd) {
    return hybridOuterF(u, d0, dEnd, /* uSeam */ 1, logRatio);
  }
  // d_seam at or beyond d0 → pure inner regime across the full warp,
  // using d0 (not d_seam) as the inner regime's effective seam so the
  // warp starts at d0 exactly.
  if (dSeamRaw >= d0) {
    return hybridInnerF(u, d0, dEnd, R, /* uSeam */ 0, /* dSeam */ d0, logRatio);
  }

  const dSeam = dSeamRaw;
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
// d_seam, mapped to log-d-equivalent f(u).
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
// θ_seam to θ_end.  Maps σ ∈ [0, 1] across u ∈ [u_seam, 1].
function hybridInnerF(
  u: number,
  d0: number,
  dEnd: number,
  R: number,
  uSeam: number,
  dSeam: number,
  logRatio: number,
): number {
  // σ ∈ [0, 1] over the inner regime.  Clamped because tiny float
  // drift at u = 1 can produce σ > 1 → S(σ) > 1 → dTarget
  // overshooting dEnd on the wrong side.
  const sigmaRaw = uSeam < 1 ? (u - uSeam) / (1 - uSeam) : 1;
  const sigma = Math.min(Math.max(sigmaRaw, 0), 1);
  // Quintic smootherstep: S(σ) = 10σ³ − 15σ⁴ + 6σ⁵.
  const s = sigma * sigma * sigma * (10 + sigma * (-15 + sigma * 6));
  const thetaSeam = R / dSeam;
  const thetaEnd = R / dEnd;
  const theta = thetaSeam + s * (thetaEnd - thetaSeam);
  const dTarget = R / theta;
  return Math.log(dTarget / d0) / logRatio;
}

/** Resolve the hybrid curve closure for a given seam_k and per-warp
 *  context.  Captures both at resolve time so the next warp picks up
 *  the latest slider value without mutating an in-flight warp.
 *
 *  `ctx == null` (or `ctx.targetRadius == null`, or outbound) falls
 *  back to cubic-Hermite log-d. */
export function resolveHybridCurve(
  seamK: number,
  ctx?: ArrivalCurveContext,
): (u: number) => number {
  if (!ctx) return cubicHermite;
  const { d0, dEnd, targetRadius } = ctx;
  return (u: number) => easeHybrid(u, d0, dEnd, targetRadius, seamK);
}
