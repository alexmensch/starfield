import * as THREE from 'three';

/** Re-anchor `camera.up` to the camera's current local +Y basis vector.
 *
 *  Required before any `lookAt(target)` that re-engages TrackballControls
 *  on the observe→navigate seam. Without it, `lookAt` re-resolves roll
 *  against world (0,1,0) and snaps any pitch the user accumulated in
 *  OBSERVE back through the horizontal plane — a jump proportional to
 *  how much they looked around. See `camera-up-align.test.ts` for the
 *  pure-algebra fixture and `docs/camera-observe.md` for the seam
 *  context. */
export function alignCameraUpToQuaternion(camera: THREE.Camera): void {
  camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
}
