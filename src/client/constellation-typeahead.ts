import type { Starfield } from './starfield';

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

interface ConEntry {
  idx: number;
  name: string;
  code: string;
  search: string;  // lowercased "name code" for substring matching
}

const MAX_RESULTS = 30;

export function bindConstellationTypeahead(starfield: Starfield) {
  const input = document.getElementById('con-input') as HTMLInputElement;
  const resultsEl = document.getElementById('con-results') as HTMLUListElement;
  const resetBtn = document.getElementById('con-reset')!;
  if (!input || !resultsEl) return;

  const entries: ConEntry[] = starfield.catalog.constellations
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
    const c = starfield.catalog.constellations[idx];
    return c ? c.name : '';
  };

  const filter = (query: string): ConEntry[] => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, MAX_RESULTS);
    return entries.filter((e) => e.search.includes(q)).slice(0, MAX_RESULTS);
  };

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
    starfield.setFilter({ highlightCon: e.idx });
    starfield.aimAtConstellation(e.idx);
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

  resetBtn.addEventListener('click', (e) => {
    e.preventDefault();
    starfield.setFilter({ highlightCon: -1 });
  });

  // Reverse-sync from filter state — URL restore, "reset" click, etc.
  const syncFromFilter = () => {
    const idx = starfield.getFilter().highlightCon;
    displayName = nameForIdx(idx);
    if (!focused) input.value = displayName;
  };
  starfield.onFilterChange(syncFromFilter);
  syncFromFilter();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
