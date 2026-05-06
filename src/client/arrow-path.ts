import * as THREE from 'three';

// Shared arrow shape used by the distance-vector overlay and the Sol/GC
// locator arrows. Both render in screen space as solid shaft + chevron
// arrowhead so all on-screen arrows in the app share one silhouette.
//
// Arrowhead size matches the original distance-vector chevron — the user
// settled on this proportion as visually appealing.
export const ARROW_HEAD_DEPTH_PX = 5;
export const ARROW_HEAD_HALF_WIDTH_PX = 4;

/**
 * Screen-space unit direction from screen centre to a world-space
 * direction vector, robust to behind-camera targets. Used by the HUD's
 * Sol/GC arrows and the POI arrows as the fallback when target
 * projection fails.
 *
 * Perspective-projection-based derivations (project the target and take
 * the screen delta from origin) collapse when the target is behind the
 * camera: the projection chain divides by z and sign-flips. View-space
 * arithmetic sidesteps that — the camera-local (x, y) of a direction is
 * the screen-plane offset regardless of front or behind, so a target the
 * user must turn 180° to see still yields a useful arrow direction.
 *
 * Browser screen y is inverted vs. view-space y (down-positive vs.
 * up-positive), hence the y flip.
 *
 * Returns null only when the direction is exactly along the camera axis
 * (view-space x and y both ≈ 0) — no rotation brings such a target into
 * view in any preferred direction.
 */
// Module-scope scratch vector for viewSpaceScreenDir. Owning it inside the
// helper keeps arrow-path symmetric with focus-ring-overlay / disc-mask /
// distance-vector-overlay (all of which hide their per-frame scratch
// state) and frees call sites from threading a Vector3 through.
const scratchVS = /*@__PURE__*/ new THREE.Vector3();

export function viewSpaceScreenDir(
  worldDir: THREE.Vector3,
  camera: THREE.Camera,
): [number, number] | null {
  scratchVS.copy(worldDir).transformDirection(camera.matrixWorldInverse);
  const sx = scratchVS.x;
  const sy = -scratchVS.y;
  const len = Math.hypot(sx, sy);
  if (len < 1e-6) return null;
  return [sx / len, sy / len];
}

// Label placement constants — shared so the distance vector and Sol/GC
// arrows position their labels identically next to the chevron tip.
export const ARROW_LABEL_OFFSET_PX = 12;
export const ARROW_LABEL_PADDING_PX = 50;

/**
 * Build an SVG path for a single arrow given the shaft's start and the
 * arrowhead tip in screen-space pixels. Returns an empty string only when
 * the segment has zero length.
 *
 * The chevron arrowhead is constructed in 2D (perpendicular to the
 * projected shaft), so the wings always face the camera regardless of the
 * shaft's 3D orientation. `chevronScale` (default 1) scales the chevron's
 * depth and half-width together — used by the navigate-mode HUD arrows so
 * a short shaft gets a proportionally-small chevron rather than a stuck
 * full-size head dominating a tiny stub.
 */
export function buildArrowSvgPath(
  shaftStartX: number,
  shaftStartY: number,
  tipX: number,
  tipY: number,
  chevronScale = 1,
): string {
  const dx = tipX - shaftStartX;
  const dy = tipY - shaftStartY;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return '';

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  const headDepth = ARROW_HEAD_DEPTH_PX * chevronScale;
  const headHalfWidth = ARROW_HEAD_HALF_WIDTH_PX * chevronScale;
  const backCx = tipX - ux * headDepth;
  const backCy = tipY - uy * headDepth;
  const wlX = backCx + px * headHalfWidth;
  const wlY = backCy + py * headHalfWidth;
  const wrX = backCx - px * headHalfWidth;
  const wrY = backCy - py * headHalfWidth;

  // Shaft + two wings. `M` jumps split the wings into separate sub-paths so
  // they meet only at the tip rather than tracing through it as a
  // continuous polyline.
  return (
    `M ${shaftStartX.toFixed(1)} ${shaftStartY.toFixed(1)} ` +
    `L ${tipX.toFixed(1)} ${tipY.toFixed(1)} ` +
    `M ${wlX.toFixed(1)} ${wlY.toFixed(1)} ` +
    `L ${tipX.toFixed(1)} ${tipY.toFixed(1)} ` +
    `M ${wrX.toFixed(1)} ${wrY.toFixed(1)} ` +
    `L ${tipX.toFixed(1)} ${tipY.toFixed(1)}`
  );
}
