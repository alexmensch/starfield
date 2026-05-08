import Fuse from 'fuse.js';
import type { Stellata } from './stellata';
import type { Catalog } from './catalog-loader';
import type { CloudCatalog } from './cloud-loader';
import { TYPEAHEAD_MAX_RESULTS } from './typeahead-util';
import { Typeahead, TypeaheadGroup } from './typeahead';

export interface SearchIndexEntry {
  i: number;
  p?: string;
  b?: string;
  f?: number;
  hip?: number;
  hd?: number;
  hr?: number;
  gl?: string;
  c?: number;
  s?: string;  // spectral designation string, cleaned for display
}

type EntryKind = 'star' | 'cloud';

interface FuzzyEntry {
  kind: EntryKind;
  index: number;
  label: string;        // what Fuse matches on
  primary: string;      // shown in dropdown primary line
  displayCon: string;   // shown in dropdown secondary line
}

// Canonical Greek letter forms keyed by AT-HYG's 3-letter Latin abbreviation.
const BAYER_FULL: Record<string, string> = {
  Alp: 'Alpha', Bet: 'Beta', Gam: 'Gamma', Del: 'Delta', Eps: 'Epsilon',
  Zet: 'Zeta', Eta: 'Eta', The: 'Theta', Iot: 'Iota', Kap: 'Kappa',
  Lam: 'Lambda', Mu: 'Mu', Nu: 'Nu', Xi: 'Xi', Omi: 'Omicron',
  Pi: 'Pi', Rho: 'Rho', Sig: 'Sigma', Tau: 'Tau', Ups: 'Upsilon',
  Phi: 'Phi', Chi: 'Chi', Psi: 'Psi', Ome: 'Omega',
};
const BAYER_GREEK: Record<string, string> = {
  Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε',
  Zet: 'ζ', Eta: 'η', The: 'θ', Iot: 'ι', Kap: 'κ',
  Lam: 'λ', Mu: 'μ', Nu: 'ν', Xi: 'ξ', Omi: 'ο',
  Pi: 'π', Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ',
  Phi: 'φ', Chi: 'χ', Psi: 'ψ', Ome: 'ω',
};

// Returns { letter3, suffix } for a Bayer string like "Alp" or "Alp-2".
// Unknown letter returns null.
export function splitBayer(bayer: string): { letter3: string; suffix: string } | null {
  const m = bayer.match(/^([A-Za-z]+)(?:-(\d))?$/);
  if (!m) return null;
  const letter3 = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  if (!(letter3 in BAYER_FULL)) return null;
  return { letter3, suffix: m[2] ? `-${m[2]}` : '' };
}

// Human-facing Bayer display string, e.g. "α¹ Cen".
export function formatBayerDisplay(bayer: string, conCode: string): string {
  const split = splitBayer(bayer);
  if (!split) return `${bayer} ${conCode}`;
  const greek = BAYER_GREEK[split.letter3];
  const sup = split.suffix ? superscript(split.suffix.slice(1)) : '';
  return `${greek}${sup} ${conCode}`;
}

export function superscript(digit: string): string {
  const map: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  return digit.split('').map((d) => map[d] ?? d).join('');
}

// Each Bayer'd star gets several fuzzy-index entries so the user can type any
// of "Alpha Cen", "Alp Cen", "α Cen", or "Alpha Centaurus" and find it. The
// "-1/-2" superscript from AT-HYG (which distinguishes the A/B components of
// a multiple system) is deliberately NOT in the search labels — users type
// "Alpha Cen" to mean the system, not "Alpha 1 Cen". Both A and B stars emit
// the same labels and will both appear in the results, letting the user pick.
// The superscript DOES show in the display form ("α¹ Cen") to disambiguate.
export function buildBayerLabels(
  bayer: string,
  conCode: string,
  conName: string,
): string[] {
  const split = splitBayer(bayer);
  if (!split) return [`${bayer} ${conCode}`];
  const full = BAYER_FULL[split.letter3];
  const greek = BAYER_GREEK[split.letter3];
  const labels = new Set<string>();
  labels.add(`${full} ${conCode}`);
  labels.add(`${full} ${conName}`);
  labels.add(`${split.letter3} ${conCode}`);
  labels.add(`${greek} ${conCode}`);
  labels.add(`${greek} ${conName}`);
  if (split.letter3 === 'Alp') {
    labels.add(`Alf ${conCode}`);
    labels.add(`Alf ${conName}`);
  }
  return [...labels];
}

