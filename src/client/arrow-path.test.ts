import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { viewSpaceScreenDir } from './arrow-path';

// Camera looking down -Z at the world origin, the canonical Stellata setup.
function makeCamera(opts: { yawRad?: number; pitchRad?: number } = {}) {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  if (opts.yawRad) cam.rotateY(opts.yawRad);
  if (opts.pitchRad) cam.rotateX(opts.pitchRad);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  return cam;
}

describe('arrow-path / viewSpaceScreenDir', () => {

  it('points right for an in-front target to the camera right', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(1, 0, -10).normalize();
    const out = viewSpaceScreenDir(dir, cam)!;
    expect(out).not.toBeNull();
    // Positive sux (right), zero suy.
    expect(out[0]).toBeGreaterThan(0.99);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
  });

  it('points up (negative suy, browser y is inverted) for an in-front target above camera', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(0, 1, -10).normalize();
    const out = viewSpaceScreenDir(dir, cam)!;
    expect(Math.abs(out[0])).toBeLessThan(1e-6);
    expect(out[1]).toBeLessThan(-0.99); // up = negative screen y
  });

  it('points right when target is BEHIND camera and to the right', () => {
    // Target behind camera (positive z in world) and to the right.
    // The user must yaw right to bring it into view → arrow should
    // still point right. This is the case the bug fix targets.
    const cam = makeCamera();
    const dir = new THREE.Vector3(1, 0, 10).normalize();
    const out = viewSpaceScreenDir(dir, cam)!;
    expect(out).not.toBeNull();
    expect(out[0]).toBeGreaterThan(0);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
  });

  it('points up when target is behind camera and above', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(0, 1, 10).normalize();
    const out = viewSpaceScreenDir(dir, cam)!;
    expect(out).not.toBeNull();
    expect(Math.abs(out[0])).toBeLessThan(1e-6);
    expect(out[1]).toBeLessThan(0);
  });

  it('returns null for a target directly in front (along camera axis)', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(0, 0, -1);
    expect(viewSpaceScreenDir(dir, cam)).toBeNull();
  });

  it('returns null for a target directly behind (along camera axis)', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    expect(viewSpaceScreenDir(dir, cam)).toBeNull();
  });

  it('returns a unit vector', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(3, 4, -5).normalize();
    const out = viewSpaceScreenDir(dir, cam)!;
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 5);
  });

  it('respects camera rotation: a yawed camera flips left/right', () => {
    // Camera yawed 180° (looking down +Z). A target at world +X is now
    // behind-and-to-the-LEFT in the camera's frame. The user must turn
    // left in the camera's local frame → screen direction left.
    const cam = makeCamera({ yawRad: Math.PI });
    const dir = new THREE.Vector3(1, 0, 0);
    const out = viewSpaceScreenDir(dir, cam)!;
    expect(out[0]).toBeLessThan(0);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
  });
});

