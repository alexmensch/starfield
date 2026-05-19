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
  FLAGS,
  RESERVED_FLAG_BITS,
  HEADER_LAYOUT,
  RECORD_LAYOUT,
  HEADER_FIELD_SIZES,
  RECORD_FIELD_SIZES,
  HEADER_SIZE,
  RECORD_SIZE,
  NAME_TABLE_PADDING,
  NAME_LENGTH_PREFIX_BYTES,
  type SpectralInfo,
  type BinaryStar,
  type DoublesStar,
  parseBailerJonesTsv,
  icrsSphericalToCartesian,
  apparentToAbsoluteMagnitude,
  applyBailerJonesOverride,
  isBailerJonesEligible,
  BJ_ELIGIBLE_DIST_SRCS,
  DIST_SRC_BAILER_JONES,
  applyLmcKinematicOverride,
  angularSeparationDeg,
  DIST_SRC_LMC_KIN,
  LMC_DISTANCE_PC,
  LMC_CENTRE_RA_HOURS,
  LMC_CENTRE_DEC_DEG,
  LMC_CONE_HALF_ANGLE_DEG,
  LMC_PM_RA_CENTRE,
  LMC_PM_DEC_CENTRE,
  LMC_PM_TOLERANCE,
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
    const fields = Object.entries(HEADER_LAYOUT) as [keyof typeof HEADER_LAYOUT, number][];
    for (const [name, off] of fields) {
      expect(HEADER_FIELD_SIZES[name]).toBeDefined();
      expect(off + HEADER_FIELD_SIZES[name]).toBeLessThanOrEqual(HEADER_SIZE);
    }
    // Pairwise non-overlap.
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const [na, oa] = fields[i];
        const [nb, ob] = fields[j];
        const ea = oa + HEADER_FIELD_SIZES[na];
        const eb = ob + HEADER_FIELD_SIZES[nb];
        const overlap = oa < eb && ob < ea;
        expect(overlap, `${na}@${oa}+${HEADER_FIELD_SIZES[na]} overlaps ${nb}@${ob}+${HEADER_FIELD_SIZES[nb]}`).toBe(false);
      }
    }
  });

  it('record offsets are non-overlapping and fit within RECORD_SIZE', () => {
    const fields = Object.entries(RECORD_LAYOUT) as [keyof typeof RECORD_LAYOUT, number][];
    for (const [name, off] of fields) {
      expect(RECORD_FIELD_SIZES[name]).toBeDefined();
      expect(off + RECORD_FIELD_SIZES[name]).toBeLessThanOrEqual(RECORD_SIZE);
    }
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const [na, oa] = fields[i];
        const [nb, ob] = fields[j];
        const ea = oa + RECORD_FIELD_SIZES[na];
        const eb = ob + RECORD_FIELD_SIZES[nb];
        const overlap = oa < eb && ob < ea;
        expect(overlap, `${na}@${oa}+${RECORD_FIELD_SIZES[na]} overlaps ${nb}@${ob}+${RECORD_FIELD_SIZES[nb]}`).toBe(false);
      }
    }
  });

  it('layout and size maps cover identical key sets', () => {
    expect(Object.keys(HEADER_FIELD_SIZES).sort()).toEqual(Object.keys(HEADER_LAYOUT).sort());
    expect(Object.keys(RECORD_FIELD_SIZES).sort()).toEqual(Object.keys(RECORD_LAYOUT).sort());
  });

  it('record fields cover the v4 byte plan (one byte 37 reserved)', () => {
    // hip is the last field; with its 4 bytes the record fills exactly
    // RECORD_SIZE except for byte 37 (reserved for future variability type).
    expect(RECORD_LAYOUT.hip + 4).toBe(RECORD_SIZE);
    // Reserved byte 37 sits between ampUnits (36) and period (38).
    expect(RECORD_LAYOUT.ampUnits + 1).toBe(37);
    expect(RECORD_LAYOUT.period).toBe(38);
  });

  it('FLAGS registry entries are distinct single-bit values', () => {
    const values = Object.values(FLAGS);
    for (const f of values) {
      expect(f).toBeGreaterThan(0);
      expect(f & (f - 1)).toBe(0); // single-bit
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it('FLAG_* aliases match the FLAGS registry', () => {
    expect(FLAG_HAS_NAME).toBe(FLAGS.hasName);
    expect(FLAG_IS_SOL).toBe(FLAGS.isSol);
    expect(FLAG_HAS_BAYER).toBe(FLAGS.hasBayer);
    expect(FLAG_BINARY_PRIMARY).toBe(FLAGS.binaryPrimary);
  });

  it('RESERVED_FLAG_BITS does not collide with any registered FLAGS value', () => {
    for (const v of Object.values(FLAGS)) {
      expect(v & RESERVED_FLAG_BITS, `FLAGS value 0x${v.toString(16)} collides with RESERVED_FLAG_BITS`).toBe(0);
    }
  });

  it('reserved + used flag bits stay within the uint8 envelope', () => {
    const used = Object.values(FLAGS).reduce((acc, v) => acc | v, 0);
    expect((used | RESERVED_FLAG_BITS) & ~0xff).toBe(0);
  });

  it('name-table layout is two zero padding bytes + (uint16 len, utf-8 bytes) entries', () => {
    expect(NAME_TABLE_PADDING).toBe(2);
    expect(NAME_LENGTH_PREFIX_BYTES).toBe(2);
    // Round-trip a writer-shaped table inline and verify the reader's
    // pointer-walk lands on the right names. Pins the contract without
    // depending on build-catalog.ts or catalog-loader.ts.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8');
    const names = ['Sol', 'α Cen', '日本']; // ascii + 2-byte + 3-byte UTF-8
    const chunks: Uint8Array[] = [new Uint8Array(NAME_TABLE_PADDING)];
    let len = NAME_TABLE_PADDING;
    const expectedOffsets: number[] = [];
    for (const n of names) {
      const bytes = encoder.encode(n);
      expectedOffsets.push(len);
      const lenHeader = new Uint8Array(NAME_LENGTH_PREFIX_BYTES);
      new DataView(lenHeader.buffer).setUint16(0, bytes.length, true);
      chunks.push(lenHeader);
      chunks.push(bytes);
      len += NAME_LENGTH_PREFIX_BYTES + bytes.length;
    }
    const table = new Uint8Array(len);
    let p = 0;
    for (const c of chunks) { table.set(c, p); p += c.length; }
    // Sentinel padding is zero.
    for (let i = 0; i < NAME_TABLE_PADDING; i++) expect(table[i]).toBe(0);
    // Reader walk.
    const view = new DataView(table.buffer);
    let q = NAME_TABLE_PADDING;
    const recovered: { offset: number; name: string }[] = [];
    while (q < len) {
      const byteLen = view.getUint16(q, true);
      const offset = q;
      q += NAME_LENGTH_PREFIX_BYTES;
      recovered.push({ offset, name: decoder.decode(table.subarray(q, q + byteLen)) });
      q += byteLen;
    }
    expect(recovered.map((r) => r.name)).toEqual(names);
    expect(recovered.map((r) => r.offset)).toEqual(expectedOffsets);
  });
});

// ─── Bailer-Jones (DR3) distance override ──────────────────────────────

describe('catalog-pure / parseBailerJonesTsv', () => {
  it('parses source_id as string and prefers r_med_photogeo', () => {
    const tsv =
      'source_id\tr_med_geo\tr_lo_geo\tr_hi_geo\tr_med_photogeo\tr_lo_photogeo\tr_hi_photogeo\tflag\n' +
      '204531088580182016\t6366.668\t6300\t6420\t6244.791\t6200\t6280\t10033\n' +
      '4773096563064098432\t93.528\t92\t94\t92.871\t92\t93\t10023\n';
    const map = parseBailerJonesTsv(tsv);
    expect(map.size).toBe(2);
    expect(map.get('204531088580182016')).toBe(6244.791);
    expect(map.get('4773096563064098432')).toBe(92.871);
  });

  it('falls back to r_med_geo when r_med_photogeo is empty', () => {
    const tsv =
      'source_id\tr_med_geo\tr_lo_geo\tr_hi_geo\tr_med_photogeo\tr_lo_photogeo\tr_hi_photogeo\tflag\n' +
      '123\t250.0\t245\t255\t\t\t\t33333\n';
    const map = parseBailerJonesTsv(tsv);
    expect(map.get('123')).toBe(250.0);
  });

  it('throws on missing required columns', () => {
    expect(() => parseBailerJonesTsv('source_id\tr_med_geo\n1\t10\n'))
      .toThrow(/r_med_photogeo/);
  });

  it('skips rows with non-positive distance and blank source_ids', () => {
    const tsv =
      'source_id\tr_med_geo\tr_lo_geo\tr_hi_geo\tr_med_photogeo\tr_lo_photogeo\tr_hi_photogeo\tflag\n' +
      '\t10\t9\t11\t10\t9\t11\t1\n' +
      '999\t-1\t-1\t-1\t\t\t\t1\n' +
      '111\t100\t99\t101\t99\t98\t100\t1\n';
    const map = parseBailerJonesTsv(tsv);
    expect(map.size).toBe(1);
    expect(map.get('111')).toBe(99);
  });
});

describe('catalog-pure / icrsSphericalToCartesian', () => {
  it('maps the cardinal RA/Dec triples to expected axes', () => {
    // ra=0h dec=0° → +X
    const a = icrsSphericalToCartesian(0, 0, 100);
    expect(a.x).toBeCloseTo(100, 10);
    expect(a.y).toBeCloseTo(0, 10);
    expect(a.z).toBeCloseTo(0, 10);
    // ra=6h dec=0° → +Y
    const b = icrsSphericalToCartesian(6, 0, 100);
    expect(b.x).toBeCloseTo(0, 10);
    expect(b.y).toBeCloseTo(100, 10);
    expect(b.z).toBeCloseTo(0, 10);
    // dec=+90° → +Z (RA irrelevant)
    const c = icrsSphericalToCartesian(0, 90, 100);
    expect(c.x).toBeCloseTo(0, 10);
    expect(c.y).toBeCloseTo(0, 10);
    expect(c.z).toBeCloseTo(100, 10);
  });

  it('matches AT-HYG x0/y0/z0 for a representative star (HIP 22365)', () => {
    // AT-HYG row: ra=4.81481859 h, dec=43.27557981°, dist=9963.4514 pc,
    // x0=2214.84, y0=6907.647, z0=6830.027.
    const { x, y, z } = icrsSphericalToCartesian(4.81481859, 43.27557981, 9963.4514);
    expect(x).toBeCloseTo(2214.84, 1);
    expect(y).toBeCloseTo(6907.647, 1);
    expect(z).toBeCloseTo(6830.027, 1);
    expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(9963.4514, 3);
  });
});

describe('catalog-pure / apparentToAbsoluteMagnitude', () => {
  it('is identity at 10 pc', () => {
    expect(apparentToAbsoluteMagnitude(5.0, 10)).toBe(5.0);
  });

  it('M = m − 5·log₁₀(d/10)', () => {
    // 100 pc is 5 magnitudes dimmer than 10 pc.
    expect(apparentToAbsoluteMagnitude(15, 100)).toBeCloseTo(10, 10);
    // 1000 pc is 10 magnitudes dimmer than 10 pc.
    expect(apparentToAbsoluteMagnitude(20, 1000)).toBeCloseTo(10, 10);
  });
});

describe('catalog-pure / applyBailerJonesOverride', () => {
  // Tier-A fixtures: real AT-HYG + Bailer-Jones DR3 values for stars
  // documented in stellata-dch.47 / dch.46 — the four catastrophic
  // parallax-inversion supergiants and a well-measured F-dwarf control.
  // Numbers pin the override outcome: drift here means the override
  // changed semantics or the upstream catalogues drifted.
  interface Fixture {
    label: string;
    ra: number; dec: number; mag: number; sourceId: string;
    athygDist: number;       // AT-HYG dist (pre-override)
    bjDist: number;          // r_med_photogeo from data/bailer-jones-dr3.tsv
  }
  const FIVE_HIPS: Fixture[] = [
    { label: 'HIP 22365', ra: 4.81481859, dec:  43.27557981, mag:  7.7,  sourceId: '204531088580182016', athygDist:  9963.4514, bjDist: 6244.791 },
    { label: 'HIP 25733', ra: 5.49517982, dec:  35.37501942, mag:  6.78, sourceId: '183255985260080896', athygDist: 14326.6476, bjDist: 5466.246 },
    { label: 'HIP 38430', ra: 7.87230124, dec: -26.42963691, mag:  9.19, sourceId: '5602025904044961536', athygDist: 12658.2278, bjDist: 6215.232 },
    { label: 'HIP 46144', ra: 9.41038175, dec:  62.43823034, mag: 10.14, sourceId: '1040043514891491968', athygDist:  9189.7878, bjDist: 7515.496 },
    { label: 'HIP 23785', ra: 5.11164486, dec: -50.94139857, mag:  8.39, sourceId: '4773096563064098432', athygDist:    93.1801, bjDist:   92.871 },
  ];
  const bjMap = new Map(FIVE_HIPS.map((f) => [f.sourceId, f.bjDist] as const));

  it('returns null when source_id is missing or absent from the map', () => {
    expect(applyBailerJonesOverride(0, 0, 10, null, bjMap)).toBeNull();
    expect(applyBailerJonesOverride(0, 0, 10, '', bjMap)).toBeNull();
    expect(applyBailerJonesOverride(0, 0, 10, '0000', bjMap)).toBeNull();
  });

  it('pins the BJ distance and recomputes x/y/z + absmag consistently', () => {
    for (const f of FIVE_HIPS) {
      const out = applyBailerJonesOverride(f.ra, f.dec, f.mag, f.sourceId, bjMap);
      expect(out, f.label).not.toBeNull();
      expect(out!.dist, f.label).toBe(f.bjDist);
      // Position vector matches the new distance.
      expect(Math.sqrt(out!.x ** 2 + out!.y ** 2 + out!.z ** 2)).toBeCloseTo(f.bjDist, 3);
      // Absolute magnitude follows m − 5·log₁₀(d/10).
      expect(out!.absmag).toBeCloseTo(f.mag - 5 * Math.log10(f.bjDist / 10), 10);
    }
  });

  it('pulls the three highest-S/N supergiants back by 37%-62%', () => {
    // HIP 22365 / 25733 / 38430 are the showcase catastrophic-parallax
    // pullbacks (37%, 62%, 51%). HIP 46144 is the fourth flagged outlier
    // but only drops 18% — the test caps at three for the ≥25% headline,
    // and HIP 46144's pullback is asserted separately below.
    for (const label of ['HIP 22365', 'HIP 25733', 'HIP 38430']) {
      const f = FIVE_HIPS.find((x) => x.label === label)!;
      const out = applyBailerJonesOverride(f.ra, f.dec, f.mag, f.sourceId, bjMap)!;
      const drop = (f.athygDist - out.dist) / f.athygDist;
      expect(drop, `${label} drop ratio`).toBeGreaterThan(0.25);
    }
  });

  it('HIP 46144 pulls back ~18% (lower-S/N outlier)', () => {
    const f = FIVE_HIPS.find((x) => x.label === 'HIP 46144')!;
    const out = applyBailerJonesOverride(f.ra, f.dec, f.mag, f.sourceId, bjMap)!;
    const drop = (f.athygDist - out.dist) / f.athygDist;
    expect(drop).toBeGreaterThan(0.15);
    expect(drop).toBeLessThan(0.20);
  });

  it('leaves the well-measured F-dwarf HIP 23785 within 5%', () => {
    const f = FIVE_HIPS.find((x) => x.label === 'HIP 23785')!;
    const out = applyBailerJonesOverride(f.ra, f.dec, f.mag, f.sourceId, bjMap)!;
    expect(Math.abs(f.athygDist - out.dist) / f.athygDist).toBeLessThan(0.05);
  });

  it('DIST_SRC_BAILER_JONES tag is "BJ" (distinct from AT-HYG namespace)', () => {
    expect(DIST_SRC_BAILER_JONES).toBe('BJ');
    expect(['G_R3', 'G_R2', 'HIP', 'GJ', 'N', 'OTHER']).not.toContain(DIST_SRC_BAILER_JONES);
  });
});

describe('catalog-pure / isBailerJonesEligible', () => {
  it('admits only Gaia-inverse dist_src values when a source_id is present', () => {
    expect(isBailerJonesEligible('123', 'G_R3')).toBe(true);
    expect(isBailerJonesEligible('123', 'G_R2')).toBe(true);
    expect(isBailerJonesEligible('123', 'HIP')).toBe(false);
    expect(isBailerJonesEligible('123', 'GJ')).toBe(false);
    expect(isBailerJonesEligible('123', 'N')).toBe(false);
    expect(isBailerJonesEligible('123', 'OTHER')).toBe(false);
  });

  it('rejects rows without a Gaia source_id even if dist_src is Gaia-inverse', () => {
    expect(isBailerJonesEligible(null, 'G_R3')).toBe(false);
    expect(isBailerJonesEligible('', 'G_R3')).toBe(false);
  });

  it('rejects rows without a dist_src even if a source_id is present', () => {
    expect(isBailerJonesEligible('123', null)).toBe(false);
    expect(isBailerJonesEligible('123', '')).toBe(false);
  });

  it('BJ_ELIGIBLE_DIST_SRCS is exactly {G_R3, G_R2} — guards against namespace drift', () => {
    expect(BJ_ELIGIBLE_DIST_SRCS.size).toBe(2);
    expect(BJ_ELIGIBLE_DIST_SRCS.has('G_R3')).toBe(true);
    expect(BJ_ELIGIBLE_DIST_SRCS.has('G_R2')).toBe(true);
    expect(BJ_ELIGIBLE_DIST_SRCS.has('HIP')).toBe(false);
  });
});

describe('catalog-pure / angularSeparationDeg', () => {
  it('returns 0 for identical positions', () => {
    expect(angularSeparationDeg(5, -30, 5, -30)).toBeCloseTo(0, 10);
  });

  it('returns 90° between RA-axis pole and equator at RA=0', () => {
    expect(angularSeparationDeg(0, 90, 0, 0)).toBeCloseTo(90, 6);
  });

  it('returns ~90° for two equatorial points 6h apart', () => {
    expect(angularSeparationDeg(0, 0, 6, 0)).toBeCloseTo(90, 6);
  });

  it('matches a known LMC-direction great-circle distance', () => {
    // HD 268749 at (4.8915 h, -69.409°) → LMC centre (5.25067 h, -69.19°).
    // Compute by hand: small-angle approximation says ~2.5° separation;
    // exact vector form here is the canonical value.
    const sep = angularSeparationDeg(4.8915, -69.409, LMC_CENTRE_RA_HOURS, LMC_CENTRE_DEC_DEG);
    expect(sep).toBeGreaterThan(0.5);
    expect(sep).toBeLessThan(LMC_CONE_HALF_ANGLE_DEG);
  });
});

describe('catalog-pure / applyLmcKinematicOverride', () => {
  // Tier-A fixtures from AT-HYG / Gaia DR3 — three real LMC supergiants
  // (HDE 268xxx range), one halo-direction control, and one halo-PM
  // outlier inside the LMC cone. AT-HYG distances are the pre-override
  // values that get smeared 5-200 kpc by 1/π inversion.
  interface Fixture {
    label: string;
    ra: number; dec: number; mag: number;
    pmRa: number | null; pmDec: number | null;
    athygDist: number;
  }
  const LMC_HITS: Fixture[] = [
    { label: 'HD 268749 (B7 IAB LMC supergiant)', ra: 4.8915, dec: -69.409, mag: 12.029, pmRa: 2.044, pmDec: -0.096, athygDist: 13368.7 },
    { label: 'HD 268718',                         ra: 4.866, dec: -69.426, mag: 10.596, pmRa: 2.093, pmDec: -0.138, athygDist: 46323.4 },
    { label: 'HD 268654 (smeared to 196 kpc)',    ra: 4.820, dec: -69.457, mag: 10.5,   pmRa: 2.033, pmDec: -0.198, athygDist: 196078.4 },
  ];
  const LMC_PM_NON_HITS: Fixture[] = [
    // Inside the LMC cone but PM ≠ LMC bulk — a halo star or runaway,
    // should pass through unchanged.
    { label: 'HD 270752 (halo in LMC direction)', ra: 4.792, dec: -65.331, mag: 11.214, pmRa: 14.925, pmDec: -3.62, athygDist: 5298.5 },
  ];

  it('LMC-direction + LMC-PM star is snapped to 49.594 kpc', () => {
    for (const f of LMC_HITS) {
      const out = applyLmcKinematicOverride(f.ra, f.dec, f.mag, f.pmRa, f.pmDec);
      expect(out, f.label).not.toBeNull();
      expect(out!.dist, f.label).toBe(LMC_DISTANCE_PC);
      // Position vector length matches the override distance.
      expect(Math.sqrt(out!.x ** 2 + out!.y ** 2 + out!.z ** 2)).toBeCloseTo(LMC_DISTANCE_PC, 3);
      // Absolute magnitude recomputed at the new distance.
      expect(out!.absmag).toBeCloseTo(f.mag - 5 * Math.log10(LMC_DISTANCE_PC / 10), 10);
    }
  });

  it('LMC-direction + non-LMC-PM star is unchanged (null override)', () => {
    for (const f of LMC_PM_NON_HITS) {
      const out = applyLmcKinematicOverride(f.ra, f.dec, f.mag, f.pmRa, f.pmDec);
      expect(out, f.label).toBeNull();
    }
  });

  it('non-LMC-direction + LMC-like PM is unchanged (null override)', () => {
    // Solar Neighbourhood star with coincidentally LMC-like PM — fails
    // the cone test. Use (RA=12h, Dec=0°) — diametrically opposite the
    // LMC field — with the LMC bulk PM exactly.
    const out = applyLmcKinematicOverride(
      12, 0, 8, LMC_PM_RA_CENTRE, LMC_PM_DEC_CENTRE,
    );
    expect(out).toBeNull();
  });

  it('SMC-direction + SMC-like PM is unchanged (out of scope)', () => {
    // SMC centre ≈ (00h 52m 38s, −72.8°) = (0.877 h, −72.8°). SMC bulk
    // PM ≈ (+0.69, −1.23) — distinct enough from the LMC cone and PM
    // window that even passing SMC values should not trigger the LMC
    // override. Confirms the bead's "SMC out of scope" contract.
    const out = applyLmcKinematicOverride(0.877, -72.8, 10, 0.69, -1.23);
    expect(out).toBeNull();
  });

  it('returns null when pm_ra or pm_dec is missing', () => {
    // A star in the LMC cone with null proper motion — should NOT be
    // overridden. AT-HYG carries blank pm_ra/pm_dec for pre-Hipparcos
    // entries; treat them as ineligible for the kinematic gate.
    expect(applyLmcKinematicOverride(LMC_CENTRE_RA_HOURS, LMC_CENTRE_DEC_DEG, 10, null, 0)).toBeNull();
    expect(applyLmcKinematicOverride(LMC_CENTRE_RA_HOURS, LMC_CENTRE_DEC_DEG, 10, 0, null)).toBeNull();
  });

  it('ordering: LMC_KIN wins over BJ for an LMC-cone star with both', () => {
    // Synthetic LMC-cone + LMC-PM star with a B-J entry. Simulates the
    // build-catalog.ts ordering: B-J runs first and writes its posterior;
    // LMC_KIN runs after and clobbers it. Test by composing the two
    // overrides in the same order as the build script.
    const f = LMC_HITS[0]; // HD 268749
    const sourceId = 'fake-lmc-source-id';
    const bjMap = new Map([[sourceId, 8000]]); // arbitrary B-J posterior ≠ LMC distance
    const bj = applyBailerJonesOverride(f.ra, f.dec, f.mag, sourceId, bjMap);
    expect(bj!.dist).toBe(8000);
    const lmc = applyLmcKinematicOverride(f.ra, f.dec, f.mag, f.pmRa, f.pmDec);
    expect(lmc!.dist).toBe(LMC_DISTANCE_PC);
    // Final state mirrors what build-catalog.ts ends up with.
    expect(lmc!.dist).not.toBe(bj!.dist);
  });

  it('boundary: just inside the cone passes, just outside fails', () => {
    // A star inside the LMC cone half-angle minus epsilon, with LMC PM:
    // expect override. Same star pushed just outside the cone: expect
    // null. Confirms the cone gate is the half-angle, not something
    // tighter like a great-circle box.
    const epsilon = 0.01;
    const inDec = LMC_CENTRE_DEC_DEG + (LMC_CONE_HALF_ANGLE_DEG - epsilon);
    const outDec = LMC_CENTRE_DEC_DEG + (LMC_CONE_HALF_ANGLE_DEG + epsilon);
    const inOut = applyLmcKinematicOverride(LMC_CENTRE_RA_HOURS, inDec, 10, LMC_PM_RA_CENTRE, LMC_PM_DEC_CENTRE);
    expect(inOut).not.toBeNull();
    const outOut = applyLmcKinematicOverride(LMC_CENTRE_RA_HOURS, outDec, 10, LMC_PM_RA_CENTRE, LMC_PM_DEC_CENTRE);
    expect(outOut).toBeNull();
  });

  it('boundary: PM tolerance is per-component, not radial', () => {
    // |Δpm_ra| at the tolerance, |Δpm_dec| at 0 → pass. Mirror case → pass.
    // Both at the tolerance → still pass (per-component, not Euclidean).
    const eps = 1e-9;
    const passEdgeRa = applyLmcKinematicOverride(
      LMC_CENTRE_RA_HOURS, LMC_CENTRE_DEC_DEG, 10,
      LMC_PM_RA_CENTRE + LMC_PM_TOLERANCE - eps, LMC_PM_DEC_CENTRE,
    );
    expect(passEdgeRa).not.toBeNull();
    const passBothEdges = applyLmcKinematicOverride(
      LMC_CENTRE_RA_HOURS, LMC_CENTRE_DEC_DEG, 10,
      LMC_PM_RA_CENTRE + LMC_PM_TOLERANCE - eps, LMC_PM_DEC_CENTRE - LMC_PM_TOLERANCE + eps,
    );
    expect(passBothEdges).not.toBeNull();
    const failJustOver = applyLmcKinematicOverride(
      LMC_CENTRE_RA_HOURS, LMC_CENTRE_DEC_DEG, 10,
      LMC_PM_RA_CENTRE + LMC_PM_TOLERANCE + eps, LMC_PM_DEC_CENTRE,
    );
    expect(failJustOver).toBeNull();
  });

  it('DIST_SRC_LMC_KIN tag is "LMC_KIN" (distinct from BJ + AT-HYG namespace)', () => {
    expect(DIST_SRC_LMC_KIN).toBe('LMC_KIN');
    expect([
      'G_R3', 'G_R2', 'HIP', 'GJ', 'N', 'OTHER', DIST_SRC_BAILER_JONES,
    ]).not.toContain(DIST_SRC_LMC_KIN);
  });
});
