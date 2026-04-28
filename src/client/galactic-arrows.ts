import * as THREE from 'three';
import { GALACTIC_CENTRE_PC } from './galactic-coords';
import { fmtDist } from './distance-util';
import {
  buildArrowSvgPath,
  ARROW_HEAD_DEPTH_PX,
  ARROW_LABEL_OFFSET_PX,
  ARROW_LABEL_PADDING_PX,
} from './arrow-path';

// Nominal apparent length of each arrow on screen, in CSS pixels. The shaft
// is built directly in screen space so this length is exact regardless of
// how the arrow's 3D direction projects. The actual length is capped per
// frame so the tip never crowds the projected target — see `updateOne`.
const ARROW_PIXEL_LENGTH = 110;
// Pixel offset between the focus point and the arrow shaft's near end —
// matches the distance-vector start offset (and the focus ring radius) so
// all three reference arrows clear the focus ring identically.
const SHAFT_START_OFFSET_PX = 28;
// Minimum shaft length below which the shrunken arrow reads as a stub. We
// hide instead of drawing it. 8 px keeps the chevron + a sliver of shaft
// visible when on the edge.
const MIN_SHAFT_PIXEL_LENGTH = 8;

/**
 * Two locator arrows pointing from the focused star (or `controls.target`
 * when unfocused) toward Sol and the galactic centre. Rendered as SVG paths
 * inside the existing `#overlay` so they share the distance-vector's stroke
 * styling, dark backing halo, and `body.warping` hide rule.
 *
 * Geometry is computed entirely in screen space:
 *   1. Project the origin (focused-star or controls.target) to pixels.
 *   2. Project an auxiliary point a small step along the 3D direction toward
 *      Sol or GC, to derive the screen-space arrow direction.
 *   3. Build shaftStart and tip in pixels by stepping along that 2D
 *      direction. The shared `buildArrowSvgPath` helper draws the chevron
 *      perpendicular to the projected shaft, so the wings always face the
 *      camera by construction.
 *
 * Critical: the shaft offset (28 px) is applied in screen space, not 3D
 * world space, so the gap between the focus point and the shaft start is
 * always exactly 28 px regardless of how aligned the arrow's direction is
 * with the camera view axis. This is what makes Sol/GC arrows clear the
 * focus ring at every viewing angle, the same way the distance vector does.
 *
 * The Sol arrow is hidden when the focused star *is* Sol — pointing at
 * yourself adds nothing. Either arrow is also hidden when its direction is
 * too close to the camera view axis to define a meaningful 2D direction.
 */
export class GalacticArrows {
  private solPath: SVGPathElement;
  private solBg: SVGPathElement;
  private gcPath: SVGPathElement;
  private gcBg: SVGPathElement;
  private solLabel: SVGTextElement;
  private gcLabel: SVGTextElement;

  // Reusable scratch vectors so per-frame updates allocate nothing.
  private tmpDir = new THREE.Vector3();
  private tmpOrigin = new THREE.Vector3();
  private tmpAux = new THREE.Vector3();
  private tmpSolLocal = new THREE.Vector3();
  private tmpGcLocal = new THREE.Vector3();

  constructor(
    solPath: SVGPathElement,
    solBg: SVGPathElement,
    gcPath: SVGPathElement,
    gcBg: SVGPathElement,
    solLabel: SVGTextElement,
    gcLabel: SVGTextElement,
  ) {
    this.solPath = solPath;
    this.solBg = solBg;
    this.gcPath = gcPath;
    this.gcBg = gcBg;
    this.solLabel = solLabel;
    this.gcLabel = gcLabel;
    this.hideAll();
  }

