import { describe, it, expect, beforeEach } from 'vitest';
import {
  ELEMENTS,
  PLANET_ORDER,
  AU_PC,
  CACHE_GRANULARITY_SEC,
  getPlanetPositions,
  planetEclipticAU,
  _resetCacheForTests,
  type Vec3,
} from './ephemeris';

// J2000.0 in Unix-seconds: 2000-01-01T12:00:00 (TT, but treated as UTC
// here — TT-UTC offset of ~64s collapses well below any test threshold).
const J2000_UNIX = 946728000;

beforeEach(() => {
  _resetCacheForTests();
});

describe('ELEMENTS table', () => {
  it('has eight planets in heliocentric order', () => {
    expect(ELEMENTS.length).toBe(8);
    expect(PLANET_ORDER).toEqual([
      'mercury', 'venus', 'earth', 'mars',
      'jupiter', 'saturn', 'uranus', 'neptune',
    ]);
  });

  it('semi-major axes are strictly increasing', () => {
    for (let i = 1; i < ELEMENTS.length; i++) {
      expect(ELEMENTS[i].a).toBeGreaterThan(ELEMENTS[i - 1].a);
    }
  });

  it('inner planets have zero perturbation terms (b/c/s/f)', () => {
    for (let i = 0; i < 4; i++) {
      expect(ELEMENTS[i].b).toBe(0);
      expect(ELEMENTS[i].c).toBe(0);
      expect(ELEMENTS[i].s).toBe(0);
      expect(ELEMENTS[i].f).toBe(0);
    }
  });

  it('Jupiter–Neptune carry non-zero perturbation terms', () => {
    for (let i = 4; i < 8; i++) {
      // f is the cubic-correction frequency; nonzero distinguishes
      // outer from inner planets in the table.
      expect(ELEMENTS[i].f).not.toBe(0);
    }
  });
});

describe('planetEclipticAU at J2000.0 (T = 0) — geometric sanity', () => {
  // Test against geometry that's intrinsic to the elements (no external
  // ephemeris reference needed). At J2000, mean longitude L is the
  // table value, distance from Sol is a·(1 − e·cos E), and (for low-
  // inclination orbits) z stays small. Catches sign-flips / rotation-
  // matrix transposes.

  it('Earth lies near 1 AU and on the ecliptic (z ≈ 0)', () => {
    const earthIdx = PLANET_ORDER.indexOf('earth');
    const out: Vec3 = { x: 0, y: 0, z: 0 };
    planetEclipticAU(ELEMENTS[earthIdx], 0, out);
    const r = Math.hypot(out.x, out.y, out.z);
    // Earth's perihelion ≈ 0.983 AU, aphelion ≈ 1.017 AU.
    expect(r).toBeGreaterThan(0.98);
    expect(r).toBeLessThan(1.02);
    // EM Bary's J2000 inclination is essentially zero (the ecliptic IS
    // Earth's orbital plane by definition).
    expect(Math.abs(out.z)).toBeLessThan(0.001);
  });

  it('every planet sits within its own [perihelion, aphelion] band at J2000', () => {
    const out: Vec3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < PLANET_ORDER.length; i++) {
      const e = ELEMENTS[i];
      planetEclipticAU(e, 0, out);
      const r = Math.hypot(out.x, out.y, out.z);
      const peri = e.a * (1 - e.e);
      const aphe = e.a * (1 + e.e);
      expect(r).toBeGreaterThan(peri * 0.999);
      expect(r).toBeLessThan(aphe * 1.001);
    }
  });

  it('outer-planet z stays small relative to a (low-inclination orbits)', () => {
    // Inclinations are all < 8°, so |z| / |r| ≤ sin(8°) ≈ 0.14.
    const out: Vec3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < PLANET_ORDER.length; i++) {
      planetEclipticAU(ELEMENTS[i], 0, out);
      const r = Math.hypot(out.x, out.y, out.z);
      expect(Math.abs(out.z) / r).toBeLessThan(0.15);
    }
  });
});

