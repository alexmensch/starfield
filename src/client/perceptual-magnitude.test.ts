import { describe, it, expect } from 'vitest';
import {
  apparentMagnitude,
  perceptualDmEff,
  perceptualAppSizePx,
} from './perceptual-magnitude';

describe('apparentMagnitude', () => {
  it('returns the absolute magnitude at 10 pc by definition', () => {
    expect(apparentMagnitude(0, 10)).toBeCloseTo(0, 12);
    expect(apparentMagnitude(4.83, 10)).toBeCloseTo(4.83, 12); // Sol
  });

  it('adds 5 mag per decade of distance', () => {
    expect(apparentMagnitude(0, 100)).toBeCloseTo(5, 12);
    expect(apparentMagnitude(0, 1000)).toBeCloseTo(10, 12);
  });

  it('subtracts 5 mag per decade closer than 10 pc', () => {
    expect(apparentMagnitude(0, 1)).toBeCloseTo(-5, 12);
  });

  it('lands Sol from Earth at the textbook value', () => {
    // 1 AU = 4.8481368e-6 pc
    const m = apparentMagnitude(4.83, 4.8481368e-6);
    expect(m).toBeCloseTo(-26.74, 1);
  });

  it('does not divide by zero at d = 0', () => {
    expect(Number.isFinite(apparentMagnitude(0, 0))).toBe(true);
  });
});

describe('perceptualDmEff', () => {
  // 'all' preset values — sizeSpan=17, knee=16 from STAR_RENDER_DEFAULTS.
  const SPAN = 17;
  const KNEE = 16;
  const CUTOFF = 15;

  it('returns 0 at the visibility cutoff', () => {
    expect(perceptualDmEff(CUTOFF, CUTOFF, SPAN, KNEE)).toBe(0);
  });

  it('clamps to 0 for sources fainter than the cutoff', () => {
    expect(perceptualDmEff(CUTOFF + 1, CUTOFF, SPAN, KNEE)).toBe(0);
    expect(perceptualDmEff(20, CUTOFF, SPAN, KNEE)).toBe(0);
  });

  it('is identity inside the linear region (dM ≤ sizeSpan)', () => {
    // appMag = 0 → dM = 15; dM ≤ sizeSpan=17 → identity.
    expect(perceptualDmEff(0, CUTOFF, SPAN, KNEE)).toBeCloseTo(15, 12);
    // appMag = -2 (Sirius-bright) → dM = 17 → exactly the boundary.
    expect(perceptualDmEff(-2, CUTOFF, SPAN, KNEE)).toBeCloseTo(17, 12);
  });

  it('asymptotes to (sizeSpan + sizeKnee) for super-bright sources', () => {
    // appMag = -1000 → dM = 1015. Asymptote = 17 + 16 = 33.
    const v = perceptualDmEff(-1000, CUTOFF, SPAN, KNEE);
    expect(v).toBeLessThan(SPAN + KNEE);
    expect(v).toBeGreaterThan(SPAN + KNEE - 0.5); // close to asymptote
  });

  it('continuous across the dM = sizeSpan boundary', () => {
    // ε on either side of the knee transition should produce nearly-
    // equal outputs (the formula is C0 by construction).
    const eps = 1e-9;
    const below = perceptualDmEff(CUTOFF - SPAN + eps, CUTOFF, SPAN, KNEE);
    const above = perceptualDmEff(CUTOFF - SPAN - eps, CUTOFF, SPAN, KNEE);
    expect(Math.abs(above - below)).toBeLessThan(1e-6);
  });

  it('sizeKnee = 0 hard-clamps at sizeSpan (legacy behaviour)', () => {
    // Above the knee, with knee=0, the bend collapses to a flat ceiling.
    expect(perceptualDmEff(-1000, CUTOFF, SPAN, 0)).toBeCloseTo(SPAN, 12);
  });
});

describe('perceptualAppSizePx', () => {
  it('returns sizeMin at dMEff = 0', () => {
    expect(perceptualAppSizePx(0, 2, 24, 17)).toBeCloseTo(2, 12);
  });

  it('returns sizeMax at dMEff = sizeSpan', () => {
    expect(perceptualAppSizePx(17, 2, 24, 17)).toBeCloseTo(24, 12);
  });

  it('halfway in dMEff lands at sqrt(0.5) blend (= ~70.7%)', () => {
    // dMEff/span = 0.5 → t = sqrt(0.5) ≈ 0.707 → ~17.6 between [2, 24].
    const v = perceptualAppSizePx(8.5, 2, 24, 17);
    const expected = 2 + Math.sqrt(0.5) * (24 - 2);
    expect(v).toBeCloseTo(expected, 12);
  });

  it('is monotone increasing in dMEff', () => {
    let prev = -Infinity;
    for (let dMEff = 0; dMEff <= 30; dMEff += 0.5) {
      const v = perceptualAppSizePx(dMEff, 2, 24, 17);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('keeps Sol-vs-Canopus ratio meaningful with a non-zero knee', () => {
    // Two sources both bright enough to clear the linear ceiling
    // (dM > sizeSpan = 17 → both above the knee). With knee=0 they
    // hard-clamp to the same dMEff and render at the same disc size;
    // with knee>0 the brighter one stays meaningfully larger.
    const SPAN = 17;
    const KNEE = 16;
    // Canopus appMag ≈ -5 → dM = 20; Sol close-approach appMag ≈ -26
    // → dM = 41. Both above SPAN.
    const solSoft = perceptualAppSizePx(
      perceptualDmEff(-26, 15, SPAN, KNEE), 2, 24, SPAN);
    const canSoft = perceptualAppSizePx(
      perceptualDmEff(-5, 15, SPAN, KNEE), 2, 24, SPAN);
    expect(solSoft).toBeGreaterThan(canSoft + 0.5); // visibly different
    // Hard-clamp variant (knee=0) collapses the difference — both
    // hit the same dMEff = sizeSpan and therefore the same appSize.
    const solHard = perceptualAppSizePx(
      perceptualDmEff(-26, 15, SPAN, 0), 2, 24, SPAN);
    const canHard = perceptualAppSizePx(
      perceptualDmEff(-5, 15, SPAN, 0), 2, 24, SPAN);
    expect(Math.abs(solHard - canHard)).toBeLessThan(1e-9);
  });
});
