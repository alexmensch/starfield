import { describe, it, expect } from 'vitest';
import {
  splitBayer,
  formatBayerDisplay,
  superscript,
  buildBayerLabels,
  buildBayerMap,
  buildSpectralMap,
  type SearchEntry,
} from './search';

describe('search / splitBayer', () => {
  it('parses a Latin 3-letter Bayer with no suffix', () => {
    expect(splitBayer('Alp')).toEqual({ letter3: 'Alp', suffix: '' });
    expect(splitBayer('Bet')).toEqual({ letter3: 'Bet', suffix: '' });
    expect(splitBayer('Ome')).toEqual({ letter3: 'Ome', suffix: '' });
  });

  it('parses a Bayer with -1 / -2 component suffix', () => {
    expect(splitBayer('Alp-1')).toEqual({ letter3: 'Alp', suffix: '-1' });
    expect(splitBayer('Tau-2')).toEqual({ letter3: 'Tau', suffix: '-2' });
  });

  it('parses 2-letter Bayer (Mu, Nu, Xi, Pi)', () => {
    // The Greek letters whose canonical 3-letter abbreviation is shorter
    // than 3 chars must still parse — they appear in source data verbatim.
    expect(splitBayer('Mu')).toEqual({ letter3: 'Mu', suffix: '' });
    expect(splitBayer('Nu')).toEqual({ letter3: 'Nu', suffix: '' });
    expect(splitBayer('Xi')).toEqual({ letter3: 'Xi', suffix: '' });
    expect(splitBayer('Pi')).toEqual({ letter3: 'Pi', suffix: '' });
  });

  it('normalises mixed-case input', () => {
    // Canonical capitalisation: first letter upper, rest lower.
    expect(splitBayer('alp')).toEqual({ letter3: 'Alp', suffix: '' });
    expect(splitBayer('ALP')).toEqual({ letter3: 'Alp', suffix: '' });
    expect(splitBayer('aLp')).toEqual({ letter3: 'Alp', suffix: '' });
  });

  it('returns null for unknown Greek letters', () => {
    // The dictionary only knows the canonical 24 — anything else is data
    // we don't recognise and shouldn't fabricate a glyph for.
    expect(splitBayer('Foo')).toBeNull();
    expect(splitBayer('Xxx')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(splitBayer('')).toBeNull();
    expect(splitBayer('Alp-')).toBeNull(); // trailing dash with no digit
    expect(splitBayer('Alp-12')).toBeNull(); // multi-digit suffix not supported
    expect(splitBayer('Alp 1')).toBeNull(); // space-separated suffix
  });
});

describe('search / superscript', () => {
  it('maps decimal digits to unicode superscript glyphs', () => {
    expect(superscript('1')).toBe('¹');
    expect(superscript('2')).toBe('²');
    expect(superscript('0')).toBe('⁰');
    expect(superscript('9')).toBe('⁹');
  });

  it('maps multi-digit strings character-by-character', () => {
    expect(superscript('12')).toBe('¹²');
    expect(superscript('420')).toBe('⁴²⁰');
  });

  it('passes through non-digit characters unchanged', () => {
    // Defensive — caller should only pass digits, but the helper must not
    // corrupt unexpected input.
    expect(superscript('a')).toBe('a');
  });

  it('returns empty string for empty input', () => {
    expect(superscript('')).toBe('');
  });
});

describe('search / formatBayerDisplay', () => {
  it('formats a basic Bayer letter as Greek glyph + constellation code', () => {
    expect(formatBayerDisplay('Alp', 'Cen')).toBe('α Cen');
    expect(formatBayerDisplay('Bet', 'Ori')).toBe('β Ori');
  });

  it('attaches a unicode superscript for component suffixes', () => {
    // α¹ Cen (Rigil Kentaurus) — the superscript is what visually
    // distinguishes the A and B components of a Bayer-multiple system.
    expect(formatBayerDisplay('Alp-1', 'Cen')).toBe('α¹ Cen');
    expect(formatBayerDisplay('Tau-2', 'Cet')).toBe('τ² Cet');
  });

  it('falls through to raw-Bayer + code when the letter is unknown', () => {
    // Unknown letters preserve the raw input so the user can still see
    // *something*, rather than swallowing the data silently.
    expect(formatBayerDisplay('Xxx', 'Cen')).toBe('Xxx Cen');
  });
});

describe('search / buildBayerLabels', () => {
  it('returns multiple search forms for a Bayer star', () => {
    const labels = buildBayerLabels('Alp', 'Cen', 'Centauri');
    // Forms users actually type: full Latin name, 3-letter abbrev, Greek glyph,
    // both with code and full constellation name.
    expect(labels).toContain('Alpha Cen');
    expect(labels).toContain('Alpha Centauri');
    expect(labels).toContain('Alp Cen');
    expect(labels).toContain('α Cen');
    expect(labels).toContain('α Centauri');
  });

  it('includes the "Alf Cen" alternate spelling for Alpha only', () => {
    // "Alf" is a common transliteration that some users will type for Alpha.
    // No equivalent transliteration is included for Beta/Gamma/etc.
    const alpha = buildBayerLabels('Alp', 'Cen', 'Centauri');
    expect(alpha).toContain('Alf Cen');
    expect(alpha).toContain('Alf Centauri');

    const beta = buildBayerLabels('Bet', 'Cen', 'Centauri');
    expect(beta.find(l => l.startsWith('Alf'))).toBeUndefined();
  });

  it('drops the component-suffix from search forms', () => {
    // The "-1/-2" suffix exists for binary disambiguation; in search we
    // want users to find the system from "Alpha Cen" without typing the
    // component number. Both A and B share the same labels and surface
    // together in results.
    const aLabels = buildBayerLabels('Alp-1', 'Cen', 'Centauri');
    const noSuffix = buildBayerLabels('Alp', 'Cen', 'Centauri');
    // Must be identical: same lookup keys for both components.
    expect(aLabels.sort()).toEqual(noSuffix.sort());
  });

  it('returns deduped labels (Set semantics)', () => {
    const labels = buildBayerLabels('Alp', 'Cen', 'Centauri');
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('falls back to raw-Bayer + code when the letter is unknown', () => {
    // Unparseable Bayer strings still produce one label so the star isn't
    // unfindable, even though we can't generate the variants.
    expect(buildBayerLabels('Xxx', 'Cen', 'Centauri')).toEqual(['Xxx Cen']);
  });
});

describe('search / buildBayerMap', () => {
  it('produces an entry per Bayer-tagged star with parseable letter and constellation', () => {
    const raw: SearchEntry[] = [
      { i: 0, b: 'Alp', c: 1 },
      { i: 1, b: 'Bet', c: 2 },
    ];
    const map = buildBayerMap(raw);
    expect(map.size).toBe(2);
    expect(map.get(0)).toEqual({ greek: 'α', suffix: '', conIdx: 1 });
    expect(map.get(1)).toEqual({ greek: 'β', suffix: '', conIdx: 2 });
  });

  it('encodes -1/-2 component suffix as a unicode superscript', () => {
    const raw: SearchEntry[] = [{ i: 0, b: 'Alp-1', c: 5 }];
    const map = buildBayerMap(raw);
    expect(map.get(0)).toEqual({ greek: 'α', suffix: '¹', conIdx: 5 });
  });

  it('skips entries with no Bayer string', () => {
    const raw: SearchEntry[] = [
      { i: 0, p: 'Sirius', c: 1 },
      { i: 1, b: 'Alp', c: 2 },
    ];
    const map = buildBayerMap(raw);
    expect(map.has(0)).toBe(false);
    expect(map.has(1)).toBe(true);
  });

  it('skips entries with no constellation (chart label needs both)', () => {
    const raw: SearchEntry[] = [
      { i: 0, b: 'Alp', c: 255 },
      { i: 1, b: 'Bet' /* no c */ },
    ];
    expect(buildBayerMap(raw).size).toBe(0);
  });

  it('skips entries whose Bayer letter is unknown', () => {
    const raw: SearchEntry[] = [
      { i: 0, b: 'Xxx', c: 1 },
      { i: 1, b: 'Alp', c: 1 },
    ];
    const map = buildBayerMap(raw);
    expect(map.has(0)).toBe(false);
    expect(map.has(1)).toBe(true);
  });
});

describe('search / buildSpectralMap', () => {
  it('keeps only entries with a spectral string', () => {
    const raw: SearchEntry[] = [
      { i: 0, s: 'G2 V' },
      { i: 1, s: 'M1.5Iab-b' },
      { i: 2, p: 'NoSpect' },
    ];
    const map = buildSpectralMap(raw);
    expect(map.size).toBe(2);
    expect(map.get(0)).toBe('G2 V');
    expect(map.get(1)).toBe('M1.5Iab-b');
    expect(map.has(2)).toBe(false);
  });

  it('preserves the source spectral string verbatim', () => {
    // Composites and ranges (e.g. 'K0III+K7V', 'M1.5Iab-b') must round-
    // trip through the map without any normalisation — the tooltip shows
    // the catalog's exact classification.
    const raw: SearchEntry[] = [{ i: 0, s: 'K0III+K7V' }];
    expect(buildSpectralMap(raw).get(0)).toBe('K0III+K7V');
  });

  it('returns an empty map when no entries carry spectral info', () => {
    const raw: SearchEntry[] = [{ i: 0, p: 'A' }, { i: 1 }];
    expect(buildSpectralMap(raw).size).toBe(0);
  });
});
