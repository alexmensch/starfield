import { describe, it, expect } from 'vitest';
import type { Catalog } from './catalog-loader';
import {
  SOL_PLANETS,
  getPlanetSystem,
  hasPlanets,
  type Planet,
  type PlanetType,
} from './planet-system';
import {
  EARTH_PHASE,
  JUPITER_PHASE,
  MARS_PHASE,
  MERCURY_PHASE,
  SATURN_PHASE,
  VENUS_PHASE,
} from './phase-function';

// Synthetic catalog stub — only fields used by the planet-system module
// matter; the rest stay zero/empty so tests don't drag in catalog parsing.
function stubCatalog(solIndex: number, count = Math.max(solIndex + 1, 1)): Catalog {
  return {
    count,
    positions: new Float32Array(count * 3),
    absmag: new Float32Array(count),
    ci: new Float32Array(count),
    spectClass: new Float32Array(count),
    luminosityClass: new Uint8Array(count),
    physicalRadius: new Float32Array(count),
    constellation: new Float32Array(count),
    flags: new Uint8Array(count),
    companion: new Int32Array(count),
    periodDays: new Float32Array(count),
    amplitudeMag: new Float32Array(count),
    hip: new Uint32Array(count),
    orbitIdx: new Int32Array(count).fill(-1),
    elementsCount: 0,
    names: new Map(),
    solIndex,
    constellations: [],
  };
}

describe('hasPlanets', () => {
  it('returns true for Sol only', () => {
    const cat = stubCatalog(7);
    expect(hasPlanets(cat, 7)).toBe(true);
    expect(hasPlanets(cat, 0)).toBe(false);
    expect(hasPlanets(cat, 42)).toBe(false);
  });

  it('returns false for null / negative / unfocused', () => {
    const cat = stubCatalog(7);
    expect(hasPlanets(cat, null)).toBe(false);
    expect(hasPlanets(cat, -1)).toBe(false);
  });

  it('returns false when the catalog has no Sol', () => {
    const cat = stubCatalog(-1);
    expect(hasPlanets(cat, -1)).toBe(false);
    expect(hasPlanets(cat, 0)).toBe(false);
  });
});

describe('getPlanetSystem', () => {
  it('resolves with Sol planets for the Sol index', async () => {
    const cat = stubCatalog(3);
    const ps = await getPlanetSystem(cat, 3);
    expect(ps).not.toBeNull();
    expect(ps!.hostStarIdx).toBe(3);
    expect(ps!.planets).toBe(SOL_PLANETS);
  });

  it('resolves to null for any other star', async () => {
    const cat = stubCatalog(3);
    expect(await getPlanetSystem(cat, 0)).toBeNull();
    expect(await getPlanetSystem(cat, 99)).toBeNull();
    expect(await getPlanetSystem(cat, null)).toBeNull();
    expect(await getPlanetSystem(cat, -1)).toBeNull();
  });
});