describe('planetEclipticAU bounding-box invariants', () => {
  // Across a 6000-year span (±3000y from J2000, the JPL Standish
  // validity window) every planet's distance from Sol must stay
  // within its [a(1-e), a(1+e)] orbital range.
  const T_VALUES = [-30, -10, -1, 0, 1, 10, 30]; // Centuries

  for (let i = 0; i < PLANET_ORDER.length; i++) {
    const name = PLANET_ORDER[i];
    it(`${name} stays within [aphelion, perihelion] over the validity window`, () => {
      const e = ELEMENTS[i];
      const out: Vec3 = { x: 0, y: 0, z: 0 };
      // 10% slack absorbs the linear secular drift in a, e over the
      // ±3000 year window (a few percent for some planets).
      const peri = e.a * (1 - e.e) * 0.9;
      const aphe = e.a * (1 + e.e) * 1.1;
      for (const T of T_VALUES) {
        planetEclipticAU(e, T, out);
        const r = Math.hypot(out.x, out.y, out.z);
        expect(r).toBeGreaterThan(peri);
        expect(r).toBeLessThan(aphe);
      }
    });
  }
});

describe('getPlanetPositions', () => {
  it('returns parsecs (not AU)', () => {
    const p = getPlanetPositions(J2000_UNIX);
    // Earth at J2000 is at 0.983–1.017 AU from Sol — in parsecs that's
    // ~4.77e-6 to ~4.93e-6. The unit-check is "is this around AU_PC,
    // not around 1 (AU) or 1.5e8 (km)".
    const r = Math.hypot(p.earth.x, p.earth.y, p.earth.z);
    expect(r / AU_PC).toBeGreaterThan(0.98);
    expect(r / AU_PC).toBeLessThan(1.02);
  });

  it('has all eight named keys', () => {
    const p = getPlanetPositions(J2000_UNIX);
    for (const name of PLANET_ORDER) {
      expect(p[name]).toBeDefined();
      expect(typeof p[name].x).toBe('number');
      expect(Number.isFinite(p[name].x)).toBe(true);
    }
  });

  it('caches by minute-bucket — same reference within bucket', () => {
    const a = getPlanetPositions(J2000_UNIX);
    const b = getPlanetPositions(J2000_UNIX + CACHE_GRANULARITY_SEC / 4);
    expect(a).toBe(b);
  });

  it('recomputes when bucket changes', () => {
    const a = getPlanetPositions(J2000_UNIX);
    const b = getPlanetPositions(J2000_UNIX + CACHE_GRANULARITY_SEC * 2);
    // Different bucket → fresh object.
    expect(a).not.toBe(b);
    // Position must have moved measurably for a fast planet (Mercury
    // covers ~0.1° in 2 minutes).
    const dx = b.mercury.x - a.mercury.x;
    const dy = b.mercury.y - a.mercury.y;
    const dz = b.mercury.z - a.mercury.z;
    expect(Math.hypot(dx, dy, dz)).toBeGreaterThan(0);
  });

  it('Mercury moves measurably over a quarter-orbit (~22 days)', () => {
    const t0 = J2000_UNIX;
    const t1 = J2000_UNIX + 22 * 86400;
    _resetCacheForTests();
    const a = getPlanetPositions(t0);
    const aMercury = { ...a.mercury };
    _resetCacheForTests();
    const b = getPlanetPositions(t1);
    const d = Math.hypot(
      b.mercury.x - aMercury.x,
      b.mercury.y - aMercury.y,
      b.mercury.z - aMercury.z,
    );
    // Quarter-orbit displacement is on the order of √2·a (Mercury at one
    // side then orthogonal). a ≈ 0.39 AU = ~1.9e-6 pc, so a quarter-
    // orbit chord of ~0.5 AU is ~2.4e-6 pc. Demand at least 1e-6 pc to
    // confirm the time-evolution path actually advances mean longitude.
    expect(d).toBeGreaterThan(1e-6);
  });

  it('Mercury returns near its starting position after one full orbit (~88 days)', () => {
    const t0 = J2000_UNIX;
    const t1 = J2000_UNIX + 88 * 86400;
    _resetCacheForTests();
    const a = getPlanetPositions(t0);
    const aMercury = { ...a.mercury };
    _resetCacheForTests();
    const b = getPlanetPositions(t1);
    const d = Math.hypot(
      b.mercury.x - aMercury.x,
      b.mercury.y - aMercury.y,
      b.mercury.z - aMercury.z,
    );
    // Mercury's sidereal period is 87.97 days. After 88 days it's
    // within ~1% of start. Mercury's orbital "size" in pc ≈ 1.9e-6;
    // 1% of that is ~2e-8.
    expect(d).toBeLessThan(5e-7);
  });
});
