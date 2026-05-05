// Shared primitives for the two typeahead dropdowns (the star/cloud
// SearchBox in `search.ts` and the constellation picker in
// `constellation-typeahead.ts`). The two are otherwise parallel
// implementations of the same UI primitive — see stellata-9kz for a
// follow-up to unify them behind a single `Typeahead<T>` abstraction.

// Sized so the wraparound point matches what the 320px max-height +
// ~30px row height actually shows on screen, so users don't arrow-nav
// past invisible rows.
export const TYPEAHEAD_MAX_RESULTS = 10;

// Toggle `.active` on the previously-hovered and newly-hovered <li> in
// place rather than rebuilding the whole results list. Full rebuild on
// every keystroke was visibly janky on long lists. Also scrolls the
// new row into view so wrap-around past the dropdown's max-height
// stays visible (no-ops when already visible).
export function applyHoverClass(
  resultsEl: Element,
  prevIdx: number,
  newIdx: number,
): void {
  if (prevIdx === newIdx) return;
  const children = resultsEl.children;
  if (prevIdx >= 0 && prevIdx < children.length) {
    (children[prevIdx] as HTMLElement).classList.remove('active');
  }
  if (newIdx >= 0 && newIdx < children.length) {
    const next = children[newIdx] as HTMLElement;
    next.classList.add('active');
    next.scrollIntoView({ block: 'nearest' });
  }
}
