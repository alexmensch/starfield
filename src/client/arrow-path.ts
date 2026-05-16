import * as THREE from 'three';

// Shared arrow shape used by the distance-vector overlay and the Sol/GC
// locator arrows. Both render in screen space as solid shaft + chevron
// arrowhead so all on-screen arrows in the app share one silhouette.
//
// Arrowhead size matches the original distance-vector chevron — the user
// settled on this proportion as visually appealing.
export const ARROW_HEAD_DEPTH_PX = 5;
export const ARROW_HEAD_HALF_WIDTH_PX = 4;

// Nominal apparent length of each Sol/GC and POI locator arrow on screen,
// in CSS pixels. Shafts are built directly in screen space so this length
// is exact regardless of how the arrow's 3D direction projects. Both the
// HUD (hud-overlay) and the POI overlay (poi-overlay) shrink the shaft
// per-frame so the tip never crowds the projected target's disc.
export const ARROW_PIXEL_LENGTH = 110;

// Halo gap between the active ring rim (focus-ring in navigate, HUD ring
// in observe, per-POI ring on POIs) and any arrow shaft that attaches to
// it. Same gap everywhere so the arrows visually detach from their ring
// identically in every layer.
export const RING_HALO_GAP_PX = 4;

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
 * Screen-space unit direction for an arrow originating at (cx, cy) and
 * pointing toward a world target. Two-tier cascade:
 *
 *   1. If the target's screen projection is non-null and is more than a
 *      pixel away from (cx, cy), use the screen-space delta directly —
 *      the natural direction.
 *   2. Otherwise (target behind the camera, or projects on top of the
 *      origin) fall back to viewSpaceScreenDir on the world direction.
 *      That one is robust to behind-camera targets because view-space xy
 *      sidesteps the projection's z-divide.
 *
 * Returns null only when both paths fail — `worldDir` along the camera
 * axis with the target either coincident with the origin or producing no
 * screen offset. No screen direction can be defined in that case and the
 * caller hides the arrow.
 */
export function screenDirToTarget(
  cx: number,
  cy: number,
  targetScreen: [number, number] | null,
  worldDir: THREE.Vector3,
  camera: THREE.Camera,
): [number, number] | null {
  if (targetScreen) {
    const tdx = targetScreen[0] - cx;
    const tdy = targetScreen[1] - cy;
    const tlen = Math.hypot(tdx, tdy);
    if (tlen >= 1) return [tdx / tlen, tdy / tlen];
  }
  return viewSpaceScreenDir(worldDir, camera);
}

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
