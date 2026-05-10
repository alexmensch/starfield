import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { shiftWarpWaypoints } from './warp-pure';

function makeState(
  a: [number, number, number],
  pStart: [number, number, number],
  pEnd: [number, number, number],
) {
  return {
    A: new THREE.Vector3(...a),
    pStart: new THREE.Vector3(...pStart),
    pEnd: new THREE.Vector3(...pEnd),
  };
}

describe('shiftWarpWaypoints', () => {
  it('subtracts the delta from every positional field in place', () => {
    const s = makeState([10, 20, 30], [11, 21, 31], [12, 22, 32]);
    shiftWarpWaypoints(s, 1, 2, 3);
    expect(s.A.toArray()).toEqual([9, 18, 27]);
    expect(s.pStart.toArray()).toEqual([10, 19, 28]);
    expect(s.pEnd.toArray()).toEqual([11, 20, 29]);
  });

  it('is a no-op for a zero delta', () => {
    const s = makeState([10, 20, 30], [11, 21, 31], [12, 22, 32]);
    shiftWarpWaypoints(s, 0, 0, 0);
    expect(s.A.toArray()).toEqual([10, 20, 30]);
    expect(s.pStart.toArray()).toEqual([11, 21, 31]);
    expect(s.pEnd.toArray()).toEqual([12, 22, 32]);
  });

  it('composes: shifting by d1 then d2 equals shifting by (d1+d2)', () => {
    const a = makeState([10, 20, 30], [11, 21, 31], [12, 22, 32]);
    const b = makeState([10, 20, 30], [11, 21, 31], [12, 22, 32]);
    shiftWarpWaypoints(a, 1, 2, 3);
    shiftWarpWaypoints(a, 4, 5, 6);
    shiftWarpWaypoints(b, 5, 7, 9);
    expect(a.A.toArray()).toEqual(b.A.toArray());
    expect(a.pStart.toArray()).toEqual(b.pStart.toArray());
    expect(a.pEnd.toArray()).toEqual(b.pEnd.toArray());
  });

  it('migrates a waypoint between frames so it tracks the same physical point', () => {
    // Setup: source origin at S=(100,200,300), pEnd at local (1,2,3) → its
    // physical (absolute) location is (101,202,303). After recentring the
    // floating origin to N=(105,210,310), the delta is N−S=(5,10,10).
    // shiftWarpWaypoints must leave pEnd pointing at the same physical
    // point, which in the new frame is (101-105, 202-210, 303-310) =
    // (-4,-8,-7).
    const s = makeState([0, 0, 0], [0, 0, 0], [1, 2, 3]);
    shiftWarpWaypoints(s, 5, 10, 10);
    expect(s.pEnd.x).toBeCloseTo(-4, 12);
    expect(s.pEnd.y).toBeCloseTo(-8, 12);
    expect(s.pEnd.z).toBeCloseTo(-7, 12);
  });

  it('lands pEnd at local (0,0,0) when the new origin coincides with the destination', () => {
    // The phase-3 invariant for observe→observe warps: at warp start
    // pEnd = B − forward·endOffset, so |pEnd − B| = endOffset. When the
    // floating origin recentres to B's absolute position, the recentre
    // delta is exactly (B − previousOrigin) = previousLocalB. After
    // shifting, pEnd's new value is pEnd_local − previousLocalB =
    // (B − forward·endOffset − B) = −forward·endOffset. The post-arrival
    // lerp pEnd → B in the new frame thus lerps from −forward·endOffset
    // to (0,0,0) — the recentred destination.
    const previousLocalB = new THREE.Vector3(50, 0, 0);
    const forward = new THREE.Vector3(1, 0, 0);
    const endOffset = 0.01;
    const pEndOld = previousLocalB.clone().addScaledVector(forward, -endOffset);
    const s = makeState([0, 0, 0], [0, 0, 0], pEndOld.toArray() as [number, number, number]);
    shiftWarpWaypoints(s, previousLocalB.x, previousLocalB.y, previousLocalB.z);
    expect(s.pEnd.x).toBeCloseTo(-endOffset, 12);
    expect(s.pEnd.y).toBeCloseTo(0, 12);
    expect(s.pEnd.z).toBeCloseTo(0, 12);
    // And the lerp endpoint at f=1 (i.e. the destination) is (0,0,0).
    const lerp = s.pEnd.clone().lerp(new THREE.Vector3(0, 0, 0), 1);
    expect(lerp.lengthSq()).toBeLessThan(1e-24);
  });
});
