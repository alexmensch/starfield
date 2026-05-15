import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { newArrival, tickArrival } from './camera-motion';

// Co-linear arrival: pStart on +X at distance 5, pEnd on +X at distance 1,
// target at the origin. Distances along the lerp are exact closed-form
// expressions in the legacy piecewise smoothstep f(u), so the curve pin
// can use `toBe(...)` for every sample.
function makeArrival() {
  return newArrival({
    pStart: new THREE.Vector3(5, 0, 0),
    pEnd: new THREE.Vector3(1, 0, 0),
    target: { center: new THREE.Vector3(0, 0, 0), parkDist: 1 },
    startMs: 0,
    durationMs: 1000,
  });
}

function makeCamera() {
  return new THREE.PerspectiveCamera(50, 1, 1e-7, 1000);
}

describe('camera-motion newArrival', () => {
  it('caches d0 and dEnd at construction', () => {
    const s = makeArrival();
    expect(s.d0).toBe(5);
    expect(s.dEnd).toBe(1);
  });

  it('clones inputs so caller scratch vectors do not bleed into state', () => {
    const pStart = new THREE.Vector3(5, 0, 0);
    const pEnd = new THREE.Vector3(1, 0, 0);
    const center = new THREE.Vector3(0, 0, 0);
    const qStart = new THREE.Quaternion();
    const qEnd = new THREE.Quaternion(0, 0, 0, 1);
    const s = newArrival({
      pStart, pEnd, qStart, qEnd,
      target: { center, parkDist: 1 },
      startMs: 0, durationMs: 1000,
    });
    pStart.set(99, 99, 99);
    pEnd.set(99, 99, 99);
    center.set(99, 99, 99);
    qStart.set(0.5, 0.5, 0.5, 0.5);
    expect(s.pStart.equals(new THREE.Vector3(5, 0, 0))).toBe(true);
    expect(s.pEnd.equals(new THREE.Vector3(1, 0, 0))).toBe(true);
    expect(s.target.center.equals(new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(s.qStart!.x).toBe(0);
  });
});

describe('camera-motion tickArrival — curve pin (legacy piecewise smoothstep)', () => {
  // Pins the easing at u = {0, 0.25, 0.5, 0.75, 1.0} for f(u) =
  //   2u²        for u < 0.5
  //   1 − 2(1−u)² for u ≥ 0.5
  // Camera distance from the target centre under a co-linear pStart/pEnd is
  //   d0 + f·(dEnd − d0)
  // so each sample is closed-form. This regression-pins the legacy curve
  // so stellata-2br.3's swap to the log-distance cubic-Hermite profile is
  // unambiguously a behaviour change rather than a stealth drift.
  it.each([
    { u: 0,    nowMs: 0,    expectedDist: 5,   expectedDone: false },
    { u: 0.25, nowMs: 250,  expectedDist: 4.5, expectedDone: false },
    { u: 0.5,  nowMs: 500,  expectedDist: 3,   expectedDone: false },
    { u: 0.75, nowMs: 750,  expectedDist: 1.5, expectedDone: false },
    { u: 1,    nowMs: 1000, expectedDist: 1,   expectedDone: true  },
  ])('u=$u → dist=$expectedDist, done=$expectedDone', ({ nowMs, expectedDist, expectedDone }) => {
    const s = makeArrival();
    const cam = makeCamera();
    const { done } = tickArrival(s, nowMs, cam);
    const dist = cam.position.distanceTo(s.target.center);
    expect(Math.abs(dist - expectedDist)).toBeLessThan(1e-9);
    expect(done).toBe(expectedDone);
  });
});

describe('camera-motion tickArrival — endpoints and done', () => {
  it('lands exactly on pStart at u=0', () => {
    const s = makeArrival();
    const cam = makeCamera();
    tickArrival(s, 0, cam);
    expect(cam.position.equals(s.pStart)).toBe(true);
  });

  it('lands exactly on pEnd at u=1', () => {
    const s = makeArrival();
    const cam = makeCamera();
    tickArrival(s, 1000, cam);
    expect(cam.position.equals(s.pEnd)).toBe(true);
  });

  it('clamps past the endpoint when nowMs overshoots durationMs', () => {
    const s = makeArrival();
    const cam = makeCamera();
    const { done } = tickArrival(s, 999_999, cam);
    expect(done).toBe(true);
    expect(cam.position.equals(s.pEnd)).toBe(true);
  });

  it('done is false at nowMs just under durationMs and true at exactly durationMs', () => {
    const s = makeArrival();
    const cam = makeCamera();
    expect(tickArrival(s, 999, cam).done).toBe(false);
    expect(tickArrival(s, 1000, cam).done).toBe(true);
  });
});

describe('camera-motion tickArrival — quaternion track', () => {
  it('slerps the camera quaternion when both qStart and qEnd are provided', () => {
    // 180° rotation about +Y so f=0.5 lands halfway (90° about +Y).
    const qStart = new THREE.Quaternion();
    const qEnd = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI,
    );
    const s = newArrival({
      pStart: new THREE.Vector3(5, 0, 0),
      pEnd: new THREE.Vector3(1, 0, 0),
      qStart, qEnd,
      target: { center: new THREE.Vector3(0, 0, 0), parkDist: 1 },
      startMs: 0, durationMs: 1000,
    });
    const cam = makeCamera();
    // u = 0.5 → f = 0.5 → 90° about +Y.
    tickArrival(s, 500, cam);
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    expect(cam.quaternion.x).toBeCloseTo(expected.x, 12);
    expect(cam.quaternion.y).toBeCloseTo(expected.y, 12);
    expect(cam.quaternion.z).toBeCloseTo(expected.z, 12);
    expect(cam.quaternion.w).toBeCloseTo(expected.w, 12);
  });

  it('leaves the camera quaternion alone when qStart/qEnd are omitted', () => {
    const s = makeArrival(); // no qStart/qEnd
    const cam = makeCamera();
    cam.quaternion.set(0.1, 0.2, 0.3, 0.92736);
    const before = cam.quaternion.clone();
    tickArrival(s, 500, cam);
    expect(cam.quaternion.x).toBe(before.x);
    expect(cam.quaternion.y).toBe(before.y);
    expect(cam.quaternion.z).toBe(before.z);
    expect(cam.quaternion.w).toBe(before.w);
  });
});
