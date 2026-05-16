import { describe, expect, it } from 'vitest';
import { FADE_INNER_PC, FADE_OUTER_PC, smoothstep } from './galactic-fade';

describe('galactic-fade', () => {
  it('fade band brackets the local-browsing-to-context-overlay transition', () => {
    expect(FADE_INNER_PC).toBe(500);
    expect(FADE_OUTER_PC).toBe(5000);
    expect(FADE_INNER_PC).toBeLessThan(FADE_OUTER_PC);
  });

  it('smoothstep clamps below the inner edge', () => {
    expect(smoothstep(0, 1, -0.5)).toBe(0);
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(FADE_INNER_PC, FADE_OUTER_PC, 0)).toBe(0);
  });

  it('smoothstep clamps above the outer edge', () => {
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(FADE_INNER_PC, FADE_OUTER_PC, 10_000)).toBe(1);
  });

  it('smoothstep midpoint is exactly 0.5 (Hermite t²(3−2t) symmetric)', () => {
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(FADE_INNER_PC, FADE_OUTER_PC, 2750)).toBeCloseTo(0.5, 10);
  });

  it('smoothstep has zero slope at both edges (Hermite property)', () => {
    const eps = 1e-6;
    // Right of edge0: f(eps) ≈ 3·eps² (low-order term is quadratic).
    expect(smoothstep(0, 1, eps)).toBeLessThan(eps);
    // Left of edge1: by symmetry, 1 - f(1-eps) is also O(eps²).
    expect(1 - smoothstep(0, 1, 1 - eps)).toBeLessThan(eps);
  });

  it('smoothstep is monotonic on the fade band', () => {
    let prev = -Infinity;
    for (let d = 0; d <= 6000; d += 200) {
      const v = smoothstep(FADE_INNER_PC, FADE_OUTER_PC, d);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
