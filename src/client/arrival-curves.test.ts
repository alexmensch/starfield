import { describe, expect, it } from 'vitest';
import {
  cubicHermite,
  easeHybrid,
  hybridUSeam,
  resolveHybridCurve,
} from './arrival-curves';

describe('easeHybrid', () => {
  // Representative Sol-from-10-pc warp.
  // R_sun ≈ 2.26e-8 pc; rounded for readability.
  const R_SOL = 2.3e-8;
  const D0 = 10;        // 10 pc start
  const D_END = 2.4e-5; // ~5 AU park
  const SEAM_K = 100;
  const D_SEAM = SEAM_K * D_END;

  // Map eased-u f back to the absolute distance the consumer would see
  // — `d(u) = d0 · (d_end/d0)^f(u)`. The test cases reason in real
  // distance space, which is easier to verify than eased-u.
  function dOf(f: number, d0 = D0, dEnd = D_END): number {
    return d0 * Math.pow(dEnd / d0, f);
  }

  it('endpoints — f(0) = 0, f(1) = 1', () => {
    expect(easeHybrid(0, D0, D_END, R_SOL, SEAM_K)).toBeCloseTo(0, 10);
    expect(easeHybrid(1, D0, D_END, R_SOL, SEAM_K)).toBeCloseTo(1, 10);
  });

  it('seam value — d_target(u_seam) ≈ d_seam', () => {
    const uSeam = hybridUSeam(D0, D_END, R_SOL, SEAM_K);
    expect(uSeam).toBeGreaterThan(0);
    expect(uSeam).toBeLessThan(1);
    const f = easeHybrid(uSeam, D0, D_END, R_SOL, SEAM_K);
    expect(dOf(f)).toBeCloseTo(D_SEAM, 6);
  });

  it('seam velocity ≈ 0 on both sides (v=0 handoff)', () => {
    const uSeam = hybridUSeam(D0, D_END, R_SOL, SEAM_K);
    const eps = 1e-5;
    const dBefore = dOf(easeHybrid(uSeam - eps, D0, D_END, R_SOL, SEAM_K));
    const dAt = dOf(easeHybrid(uSeam, D0, D_END, R_SOL, SEAM_K));
    const dAfter = dOf(easeHybrid(uSeam + eps, D0, D_END, R_SOL, SEAM_K));
    // Both quadratic ramps land at u_seam with df/du = 0, so dd/du
    // also → 0. Tolerance is loose because second-order terms dominate
    // at this ε scale.
    const slopeRef = D0 - D_SEAM;
    expect(Math.abs((dAt - dBefore) / eps) / slopeRef).toBeLessThan(5e-4);
    expect(Math.abs((dAfter - dAt) / eps) / slopeRef).toBeLessThan(5e-4);
  });

  it('outer regime matches piecewise-quad on linear-d', () => {
    const uSeam = hybridUSeam(D0, D_END, R_SOL, SEAM_K);
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
    const uSeam = hybridUSeam(D0, D_END, R_SOL, SEAM_K);
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
    // ε small enough to keep the centred-difference truncation error
    // below tolerance for the seam_k=100 inner-regime width.
    // Truncation goes as ε / (1 − u_seam)³, dominated by `S'''(1) = 60`
    // when S''(1) = 0 (the quintic-landing property we're verifying).
    const eps = 1e-5;
    const f1 = easeHybrid(1, D0, D_END, R_SOL, SEAM_K);
    const f2 = easeHybrid(1 - eps, D0, D_END, R_SOL, SEAM_K);
    const f3 = easeHybrid(1 - 2 * eps, D0, D_END, R_SOL, SEAM_K);
    const theta1 = R_SOL / dOf(f1);
    const theta2 = R_SOL / dOf(f2);
    const theta3 = R_SOL / dOf(f3);
    const thetaSeam = R_SOL / D_SEAM;
    const thetaEnd = R_SOL / D_END;
    const dThetaDdu2 = (theta1 - 2 * theta2 + theta3) / (eps * eps);
    const scale = thetaEnd - thetaSeam;
    expect(Math.abs(dThetaDdu2) / scale).toBeLessThan(0.05);
  });

  it('pure inner regime (d_seam >= d_0) — endpoints exact, monotone', () => {
    // For seam_k * d_end > d_0, the whole warp runs the inner regime.
    const closeD0 = D_SEAM * 0.5;
    expect(easeHybrid(0, closeD0, D_END, R_SOL, SEAM_K)).toBeCloseTo(0, 10);
    expect(easeHybrid(1, closeD0, D_END, R_SOL, SEAM_K)).toBeCloseTo(1, 10);
    let prevD = closeD0 * 1.01;
    for (let i = 1; i <= 10; i++) {
      const u = i / 10;
      const f = easeHybrid(u, closeD0, D_END, R_SOL, SEAM_K);
      const d = dOf(f, closeD0);
      expect(d).toBeLessThan(prevD);
      prevD = d;
    }
  });

  it('pure outer regime (seam_k <= 1) — d(1) = d_end exactly', () => {
    // seam_k = 1 puts d_seam at parkDist; seam_k = 0 puts it at zero
    // (below park, which the implementation treats the same way). Both
    // run pure piecewise-quad on linear-d across [d0, d_end].
    for (const seamK of [0, 0.5, 1]) {
      expect(easeHybrid(0, D0, D_END, R_SOL, seamK)).toBeCloseTo(0, 10);
      expect(easeHybrid(1, D0, D_END, R_SOL, seamK)).toBeCloseTo(1, 10);
      // Mid-warp should match piecewise-quad on linear-d.
      const f = easeHybrid(0.5, D0, D_END, R_SOL, seamK);
      const dActual = dOf(f);
      const dExpected = D0 - 0.5 * (D0 - D_END);
      expect(dActual).toBeCloseTo(dExpected, 6);
    }
  });

  it('null R fallback — bit-equal to cubic-Hermite across u', () => {
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      expect(easeHybrid(u, D0, D_END, null, SEAM_K)).toBe(cubicHermite(u));
    }
  });

  it('outbound (d_end > d_0) fallback — bit-equal to cubic-Hermite', () => {
    const dOutStart = 1e-5;
    const dOutEnd = 2e-5;
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      expect(easeHybrid(u, dOutStart, dOutEnd, R_SOL, SEAM_K))
        .toBe(cubicHermite(u));
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

describe('hybridUSeam', () => {
  const R = 2.3e-8;
  const D0 = 10;
  const D_END = 2.4e-5;

  it('returns -1 when targetRadius is null (fallback mode)', () => {
    expect(hybridUSeam(D0, D_END, null, 100)).toBe(-1);
    expect(hybridUSeam(D0, D_END, 0, 100)).toBe(-1);
    expect(hybridUSeam(D0, D_END, -1, 100)).toBe(-1);
  });

  it('returns -1 when trajectory is outbound (fallback mode)', () => {
    expect(hybridUSeam(1e-5, 2e-5, R, 100)).toBe(-1);
    expect(hybridUSeam(D_END, D0, R, 100)).toBe(-1);
  });

  it('returns 1 when seam_k <= 1 (pure outer regime)', () => {
    expect(hybridUSeam(D0, D_END, R, 0)).toBe(1);
    expect(hybridUSeam(D0, D_END, R, 0.5)).toBe(1);
    expect(hybridUSeam(D0, D_END, R, 1)).toBe(1);
  });

  it('returns 0 when d_seam >= d_0 (pure inner regime)', () => {
    // d_0 inside the seam radius.
    const closeD0 = 50 * D_END; // seam_k 100 → d_seam = 100·D_END > closeD0
    expect(hybridUSeam(closeD0, D_END, R, 100)).toBe(0);
  });

  it('returns clamped value in [0.3, 0.85] for normal hybrid cases', () => {
    // Default seam_k = 100 with Sol-from-10-pc — should be inside the
    // clamp window.
    const u = hybridUSeam(D0, D_END, R, 100);
    expect(u).toBeGreaterThanOrEqual(0.3);
    expect(u).toBeLessThanOrEqual(0.85);
  });

  it('matches the log-proportional formula inside the clamp window', () => {
    const seamK = 200;
    const dSeam = seamK * D_END;
    const expected = Math.log(D0 / dSeam) / Math.log(D0 / D_END);
    expect(hybridUSeam(D0, D_END, R, seamK)).toBeCloseTo(expected, 10);
  });
});

describe('resolveHybridCurve', () => {
  it('returns cubic-Hermite when ctx is missing', () => {
    const fn = resolveHybridCurve(100);
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      expect(fn(u)).toBe(cubicHermite(u));
    }
  });

  it('captures ctx + seam_k at resolve time', () => {
    const ctx = { d0: 10, dEnd: 2.4e-5, targetRadius: 2.3e-8 };
    const fn = resolveHybridCurve(100, ctx);
    expect(fn(0)).toBeCloseTo(0, 10);
    expect(fn(1)).toBeCloseTo(1, 10);
    // Closure agrees with the direct easeHybrid call at the same u.
    expect(fn(0.5)).toBeCloseTo(
      easeHybrid(0.5, ctx.d0, ctx.dEnd, ctx.targetRadius, 100),
      12,
    );
  });

  it('null-R ctx falls back to cubic-Hermite via the closure', () => {
    const fn = resolveHybridCurve(100, {
      d0: 10,
      dEnd: 2.4e-5,
      targetRadius: null,
    });
    expect(fn(0.5)).toBe(cubicHermite(0.5));
  });
});
