// Hybrid arrival profile consumed by camera-motion.ts's tickArrival
// log-d formula. See docs/camera-arrival.md § Profile for the
// two-regime construction (linear-d outer + angular-size inner) and
// the seam_k knob. Falls back to cubic-Hermite log-d for outbound
// trajectories, null targetRadius, or no resolved context.

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
// per-warp context is unavailable (clouds, outbound, missing ctx), and
// re-exported as `camera-motion.ts`'s default `easeUFn` so the
// canonical fallback shape lives in exactly one place.
export function cubicHermite(u: number): number {
  return u * u * (3 - 2 * u);
}

/** Outer→inner handoff u-value. Sentinels: `1` pure-outer, `0`
 *  pure-inner, `-1` cubic-Hermite fallback. Otherwise in
 *  [HYBRID_U_SEAM_MIN, HYBRID_U_SEAM_MAX]. */
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
 // the full warp (degenerates to the pre- main-branch behaviour,
  // a useful comparison baseline).
  if (dSeamRaw <= dEnd) return 1;
  // d_seam ≥ d0 — already inside the seam radius at warp start.  Skip
  // outer and run pure inner.
  if (dSeamRaw >= d0) return 0;
  const uSeamRaw = Math.log(d0 / dSeamRaw) / Math.log(d0 / dEnd);
  return Math.min(Math.max(uSeamRaw, HYBRID_U_SEAM_MIN), HYBRID_U_SEAM_MAX);
}

/** Hybrid two-regime arrival profile — returns log-d-equivalent
 *  eased-u so the tickArrival consumer line is unchanged. See
 *  docs/camera-arrival.md § Profile. */
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
