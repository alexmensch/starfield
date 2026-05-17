// Aim-slerp state machines: rotate camera so a world point lands at
// view centre. Navigate orbits around controls.target at constant
// radius; observe holds camera position and slerps quaternion in place.
//
// Each branch disables its host input controller for the duration and
// re-enables on natural completion. `cancel()` is the supersession path
// (warp.start / observe-exit): nullifies state but does NOT re-enable,
// because the caller is moving control elsewhere.

import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { CameraMode } from '../stellata';
import type { ObserveControls } from './observe-controls';
import { AIM_T_MAX_MS, AIM_T_MIN_MS, WARP_BASE_DIR } from './timing';

interface NavigateAimState {
  startTimeMs: number;
  durationMs: number;
  q0: THREE.Quaternion;       // rotates WARP_BASE_DIR to the start radial dir
  q1: THREE.Quaternion;       // rotates WARP_BASE_DIR to the end radial dir
  radius: number;             // |camera - pivot| at start; held constant
  pivot: THREE.Vector3;       // controls.target snapshot, in local frame
}

interface ObserveAimState {
  startTimeMs: number;
  durationMs: number;
  q0: THREE.Quaternion;
  q1: THREE.Quaternion;
}

export interface AimControllerDeps {
  camera: THREE.PerspectiveCamera;
  controls: TrackballControls;
  observeControls: ObserveControls;
  getCameraMode: () => CameraMode;
}

export class AimController {
  private readonly deps: AimControllerDeps;
  private navigate: NavigateAimState | null = null;
  private observe: ObserveAimState | null = null;
  // Per-tick scratch — reused so the animation never allocates.
  private readonly tickQ = new THREE.Quaternion();
  private readonly tickDir = new THREE.Vector3();
  private readonly tickObserveQ = new THREE.Quaternion();

  constructor(deps: AimControllerDeps) {
    this.deps = deps;
  }

  isActive(): boolean { return this.navigate !== null; }
  isObserveAimActive(): boolean { return this.observe !== null; }

  /** Smoothly rotate the camera so `pointLocal` (a world point in the
   *  renderer's local frame) ends up at the centre of the view.
   *  Mode-aware: navigate slerps the orbit pose, observe slerps the
   *  camera quaternion in place.
   *
   *  No-ops if the corresponding mode's aim is already active. The
   *  warp / focus-lerp / observe-transition busy checks live on the
   *  composition shell — call `aim.aimAt(point)` only when those gates
   *  have cleared. */
  aimAt(pointLocal: THREE.Vector3): void {
    if (this.deps.getCameraMode() === 'observe') {
      if (this.observe !== null) return;
      this.startObserveAim(pointLocal);
    } else {
      if (this.navigate !== null) return;
      this.startNavigateAim(pointLocal);
    }
  }

  /** Supersession cancellation — used by warp.start and observe-exit.
   *  Drops both slot states without re-enabling controls/observeControls;
   *  the caller is moving camera control elsewhere and owns the next
   *  input-handler transition. */
  cancel(): void {
    this.navigate = null;
    this.observe = null;
  }

  tick(nowMs: number): void {
    const state = this.navigate;
    if (!state) return;
    const u = Math.min(1, (nowMs - state.startTimeMs) / state.durationMs);
    const f = u * u * (3 - 2 * u);
    this.tickQ.copy(state.q0).slerp(state.q1, f);
    this.tickDir.copy(WARP_BASE_DIR).applyQuaternion(this.tickQ);
    this.deps.camera.position
      .copy(state.pivot)
      .addScaledVector(this.tickDir, state.radius);
    this.deps.camera.lookAt(state.pivot);
    if (u >= 1) {
      this.navigate = null;
      this.deps.controls.enabled = true;
      this.deps.controls.update();
    }
  }

