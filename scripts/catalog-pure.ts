// Pure data-transform helpers shared by build-catalog.ts and its tests.
// Anything in this file must be deterministic, side-effect-free, and
// import nothing from node:fs / node:path / globals — these helpers are
// the seam where unit tests pin down the catalog's most error-prone
// transforms (spectral parsing, Stefan-Boltzmann radius, GCVS field
// extraction, binary spatial inference) without spinning up the build.

// ---- Spectral classification --------------------------------------------

export interface SpectralInfo {
  classIdx: number;     // 0-8 per spectClassIndex
  subclass: number;     // 0-9, defaults to 5 when missing
  lumClass: number;     // 0-9 (see encoding below), 255 if unknown
  isWhiteDwarf: boolean;
  wdSubclass: number;   // only valid if isWhiteDwarf (the digit after D)
}

// Luminosity-class encoding shared with the renderer:
//   0 = VII / D  (white dwarf)        5 = II        (bright giant)
//   1 = VI / sd  (subdwarf)           6 = Ib        (less-luminous supergiant)
//   2 = V        (main sequence)      7 = Iab       (intermediate supergiant)
//   3 = IV       (subgiant)           8 = Ia        (luminous supergiant)
//   4 = III      (giant)              9 = Ia+ / 0   (hypergiant)
// 255 = unknown / unparseable
export function spectClassIndex(firstChar: string): number {
  switch (firstChar) {
    case 'O': return 0;
    case 'B': return 1;
    case 'A': return 2;
    case 'F': return 3;
    case 'G': return 4;
    case 'K': return 5;
    case 'M': return 6;
    case 'C': case 'S': case 'W': case 'N': case 'R': return 7;
    default: return 8;
  }
}

