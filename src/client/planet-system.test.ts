import { describe, it, expect } from 'vitest';
import type { Catalog } from './catalog-loader';
import {
  SOL_PLANETS,
  getPlanetSystem,
  hasPlanets,
  type Planet,
  type PlanetType,
} from './planet-system';

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
  ];

  it('lists all eight planets in heliocentric order', () => {
    expect(SOL_PLANETS.map(p => p.name)).toEqual(expectedNames);
  });

  it('semi-major axes are strictly increasing (sanity check on order)', () => {
    for (let i = 1; i < SOL_PLANETS.length; i++) {
      expect(SOL_PLANETS[i].semiMajorAxisAu)
        .toBeGreaterThan(SOL_PLANETS[i - 1].semiMajorAxisAu);
    }
  });

  it('every planet has a positive radius and orbit', () => {
    for (const p of SOL_PLANETS) {
      expect(p.radiusKm).toBeGreaterThan(0);
      expect(p.semiMajorAxisAu).toBeGreaterThan(0);
    }
  });

  it('classifies inner four as rocky and outer four as giants', () => {
    const types = SOL_PLANETS.map(p => p.type);
    expect(types.slice(0, 4)).toEqual(['rocky', 'rocky', 'rocky', 'rocky']);
    expect(types[4]).toBe('gas_giant');
    expect(types[5]).toBe('gas_giant');
    expect(types[6]).toBe('ice_giant');
    expect(types[7]).toBe('ice_giant');
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

  it('Earth, Venus, and the four giants flag hasAtmosphere; Mercury and Mars do not', () => {
    const atm = Object.fromEntries(SOL_PLANETS.map(p => [p.name, p.hasAtmosphere]));
    expect(atm).toEqual({
      Mercury: false,
      Venus: true,
      Earth: true,
      Mars: false,
      Jupiter: true,
      Saturn: true,
      Uranus: true,
      Neptune: true,
    });
  });

  it('radii match published equatorial values (within 1 km)', () => {
    const expected: Record<string, number> = {
      Mercury: 2440, Venus: 6052, Earth: 6371, Mars: 3390,
      Jupiter: 69911, Saturn: 58232, Uranus: 25362, Neptune: 24622,
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
