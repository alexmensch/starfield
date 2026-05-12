import { describe, it, expect, vi } from 'vitest';
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
  applyMultipleOverridesPure,
  buildOrbitalElementsTable,
  readOrbitalElements,
  BINARY_MAX_SEP_PC,
  MIN_RENDER_SEPARATION_PC,
  FLAG_HAS_NAME,
  FLAG_IS_SOL,
  FLAG_HAS_BAYER,
  FLAG_BINARY_PRIMARY,
  FLAG_BINARY_SECONDARY,
  FLAGS,
  RESERVED_FLAG_BITS,
  HEADER_LAYOUT,
  RECORD_LAYOUT,
  ORBITAL_LAYOUT,
  HEADER_FIELD_SIZES,
  RECORD_FIELD_SIZES,
  ORBITAL_FIELD_SIZES,
  HEADER_SIZE,
  RECORD_SIZE,
  ORBITAL_RECORD_SIZE,
  MAGIC,
  BINARY_VERSION,
  NAME_TABLE_PADDING,
  NAME_LENGTH_PREFIX_BYTES,
  type SpectralInfo,
  type BinaryStar,
  type DoublesStar,
  type MultipleOverrideRow,
  type OverridableStar,
  type OrbitalElements,
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
    expect(inferBinaries([])).toEqual({ pairs: 0, mutualPairs: 0, droppedSubThreshold: 0 });
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

  it('drops the fainter of a sub-threshold mutual pair when neither is protected', () => {
    // Two unprotected stars at ~0.5 AU separation (well below
    // MIN_RENDER_SEPARATION_PC = 1 AU). Safety net should drop the
    // fainter (idx 1, absmag=6) and not flag either as a binary primary.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stars: BinaryStar[] = [
        makeStar({ x: 0, y: 0, z: 0, absmag: 4, hip: 100 }),
        makeStar({ x: MIN_RENDER_SEPARATION_PC / 2, y: 0, z: 0, absmag: 6, hip: 200 }),
      ];
      const stats = inferBinaries(stars);
      expect(stats.droppedSubThreshold).toBe(1);
      expect(stats.mutualPairs).toBe(0);
      expect(stars.length).toBe(1);
      expect(stars[0].hip).toBe(100);
      expect(stars[0].flags & FLAG_BINARY_PRIMARY).toBeFalsy();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/HIP 200/);
      expect(warn.mock.calls[0][0]).toMatch(/HIP 100/);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a sub-threshold pair when either component is in protectedIndices', () => {
    // Same fixture, but one star is protected (came from the multiples
    // pipeline — its position is curated, not a collapsed-parallax
    // artefact). Safety net must not fire.
    const stars: BinaryStar[] = [
      makeStar({ x: 0, y: 0, z: 0, absmag: 4, hip: 100 }),
      makeStar({ x: MIN_RENDER_SEPARATION_PC / 2, y: 0, z: 0, absmag: 6, hip: 200 }),
    ];
    const stats = inferBinaries(stars, new Set([0]));
    expect(stats.droppedSubThreshold).toBe(0);
    expect(stats.mutualPairs).toBe(1);
    expect(stars.length).toBe(2);
    // Brighter (lower absmag) gets the primary bit.
    expect(stars[0].flags & FLAG_BINARY_PRIMARY).toBeTruthy();
  });

  it('leaves above-threshold mutual pairs untouched by the sub-threshold drop', () => {
    // Separation = 0.001 pc ≫ MIN_RENDER_SEPARATION_PC. Existing
    // behaviour: both flagged as a mutual pair, brighter is primary, no
    // drops.
    const stars: BinaryStar[] = [
      makeStar({ x: 0,     y: 0, z: 0, absmag: 4, hip: 100 }),
      makeStar({ x: 0.001, y: 0, z: 0, absmag: 6, hip: 200 }),
    ];
    const stats = inferBinaries(stars);
    expect(stats.droppedSubThreshold).toBe(0);
    expect(stats.mutualPairs).toBe(1);
    expect(stars.length).toBe(2);
  });

  it('rewrites companionIdx of survivors that pointed at a dropped slot', () => {
    // Three stars: A and B at exactly the same point (sub-threshold), C
    // far enough to pair with the brighter survivor. After A↔B is
    // resolved (B dropped), C's companionIdx must still point to a
    // valid index (A's slot, shifted to 0).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stars: BinaryStar[] = [
        makeStar({ x: 0,                            y: 0, z: 0, absmag: 4, hip: 100 }),
        makeStar({ x: MIN_RENDER_SEPARATION_PC / 4, y: 0, z: 0, absmag: 7, hip: 200 }),
        makeStar({ x: 0.002,                        y: 0, z: 0, absmag: 5, hip: 300 }),
      ];
      const stats = inferBinaries(stars);
      expect(stats.droppedSubThreshold).toBe(1);
      expect(stars.length).toBe(2);
      // No survivor's companionIdx may reference a slot past the new
      // array length (or a stale higher index).
      for (const s of stars) {
        expect(s.companionIdx).toBeLessThan(stars.length);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe('catalog-pure / applyMultipleOverridesPure', () => {
  function star(opts: Partial<OverridableStar> & { hip: number | null }): OverridableStar {
    return {
      x: 0, y: 0, z: 0,
      absmag: 5, ci: 0.5,
      spectClass: 8, lumClass: 255,
      physicalRadius: 1,
      flags: 0,
      proper: null,
      spectDisplay: null,
      fromOverride: false,
      orbitId: null, orbitRole: null, orbit: null,
      ...opts,
    };
  }

  function row(opts: Partial<MultipleOverrideRow> & { hipOrSyn: string }): MultipleOverrideRow {
    return {
      systemId: 'TEST', comp: 'A',
      x: 0, y: 0, z: 0,
      absmag: 5, ci: 0.5,
      spect: 'G2V', name: '', source: 'test', regime: 1,
      orbitId: null, orbitRole: null, orbit: null,
      ...opts,
    };
  }

  function makeSyn(r: MultipleOverrideRow): OverridableStar {
    const info = parseSpectral(r.spect);
    return {
      x: r.x, y: r.y, z: r.z,
      absmag: r.absmag, ci: r.ci,
      spectClass: info.classIdx, lumClass: info.lumClass,
      physicalRadius: physicalRadius(r.absmag, info),
      flags: r.name ? FLAG_HAS_NAME : 0,
      proper: r.name || null,
      hip: null,
      spectDisplay: r.spect,
      fromOverride: false,
      orbitId: null, orbitRole: null, orbit: null,
    };
  }

  it('rewrites position, photometry, and spectrum on a matched HIP row', () => {
    const stars = [star({ hip: 32349, x: -0.49, y: 2.47, z: -0.76, absmag: 1.4, ci: 0.0, spectClass: 2 })];
    const stats = applyMultipleOverridesPure(
      stars,
      [row({ hipOrSyn: '32349', x: -0.494, y: 2.477, z: -0.758, absmag: 1.454, ci: 0.009, spect: 'A0m...' })],
      makeSyn,
    );
    expect(stats.hipOverridden).toBe(1);
    expect(stats.synInjected).toBe(0);
    expect(stars[0].x).toBe(-0.494);
    expect(stars[0].y).toBe(2.477);
    expect(stars[0].z).toBe(-0.758);
    expect(stars[0].absmag).toBe(1.454);
    expect(stars[0].ci).toBe(0.009);
    expect(stars[0].spectClass).toBe(parseSpectral('A0m...').classIdx);
    expect(stars[0].fromOverride).toBe(true);
  });

  it('recomputes physicalRadius from the new spectrum and absmag', () => {
    // Override changes a fictional cool dwarf into a hot O-class — the
    // recomputed radius must reflect the new spectral inputs, not the
    // pre-override values.
    const stars = [star({ hip: 1, absmag: 10, physicalRadius: 0.2 })];
    applyMultipleOverridesPure(
      stars,
      [row({ hipOrSyn: '1', absmag: -5, spect: 'O5V' })],
      makeSyn,
    );
    const expected = physicalRadius(-5, parseSpectral('O5V'));
    expect(stars[0].physicalRadius).toBe(expected);
    expect(stars[0].physicalRadius).toBeGreaterThan(1);
  });

  it('only overwrites the proper name when the override name is non-empty', () => {
    // Blank-name rows (the common case from build-binaries.py for HIP
    // primaries) must not clobber the AT-HYG proper name.
    const stars = [star({ hip: 1, proper: 'PreservedName', flags: FLAG_HAS_NAME })];
    applyMultipleOverridesPure(stars, [row({ hipOrSyn: '1', name: '' })], makeSyn);
    expect(stars[0].proper).toBe('PreservedName');
    expect(stars[0].flags & FLAG_HAS_NAME).toBeTruthy();
  });

  it('overwrites name and sets FLAG_HAS_NAME when the override name is non-empty', () => {
    const stars = [star({ hip: 1, proper: null, flags: 0 })];
    applyMultipleOverridesPure(stars, [row({ hipOrSyn: '1', name: 'Newly Named' })], makeSyn);
    expect(stars[0].proper).toBe('Newly Named');
    expect(stars[0].flags & FLAG_HAS_NAME).toBeTruthy();
  });

  it('counts hipMissing and continues for HIPs absent from the catalog', () => {
    const stars = [star({ hip: 1 })];
    const stats = applyMultipleOverridesPure(
      stars,
      [row({ hipOrSyn: '999' })],
      makeSyn,
    );
    expect(stats.hipOverridden).toBe(0);
    expect(stats.hipMissing).toBe(1);
    expect(stars.length).toBe(1);
  });

  it('appends a SYN-NNN row via the factory and marks it fromOverride', () => {
    const stars = [star({ hip: 1, proper: 'Sirius' })];
    const stats = applyMultipleOverridesPure(
      stars,
      [row({ hipOrSyn: 'SYN-7261', name: 'Sirius B', spect: 'DA2', absmag: 11.36, regime: 2 })],
      makeSyn,
    );
    expect(stats.synInjected).toBe(1);
    expect(stars.length).toBe(2);
    expect(stars[1].proper).toBe('Sirius B');
    expect(stars[1].hip).toBeNull();
    expect(stars[1].fromOverride).toBe(true);
    expect(stars[1].flags & FLAG_HAS_NAME).toBeTruthy();
  });

  it('dedupes duplicate HIP rows (build-binaries emits one per WDS pair)', () => {
    // Sirius A appears 5x in real multiples.tsv (once per WDS pair the
    // primary belongs to). All rows carry identical values; the helper
    // applies the first and skips the rest.
    const stars = [star({ hip: 32349 })];
    const stats = applyMultipleOverridesPure(
      stars,
      [
        row({ hipOrSyn: '32349', x: 1 }),
        row({ hipOrSyn: '32349', x: 1 }),
        row({ hipOrSyn: '32349', x: 1 }),
      ],
      makeSyn,
    );
    expect(stats.hipOverridden).toBe(1);
    expect(stars[0].x).toBe(1);
  });

  it('dedupes duplicate SYN-NNN rows (factory called once per id)', () => {
    const stars: OverridableStar[] = [];
    let factoryCalls = 0;
    const stats = applyMultipleOverridesPure(
      stars,
      [
        row({ hipOrSyn: 'SYN-7261', name: 'Sirius B' }),
        row({ hipOrSyn: 'SYN-7261', name: 'Sirius B' }),
      ],
      (r) => {
        factoryCalls++;
        return makeSyn(r);
      },
    );
    expect(stats.synInjected).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(stars.length).toBe(1);
  });

  it('reports a per-regime breakdown across HIP overrides and SYN injections', () => {
    const stars = [star({ hip: 1 }), star({ hip: 2 })];
    const stats = applyMultipleOverridesPure(
      stars,
      [
        row({ hipOrSyn: '1', regime: 1 }),
        row({ hipOrSyn: '2', regime: 2 }),
        row({ hipOrSyn: 'SYN-1', regime: 2 }),
        row({ hipOrSyn: 'SYN-2', regime: 3 }),
      ],
      makeSyn,
    );
    expect(stats.byRegime).toEqual({ 1: 1, 2: 2, 3: 1 });
  });

  it('end-to-end: co-located α Cen-style rows + override → two distinct positions, mutual pair preserved', () => {
    // Simulate AT-HYG's collapsed-parallax problem for α Cen: A and B
    // share the same (x, y, z). The override moves B to the J2000
    // orbit-resolved position. Verify (a) both records survive, (b) they
    // are no longer at identical coords, (c) `inferBinaries` with the
    // protected set keeps them mutually paired instead of dropping B as
    // sub-threshold.
    const aCenA: OverridableStar & BinaryStar = {
      ...star({ hip: 71683, x: -0.495, y: -0.414, z: -1.157, absmag: 4.379 }),
      companionIdx: -1,
    };
    const aCenB: OverridableStar & BinaryStar = {
      ...star({ hip: 71681, x: -0.495, y: -0.414, z: -1.157, absmag: 5.739 }),
      companionIdx: -1,
    };
    const stars = [aCenA, aCenB];
    applyMultipleOverridesPure(
      stars,
      [
        row({ hipOrSyn: '71683', x: -0.495, y: -0.414, z: -1.157, absmag: 4.379, regime: 2 }),
        row({
          hipOrSyn: '71681',
          x: -0.494994451, y: -0.413915477, z: -1.157032646,
          absmag: 5.739, regime: 2,
        }),
      ],
      makeSyn,
    );
    expect(stars[0].x).not.toBe(stars[1].x);

    // Build the protected set as the build script does: every
    // `fromOverride` star's post-sort index. (No sort here — fixture is
    // already in absmag order.)
    const protectedIndices = new Set<number>();
    for (let i = 0; i < stars.length; i++) {
      if (stars[i].fromOverride) protectedIndices.add(i);
    }
    expect(protectedIndices.size).toBe(2);

    const stats = inferBinaries(stars as BinaryStar[], protectedIndices);
    expect(stats.droppedSubThreshold).toBe(0);
    expect(stats.mutualPairs).toBe(1);
    expect(stars.length).toBe(2);

    // Separation should be ~17 AU = ~8e-5 pc — above MIN_RENDER but well
    // below BINARY_MAX_SEP_PC, so the mutual pair stays detected.
    const dx = stars[1].x - stars[0].x;
    const dy = stars[1].y - stars[0].y;
    const dz = stars[1].z - stars[0].z;
    const sep = Math.sqrt(dx*dx + dy*dy + dz*dz);
    expect(sep).toBeGreaterThan(MIN_RENDER_SEPARATION_PC);
    expect(sep).toBeLessThan(BINARY_MAX_SEP_PC);
  });
});

describe('catalog-pure / MIN_RENDER_SEPARATION_PC', () => {
  it('is 5e-6 pc (~1 AU) — the visual-mergeability threshold', () => {
    // Pinned because the safety-net drop in `inferBinaries` is calibrated
    // off this exact value; the build expects ~zero drops once the
    // multiples pipeline is in place.
    expect(MIN_RENDER_SEPARATION_PC).toBe(5e-6);
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

  it('record fields cover the v5 byte plan (one byte 37 reserved)', () => {
    // orbitIdx is the last field; with its 4 bytes the record fills exactly
    // RECORD_SIZE except for byte 37 (reserved for future variability type).
    expect(RECORD_LAYOUT.orbitIdx + 4).toBe(RECORD_SIZE);
    // Reserved byte 37 sits between ampUnits (36) and period (38).
    expect(RECORD_LAYOUT.ampUnits + 1).toBe(37);
    expect(RECORD_LAYOUT.period).toBe(38);
  });

  it('MAGIC trailing digit tracks BINARY_VERSION', () => {
    // Convention: MAGIC's suffix is the decimal version string. Pins
    // the "bump both together" contract documented in this file's
    // header comment and in docs/build-and-data.md.
    expect(MAGIC.endsWith(String(BINARY_VERSION))).toBe(true);
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
    expect(FLAG_BINARY_SECONDARY).toBe(FLAGS.binarySecondary);
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

  it('orbital offsets are non-overlapping and fit within ORBITAL_RECORD_SIZE', () => {
    const fields = Object.entries(ORBITAL_LAYOUT) as [keyof typeof ORBITAL_LAYOUT, number][];
    for (const [name, off] of fields) {
      expect(ORBITAL_FIELD_SIZES[name]).toBeDefined();
      expect(off + ORBITAL_FIELD_SIZES[name]).toBeLessThanOrEqual(ORBITAL_RECORD_SIZE);
    }
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const [na, oa] = fields[i];
        const [nb, ob] = fields[j];
        const ea = oa + ORBITAL_FIELD_SIZES[na];
        const eb = ob + ORBITAL_FIELD_SIZES[nb];
        const overlap = oa < eb && ob < ea;
        expect(overlap, `${na}@${oa}+${ORBITAL_FIELD_SIZES[na]} overlaps ${nb}@${ob}+${ORBITAL_FIELD_SIZES[nb]}`).toBe(false);
      }
    }
  });

  it('orbital layout fills ORBITAL_RECORD_SIZE exactly (9 × float32)', () => {
    const total = (Object.values(ORBITAL_FIELD_SIZES) as number[])
      .reduce((acc, n) => acc + n, 0);
    expect(total).toBe(ORBITAL_RECORD_SIZE);
    expect(ORBITAL_RECORD_SIZE).toBe(36);
  });

  it('orbital layout and size maps cover identical key sets', () => {
    expect(Object.keys(ORBITAL_FIELD_SIZES).sort()).toEqual(Object.keys(ORBITAL_LAYOUT).sort());
  });
});

describe('catalog-pure / buildOrbitalElementsTable', () => {
  const sampleOrbit: OrbitalElements = {
    P: 29200.32, T: 2447836.0,
    e: 0.5179, a: 17.57, q: 0.466,
    i: 2.380, omega: 2.604, Omega: 0.7779,
    dist: 1.3389,
  };

  function makeStar(orbitId: string | null, orbit: OrbitalElements | null): {
    orbitId: string | null;
    orbit: OrbitalElements | null;
  } {
    return { orbitId, orbit };
  }

  it('emits one row per unique orbitId in insertion order', () => {
    const stars = [
      makeStar('alpha', sampleOrbit),
      makeStar('alpha', sampleOrbit),    // duplicate orbitId — collapses
      makeStar('beta',  { ...sampleOrbit, P: 1000 }),
    ];
    const { bytes, orbitIdToRowIndex } = buildOrbitalElementsTable(stars);
    expect(orbitIdToRowIndex.size).toBe(2);
    expect(orbitIdToRowIndex.get('alpha')).toBe(0);
    expect(orbitIdToRowIndex.get('beta')).toBe(1);
    expect(bytes.byteLength).toBe(2 * ORBITAL_RECORD_SIZE);
  });

  it('skips stars with null orbitId or null orbit', () => {
    const stars = [
      makeStar(null, sampleOrbit),
      makeStar('id-only', null),
      makeStar('real', sampleOrbit),
    ];
    const { orbitIdToRowIndex } = buildOrbitalElementsTable(stars);
    expect(orbitIdToRowIndex.size).toBe(1);
    expect(orbitIdToRowIndex.get('real')).toBe(0);
  });

  it('round-trips float32 values within float32 precision', () => {
    const stars = [makeStar('alpha-cen', sampleOrbit)];
    const { bytes } = buildOrbitalElementsTable(stars);
    const recovered = readOrbitalElements(bytes, 0);
    // float32 has ~7 significant digits; sample values are picked to
    // survive that.
    expect(recovered.P).toBeCloseTo(sampleOrbit.P, 1);
    expect(recovered.T).toBeCloseTo(sampleOrbit.T, 0);
    expect(recovered.e).toBeCloseTo(sampleOrbit.e, 4);
    expect(recovered.a).toBeCloseTo(sampleOrbit.a, 4);
    expect(recovered.q).toBeCloseTo(sampleOrbit.q, 5);
    expect(recovered.i).toBeCloseTo(sampleOrbit.i, 5);
    expect(recovered.omega).toBeCloseTo(sampleOrbit.omega, 5);
    expect(recovered.Omega).toBeCloseTo(sampleOrbit.Omega, 5);
    expect(recovered.dist).toBeCloseTo(sampleOrbit.dist, 4);
  });

  it('returns empty bytes + empty map for stars with no orbital data', () => {
    const stars = [
      makeStar(null, null),
      makeStar(null, null),
    ];
    const { bytes, orbitIdToRowIndex } = buildOrbitalElementsTable(stars);
    expect(bytes.byteLength).toBe(0);
    expect(orbitIdToRowIndex.size).toBe(0);
  });

  it('first-write-wins when duplicate orbitId carries different elements', () => {
    // build-binaries.py guarantees identical elements per orbit_id; this
    // pins the defensive contract so a slightly-different second fit
    // doesn't silently overwrite the first.
    const stars = [
      makeStar('shared', sampleOrbit),
      makeStar('shared', { ...sampleOrbit, P: 999 }),
    ];
    const { bytes, orbitIdToRowIndex } = buildOrbitalElementsTable(stars);
    expect(orbitIdToRowIndex.size).toBe(1);
    const row = readOrbitalElements(bytes, 0);
    expect(row.P).toBeCloseTo(sampleOrbit.P, 1);
  });
});

describe('catalog-pure / applyMultipleOverridesPure — orbital fields', () => {
  // Mini-fixture: an OverridableStar factory that includes the new
  // orbital slots, plus a row factory that takes optional orbital data.
  function star(opts: Partial<OverridableStar> & { hip: number | null }): OverridableStar {
    return {
      x: 0, y: 0, z: 0, absmag: 5, ci: 0.5,
      spectClass: 8, lumClass: 255, physicalRadius: 1,
      flags: 0, proper: null, spectDisplay: null,
      fromOverride: false,
      orbitId: null, orbitRole: null, orbit: null,
      ...opts,
    };
  }
  function row(opts: Partial<MultipleOverrideRow> & { hipOrSyn: string }): MultipleOverrideRow {
    return {
      systemId: 'TEST', comp: 'A',
      x: 0, y: 0, z: 0, absmag: 5, ci: 0.5,
      spect: 'G2V', name: '', source: 'test', regime: 1,
      orbitId: null, orbitRole: null, orbit: null,
      ...opts,
    };
  }
  function makeSyn(r: MultipleOverrideRow): OverridableStar {
    return {
      x: r.x, y: r.y, z: r.z, absmag: r.absmag, ci: r.ci,
      spectClass: 4, lumClass: 2, physicalRadius: 1,
      flags: r.name ? FLAG_HAS_NAME : 0,
      proper: r.name || null, hip: null, spectDisplay: r.spect,
      fromOverride: false,
      orbitId: null, orbitRole: null, orbit: null,
    };
  }

  const orbit: OrbitalElements = {
    P: 18313.0, T: 2449416.4,
    e: 0.5923, a: 19.8, q: 0.33,
    i: 2.380, omega: 2.604, Omega: 0.7779,
    dist: 2.64,
  };

  it('propagates orbitId, orbitRole, and elements onto a matched HIP row', () => {
    const stars = [star({ hip: 32349 })];
    applyMultipleOverridesPure(
      stars,
      [row({
        hipOrSyn: '32349', regime: 2,
        orbitId: 'WDS|06451-1643|AB', orbitRole: 'primary', orbit,
      })],
      makeSyn,
    );
    expect(stars[0].orbitId).toBe('WDS|06451-1643|AB');
    expect(stars[0].orbitRole).toBe('primary');
    expect(stars[0].orbit).toEqual(orbit);
  });

  it('propagates orbital fields onto a SYN-NNN injection', () => {
    const stars: OverridableStar[] = [];
    applyMultipleOverridesPure(
      stars,
      [row({
        hipOrSyn: 'SYN-7261', regime: 2, name: 'Sirius B',
        orbitId: 'WDS|06451-1643|AB', orbitRole: 'secondary', orbit,
      })],
      makeSyn,
    );
    expect(stars[0].orbitId).toBe('WDS|06451-1643|AB');
    expect(stars[0].orbitRole).toBe('secondary');
    expect(stars[0].orbit).toEqual(orbit);
  });

  it('end-to-end: A+B share orbitIdx, only secondary carries FLAG_BINARY_SECONDARY', () => {
    // Apply primary + secondary rows. Then build the table; expect both
    // stars to map to the same row index.
    const stars = [star({ hip: 32349 })];
    applyMultipleOverridesPure(
      stars,
      [
        row({
          hipOrSyn: '32349', regime: 2, name: 'Sirius',
          orbitId: 'WDS|06451-1643|AB', orbitRole: 'primary', orbit,
        }),
        row({
          hipOrSyn: 'SYN-7261', regime: 2, name: 'Sirius B',
          orbitId: 'WDS|06451-1643|AB', orbitRole: 'secondary', orbit,
        }),
      ],
      makeSyn,
    );
    const { orbitIdToRowIndex } = buildOrbitalElementsTable(stars);
    expect(orbitIdToRowIndex.size).toBe(1);
    const sharedIdx = orbitIdToRowIndex.get('WDS|06451-1643|AB');
    expect(sharedIdx).toBe(0);

    // Writer-side: replicate the per-record flag logic so the contract
    // is pinned without depending on build-catalog.ts internals.
    const flags = stars.map((s) => {
      let f = s.flags;
      if (s.orbitId && s.orbitRole === 'secondary') f |= FLAG_BINARY_SECONDARY;
      return f;
    });
    expect(flags[0] & FLAG_BINARY_SECONDARY).toBeFalsy();  // primary
    expect(flags[1] & FLAG_BINARY_SECONDARY).toBeTruthy(); // secondary
  });
});
