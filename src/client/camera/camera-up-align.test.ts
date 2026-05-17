import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

// Pure-algebra regression for stellata-a8w (PR #23). The fix is:
//
//   camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
//
// Before any lookAt(target) on the observe→navigate seam. After this
// line, camera.up equals the camera's local +Y basis vector — i.e. the
// second column of the camera's rotation matrix — so a subsequent
// lookAt(target) re-resolves roll against the *current* image-plane
// up, not the world (0, 1, 0). Without it, any pitch the user
// accumulated in observe gets rolled back through the horizontal plane
// on exit.
//
// 9mm.29 extracts this into alignCameraUpToQuaternion() and applies it
// on all three observe-exit paths; this test pins the underlying
// algebra so a future quaternion convention change can't silently
// break it.
describe('camera-up alignment (a8w / 9mm.29)', () => {
  it('aligns camera.up with the camera-local +Y basis vector', () => {
    // Pitch 30° up so the camera is no longer looking flat.
    const quat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 6,
    );
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);

    // camera-local +Y in world: extract column 2 of the rotation matrix.
    // For a pure rotation about world +X by 30°, world +Y maps to
    // (0, cos30°, sin30°).
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(up.z).toBeCloseTo(Math.sin(Math.PI / 6), 6);
  });

  it('preserves unit length under any rotation', () => {
    // Random-ish quaternion built from yaw + pitch + roll.
    const e = new THREE.Euler(0.7, -1.1, 0.3, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(e);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(up.length()).toBeCloseTo(1, 6);
  });

  it('is the identity when the quaternion is the identity', () => {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion());
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeCloseTo(1, 6);
    expect(up.z).toBeCloseTo(0, 6);
  });

  it('matches what camera.matrixWorld would extract as its up basis', () => {
    // The full pipeline equivalent: build a camera with the same
    // quaternion, update its world matrix, and pull the +Y basis from
    // matrix.elements[4..6]. Values must match the algebra above.
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(5, -2, 3);
    const e = new THREE.Euler(0.4, 0.9, -0.2, 'XYZ');
    cam.quaternion.setFromEuler(e);
    cam.updateMatrixWorld(true);

    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const m = cam.matrixWorld.elements;
    // +Y basis in column 1 (elements 4, 5, 6).
    expect(up.x).toBeCloseTo(m[4], 6);
    expect(up.y).toBeCloseTo(m[5], 6);
    expect(up.z).toBeCloseTo(m[6], 6);
  });
});