// Best human-readable label for a star, falling back through identifier
// tiers: proper name → Bayer designation → Flamsteed → HIP → HD → HR → Gl.
// For use in the focus display, meta bar, tooltip, and the search-box
// value when a star is picked.
export function buildStarLabels(
  catalog: Catalog,
  raw: SearchIndexEntry[],
): Map<number, string> {
  const labels = new Map<number, string>();
  for (const [idx, name] of catalog.names) labels.set(idx, name);

  for (const entry of raw) {
    if (labels.has(entry.i)) continue;
    const conIdx = entry.c ?? 255;
    const con = conIdx !== 255 ? catalog.constellations[conIdx] : null;
    const conCode = con?.code ?? '';
    if (entry.b && conCode) {
      labels.set(entry.i, formatBayerDisplay(entry.b, conCode));
    } else if (entry.f !== undefined && conCode) {
      labels.set(entry.i, `${entry.f} ${conCode}`);
    } else if (entry.hip !== undefined) {
      labels.set(entry.i, `HIP ${entry.hip}`);
    } else if (entry.hd !== undefined) {
      labels.set(entry.i, `HD ${entry.hd}`);
    } else if (entry.hr !== undefined) {
      labels.set(entry.i, `HR ${entry.hr}`);
    } else if (entry.gl) {
      labels.set(entry.i, `Gl ${entry.gl}`);
    }
  }
  return labels;
}

// Map of star index → spectral designation string ("G2 V", "M1.5Iab-b",
// "K0III+K7V", etc.), as carried from the source catalog via search-index.
// Used by the hover tooltip to show full classification info.
export function buildSpectralMap(raw: SearchIndexEntry[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const entry of raw) {
    if (entry.s) out.set(entry.i, entry.s);
  }
  return out;
}

export interface BayerInfo {
  /** Greek letter glyph, e.g. "α". */
  greek: string;
  /** Optional unicode-superscript suffix for A/B components, e.g. "¹". */
  suffix: string;
  /** Constellation index from the catalog (255 = none). */
  conIdx: number;
}

// Map star idx → its Bayer designation parts. Used by chart mode to render
// Greek-letter labels alongside proper names. Entries without a parseable
// Bayer string or a constellation are skipped — chart labels need both.
export function buildBayerMap(raw: SearchIndexEntry[]): Map<number, BayerInfo> {
  const out = new Map<number, BayerInfo>();
  for (const entry of raw) {
    if (!entry.b) continue;
    if (entry.c === undefined || entry.c === 255) continue;
    const split = splitBayer(entry.b);
    if (!split) continue;
    const greek = BAYER_GREEK[split.letter3];
    const suffix = split.suffix ? superscript(split.suffix.slice(1)) : '';
    out.set(entry.i, { greek, suffix, conIdx: entry.c });
  }
  return out;
}

