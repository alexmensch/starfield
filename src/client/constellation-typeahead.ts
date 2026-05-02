import type { Stellata } from './stellata';

// Typeahead replacement for the old `<select id="con-select">` constellation
// picker. 88 entries, all known up-front — no fuzzy library needed; a
// simple substring filter against name + IAU 3-letter code is plenty.
//
// UX modeled on the Focus/To search box in `search.ts`: the input shows the
// selected constellation's name when blurred, focusing reveals the dropdown
// (showing the full list if the input is empty), typing filters, blur
// restores the displayed name. Keyboard: ArrowUp/Down + Enter, Escape
// closes. Selecting fires both `setFilter({ highlightCon })` and
// `aimAtConstellation`, matching the prior `<select>`'s behaviour.

export interface ConEntry {
  idx: number;  // -1 for the synthetic "None" entry that clears the highlight
  name: string;
  code: string;
  search: string;  // lowercased "name code" for substring matching
}

const MAX_RESULTS = 30;

// Synthetic top-of-list entry that clears the highlight when picked. We
// pin it on top whenever the input is empty so users can land on it
// after Cmd+A → Delete → Enter, mirroring the way they pick any other
// constellation.
const NONE_ENTRY: ConEntry = { idx: -1, name: 'None', code: '', search: '' };

// Substring filter on lowercased "name code". Empty query returns
// [None, ...first MAX_RESULTS-1 entries] so the dropdown opens with
// the clear-highlight option pinned and the alphabetical list under it.
// Non-empty query filters and caps at MAX_RESULTS without prepending
// None — picking None for a constellation that doesn't match is not
// meaningful.
export function filterConstellations(entries: ConEntry[], query: string): ConEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [NONE_ENTRY, ...entries.slice(0, MAX_RESULTS - 1)];
  return entries.filter((e) => e.search.includes(q)).slice(0, MAX_RESULTS);
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

  let displayName = '';
  let results: ConEntry[] = [];
  let hoverIdx = -1;
  let focused = false;

  const nameForIdx = (idx: number): string => {
    if (idx < 0) return '';
    const c = stellata.catalog.constellations[idx];
    return c ? c.name : '';
  };

  const filter = (query: string): ConEntry[] => filterConstellations(entries, query);

  const renderDom = () => {
    resultsEl.innerHTML = '';
    for (let i = 0; i < results.length; i++) {
      const e = results[i];
      const li = document.createElement('li');
      li.className = i === hoverIdx ? 'active' : '';
      li.innerHTML = `<span>${escapeHtml(e.name)}</span><span class="sub">${escapeHtml(e.code)}</span>`;
      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        pick(i);
      });
      resultsEl.appendChild(li);
    }
  };

  const renderQuery = (query: string) => {
    results = filter(query);
    hoverIdx = results.length > 0 ? 0 : -1;
    renderDom();
    resultsEl.hidden = results.length === 0;
  };

  const pick = (i: number) => {
    const e = results[i];
    if (!e) return;
    stellata.setFilter({ highlightCon: e.idx });
    // The synthetic None entry has no constellation to aim at — picking
    // it just clears the highlight.
    if (e.idx >= 0) stellata.aimAtConstellation(e.idx);
    resultsEl.hidden = true;
    input.blur();
  };

  input.addEventListener('input', () => renderQuery(input.value));
  input.addEventListener('focus', () => {
    focused = true;
    renderQuery(input.value);
  });
  input.addEventListener('blur', () => {
    // Defer so click-on-result (mousedown) wins the race.
    setTimeout(() => {
      focused = false;
      resultsEl.hidden = true;
      input.value = displayName;
    }, 140);
  });
  input.addEventListener('keydown', (e) => {
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      hoverIdx = (hoverIdx + 1) % results.length;
      renderDom();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      hoverIdx = (hoverIdx - 1 + results.length) % results.length;
      renderDom();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (hoverIdx >= 0) pick(hoverIdx);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      resultsEl.hidden = true;
      input.blur();
    }
  });

  // Reverse-sync from filter state — URL restore, "None"-pick, etc.
  const syncFromFilter = () => {
    const idx = stellata.getFilter().highlightCon;
    displayName = nameForIdx(idx);
    if (!focused) input.value = displayName;
  };
  stellata.onFilterChange(syncFromFilter);
  syncFromFilter();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
