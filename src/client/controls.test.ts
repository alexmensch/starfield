import { describe, it, expect } from 'vitest';
import {
  sliderToDist,
  distToSlider,
  SLIDER_STEPS,
  DIST_MIN_PC,
  DIST_MAX_PC,
} from './controls';

describe('controls / sliderToDist', () => {
  it('maps slider 0 with isMin=true to 0 (the "no minimum" sentinel)', () => {
    // The min-distance slider treats slider=0 as "no lower bound" so the
    // user can dial down to capture every star. A literal 0 pc would
    // imply you-are-here, which doesn't match the UX intent.
    expect(sliderToDist(0, true)).toBe(0);
  });

  it('maps slider 0 with isMin=false to DIST_MIN_PC', () => {
    // The max-distance slider has no "no maximum" sentinel — the max-out
    // position represents 50,000 pc, and the floor of the slider is the
    // shared minimum. Slider=0 there encodes the actual minimum distance.
    expect(sliderToDist(0, false)).toBeCloseTo(DIST_MIN_PC, 10);
  });

  it('maps slider SLIDER_STEPS to DIST_MAX_PC for both endpoints', () => {
    expect(sliderToDist(SLIDER_STEPS, true)).toBeCloseTo(DIST_MAX_PC, 5);
    expect(sliderToDist(SLIDER_STEPS, false)).toBeCloseTo(DIST_MAX_PC, 5);
  });

  it('is monotonically non-decreasing across the slider range (max side)', () => {
    let prev = -Infinity;
    for (let v = 0; v <= SLIDER_STEPS; v += 50) {
      const d = sliderToDist(v, false);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('produces a log-uniform distribution', () => {
    // Equal slider intervals should produce equal *log-distance* deltas.
    // The whole point of the log scaling is that nearby sliders feel the
    // same — moving from 100→200 and 800→900 should not feel different.
    const a = Math.log10(sliderToDist(100, false));
    const b = Math.log10(sliderToDist(200, false));
    const c = Math.log10(sliderToDist(800, false));
    const d = Math.log10(sliderToDist(900, false));
    expect(b - a).toBeCloseTo(d - c, 5);
  });
});

describe('controls / distToSlider', () => {
  it('returns 0 for non-positive distance', () => {
    expect(distToSlider(0, true)).toBe(0);
    expect(distToSlider(0, false)).toBe(0);
    expect(distToSlider(-5, true)).toBe(0);
  });

  it('clamps distances below DIST_MIN_PC to slider 0', () => {
    // A user-set min smaller than the slider's resolution still encodes
    // as the bottom of the slider, not a negative slider position.
    expect(distToSlider(DIST_MIN_PC / 10, false)).toBe(0);
  });

  it('clamps distances above DIST_MAX_PC to slider SLIDER_STEPS', () => {
    expect(distToSlider(DIST_MAX_PC * 10, false)).toBe(SLIDER_STEPS);
  });

  it('keeps output within [0, SLIDER_STEPS] for any positive input', () => {
    for (const pc of [0.0001, 0.5, 1, 100, 1000, 50000, 500_000]) {
      const v = distToSlider(pc, false);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(SLIDER_STEPS);
    }
  });

  it('returns an integer (slider position is discrete)', () => {
    for (const pc of [0.5, 5, 100, 5000]) {
      const v = distToSlider(pc, false);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe('controls / round-trip slider ↔ dist', () => {
  // Round-trip identity is the load-bearing invariant — URL state encodes
  // the slider position, applies it to the filter, and the next emit
  // reads the filter back. If the round-trip drifts, sharing a URL would
  // shift the user's view by one slider tick at a time on every share.

  it('round-trips slider values across the interior of the range (max side)', () => {
    for (let v = 1; v < SLIDER_STEPS; v += 37) {
      const dist = sliderToDist(v, false);
      const back = distToSlider(dist, false);
      expect(back).toBe(v);
    }
  });

  it('round-trips slider values across the interior of the range (min side)', () => {
    // Skip v=0 (the "no minimum" sentinel) — its round-trip is 0 → 0
    // (sliderToDist returns 0; distToSlider(0) returns 0) tested above.
    for (let v = 1; v < SLIDER_STEPS; v += 37) {
      const dist = sliderToDist(v, true);
      const back = distToSlider(dist, true);
      expect(back).toBe(v);
    }
  });

  it('round-trips the "no minimum" sentinel', () => {
    const dist = sliderToDist(0, true);
    expect(dist).toBe(0);
    expect(distToSlider(0, true)).toBe(0);
  });

  it('round-trips DIST_MAX_PC', () => {
    expect(distToSlider(DIST_MAX_PC, false)).toBe(SLIDER_STEPS);
    expect(sliderToDist(SLIDER_STEPS, false)).toBeCloseTo(DIST_MAX_PC, 5);
  });

  it('produces stable output under repeated round-trips', () => {
    // Iterating the cycle should converge in one step — we already round
    // to nearest, so a slider that decoded to the right pc decodes to the
    // same slider on the way back.
    let v = 500;
    for (let i = 0; i < 5; i++) {
      v = distToSlider(sliderToDist(v, false), false);
    }
    expect(v).toBe(500);
  });
});
