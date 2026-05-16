import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  newFocusLerpFrom,
  parkDistance,
  tickFocusLerp,
} from './focus-transition';
import { AU_PC, R_SUN_PC } from './astronomy-constants';
import {
  AIM_T_MAX_MS,
  CAMERA_LERP_MS,
  FOCUS_LERP_MS,
  WARP_REORIENT_MS,
} from './stellata';

describe('camera-lerp duration consolidation (r9q.2)', () => {
  it('routes AIM_T_MAX_MS / FOCUS_LERP_MS through CAMERA_LERP_MS', () => {
    expect(CAMERA_LERP_MS).toBe(2000);
    expect(AIM_T_MAX_MS).toBe(CAMERA_LERP_MS);
    expect(FOCUS_LERP_MS).toBe(CAMERA_LERP_MS);
  });

  it('keeps WARP_REORIENT_MS tuned slightly under the canonical lerp', () => {
    expect(WARP_REORIENT_MS).toBe(1800);
    expect(WARP_REORIENT_MS).toBeLessThan(CAMERA_LERP_MS);
  });
});

describe('parkDistance', () => {
  // Sol's catalogued radius is 1.035 R_sun (the v4 catalog uses the
  // luminosity-class lookup). Use 1.0 R_sun here so the assertion is
  // independent of catalog precision.
  const SOL_R_PC = R_SUN_PC;

  it('parks Sol just outside Earth\'s orbit', () => {
    // dMinFloor and extraFloor are tiny vs 1 AU so the AU_PC + R term wins.
    const d = parkDistance({ R_pc: SOL_R_PC, dMinFloor: 0, extraFloor: 0 });
    expect(d).toBe(AU_PC + SOL_R_PC);
    expect(d / AU_PC).toBeGreaterThan(1.0);
    expect(d / AU_PC).toBeLessThan(1.01);
  });

  it('clamps to dMinFloor when the 90 %-fill floor exceeds 1 AU + R', () => {
    // Betelgeuse-scale: ~4.65 AU radius. 1 AU + 4.65 AU = 5.65 AU but the
    // 90 %-fill floor for a star that large sits at ~20 AU, so the floor
    // dominates.
    const Rpc = 4.65 * AU_PC;
    const dMinFloor = 20 * AU_PC;
    const d = parkDistance({ R_pc: Rpc, dMinFloor });
    expect(d).toBe(dMinFloor);
  });

  it('clamps to extraFloor when a binary companion pushes the camera back', () => {
    const extraFloor = 100 * AU_PC;
    const d = parkDistance({
      R_pc: SOL_R_PC,
      dMinFloor: 0,
      extraFloor,
    });
    expect(d).toBe(extraFloor);
  });

  it('handles a variable star where Reff exceeds R', () => {
    // A high-amplitude pulsator with R_peak = 2× the static radius.
    const Rpeak = 2 * R_SUN_PC;
    const d = parkDistance({ R_pc: Rpeak, dMinFloor: 0 });
    expect(d).toBe(AU_PC + Rpeak);
  });

  it('treats extraFloor as zero when omitted', () => {
    const d = parkDistance({ R_pc: SOL_R_PC, dMinFloor: 0 });
    expect(d).toBe(AU_PC + SOL_R_PC);
  });
});

