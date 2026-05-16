import * as THREE from 'three';

// Shared world-to-screen projection helper for SVG overlays. Returns null
// when the input projects at or behind the camera; otherwise returns
// pixel coordinates in CSS-pixel space (same convention every overlay
// uses: x increases right, y increases down).
//
// CAMERA NEAR NOTE: We read camera.near as the "behind/at camera" clip
// threshold. After PR #7 enabled logarithmicDepthBuffer, camera.near is
// 1e-10 pc — orders of magnitude below any orbit-floor regime, so the
// threshold acts as plain "view-z >= 0" (= "at or behind the camera").
// The numeric coupling to the log-depth precision floor is intentional:
// one symbol used at one site is easier to reason about than two
// near-identical constants. If the orbit floor ever drops to within
// striking distance of camera.near we'll need to decouple — until then,
// the single read is the simplest correct thing. (Tracked in the
// retired stellata-9mm.46 analysis.)
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
