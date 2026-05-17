// AimController tests (stellata-9mm.194.4).
//
// Covers: slerp lifecycle (start → tick → land), supersession via
// cancel(), dispose tear-down, navigate vs observe branches. The two
// numeric facts the bead pins via toBe(N) (per stellata-test-coverage-
// discipline) are: the AIM_T_MIN_MS floor on `aimDurationMs(0)`, and the
// 2·acos(|q0·q1|) geodesic-angle formula that drives the observe-branch
// duration.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { AimController, aimDurationMs, type AimControllerDeps } from './aim-controller';
import { AIM_T_MAX_MS, AIM_T_MIN_MS } from './timing';
import type { ObserveControls } from './observe-controls';

// Minimal stub for TrackballControls — only `enabled`, `target`, and
// `update()` are touched by the controller.
function makeControlsStub(): TrackballControls & { update: ReturnType<typeof vi.fn> } {
  return {
    enabled: true,
    target: new THREE.Vector3(0, 0, 0),
    update: vi.fn(),
  } as unknown as TrackballControls & { update: ReturnType<typeof vi.fn> };
}

function makeObserveControlsStub(): ObserveControls & {
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
} {
  return {
    enable: vi.fn(),
    disable: vi.fn(),
  } as unknown as ObserveControls & {
    enable: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(mode: 'navigate' | 'observe' = 'navigate') {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const controls = makeControlsStub();
  const observeControls = makeObserveControlsStub();
  let cameraMode = mode;
  const deps: AimControllerDeps = {
    camera,
    controls,
    observeControls,
    getCameraMode: () => cameraMode,
  };
  return {
    aim: new AimController(deps),
    camera,
    controls,
    observeControls,
    setCameraMode: (m: 'navigate' | 'observe') => { cameraMode = m; },
  };
}

describe('aimDurationMs', () => {
  it('floors at AIM_T_MIN_MS for a zero-angle nudge', () => {
    expect(aimDurationMs(0)).toBe(AIM_T_MIN_MS);
  });
  it('caps at AIM_T_MAX_MS for a half-circle swing', () => {
    expect(aimDurationMs(Math.PI)).toBe(AIM_T_MAX_MS);
  });
  it('scales linearly between floor and cap', () => {
    expect(aimDurationMs(Math.PI / 2)).toBe(AIM_T_MAX_MS / 2);
  });
  it('floor wins below the cross-over angle', () => {
    // Linear ramp value at angle = AIM_T_MIN_MS/AIM_T_MAX_MS * π equals
    // AIM_T_MIN_MS exactly. Halve that and the floor wins.
    const crossover = (AIM_T_MIN_MS / AIM_T_MAX_MS) * Math.PI;
    expect(aimDurationMs(crossover / 2)).toBe(AIM_T_MIN_MS);
  });
});

describe('AimController — navigate slerp lifecycle', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness('navigate'); });

  it('starts an aim and disables TrackballControls', () => {
    // Camera at (10,0,0) orbiting origin. Aim at (0,10,0) — 90° swing
    // around the pivot.
    h.camera.position.set(10, 0, 0);
    h.controls.target.set(0, 0, 0);
    h.aim.aimAt(new THREE.Vector3(0, 10, 0));
    expect(h.aim.isActive()).toBe(true);
    expect(h.controls.enabled).toBe(false);
  });

  it('lands camera at the opposite-side parking pose and re-enables controls', () => {
    h.camera.position.set(10, 0, 0);
    h.controls.target.set(0, 0, 0);
    const startMs = performance.now();
    h.aim.aimAt(new THREE.Vector3(0, 10, 0));
    // Tick at start + AIM_T_MAX_MS — guaranteed past the 90° duration cap.
    h.aim.tick(startMs + AIM_T_MAX_MS + 1);
    expect(h.aim.isActive()).toBe(false);
    expect(h.controls.enabled).toBe(true);
    expect(h.controls.update).toHaveBeenCalled();
    // End pose: camera on opposite side of pivot from the aim point at
    // the same radius. Aim at +Y → camera lands at -Y * 10.
    expect(h.camera.position.x).toBeCloseTo(0, 5);
    expect(h.camera.position.y).toBeCloseTo(-10, 5);
    expect(h.camera.position.z).toBeCloseTo(0, 5);
  });

  it('mid-tick keeps the controller active', () => {
    h.camera.position.set(10, 0, 0);
    const startMs = performance.now();
    h.aim.aimAt(new THREE.Vector3(0, 10, 0));
    h.aim.tick(startMs + 1); // 1 ms into the slerp
    expect(h.aim.isActive()).toBe(true);
    expect(h.controls.enabled).toBe(false);
  });

  it('no-op when called twice — second aim is suppressed', () => {
    h.camera.position.set(10, 0, 0);
    h.aim.aimAt(new THREE.Vector3(0, 10, 0));
    const firstActive = h.aim.isActive();
    h.aim.aimAt(new THREE.Vector3(0, -10, 0)); // would-be 180° re-aim
    expect(firstActive).toBe(true);
    expect(h.aim.isActive()).toBe(true); // first slerp still owns the slot
  });

  it('no-op when camera coincides with pivot', () => {
    h.camera.position.set(0, 0, 0);
    h.controls.target.set(0, 0, 0);
    h.aim.aimAt(new THREE.Vector3(1, 0, 0));
    expect(h.aim.isActive()).toBe(false);
    expect(h.controls.enabled).toBe(true);
  });

  it('no-op when point coincides with pivot', () => {
    h.camera.position.set(10, 0, 0);
    h.controls.target.set(0, 0, 0);
    h.aim.aimAt(new THREE.Vector3(0, 0, 0));
    expect(h.aim.isActive()).toBe(false);
    expect(h.controls.enabled).toBe(true);
  });

  it('no-op when already aimed (dir0 == dir1)', () => {
    // Camera at (+X, 0, 0) currently aimed at origin (forward = -X). For
    // the aim-end pose to coincide with the start pose, the point must
    // lie on the line through pivot in the direction camera→pivot
    // extended, i.e. somewhere on -X past origin.
    h.camera.position.set(10, 0, 0);
    h.controls.target.set(0, 0, 0);
    h.aim.aimAt(new THREE.Vector3(-5, 0, 0));
    expect(h.aim.isActive()).toBe(false);
    expect(h.controls.enabled).toBe(true);
  });
});

