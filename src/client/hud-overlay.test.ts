import { describe, expect, it, vi } from 'vitest';
import { applyFade } from './dirty-attr';
import { emptyArrowState, resetArrowSentinels, type ArrowState } from './hud-overlay';

function makeFadeEls() {
  const style = {} as Record<string, string>;
  const el = {
    style: style as unknown as CSSStyleDeclaration,
    setAttribute: vi.fn(),
  } as unknown as SVGPathElement & SVGTextElement;
  return { el, style };
}

describe('hud-overlay applyFade', () => {
  it('writes opacity to all three elements on the first call from a fresh state', () => {
    // Regression test for the original-9mm.167 / sentinel-init bug where
    // `lastOpacity: NaN` poisoned applyFade's early-write gate
    // (`Math.abs(α − NaN) = NaN; NaN >= 0.0005 = false`) and silently
    // skipped every opacity write — leaving the Sol/GC arrows pinned at
    // the CSS default opacity (no fade). emptyArrowState() must produce
    // a sentinel that fails the `>= 0.0005` comparison so the write
    // lands. -Infinity satisfies that; NaN does not.
    const path = makeFadeEls();
    const bg = makeFadeEls();
    const label = makeFadeEls();
    const state = emptyArrowState();
    applyFade([path.el, bg.el, label.el], label.el, 0.5, state);
    expect(path.style.opacity).toBe('0.500');
    expect(bg.style.opacity).toBe('0.500');
    expect(label.style.opacity).toBe('0.500');
    expect(state.lastOpacity).toBe(0.5);
  });

  it('skips opacity writes when alpha is within 0.0005 of last', () => {
    const path = makeFadeEls();
    const bg = makeFadeEls();
    const label = makeFadeEls();
    const state = emptyArrowState();
    applyFade([path.el, bg.el, label.el], label.el, 0.5, state);
    path.style.opacity = 'sentinel'; // overwrite to detect a re-write
    bg.style.opacity = 'sentinel';
    label.style.opacity = 'sentinel';
    applyFade([path.el, bg.el, label.el], label.el, 0.5001, state);
    expect(path.style.opacity).toBe('sentinel');
    expect(bg.style.opacity).toBe('sentinel');
    expect(label.style.opacity).toBe('sentinel');
  });

  it('toggles label pointer-events at the 0.5 alpha threshold', () => {
    const path = makeFadeEls();
    const bg = makeFadeEls();
    const label = makeFadeEls();
    const state = emptyArrowState();
    applyFade([path.el, bg.el, label.el], label.el, 1.0, state);
    expect(label.style.pointerEvents).toBe('');
    expect(state.lastPointerEvents).toBe('');
    applyFade([path.el, bg.el, label.el], label.el, 0.3, state);
    expect(label.style.pointerEvents).toBe('none');
    expect(state.lastPointerEvents).toBe('none');
  });

  it('resetArrowSentinels wipes every per-attribute sentinel back to its poison-init value (9mm.170)', () => {
    // Regression for 9mm.170: hideArrow must wipe the numeric / text /
    // opacity / pointer-events sentinels, not just the visible d / display
    // pair. Without this, the next show-from-hide cycle would inherit
    // stale cx/cy/lx/ly from the prior visible session whenever the new
    // coords fell within ATTR_DIRTY_PX of them — silently skipping the
    // first-frame setAttribute and pinning the label to its old position.
    const populated: ArrowState = {
      lastD: 'M250,100L300,150',
      lastLabelDisplay: '',
      lastLabelText: 'Sol · 4.2 pc',
      lastLabelX: 312,
      lastLabelY: 96,
      lastOpacity: 0.7,
      lastPointerEvents: '',
    };
    resetArrowSentinels(populated);
    // Numeric sentinels return to NaN (any real value differs).
    expect(Number.isNaN(populated.lastLabelX)).toBe(true);
    expect(Number.isNaN(populated.lastLabelY)).toBe(true);
    // String + opacity sentinels return to their canonical poisons.
    expect(populated.lastLabelText).toBe('\0');
    expect(populated.lastOpacity).toBe(-Infinity);
    expect(populated.lastPointerEvents).toBe('\0');
    // d + display are NOT reset — they ride the dirty-attr gate so the
    // hide-state value (set elsewhere in hideArrow) stays as the cached
    // last value.
    expect(populated.lastD).toBe('M250,100L300,150');
    expect(populated.lastLabelDisplay).toBe('');
  });

  it("first pointer-events write lands from poison '\\0' sentinel even when alpha=1 yields ''", () => {
    // Regression test for the original-9mm.167 case where
    // `lastPointerEvents: ''` matched the steady-state derived value and
    // the first restore-to-clickable write was skipped. The fresh sentinel
    // must be poison ('\0') so the first apply writes through.
    const path = makeFadeEls();
    const bg = makeFadeEls();
    const label = makeFadeEls();
    const state = emptyArrowState();
    expect(state.lastPointerEvents).toBe('\0');
    applyFade([path.el, bg.el, label.el], label.el, 1.0, state);
    expect(label.style.pointerEvents).toBe('');
    expect(state.lastPointerEvents).toBe('');
  });
});
