import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  AU_PC,
  KM_PC,
  ECLIPTIC_NORTH_POLE_ICRS,
  RING_VISIBILITY_THRESHOLD_PX,
  StarSystem,
  buildEllipsePoints,
  orbitalPlaneNormalFor,
  placeholderEccentricAnomaly,
  planetLocalPosition,
  ringVisibility,
  solidityForType,
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

describe('KM_PC', () => {
  it('relates to AU_PC via 1 AU = 149597870.7 km', () => {
    expect(KM_PC * 1.495978707e8).toBeCloseTo(AU_PC, 12);
  });

  it('agrees with the published 1 km ≈ 3.241e-14 pc figure', () => {
    expect(KM_PC).toBeCloseTo(3.2407793e-14, 18);
  });
});

describe('placeholderEccentricAnomaly', () => {
  it('spreads N planets evenly around their orbits', () => {
    expect(placeholderEccentricAnomaly(0, 8)).toBe(0);
    expect(placeholderEccentricAnomaly(2, 8)).toBeCloseTo(Math.PI / 2, 12);
    expect(placeholderEccentricAnomaly(4, 8)).toBeCloseTo(Math.PI, 12);
    expect(placeholderEccentricAnomaly(7, 8)).toBeCloseTo((7 * Math.PI) / 4, 12);
  });

  it('returns zero on a degenerate (empty) system without dividing by zero', () => {
    expect(placeholderEccentricAnomaly(0, 0)).toBe(0);
    expect(placeholderEccentricAnomaly(3, 0)).toBe(0);
  });

  it('is deterministic — same (i, n) always returns the same angle', () => {
    expect(placeholderEccentricAnomaly(3, 8)).toBe(placeholderEccentricAnomaly(3, 8));
  });
});

describe('planetLocalPosition', () => {
  const identity = new THREE.Quaternion();
  const out = new THREE.Vector3();

  it('lands at perihelion for eccentricAnomaly = 0', () => {
    // a = 1 pc-equivalent, e = 0.5 ; perihelion at +x = a − c = 0.5.
    planetLocalPosition(1 / AU_PC, 0.5, 0, identity, out);
    expect(out.x).toBeCloseTo(0.5, 6);
    expect(out.y).toBeCloseTo(0, 6);
    expect(out.z).toBe(0);
  });

  it('lands at aphelion for eccentricAnomaly = π', () => {
    planetLocalPosition(1 / AU_PC, 0.5, Math.PI, identity, out);
    expect(out.x).toBeCloseTo(-1.5, 6);
    expect(out.y).toBeCloseTo(0, 6);
  });

  it('lies in the local xy plane before any orientation rotation', () => {
    for (let t = 0; t < 6; t++) {
      planetLocalPosition(1, 0.3, t, identity, out);
      expect(out.z).toBe(0);
    }
  });

  it('a circular orbit (e = 0) traces a true circle of radius a', () => {
    const aPc = 0.001;
    for (let t = 0; t < 8; t++) {
      const angle = (t / 8) * Math.PI * 2;
      planetLocalPosition(aPc / AU_PC, 0, angle, identity, out);
      expect(Math.hypot(out.x, out.y)).toBeCloseTo(aPc, 9);
    }
  });

  it('respects the orientation quaternion', () => {
    // Rotate +z onto +y; an in-plane perihelion (+x, 0, 0) should stay
    // on +x (rotation around +z by 0 in our case is identity, but a 90°
    // rotation around +x takes y to z).
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2,
    );
    // semiMajorAxisAu = 1/AU_PC means a = 1 pc internally; eccentricAnomaly
    // = π/2 with e=0 yields the in-plane (0, 1, 0) point.
    planetLocalPosition(1 / AU_PC, 0, Math.PI / 2, q, out);
    // Pre-rotation: (0, 1, 0). Post 90° around +x: (0, 0, 1).
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(0, 6);
    expect(out.z).toBeCloseTo(1, 6);
  });
});

describe('solidityForType', () => {
  it('rocky bodies have full solidity (hard disc edge)', () => {
    expect(solidityForType('rocky')).toBe(1);
  });

  it('gas giants have zero solidity (broad gradient)', () => {
    expect(solidityForType('gas_giant')).toBe(0);
  });

  it('ice giants sit between rocky and gas giants', () => {
    const v = solidityForType('ice_giant');
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });
});

