import { describe, it, expect } from 'vitest';
import {
  spectClassIndex,
  parseSpectral,
  tempKelvin,
  boloCorr,
  physicalRadius,
  normalizeGcvsName,
  parseGcvsNumber,
  inferBinaries,
  BINARY_MAX_SEP_PC,
  type SpectralInfo,
  type BinaryStar,
} from './catalog-pure';

describe('catalog-pure / spectClassIndex', () => {
  it('maps the seven main MK classes to indices 0..6', () => {
    expect(spectClassIndex('O')).toBe(0);
    expect(spectClassIndex('B')).toBe(1);
    expect(spectClassIndex('A')).toBe(2);
    expect(spectClassIndex('F')).toBe(3);
    expect(spectClassIndex('G')).toBe(4);
    expect(spectClassIndex('K')).toBe(5);
    expect(spectClassIndex('M')).toBe(6);
  });

  it('groups carbon and Wolf-Rayet variants under index 7', () => {
    // C (carbon), S (zirconium oxide), W (Wolf-Rayet), N (legacy carbon),
    // R (legacy carbon) — all visually-distinct rare classes that share a
    // single renderer bucket.
    expect(spectClassIndex('C')).toBe(7);
    expect(spectClassIndex('S')).toBe(7);
    expect(spectClassIndex('W')).toBe(7);
    expect(spectClassIndex('N')).toBe(7);
    expect(spectClassIndex('R')).toBe(7);
  });

  it('returns 8 (unknown) for any unrecognised letter', () => {
    expect(spectClassIndex('X')).toBe(8);
    expect(spectClassIndex('')).toBe(8);
    expect(spectClassIndex('?')).toBe(8);
  });
});

describe('catalog-pure / parseSpectral', () => {
  it('returns the unknown sentinel for empty input', () => {
    const info = parseSpectral('');
    expect(info).toEqual({
      classIdx: 8, subclass: 5, lumClass: 255, isWhiteDwarf: false, wdSubclass: 0,
    });
  });

  it('parses a basic main-sequence type', () => {
    const info = parseSpectral('G2 V');
    expect(info.classIdx).toBe(4); // G
    expect(info.subclass).toBe(2);
    expect(info.lumClass).toBe(2); // V
    expect(info.isWhiteDwarf).toBe(false);
  });

  it('parses giant and supergiant luminosity classes', () => {
    expect(parseSpectral('K0III').lumClass).toBe(4); // III
    expect(parseSpectral('M2II').lumClass).toBe(5);  // II
    expect(parseSpectral('B5IV').lumClass).toBe(3);  // IV
    expect(parseSpectral('M1Ia').lumClass).toBe(8);  // Ia
    expect(parseSpectral('M1Iab').lumClass).toBe(7); // Iab
    expect(parseSpectral('B0Ib').lumClass).toBe(6);  // Ib
    expect(parseSpectral('A0VII').lumClass).toBe(0); // VII (rare)
    expect(parseSpectral('K3VI').lumClass).toBe(1);  // VI (subdwarf)
  });

  it('parses Ia+ / 0 hypergiants', () => {
    expect(parseSpectral('B5Ia+').lumClass).toBe(9);
    expect(parseSpectral('M2 0').lumClass).toBe(9);
  });

  it('treats bare "I" as Iab (intermediate supergiant)', () => {
    // The catalog occasionally carries just "I" without the a/b/ab suffix —
    // assigning it to Iab keeps the renderer's size mapping centred on the
    // supergiant class rather than over-promoting to Ia or under-promoting
    // to Ib.
    expect(parseSpectral('A0I').lumClass).toBe(7);
  });

  it('handles composite spectra by parsing the first component', () => {
    // K0III+K7V → primary is K0III. The "+" composite separator is left
    // for the caller to ignore; the parser doesn't try to split.
    const info = parseSpectral('K0III+K7V');
    expect(info.classIdx).toBe(5); // K
    expect(info.subclass).toBe(0);
    expect(info.lumClass).toBe(4); // III
  });

  it('parses subdwarfs (sdB, sdO) with lumClass=1', () => {
    const info = parseSpectral('sdB5');
    expect(info.classIdx).toBe(1);   // B
    expect(info.subclass).toBe(5);
    expect(info.lumClass).toBe(1);   // VI (subdwarf)
    expect(info.isWhiteDwarf).toBe(false);
  });

  it('parses white dwarfs (D, DA, DB, DA2)', () => {
    expect(parseSpectral('D').isWhiteDwarf).toBe(true);
    expect(parseSpectral('DA').isWhiteDwarf).toBe(true);
    expect(parseSpectral('DB').isWhiteDwarf).toBe(true);
    expect(parseSpectral('DA2').wdSubclass).toBe(2);
    expect(parseSpectral('DA2').lumClass).toBe(0); // VII
  });

  it('clamps the white-dwarf subclass digit into [0, 9]', () => {
    // The DA[N] number ranges 1-9 in practice; clamp guards malformed input.
    expect(parseSpectral('DA0').wdSubclass).toBe(0);
    expect(parseSpectral('DA9').wdSubclass).toBe(9);
  });

  it('strips leading colons / quotes / whitespace before parsing', () => {
    expect(parseSpectral(':G2V').classIdx).toBe(4);
    expect(parseSpectral('"G2V').classIdx).toBe(4);
    expect(parseSpectral('  G2V').classIdx).toBe(4);
  });

  it('parses fractional subclass digits by taking the integer part', () => {
    // M1.5Iab-b → subclass=1 (integer part of 1.5)
    expect(parseSpectral('M1.5Iab-b').subclass).toBe(1);
    expect(parseSpectral('M1.5Iab-b').lumClass).toBe(7);
  });

  it('case-normalises input', () => {
    const a = parseSpectral('g2v');
    const b = parseSpectral('G2V');
    expect(a).toEqual(b);
  });
});

