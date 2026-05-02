import { describe, it, expect } from 'vitest';
import { filterConstellations, type ConEntry } from './constellation-typeahead';

// Build a representative subset of constellation entries (in alphabetical
// order, matching the binding's sort step) that exercises the filter.
function makeEntries(): ConEntry[] {
  const list: Array<[string, string]> = [
    ['Andromeda', 'And'],
    ['Cassiopeia', 'Cas'],
    ['Cepheus', 'Cep'],
    ['Centaurus', 'Cen'],
    ['Lyra', 'Lyr'],
    ['Orion', 'Ori'],
    ['Sagittarius', 'Sgr'],
    ['Taurus', 'Tau'],
    ['Ursa Major', 'UMa'],
    ['Ursa Minor', 'UMi'],
  ];
  return list.map(([name, code], i) => ({
    idx: i,
    name,
    code,
    search: `${name} ${code}`.toLowerCase(),
  }));
}

describe('constellation-typeahead / filterConstellations', () => {
  describe('empty query', () => {
    it('returns the None entry pinned on top', () => {
      const out = filterConstellations(makeEntries(), '');
      expect(out[0].idx).toBe(-1);
      expect(out[0].name).toBe('None');
    });

    it('returns None followed by the alphabetical list', () => {
      const out = filterConstellations(makeEntries(), '');
      expect(out[1].name).toBe('Andromeda');
      expect(out[2].name).toBe('Cassiopeia');
    });

    it('treats whitespace-only query as empty', () => {
      const out = filterConstellations(makeEntries(), '   ');
      expect(out[0].idx).toBe(-1);
    });

    it('caps total length at MAX_RESULTS even with None included', () => {
      const many: ConEntry[] = Array.from({ length: 100 }, (_, i) => ({
        idx: i,
        name: `Con${i}`,
        code: `C${i}`,
        search: `con${i} c${i}`,
      }));
      const out = filterConstellations(many, '');
      // None + 29 entries = 30 total
      expect(out).toHaveLength(30);
      expect(out[0].idx).toBe(-1);
    });
  });

  describe('non-empty query', () => {
    it('filters by substring against the search field (name + code)', () => {
      const out = filterConstellations(makeEntries(), 'ori');
      expect(out.map(e => e.name)).toContain('Orion');
    });

    it('matches the IAU 3-letter code', () => {
      const out = filterConstellations(makeEntries(), 'sgr');
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe('Sagittarius');
    });

    it('is case-insensitive', () => {
      const lower = filterConstellations(makeEntries(), 'orion');
      const upper = filterConstellations(makeEntries(), 'ORION');
      const mixed = filterConstellations(makeEntries(), 'OrIoN');
      expect(lower).toEqual(upper);
      expect(lower).toEqual(mixed);
    });

    it('returns multiple matches for a partial substring', () => {
      // "ursa" matches both Ursa Major and Ursa Minor.
      const out = filterConstellations(makeEntries(), 'ursa');
      expect(out).toHaveLength(2);
      expect(out.map(e => e.name).sort()).toEqual(['Ursa Major', 'Ursa Minor']);
    });

    it('does not prepend None when query is non-empty (even if no matches)', () => {
      const out = filterConstellations(makeEntries(), 'xyz-not-a-match');
      expect(out).toHaveLength(0);
      expect(out.find(e => e.idx === -1)).toBeUndefined();
    });

    it('caps results at MAX_RESULTS', () => {
      const many: ConEntry[] = Array.from({ length: 100 }, (_, i) => ({
        idx: i,
        name: `Match${i}`,
        code: `M${i}`,
        search: `match${i} m${i}`,
      }));
      const out = filterConstellations(many, 'match');
      expect(out).toHaveLength(30);
    });

    it('preserves entry order from the input', () => {
      // Filter keeps source order — the binding pre-sorts alphabetically,
      // so results stay alphabetical.
      const entries = makeEntries(); // Andromeda, Cas, Cen, Cep, ...
      // "ce" matches Centaurus and Cepheus — in input order Cassiopeia
      // (matches "ca" not "ce") doesn't match, leaving Centaurus first.
      const out = filterConstellations(entries, 'ce');
      expect(out[0].name).toBe('Cepheus');
      expect(out[1].name).toBe('Centaurus');
    });
  });
});
