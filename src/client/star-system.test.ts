import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  AU_PC,
  ECLIPTIC_NORTH_POLE_ICRS,
  RING_VISIBILITY_THRESHOLD_PX,
  StarSystem,
  buildEllipsePoints,
  orbitalPlaneNormalFor,
  ringVisibility,
} from './star-system';
import { GALACTIC_NORTH_POLE_ICRS } from './galactic-coords';
import type { Planet, PlanetSystem } from './planet-system';

function makePlanet(overrides: Partial<Planet> = {}): Planet {
  return {
    name: 'Test',
    radiusKm: 1000,
    semiMajorAxisAu: 1,
    eccentricity: 0,
    type: 'rocky',
    colour: [1, 1, 1],
    hasAtmosphere: false,
    ...overrides,
  };
}

function makeCamera(distancePc: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 1e-7, 1000);
  cam.position.set(0, 0, distancePc);
  return cam;
}

describe('AU_PC', () => {
  it('matches IAU 2012 to 7 significant figures', () => {
    expect(AU_PC).toBeCloseTo(4.8481368e-6, 12);
  });
});

describe('ECLIPTIC_NORTH_POLE_ICRS', () => {
  it('is a unit vector with the J2000 obliquity tilt around +X', () => {
    expect(ECLIPTIC_NORTH_POLE_ICRS.length()).toBeCloseTo(1, 6);
    expect(ECLIPTIC_NORTH_POLE_ICRS.x).toBeCloseTo(0, 12);
    // sin(23.4392911°) ≈ 0.39777716 ; cos ≈ 0.91748206
    expect(ECLIPTIC_NORTH_POLE_ICRS.y).toBeCloseTo(0.39777716, 6);
    expect(ECLIPTIC_NORTH_POLE_ICRS.z).toBeCloseTo(0.91748206, 6);
  });
});

describe('orbitalPlaneNormalFor', () => {
  it('returns the ecliptic normal for Sol', () => {
    const n = orbitalPlaneNormalFor(7, 7);
    expect(n.x).toBeCloseTo(ECLIPTIC_NORTH_POLE_ICRS.x, 12);
    expect(n.y).toBeCloseTo(ECLIPTIC_NORTH_POLE_ICRS.y, 12);
    expect(n.z).toBeCloseTo(ECLIPTIC_NORTH_POLE_ICRS.z, 12);
  });

  it('returns the galactic plane normal for any other host', () => {
    const n = orbitalPlaneNormalFor(42, 7);
    expect(n.x).toBeCloseTo(GALACTIC_NORTH_POLE_ICRS.x, 12);
    expect(n.y).toBeCloseTo(GALACTIC_NORTH_POLE_ICRS.y, 12);
    expect(n.z).toBeCloseTo(GALACTIC_NORTH_POLE_ICRS.z, 12);
  });

  it('returns a fresh vector — never the cached export', () => {
    // Mutating the return value must not corrupt the shared constant.
    const n = orbitalPlaneNormalFor(7, 7);
    n.set(0, 0, 0);
    expect(ECLIPTIC_NORTH_POLE_ICRS.length()).toBeCloseTo(1, 6);
    const m = orbitalPlaneNormalFor(99, 7);
    m.set(0, 0, 0);
    expect(GALACTIC_NORTH_POLE_ICRS.length()).toBeCloseTo(1, 6);
  });
});

describe('ringVisibility', () => {
  it('hides rings whose pixel gap to a neighbour is too small', () => {
    // Rings at 10, 14, 30, 32, 100 px. With threshold 6:
    //   i=0: gapNext = 4  → hidden
    //   i=1: gapPrev = 4  → hidden
    //   i=2: gapPrev=16, gapNext=2 → hidden
    //   i=3: gapPrev = 2  → hidden
    //   i=4: gapPrev = 68 → visible (no next neighbour)
    expect(ringVisibility([10, 14, 30, 32, 100], 6)).toEqual([
      false, false, false, false, true,
    ]);
  });

  it('renders the innermost / outermost rings using their single neighbour gap', () => {
    expect(ringVisibility([10, 50], 6)).toEqual([true, true]);
    expect(ringVisibility([10, 12], 6)).toEqual([false, false]);
  });

  it('renders an isolated single ring', () => {
    expect(ringVisibility([42], 6)).toEqual([true]);
  });

  it('renders nothing for an empty system', () => {
    expect(ringVisibility([], 6)).toEqual([]);
  });

  it('uses strict-greater-than against the threshold (gap == threshold hides)', () => {
    expect(ringVisibility([0, 6], 6)).toEqual([false, false]);
    expect(ringVisibility([0, 7], 6)).toEqual([true, true]);
  });
});

