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
  it('routes WARP_REORIENT_MS / AIM_T_MAX_MS / FOCUS_LERP_MS through CAMERA_LERP_MS', () => {
    expect(CAMERA_LERP_MS).toBe(2000);
    expect(WARP_REORIENT_MS).toBe(CAMERA_LERP_MS);
    expect(AIM_T_MAX_MS).toBe(CAMERA_LERP_MS);
    expect(FOCUS_LERP_MS).toBe(CAMERA_LERP_MS);
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
  it('parks the lerp endpoint at parkDist along the current eye direction', () => {
    const cam = new THREE.Vector3(0, 0, 5 * AU_PC);
    const target = new THREE.Vector3(0, 0, 0);
    const parkDist = AU_PC;
    const state = newFocusLerpFrom(cam, target, parkDist, 2000, 0);
    expect(state.toPos.distanceTo(target)).toBeCloseTo(parkDist, 14);
    // Same direction as starting eye vector — Z+ in this setup.
    expect(state.toPos.z).toBeCloseTo(parkDist, 14);
    expect(state.toPos.x).toBeCloseTo(0, 14);
    expect(state.toPos.y).toBeCloseTo(0, 14);
  });

  it('clones the start position so later camera moves do not mutate fromPos', () => {
    const cam = new THREE.Vector3(0, 0, 5 * AU_PC);
    const state = newFocusLerpFrom(cam, new THREE.Vector3(), AU_PC, 2000, 0);
    cam.set(99, 99, 99);
    expect(state.fromPos.equals(new THREE.Vector3(0, 0, 5 * AU_PC))).toBe(true);
  });

  it('falls back to +Z when camera is coincident with target', () => {
    const cam = new THREE.Vector3(0, 0, 0);
    const target = new THREE.Vector3(0, 0, 0);
    const state = newFocusLerpFrom(cam, target, AU_PC, 2000, 0);
    expect(state.toPos.z).toBeCloseTo(AU_PC, 14);
  });
});

describe('tickFocusLerp', () => {
  function makeState() {
    return newFocusLerpFrom(
      new THREE.Vector3(0, 0, 5 * AU_PC),
      new THREE.Vector3(0, 0, 0),
      AU_PC,
      2000,
      1000,
    );
  }

  it('returns true while in flight and writes the eased position', () => {
    const state = makeState();
    const cam = new THREE.PerspectiveCamera(50, 1, 1e-7, 1000);
    cam.position.copy(state.fromPos);
    const active = tickFocusLerp(state, 2000, cam);
    expect(active).toBe(true);
    // At t = 0.5 the smoothstep eases to f = 0.5 — camera is exactly
    // halfway between fromPos and toPos.
    const midZ = (state.fromPos.z + state.toPos.z) / 2;
    expect(cam.position.z).toBeCloseTo(midZ, 14);
  });

  it('lands exactly on toPos when duration has elapsed', () => {
    const state = makeState();
    const cam = new THREE.PerspectiveCamera(50, 1, 1e-7, 1000);
    cam.position.copy(state.fromPos);
    const active = tickFocusLerp(state, 1000 + state.durationMs, cam);
    expect(active).toBe(false);
    expect(cam.position.equals(state.toPos)).toBe(true);
  });

  it('does not run past the endpoint when nowMs overshoots durationMs', () => {
    const state = makeState();
    const cam = new THREE.PerspectiveCamera(50, 1, 1e-7, 1000);
    cam.position.copy(state.fromPos);
    const active = tickFocusLerp(state, 1000 + 999_999, cam);
    expect(active).toBe(false);
    expect(cam.position.equals(state.toPos)).toBe(true);
  });
});
