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

  it('falls back to Lambert when α exceeds the validity bound', () => {
    // Mars: alphaMaxDeg = 50°. At 60° we want Lambert, not the
    // extrapolated polynomial (which would over-brighten).
    const a = 60 * DEG;
    expect(mallamaPhaseFactor(MARS_PHASE, a))
      .toBeCloseTo(lambertianPhaseFactor(a), 12);
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
