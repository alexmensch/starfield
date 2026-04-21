import Fuse from 'fuse.js';
import type { Starfield } from './starfield';
import type { Catalog } from './catalog-loader';

interface SearchEntry {
  index: number;
  name: string;
  con: string;
  conCode: string;
}

let activeBox: SearchBox | null = null;

class SearchBox {
  private displayName = '';
  private results: SearchEntry[] = [];
  private hoverIdx = -1;

  constructor(
    readonly input: HTMLInputElement,
    private clearBtn: HTMLButtonElement,
    private resultsEl: HTMLUListElement,
    private fuse: Fuse<SearchEntry>,
    private onSelect: (idx: number) => void,
    private onClear: () => void,
  ) {
    input.addEventListener('input', () => this.render(input.value));
    input.addEventListener('focus', () => {
      activeBox = this;
      if (input.value) this.render(input.value);
    });
    input.addEventListener('blur', () => {
      // Delay so a mousedown on a result can fire first.
      setTimeout(() => {
        if (activeBox === this) {
          resultsEl.hidden = true;
          activeBox = null;
        }
        this.restore();
      }, 140);
    });
    input.addEventListener('keydown', (e) => this.handleKey(e));
    clearBtn.addEventListener('click', () => {
      this.onClear();
      input.focus();
    });
  }

  setName(name: string) {
    this.displayName = name;
    if (activeBox !== this) this.input.value = name;
    this.clearBtn.hidden = !name;
  }

  private restore() {
    // If the user typed but didn't pick a result, put the current state name
    // back so the input always reflects truth.
    this.input.value = this.displayName;
  }

  private render(query: string) {
    const q = query.trim();
    if (!q) {
      this.resultsEl.hidden = true;
      this.results = [];
      this.hoverIdx = -1;
      return;
    }
    const res = this.fuse.search(q, { limit: 12 });
    this.results = res.map((r) => r.item);
    this.hoverIdx = this.results.length > 0 ? 0 : -1;
    this.renderResultsDom();
    this.resultsEl.hidden = this.results.length === 0;
    // Position dropdown under the row that owns this input.
    const row = this.input.closest('.search-row') as HTMLElement | null;
    if (row) {
      this.resultsEl.style.top = row.offsetTop + row.offsetHeight + 'px';
    }
  }

  private renderResultsDom() {
    this.resultsEl.innerHTML = '';
    for (let i = 0; i < this.results.length; i++) {
      const e = this.results[i];
      const li = document.createElement('li');
      li.className = i === this.hoverIdx ? 'active' : '';
      li.innerHTML = `<span>${escapeHtml(e.name)}</span><span class="sub">${escapeHtml(e.con || '—')}</span>`;
      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        this.pick(i);
      });
      this.resultsEl.appendChild(li);
    }
  }

  private pick(i: number) {
    const e = this.results[i];
    if (!e) return;
    this.onSelect(e.index);
    // The Starfield state change will call setName with the new display value.
    this.resultsEl.hidden = true;
    this.input.blur();
  }

  private handleKey(e: KeyboardEvent) {
    if (this.results.length === 0) return;
    if (e.key === 'ArrowDown') {
      this.hoverIdx = (this.hoverIdx + 1) % this.results.length;
      this.renderResultsDom();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      this.hoverIdx = (this.hoverIdx - 1 + this.results.length) % this.results.length;
      this.renderResultsDom();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (this.hoverIdx >= 0) this.pick(this.hoverIdx);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      this.resultsEl.hidden = true;
      this.input.blur();
    }
  }
}

export function bindSearch(starfield: Starfield, catalog: Catalog) {
  const entries: SearchEntry[] = [];
  for (const [index, name] of catalog.names) {
    const conIdx = catalog.constellation[index];
    const con = conIdx !== 255 ? catalog.constellations[conIdx] : null;
    entries.push({
      index,
      name,
      con: con?.name ?? '',
      conCode: con?.code ?? '',
    });
  }
  const fuse = new Fuse(entries, {
    keys: [
      { name: 'name', weight: 0.7 },
      { name: 'con', weight: 0.15 },
      { name: 'conCode', weight: 0.15 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
    includeScore: true,
  });

  const resultsEl = document.getElementById('search-results') as HTMLUListElement;
  const focusInput = document.getElementById('search-focus') as HTMLInputElement;
  const focusClear = document.getElementById('search-focus-clear') as HTMLButtonElement;
  const toInput = document.getElementById('search-to') as HTMLInputElement;
  const toClear = document.getElementById('search-to-clear') as HTMLButtonElement;
  const toRow = document.getElementById('search-to-row')!;

  const describe = (idx: number): string => {
    return catalog.names.get(idx) ?? `Unnamed #${idx}`;
  };

  const focusBox = new SearchBox(
    focusInput,
    focusClear,
    resultsEl,
    fuse,
    (idx) => starfield.focusStar(idx),
    () => starfield.unfocus(),
  );

  const toBox = new SearchBox(
    toInput,
    toClear,
    resultsEl,
    fuse,
    (idx) => starfield.setVectorTo(idx),
    () => starfield.setVectorTo(null),
  );

  const syncFocus = (idx: number | null) => {
    focusBox.setName(idx !== null ? describe(idx) : '');
    toRow.hidden = idx === null;
    if (idx === null) toBox.setName('');
  };
  const syncVector = (idx: number | null) => {
    toBox.setName(idx !== null ? describe(idx) : '');
  };

  starfield.onFocusChange(syncFocus);
  starfield.onVectorChange(syncVector);

  // Seed initial state (focus may already be Sol at boot).
  syncFocus(starfield.getFocusedStar());
  syncVector(starfield.getVectorTo());
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
