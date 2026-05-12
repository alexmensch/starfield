import { describe, it, expect } from 'vitest';
import { solveKepler, wrapAngle } from './kepler-solver';

describe('wrapAngle', () => {
  it('leaves angles in (-π, π] alone', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBe(Math.PI);
    expect(wrapAngle(-Math.PI + 1e-9)).toBeCloseTo(-Math.PI + 1e-9, 12);
    expect(wrapAngle(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('wraps angles above π down by 2π', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(2 * Math.PI + 0.5)).toBeCloseTo(0.5, 12);
  });

  it('wraps angles below -π up by 2π', () => {
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-2 * Math.PI - 0.5)).toBeCloseTo(-0.5, 12);
  });

  it('is idempotent — wrapping twice equals wrapping once', () => {
    for (const a of [-10, -5.5, -0.1, 0.1, 5.5, 10, 100]) {
      expect(wrapAngle(wrapAngle(a))).toBeCloseTo(wrapAngle(a), 12);
    }
  });
});

describe('solveKepler', () => {
  it('returns E = M when e = 0 (circular orbit)', () => {
    for (const M of [-1, 0, 0.5, 1, 2]) {
      expect(solveKepler(M, 0)).toBeCloseTo(wrapAngle(M), 12);
    }
  });

  it('satisfies the defining equation M = E − e·sin(E) for low/moderate e', () => {
    const eccs = [0, 0.05, 0.3, 0.591, 0.9];
    const Ms = [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3, 2.5];
    for (const e of eccs) {
      for (const M of Ms) {
        const E = solveKepler(M, e);
        const residual = E - e * Math.sin(E) - wrapAngle(M);
        expect(Math.abs(residual)).toBeLessThan(1e-10);
      }
    }
  });

  it('converges to the defining equation for high eccentricity (e = 0.95)', () => {
    const e = 0.95;
    for (const M of [0.001, 0.1, 1.0, Math.PI / 2, Math.PI - 0.01, 2.0]) {
      const E = solveKepler(M, e);
      const residual = E - e * Math.sin(E) - wrapAngle(M);
      expect(Math.abs(residual)).toBeLessThan(1e-10);
    }
  });

  it('returns E = 0 at M = 0 for any eccentricity', () => {
    for (const e of [0, 0.3, 0.6, 0.9, 0.99]) {
      expect(solveKepler(0, e)).toBeCloseTo(0, 12);
    }
  });

  it('returns E = π at M = π (apoapsis) for any eccentricity', () => {
    for (const e of [0, 0.3, 0.6, 0.9]) {
      expect(Math.abs(solveKepler(Math.PI, e))).toBeCloseTo(Math.PI, 10);
    }
  });

  it('handles unwrapped M (multiple revolutions in either direction)', () => {
    const e = 0.3;
    const E0 = solveKepler(0.7, e);
    const E1 = solveKepler(0.7 + 4 * Math.PI, e);
    const E2 = solveKepler(0.7 - 6 * Math.PI, e);
    expect(E1).toBeCloseTo(E0, 10);
    expect(E2).toBeCloseTo(E0, 10);
  });
});