describe('catalog-pure / tempKelvin', () => {
  function info(classIdx: number, subclass: number, lumClass = 2): SpectralInfo {
    return { classIdx, subclass, lumClass, isWhiteDwarf: false, wdSubclass: 0 };
  }

  it('returns Sun-like temperature for G2 (~5778 K target)', () => {
    // Sun is G2V — interpolated table value should be in the right neighbourhood.
    const T = tempKelvin(info(4, 2));
    expect(T).toBeGreaterThan(5500);
    expect(T).toBeLessThan(6000);
  });

  it('is hotter for O than for B than for A...', () => {
    // Spectral class O is the hottest, M the coolest. Monotone non-increasing
    // along the canonical OBAFGKM order (subclass=5 across the board).
    const Ts = [0, 1, 2, 3, 4, 5, 6].map(c => tempKelvin(info(c, 5)));
    for (let i = 1; i < Ts.length; i++) {
      expect(Ts[i]).toBeLessThan(Ts[i - 1]);
    }
  });

  it('white dwarf temperature scales as 50400 / wdSubclass', () => {
    const wd: SpectralInfo = { classIdx: 8, subclass: 5, lumClass: 0, isWhiteDwarf: true, wdSubclass: 2 };
    expect(tempKelvin(wd)).toBeCloseTo(25200, 1);

    const wd5: SpectralInfo = { ...wd, wdSubclass: 5 };
    expect(tempKelvin(wd5)).toBeCloseTo(10080, 1);
  });

  it('uses the unknown-class neutral table when classIdx is out of range', () => {
    // classIdx=999 → falls back to T_TABLE[8] (5000 K flat).
    expect(tempKelvin(info(999, 5))).toBe(5000);
  });
});