export function parseSpectral(raw: string): SpectralInfo {
  // Strip leading junk colons and quotes; collapse spaces.
  const s = raw.replace(/^["':\s]+/, '').replace(/\s+/g, '').toUpperCase();
  if (!s) {
    return { classIdx: 8, subclass: 5, lumClass: 255, isWhiteDwarf: false, wdSubclass: 0 };
  }

  // White dwarf: starts with "D" followed by another letter (DA, DB, DC, DO,
  // DZ, DQ, DX) and an optional digit. Plain "D" alone (rare) also counts.
  if (s[0] === 'D' && (s.length === 1 || /[A-Z]/.test(s[1]))) {
    const m = s.match(/^D[A-Z]*(\d(?:\.\d)?)?/);
    const wdSub = m && m[1] ? Math.round(Number(m[1])) : 5;
    return {
      classIdx: 8, subclass: 5, lumClass: 0, isWhiteDwarf: true,
      wdSubclass: Math.max(0, Math.min(9, wdSub)),
    };
  }

  // Subdwarf prefix: "sdB", "sdO", etc. — lumClass=1, classIdx from the letter.
  if (s.startsWith('SD')) {
    const letter = s.charAt(2);
    const cls = spectClassIndex(letter);
    const subMatch = s.substring(3).match(/^(\d)/);
    const sub = subMatch ? Number(subMatch[1]) : 5;
    return { classIdx: cls, subclass: sub, lumClass: 1, isWhiteDwarf: false, wdSubclass: 0 };
  }

  // Leading letter is the primary spectral class.
  const firstChar = s.charAt(0);
  const classIdx = spectClassIndex(firstChar);

  // Subclass digit (0-9), optionally with a decimal — take the integer part.
  // The full match includes the decimal portion so afterPrefix skips past it,
  // letting the luminosity-class regex see "Iab" rather than ".5Iab".
  const subMatch = s.substring(1).match(/^(\d)(?:\.\d)?/);
  const subclass = subMatch ? Number(subMatch[1]) : 5;

  // Luminosity Roman numeral — order from most specific to least so we don't
  // mis-match "II" as "I" etc. Matched anywhere after the first 2-3 chars.
  const afterPrefix = s.substring(1 + (subMatch ? subMatch[0].length : 0));
  let lumClass = 255;
  if (/^(IA\+|0)/.test(afterPrefix)) lumClass = 9;
  else if (/^IAB/.test(afterPrefix)) lumClass = 7;
  else if (/^IA/.test(afterPrefix)) lumClass = 8;
  else if (/^IB/.test(afterPrefix)) lumClass = 6;
  else if (/^III/.test(afterPrefix)) lumClass = 4;
  else if (/^II(?!I)/.test(afterPrefix)) lumClass = 5;
  else if (/^IV/.test(afterPrefix)) lumClass = 3;
  else if (/^VII/.test(afterPrefix)) lumClass = 0;
  else if (/^VI(?!I)/.test(afterPrefix)) lumClass = 1;
  else if (/^V/.test(afterPrefix)) lumClass = 2;
  else if (/^I(?![IV])/.test(afterPrefix)) lumClass = 7; // bare "I" — treat as Iab

  return { classIdx, subclass, lumClass, isWhiteDwarf: false, wdSubclass: 0 };
}

// ---- Stefan-Boltzmann physical-radius chain -----------------------------

// Effective temperature (Kelvin) by spectral class + subclass for main-sequence
// stars. Giants and supergiants of the same letter+digit run ~10-15% cooler;
// the physical-radius calculation rides mostly on the *relative* scaling, so
// the MS table is close enough. White dwarfs use a separate formula.
const T_TABLE: Record<number, [number, number][]> = {
  0: [[0, 50000], [5, 42000], [9, 34000]],             // O
  1: [[0, 30000], [5, 15200], [9, 10500]],             // B
  2: [[0,  9790], [5,  8180], [9,  7600]],             // A
  3: [[0,  7300], [5,  6650], [9,  6050]],             // F
  4: [[0,  5940], [5,  5560], [9,  5310]],             // G
  5: [[0,  5150], [5,  4410], [9,  3900]],             // K
  6: [[0,  3840], [5,  3170], [9,  2500]],             // M
  7: [[0,  4000], [5,  3000], [9,  2500]],             // C/S/W (cool carbon) — rough
  8: [[0,  5000], [5,  5000], [9,  5000]],             // unknown — neutral default
};

function interpolate(table: [number, number][], key: number): number {
  for (let i = 1; i < table.length; i++) {
    const [k0, v0] = table[i - 1];
    const [k1, v1] = table[i];
    if (key <= k1) {
      const t = (key - k0) / (k1 - k0);
      return v0 + (v1 - v0) * t;
    }
  }
  return table[table.length - 1][1];
}

export function tempKelvin(info: SpectralInfo): number {
  if (info.isWhiteDwarf) {
    // WD spectral number is T_eff / 50400 × 10 (inverted from Sion et al.);
    // so T_eff ≈ 50400 / N for N=1..9.
    const n = Math.max(1, info.wdSubclass);
    return 50400 / n;
  }
  return interpolate(T_TABLE[info.classIdx] ?? T_TABLE[8], info.subclass);
}

// Bolometric correction by spectral class + subclass. Mostly negligible for
// solar-type stars; large negatives for O/B (lots of UV) and M (lots of IR).
const BC_TABLE: Record<number, [number, number][]> = {
  0: [[0, -4.9], [5, -4.4], [9, -3.3]],
  1: [[0, -3.16], [5, -1.46], [9, -0.51]],
  2: [[0, -0.30], [5, -0.15], [9, -0.10]],
  3: [[0, -0.09], [5, -0.14], [9, -0.16]],
  4: [[0, -0.18], [5, -0.21], [9, -0.31]],
  5: [[0, -0.31], [5, -0.72], [9, -1.20]],
  6: [[0, -1.38], [5, -2.73], [9, -4.10]],
  7: [[0, -2.00], [5, -3.00], [9, -4.00]],
  8: [[0,  0.00], [5,  0.00], [9,  0.00]],
};

export function boloCorr(info: SpectralInfo): number {
  if (info.isWhiteDwarf) {
    // WDs have large BCs that depend strongly on T; a single value is a lie
    // but good enough for display sizing. Hot DA ≈ -2, cool ≈ 0.
    const T = tempKelvin(info);
    if (T > 30000) return -2.5;
    if (T > 15000) return -1.0;
    if (T > 8000) return -0.2;
    return 0.3;
  }
  return interpolate(BC_TABLE[info.classIdx] ?? BC_TABLE[8], info.subclass);
}

const T_SUN = 5778;
const MBOL_SUN = 4.74;

// Compute physical radius in solar radii from absolute magnitude + spectral
// info via Stefan-Boltzmann. Clamped to sane bounds so odd catalog entries
// don't produce absurd values.
export function physicalRadius(absmag: number, info: SpectralInfo): number {
  if (info.isWhiteDwarf) {
    // White dwarfs cluster tightly around 0.01 R☉; absmag doesn't translate
    // reliably into a radius for them.
    return 0.013;
  }
  const T = tempKelvin(info);
  const BC = boloCorr(info);
  const Mbol = absmag + BC;
  const L = Math.pow(10, (MBOL_SUN - Mbol) / 2.5); // L/L☉
  if (!Number.isFinite(L) || L <= 0) return 1.0;
  const R = Math.sqrt(L) * (T_SUN / T) * (T_SUN / T);
  // Empirical stellar range: red dwarfs bottom around 0.08 R☉, extreme
  // supergiants top around ~2000 R☉. Beyond these is bad catalog data.
  return Math.max(0.08, Math.min(2500, R));
}

// ---- GCVS variable-star catalogue parsing -------------------------------

// GCVS designations in both files are space-padded fixed-width, e.g.
// "R     And *" or "Z     Peg". Trailing asterisk is an indicator we
// don't need; collapse internal whitespace to a single space.
export function normalizeGcvsName(raw: string): string {
  return raw
    .replace(/\*+$/, '')
    .trim()
    .replace(/\s+/g, ' ');
}

// Parse a possibly-annotated GCVS number field: entries may carry "<", ">",
// ":", "()" uncertainty markers or trailing "*"; strip them before parsing.
export function parseGcvsNumber(s: string): number | null {
  const t = s.trim().replace(/[<>():;*]/g, '').trim();
  if (!t) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

// ---- Catalog flag bits --------------------------------------------------

// Per-star bitfield in the binary catalog. Bit 3 (0x08) is reserved for
// future use. Single source of truth for both writers (scripts/build-catalog,
// scripts/catalog-pure inferBinaries) and readers (catalog-loader,
// chart-labels, verify-catalog). Adding a bit means adding a name here, not
// sprinkling another magic number.
export const FLAG_HAS_NAME = 0x01;
export const FLAG_IS_SOL = 0x02;
export const FLAG_HAS_BAYER = 0x04;
export const FLAG_BINARY_PRIMARY = 0x10;

// ---- Geometric binary inference -----------------------------------------

// Pairs within this 3D distance are flagged as a physical binary/multiple
// system. 0.005 pc ≈ 1030 AU — wide-binary territory. Gaia resolves most
// bound pairs wider than ~0.5 arcsec so this captures the visually-
// renderable cases.
export const BINARY_MAX_SEP_PC = 0.005;

// Structural type of a star record consumed by `inferBinaries`. The build
// script's full Star type extends this; the helper only reads/writes the
// fields named here.
export interface BinaryStar {
  x: number;
  y: number;
  z: number;
  absmag: number;
  flags: number;
  companionIdx: number;
}

// Pick the brightest star (lowest absmag) of `indices` and OR
// FLAG_BINARY_PRIMARY onto it. Returns the picked index, or -1 if the
// group is empty. Single point of truth for the "primary = brightest of
// group" convention shared by both binary-flagging passes (geometric
// mutual pairs in inferBinaries; CCDM groups in applyDoublesFlag).
//
// Idempotent: re-running on a group whose primary is already flagged
// produces the same flag bits.
export function markPrimary(
  stars: Pick<BinaryStar, 'absmag' | 'flags'>[],
  indices: number[],
): number {
  let bestIdx = -1;
  let bestMag = Infinity;
  for (const i of indices) {
    const m = stars[i].absmag;
    if (m < bestMag) {
      bestMag = m;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return -1;
  stars[bestIdx].flags |= FLAG_BINARY_PRIMARY;
  return bestIdx;
}

// Like markPrimary, but a no-op when any star in `indices` already carries
// FLAG_BINARY_PRIMARY. Used by the CCDM pass: a star flagged by
// inferBinaries' mutual-pair pick should not get re-picked here, since
// the two passes can disagree on which of a triple is "primary" (e.g. a
// non-mutual {A, B, C} where the geometric pair is (B, C) but A is
// brightest in the CCDM group). Honouring the existing pick keeps the
// "at most one primary per physical system" contract — re-flagging would
// produce two wings glyphs for the same system. Returns the picked
// index, -1 if no in-catalog members, or -2 if a member was already
// flagged.
export function markPrimaryIfUnflagged(
  stars: Pick<BinaryStar, 'absmag' | 'flags'>[],
  indices: number[],
): number {
  if (indices.length === 0) return -1;
  for (const i of indices) {
    if ((stars[i].flags & FLAG_BINARY_PRIMARY) !== 0) return -2;
  }
  return markPrimary(stars, indices);
}

// Spatial-grid nearest-neighbour pass. For each star, find its nearest
// neighbour within BINARY_MAX_SEP_PC and record it as `companionIdx`.
// `companionIdx` is the **directed** nearest neighbour (A's nearest may
// be B while B's nearest is some third star C); the renderer reads it
// as "the partner to keep in frame," which is well-defined even when
// the relationship is one-way.
//
// The `0x10` flag is stricter: set only on the brighter member of a
// **mutual** pair (A's nearest is B AND B's nearest is A). The chart-
// mode wings glyph is anchored on `0x10`, so mutual-only avoids
// over-flagging in dense clusters where one star's nearest happens to
// be a third star that's actually paired with someone else.
//
// Mutates `stars[i].companionIdx` and `stars[i].flags` in place.
// Returns counts for the build-time log line:
//   pairs        — total directed companion assignments
//   mutualPairs  — undirected mutual pairs (each counted once)
//   primaries    — stars marked with 0x10 (== mutualPairs)
export function inferBinaries(
  stars: BinaryStar[],
): { pairs: number; mutualPairs: number; primaries: number } {
  const cell = BINARY_MAX_SEP_PC;
  const cellInv = 1 / cell;
  const grid = new Map<number, number[]>();
  const n = stars.length;

  const hashKey = (ix: number, iy: number, iz: number): number =>
    ix * 73856093 + iy * 19349663 + iz * 83492791;

  for (let i = 0; i < n; i++) {
    const s = stars[i];
    const ix = Math.floor(s.x * cellInv);
    const iy = Math.floor(s.y * cellInv);
    const iz = Math.floor(s.z * cellInv);
    const key = hashKey(ix, iy, iz);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  const sepSq = BINARY_MAX_SEP_PC * BINARY_MAX_SEP_PC;
  let pairs = 0;

  for (let i = 0; i < n; i++) {
    const s = stars[i];
    const ix = Math.floor(s.x * cellInv);
    const iy = Math.floor(s.y * cellInv);
    const iz = Math.floor(s.z * cellInv);
    let bestIdx = -1;
    let bestSq = sepSq;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(hashKey(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j === i) continue;
            const t = stars[j];
            const dxv = t.x - s.x;
            const dyv = t.y - s.y;
            const dzv = t.z - s.z;
            const d2 = dxv * dxv + dyv * dyv + dzv * dzv;
            if (d2 < bestSq) {
              bestSq = d2;
              bestIdx = j;
            }
          }
        }
      }
    }
    if (bestIdx !== -1) {
      stars[i].companionIdx = bestIdx;
      pairs++;
    }
  }

  // Second pass: identify mutual pairs (A↔B where each is the other's
  // directed nearest) and flag the brighter member as primary. Iterate
  // i < j to count each pair exactly once.
  let mutualPairs = 0;
  for (let i = 0; i < n; i++) {
    const j = stars[i].companionIdx;
    if (j < 0 || j <= i) continue;
    if (stars[j].companionIdx !== i) continue;
    mutualPairs++;
    markPrimary(stars, [i, j]);
  }

  return { pairs, mutualPairs, primaries: mutualPairs };
}