describe('SOL_PLANETS data', () => {
  const expectedNames = [
    'Mercury', 'Venus', 'Earth', 'Mars',
    'Jupiter', 'Saturn', 'Uranus', 'Neptune',
    'Pluto',
  ];

  it('lists all nine bodies in heliocentric order (eight planets + Pluto)', () => {
    expect(SOL_PLANETS.map(p => p.name)).toEqual(expectedNames);
  });

  it('semi-major axes are strictly increasing (sanity check on order)', () => {
    for (let i = 1; i < SOL_PLANETS.length; i++) {
      expect(SOL_PLANETS[i].semiMajorAxisAu)
        .toBeGreaterThan(SOL_PLANETS[i - 1].semiMajorAxisAu);
    }
  });

  it('every body has a positive radius and orbit', () => {
    for (const p of SOL_PLANETS) {
      expect(p.radiusKm).toBeGreaterThan(0);
      expect(p.semiMajorAxisAu).toBeGreaterThan(0);
    }
  });

  it('eccentricities are in [0, 1); Pluto is most eccentric, Mercury second', () => {
    const sorted = [...SOL_PLANETS].sort((a, b) => b.eccentricity - a.eccentricity);
    for (const p of SOL_PLANETS) {
      expect(p.eccentricity).toBeGreaterThanOrEqual(0);
      expect(p.eccentricity).toBeLessThan(1);
    }
    expect(sorted[0].name).toBe('Pluto');
    expect(sorted[1].name).toBe('Mercury');
  });

  it('classifies inner four as rocky, two gas giants, two ice giants, Pluto rocky', () => {
    const types = SOL_PLANETS.map(p => p.type);
    expect(types.slice(0, 4)).toEqual(['rocky', 'rocky', 'rocky', 'rocky']);
    expect(types[4]).toBe('gas_giant');
    expect(types[5]).toBe('gas_giant');
    expect(types[6]).toBe('ice_giant');
    expect(types[7]).toBe('ice_giant');
    expect(types[8]).toBe('rocky');
  });

  it('colour channels are normalised RGB triples in [0,1]', () => {
    for (const p of SOL_PLANETS) {
      expect(p.colour).toHaveLength(3);
      for (const c of p.colour) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every body has a published geometric albedo in (0, 1)', () => {
    // Mallama 2018 + NASA fact-sheet values; pinned here so an
    // accidental edit doesn't silently drift the apparent-magnitude
    // calculation.
    const expected: Record<string, number> = {
      Mercury: 0.142, Venus: 0.689, Earth: 0.434, Mars: 0.170,
      Jupiter: 0.538, Saturn: 0.499, Uranus: 0.488, Neptune: 0.442,
      Pluto: 0.49,
    };
    for (const p of SOL_PLANETS) {
      expect(p.albedo).toBeGreaterThan(0);
      expect(p.albedo).toBeLessThan(1);
      expect(p.albedo).toBeCloseTo(expected[p.name], 3);
    }
  });

  it('every Mallama-published planet carries the matching phase coefficients', () => {
    // Mallama 2018 publishes phase-angle polynomials for Mercury,
    // Venus, Earth, Mars, Jupiter and Saturn. Uranus, Neptune and
    // Pluto have no published phase polynomial — Uranus and Neptune
    // because their max α from Earth is "negligible" so the paper
    // models latitude/temporal effects instead, Pluto because the
    // paper doesn't cover it. All three fall back to Lambertian.
    const expected: Record<string, unknown> = {
      Mercury: MERCURY_PHASE,
      Venus: VENUS_PHASE,
      Earth: EARTH_PHASE,
      Mars: MARS_PHASE,
      Jupiter: JUPITER_PHASE,
      Saturn: SATURN_PHASE,
    };
    const lambertianFallback = new Set(['Uranus', 'Neptune', 'Pluto']);
    for (const p of SOL_PLANETS) {
      if (lambertianFallback.has(p.name)) {
        expect(p.phaseCoefficients).toBeUndefined();
      } else {
        expect(p.phaseCoefficients).toBe(expected[p.name]);
      }
    }
  });

  it('radii match published equatorial / mean values (within 1 km)', () => {
    const expected: Record<string, number> = {
      Mercury: 2440, Venus: 6052, Earth: 6371, Mars: 3390,
      Jupiter: 69911, Saturn: 58232, Uranus: 25362, Neptune: 24622,
      Pluto: 1188,
    };
    for (const p of SOL_PLANETS) {
      expect(p.radiusKm).toBeCloseTo(expected[p.name], 0);
    }
  });
});

describe('Planet / PlanetType type surface', () => {
  it('PlanetType is one of the three documented categories', () => {
    const valid: PlanetType[] = ['rocky', 'gas_giant', 'ice_giant'];
    for (const p of SOL_PLANETS) {
      expect(valid).toContain(p.type as PlanetType);
    }
    // Compile-time assertion — if this stops type-checking, the enum widened.
    const t: Planet = SOL_PLANETS[0];
    expect(t.name).toBeTruthy();
  });
});
