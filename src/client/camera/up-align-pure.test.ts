import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { alignCameraUpToQuaternion } from './up-align-pure';

// Helper-level companion to `camera-up-align.test.ts`. The neighbouring
// fixture pins the underlying quaternion algebra; this one pins the
// extracted function's contract — `alignCameraUpToQuaternion(camera)`
// mutates `camera.up` in place to the camera's current local +Y, leaving
// position and quaternion untouched.
describe('alignCameraUpToQuaternion', () => {
  it('writes the camera-local +Y basis into camera.up', () => {
    const cam = new THREE.PerspectiveCamera();
    cam.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 6);
    cam.up.set(0, 1, 0);

    alignCameraUpToQuaternion(cam);

    expect(cam.up.x).toBeCloseTo(0, 6);
    expect(cam.up.y).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(cam.up.z).toBeCloseTo(Math.sin(Math.PI / 6), 6);
  });

  it('is the identity when the camera quaternion is identity', () => {
    const cam = new THREE.PerspectiveCamera();
    cam.up.set(0, 1, 0);
    alignCameraUpToQuaternion(cam);
    expect(cam.up.x).toBeCloseTo(0, 6);
    expect(cam.up.y).toBeCloseTo(1, 6);
    expect(cam.up.z).toBeCloseTo(0, 6);
  });

  it('preserves unit length under any rotation', () => {
    const cam = new THREE.PerspectiveCamera();
    cam.quaternion.setFromEuler(new THREE.Euler(0.7, -1.1, 0.3, 'XYZ'));
    alignCameraUpToQuaternion(cam);
    expect(cam.up.length()).toBeCloseTo(1, 6);
  });

  it('does not touch camera.position or camera.quaternion', () => {
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(5, -2, 3);
    cam.quaternion.setFromEuler(new THREE.Euler(0.4, 0.9, -0.2, 'XYZ'));
    const posBefore = cam.position.clone();
    const quatBefore = cam.quaternion.clone();

    alignCameraUpToQuaternion(cam);

    expect(cam.position.x).toBe(posBefore.x);
    expect(cam.position.y).toBe(posBefore.y);
    expect(cam.position.z).toBe(posBefore.z);
    expect(cam.quaternion.x).toBe(quatBefore.x);
    expect(cam.quaternion.y).toBe(quatBefore.y);
    expect(cam.quaternion.z).toBe(quatBefore.z);
    expect(cam.quaternion.w).toBe(quatBefore.w);
  });
});
