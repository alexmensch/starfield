import { beforeEach, describe, expect, it } from 'vitest';
import { setUnit } from '../../distance-util';
import { formatStarHover, type StarHoverFormatContext } from './star-hover-format';

// Tiny fixture builder. Three stars by default — idx 0 is the named
// non-variable, idx 1 is the variable, idx 2 is the unnamed-but-HIP
// fallback. Tests pick the slot they want.
function buildCtx(overrides: Partial<StarHoverFormatContext> = {}): StarHoverFormatContext {
  const positions = new Float32Array([
    // idx 0 — Vega-like distance (~7.7 pc)
    5, 4, 3,
    // idx 1 — Mira-like distance (~92 pc)
    60, 50, 40,
    // idx 2 — far unnamed (~150 pc)
    100, 80, 60,
  ]);
  const constellation = new Float32Array([0, 1, 255]);
  const constellations = [{ name: 'Lyra' }, { name: 'Cetus' }];
  const periodDays = new Float32Array([0, 332, 0]);
  const amplitudeMag = new Float32Array([0, 7.6, 0]);
  const starLabels = new Map<number, string>([
    [0, 'Vega'],
    [1, 'Mira'],
    [2, 'HIP 99999'],
  ]);
  const spectralMap = new Map<number, string>([
    [0, 'A0V'],
    [1, 'M5-9e'],
    // idx 2: no spectral entry — exercise the no-spectral path
  ]);
  return {
    starLabels,
    spectralMap,
    positions,
    constellation,
    constellations,
    periodDays,
    amplitudeMag,
    ...overrides,
  };
}

describe('formatStarHover', () => {
  beforeEach(() => {
    // fmtDist reads module-level state. Pin to 'pc' so the golden
    // distance strings below stay stable regardless of test order.
    setUnit('pc');
  });

  it('formats a named non-variable star (Vega-like)', () => {
    const out = formatStarHover(0, buildCtx());
    expect(out.name).toBe('Vega');
    // Distance = sqrt(5² + 4² + 3²) = sqrt(50) ≈ 7.07 pc → '7.1 pc'
    // via fmtDist's <100 pc tier (one decimal).
    expect(out.lines).toEqual([
      'Lyra · 7.1 pc',
      'A0V',
    ]);
  });

  it('formats a variable star with period + Δmag (Mira-like)', () => {
    const out = formatStarHover(1, buildCtx());
    expect(out.name).toBe('Mira');
    // Distance = sqrt(60² + 50² + 40²) = sqrt(7700) ≈ 87.75 pc → '87.7 pc'
    // (fmtDist <100 pc tier uses toFixed(1) which truncates the 5).
    expect(out.lines).toEqual([
      'Cetus · 87.7 pc',
      'M5-9e',
      'Variable · P=332d, Δ=7.6mag',
    ]);
  });

  it('formats an unnamed catalog star with the HIP fallback in the name line', () => {
    // idx 2 has constellation = 255 (no constellation) and no spectral
    // entry — distance is the only sub-line.
    const out = formatStarHover(2, buildCtx());
    expect(out.name).toBe('HIP 99999');
    // sqrt(100² + 80² + 60²) = sqrt(20000) ≈ 141.42 pc → '141 pc'
    // (fmtDist 100–10k tier uses Math.round).
    expect(out.lines).toEqual([
      '141 pc',
    ]);
  });

  it('uses the short-period format (toFixed(2)) below 10 days', () => {
    // RR Lyrae-style short-period variable: period 0.567 days.
    const ctx = buildCtx({
      periodDays: new Float32Array([0.567, 0, 0]),
      amplitudeMag: new Float32Array([1.0, 0, 0]),
    });
    const out = formatStarHover(0, ctx);
    expect(out.lines).toContain('Variable · P=0.57d, Δ=1.0mag');
  });

  it('falls back to "Unnamed #idx" when starLabels has no entry', () => {
    const ctx = buildCtx({ starLabels: new Map() });
    expect(formatStarHover(0, ctx).name).toBe('Unnamed #0');
  });
});