  /**
   * Per-frame update.
   *
   * @param camera         live perspective camera (matrices must be current)
   * @param target         orbit target in local frame (`starfield.controls.target`)
   * @param worldOffset    floating-origin offset
   * @param focusedLocal   focused star's local-frame position, or null when unfocused
   * @param hideSolArrow   true when the focused star is Sol
   * @param enabled        the user-facing `showGalacticOverlays` toggle
   * @param sizeMaxPx      current max-app-size from the Camera panel; the
   *                       arrow tip stays this far away from the projected
   *                       target (≈ disc radius, since sizeMaxPx is a
   *                       diameter) so it doesn't crowd the star's disc.
   */
  update(
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3,
    worldOffset: THREE.Vector3,
    focusedLocal: THREE.Vector3 | null,
    hideSolArrow: boolean,
    enabled: boolean,
    sizeMaxPx: number,
  ) {
    if (!enabled) {
      this.hideAll();
      return;
    }

    const origin = this.tmpOrigin.copy(focusedLocal ?? target);
    const w = window.innerWidth;
    const h = window.innerHeight;

    const originScreen = projectToScreen(origin, camera, w, h);
    if (!originScreen) {
      this.hideAll();
      return;
    }

    // World-space step for the auxiliary projection used to derive a
    // screen-space direction. Sized as the world equivalent of
    // ARROW_PIXEL_LENGTH at the focal depth — long enough for clean
    // projection error, short enough to stay in front of the camera even
    // when `dir` points toward the camera (worst case: aux depth =
    // distToOrigin × ~0.72, well clear of the near plane).
    const distToOrigin = camera.position.distanceTo(origin);
    const focalPx = window.innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const auxStepW = (ARROW_PIXEL_LENGTH * distToOrigin) / Math.max(focalPx, 1);

    const targetMarginPx = Math.max(sizeMaxPx, 0);

    // Sol's local-frame position is just `-worldOffset` (Sol is the catalog
    // origin). Compute it once into a scratch vector so the per-arrow call
    // can project it for shaft-shortening.
    this.tmpSolLocal.set(-worldOffset.x, -worldOffset.y, -worldOffset.z);
    const solDist = this.tmpSolLocal.distanceTo(origin);

    this.updateOne(
      this.solPath,
      this.solBg,
      this.solLabel,
      origin,
      originScreen,
      this.tmpDir.copy(this.tmpSolLocal).sub(origin),
      solDist,
      this.tmpSolLocal,
      auxStepW,
      camera,
      w,
      h,
      hideSolArrow,
      targetMarginPx,
      'Sol',
    );

    this.tmpGcLocal.set(
      GALACTIC_CENTRE_PC.x - worldOffset.x,
      GALACTIC_CENTRE_PC.y - worldOffset.y,
      GALACTIC_CENTRE_PC.z - worldOffset.z,
    );
    const gcDist = this.tmpGcLocal.distanceTo(origin);

    this.updateOne(
      this.gcPath,
      this.gcBg,
      this.gcLabel,
      origin,
      originScreen,
      this.tmpDir.copy(this.tmpGcLocal).sub(origin),
      gcDist,
      this.tmpGcLocal,
      auxStepW,
      camera,
      w,
      h,
      false,
      targetMarginPx,
      'Galactic centre',
    );
  }