describe('StarSystem.anyOrbitRingVisible', () => {
  it('returns false with no planet system attached', () => {
    const ss = new StarSystem();
    expect(ss.anyOrbitRingVisible()).toBe(false);
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
    expect(ss.anyOrbitRingVisible()).toBe(true);
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
    expect(ss.anyOrbitRingVisible()).toBe(false);
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
    expect(ss.anyOrbitRingVisible()).toBe(false);
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
    expect(ss.anyOrbitRingVisible()).toBe(false);
    ss.dispose();
  });

  it('isOrbitRingVisible is per-planet and tracks per-ring visibility', () => {
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [
        makePlanet({ name: 'A', semiMajorAxisAu: 1 }),
        makePlanet({ name: 'B', semiMajorAxisAu: 100 }),
      ],
    };
    ss.setPlanetSystem(ps, 0);
    // Mid-range camera distance — the inner ring's pixel radius collapses
    // (pile-up against neighbour) while the outer ring remains spread.
    // The exact heuristic outcome is exercised in `ringVisibility` tests
    // above; here we just confirm the per-index API plumbs through.
    ss.update(makeCamera(50 * AU_PC), 800);
    const a = ss.isOrbitRingVisible(0);
    const b = ss.isOrbitRingVisible(1);
    expect(typeof a).toBe('boolean');
    expect(typeof b).toBe('boolean');
    // Out-of-range index is always false.
    expect(ss.isOrbitRingVisible(2)).toBe(false);
    expect(ss.isOrbitRingVisible(-1)).toBe(false);
    // Hide layer → all rings report false.
    ss.setHidden(true);
    expect(ss.isOrbitRingVisible(0)).toBe(false);
    expect(ss.isOrbitRingVisible(1)).toBe(false);
    ss.dispose();
  });

  it('update positions the group at hostLocalPos when supplied', () => {
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [makePlanet({ semiMajorAxisAu: 1 })],
    };
    ss.setPlanetSystem(ps, 0);
    const host = new THREE.Vector3(10, -3, 7);
    ss.update(makeCamera(5 * AU_PC), 800, host);
    expect(ss.group.position.x).toBe(10);
    expect(ss.group.position.y).toBe(-3);
    expect(ss.group.position.z).toBe(7);
    ss.dispose();
  });

  it('update with hostLocalPos uses camera-to-host distance for the heuristic', () => {
    // Two-ring system; with the host at the origin and the camera 5 AU
    // away, the heuristic at this ring spread lets at least one through
    // (small enough rings → suppressed; large outer ring with big gap →
    // visible). Same camera position with the host placed AT the camera
    // makes camera-to-host = 0 so the rings project to a degenerate
    // angular size (atan saturates at π/2) and at least the outermost
    // visibly registers; either way, the API is exercised — the precise
    // outcome is covered in the `ringVisibility` pure-function tests.
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [
        makePlanet({ name: 'A', semiMajorAxisAu: 1 }),
        makePlanet({ name: 'B', semiMajorAxisAu: 50 }),
      ],
    };
    ss.setPlanetSystem(ps, 0);
    const cam = makeCamera(5 * AU_PC);
    // Sanity check: with host at origin, the existing heuristic behaviour
    // applies — at least one of these two well-spread rings should be
    // visible at this distance.
    ss.update(cam, 800);
    const visibleAtOrigin = ss.isOrbitRingVisible(0) || ss.isOrbitRingVisible(1);
    expect(visibleAtOrigin).toBe(true);
    // Move the host far enough that the camera-to-host distance grows
    // past the ring-gap collapse threshold (~7500 AU for these
    // particular semi-major axes against a 6 px gap floor) — both
    // rings should now collapse below the pixel-gap threshold.
    const farHost = new THREE.Vector3(0, 0, 50_000 * AU_PC);
    ss.update(cam, 800, farHost);
    expect(ss.isOrbitRingVisible(0)).toBe(false);
    expect(ss.isOrbitRingVisible(1)).toBe(false);
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
    expect(ss.anyOrbitRingVisible()).toBe(false);
    ss.dispose();
  });
});

