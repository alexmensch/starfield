import { describe, it, expect } from 'vitest';
import {
  EARTH_PHASE,
  JUPITER_PHASE,
  MARS_PHASE,
  MERCURY_PHASE,
  SATURN_PHASE,
  VENUS_PHASE,
  type PhaseCoefficients,
  lambertianPhaseFactor,
  mallamaPhaseFactor,
  peakPhaseFactor,
} from './phase-function';

const DEG = Math.PI / 180;

describe('lambertianPhaseFactor', () => {
  it('returns 1 at full phase (α = 0)', () => {
    expect(lambertianPhaseFactor(0)).toBeCloseTo(1, 12);
  });

  it('returns 0 at new phase (α = π)', () => {
    expect(lambertianPhaseFactor(Math.PI)).toBeCloseTo(0, 12);
  });

  it('returns 1/π at half phase (α = π/2)', () => {
    expect(lambertianPhaseFactor(Math.PI / 2)).toBeCloseTo(1 / Math.PI, 12);
  });

  it('is monotone decreasing in α over [0, π]', () => {
    let prev = Infinity;
    for (let a = 0; a <= Math.PI; a += 0.05) {
      const v = lambertianPhaseFactor(a);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('clamps α defensively outside [0, π]', () => {
    expect(lambertianPhaseFactor(-1)).toBeCloseTo(1, 12);
    expect(lambertianPhaseFactor(Math.PI + 1)).toBeCloseTo(0, 12);
  });
});

describe('mallamaPhaseFactor', () => {
  it('returns Lambertian when alphaMaxDeg sentinel = 0', () => {
    const empty: PhaseCoefficients = {
      c0: 0, c1: 0, c2: 0, c3: 0, c4: 0, c5: 0, c6: 0, alphaMaxDeg: 0,
    };
    for (const aDeg of [0, 30, 90, 150]) {
      expect(mallamaPhaseFactor(empty, aDeg * DEG))
        .toBeCloseTo(lambertianPhaseFactor(aDeg * DEG), 12);
    }
  });

  it('beyond αmax: anchor-scaled Lambert (continuous at the boundary)', () => {
    // Mars: alphaMaxDeg = 50°. At 60° we want
    //   Lambert(60°) × poly(50°) / Lambert(50°)
    // — anchor-scaled, NOT pure Lambert (which would step) and NOT
    // the extrapolated polynomial (which would over-brighten).
    const aMax = MARS_PHASE.alphaMaxDeg * DEG;
    const polyAtBoundary = mallamaPhaseFactor(MARS_PHASE, aMax);
    const lambertAtBoundary = lambertianPhaseFactor(aMax);
    const k = polyAtBoundary / lambertAtBoundary;
    const a60 = 60 * DEG;
    expect(mallamaPhaseFactor(MARS_PHASE, a60))
      .toBeCloseTo(lambertianPhaseFactor(a60) * k, 10);
    // Mars darkens faster than a Lambertian sphere at moderate α:
    // k < 1, so the anchor-scaled Lambert past 50° stays dimmer than
    // pure Lambert.
    expect(k).toBeLessThan(1);
  });

  it('Saturn continuity: no brightness step across α = αmax', () => {
    // Saturn's c0 = −0.55 lifts polynomial flux to ~1.42 just inside
    // αmax = 6.5°; pure Lambert at 6.5° is ~0.99, so the prior
    // implementation showed a ~30% brightness drop at the boundary.
    // Anchor-scaled Lambert past αmax eliminates the step by
    // construction (right-limit ≡ left-limit).
    const eps = 1e-6;
    const aMax = SATURN_PHASE.alphaMaxDeg * DEG;
    const lhs = mallamaPhaseFactor(SATURN_PHASE, aMax - eps);
    const rhs = mallamaPhaseFactor(SATURN_PHASE, aMax + eps);
    expect(rhs).toBeCloseTo(lhs, 5);
    // Sanity: the anchor preserves Saturn's ring boost past αmax —
    // anchored Lambert sits well above 1, not the ~0.99 a naive
    // Lambert would give.
    expect(rhs).toBeGreaterThan(1.4);
  });

  it('Mars continuity: no brightness step across α = αmax', () => {
    // Same continuity check for Mars (smaller jump, opposite
    // direction — polynomial dimmer than Lambert at 50°).
    const eps = 1e-6;
    const aMax = MARS_PHASE.alphaMaxDeg * DEG;
    const lhs = mallamaPhaseFactor(MARS_PHASE, aMax - eps);
    const rhs = mallamaPhaseFactor(MARS_PHASE, aMax + eps);
    expect(rhs).toBeCloseTo(lhs, 5);
  });

  it('clamps α defensively outside [0, π] (sibling-symmetric with Lambert)', () => {
    // Negative α → clamped to 0. For c0 = 0 planets, the polynomial
    // value at α = 0 is exactly 1.
    expect(mallamaPhaseFactor(MARS_PHASE, -1)).toBeCloseTo(1, 12);
    // α > π → clamped to π. π in degrees = 180°, beyond every
    // published αmax, so this lands on the anchor-Lambert path with
    // Lambert(π) = 0 ⇒ φ = 0 regardless of the anchor multiplier.
    expect(mallamaPhaseFactor(MARS_PHASE, Math.PI + 1)).toBeCloseTo(0, 12);
    // Saturn at negative α → clamped to 0 → polynomial gives the c0
    // ring boost (≈ 1.66×). Defensive symmetry: a misuse with
    // out-of-range α can't trigger Horner extrapolation.
    expect(mallamaPhaseFactor(SATURN_PHASE, -1)).toBeCloseTo(
      10 ** (0.55 / 2.5),
      6,
    );
  });

  it('returns 1 at α = 0 for every planet with c0 = 0', () => {
    // Saturn opts out — see the Saturn-specific test below.
    const planets: [string, PhaseCoefficients][] = [
      ['Mercury', MERCURY_PHASE],
      ['Venus', VENUS_PHASE],
      ['Earth', EARTH_PHASE],
      ['Mars', MARS_PHASE],
      ['Jupiter', JUPITER_PHASE],
    ];
    for (const [name, p] of planets) {
      const v = mallamaPhaseFactor(p, 0);
      expect(v, `${name} α=0`).toBeCloseTo(1, 12);
    }
  });

  it('Saturn at α = 0 is brighter than 1× (ring boost)', () => {
    // c0 = -0.55 mag → 10^(0.55/2.5) ≈ 1.660.
    const v = mallamaPhaseFactor(SATURN_PHASE, 0);
    expect(v).toBeCloseTo(10 ** (0.55 / 2.5), 6);
    expect(v).toBeGreaterThan(1.6);
    expect(v).toBeLessThan(1.7);
  });

  it('Mercury truncation budget: degree-6 vs full Mallama 7th-order', () => {
    // Mallama 2018 Table A-1.2 publishes Mercury as a degree-7
    // polynomial. We drop c7 = 6.592e-15 to fit degree-6 storage.
    // This test pins the storage truncation independently of the
    // αmax handover (it evaluates the truncated polynomial directly,
    // so the αmax = 87° cap doesn't interfere). It motivates the
    // αmax choice: past 88° the c7·α⁷ term dominates and the
    // truncated polynomial is no longer faithful — αmax is set so
    // the polynomial path stops where the budget breaks.
    const c7 = 6.592e-15;
    const directTruncDV = (aDeg: number): number =>
      MERCURY_PHASE.c0 +
      aDeg *
        (MERCURY_PHASE.c1 +
          aDeg *
            (MERCURY_PHASE.c2 +
              aDeg *
                (MERCURY_PHASE.c3 +
                  aDeg *
                    (MERCURY_PHASE.c4 +
                      aDeg * (MERCURY_PHASE.c5 + aDeg * MERCURY_PHASE.c6)))));
    const fullDV = (aDeg: number): number =>
      directTruncDV(aDeg) + c7 * aDeg ** 7;
    // Sub-0.25 mag out to ≈87° (where c7·α^7 first exceeds 0.25).
    for (let aDeg = 0; aDeg <= 84; aDeg += 4) {
      const err = Math.abs(directTruncDV(aDeg) - fullDV(aDeg));
      expect(err, `α=${aDeg}°`).toBeLessThan(0.25);
    }
    // The cutoff: just under 0.25 at 87°, just over at 88°. This is
    // why MERCURY_PHASE.alphaMaxDeg is 87 (not Mallama's published
    // 170° validity range — the truncation, not the source data,
    // sets our usable bound).
    expect(Math.abs(directTruncDV(87) - fullDV(87))).toBeLessThan(0.25);
    expect(Math.abs(directTruncDV(88) - fullDV(88))).toBeGreaterThan(0.25);
    expect(MERCURY_PHASE.alphaMaxDeg).toBe(87);
    // Spot-checks at higher α — pin the actual budget so future
    // edits to c0..c6 can't drift undetected.
    expect(Math.abs(directTruncDV(100) - fullDV(100))).toBeCloseTo(0.659, 2);
    expect(Math.abs(directTruncDV(120) - fullDV(120))).toBeCloseTo(2.362, 2);
    expect(Math.abs(directTruncDV(170) - fullDV(170))).toBeCloseTo(27.05, 1);
  });

  it('Mercury at high α tracks Mallama via anchor-Lambert (within 0.5 mag)', () => {
    // αmax = 87° hands over to anchor-scaled Lambert. Across
    // 90°–170° the anchor approximation tracks the published
    // 7th-order Mallama curve to within 0.5 mag — at high α
    // Mercury reads as a thin crescent dominated by geometric
    // `(sin α + (π−α)·cos α)/π` falloff, and the anchor multiplier
    // `k = poly(87°)/Lambert(87°)` provides the normalization to
    // match Mallama at the handover. Without this rule (αmax = 170°
    // letting the truncated polynomial run all the way out) Mercury
    // renders 27 mag too bright at α = 170° — apparent V ≈ −18
    // instead of the real ≈ +8. Pin the physical fidelity.
    const c7 = 6.592e-15;
    const fullDV = (aDeg: number): number =>
      MERCURY_PHASE.c0 +
      aDeg *
        (MERCURY_PHASE.c1 +
          aDeg *
            (MERCURY_PHASE.c2 +
              aDeg *
                (MERCURY_PHASE.c3 +
                  aDeg *
                    (MERCURY_PHASE.c4 +
                      aDeg *
                        (MERCURY_PHASE.c5 +
                          aDeg * (MERCURY_PHASE.c6 + aDeg * c7))))));
    const renderedDV = (aDeg: number): number => {
      const factor = mallamaPhaseFactor(MERCURY_PHASE, aDeg * DEG);
      return (-Math.log(factor) * 2.5) / Math.log(10);
    };
    for (let aDeg = 90; aDeg <= 170; aDeg += 10) {
      const err = Math.abs(renderedDV(aDeg) - fullDV(aDeg));
      expect(err, `α=${aDeg}°`).toBeLessThan(0.55);
    }
    // Brightness must be MONOTONE DECREASING with α past αmax (the
    // physical sanity check Alex flagged: a thin crescent should get
    // dimmer, not brighter, as α grows). ΔV grows ⇒ flux falls.
    let prev = -Infinity;
    for (let aDeg = 90; aDeg <= 170; aDeg += 10) {
      const dV = renderedDV(aDeg);
      expect(dV, `α=${aDeg}°`).toBeGreaterThan(prev);
      prev = dV;
    }
  });

  it('Mercury polynomial reproduces published ΔV at α = 30°', () => {
    // Mallama 2018 Table A-1.2 V-band coefficients evaluated at 30°.
    // Hand-checked to land near 1.15 mag. This is a sanity bound,
    // not a hard pin.
    const a = 30 * DEG;
    const factor = mallamaPhaseFactor(MERCURY_PHASE, a);
    const dV = -Math.log(factor) * 2.5 / Math.log(10);
    expect(dV).toBeGreaterThan(1.0);
    expect(dV).toBeLessThan(1.3);
  });

  it('Earth polynomial passes through the Mallama 2018 Table A-3.1 anchor points', () => {
    // The fit was constructed to pass exactly through (45°, 1.123),
    // (90°, 2.069), (135°, 3.801) — the published table values.
    for (const [aDeg, expectedDV] of [
      [45, 1.123],
      [90, 2.069],
      [135, 3.801],
    ] as const) {
      const factor = mallamaPhaseFactor(EARTH_PHASE, aDeg * DEG);
      const dV = -Math.log(factor) * 2.5 / Math.log(10);
      expect(dV, `Earth α=${aDeg}°`).toBeCloseTo(expectedDV, 2);
    }
  });

  it('Venus is brighter than Lambert at large α (atmospheric forward-scattering)', () => {
    // The defining win for Venus from the bead description: at large
    // phase angle Venus's atmosphere forward-scatters, leaving the
    // crescent meaningfully brighter than a perfectly diffuse sphere
    // would predict. The asymmetry grows with α — at 130° Mallama
    // is ~1.6× Lambert; by 160° it's nearly an order of magnitude.
    const a130 = 130 * DEG;
    expect(mallamaPhaseFactor(VENUS_PHASE, a130))
      .toBeGreaterThan(lambertianPhaseFactor(a130) * 1.4);
    const a160 = 160 * DEG;
    expect(mallamaPhaseFactor(VENUS_PHASE, a160))
      .toBeGreaterThan(lambertianPhaseFactor(a160) * 5);
  });

  it('all curves return positive, finite factors over their validity range', () => {
    const all = [
      MERCURY_PHASE, VENUS_PHASE, EARTH_PHASE, MARS_PHASE,
      JUPITER_PHASE, SATURN_PHASE,
    ];
    for (const p of all) {
      for (let aDeg = 0; aDeg <= p.alphaMaxDeg; aDeg += 0.5) {
        const v = mallamaPhaseFactor(p, aDeg * DEG);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
  });
});

describe('peakPhaseFactor', () => {
  it('returns 1 for undefined coefficients (Lambertian fallback)', () => {
    expect(peakPhaseFactor(undefined)).toBe(1);
  });

  it('returns 1 for any zeroed-out planet (c0 = 0)', () => {
    expect(peakPhaseFactor(EARTH_PHASE)).toBeCloseTo(1, 12);
    expect(peakPhaseFactor(JUPITER_PHASE)).toBeCloseTo(1, 12);
  });

  it('returns the c0-boost flux multiplier for Saturn', () => {
    expect(peakPhaseFactor(SATURN_PHASE)).toBeCloseTo(10 ** (0.55 / 2.5), 6);
  });

  it('returns 1 when alphaMaxDeg = 0 (sentinel — Mallama disabled)', () => {
    const sentinel: PhaseCoefficients = {
      c0: -1, c1: 0, c2: 0, c3: 0, c4: 0, c5: 0, c6: 0, alphaMaxDeg: 0,
    };
    expect(peakPhaseFactor(sentinel)).toBe(1);
  });
});
