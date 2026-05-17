import type { Stellata } from '../stellata';
import { TYPEAHEAD_MAX_RESULTS } from './typeahead-util';
import { Typeahead } from './typeahead';

// Typeahead replacement for the old `<select id="con-select">` constellation
// picker. 88 entries, all known up-front — no fuzzy library needed; a
// simple substring filter against name + IAU 3-letter code is plenty.
//
// UX modeled on the Focus/To search box in `search.ts`: both binders use
// the shared `Typeahead<T>` abstraction in `typeahead.ts`. Selecting fires
// both `setFilter({ highlightCon })` and `aimAtConstellation`, matching
// the prior `<select>`'s behaviour.

export interface ConEntry {
  idx: number;  // -1 for the synthetic "None" entry that clears the highlight
  name: string;
  code: string;
  search: string;  // lowercased "name code" for substring matching
}

// Synthetic top-of-list entry that clears the highlight when picked. We
// pin it on top whenever the input is empty so users can land on it
// after Cmd+A → Delete → Enter, mirroring the way they pick any other
// constellation.
const NONE_ENTRY: ConEntry = { idx: -1, name: 'None', code: '', search: '' };

// Substring filter on lowercased "name code". Empty query returns
// [None, ...first TYPEAHEAD_MAX_RESULTS-1 entries] so the dropdown opens
// with the clear-highlight option pinned and the alphabetical list under
// it. Non-empty query filters and caps at TYPEAHEAD_MAX_RESULTS without
// prepending None — picking None for a constellation that doesn't match
// is not meaningful.
export function filterConstellations(entries: ConEntry[], query: string): ConEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [NONE_ENTRY, ...entries.slice(0, TYPEAHEAD_MAX_RESULTS - 1)];
  return entries.filter((e) => e.search.includes(q)).slice(0, TYPEAHEAD_MAX_RESULTS);
}

export function bindConstellationTypeahead(stellata: Stellata) {
  const input = document.getElementById('con-input') as HTMLInputElement;
  const resultsEl = document.getElementById('con-results') as HTMLUListElement;
  if (!input || !resultsEl) return;

  const entries: ConEntry[] = stellata.catalog.constellations
    .map((c, idx) => ({
      idx,
      name: c.name,
      code: c.code,
      search: `${c.name} ${c.code}`.toLowerCase(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const nameForIdx = (idx: number): string => {
    if (idx < 0) return '';
    const c = stellata.catalog.constellations[idx];
    return c ? c.name : '';
  };

  const typeahead = new Typeahead<ConEntry>({
    input,
    resultsEl,
    runQuery: (q) => filterConstellations(entries, q),
    rowFor: (e) => ({ primary: e.name, sub: e.code }),
    onSelect: (e) => {
      stellata.setFilter({ highlightCon: e.idx });
      // The synthetic None entry has no constellation to aim at — picking
      // it just clears the highlight.
      if (e.idx >= 0) stellata.aimAtConstellation(e.idx);
    },
  });

  // Reverse-sync from filter state — URL restore, "None"-pick, etc.
  const syncFromFilter = () => {
    typeahead.setName(nameForIdx(stellata.getFilter().highlightCon));
  };
  stellata.on('filter', syncFromFilter);
  syncFromFilter();
}