describe('StarSystem ephemeris-driven body positions (3re.3)', () => {
  it('calls ps.positionsAt on every update() and re-uploads the iPosition attribute', () => {
    const ss = new StarSystem();
    let lastT: number | null = null;
    let calls = 0;
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [makePlanet({ semiMajorAxisAu: 1 }), makePlanet({ semiMajorAxisAu: 2 })],
      positionsAt: (t, out) => {
        lastT = t;
        calls++;
        // Encode `t` into the position so the test can verify the
        // buffer reflects the latest call.
        for (let i = 0; i < out.length; i += 3) {
          out[i + 0] = t * 0.001 + i;
          out[i + 1] = 0;
          out[i + 2] = 0;
        }
      },
    };
    ss.setPlanetSystem(ps, 0);
    // Initial fill from setPlanetSystem (Date.now()-driven).
    expect(calls).toBeGreaterThanOrEqual(1);

    const beforeUpdate = calls;
    ss.update(makeCamera(5 * AU_PC), 800, undefined, 12345);
    expect(calls).toBe(beforeUpdate + 1);
    expect(lastT).toBe(12345);

    // The bodyLocalPositions buffer should have updated x = t * 0.001
    // for each planet (after the host's orientation rotation — for a
    // non-Sol host the orientation rotates +z onto the galactic pole,
    // which leaves +x close to itself for galactic-z-aligned input).
    const positions = ss.getPlanetLocalPositions()!;
    expect(positions).not.toBeNull();
    expect(positions.length).toBe(6);
    // Magnitude of each planet's xy projection should be near the
    // encoded |x| value (rotation preserves length).
    const mag0 = Math.hypot(positions[0], positions[1], positions[2]);
    expect(mag0).toBeCloseTo(12345 * 0.001, 6);
    ss.dispose();
  });

  it('falls back to placeholder positions when ps.positionsAt is undefined', () => {
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [makePlanet({ semiMajorAxisAu: 1 })],
      // positionsAt intentionally absent
    };
    ss.setPlanetSystem(ps, 0);
    const initial = Array.from(ss.getPlanetLocalPositions()!);
    // Calling update with a wildly different `t` should NOT change the
    // positions — the placeholder path is set-once.
    ss.update(makeCamera(5 * AU_PC), 800, undefined, 1e9);
    const after = Array.from(ss.getPlanetLocalPositions()!);
    expect(after).toEqual(initial);
    ss.dispose();
  });
});

describe('StarSystem orbit-ring orientation (3re.13)', () => {
  it('a non-zero inclination tilts the ring out of the host plane', () => {
    // Inclination 30°, no node / argperi rotation. The ring should
    // sit on a plane tilted 30° from the host plane (which for a
    // non-Sol host is the galactic plane). The ring's z-extent in
    // the host plane frame should be a·sin(30°) = 0.5·a.
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 1,
      planets: [makePlanet({ semiMajorAxisAu: 1, eccentricity: 0 })],
      orbitOrientations: [{
        inclination: 30 * Math.PI / 180,
        longAscNode: 0,
        argPerihelion: 0,
      }],
    };
    ss.setPlanetSystem(ps, 0);
    // Rummage in the scene graph for the ring's position buffer.
    const ringLine = ss.group.children.find(
      (c) => (c as THREE.LineLoop).isLineLoop,
    ) as THREE.LineLoop | undefined;
    expect(ringLine).toBeDefined();
    const positions = (ringLine!.geometry as THREE.BufferGeometry)
      .getAttribute('position').array as Float32Array;
    // Compute max |z'| where z' is the host-plane-normal component.
    // For a galactic-pole-normal host plane the normal is the galactic
    // north pole; project each vertex onto it.
    const normal = GALACTIC_NORTH_POLE_ICRS.clone();
    let maxAbsZ = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const dot = positions[i] * normal.x
        + positions[i + 1] * normal.y
        + positions[i + 2] * normal.z;
      maxAbsZ = Math.max(maxAbsZ, Math.abs(dot));
    }
    // Expect ~0.5 × 1 AU. Tolerance loose enough to absorb the 128-
    // segment discretisation (≈cos error well below 1%).
    expect(maxAbsZ / AU_PC).toBeGreaterThan(0.49);
    expect(maxAbsZ / AU_PC).toBeLessThan(0.51);
    ss.dispose();
  });

  it('without orbitOrientations the ring sits flat on the host plane', () => {
    // Same setup as above but no orbitOrientations field — ring
    // collapses to the host-plane disc; the host-normal projection
    // should be ~zero across all vertices.
    const ss = new StarSystem();
    const ps: PlanetSystem = {
      hostStarIdx: 1,
      planets: [makePlanet({ semiMajorAxisAu: 1, eccentricity: 0 })],
    };
    ss.setPlanetSystem(ps, 0);
    const ringLine = ss.group.children.find(
      (c) => (c as THREE.LineLoop).isLineLoop,
    ) as THREE.LineLoop | undefined;
    expect(ringLine).toBeDefined();
    const positions = (ringLine!.geometry as THREE.BufferGeometry)
      .getAttribute('position').array as Float32Array;
    const normal = GALACTIC_NORTH_POLE_ICRS.clone();
    let maxAbsZ = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const dot = positions[i] * normal.x
        + positions[i + 1] * normal.y
        + positions[i + 2] * normal.z;
      maxAbsZ = Math.max(maxAbsZ, Math.abs(dot));
    }
    expect(maxAbsZ).toBeLessThan(1e-9);
    ss.dispose();
  });
});
