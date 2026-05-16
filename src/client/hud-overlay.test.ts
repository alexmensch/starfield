import { describe, expect, it, vi } from 'vitest';
import { applyFade, emptyArrowState } from './hud-overlay';

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
    applyFade(path.el, bg.el, label.el, 0.5, state);
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
    applyFade(path.el, bg.el, label.el, 0.5, state);
    path.style.opacity = 'sentinel'; // overwrite to detect a re-write
    bg.style.opacity = 'sentinel';
    label.style.opacity = 'sentinel';
    applyFade(path.el, bg.el, label.el, 0.5001, state);
    expect(path.style.opacity).toBe('sentinel');
    expect(bg.style.opacity).toBe('sentinel');
    expect(label.style.opacity).toBe('sentinel');
  });

  it('toggles label pointer-events at the 0.5 alpha threshold', () => {
    const path = makeFadeEls();
    const bg = makeFadeEls();
    const label = makeFadeEls();
    const state = emptyArrowState();
    applyFade(path.el, bg.el, label.el, 1.0, state);
    expect(label.style.pointerEvents).toBe('');
    expect(state.lastPointerEvents).toBe('');
    applyFade(path.el, bg.el, label.el, 0.3, state);
    expect(label.style.pointerEvents).toBe('none');
    expect(state.lastPointerEvents).toBe('none');
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
    applyFade(path.el, bg.el, label.el, 1.0, state);
    expect(label.style.pointerEvents).toBe('');
    expect(state.lastPointerEvents).toBe('');
  });
});