describe('catalog-pure / physicalRadius', () => {
  function info(classIdx: number, subclass: number, lumClass = 2): SpectralInfo {
    return { classIdx, subclass, lumClass, isWhiteDwarf: false, wdSubclass: 0 };
  }

  it('returns ~1 R☉ for the Sun (G2V, absmag=4.83)', () => {
    // Sun is the calibration point of the whole magnitude system. Within
    // ~10% of 1.0 R☉ is the contract — the table-based BC introduces some
    // play but the answer must round-trip near unity.
    const R = physicalRadius(4.83, info(4, 2));
    expect(R).toBeGreaterThan(0.9);
    expect(R).toBeLessThan(1.2);
  });

  it('returns a tiny radius for white dwarfs (~0.013 R☉, hardcoded)', () => {
    const wd: SpectralInfo = { classIdx: 8, subclass: 5, lumClass: 0, isWhiteDwarf: true, wdSubclass: 2 };
    // WDs ignore absmag and return a fixed small radius — the catalog's
    // absmag for WDs doesn't translate reliably into physical radius via
    // Stefan-Boltzmann.
    expect(physicalRadius(11, wd)).toBeCloseTo(0.013, 5);
    expect(physicalRadius(0, wd)).toBeCloseTo(0.013, 5);
  });

  it('produces a much larger radius for a supergiant than for the Sun', () => {
    // Betelgeuse-ish: M2 supergiant, absmag ≈ -5.85. Stefan-Boltzmann gives
    // the very large radius the chart-mode disc relies on.
    const big = physicalRadius(-5.85, info(6, 2, 7));
    const sun = physicalRadius(4.83, info(4, 2));
    expect(big).toBeGreaterThan(sun * 100);
  });

  it('clamps absurdly bright catalog rows to the upper bound', () => {
    // absmag=-30 is unphysical (pre-cap luminosity ≈ 10^14 L☉). The clamp
    // should saturate at 2500 R☉ rather than letting the ratio explode.
    const R = physicalRadius(-30, info(0, 0));
    expect(R).toBeLessThanOrEqual(2500);
  });

  it('clamps absurdly dim catalog rows to the lower bound', () => {
    // absmag=+30 makes L tiny; without the floor, R would underflow toward 0.
    // Lower clamp keeps red-dwarf-ish minimum so renderable.
    const R = physicalRadius(30, info(6, 9));
    expect(R).toBeGreaterThanOrEqual(0.08);
  });
});

describe('catalog-pure / boloCorr', () => {
  function info(classIdx: number, subclass: number, lumClass = 2): SpectralInfo {
    return { classIdx, subclass, lumClass, isWhiteDwarf: false, wdSubclass: 0 };
  }

  it('is near zero for solar-type stars', () => {
    // BC for G2V should be a few hundredths — the Sun is the reference.
    expect(Math.abs(boloCorr(info(4, 2)))).toBeLessThan(0.5);
  });

  it('is strongly negative for hot O-class stars (UV-rich)', () => {
    expect(boloCorr(info(0, 0))).toBeLessThan(-3);
  });

  it('is strongly negative for cool M-class stars (IR-rich)', () => {
    expect(boloCorr(info(6, 9))).toBeLessThan(-3);
  });
});

describe('catalog-pure / normalizeGcvsName', () => {
  it('collapses internal whitespace to a single space', () => {
    expect(normalizeGcvsName('R     And')).toBe('R And');
    expect(normalizeGcvsName('V0640    Cas')).toBe('V0640 Cas');
  });

  it('strips trailing asterisks', () => {
    expect(normalizeGcvsName('R And *')).toBe('R And');
    expect(normalizeGcvsName('R And **')).toBe('R And');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeGcvsName('  R And  ')).toBe('R And');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeGcvsName('   ')).toBe('');
  });
});

describe('catalog-pure / parseGcvsNumber', () => {
  it('parses a plain number', () => {
    expect(parseGcvsNumber('5.5')).toBe(5.5);
    expect(parseGcvsNumber('100')).toBe(100);
  });

  it('strips uncertainty markers and brackets', () => {
    expect(parseGcvsNumber('<5.5')).toBe(5.5);
    expect(parseGcvsNumber('5.5:')).toBe(5.5);
    expect(parseGcvsNumber('(5.5)')).toBe(5.5);
    expect(parseGcvsNumber('5.5*')).toBe(5.5);
    expect(parseGcvsNumber('>5.5')).toBe(5.5);
  });

  it('returns null for empty / whitespace input', () => {
    expect(parseGcvsNumber('')).toBeNull();
    expect(parseGcvsNumber('   ')).toBeNull();
  });

  it('returns null for non-numeric input', () => {
    expect(parseGcvsNumber('abc')).toBeNull();
    expect(parseGcvsNumber('---')).toBeNull();
  });

  it('returns null for input that strips down to nothing', () => {
    expect(parseGcvsNumber('()')).toBeNull();
    expect(parseGcvsNumber(':*')).toBeNull();
  });
});

