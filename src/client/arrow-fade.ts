import { smoothstep } from './galactic-fade';

// Disc-coverage thresholds for the focused-star reference-arrow fade.
// Below COVERAGE_FADE_START the arrow is fully visible; above
// COVERAGE_FADE_END it's fully hidden. The 0.5→0.75 band engages the
// fade well before the disc would touch the chevron tip and finishes
// before the tip is clearly behind the disc.
export const COVERAGE_FADE_START = 0.5;
export const COVERAGE_FADE_END = 0.75;

/**
 * Opacity for a screen-space reference arrow as the focused star's disc
 * grows past its shaft start. Returns 1 when the disc hasn't reached the
 * shaft start, 0 once the disc covers ≥ 75 % of the shaft length.
 *
 * The Sol/GC chevrons share one alpha keyed on max(solLen, gcLen) so the
 * pair fades together. The distance-vector arrow computes its own alpha
 * against its own drawn length so a long pointer-to-destination chevron
 * outlasts the short Sol/GC chevrons by design — its disc has to grow
 * proportionally larger before the distance-vector fades. (Option B from
 * the ml8 bead.)
 *
 * - shaftLengthPx ≤ 0 → returns 1. No drawn shaft to fade; the consumer
 *   will hide the arrow on geometry grounds. Guards against a zero-length
 *   state producing coverage = ∞ and wrongly driving alpha to 0.
 * - discRadiusPx ≤ shaftStartPx → returns 1. Disc hasn't reached the
 *   shaft start yet.
 */
export function discCoverageAlpha(
  discRadiusPx: number,
  shaftLengthPx: number,
  shaftStartPx: number,
): number {
  if (shaftLengthPx <= 0) return 1;
  const coverage = Math.max(0, discRadiusPx - shaftStartPx) / shaftLengthPx;
  return 1 - smoothstep(COVERAGE_FADE_START, COVERAGE_FADE_END, coverage);
}

/**
 * Full alpha for a focused-star reference arrow under the current camera
 * mode + transition state. Combines the camera-state gate with the disc-
 * coverage smoothstep so both consumers (HUD Sol/GC arrows, distance-
 * vector overlay) make the same decision from the same inputs within a
 * frame.
 *
 * Gate semantics:
 * - During an observe transition: only the 'enter' kind fades — the
 *   chrome melts away as the camera dives into the focal star. The 'exit'
 *   kind snaps to 1 to avoid double-easing while the disc is shrinking
 *   back to its parked size.
 * - Steady-state observe: alpha = 1 (the focal star isn't centered in
 *   view, no disc-coverage problem to solve).
 * - Steady-state navigate: fade engages.
 */
export function focusedArrowFadeAlpha(
  cameraMode: 'navigate' | 'observe',
  transition: { kind: 'enter' | 'exit' } | null,
  discRadiusPx: number,
  shaftLengthPx: number,
  shaftStartPx: number,
): number {
  if (transition) {
    if (transition.kind !== 'enter') return 1;
  } else if (cameraMode !== 'navigate') {
    return 1;
  }
  return discCoverageAlpha(discRadiusPx, shaftLengthPx, shaftStartPx);
}