describe('AimController — observe slerp lifecycle', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness('observe'); });

  it('starts an observe aim and disables ObserveControls', () => {
    h.camera.position.set(0, 0, 0); // parked at focal star
    h.camera.lookAt(0, 0, -1);      // currently facing -Z
    h.camera.updateMatrixWorld();
    h.aim.aimAt(new THREE.Vector3(1, 0, -1)); // 45° swing toward +X
    expect(h.aim.isObserveAimActive()).toBe(true);
    expect(h.observeControls.disable).toHaveBeenCalled();
    expect(h.aim.isActive()).toBe(false); // navigate slot stays clear
  });

  it('lands camera quaternion at lookAt(point) and re-enables ObserveControls', () => {
    h.camera.position.set(0, 0, 0);
    h.camera.lookAt(0, 0, -1);
    h.camera.updateMatrixWorld();
    const startMs = performance.now();
    h.aim.aimAt(new THREE.Vector3(1, 0, -1));
    h.aim.tickObserve(startMs + AIM_T_MAX_MS + 1);
    expect(h.aim.isObserveAimActive()).toBe(false);
    expect(h.observeControls.enable).toHaveBeenCalled();
    // Land quaternion ≈ lookAt(point) quaternion.
    const expected = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(
        h.camera.position,
        new THREE.Vector3(1, 0, -1),
        new THREE.Vector3(0, 1, 0),
      ),
    );
    expect(h.camera.quaternion.dot(expected)).toBeCloseTo(1, 5);
  });

  it('no-op when point coincides with camera position', () => {
    h.camera.position.set(1, 2, 3);
    h.aim.aimAt(new THREE.Vector3(1, 2, 3));
    expect(h.aim.isObserveAimActive()).toBe(false);
    expect(h.observeControls.disable).not.toHaveBeenCalled();
  });

  it('no-op when already aimed', () => {
    h.camera.position.set(0, 0, 0);
    h.camera.lookAt(0, 0, -1);
    h.camera.updateMatrixWorld();
    // Aim at a point along the current forward direction — q0 == q1.
    h.aim.aimAt(new THREE.Vector3(0, 0, -5));
    expect(h.aim.isObserveAimActive()).toBe(false);
  });

  it('observe duration derives from the 2·acos(|q0·q1|) geodesic formula', () => {
    h.camera.position.set(0, 0, 0);
    h.camera.lookAt(0, 0, -1);
    h.camera.updateMatrixWorld();
    const q0 = h.camera.quaternion.clone();
    // Pick a point that gives a known target quaternion.
    const point = new THREE.Vector3(1, 0, -1);
    const lookMat = new THREE.Matrix4().lookAt(
      h.camera.position,
      point,
      new THREE.Vector3(0, 1, 0),
    );
    const q1 = new THREE.Quaternion().setFromRotationMatrix(lookMat);
    const dot = Math.min(1, Math.abs(q0.dot(q1)));
    const expectedAngle = 2 * Math.acos(dot);
    const expectedDuration = aimDurationMs(expectedAngle);

    const startMs = performance.now();
    h.aim.aimAt(point);
    // Tick one ms before expected landing — must still be active.
    h.aim.tickObserve(startMs + expectedDuration - 1);
    expect(h.aim.isObserveAimActive()).toBe(true);
    // Tick one ms past expected landing — must have completed.
    h.aim.tickObserve(startMs + expectedDuration + 1);
    expect(h.aim.isObserveAimActive()).toBe(false);
  });
});

