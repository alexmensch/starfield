import { describe, expect, it } from 'vitest';
import {
  BV_MAX,
  BV_MIN,
  LUT_SIZE,
  ballesterosTeff,
  blackbodyToSrgb,
  buildLut,
  bvAtIndex,
  sampleLut,
} from './blackbody-lut';
import {
  LUT_BYTES,
  LUT_SIZE as CONSUMER_LUT_SIZE,
  BV_MIN as CONSUMER_BV_MIN,
  BV_MAX as CONSUMER_BV_MAX,
} from '../src/client/shaders/blackbody-lut';

// ---- Ballesteros parity ----------------------------------------------
//
// Reference values from research/star-spectral-rendition/blackbody_color.py
// (the Python source-of-truth this module ports). Computed via the
// Ballesteros 2012 formula at 5 spanning B-V values; pinned to 0.01 K to
// catch any drift in the TS port.

describe('ballesterosTeff', () => {
  const cases: ReadonlyArray<[number, number]> = [
    [-0.4, 21707.4217],
    [0.0, 10125.2372],
    [0.65, 5778.4237],
    [1.5, 3793.5065],
    [2.0, 3169.3537],
  ];

  it.each(cases)('Ball(%f) = %f', (bv, expected) => {
    expect(ballesterosTeff(bv)).toBeCloseTo(expected, 2);
  });
});

// ---- LUT consumer module is in sync ---------------------------------
//
// The generated module in src/client/shaders/blackbody-lut.ts must match
// what scripts/blackbody-lut.ts emits today. Drift = regenerate via
// `npm run build:lut` and commit both files in the same PR.

describe('LUT byte signature', () => {
  it('matches what buildLut() emits today', () => {
    const generated = buildLut();
    expect(generated.length).toBe(LUT_SIZE * 3);
    expect(LUT_BYTES.length).toBe(LUT_SIZE * 3);
    expect(Array.from(generated)).toEqual(Array.from(LUT_BYTES));
  });

  it('endpoint bytes match Python reference', () => {
    // First entry (B-V = -0.4, T ≈ 21707 K): hot blue-white.
    expect(LUT_BYTES[0]).toBe(169);
    expect(LUT_BYTES[1]).toBe(192);
    expect(LUT_BYTES[2]).toBe(255);
    // Last entry (B-V = +2.0, T ≈ 3169 K): warm amber.
    expect(LUT_BYTES[(LUT_SIZE - 1) * 3 + 0]).toBe(255);
    expect(LUT_BYTES[(LUT_SIZE - 1) * 3 + 1]).toBe(190);
    expect(LUT_BYTES[(LUT_SIZE - 1) * 3 + 2]).toBe(120);
  });

  it('consumer-module constants match the generator', () => {
    expect(CONSUMER_LUT_SIZE).toBe(LUT_SIZE);
    expect(CONSUMER_BV_MIN).toBe(BV_MIN);
    expect(CONSUMER_BV_MAX).toBe(BV_MAX);
  });
});

// ---- bvAtIndex spans the full inclusive range ------------------------

describe('bvAtIndex', () => {
  it('hits BV_MIN at index 0 and BV_MAX at the last index', () => {
    expect(bvAtIndex(0)).toBeCloseTo(BV_MIN, 10);
    expect(bvAtIndex(LUT_SIZE - 1)).toBeCloseTo(BV_MAX, 10);
  });
});

// ---- Per-sample-star RGB ---------------------------------------------
//
// Pin the LUT's rendered colour for the named-star smoke list in the
// bead. Tolerance accounts for LUT quantisation (one 256th of the B-V
// range ≈ 0.0094 mag between entries; linear interp keeps the
// chromaticity smooth between samples).

function deltaE255(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

describe('sampleLut at named-star B-V values', () => {
  // Expected RGBs come from the direct Python pipeline at
  // T = Ballesteros(B-V); the LUT samples agree within quantisation noise.
  const cases: ReadonlyArray<[string, number, [number, number, number]]> = [
    ['Sol',        0.656, [255, 241, 233]],
    ['Sirius A',   0.009, [205, 217, 255]],
    ['Aldebaran',  1.538, [255, 206, 152]],
    ['Antares',    1.830, [255, 196, 131]],
    ['Betelgeuse', 1.860, [255, 195, 129]],
    ['Mintaka',   -0.170, [188, 206, 255]],
    // Mu Cep at observed (dust-reddened) B-V = +2.4 — the load-bearing
    // case study (RECOMMENDATION.md § Mu Cephei). Tier 1 must land at
    // pumpkin-amber, not the current shader's over-saturated red. The LUT
    // clamps inputs at BV_MAX = 2.0, so this samples the table's hottest-end
    // entry — slightly warmer than the un-clamped pumpkin, but the visual
    // identity is preserved (still cool amber, not the prior shader's red).
    ['Mu Cep observed', 2.400, [255, 190, 120]],
  ];

  it.each(cases)('%s (B-V=%f) renders as expected ±5 ΔE', (_name, bv, expected) => {
    const sampled = sampleLut(LUT_BYTES, bv);
    const rounded: [number, number, number] = [
      Math.round(sampled[0]),
      Math.round(sampled[1]),
      Math.round(sampled[2]),
    ];
    expect(deltaE255(rounded, expected)).toBeLessThanOrEqual(5);
  });
});

// ---- blackbodyToSrgb sanity ------------------------------------------

describe('blackbodyToSrgb', () => {
  it('cool red 3000K reads warm orange', () => {
    const [r, g, b] = blackbodyToSrgb(3000);
    expect(Math.round(r * 255)).toBe(255);
    expect(Math.round(g * 255)).toBeGreaterThan(150);
    expect(Math.round(g * 255)).toBeLessThan(200);
    expect(Math.round(b * 255)).toBeLessThan(120);
  });

  it('Sol-like 5778K reads near-white', () => {
    const [r, g, b] = blackbodyToSrgb(5778);
    expect(Math.round(r * 255)).toBe(255);
    expect(Math.round(g * 255)).toBeGreaterThan(235);
    expect(Math.round(b * 255)).toBeGreaterThan(225);
  });

  it('hot 30000K reads blue-white (Python parity)', () => {
    const [r, g, b] = blackbodyToSrgb(30000);
    expect(Math.round(r * 255)).toBe(162);
    expect(Math.round(g * 255)).toBe(187);
    expect(Math.round(b * 255)).toBe(255);
  });
});
