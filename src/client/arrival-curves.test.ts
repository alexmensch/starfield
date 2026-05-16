import { describe, expect, it } from 'vitest';
import {
  easeCubicHermite,
  easeQuinticHermite,
  easePower,
  easeTrapezoid,
  easeHybrid,
  resolveArrivalCurve,
} from './arrival-curves';

describe('easeCubicHermite', () => {
  it('endpoints', () => {
    expect(easeCubicHermite(0)).toBe(0);
    expect(easeCubicHermite(1)).toBe(1);
  });
  it('matches the documented midpoint value', () => {
    expect(easeCubicHermite(0.5)).toBeCloseTo(0.5, 12);
  });
  it('symmetric around the midpoint: f(u) + f(1−u) == 1', () => {
    for (const u of [0.1, 0.25, 0.4]) {
      expect(easeCubicHermite(u) + easeCubicHermite(1 - u)).toBeCloseTo(1, 12);
    }
  });
  it('monotonic in [0, 1]', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const v = easeCubicHermite(i / 20);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('easeQuinticHermite', () => {
  it('endpoints', () => {
    expect(easeQuinticHermite(0)).toBe(0);
    expect(easeQuinticHermite(1)).toBe(1);
  });
  it('midpoint 0.5', () => {
    expect(easeQuinticHermite(0.5)).toBeCloseTo(0.5, 12);
  });
  it('symmetric around the midpoint', () => {
    for (const u of [0.1, 0.3, 0.4]) {
      expect(easeQuinticHermite(u) + easeQuinticHermite(1 - u)).toBeCloseTo(1, 12);
    }
  });
  it('flatter than cubic-Hermite near the endpoints', () => {
    // Both pass through (0.5, 0.5) and (0, 0) / (1, 1), but the quintic
    // has zero second derivative at the endpoints — so for u ∈ (0, 0.5)
    // it sits below the cubic curve (slower to leave 0), and by symmetry
    // sits above for u ∈ (0.5, 1).
    expect(easeQuinticHermite(0.2)).toBeLessThan(easeCubicHermite(0.2));
    expect(easeQuinticHermite(0.8)).toBeGreaterThan(easeCubicHermite(0.8));
  });
  it('monotonic in [0, 1]', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const v = easeQuinticHermite(i / 20);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('easePower', () => {
  it('endpoints for any p', () => {
    for (const p of [0.5, 1, 2, 3]) {
      expect(easePower(0, p)).toBe(0);
      expect(easePower(1, p)).toBe(1);
    }
  });
  it('p == 1 is linear', () => {
    for (const u of [0.1, 0.25, 0.5, 0.75]) {
      expect(easePower(u, 1)).toBeCloseTo(u, 12);
    }
  });
  it('p > 1 ease-in (slow start)', () => {
    expect(easePower(0.5, 2)).toBeCloseTo(0.25, 12);
    expect(easePower(0.5, 3)).toBeCloseTo(0.125, 12);
  });
  it('p < 1 ease-out (fast start)', () => {
    expect(easePower(0.5, 0.5)).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe('easeTrapezoid', () => {
  // Default panel values per warp-tuning.ts.
  const DEFAULT_T_ACCEL = 0.15;
  const DEFAULT_T_DECEL = 0.10;

  // Centred-difference numerical derivative used to verify endpoint
  // and join slopes. Small ε keeps the centred-diff truncation error
  // (O(ε²) for smooth segments, O(ε) at C¹ joins) below the test
  // tolerance.
  function dfdu(u: number, ta: number, td: number, eps = 1e-6): number {
    return (easeTrapezoid(u + eps, ta, td) - easeTrapezoid(u - eps, ta, td)) / (2 * eps);
  }

  it('endpoints for representative widths', () => {
    for (const [ta, td] of [[0.15, 0.1], [0.05, 0.05], [0.3, 0.3], [0.5, 0.5]]) {
      expect(easeTrapezoid(0, ta, td)).toBeCloseTo(0, 12);
      expect(easeTrapezoid(1, ta, td)).toBeCloseTo(1, 12);
    }
  });

  it('zero slope at both endpoints', () => {
    expect(dfdu(0, DEFAULT_T_ACCEL, DEFAULT_T_DECEL)).toBeCloseTo(0, 5);
    expect(dfdu(1, DEFAULT_T_ACCEL, DEFAULT_T_DECEL)).toBeCloseTo(0, 5);
  });

  it('slope continuous at the accel join (one-sided limits both equal v)', () => {
    const ta = DEFAULT_T_ACCEL;
    const td = DEFAULT_T_DECEL;
    const v = 1 / (1 - ta / 2 - td / 2);
    // Accel ramp slope at u = ta (one-sided limit from below):
    //   f(u) = (v / (2a)) u² ⇒ f'(a) = v
    // Cruise slope (one-sided limit from above):
    //   f(u) = v·u − v·a/2 ⇒ f'(a) = v
    // Centred difference straddling the join reports the average,
    // which equals v exactly to within O(ε) truncation error.
    const slope = dfdu(ta, ta, td, 1e-8);
    expect(slope).toBeCloseTo(v, 5);
  });

  it('slope continuous at the decel join (one-sided limits both equal v)', () => {
    const ta = DEFAULT_T_ACCEL;
    const td = DEFAULT_T_DECEL;
    const v = 1 / (1 - ta / 2 - td / 2);
    // Cruise slope at u = 1 − td (from below): v.
    // Decel ramp at u = 1 − td (from above):
    //   f(u) = 1 − (v·td/2)(1 − s)², s = (u − (1−td))/td
    //   df/du = v·(1 − s); at s = 0 this is v.
    const slope = dfdu(1 - td, ta, td, 1e-8);
    expect(slope).toBeCloseTo(v, 5);
  });

  it('degenerate (0.5, 0.5) reproduces the legacy piecewise-quadratic', () => {
    // f = 2u²       for u < 0.5
    // f = 1 − 2(1−u)² for u ≥ 0.5
    for (const u of [0.0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1.0]) {
      const expected = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
      expect(easeTrapezoid(u, 0.5, 0.5)).toBeCloseTo(expected, 10);
    }
  });

  it('monotonic across the full domain for default widths', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const v = easeTrapezoid(i / 100, DEFAULT_T_ACCEL, DEFAULT_T_DECEL);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('asymmetric defaults reach the documented v ≈ 1.143', () => {
    const v = 1 / (1 - DEFAULT_T_ACCEL / 2 - DEFAULT_T_DECEL / 2);
    expect(v).toBeCloseTo(1.1428571, 6);
    // The cruise segment is a straight line of slope v from
    // u = t_accel to u = 1 − t_decel. Check the middle of the cruise.
    const uMid = (DEFAULT_T_ACCEL + (1 - DEFAULT_T_DECEL)) / 2;
    const fMid = easeTrapezoid(uMid, DEFAULT_T_ACCEL, DEFAULT_T_DECEL);
    const expected = v * uMid - v * DEFAULT_T_ACCEL / 2;
    expect(fMid).toBeCloseTo(expected, 10);
  });

  it('clamps degenerate inputs to the safe ramp range', () => {
    // Below the minimum the result stays finite and matches the
    // clamped-floor computation, so live slider values that under-shoot
    // the panel min don't break the curve.
    const fA = easeTrapezoid(0.5, 0, 0.1);
    const fB = easeTrapezoid(0.5, 0.01, 0.1);
    expect(fA).toBeCloseTo(fB, 10);
    expect(Number.isFinite(fA)).toBe(true);
  });
});

describe('easeHybrid', () => {
  // Representative Sol-from-10-pc warp.
  // R_sun ≈ 2.26e-8 pc; rounded for readability.
  const R_SOL = 2.3e-8;
  const D0 = 10;        // 10 pc start
  const D_END = 2.4e-5; // ~5 AU park
  const SEAM_K = 500;
  const D_SEAM = SEAM_K * D_END;

  // Map eased-u f back to the absolute distance the consumer would see
  // — `d(u) = d0 · (d_end/d0)^f(u)`. The test cases reason in real
  // distance space, which is easier to verify than eased-u.
  function dOf(f: number): number {
    return D0 * Math.pow(D_END / D0, f);
  }

  it('endpoints — f(0) = 0, f(1) = 1', () => {
    expect(easeHybrid(0, D0, D_END, R_SOL, SEAM_K)).toBeCloseTo(0, 10);
    expect(easeHybrid(1, D0, D_END, R_SOL, SEAM_K)).toBeCloseTo(1, 10);
  });

  it('seam value — d_target(u_seam) ≈ d_seam', () => {
    const uSeamRaw =
      Math.log(D0 / D_SEAM) / Math.log(D0 / D_END);
    const uSeam = Math.min(Math.max(uSeamRaw, 0.3), 0.85);
    const f = easeHybrid(uSeam, D0, D_END, R_SOL, SEAM_K);
    const d = dOf(f);
    expect(d).toBeCloseTo(D_SEAM, 6);
  });

  it('seam velocity ≈ 0 on both sides (v=0 handoff)', () => {
    const uSeamRaw =
      Math.log(D0 / D_SEAM) / Math.log(D0 / D_END);
    const uSeam = Math.min(Math.max(uSeamRaw, 0.3), 0.85);
    const eps = 1e-5;
    const dBefore = dOf(easeHybrid(uSeam - eps, D0, D_END, R_SOL, SEAM_K));
    const dAt = dOf(easeHybrid(uSeam, D0, D_END, R_SOL, SEAM_K));
    const dAfter = dOf(easeHybrid(uSeam + eps, D0, D_END, R_SOL, SEAM_K));
    // Numerical derivative of d wrt u on each side. Both quadratic
    // ramps land at u_seam with df/du = 0 (outer pq ends at τ=1,
    // inner quintic starts at σ=0 with S'(0)=0), so dd/du also → 0.
    // Tolerance is loose because we're sandwiched between two
    // quadratic regions — second-order terms dominate at this ε.
    const ddBefore = Math.abs((dAt - dBefore) / eps);
    const ddAfter = Math.abs((dAfter - dAt) / eps);
    // Scale tolerance by |d0 - d_seam| / 1 — pure dimensional check
    // that the velocity is "small" relative to the regime's distance
    // range, not literal zero.
    const slopeRef = (D0 - D_SEAM);
    expect(ddBefore / slopeRef).toBeLessThan(5e-4);
    expect(ddAfter / slopeRef).toBeLessThan(5e-4);
  });

  it('outer regime matches piecewise-quad on linear-d', () => {
    const uSeamRaw =
      Math.log(D0 / D_SEAM) / Math.log(D0 / D_END);
    const uSeam = Math.min(Math.max(uSeamRaw, 0.3), 0.85);
    // Sample at τ = 0.25, 0.5, 0.75 within the outer regime.
    for (const tau of [0.25, 0.5, 0.75]) {
      const u = tau * uSeam;
      const fOuterAnalytic = tau < 0.5
        ? 2 * tau * tau
        : 1 - 2 * (1 - tau) * (1 - tau);
      const dExpected = D0 - fOuterAnalytic * (D0 - D_SEAM);
      const dActual = dOf(easeHybrid(u, D0, D_END, R_SOL, SEAM_K));
      expect(dActual).toBeCloseTo(dExpected, 6);
    }
  });

  it('inner regime mid-σ matches quintic-smootherstep on θ', () => {
    const uSeamRaw =
      Math.log(D0 / D_SEAM) / Math.log(D0 / D_END);
    const uSeam = Math.min(Math.max(uSeamRaw, 0.3), 0.85);
    // σ = 0.5 corresponds to u halfway through the inner regime.
    const u = uSeam + 0.5 * (1 - uSeam);
    // Quintic at σ=0.5: 10·0.125 − 15·0.0625 + 6·0.03125 = 0.5.
    const sigmaS = 0.5;
    const thetaSeam = R_SOL / D_SEAM;
    const thetaEnd = R_SOL / D_END;
    const thetaExpected = thetaSeam + sigmaS * (thetaEnd - thetaSeam);
    const dExpected = R_SOL / thetaExpected;
    const dActual = dOf(easeHybrid(u, D0, D_END, R_SOL, SEAM_K));
    expect(dActual).toBeCloseTo(dExpected, 8);
  });

  it('quintic landing — d²θ/du² at u = 1 is ≈ 0', () => {
    // Sample three points near u = 1 and check the second-difference
    // of θ wrt u falls off to noise.
    const eps = 1e-4;
    const f1 = easeHybrid(1, D0, D_END, R_SOL, SEAM_K);
    const f2 = easeHybrid(1 - eps, D0, D_END, R_SOL, SEAM_K);
    const f3 = easeHybrid(1 - 2 * eps, D0, D_END, R_SOL, SEAM_K);
    const theta1 = R_SOL / dOf(f1);
    const theta2 = R_SOL / dOf(f2);
    const theta3 = R_SOL / dOf(f3);
    // d²θ/du² ≈ (θ1 - 2·θ2 + θ3) / ε². For quintic landing, this
    // should be small relative to the inner regime's θ range.
    const thetaSeam = R_SOL / D_SEAM;
    const thetaEnd = R_SOL / D_END;
    const dThetaDdu2 = (theta1 - 2 * theta2 + theta3) / (eps * eps);
    const scale = thetaEnd - thetaSeam;
    expect(Math.abs(dThetaDdu2) / scale).toBeLessThan(0.1);
  });

  it('degenerate d_seam >= d_0 — pure inner regime, endpoints exact', () => {
    // For seam_k * d_end > d_0, the whole warp runs the inner regime.
    // Endpoints must still land exactly.
    const closeD0 = D_SEAM * 0.5; // start well inside the seam radius
    expect(easeHybrid(0, closeD0, D_END, R_SOL, SEAM_K)).toBeCloseTo(0, 10);
    expect(easeHybrid(1, closeD0, D_END, R_SOL, SEAM_K)).toBeCloseTo(1, 10);
    // Inner is monotone — sample a few u and check d strictly decreases.
    let prevD = closeD0 * 1.01;
    for (let i = 1; i <= 10; i++) {
      const u = i / 10;
      const f = easeHybrid(u, closeD0, D_END, R_SOL, SEAM_K);
      const d = closeD0 * Math.pow(D_END / closeD0, f);
      expect(d).toBeLessThan(prevD);
      prevD = d;
    }
  });

  it('null R fallback — bit-equal to cubic-Hermite across u', () => {
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      expect(easeHybrid(u, D0, D_END, null, SEAM_K)).toBe(easeCubicHermite(u));
    }
  });

  it('outbound (d_end > d_0) fallback — bit-equal to cubic-Hermite', () => {
    // Unfocus path: camera starts inside parkDist, moves outward.
    const dOutStart = 1e-5;
    const dOutEnd = 2e-5;
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      expect(easeHybrid(u, dOutStart, dOutEnd, R_SOL, SEAM_K))
        .toBe(easeCubicHermite(u));
    }
  });

  it('monotonic d across full warp', () => {
    let prevD = D0 * 1.01;
    for (let i = 0; i <= 200; i++) {
      const u = i / 200;
      const f = easeHybrid(u, D0, D_END, R_SOL, SEAM_K);
      const d = dOf(f);
      expect(d).toBeLessThan(prevD);
      prevD = d;
    }
  });
});

describe('resolveArrivalCurve', () => {
  it('cubic-hermite branch', () => {
    const fn = resolveArrivalCurve('cubic-hermite', 2, 0.15, 0.1, 500);
    expect(fn(0.5)).toBeCloseTo(easeCubicHermite(0.5), 12);
  });
  it('quintic-hermite branch', () => {
    const fn = resolveArrivalCurve('quintic-hermite', 2, 0.15, 0.1, 500);
    expect(fn(0.5)).toBeCloseTo(easeQuinticHermite(0.5), 12);
  });
  it('power branch captures p at resolve time', () => {
    const fn2 = resolveArrivalCurve('power', 2, 0.15, 0.1, 500);
    const fn3 = resolveArrivalCurve('power', 3, 0.15, 0.1, 500);
    expect(fn2(0.5)).toBeCloseTo(0.25, 12);
    expect(fn3(0.5)).toBeCloseTo(0.125, 12);
    // Both stay independent if the caller resolves with different p values.
  });
  it('trapezoid branch captures ramp widths at resolve time', () => {
    const fnA = resolveArrivalCurve('trapezoid', 2, 0.15, 0.10, 500);
    const fnB = resolveArrivalCurve('trapezoid', 2, 0.5, 0.5, 500);
    // Same u, different closure inputs → independent results.
    expect(fnA(0.5)).toBeCloseTo(easeTrapezoid(0.5, 0.15, 0.10), 12);
    expect(fnB(0.5)).toBeCloseTo(easeTrapezoid(0.5, 0.5, 0.5), 12);
    // Sanity: the legacy degenerate case lands at f(0.5) = 0.5.
    expect(fnB(0.5)).toBeCloseTo(0.5, 10);
  });
  it('hybrid branch captures ctx at resolve time', () => {
    const ctx = { d0: 10, dEnd: 2.4e-5, targetRadius: 2.3e-8 };
    const fn = resolveArrivalCurve('hybrid', 2, 0.15, 0.1, 500, ctx);
    expect(fn(0)).toBeCloseTo(0, 10);
    expect(fn(1)).toBeCloseTo(1, 10);
    // Sample agrees with the direct easeHybrid call.
    expect(fn(0.5)).toBeCloseTo(
      easeHybrid(0.5, ctx.d0, ctx.dEnd, ctx.targetRadius, 500),
      12,
    );
  });
  it('hybrid branch without ctx falls back to cubic-Hermite', () => {
    const fn = resolveArrivalCurve('hybrid', 2, 0.15, 0.1, 500);
    expect(fn(0.5)).toBe(easeCubicHermite(0.5));
  });
});
