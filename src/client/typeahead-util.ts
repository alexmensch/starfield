// Pure helpers for the typeahead dropdowns (the star/cloud picker in
// `search.ts` and the constellation picker in
// `constellation-typeahead.ts`). The DOM glue itself lives in
// `typeahead.ts` (the unified `Typeahead<T>` class — stellata-xbj).

// Sized so the wraparound point matches what the 320px max-height +
// ~30px row height actually shows on screen, so users don't arrow-nav
// past invisible rows.
export const TYPEAHEAD_MAX_RESULTS = 10;

// Class applied to the highlighted row. Coupled to styles.css selectors
// (.search-results li.active and the monochrome variant) — keep them in
// sync if this string changes.
export const TYPEAHEAD_ACTIVE_CLASS = 'active';

// Toggle the highlight class on the previously-hovered and newly-hovered
// <li> in place rather than rebuilding the whole results list. Full
// rebuild on every keystroke was visibly janky on long lists. Also
// scrolls the new row into view when wrap-around lands outside the
// dropdown's visible window.
export function applyHoverClass(
  resultsEl: Element,
  prevIdx: number,
  newIdx: number,
): void {
  if (prevIdx === newIdx) return;
  const children = resultsEl.children;
  if (prevIdx >= 0 && prevIdx < children.length) {
    (children[prevIdx] as HTMLElement).classList.remove(TYPEAHEAD_ACTIVE_CLASS);
  }
  if (newIdx >= 0 && newIdx < children.length) {
    const next = children[newIdx] as HTMLElement;
    next.classList.add(TYPEAHEAD_ACTIVE_CLASS);
    scrollRowIntoView(resultsEl as HTMLElement, next);
  }
}

// Adjust the dropdown's own scrollTop so `row` sits inside its visible
// window. Confines the scroll effect to the dropdown — bypasses
// scrollIntoView({block: 'nearest'}), which walks ancestors and can shift
// a parent panel even when the row is fully visible inside its own
// scrollable list. No-op when the dropdown isn't actually scrollable.
//
// LAYOUT ASSUMPTION: `row.offsetTop` is relative to the row's
// offsetParent (the nearest positioned ancestor). The current CSS for
// `.search-results` and `.con-typeahead .typeahead-results` both set
// `position: absolute`, which makes them the offsetParent of their
// `<li>` rows — so `row.offsetTop` is the desired "row top within
// list" distance. If a future CSS change ever drops `position` from
// either dropdown, offsetTop would silently shift to walk past the
// list to a further positioned ancestor and the scroll math here
// would break. If you hit that, either: (a) restore `position` on the
// list, (b) switch to `row.getBoundingClientRect().top -
// list.getBoundingClientRect().top + list.scrollTop`, or (c) compute
// `row.offsetTop - list.offsetTop` (works only when both share the
// same offsetParent).
function scrollRowIntoView(list: HTMLElement, row: HTMLElement): void {
  if (list.scrollHeight <= list.clientHeight) return;
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  const viewTop = list.scrollTop;
  const viewBottom = viewTop + list.clientHeight;
  if (top < viewTop) list.scrollTop = top;
  else if (bottom > viewBottom) list.scrollTop = bottom - list.clientHeight;
}
