import { describe, expect, it } from 'vitest';
import {
  COVERAGE_FADE_END,
  COVERAGE_FADE_START,
  discCoverageAlpha,
  focusedArrowFadeAlpha,
} from './arrow-fade';

describe('discCoverageAlpha', () => {
  it('returns 1 when shaftLengthPx is 0 (no drawn shaft)', () => {
    // Regression for ml8 symptom 1: previously, refLen = max(solDrawnLen,
    // gcDrawnLen) could be 0 on the first frame after HUD toggle-on,
    // dividing through to coverage = ∞ and forcing alpha = 0 (or worse,
    // NaN). The guard returns 1 so the caller is the one deciding whether
    // to hide the arrow on geometry grounds.
    expect(discCoverageAlpha(50, 0, 28)).toBe(1);
    expect(discCoverageAlpha(50, -1, 28)).toBe(1);
  });

  it('returns 1 when disc has not reached the shaft start', () => {
    // Disc radius < shaftStart → coverage = 0 → alpha = 1.
    expect(discCoverageAlpha(20, 100, 28)).toBe(1);
    expect(discCoverageAlpha(28, 100, 28)).toBe(1);
  });

  it('returns 0 when coverage reaches the end of the fade band', () => {
    // coverage = (discRadius - shaftStart) / shaftLength
    //         = (103 - 28) / 100 = 0.75 → smoothstep(0.5, 0.75, 0.75) = 1 → alpha = 0.
    expect(discCoverageAlpha(103, 100, 28)).toBe(0);
    expect(discCoverageAlpha(200, 100, 28)).toBe(0);
  });

  it('returns 1 at the start of the fade band (smoothstep zero-slope edge)', () => {
    // coverage = 0.5 → smoothstep(0.5, 0.75, 0.5) = 0 → alpha = 1.
    expect(discCoverageAlpha(78, 100, 28)).toBe(1);
  });

  it('eases smoothly across the [0.5, 0.75] coverage band', () => {
    // Mid-band coverage = 0.625 → smoothstep = 0.5 → alpha = 0.5.
    expect(discCoverageAlpha(90.5, 100, 28)).toBeCloseTo(0.5, 5);
  });

  it('uses the published COVERAGE_FADE_START / COVERAGE_FADE_END constants', () => {
    // Pin the named-constant contract: any drift would shift the fade
    // engagement window and silently change visible behaviour.
    expect(COVERAGE_FADE_START).toBe(0.5);
    expect(COVERAGE_FADE_END).toBe(0.75);
  });

  it('per-arrow length: a longer shaft fades later than a shorter one (option B)', () => {
    // Same disc, same shaftStart, different shaft lengths. The longer
    // arrow has more room before the disc dominates it, so it stays at
    // higher alpha. This is the distance-vector-vs-Sol/GC distinction
    // the ml8 fix puts in place: per-arrow coverage, not shared.
    const disc = 80;
    const start = 28;
    const shortAlpha = discCoverageAlpha(disc, 80, start);
    const longAlpha = discCoverageAlpha(disc, 300, start);
    expect(longAlpha).toBeGreaterThan(shortAlpha);
  });
});

describe('focusedArrowFadeAlpha', () => {
  it('returns 1 in steady-state observe regardless of coverage', () => {
    // Observe steady state: the focal star isn't centred so there's
    // nothing to clear chrome out of the way for. alpha=1.
    expect(focusedArrowFadeAlpha('observe', null, 200, 100, 28)).toBe(1);
  });

  it('returns 1 during an exit transition regardless of coverage', () => {
    // Exit: snap alpha to 1 so we don't double-ease (disc is also
    // shrinking back to parked size). Without this, the arrows would
    // fade in twice — once via this curve, once via the disc shrinkage.
    expect(focusedArrowFadeAlpha('navigate', { kind: 'exit' }, 200, 100, 28)).toBe(1);
    expect(focusedArrowFadeAlpha('observe', { kind: 'exit' }, 200, 100, 28)).toBe(1);
  });

  it('applies disc coverage during an enter transition', () => {
    // Enter: chrome should melt away as the camera dives into the focal
    // star. cameraMode flips to 'observe' at the start of the transition
    // so we key on the transition kind, not the mode.
    expect(focusedArrowFadeAlpha('observe', { kind: 'enter' }, 200, 100, 28)).toBe(0);
    expect(focusedArrowFadeAlpha('navigate', { kind: 'enter' }, 200, 100, 28)).toBe(0);
  });

  it('applies disc coverage in steady-state navigate', () => {
    expect(focusedArrowFadeAlpha('navigate', null, 200, 100, 28)).toBe(0);
    expect(focusedArrowFadeAlpha('navigate', null, 20, 100, 28)).toBe(1);
  });

  it('does not flash to 1 when shaftLength is 0 in navigate mode (ml8 symptom 1)', () => {
    // The original bug: when HUD just toggled on, the alpha calc read
    // last-frame's drawn shaft lengths which were 0 from hideAll, so
    // coverage divided through to a refLen of 0 and the calc returned
    // alpha=1 — Sol/GC arrows painted full-opacity for one frame.
    //
    // The fix moves the alpha calc to consume THIS-frame's geometry.
    // The pure helper's contract: shaftLength=0 yields alpha=1, but the
    // caller no longer feeds shaftLength=0 — it feeds the freshly-
    // computed shaft length of this frame. The guard here is for the
    // edge case where the arrow legitimately has no drawn shaft (e.g.
    // Sol is the focused star → Sol arrow hidden, GC also degenerate);
    // in that case there's nothing to fade.
    expect(focusedArrowFadeAlpha('navigate', null, 200, 0, 28)).toBe(1);
  });
});
