import * as THREE from 'three';

// World-to-screen projection for SVG overlays. Returns null when the
// input projects at or behind the camera (camera.near = 1e-10 pc
// under logarithmicDepthBuffer, so the threshold acts as plain
// "view-z >= 0"). Pixel coordinates are CSS-pixel space (x right, y
// down) — every overlay uses this convention.
const scratch = /*@__PURE__*/ new THREE.Vector3();

export function projectToScreen(
  p: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): [number, number] | null {
  scratch.copy(p).applyMatrix4(camera.matrixWorldInverse);
  if (scratch.z >= -camera.near) return null;
  scratch.applyMatrix4(camera.projectionMatrix);
  return [(scratch.x + 1) * 0.5 * w, (1 - scratch.y) * 0.5 * h];
}