describe('AimController — cancel / dispose / mode isolation', () => {
  it('cancel() drops navigate state without re-enabling controls', () => {
    const h = makeHarness('navigate');
    h.camera.position.set(10, 0, 0);
    h.aim.aimAt(new THREE.Vector3(0, 10, 0));
    expect(h.aim.isActive()).toBe(true);
    expect(h.controls.enabled).toBe(false);
    h.aim.cancel();
    expect(h.aim.isActive()).toBe(false);
    // Caller (warp, observe-exit) owns the next controls.enabled transition.
    expect(h.controls.enabled).toBe(false);
    expect(h.controls.update).not.toHaveBeenCalled();
  });

  it('cancel() drops observe state without calling observeControls.enable', () => {
    const h = makeHarness('observe');
    h.camera.position.set(0, 0, 0);
    h.camera.lookAt(0, 0, -1);
    h.camera.updateMatrixWorld();
    h.aim.aimAt(new THREE.Vector3(1, 0, -1));
    expect(h.aim.isObserveAimActive()).toBe(true);
    h.aim.cancel();
    expect(h.aim.isObserveAimActive()).toBe(false);
    expect(h.observeControls.enable).not.toHaveBeenCalled();
  });

  it('cancel() mid-tick prevents the next tick from advancing the camera', () => {
    const h = makeHarness('navigate');
    h.camera.position.set(10, 0, 0);
    const startMs = performance.now();
    h.aim.aimAt(new THREE.Vector3(0, 10, 0));
    h.aim.cancel();
    const posBefore = h.camera.position.clone();
    h.aim.tick(startMs + 100);
    expect(h.camera.position.x).toBe(posBefore.x);
    expect(h.camera.position.y).toBe(posBefore.y);
    expect(h.camera.position.z).toBe(posBefore.z);
  });

  it('dispose() clears both slots and stops both ticks', () => {
    const h = makeHarness('navigate');
    h.camera.position.set(10, 0, 0);
    h.aim.aimAt(new THREE.Vector3(0, 10, 0));
    h.aim.dispose();
    expect(h.aim.isActive()).toBe(false);
    expect(h.aim.isObserveAimActive()).toBe(false);
    h.aim.tick(performance.now() + 1000);
    h.aim.tickObserve(performance.now() + 1000);
    // dispose() is idempotent — no throw, no state revival.
    expect(h.aim.isActive()).toBe(false);
    expect(h.aim.isObserveAimActive()).toBe(false);
  });

  it('navigate aim is rejected while in observe mode', () => {
    const h = makeHarness('observe');
    h.camera.position.set(10, 0, 0);
    h.controls.target.set(0, 0, 0);
    // observe-mode aim path runs — but starts the observe slot, not navigate.
    h.aim.aimAt(new THREE.Vector3(0, 10, 0));
    expect(h.aim.isActive()).toBe(false);
  });
});
