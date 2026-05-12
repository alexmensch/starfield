import { describe, expect, it } from 'vitest';
import {
  AU_KM,
  AU_PC,
  AU_PER_PC,
  J2000_JD,
  KM_PC,
  R_SUN_PC,
} from './astronomy-constants';

describe('astronomy-constants', () => {
  it('AU_PER_PC matches the IAU 2015 parsec definition', () => {
    expect(AU_PER_PC).toBe(206264.80624709636);
    // 1 pc = 648000/π AU. Verify against the first-principles definition.
    expect(AU_PER_PC).toBeCloseTo(648000 / Math.PI, 9);
  });

  it('AU_PC is the reciprocal of AU_PER_PC', () => {
    expect(AU_PC).toBe(1 / 206264.80624709636);
    expect(AU_PER_PC * AU_PC).toBeCloseTo(1, 15);
  });

  it('AU_KM is the IAU 2012 exact value', () => {
    expect(AU_KM).toBe(1.495978707e8);
  });

  it('KM_PC composes AU_PC and AU_KM', () => {
    expect(KM_PC).toBe(AU_PC / AU_KM);
  });

  it('R_SUN_PC is one solar radius in parsecs', () => {
    expect(R_SUN_PC).toBe(2.2543e-8);
  });

  it('J2000_JD is the standard J2000.0 reference epoch', () => {
    expect(J2000_JD).toBe(2451545.0);
  });
});
