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
  7: [[0,  4000], [5,  3000], [9,  2500]],             // C/S/W/N/R (cool carbon) — rough
  8: [[0,  5000], [5,  5000], [9,  5000]],             // unknown — neutral default
};

function interpolate(table: [number, number][], key: number): number {
  // Explicit high-end clamp: callers contract for keys in [0, 9] and the
  // tables span [0, 9] inclusive, so any key >= the last bucket boundary
  // is at-or-beyond the table. Returning the last value here is the
  // documented out-of-range behaviour and lets the loop body assume
  // key < k1 on every iteration.
  const last = table[table.length - 1];
  if (key >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [k0, v0] = table[i - 1];
    const [k1, v1] = table[i];
    if (key <= k1) {
      const t = (key - k0) / (k1 - k0);
      return v0 + (v1 - v0) * t;
    }
  }
  return last[1];
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

// ---- Binary catalog format ----------------------------------------------

// Single source of truth for the catalog.bin file layout, shared by the
// writer (scripts/build-catalog), the runtime reader
// (src/client/catalog-loader), and the verify tool (scripts/verify-catalog).
//
// File structure:
//   [0,                       HEADER_SIZE)                              header
//   [HEADER_SIZE,             HEADER_SIZE + count*RECORD_SIZE)          records
//   [HEADER_SIZE + count*RECORD_SIZE,                       end)        name table
//
// HEADER_LAYOUT / RECORD_LAYOUT below carry the per-field byte offsets;
// HEADER_FIELD_SIZES / RECORD_FIELD_SIZES carry the matching byte widths
// and field kinds. Adding/changing a field means: bump BINARY_VERSION +
// MAGIC, extend the LAYOUT + SIZES pair with the new offset and kind, and
// the writer + reader + tests pick the change up automatically.

export const MAGIC = 'HYG4';
export const BINARY_VERSION = 4;
export const HEADER_SIZE = 32;
export const RECORD_SIZE = 44;
export const NO_COMPANION = 0xffffffff;

export const HEADER_LAYOUT = {
  magic: 0,            // 4 bytes ASCII
  version: 4,          // uint32
  count: 8,            // uint32
  nameTableOffset: 12, // uint32
  nameTableLength: 16, // uint32
  // bytes 20..31 reserved
} as const;

/** Per-field byte width keyed by HEADER_LAYOUT name. Single source of
 *  truth shared with the layout regression tests so size assertions
 *  can't drift from the actual encoding. */
export const HEADER_FIELD_SIZES: Record<keyof typeof HEADER_LAYOUT, number> = {
  magic: 4,
  version: 4,
  count: 4,
  nameTableOffset: 4,
  nameTableLength: 4,
};

export const RECORD_LAYOUT = {
  x: 0,           // float32
  y: 4,           // float32
  z: 8,           // float32
  absmag: 12,     // float32
  ci: 16,         // float32
  physRadius: 20, // float32
  companion: 24,  // uint32 (NO_COMPANION = none)
  nameOffset: 28, // uint32 (0 = unnamed)
  spectClass: 32, // uint8
  lumClass: 33,   // uint8
  conIndex: 34,   // uint8 (255 = none)
  flags: 35,      // uint8 (FLAG_*)
  ampUnits: 36,   // uint8 (×0.05 mag)
  // byte 37 reserved (variability type)
  period: 38,     // uint16 (×0.1 days)
  hip: 40,        // uint32 (0 = no HIP)
} as const;

/** Per-field byte width keyed by RECORD_LAYOUT name. As with
 *  HEADER_FIELD_SIZES the test suite derives non-overlap + bound checks
 *  from this map so any new field gets coverage by extending one place. */
export const RECORD_FIELD_SIZES: Record<keyof typeof RECORD_LAYOUT, number> = {
  x: 4, y: 4, z: 4, absmag: 4, ci: 4, physRadius: 4,
  companion: 4, nameOffset: 4,
  spectClass: 1, lumClass: 1, conIndex: 1, flags: 1, ampUnits: 1,
  period: 2, hip: 4,
};

// Name table layout: two zero bytes of padding so name offset 0 reads as
// the "no name" sentinel, followed by length-prefixed UTF-8 strings:
// uint16 byteLen, then byteLen bytes.
export const NAME_TABLE_PADDING = 2;
export const NAME_LENGTH_PREFIX_BYTES = 2;

// ---- search-index.json wire contract ------------------------------------

// One entry per searchable star written by build-catalog.ts and consumed
// by src/client/search.ts. Keys are short (i/p/b/f/c/s/hip/hd/hr/gl) for
// wire size — the index is ~13 MB raw with hundreds of thousands of
// entries. Sharing the interface across writer + reader is the contract:
// drift here ships a broken index.
export interface SearchEntry {
  i: number;     // record index in the binary catalog
  p?: string;    // proper name (Sol, Sirius, …)
  b?: string;    // Bayer designation as in AT-HYG (Alp, Alp-1, …)
  f?: number;    // Flamsteed number
  c?: number;    // constellation index (255 = none, omitted)
  s?: string;    // spectral designation, cleaned for display
  hip?: number;  // Hipparcos catalogue number
  hd?: number;   // Henry Draper number
  hr?: number;   // Harvard Revised / Yale BSC number
  gl?: string;   // Gliese / GJ designation
}

// ---- Catalog flag bits --------------------------------------------------

// Per-star bitfield stored at RECORD_LAYOUT.flags. Single source of truth
// for both writers (scripts/build-catalog, scripts/catalog-pure
// inferBinaries) and readers (catalog-loader, chart-labels,
// verify-catalog). Adding a bit means adding a name to the FLAGS
// registry, not sprinkling another magic number — the regression tests
// then automatically pin distinct-ness and single-bit-ness.
//
// FLAGS is the canonical registry; the FLAG_* exports below are named
// aliases for callsite readability.
export const FLAGS = {
  hasName: 0x01,
  isSol: 0x02,
  hasBayer: 0x04,
  binaryPrimary: 0x10,
} as const;
export const FLAG_HAS_NAME = FLAGS.hasName;
export const FLAG_IS_SOL = FLAGS.isSol;
export const FLAG_HAS_BAYER = FLAGS.hasBayer;
export const FLAG_BINARY_PRIMARY = FLAGS.binaryPrimary;

/** Bits intentionally left free for future use — adding functionality
 *  that fits inside one of these does not require a BINARY_VERSION bump.
 *  The reservation is pinned by a regression test: drifting RESERVED into
 *  any FLAGS value forces a deliberate edit here. */
export const RESERVED_FLAG_BITS = 0x08 | 0x20 | 0x40 | 0x80;

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

// Apply FLAG_BINARY_PRIMARY across an iterable of HIP-indexed groups. Each
// group's brightest in-catalog component (lowest absmag) gets the bit,
// idempotent with any pre-existing flags from `inferBinaries` (the
// geometric mutual-pair pass can have already marked one member). Groups
// with no in-catalog members are silently skipped.
//
// The `groups` iterable is the union of CCDM groups parsed from the
// Hipparcos cross-reference and the curated `KNOWN_VISUAL_DOUBLES`
// overrides — the caller (build-catalog) constructs the union; this
// helper just walks it.
//
// Returns:
//   systems  — count of groups that resolved at least one in-catalog HIP.
//   flagged  — count of groups where this pass set a fresh primary
//              (i.e. excludes groups whose primary was already set by a
//              prior pass).
//
// Mutates `stars[i].flags` in place via `markPrimaryIfUnflagged`. Pure
// otherwise — does not read or write any other fields.
export interface DoublesStar { absmag: number; flags: number; hip: number | null; }
export function applyDoublesFlag(
  stars: DoublesStar[],
  groups: Iterable<Iterable<number>>,
): { systems: number; flagged: number } {
  const hipToIndex = new Map<number, number>();
  for (let i = 0; i < stars.length; i++) {
    const h = stars[i].hip;
    if (h !== null && h > 0) hipToIndex.set(h, i);
  }

  let systems = 0;
  let flagged = 0;
  for (const hips of groups) {
    const indices: number[] = [];
    for (const h of hips) {
      const idx = hipToIndex.get(h);
      if (idx !== undefined) indices.push(idx);
    }
    if (indices.length === 0) continue;
    systems++;
    if (markPrimaryIfUnflagged(stars, indices) >= 0) flagged++;
  }
  return { systems, flagged };
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
//   mutualPairs  — undirected mutual pairs (each counted once); also
//                  equals the count of FLAG_BINARY_PRIMARY bits set,
//                  since we mark exactly one primary per mutual pair
export function inferBinaries(
  stars: BinaryStar[],
): { pairs: number; mutualPairs: number } {
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

  return { pairs, mutualPairs };
}

// ---- Bailer-Jones (DR3) distance override -------------------------------

// dist_src tag emitted when a star's distance was supplanted by the
// Bailer-Jones 2021 (DR3) photogeometric / geometric posterior. Joins
// AT-HYG's existing namespace (G_R3, G_R2, HIP, GJ, N, OTHER).
export const DIST_SRC_BAILER_JONES = 'BJ';

/** Parse the TSV produced by `scripts/refresh-bailer-jones.py` into a
 *  Gaia DR3 source_id → distance (pc) map. `source_id` is kept as a
 *  string: Gaia source_ids exceed `Number.MAX_SAFE_INTEGER`, so any
 *  numeric parse would silently corrupt the join key.
 *
 *  Per Bailer-Jones 2021, `r_med_photogeo` is preferred when available
 *  (combines the parallax likelihood with a colour-and-magnitude
 *  population prior); `r_med_geo` is the geometric-only fallback for
 *  rows without photogeo (no usable G or BP–RP). */
export function parseBailerJonesTsv(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return out;
  const header = lines[0].split('\t').map((h) => h.trim());
  const idIdx = header.indexOf('source_id');
  const geoIdx = header.indexOf('r_med_geo');
  const photogeoIdx = header.indexOf('r_med_photogeo');
  const missing: string[] = [];
  if (idIdx < 0) missing.push('source_id');
  if (geoIdx < 0) missing.push('r_med_geo');
  if (photogeoIdx < 0) missing.push('r_med_photogeo');
  if (missing.length) {
    throw new Error(
      `Bailer-Jones TSV is missing required columns: ${missing.join(', ')}. ` +
        `Re-run scripts/refresh-bailer-jones.py.`,
    );
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const sourceId = (cells[idIdx] ?? '').trim();
    if (!sourceId) continue;
    const photogeo = parseFloat((cells[photogeoIdx] ?? '').trim());
    const geo = parseFloat((cells[geoIdx] ?? '').trim());
    const d = Number.isFinite(photogeo)
      ? photogeo
      : Number.isFinite(geo) ? geo : NaN;
    if (!Number.isFinite(d) || d <= 0) continue;
    out.set(sourceId, d);
  }
  return out;
}

/** ICRS spherical → AT-HYG Cartesian (parsec). RA in hours, Dec in
 *  degrees, distance in pc. Mirrors AT-HYG's own (x0, y0, z0) basis so
 *  override outputs slot back into the same coordinate space. */
export function icrsSphericalToCartesian(
  raHours: number,
  decDegrees: number,
  distPc: number,
): { x: number; y: number; z: number } {
  const ra = raHours * (Math.PI / 12);
  const dec = decDegrees * (Math.PI / 180);
  const cosDec = Math.cos(dec);
  return {
    x: distPc * cosDec * Math.cos(ra),
    y: distPc * cosDec * Math.sin(ra),
    z: distPc * Math.sin(dec),
  };
}

/** Apparent magnitude → absolute magnitude at given distance.
 *  M = m − 5·log₁₀(d / 10 pc). */
export function apparentToAbsoluteMagnitude(mag: number, distPc: number): number {
  return mag - 5 * Math.log10(distPc / 10);
}

export interface BailerJonesOverride {
  dist: number;
  x: number;
  y: number;
  z: number;
  absmag: number;
}

/** When `gaiaSourceId` has a Bailer-Jones entry, returns the override
 *  (dist, x, y, z, absmag) for that star; otherwise null. The caller
 *  swaps these into the star record and tags `dist_src = "BJ"`.
 *  Recomputing absmag with the new distance is essential — without it,
 *  stars get placed at the new distance but lit for the old one. */
export function applyBailerJonesOverride(
  raHours: number,
  decDegrees: number,
  mag: number,
  gaiaSourceId: string | null,
  bjMap: Map<string, number>,
): BailerJonesOverride | null {
  if (!gaiaSourceId) return null;
  const dist = bjMap.get(gaiaSourceId);
  if (dist === undefined) return null;
  const { x, y, z } = icrsSphericalToCartesian(raHours, decDegrees, dist);
  return { dist, x, y, z, absmag: apparentToAbsoluteMagnitude(mag, dist) };
}
