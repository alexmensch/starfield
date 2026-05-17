import { beforeEach, describe, expect, it } from 'vitest';
import { setUnit } from '../../ui/distance-util';
import { SOL_PLANETS } from '../../solar-system/planet-system';
import {
  formatPlanetHover,
  type PlanetHoverFormatContext,
} from './planet-hover-format';

// Helper: per-planet distance/mag map keyed by planet name, so the test
// inputs read in calling order rather than as bare numeric vectors.
function buildCtx(byName: {
  [name: string]: { distancePc?: number | null; appMag?: number | null };
}): PlanetHoverFormatContext {
  return {
    planets: SOL_PLANETS,
    distanceFromHostPc(planetIdx) {
      const entry = byName[SOL_PLANETS[planetIdx].name];
      return entry?.distancePc ?? null;
    },
    appMagFor(planetIdx) {
      const entry = byName[SOL_PLANETS[planetIdx].name];
      return entry?.appMag ?? null;
    },
  };
}

describe('formatPlanetHover', () => {
  beforeEach(() => {
    // fmtDistAuto switches to AU below 0.01 pc, but inside the AU band
    // it doesn't read the pc/ly unit toggle. Pin to 'pc' anyway so any
    // future regression that leaks the toggle into the AU tier surfaces.
    setUnit('pc');
  });

  it('formats Mercury at perihelion (live ephemeris distance + appMag)', () => {
    // Mercury 0.31 AU in pc = 0.31 / 206264.806 = 1.5029e-6 pc.
    // fmtDistAuto switches to AU below 0.01 pc; sub-AU values get
    // three decimals ("0.310 AU"), the AU 1–100 tier uses one
    // ("1.0 AU"), and ≥100 AU floor-rounds. Test pins each tier.
    const out = formatPlanetHover(0, buildCtx({
      Mercury: { distancePc: 0.31 / 206264.80624709636, appMag: -2.5 },
    }));
    expect(out.name).toBe('Mercury');
    expect(out.lines).toEqual([
      '0.310 AU · Vmag -2.5',
      'Period 0.24 yr',
      'Radius 2,440 km',
    ]);
  });

  it('formats Earth at a representative orbital distance', () => {
    // Earth idx = 2. The test feeds a fixed 1 AU input — a fake
    // current-position stand-in for golden-string stability. Real
    // Earth varies 0.983-1.017 AU through its orbit (e = 0.0167);
    // the live hover path reads the actual distance from
    // PlanetBodyField's ephemeris-driven iLocalRel cache. This test
    // only pins the formatter, not the ephemeris.
    const out = formatPlanetHover(2, buildCtx({
      Earth: { distancePc: 1 / 206264.80624709636, appMag: -3.99 },
    }));
    expect(out.name).toBe('Earth');
    expect(out.lines).toEqual([
      '1.0 AU · Vmag -4.0',
      'Period 1.00 yr',
      'Radius 6,371 km',
    ]);
  });

  it('formats Jupiter (whole-year period, thousands-separated radius)', () => {
    // Jupiter idx = 4. 5.2 AU host-distance, appMag −2.7 at Earth
    // opposition (sign explicit when negative).
    const out = formatPlanetHover(4, buildCtx({
      Jupiter: { distancePc: 5.2 / 206264.80624709636, appMag: -2.7 },
    }));
    expect(out.name).toBe('Jupiter');
    // Kepler 3rd law: 5.203^1.5 ≈ 11.86 → rounds to 12 (>= 10 tier).
    expect(out.lines).toEqual([
      '5.2 AU · Vmag -2.7',
      'Period 12 yr',
      'Radius 69,911 km',
    ]);
  });

  it('positive-mag planet renders an explicit + sign', () => {
    const out = formatPlanetHover(8, buildCtx({
      Pluto: { distancePc: 39 / 206264.80624709636, appMag: 14.3 },
    }));
    expect(out.name).toBe('Pluto');
    expect(out.lines[0]).toBe('39.0 AU · Vmag +14.3');
  });

  it('falls back gracefully when live values are null', () => {
    // The provider should never hand the formatter a null pair (the
    // pick path returns null whenever the planet isn't visible) but
    // guard the formatter against the degenerate state. Empty head
    // line should not appear — only Period + Radius survive.
    const out = formatPlanetHover(2, buildCtx({
      Earth: { distancePc: null, appMag: null },
    }));
    expect(out.name).toBe('Earth');
    expect(out.lines).toEqual([
      'Period 1.00 yr',
      'Radius 6,371 km',
    ]);
  });

  it('returns empty payload for out-of-range index', () => {
    const out = formatPlanetHover(99, buildCtx({}));
    expect(out).toEqual({ name: '', lines: [] });
  });
});
