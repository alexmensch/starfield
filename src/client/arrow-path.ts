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
 * Sol/GC arrows and the POI arrows as the third-tier fallback after
 * aux-step and direct target projection both fail.
 *
 * Both perspective-projection-based derivations used elsewhere (project
 * two world points and take the screen delta, or project the target
 * directly) collapse when the target is behind the camera: the
 * projection chain divides by z and sign-flips. View-space arithmetic
 * sidesteps that — the camera-local (x, y) of a direction is the
 * screen-plane offset regardless of front or behind, so a target the
 * user must turn 180° to see still yields a useful arrow direction.
 *
 * Browser screen y is inverted vs. view-space y (down-positive vs.
 * up-positive), hence the y flip.
 *
 * Returns null only when the direction is exactly along the camera axis
 * (view-space x and y both ≈ 0) — no rotation brings such a target into
 * view in any preferred direction.
 */
// Module-scope scratch vectors. Owning them inside the helpers keeps
// arrow-path symmetric with focus-ring-overlay / disc-mask /
// distance-vector-overlay (all of which hide their per-frame scratch
// state) and frees call sites from threading a Vector3 through.
// Scratch reuse across these helpers is single-threaded — JS is
// single-threaded and no helper here calls another while still reading
// its own scratch. screenDirFromCascade and viewSpaceScreenDir use
// distinct scratches because the cascade may invoke viewSpaceScreenDir
// after writing its own scratch in tier 1.
const scratchVS = /*@__PURE__*/ new THREE.Vector3();
const scratchAux = /*@__PURE__*/ new THREE.Vector3();

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

// CPU-side near-plane clip threshold for screen-space overlay projection.
// Decoupled from camera.near because PR #7 dropped camera.near to 1e-10 pc
// to give the GPU log-depth buffer headroom — that's a precision floor,
// not a perceptual "object is in front of the camera" cutoff. Overlays use
// this constant so anything within the orbit floor (~5e-3 pc) still
// projects sensibly without each overlay re-deriving its own threshold.
export const OVERLAY_NEAR_CLIP_PC = 1e-3;

/**
 * Three-tier cascade for resolving an arrow's screen-space unit direction.
 * Used identically by the HUD and POI overlays — both face the same problem
 * (anchor → direction → 2D unit vector) with the same edge cases.
 *
 *   1. **Aux-step** (preferred when origin ≠ camera): project a tiny step
 *      along `dir` from `auxStepFrom` and take the screen-space delta from
 *      `(cx, cy)`. Gets perspective right.
 *   2. **Target-projection** (preferred when origin == camera, e.g. observe
 *      steady state): if a pre-projected target is available, use the screen
 *      vector from anchor to that point.
 *   3. **View-space** (target behind camera): both projection-based
 *      derivations divide by z and collapse when the target is behind the
 *      camera; view-space (x, y) of `dir` sidesteps the projection divide.
 *
 * Each tier returns null when its result is too short to normalise (<1 px
 * for tiers 1-2, view-space ≈ 0 for tier 3). Final null only when all three
 * tiers fail — i.e. the direction is exactly along the camera axis.
 */
export function screenDirFromCascade(
  auxStepFrom: THREE.Vector3,
  dir: THREE.Vector3,
  auxStepW: number,
  targetScreen: [number, number] | null,
  cx: number,
  cy: number,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): [number, number] | null {
  scratchAux.copy(auxStepFrom).addScaledVector(dir, auxStepW);
  const auxScreen = projectToScreen(scratchAux, camera, w, h);
  if (auxScreen) {
    const sdx = auxScreen[0] - cx;
    const sdy = auxScreen[1] - cy;
    const slen = Math.hypot(sdx, sdy);
    if (slen >= 1) return [sdx / slen, sdy / slen];
  }
  if (targetScreen) {
    const tdx = targetScreen[0] - cx;
    const tdy = targetScreen[1] - cy;
    const tlen = Math.hypot(tdx, tdy);
    if (tlen >= 1) return [tdx / tlen, tdy / tlen];
  }
  return viewSpaceScreenDir(dir, camera);
}

/**
 * Project a local-frame world-space point to CSS pixel coordinates. Returns
 * null when the point is at or behind the near plane — the projection
 * matrix is degenerate there and downstream code must fall back to a
 * direction-based arrow.
 *
 * The clone() guards the input from mutation; callers in hot paths pass
 * scratch vectors anyway, but the cost is one Vector3 alloc per call. If
 * that ever shows up in a profile, thread an out-vector arg through.
 */
export function projectToScreen(
  p: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): [number, number] | null {
  const v = p.clone().applyMatrix4(camera.matrixWorldInverse);
  if (v.z >= -OVERLAY_NEAR_CLIP_PC) return null;
  const ndc = v.applyMatrix4(camera.projectionMatrix);
  return [(ndc.x + 1) * 0.5 * w, (1 - ndc.y) * 0.5 * h];
}

/**
 * Build an SVG path for a single arrow given the shaft's start and the
 * arrowhead tip in screen-space pixels. Returns an empty string when the
 * segment is too short to draw a clean head.
 *
 * The chevron arrowhead is constructed in 2D (perpendicular to the
 * projected shaft), so the wings always face the camera regardless of the
 * shaft's 3D orientation.
 */
export function buildArrowSvgPath(
  shaftStartX: number,
  shaftStartY: number,
  tipX: number,
  tipY: number,
): string {
  const dx = tipX - shaftStartX;
  const dy = tipY - shaftStartY;
  const len = Math.hypot(dx, dy);
  if (len < ARROW_HEAD_DEPTH_PX + 2) return '';

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  const backCx = tipX - ux * ARROW_HEAD_DEPTH_PX;
  const backCy = tipY - uy * ARROW_HEAD_DEPTH_PX;
  const wlX = backCx + px * ARROW_HEAD_HALF_WIDTH_PX;
  const wlY = backCy + py * ARROW_HEAD_HALF_WIDTH_PX;
  const wrX = backCx - px * ARROW_HEAD_HALF_WIDTH_PX;
  const wrY = backCy - py * ARROW_HEAD_HALF_WIDTH_PX;

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