describe('buildEllipsePoints', () => {
  it('emits a circle when eccentricity is zero', () => {
    const segments = 64;
    const verts = new Float32Array(segments * 3);
    buildEllipsePoints(1, 0, segments, verts);
    for (let i = 0; i < segments; i++) {
      const x = verts[i * 3];
      const y = verts[i * 3 + 1];
      const z = verts[i * 3 + 2];
      expect(z).toBe(0);
      expect(Math.hypot(x, y)).toBeCloseTo(1, 6);
    }
  });

  it('places the host (origin) at one focus, with perihelion on +x', () => {
    // Eccentricity 0.5: c = a·e = 0.5, b = a·√(1−e²) ≈ 0.866.
    // Perihelion at +x = a − c = 0.5 ; aphelion at −x = −a − c = −1.5.
    const segments = 4;
    const verts = new Float32Array(segments * 3);
    buildEllipsePoints(1, 0.5, segments, verts);
    // t = 0 → perihelion
    expect(verts[0]).toBeCloseTo(0.5, 6);
    expect(verts[1]).toBeCloseTo(0, 6);
    // t = π → aphelion
    expect(verts[2 * 3]).toBeCloseTo(-1.5, 6);
    expect(verts[2 * 3 + 1]).toBeCloseTo(0, 6);
  });

  it('every point satisfies the ellipse equation around its centre', () => {
    const a = 5;
    const e = 0.3;
    const c = a * e;
    const b = a * Math.sqrt(1 - e * e);
    const segments = 32;
    const verts = new Float32Array(segments * 3);
    buildEllipsePoints(a, e, segments, verts);
    for (let i = 0; i < segments; i++) {
      const x = verts[i * 3] + c; // shift so centre is at origin
      const y = verts[i * 3 + 1];
      // (x/a)² + (y/b)² = 1 to within float32 noise
      expect((x * x) / (a * a) + (y * y) / (b * b)).toBeCloseTo(1, 5);
    }
  });

  it('emits all-zero output if segments is zero', () => {
    const verts = new Float32Array(0);
    buildEllipsePoints(1, 0, 0, verts);
    expect(verts.length).toBe(0);
  });
});

describe('RING_VISIBILITY_THRESHOLD_PX', () => {
  it('is a small positive pixel count consistent with the bead recommendation', () => {
    expect(RING_VISIBILITY_THRESHOLD_PX).toBeGreaterThanOrEqual(4);
    expect(RING_VISIBILITY_THRESHOLD_PX).toBeLessThanOrEqual(8);
  });
});

describe('StarSystem.anyRingVisible', () => {
  it('returns false with no planet system attached', () => {
    const ss = new StarSystem();
    expect(ss.anyRingVisible()).toBe(false);
    ss.dispose();
  });

  it('returns true after a tick that lets at least one ring through the heuristic', () => {
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [makePlanet({ name: 'Alpha', semiMajorAxisAu: 1 })],
    };
    ss.setPlanetSystem(ps, 0);
    // Camera at 5 AU from the (origin) host. A lone ring has no
    // neighbours, so the gap heuristic always lets it render.
    ss.update(makeCamera(5 * AU_PC), 800);
    expect(ss.anyRingVisible()).toBe(true);
    ss.dispose();
  });

  it('returns false after the planet system is cleared', () => {
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [makePlanet()],
    };
    ss.setPlanetSystem(ps, 0);
    ss.update(makeCamera(5 * AU_PC), 800);
    ss.setPlanetSystem(null, 0);
    expect(ss.anyRingVisible()).toBe(false);
    ss.dispose();
  });

  it('returns false when warp-hidden, even with rings still in the heuristic', () => {
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [makePlanet()],
    };
    ss.setPlanetSystem(ps, 0);
    ss.update(makeCamera(5 * AU_PC), 800);
    ss.setHidden(true);
    expect(ss.anyRingVisible()).toBe(false);
    ss.dispose();
  });

  it('returns false in chart (mono) mode', () => {
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [makePlanet()],
    };
    ss.setPlanetSystem(ps, 0);
    ss.update(makeCamera(5 * AU_PC), 800);
    ss.setMonochrome(true);
    expect(ss.anyRingVisible()).toBe(false);
    ss.dispose();
  });

  it('returns false when every ring is suppressed by the pixel-gap heuristic', () => {
    // Two rings with semi-major axes very close together, viewed from far
    // enough that the projected pixel gap collapses below the threshold.
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [
        makePlanet({ name: 'A', semiMajorAxisAu: 1.000 }),
        makePlanet({ name: 'B', semiMajorAxisAu: 1.001 }),
      ],
    };
    ss.setPlanetSystem(ps, 0);
    // 1e6 pc is absurdly far; both ring projections shrink to indistinguishable.
    ss.update(makeCamera(1e6), 800);
    expect(ss.anyRingVisible()).toBe(false);
    ss.dispose();
  });
});