describe('newFocusLerpFrom', () => {
  const Y_UP = new THREE.Vector3(0, 1, 0);
  const IDENTITY = new THREE.Quaternion();

  it('parks the lerp endpoint at parkDist along the current eye direction', () => {
    const cam = new THREE.Vector3(0, 0, 5 * AU_PC);
    const target = new THREE.Vector3(0, 0, 0);
    const parkDist = AU_PC;
    const state = newFocusLerpFrom(cam, IDENTITY, Y_UP, target, parkDist, 2000, 0);
    expect(state.pEnd.distanceTo(target)).toBeCloseTo(parkDist, 14);
    expect(state.pEnd.z).toBeCloseTo(parkDist, 14);
    expect(state.pEnd.x).toBeCloseTo(0, 14);
    expect(state.pEnd.y).toBeCloseTo(0, 14);
  });

  it('clones inputs so later camera moves do not mutate state', () => {
    const cam = new THREE.Vector3(0, 0, 5 * AU_PC);
    const quat = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const state = newFocusLerpFrom(cam, quat, up, new THREE.Vector3(), AU_PC, 2000, 0);
    cam.set(99, 99, 99);
    quat.set(0.5, 0.5, 0.5, 0.5);
    up.set(99, 99, 99);
    expect(state.pStart.equals(new THREE.Vector3(0, 0, 5 * AU_PC))).toBe(true);
    expect(state.qStart!.x).toBe(0);
  });

  it('falls back to +Z when camera is coincident with target', () => {
    const cam = new THREE.Vector3(0, 0, 0);
    const target = new THREE.Vector3(0, 0, 0);
    const state = newFocusLerpFrom(cam, IDENTITY, Y_UP, target, AU_PC, 2000, 0);
    expect(state.pEnd.z).toBeCloseTo(AU_PC, 14);
  });

  it('captures an end-quaternion that looks at the target from pEnd', () => {
    // Camera 5 AU back along +Z, looking at origin. End-orientation
    // must still point at origin (so qEnd ≈ identity for a +Z eye).
    const cam = new THREE.Vector3(0, 0, 5 * AU_PC);
    const target = new THREE.Vector3();
    const state = newFocusLerpFrom(cam, IDENTITY, Y_UP, target, AU_PC, 2000, 0);
    // Verify by applying qEnd to (0,0,-1) — should give the direction
    // from pEnd to target. That direction is (target - pEnd).normalize().
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(state.qEnd!);
    const expected = new THREE.Vector3().subVectors(target, state.pEnd).normalize();
    expect(fwd.x).toBeCloseTo(expected.x, 12);
    expect(fwd.y).toBeCloseTo(expected.y, 12);
    expect(fwd.z).toBeCloseTo(expected.z, 12);
  });
});

describe('tickFocusLerp', () => {
  const Y_UP = new THREE.Vector3(0, 1, 0);
  const IDENTITY = new THREE.Quaternion();

  function makeState() {
    return newFocusLerpFrom(
      new THREE.Vector3(0, 0, 5 * AU_PC),
      IDENTITY,
      Y_UP,
      new THREE.Vector3(0, 0, 0),
      AU_PC,
      2000,
      1000,
    );
  }

  it('returns true while in flight and writes the eased position', () => {
    const state = makeState();
    const cam = new THREE.PerspectiveCamera(50, 1, 1e-7, 1000);
    cam.position.copy(state.pStart);
    const active = tickFocusLerp(state, 2000, cam);
    expect(active).toBe(true);
    // At t = 0.5 the cubic-Hermite log-distance profile eases to f = 0.5
    // — distance from target is the geometric mean √(d0·dEnd) (not the
    // arithmetic mean). pStart at z = 5·AU_PC, pEnd at z = AU_PC, both
    // on +Z, target at origin → cam.z = √(5)·AU_PC.
    const midZ = Math.sqrt(5) * AU_PC;
    expect(cam.position.z).toBeCloseTo(midZ, 14);
  });

  it('lands exactly on pEnd and qEnd when duration has elapsed', () => {
    const state = makeState();
    const cam = new THREE.PerspectiveCamera(50, 1, 1e-7, 1000);
    cam.position.copy(state.pStart);
    const active = tickFocusLerp(state, 1000 + state.durationMs, cam);
    expect(active).toBe(false);
    expect(cam.position.equals(state.pEnd)).toBe(true);
    expect(cam.quaternion.x).toBeCloseTo(state.qEnd!.x, 14);
    expect(cam.quaternion.y).toBeCloseTo(state.qEnd!.y, 14);
    expect(cam.quaternion.z).toBeCloseTo(state.qEnd!.z, 14);
    expect(cam.quaternion.w).toBeCloseTo(state.qEnd!.w, 14);
  });

  it('does not run past the endpoint when nowMs overshoots durationMs', () => {
    const state = makeState();
    const cam = new THREE.PerspectiveCamera(50, 1, 1e-7, 1000);
    cam.position.copy(state.pStart);
    const active = tickFocusLerp(state, 1000 + 999_999, cam);
    expect(active).toBe(false);
    expect(cam.position.equals(state.pEnd)).toBe(true);
  });
});
