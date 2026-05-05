import { describe, it, expect } from 'vitest';
import {
  applyHoverClass,
  TYPEAHEAD_ACTIVE_CLASS,
  TYPEAHEAD_MAX_RESULTS,
} from './typeahead-util';

// Lightweight Element-shaped stub. The vitest config runs in 'node'
// environment so there's no real DOM; this models just the API surface
// applyHoverClass touches. Mirrors how Element.classList behaves under
// real DOM (set semantics, idempotent add/remove).
interface RowStub {
  classes: Set<string>;
  classList: { add(c: string): void; remove(c: string): void };
  offsetTop: number;
  offsetHeight: number;
}
function makeRow(offsetTop: number, offsetHeight: number): RowStub {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
    },
    offsetTop,
    offsetHeight,
  };
}

interface ListStub {
  children: RowStub[];
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}
function makeList(rows: RowStub[], scrollHeight: number, clientHeight: number): ListStub {
  return { children: rows, scrollTop: 0, scrollHeight, clientHeight };
}

describe('typeahead-util / applyHoverClass', () => {
  it('moves the active class from prev to new index', () => {
    const rows = [makeRow(0, 30), makeRow(30, 30), makeRow(60, 30)];
    const list = makeList(rows, 90, 90);
    rows[0].classList.add(TYPEAHEAD_ACTIVE_CLASS);
    applyHoverClass(list as unknown as Element, 0, 2);
    expect(rows[0].classes.has(TYPEAHEAD_ACTIVE_CLASS)).toBe(false);
    expect(rows[2].classes.has(TYPEAHEAD_ACTIVE_CLASS)).toBe(true);
  });

  it('is a no-op when prev and new index are the same', () => {
    const rows = [makeRow(0, 30), makeRow(30, 30)];
    const list = makeList(rows, 60, 60);
    rows[1].classList.add(TYPEAHEAD_ACTIVE_CLASS);
    applyHoverClass(list as unknown as Element, 1, 1);
    // Untouched.
    expect(rows[1].classes.has(TYPEAHEAD_ACTIVE_CLASS)).toBe(true);
    expect(rows[0].classes.has(TYPEAHEAD_ACTIVE_CLASS)).toBe(false);
  });

  it('ignores out-of-bounds indices for both prev and new', () => {
    const rows = [makeRow(0, 30), makeRow(30, 30)];
    const list = makeList(rows, 60, 60);
    // Negative prev, out-of-range new — both must be no-ops, no throw.
    expect(() => applyHoverClass(list as unknown as Element, -1, 99)).not.toThrow();
    expect(rows[0].classes.has(TYPEAHEAD_ACTIVE_CLASS)).toBe(false);
    expect(rows[1].classes.has(TYPEAHEAD_ACTIVE_CLASS)).toBe(false);
  });

  it('does not scroll when the dropdown is not scrollable', () => {
    // scrollHeight == clientHeight → all rows fit; scrollTop must stay at 0
    // even when the row is "outside" the artificial offsetTop range. The
    // bug this guards against is panel-scroll jitter when a parent
    // container is partially scrolled.
    const rows = [makeRow(0, 30), makeRow(1000, 30)];
    const list = makeList(rows, 60, 60);
    applyHoverClass(list as unknown as Element, 0, 1);
    expect(list.scrollTop).toBe(0);
  });

  it('scrolls the new row into view when it is below the visible window', () => {
    // 3 rows of 30px each, viewport 60px tall — last row (offsetTop=60) is
    // out of view at scrollTop=0.
    const rows = [makeRow(0, 30), makeRow(30, 30), makeRow(60, 30)];
    const list = makeList(rows, 90, 60);
    applyHoverClass(list as unknown as Element, 0, 2);
    // Bottom-aligned: scrollTop = (offsetTop + offsetHeight) - clientHeight
    expect(list.scrollTop).toBe(30);
  });

  it('scrolls the new row into view when it is above the visible window', () => {
    const rows = [makeRow(0, 30), makeRow(30, 30), makeRow(60, 30)];
    const list = makeList(rows, 90, 60);
    list.scrollTop = 30; // last row visible, first off-screen above
    applyHoverClass(list as unknown as Element, 2, 0);
    expect(list.scrollTop).toBe(0);
  });

  it('does not scroll when the new row is already fully in view', () => {
    const rows = [makeRow(0, 30), makeRow(30, 30), makeRow(60, 30)];
    const list = makeList(rows, 90, 60);
    list.scrollTop = 0; // rows 0 + 1 visible
    applyHoverClass(list as unknown as Element, 0, 1);
    expect(list.scrollTop).toBe(0);
  });
});

describe('typeahead-util / TYPEAHEAD_MAX_RESULTS', () => {
  it('matches the documented 320 px / ~30 px row sizing', () => {
    // Pinning the value is the regression net — both typeahead binders
    // depend on the same constant for visible-row count.
    expect(TYPEAHEAD_MAX_RESULTS).toBe(10);
  });
});
