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
  markPrimary,
  markPrimaryIfUnflagged,
  applyDoublesFlag,
  BINARY_MAX_SEP_PC,
  FLAG_HAS_NAME,
  FLAG_IS_SOL,
  FLAG_HAS_BAYER,
  FLAG_BINARY_PRIMARY,
  HEADER_LAYOUT,
  RECORD_LAYOUT,
  HEADER_SIZE,
  RECORD_SIZE,
  type SpectralInfo,
  type BinaryStar,
  type DoublesStar,
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
    expect(stats.mutualPairs).toBe(1);
    expect(stars[0].companionIdx).toBe(1);
    expect(stars[1].companionIdx).toBe(0);
  });

  it('flags the brighter (lower absmag) star as the primary', () => {
    const stars: BinaryStar[] = [
      makeStar({ x: 0, y: 0, z: 0, absmag: 6 }),       // dimmer
      makeStar({ x: 0.001, y: 0, z: 0, absmag: 4 }),   // brighter
    ];
    inferBinaries(stars);
    expect(stars[1].flags & FLAG_BINARY_PRIMARY).toBeTruthy();
    expect(stars[0].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
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
    const stats = inferBinaries(stars);
    // Distances: A-B=0.001, A-C=0.0009, B-C=0.0001.
    //   A's nearest is C (0.0009). C's nearest is B (0.0001). B's nearest is C.
    // Only B↔C is mutual; A→C is one-way (C points back to B).
    expect(stars[0].companionIdx).toBe(2);
    expect(stars[1].companionIdx).toBe(2);
    expect(stars[2].companionIdx).toBe(1);
    expect(stats.mutualPairs).toBe(1);
    // Primary = brighter of mutual pair B↔C → B (absmag=5 < C's 6).
    expect(stars[1].flags & FLAG_BINARY_PRIMARY).toBeTruthy();
    // A is not part of any mutual pair, so it is NOT flagged primary
    // even though it is the brightest of the three.
    expect(stars[0].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
    expect(stars[2].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
  });

  it('does not flag stars in non-mutual chains as primary', () => {
    // 1D chain A-B-C-D where the inner B-C gap is the tightest, so
    // A→B and D→C (the outer stars point inward) but neither A nor D
    // is the nearest of anyone — they're chain ends. Only B↔C is
    // mutual.
    //   A=0, B=0.0030, C=0.0040, D=0.0070
    //   distances: A-B=0.0030, B-C=0.0010, C-D=0.0030,
    //              A-C=0.0040, A-D=0.0070 (above cutoff), B-D=0.0040.
    //   A→B (closer than C), B→C (0.0010 beats A's 0.0030),
    //   C→B (0.0010 beats D's 0.0030), D→C (closer than B).
    const stars: BinaryStar[] = [
      makeStar({ x: 0,      y: 0, z: 0, absmag: 3 }),
      makeStar({ x: 0.0030, y: 0, z: 0, absmag: 4 }),
      makeStar({ x: 0.0040, y: 0, z: 0, absmag: 5 }),
      makeStar({ x: 0.0070, y: 0, z: 0, absmag: 6 }),
    ];
    const stats = inferBinaries(stars);
    expect(stars[0].companionIdx).toBe(1);
    expect(stars[1].companionIdx).toBe(2);
    expect(stars[2].companionIdx).toBe(1);
    expect(stars[3].companionIdx).toBe(2);
    expect(stats.mutualPairs).toBe(1);
    // Primary = brighter of B↔C → B (absmag=4).
    expect(stars[1].flags & FLAG_BINARY_PRIMARY).toBeTruthy();
    expect(stars[0].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
    expect(stars[2].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
    expect(stars[3].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
  });

  it('flags one primary per mutual pair when there are several', () => {
    // Two well-separated mutual pairs.
    const stars: BinaryStar[] = [
      makeStar({ x: 0,         y: 0, z: 0, absmag: 4 }),  // pair 1
      makeStar({ x: 0.001,     y: 0, z: 0, absmag: 5 }),
      makeStar({ x: 100,       y: 0, z: 0, absmag: 3 }),  // pair 2 (brightest in catalog)
      makeStar({ x: 100.001,   y: 0, z: 0, absmag: 6 }),
    ];
    const stats = inferBinaries(stars);
    expect(stats.mutualPairs).toBe(2);
    expect(stars[0].flags & FLAG_BINARY_PRIMARY).toBeTruthy(); // pair 1 brighter
    expect(stars[1].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
    expect(stars[2].flags & FLAG_BINARY_PRIMARY).toBeTruthy(); // pair 2 brighter
    expect(stars[3].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
  });

  it('returns zero counts for an empty input', () => {
    expect(inferBinaries([])).toEqual({ pairs: 0, mutualPairs: 0 });
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

describe("catalog-pure / markPrimary", () => {
  type Slim = { absmag: number; flags: number };
  const star = (absmag: number, flags = 0): Slim => ({ absmag, flags });

  it("flags the brightest (lowest absmag) of a group", () => {
    const stars: Slim[] = [star(6), star(4), star(5)];
    expect(markPrimary(stars, [0, 1, 2])).toBe(1);
    expect(stars[1].flags & FLAG_BINARY_PRIMARY).toBeTruthy();
    expect(stars[0].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
    expect(stars[2].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
  });

  it("returns -1 for an empty group", () => {
    const stars: Slim[] = [star(4)];
    expect(markPrimary(stars, [])).toBe(-1);
    expect(stars[0].flags).toBe(0);
  });

  it("preserves pre-existing flag bits via OR", () => {
    const stars: Slim[] = [star(4, 0x01)];
    markPrimary(stars, [0]);
    expect(stars[0].flags & 0x01).toBeTruthy();
    expect(stars[0].flags & FLAG_BINARY_PRIMARY).toBeTruthy();
  });

  it("is idempotent under re-application to the same group", () => {
    const stars: Slim[] = [star(4), star(6)];
    markPrimary(stars, [0, 1]);
    const before = stars.map(s => s.flags);
    markPrimary(stars, [0, 1]);
    expect(stars.map(s => s.flags)).toEqual(before);
  });

  it("breaks ties on the first-encountered index", () => {
    // Both equally bright — the helper picks whichever it sees first
    // (matching the prior `i <= j ? i : j` behaviour for mutual pairs).
    const stars: Slim[] = [star(4), star(4)];
    expect(markPrimary(stars, [0, 1])).toBe(0);
  });
});

describe("catalog-pure / markPrimaryIfUnflagged", () => {
  type Slim = { absmag: number; flags: number };
  const star = (absmag: number, flags = 0): Slim => ({ absmag, flags });

  it("delegates to markPrimary when no member is pre-flagged", () => {
    const stars: Slim[] = [star(6), star(4), star(5)];
    expect(markPrimaryIfUnflagged(stars, [0, 1, 2])).toBe(1);
    expect(stars[1].flags & FLAG_BINARY_PRIMARY).toBeTruthy();
  });

  it("returns -2 (skip sentinel) when any member is already flagged", () => {
    // Geometric pass already picked stars[2] (e.g. mutual pair primary).
    // CCDM pass should not re-flag stars[0] even though it is brighter.
    const stars: Slim[] = [star(4), star(6), star(5, FLAG_BINARY_PRIMARY)];
    expect(markPrimaryIfUnflagged(stars, [0, 1, 2])).toBe(-2);
    expect(stars[0].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
    expect(stars[1].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
    expect(stars[2].flags & FLAG_BINARY_PRIMARY).toBeTruthy();
  });

  it("returns -1 for an empty group", () => {
    const stars: Slim[] = [star(4)];
    expect(markPrimaryIfUnflagged(stars, [])).toBe(-1);
  });

  it("is idempotent: a group whose primary it just flagged returns -2 next time", () => {
    const stars: Slim[] = [star(4), star(6)];
    expect(markPrimaryIfUnflagged(stars, [0, 1])).toBe(0);
    expect(markPrimaryIfUnflagged(stars, [0, 1])).toBe(-2);
  });

  it("does not flag any star when bailing on the pre-flagged check", () => {
    const stars: Slim[] = [star(4), star(6, FLAG_BINARY_PRIMARY)];
    markPrimaryIfUnflagged(stars, [0, 1]);
    // stars[0] was brighter but must remain unflagged because stars[1]
    // already carried the bit.
    expect(stars[0].flags).toBe(0);
  });
});

describe('catalog-pure / applyDoublesFlag', () => {
  // Mini Star fixture with just the fields applyDoublesFlag reads/writes.
  function s(absmag: number, hip: number | null, flags = 0): DoublesStar {
    return { absmag, hip, flags };
  }

  it('flags the brightest in-catalog member of each group', () => {
    // Three stars; the group covers them all. Lowest absmag (=brightest)
    // should get FLAG_BINARY_PRIMARY; the others stay clean.
    const stars: DoublesStar[] = [s(4, 100), s(2, 200), s(6, 300)];
    const r = applyDoublesFlag(stars, [[100, 200, 300]]);
    expect(r.systems).toBe(1);
    expect(r.flagged).toBe(1);
    expect(stars[1].flags).toBe(FLAG_BINARY_PRIMARY);
    expect(stars[0].flags).toBe(0);
    expect(stars[2].flags).toBe(0);
  });

  it('silently drops groups whose HIPs are all missing from the catalog', () => {
    const stars: DoublesStar[] = [s(4, 100), s(5, 200)];
    const r = applyDoublesFlag(stars, [[999, 1000]]);
    expect(r.systems).toBe(0);
    expect(r.flagged).toBe(0);
    expect(stars[0].flags).toBe(0);
    expect(stars[1].flags).toBe(0);
  });

  it('counts a system but does not re-flag when a member already has the bit', () => {
    // Geometric pass already flagged the dimmer star; CCDM pass would
    // pick the brighter one but must defer per markPrimaryIfUnflagged's
    // contract.
    const stars: DoublesStar[] = [s(2, 100), s(5, 200, FLAG_BINARY_PRIMARY)];
    const r = applyDoublesFlag(stars, [[100, 200]]);
    expect(r.systems).toBe(1);
    expect(r.flagged).toBe(0);
    expect(stars[0].flags).toBe(0);                    // not re-flagged
    expect(stars[1].flags).toBe(FLAG_BINARY_PRIMARY);  // pre-existing bit preserved
  });

  it('flags one primary per group across multiple groups', () => {
    const stars: DoublesStar[] = [
      s(2, 100), s(3, 101), // group A — 100 brightest
      s(5, 200), s(4, 201), // group B — 201 brightest
    ];
    const r = applyDoublesFlag(stars, [[100, 101], [200, 201]]);
    expect(r.systems).toBe(2);
    expect(r.flagged).toBe(2);
    expect(stars[0].flags).toBe(FLAG_BINARY_PRIMARY); // 100 won group A
    expect(stars[3].flags).toBe(FLAG_BINARY_PRIMARY); // 201 won group B
    expect(stars[1].flags).toBe(0);
    expect(stars[2].flags).toBe(0);
  });

  it('handles override-style groups (curated visual doubles) the same as CCDM groups', () => {
    // The build-catalog wrapper unions CCDM-from-file groups and the
    // KNOWN_VISUAL_DOUBLES list before calling this; here we verify both
    // sources behave identically once unioned.
    const stars: DoublesStar[] = [s(3, 100), s(2, 101)];
    // Pretend the CCDM pass produced one group, the override another.
    const r = applyDoublesFlag(stars, [[100], [101]]);
    expect(r.systems).toBe(2);
    expect(r.flagged).toBe(2);
    // Each single-member group flags its own brightest (and only)
    // component.
    expect(stars[0].flags).toBe(FLAG_BINARY_PRIMARY);
    expect(stars[1].flags).toBe(FLAG_BINARY_PRIMARY);
  });

  it('skips HIP=0 / null records when building the lookup', () => {
    const stars: DoublesStar[] = [s(2, null), s(4, 0), s(3, 100)];
    const r = applyDoublesFlag(stars, [[100]]);
    expect(r.systems).toBe(1);
    expect(stars[2].flags).toBe(FLAG_BINARY_PRIMARY);
    // The 0/null-HIP rows must never be hit by HIP→index lookup.
    expect(stars[0].flags).toBe(0);
    expect(stars[1].flags).toBe(0);
  });

  it('is idempotent under re-application', () => {
    const stars: DoublesStar[] = [s(2, 100), s(5, 200)];
    applyDoublesFlag(stars, [[100, 200]]);
    const flagsBefore = stars.map((x) => x.flags);
    applyDoublesFlag(stars, [[100, 200]]);
    // Second pass sees the existing primary bit and bails — no
    // additional bits set.
    expect(stars.map((x) => x.flags)).toEqual(flagsBefore);
  });
});

// Pin the v4 byte layout. The writer (build-catalog.ts) and the readers
// (catalog-loader.ts, verify-catalog.ts) all index off these constants;
// drift between the two would silently produce a corrupt binary, so the
// constants themselves get the regression coverage.
describe('catalog-pure / binary-format constants', () => {
  it('header offsets are non-overlapping uint32 slots within HEADER_SIZE', () => {
    const fields = Object.entries(HEADER_LAYOUT);
    // First field is `magic` (4 ASCII bytes), the rest are uint32s.
    const sizes: Record<string, number> = {
      magic: 4, version: 4, count: 4, nameTableOffset: 4, nameTableLength: 4,
    };
    for (const [name, off] of fields) {
      expect(sizes[name]).toBeDefined();
      expect(off + sizes[name]).toBeLessThanOrEqual(HEADER_SIZE);
    }
    // Pairwise non-overlap.
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const [na, oa] = fields[i];
        const [nb, ob] = fields[j];
        const ea = oa + sizes[na];
        const eb = ob + sizes[nb];
        const overlap = oa < eb && ob < ea;
        expect(overlap, `${na}@${oa}+${sizes[na]} overlaps ${nb}@${ob}+${sizes[nb]}`).toBe(false);
      }
    }
  });

  it('record offsets are non-overlapping and fit within RECORD_SIZE', () => {
    const sizes: Record<string, number> = {
      x: 4, y: 4, z: 4, absmag: 4, ci: 4, physRadius: 4,
      companion: 4, nameOffset: 4,
      spectClass: 1, lumClass: 1, conIndex: 1, flags: 1, ampUnits: 1,
      period: 2, hip: 4,
    };
    const fields = Object.entries(RECORD_LAYOUT);
    for (const [name, off] of fields) {
      expect(sizes[name]).toBeDefined();
      expect(off + sizes[name]).toBeLessThanOrEqual(RECORD_SIZE);
    }
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const [na, oa] = fields[i];
        const [nb, ob] = fields[j];
        const ea = oa + sizes[na];
        const eb = ob + sizes[nb];
        const overlap = oa < eb && ob < ea;
        expect(overlap, `${na}@${oa}+${sizes[na]} overlaps ${nb}@${ob}+${sizes[nb]}`).toBe(false);
      }
    }
  });

  it('record fields cover the v4 byte plan (one byte 37 reserved)', () => {
    // hip is the last field; with its 4 bytes the record fills exactly
    // RECORD_SIZE except for byte 37 (reserved for future variability type).
    expect(RECORD_LAYOUT.hip + 4).toBe(RECORD_SIZE);
    // Reserved byte 37 sits between ampUnits (36) and period (38).
    expect(RECORD_LAYOUT.ampUnits + 1).toBe(37);
    expect(RECORD_LAYOUT.period).toBe(38);
  });

  it('flag bits are distinct powers of two', () => {
    const flags = [FLAG_HAS_NAME, FLAG_IS_SOL, FLAG_HAS_BAYER, FLAG_BINARY_PRIMARY];
    for (const f of flags) {
      expect(f).toBeGreaterThan(0);
      expect((f & (f - 1))).toBe(0); // single-bit
    }
    expect(new Set(flags).size).toBe(flags.length);
  });
});
