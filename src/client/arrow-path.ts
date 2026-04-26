// Shared arrow shape used by the distance-vector overlay and the Sol/GC
// locator arrows. Both render in screen space as solid shaft + chevron
// arrowhead so all on-screen arrows in the app share one silhouette.
//
// Arrowhead size matches the original distance-vector chevron — the user
// settled on this proportion as visually appealing.
export const ARROW_HEAD_DEPTH_PX = 5;
export const ARROW_HEAD_HALF_WIDTH_PX = 4;

// Label placement constants — shared so the distance vector and Sol/GC
// arrows position their labels identically next to the chevron tip.
export const ARROW_LABEL_OFFSET_PX = 12;
export const ARROW_LABEL_PADDING_PX = 50;

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