  tickObserve(nowMs: number): void {
    const state = this.observe;
    if (!state) return;
    const u = Math.min(1, (nowMs - state.startTimeMs) / state.durationMs);
    const f = u * u * (3 - 2 * u);
    this.tickObserveQ.copy(state.q0).slerp(state.q1, f);
    this.deps.camera.quaternion.copy(this.tickObserveQ);
    if (u >= 1) {
      this.observe = null;
      this.deps.observeControls.enable();
    }
  }

  dispose(): void {
    this.navigate = null;
    this.observe = null;
  }

  private startNavigateAim(pointLocal: THREE.Vector3): void {
    const camera = this.deps.camera;
    const pivot = this.deps.controls.target;
    const offsetX = camera.position.x - pivot.x;
    const offsetY = camera.position.y - pivot.y;
    const offsetZ = camera.position.z - pivot.z;
    const r = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
    if (r < 1e-6) return; // camera coincident with pivot — no orbit to rotate

    const aimX = pointLocal.x - pivot.x;
    const aimY = pointLocal.y - pivot.y;
    const aimZ = pointLocal.z - pivot.z;
    const aimLen = Math.sqrt(aimX * aimX + aimY * aimY + aimZ * aimZ);
    if (aimLen < 1e-6) return; // target coincides with pivot

    // Start radial direction = camera - pivot, normalised.
    const dir0 = new THREE.Vector3(offsetX / r, offsetY / r, offsetZ / r);
    // End radial direction = -(point - pivot) normalised. Putting the
    // camera on the opposite side of pivot from the target makes the
    // forward vector (pivot - camera) point toward the target.
    const dir1 = new THREE.Vector3(-aimX / aimLen, -aimY / aimLen, -aimZ / aimLen);

    const dot = Math.max(-1, Math.min(1, dir0.dot(dir1)));
    if (dot > 0.99999) return; // already aimed

    const angle = Math.acos(dot);
    const q0 = new THREE.Quaternion().setFromUnitVectors(WARP_BASE_DIR, dir0);
    const q1 = new THREE.Quaternion().setFromUnitVectors(WARP_BASE_DIR, dir1);

    this.deps.controls.enabled = false;
    this.navigate = {
      startTimeMs: performance.now(),
      durationMs: aimDurationMs(angle),
      q0,
      q1,
      radius: r,
      pivot: pivot.clone(),
    };
  }

  private startObserveAim(pointLocal: THREE.Vector3): void {
    const camera = this.deps.camera;
    const aimDx = pointLocal.x - camera.position.x;
    const aimDy = pointLocal.y - camera.position.y;
    const aimDz = pointLocal.z - camera.position.z;
    if (aimDx * aimDx + aimDy * aimDy + aimDz * aimDz < 1e-6) return;

    const lookMat = new THREE.Matrix4().lookAt(
      camera.position,
      pointLocal,
      camera.up,
    );
    const q1 = new THREE.Quaternion().setFromRotationMatrix(lookMat);
    const q0 = camera.quaternion.clone();
    const dot = Math.min(1, Math.abs(q0.dot(q1)));
    if (dot > 0.99999) return;
    // Geodesic angle between two unit quaternions is 2·acos(|q0·q1|).
    const angle = 2 * Math.acos(dot);

    this.deps.observeControls.disable();
    this.observe = {
      startTimeMs: performance.now(),
      durationMs: aimDurationMs(angle),
      q0,
      q1,
    };
  }
}

/** Map an aim swing angle in [0, π] rad to a duration in ms. Linear
 *  ramp from `AIM_T_MIN_MS` (floor for trivial nudges) to `AIM_T_MAX_MS`
 *  (cap for a half-circle swing). Exported so tests can pin the floor
 *  and the linear cross-over without re-deriving them. */
export function aimDurationMs(angleRad: number): number {
  return Math.max(
    AIM_T_MIN_MS,
    Math.min(AIM_T_MAX_MS, (angleRad / Math.PI) * AIM_T_MAX_MS),
  );
}
