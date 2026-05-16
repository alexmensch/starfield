import { describe, expect, it } from 'vitest';
import { chartPlateauDistancePc } from './chart-disc-pure';

describe('chartPlateauDistancePc', () => {
  it('matches the worked Sol example (M = 4.83, magBright = -2): ~0.43 pc', () => {
    const d = chartPlateauDistancePc(4.83, -2.0);
    expect(d).toBeCloseTo(0.4305, 3);
  });

  it('matches the worked Betelgeuse example (M = -5.85, magBright = -2): ~58.9 pc', () => {
    const d = chartPlateauDistancePc(-5.85, -2.0);
    expect(d).toBeCloseTo(58.88, 1);
  });

  it('Sirius (M = 1.42, magBright = -2): ~2.07 pc', () => {
    const d = chartPlateauDistancePc(1.42, -2.0);
    expect(d).toBeCloseTo(2.073, 2);
  });

  it('distance-modulus identity: magBright == absMag plateaus at exactly 10 pc', () => {
    // appMag = absMag + 5·log10(d/10), so appMag == absMag iff d = 10 pc.
    // Pin the plateau formula against the distance-modulus identity at
    // the well-known reference point.
    expect(chartPlateauDistancePc(3, 3)).toBeCloseTo(10, 6);
    expect(chartPlateauDistancePc(-2, -2)).toBeCloseTo(10, 6);
  });

  it('moves with magBright: a brighter threshold pushes plateau closer in', () => {
    const at_neg2 = chartPlateauDistancePc(4.83, -2.0);
    const at_neg4 = chartPlateauDistancePc(4.83, -4.0);
    // -4 is brighter than -2 → plateau requires a closer (smaller-d) viewpoint
    expect(at_neg4).toBeLessThan(at_neg2);
    // Specifically, every 5 magnitudes of brightening = factor-10 in distance,
    // so 2 mag brighter = factor-10^(2/5) ≈ 0.398.
    expect(at_neg4 / at_neg2).toBeCloseTo(Math.pow(10, -0.4), 6);
  });

  it('intrinsically too dim: plateau distance < 1 pc when star never crosses threshold from outside', () => {
    // A star with absMag = 10, magBright = -2 would need to be at
    // 10^((-2-10+5)/5) = 10^(-1.4) ≈ 0.0398 pc to plateau. The function
    // returns the literal solution — caller gates on it being reachable.
    expect(chartPlateauDistancePc(10, -2)).toBeCloseTo(0.0398, 4);
  });
});
