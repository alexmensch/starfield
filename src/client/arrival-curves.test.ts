import { describe, expect, it } from 'vitest';
import {
  easeCubicHermite,
  easeQuinticHermite,
  easePower,
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

describe('resolveArrivalCurve', () => {
  it('cubic-hermite branch', () => {
    const fn = resolveArrivalCurve('cubic-hermite', 2);
    expect(fn(0.5)).toBeCloseTo(easeCubicHermite(0.5), 12);
  });
  it('quintic-hermite branch', () => {
    const fn = resolveArrivalCurve('quintic-hermite', 2);
    expect(fn(0.5)).toBeCloseTo(easeQuinticHermite(0.5), 12);
  });
  it('power branch captures p at resolve time', () => {
    const fn2 = resolveArrivalCurve('power', 2);
    const fn3 = resolveArrivalCurve('power', 3);
    expect(fn2(0.5)).toBeCloseTo(0.25, 12);
    expect(fn3(0.5)).toBeCloseTo(0.125, 12);
    // Both stay independent if the caller resolves with different p values.
  });
});