describe('catalog-pure / inferBinaries', () => {
  function makeStar(opts: Partial<BinaryStar> & { x: number; y: number; z: number; absmag: number }): BinaryStar {
    return { flags: 0, companionIdx: -1, ...opts };
  }

  it('flags a single close pair as a binary', () => {
    // Two stars at 0.001 pc apart — well under BINARY_MAX_SEP_PC (0.005 pc).
    const stars: BinaryStar[] = [
      makeStar({ x: 0, y: 0, z: 0, absmag: 4 }),
      makeStar({ x: 0.001, y: 0, z: 0, absmag: 6 }),
    ];
    const stats = inferBinaries(stars);
    expect(stats.pairs).toBe(2); // both record the other as companion
    expect(stats.primaries).toBe(1);
    expect(stars[0].companionIdx).toBe(1);
    expect(stars[1].companionIdx).toBe(0);
  });

  it('flags the brighter (lower absmag) star as the primary', () => {
    const stars: BinaryStar[] = [
      makeStar({ x: 0, y: 0, z: 0, absmag: 6 }),       // dimmer
      makeStar({ x: 0.001, y: 0, z: 0, absmag: 4 }),   // brighter
    ];
    inferBinaries(stars);
    expect(stars[1].flags & 0x10).toBeTruthy(); // primary flag bit
    expect(stars[0].flags & 0x10).toBeFalsy();
  });

  it('does not pair stars that are further apart than BINARY_MAX_SEP_PC', () => {
    const stars: BinaryStar[] = [
      makeStar({ x: 0, y: 0, z: 0, absmag: 4 }),
      makeStar({ x: BINARY_MAX_SEP_PC * 2, y: 0, z: 0, absmag: 6 }),
    ];
    const stats = inferBinaries(stars);
    expect(stats.pairs).toBe(0);
    expect(stars[0].companionIdx).toBe(-1);
    expect(stars[1].companionIdx).toBe(-1);
  });

  it('ignores stars exactly at the cutoff (strict less-than)', () => {
    const stars: BinaryStar[] = [
      makeStar({ x: 0, y: 0, z: 0, absmag: 4 }),
      makeStar({ x: BINARY_MAX_SEP_PC, y: 0, z: 0, absmag: 6 }),
    ];
    inferBinaries(stars);
    expect(stars[0].companionIdx).toBe(-1);
  });

  it('picks the nearest neighbour when several are within range', () => {
    const stars: BinaryStar[] = [
      makeStar({ x: 0,      y: 0, z: 0, absmag: 4 }),
      makeStar({ x: 0.0008, y: 0, z: 0, absmag: 6 }),
      makeStar({ x: 0.003,  y: 0, z: 0, absmag: 5 }),
    ];
    inferBinaries(stars);
    expect(stars[0].companionIdx).toBe(1); // nearest, not brightest
  });

  it('does not pair a star with itself', () => {
    const stars: BinaryStar[] = [
      makeStar({ x: 0, y: 0, z: 0, absmag: 4 }),
    ];
    const stats = inferBinaries(stars);
    expect(stats.pairs).toBe(0);
    expect(stars[0].companionIdx).toBe(-1);
  });

  it('handles a triple system by pairing each member with its nearest', () => {
    const stars: BinaryStar[] = [
      makeStar({ x: 0,      y: 0, z: 0, absmag: 4 }),    // A — brightest
      makeStar({ x: 0.001,  y: 0, z: 0, absmag: 5 }),    // B
      makeStar({ x: 0.0009, y: 0, z: 0, absmag: 6 }),    // C
    ];
    inferBinaries(stars);
    // Distances: A-B=0.001, A-C=0.0009, B-C=0.0001.
    //   A's nearest is C (0.0009). C's nearest is B (0.0001). B's nearest is C.
    expect(stars[0].companionIdx).toBe(2);
    expect(stars[1].companionIdx).toBe(2);
    expect(stars[2].companionIdx).toBe(1);
  });

  it('returns zero counts for an empty input', () => {
    expect(inferBinaries([])).toEqual({ pairs: 0, primaries: 0 });
  });

  it('uses 3D distance, not 2D', () => {
    // Two stars separated only along z; would be 0 in xy projection.
    const stars: BinaryStar[] = [
      makeStar({ x: 0, y: 0, z: 0,     absmag: 4 }),
      makeStar({ x: 0, y: 0, z: 0.001, absmag: 6 }),
    ];
    inferBinaries(stars);
    expect(stars[0].companionIdx).toBe(1);
  });
});
