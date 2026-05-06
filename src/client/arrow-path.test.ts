import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { viewSpaceScreenDir, screenDirFromCascade } from './arrow-path';

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
  const scratch = new THREE.Vector3();

  it('points right for an in-front target to the camera right', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(1, 0, -10).normalize();
    const out = viewSpaceScreenDir(dir, cam, scratch)!;
    expect(out).not.toBeNull();
    // Positive sux (right), zero suy.
    expect(out[0]).toBeGreaterThan(0.99);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
  });

  it('points up (negative suy, browser y is inverted) for an in-front target above camera', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(0, 1, -10).normalize();
    const out = viewSpaceScreenDir(dir, cam, scratch)!;
    expect(Math.abs(out[0])).toBeLessThan(1e-6);
    expect(out[1]).toBeLessThan(-0.99); // up = negative screen y
  });

  it('points right when target is BEHIND camera and to the right', () => {
    // Target behind camera (positive z in world) and to the right.
    // The user must yaw right to bring it into view → arrow should
    // still point right. This is the case the bug fix targets.
    const cam = makeCamera();
    const dir = new THREE.Vector3(1, 0, 10).normalize();
    const out = viewSpaceScreenDir(dir, cam, scratch)!;
    expect(out).not.toBeNull();
    expect(out[0]).toBeGreaterThan(0);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
  });

  it('points up when target is behind camera and above', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(0, 1, 10).normalize();
    const out = viewSpaceScreenDir(dir, cam, scratch)!;
    expect(out).not.toBeNull();
    expect(Math.abs(out[0])).toBeLessThan(1e-6);
    expect(out[1]).toBeLessThan(0);
  });

  it('returns null for a target directly in front (along camera axis)', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(0, 0, -1);
    expect(viewSpaceScreenDir(dir, cam, scratch)).toBeNull();
  });

  it('returns null for a target directly behind (along camera axis)', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    expect(viewSpaceScreenDir(dir, cam, scratch)).toBeNull();
  });

  it('returns a unit vector', () => {
    const cam = makeCamera();
    const dir = new THREE.Vector3(3, 4, -5).normalize();
    const out = viewSpaceScreenDir(dir, cam, scratch)!;
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 5);
  });

  it('respects camera rotation: a yawed camera flips left/right', () => {
    // Camera yawed 180° (looking down +Z). A target at world +X is now
    // behind-and-to-the-LEFT in the camera's frame. The user must turn
    // left in the camera's local frame → screen direction left.
    const cam = makeCamera({ yawRad: Math.PI });
    const dir = new THREE.Vector3(1, 0, 0);
    const out = viewSpaceScreenDir(dir, cam, scratch)!;
    expect(out[0]).toBeLessThan(0);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
  });
});

describe('arrow-path / screenDirFromCascade (3-tier ordering)', () => {
  const scratch = new THREE.Vector3();
  const W = 800;
  const H = 600;
  const cx = W * 0.5;
  const cy = H * 0.5;

  function projectIfPossible(p: THREE.Vector3, cam: THREE.PerspectiveCamera): [number, number] | null {
    const v = p.clone().applyMatrix4(cam.matrixWorldInverse);
    if (v.z >= -1e-3) return null;
    const ndc = v.applyMatrix4(cam.projectionMatrix);
    return [(ndc.x + 1) * 0.5 * W, (1 - ndc.y) * 0.5 * H];
  }

  it('returns aux-step direction (tier 1) when origin is offset and target is in front', () => {
    // Camera at +5 along z, looking at origin. Origin at world (0,0,0),
    // direction toward a target at +x. Aux step lands well in front of
    // the camera → tier 1 wins.
    const cam = makeCamera();
    cam.position.set(0, 0, 5);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.updateProjectionMatrix();
    const origin = new THREE.Vector3(0, 0, 0);
    const dir = new THREE.Vector3(1, 0, 0);
    const target = new THREE.Vector3(1, 0, 0);
    const targetScreen = projectIfPossible(target, cam);
    const out = screenDirFromCascade(origin, dir, 0.5, targetScreen, cx, cy, cam, W, H, scratch)!;
    expect(out).not.toBeNull();
    expect(out[0]).toBeGreaterThan(0); // pointing right
    expect(Math.abs(out[1])).toBeLessThan(0.05);
  });

  it('falls through to tier 3 (view-space) when the target is behind the camera', () => {
    // Camera at origin looking down -Z. Target far behind (+z). Both the
    // aux-step (origin coincides with camera, projection collapses) AND
    // target-projection fail because the target is behind the near plane.
    // Only view-space recovers a direction.
    const cam = makeCamera();
    const origin = new THREE.Vector3(0, 0, 0); // == camera pos
    const dir = new THREE.Vector3(1, 0, 1).normalize(); // behind-and-right
    const targetScreen: [number, number] | null = null; // pre-projected null
    const out = screenDirFromCascade(origin, dir, 0.5, targetScreen, cx, cy, cam, W, H, scratch)!;
    expect(out).not.toBeNull();
    // View-space x should still be positive — user turns RIGHT to bring
    // the behind-right target back into view.
    expect(out[0]).toBeGreaterThan(0);
  });

  it('falls back to tier 2 (target projection) when aux-step is degenerate', () => {
    // Camera at world origin (== anchor origin) — aux-step from origin
    // along dir lands AT the camera (z=0 view-space) and projection of
    // any aux step from camera-position is degenerate. Tier 2 uses the
    // pre-projected target instead.
    const cam = makeCamera();
    const origin = new THREE.Vector3(0, 0, 0); // == camera
    const dir = new THREE.Vector3(0, 0, -1);   // forward
    // Pre-projected target offset to the right of screen centre.
    const targetScreen: [number, number] = [cx + 100, cy];
    const out = screenDirFromCascade(origin, dir, 0.001, targetScreen, cx, cy, cam, W, H, scratch)!;
    expect(out).not.toBeNull();
    // Direction toward (cx+100, cy) from (cx, cy) is +x, 0 — tier 2 wins.
    expect(out[0]).toBeGreaterThan(0.99);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
  });

  it('returns null only when all three tiers fail (direction along camera axis)', () => {
    // dir == -Z (straight ahead) with camera at world origin looking -Z.
    // Aux step lands on screen centre (slen < 1), no targetScreen, and
    // view-space (x, y) ≈ (0, 0).
    const cam = makeCamera();
    const origin = new THREE.Vector3(0, 0, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    const out = screenDirFromCascade(origin, dir, 0.001, null, cx, cy, cam, W, H, scratch);
    expect(out).toBeNull();
  });
});