export function bindSearch(
  stellata: Stellata,
  catalog: Catalog,
  raw: SearchIndexEntry[],
  starLabels: Map<number, string>,
  clouds: CloudCatalog | null,
) {
  // Direct-lookup maps for numeric IDs. Prefix form ("HIP 12345", "HD 128620")
  // dispatches here rather than through the fuzzy index.
  const hipMap = new Map<number, number>();
  const hdMap = new Map<number, number>();
  const hrMap = new Map<number, number>();
  const glMap = new Map<string, number>();
  const flamMap = new Map<string, number>(); // key: `${flam} ${conCode}` lowercased

  const fuzzyEntries: FuzzyEntry[] = [];
  const conByIdx = catalog.constellations;

  for (const entry of raw) {
    if (entry.hip !== undefined) hipMap.set(entry.hip, entry.i);
    if (entry.hd !== undefined) hdMap.set(entry.hd, entry.i);
    if (entry.hr !== undefined) hrMap.set(entry.hr, entry.i);
    if (entry.gl !== undefined) {
      // Normalize "Gl 559A" / "GJ 559" / "Gliese 559A" all to "559a".
      const norm = entry.gl.replace(/^(GJ|Gl|Gliese)\s*/i, '').toLowerCase();
      if (norm) glMap.set(norm, entry.i);
    }

    const conIdx = entry.c ?? 255;
    const con = conIdx !== 255 ? conByIdx[conIdx] : null;
    const conCode = con?.code ?? '';
    const conName = con?.name ?? '';

    if (entry.f !== undefined && conCode) {
      // Flamsteed: the same number can recur across constellations, so key by
      // both. Also add the 3-letter form since most users type that.
      flamMap.set(`${entry.f} ${conCode.toLowerCase()}`, entry.i);
      flamMap.set(`${entry.f} ${conName.toLowerCase()}`, entry.i);
    }

    // Build the display form once per star so every label for this star
    // shares the same presentation. Format: "ProperName (α¹ Cen)" when
    // both are available, else whichever exists. The Bayer portion in the
    // display preserves the AT-HYG component suffix as a Unicode superscript
    // to disambiguate A/B pairs in the dropdown (even though the search
    // labels drop it — see buildBayerLabels).
    const properName = entry.p ?? null;
    const bayerDisplay = entry.b && conCode ? formatBayerDisplay(entry.b, conCode) : null;
    let primary: string;
    if (properName && bayerDisplay) primary = `${properName} (${bayerDisplay})`;
    else if (properName) primary = properName;
    else if (bayerDisplay) primary = bayerDisplay;
    else continue; // no human-readable label and no Bayer — only findable via numeric ID
    const displayCon = con?.name ?? '';

    if (properName) {
      fuzzyEntries.push({ kind: 'star', index: entry.i, label: properName, primary, displayCon });
    }
    if (entry.b && conCode) {
      for (const label of buildBayerLabels(entry.b, conCode, conName)) {
        fuzzyEntries.push({ kind: 'star', index: entry.i, label, primary, displayCon });
      }
    }
    if (entry.f !== undefined && conCode) {
      fuzzyEntries.push({
        kind: 'star',
        index: entry.i,
        label: `${entry.f} ${conCode}`,
        primary,
        displayCon,
      });
      fuzzyEntries.push({
        kind: 'star',
        index: entry.i,
        label: `${entry.f} ${conName}`,
        primary,
        displayCon,
      });
    }
  }

  // Cloud entries — typed-name match plus a "cloud" badge in the dropdown
  // secondary line so users can distinguish Taurus (the cloud) from Tau
  // (any star labelled "Tau …").
  if (clouds) {
    for (let i = 0; i < clouds.clouds.length; i++) {
      const c = clouds.clouds[i];
      fuzzyEntries.push({
        kind: 'cloud',
        index: i,
        label: c.name,
        primary: c.name,
        displayCon: 'Molecular cloud',
      });
    }
  }

  // Threshold 0.25 trims the long tail of loose matches (e.g. "alpha cen"
  // used to dredge up "Aldebaran" via shared letters). 0.35 was too lenient
  // for short queries against a few-thousand-entry corpus.
  const fuse = new Fuse(fuzzyEntries, {
    keys: ['label'],
    threshold: 0.25,
    ignoreLocation: true,
    includeScore: true,
  });

  // Run a query, dispatching to direct-lookup maps when the form matches,
  // otherwise falling back to fuzzy search. Deduplicates by star index so the
  // dropdown doesn't show "Alpha Cen", "Alpha Centaurus", "α Cen" for the
  // same star.
  const runQuery = (q: string): FuzzyEntry[] => {
    const trimmed = q.trim();

    // Numeric-prefixed ID lookups.
    const idPatterns: Array<{ re: RegExp; map: Map<number, number>; prefix: string }> = [
      { re: /^hip\s*(\d+)$/i, map: hipMap, prefix: 'HIP' },
      { re: /^hd\s*(\d+)$/i, map: hdMap, prefix: 'HD' },
      { re: /^hr\s*(\d+)$/i, map: hrMap, prefix: 'HR' },
    ];
    for (const { re, map, prefix } of idPatterns) {
      const m = trimmed.match(re);
      if (m) {
        const idx = map.get(Number(m[1]));
        return idx !== undefined ? [directResult(idx, `${prefix} ${m[1]}`)] : [];
      }
    }
    // Gliese: "Gl 559A", "GJ 581", "Gliese 411"
    const glMatch = trimmed.match(/^(?:gl|gj|gliese)\s*(\d+\s*[a-z]?)$/i);
    if (glMatch) {
      const key = glMatch[1].replace(/\s+/g, '').toLowerCase();
      const idx = glMap.get(key);
      return idx !== undefined ? [directResult(idx, `Gl ${glMatch[1].toUpperCase()}`)] : [];
    }
    // Flamsteed: "58 Ori"
    const flamMatch = trimmed.match(/^(\d+)\s+([A-Za-z]+)$/);
    if (flamMatch) {
      const key = `${flamMatch[1]} ${flamMatch[2].toLowerCase()}`;
      const idx = flamMap.get(key);
      if (idx !== undefined) return [directResult(idx, `${flamMatch[1]} ${flamMatch[2]}`)];
      // Fall through to fuzzy — maybe "58 Ori" is a partial match on a label.
    }

    const res = fuse.search(trimmed, { limit: 30 });
    const seen = new Set<string>();
    const out: FuzzyEntry[] = [];
    for (const r of res) {
      // Key by kind+index so a star whose name collides with a cloud name
      // (e.g. "Taurus" the cloud vs. some Tau star) doesn't dedupe across
      // categories. The fuzzy index intentionally carries multiple labels
      // per star, so within-kind dedup is still necessary.
      const key = `${r.item.kind}:${r.item.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r.item);
      if (out.length >= TYPEAHEAD_MAX_RESULTS) break;
    }
    return out;
  };

  const directResult = (idx: number, label: string): FuzzyEntry => {
    const conIdx = catalog.constellation[idx];
    const con = conIdx !== 255 ? catalog.constellations[conIdx] : null;
    const name = catalog.names.get(idx);
    return {
      kind: 'star',
      index: idx,
      label,
      primary: name ? `${name} (${label})` : label,
      displayCon: con?.name ?? '',
    };
  };

  const resultsEl = document.getElementById('search-results') as HTMLUListElement;
  const focusInput = document.getElementById('search-focus') as HTMLInputElement;
  const focusClear = document.getElementById('search-focus-clear') as HTMLButtonElement;
  const focusTag = document.getElementById('search-focus-tag')!;
  const toInput = document.getElementById('search-to') as HTMLInputElement;
  const toClear = document.getElementById('search-to-clear') as HTMLButtonElement;
  const toRow = document.getElementById('search-to-row')!;

  const describe = (idx: number): string => {
    return starLabels.get(idx) ?? `Unnamed #${idx}`;
  };

  // OBSERVE mode is star-only — clouds aren't valid observation anchors,
  // so they shouldn't appear in the location picker. Wrap the shared query
  // to drop them when observing; the To box still uses the unfiltered
  // runner because the distance vector accepts cloud destinations.
  const focusRunQuery = (q: string): FuzzyEntry[] => {
    const all = runQuery(q);
    if (stellata.getCameraMode() === 'observe') {
      return all.filter((e) => e.kind === 'star');
    }
    return all;
  };

  // Both inputs share the single resultsEl, so they share a group too —
  // the group's "active" slot keeps blur-defer from hiding the dropdown
  // when focus moves between focus + to.
  const group = new TypeaheadGroup();

  // Empty constellation falls back to an em-dash so the secondary
  // column never collapses (rows without a constellation still need a
  // baseline).
  const rowFor = (e: FuzzyEntry) => ({
    primary: e.primary,
    sub: e.displayCon || '—',
  });

  // Anchor the floating dropdown under whichever search row triggered
  // it. Both the focus + to inputs share a single absolutely-positioned
  // resultsEl, so its `top` has to be re-computed on every render.
  const positionUnder = (input: HTMLInputElement) => () => {
    const row = input.closest('.search-row') as HTMLElement | null;
    if (row) {
      resultsEl.style.top = row.offsetTop + row.offsetHeight + 'px';
    }
  };

  const focusBox = new Typeahead<FuzzyEntry>({
    input: focusInput,
    resultsEl,
    clearBtn: focusClear,
    runQuery: focusRunQuery,
    rowFor,
    onSelect: (entry) => {
      if (entry.kind === 'cloud') {
        stellata.flyToCloud(entry.index);
      } else if (stellata.getCameraMode() === 'observe') {
        // Re-route through warp so the camera flies from the current
        // observation anchor to the new one and re-enters observe on
        // arrival, instead of teleporting via focusStar.
        stellata.warpTo(entry.index);
      } else {
        stellata.focusStar(entry.index);
      }
    },
    onClear: () => stellata.unfocus(),
    positionResults: positionUnder(focusInput),
    group,
  });

  // Distance-vector destination — accepts both star and cloud entries.
  // The pick handler dispatches to the appropriate setter; the two
  // mutually exclude in Stellata, so flipping between a star and a
  // cloud destination clears the previous one.
  const toBox = new Typeahead<FuzzyEntry>({
    input: toInput,
    resultsEl,
    clearBtn: toClear,
    runQuery,
    rowFor,
    onSelect: (entry) => {
      if (entry.kind === 'cloud') stellata.setVectorToCloud(entry.index);
      else stellata.setVectorTo(entry.index);
    },
    onClear: () => {
      stellata.setVectorTo(null);
      stellata.setVectorToCloud(null);
    },
    positionResults: positionUnder(toInput),
    group,
  });

  // Single sync for both star and cloud focus — the two are mutually
  // exclusive (setting either clears the other in Stellata), so the
  // focus search box renders whichever one is set. The To (distance
  // vector) row is shown whenever a focus is held — clouds participate
  // in the same measurement / warp flow as stars now. OBSERVE mode hides
  // the To row entirely: distance-vector measurement is meaningless from
  // a camera parked on its own anchor, and the underlying setters no-op
  // in that mode anyway.
  const syncFocusUI = () => {
    const starIdx = stellata.getFocusedStar();
    const cloudIdx = stellata.getFocusedCloud();
    const observe = stellata.getCameraMode() === 'observe';
    // OBSERVE makes the focus row read as "where you are observing from"
    // rather than "what you have selected", which is what FOCUS implies in
    // navigate mode. Same field, different mental model.
    focusTag.textContent = observe ? 'Location' : 'Focus';
    if (starIdx !== null) {
      focusBox.setName(describe(starIdx));
      toRow.hidden = observe;
    } else if (cloudIdx !== null && clouds) {
      focusBox.setName(clouds.clouds[cloudIdx].name);
      toRow.hidden = observe;
    } else {
      focusBox.setName('');
      toRow.hidden = true;
      toBox.setName('');
    }
  };
  const syncVectorUI = () => {
    const star = stellata.getVectorTo();
    const cloudVec = stellata.getVectorToCloud();
    if (star !== null) toBox.setName(describe(star));
    else if (cloudVec !== null && clouds) toBox.setName(clouds.clouds[cloudVec].name);
    else toBox.setName('');
  };

  stellata.onFocusChange(syncFocusUI);
  stellata.onCloudFocusChange(syncFocusUI);
  stellata.onCameraModeChange(syncFocusUI);
  stellata.onVectorChange(syncVectorUI);
  stellata.onVectorCloudChange(syncVectorUI);

  syncFocusUI();
  syncVectorUI();
}