  private updateOne(
    path: SVGPathElement,
    bg: SVGPathElement,
    label: SVGTextElement,
    origin: THREE.Vector3,
    originScreen: [number, number],
    dir: THREE.Vector3,
    distancePc: number,
    targetLocal: THREE.Vector3,
    auxStepW: number,
    camera: THREE.PerspectiveCamera,
    w: number,
    h: number,
    hide: boolean,
    targetMarginPx: number,
    labelPrefix: string,
  ) {
    const dirLenSq = dir.lengthSq();
    if (hide || dirLenSq < 1e-12) {
      this.hideArrow(path, bg, label);
      return;
    }
    dir.multiplyScalar(1 / Math.sqrt(dirLenSq));

    // Project an aux point along the 3D direction. The screen-space delta
    // from the origin gives us the 2D arrow direction.
    this.tmpAux.copy(origin).addScaledVector(dir, auxStepW);
    const auxScreen = projectToScreen(this.tmpAux, camera, w, h);
    if (!auxScreen) {
      this.hideArrow(path, bg, label);
      return;
    }
    const sdx = auxScreen[0] - originScreen[0];
    const sdy = auxScreen[1] - originScreen[1];
    const slen = Math.hypot(sdx, sdy);
    if (slen < 1) {
      // The 3D direction is too aligned with the camera view axis to
      // produce a useful 2D direction. Hide rather than draw a degenerate
      // arrow.
      this.hideArrow(path, bg, label);
      return;
    }
    const sux = sdx / slen;
    const suy = sdy / slen;

    // Shaft endpoints + chevron tip, all in screen pixels. Default length
    // is ARROW_PIXEL_LENGTH; shrunk so the tip stays `targetMarginPx` short
    // of the projected target when the target falls inside the nominal
    // shaft. We project the target separately because the auxiliary point
    // above lies along `dir` only up to a small step — at that step it
    // gives us screen direction reliably even when the target sits behind
    // the camera, which we still want to support (the arrow then keeps
    // its full length pointing in the projected direction).
    const targetScreen = projectToScreen(targetLocal, camera, w, h);
    let shaftLengthPx = ARROW_PIXEL_LENGTH;
    if (targetScreen) {
      const tdx = targetScreen[0] - originScreen[0];
      const tdy = targetScreen[1] - originScreen[1];
      // Project the target offset onto the screen-space arrow direction
      // (sux, suy). Negative or near-zero values mean the target is
      // "behind" the arrow on screen — leave the full nominal length.
      const projAlong = tdx * sux + tdy * suy;
      if (projAlong > 0) {
        const allowed = projAlong - SHAFT_START_OFFSET_PX - targetMarginPx;
        if (allowed < shaftLengthPx) shaftLengthPx = allowed;
      }
    }
    if (shaftLengthPx < MIN_SHAFT_PIXEL_LENGTH) {
      this.hideArrow(path, bg, label);
      return;
    }

    const shaftStartX = originScreen[0] + sux * SHAFT_START_OFFSET_PX;
    const shaftStartY = originScreen[1] + suy * SHAFT_START_OFFSET_PX;
    const tipX = shaftStartX + sux * shaftLengthPx;
    const tipY = shaftStartY + suy * shaftLengthPx;

    const d = buildArrowSvgPath(shaftStartX, shaftStartY, tipX, tipY);
    if (!d) {
      this.hideArrow(path, bg, label);
      return;
    }
    path.setAttribute('d', d);
    bg.setAttribute('d', d);

    const labelAnchorX = tipX + ARROW_LABEL_OFFSET_PX + ARROW_HEAD_DEPTH_PX;
    const labelAnchorY = tipY - ARROW_LABEL_OFFSET_PX;
    const sx = clamp(labelAnchorX, ARROW_LABEL_PADDING_PX, w - ARROW_LABEL_PADDING_PX);
    const sy = clamp(labelAnchorY, ARROW_LABEL_PADDING_PX, h - ARROW_LABEL_PADDING_PX);
    label.style.display = '';
    label.setAttribute('x', sx.toFixed(1));
    label.setAttribute('y', sy.toFixed(1));
    label.textContent = `${labelPrefix} · ${fmtDist(distancePc)}`;
  }

  /** Mono-mode swap is handled by CSS rules on `.gal-arrow` /
   *  `.gal-arrow-bg`, so this method is intentionally empty — the SVG
   *  classes route to the right palette via `body.monochrome`. Kept on the
   *  interface for symmetry with the disc/grid layers. */
  setMonochrome(_on: boolean) { /* CSS-only */ }

  /** Top-level visibility for warp-hide / disabled-toggle. */
  setVisible(on: boolean) {
    if (!on) this.hideAll();
  }

  private hideAll() {
    this.hideArrow(this.solPath, this.solBg, this.solLabel);
    this.hideArrow(this.gcPath, this.gcBg, this.gcLabel);
  }

  private hideArrow(path: SVGPathElement, bg: SVGPathElement, label: SVGTextElement) {
    path.setAttribute('d', '');
    bg.setAttribute('d', '');
    label.style.display = 'none';
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function projectToScreen(
  p: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): [number, number] | null {
  const v = p.clone().applyMatrix4(camera.matrixWorldInverse);
  if (v.z >= -camera.near) return null;
  const ndc = v.applyMatrix4(camera.projectionMatrix);
  return [(ndc.x + 1) * 0.5 * w, (1 - ndc.y) * 0.5 * h];
}
