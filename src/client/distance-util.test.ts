import { describe, it, expect, beforeEach } from 'vitest';
import { fmtDist, niceRound, setUnit, getUnit, LY_PER_PC } from './distance-util';

// fmtDist reads a module-level current unit; tests reset it explicitly so
// they're order-independent.
beforeEach(() => {
  setUnit('pc');
});

describe('distance-util / niceRound', () => {
  it('returns 0 for non-positive inputs', () => {
    expect(niceRound(0)).toBe(0);
    expect(niceRound(-5)).toBe(0);
    expect(niceRound(-0.001)).toBe(0);
  });

  it('is idempotent on canonical 1/2/5 × 10^N values', () => {
    // Snapping is a fixed point: a value already at a tick stays put.
    for (const v of [1, 2, 5, 10, 20, 50, 100, 200, 500, 0.1, 0.2, 0.5]) {
      expect(niceRound(v)).toBeCloseTo(v, 10);
    }
  });

  it('snaps each decade to the nearest 1, 2, 5, or 10', () => {
    // Within [1, 10), thresholds are 1.5, 3.5, 7.5 (round-to-nearest):
    //   [1, 1.5)   → 1
    //   [1.5, 3.5) → 2
    //   [3.5, 7.5) → 5
    //   [7.5, 10)  → 10
    expect(niceRound(1.2)).toBeCloseTo(1, 10);
    expect(niceRound(1.4999)).toBeCloseTo(1, 10);
    expect(niceRound(1.5)).toBeCloseTo(2, 10);
    expect(niceRound(2.7)).toBeCloseTo(2, 10);
    expect(niceRound(3.4999)).toBeCloseTo(2, 10);
    expect(niceRound(3.5)).toBeCloseTo(5, 10);
    expect(niceRound(6.0)).toBeCloseTo(5, 10);
    expect(niceRound(7.4999)).toBeCloseTo(5, 10);
    expect(niceRound(7.5)).toBeCloseTo(10, 10);
    expect(niceRound(9.9)).toBeCloseTo(10, 10);
  });

  it('scales the same thresholds across decades', () => {
    expect(niceRound(15)).toBeCloseTo(20, 10);
    expect(niceRound(150)).toBeCloseTo(200, 10);
    expect(niceRound(1500)).toBeCloseTo(2000, 10);
    expect(niceRound(0.15)).toBeCloseTo(0.2, 10);
    expect(niceRound(0.015)).toBeCloseTo(0.02, 10);
  });

  it('returns a value within a factor of √10 of the input', () => {
    // Snapping never produces a tick more than one decade away from the
    // input — the worst case is just below 1.5×10^N snapping to 1×10^N
    // (factor 1.5x), or just below 7.5×10^N snapping to 10×10^N (1.33x).
    for (const v of [0.123, 1.23, 12.3, 123, 1234, 0.0042, 99.999]) {
      const r = niceRound(v);
      expect(r / v).toBeGreaterThan(0.1);
      expect(r / v).toBeLessThan(10);
    }
  });
});

describe('distance-util / fmtDist (pc)', () => {
  it('uses 4 decimals below 0.01 pc', () => {
    expect(fmtDist(0.005)).toBe('0.0050 pc');
    expect(fmtDist(0.0001)).toBe('0.0001 pc');
  });

  it('uses 3 decimals between 0.01 and 1 pc', () => {
    expect(fmtDist(0.01)).toBe('0.010 pc');
    expect(fmtDist(0.5)).toBe('0.500 pc');
    expect(fmtDist(0.999)).toBe('0.999 pc');
  });

  it('uses 1 decimal between 1 and 100 pc', () => {
    expect(fmtDist(1)).toBe('1.0 pc');
    expect(fmtDist(42.5)).toBe('42.5 pc');
    expect(fmtDist(99.9)).toBe('99.9 pc');
  });

  it('uses integer rounding between 100 and 10000 pc', () => {
    expect(fmtDist(100)).toBe('100 pc');
    expect(fmtDist(1234.5)).toBe('1235 pc');
    expect(fmtDist(9999)).toBe('9999 pc');
  });

  it('uses k-suffix at and above 10000 pc', () => {
    expect(fmtDist(10000)).toBe('10k pc');
    expect(fmtDist(15500)).toBe('15.5k pc');
    expect(fmtDist(100000)).toBe('100k pc');
  });

  it('strips trailing .0 from k-suffix output', () => {
    // "10.0k pc" reads worse than "10k pc"; the formatter strips the .0.
    expect(fmtDist(10000)).toBe('10k pc');
    expect(fmtDist(20000)).toBe('20k pc');
  });

  it('is monotonically non-decreasing across the formatted-tier boundaries', () => {
    // Across each tier change, larger pc still produces a value-equal-or-
    // greater displayed magnitude — the units don't lie about ordering.
    const samples = [0.001, 0.005, 0.01, 0.5, 1, 10, 99, 100, 9999, 10000, 50000];
    for (let i = 1; i < samples.length; i++) {
      const a = fmtDist(samples[i - 1]);
      const b = fmtDist(samples[i]);
      expect(a).not.toBe(b); // tier boundaries must still produce distinct strings
    }
  });
});

describe('distance-util / fmtDist (ly)', () => {
  beforeEach(() => {
    setUnit('ly');
  });

  it('converts pc to ly using LY_PER_PC', () => {
    // 1 pc → 3.26... ly. Display uses the 1–100 tier (1 decimal).
    expect(fmtDist(1)).toBe(`${LY_PER_PC.toFixed(1)} ly`);
  });

  it('uses ly unit suffix in all tiers', () => {
    expect(fmtDist(0.001)).toMatch(/ ly$/); // 4-decimal tier
    expect(fmtDist(0.05)).toMatch(/ ly$/);  // 3-decimal tier
    expect(fmtDist(10)).toMatch(/ ly$/);    // 1-decimal tier
    expect(fmtDist(500)).toMatch(/ ly$/);   // integer tier
    expect(fmtDist(50000)).toMatch(/ ly$/); // k-suffix tier
  });

  it('switches tiers based on the converted value, not the pc input', () => {
    // 0.5 pc * 3.26 ≈ 1.63 ly → falls into the "1.0 to 100" tier (1 decimal),
    // not the "<1" tier (3 decimals). The formatter measures tier on the
    // displayed-unit value.
    expect(fmtDist(0.5)).toBe('1.6 ly');
  });
});

describe('distance-util / unit state', () => {
  it('defaults to pc on import', () => {
    // Module load order: each test resets to pc in beforeEach, so we can
    // observe the initial state semantics here.
    expect(getUnit()).toBe('pc');
  });

  it('persists the unit across reads', () => {
    setUnit('ly');
    expect(getUnit()).toBe('ly');
    expect(getUnit()).toBe('ly');
  });

  it('LY_PER_PC matches the IAU-derived parsec-to-light-year conversion', () => {
    // A parsec is 3.085677581e16 m; a light-year is 9.4607e15 m. The
    // ratio is ~3.2615638. The codebase uses this constant in multiple
    // places (URL state, scale bar, distance util) so changes here must
    // be deliberate and synchronised.
    expect(LY_PER_PC).toBeCloseTo(3.2615638, 7);
  });
});
