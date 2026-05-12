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
//   [0,                                                HEADER_SIZE)               header
//   [HEADER_SIZE,                  HEADER_SIZE + count*RECORD_SIZE)               records
//   [HEADER_SIZE + count*RECORD_SIZE,                  elementsOffset)            name table
//   [elementsOffset,         elementsOffset + elementsCount*ORBITAL_RECORD_SIZE)  orbital-elements
//
// The orbital-elements section is empty at v5 (elementsCount = 0) — the
// scaffolding is laid down now so dch.8 can populate it without another
// version bump. The convention `MAGIC.endsWith(String(BINARY_VERSION))`
// is pinned by a test.
//
// HEADER_LAYOUT / RECORD_LAYOUT below carry the per-field byte offsets;
// HEADER_FIELD_SIZES / RECORD_FIELD_SIZES carry the matching byte widths
// and field kinds. Adding/changing a field means: bump BINARY_VERSION +
// MAGIC, extend the LAYOUT + SIZES pair with the new offset and kind, and
// the writer + reader + tests pick the change up automatically.

export const MAGIC = 'HYG5';
export const BINARY_VERSION = 5;
export const HEADER_SIZE = 32;
export const RECORD_SIZE = 48;
export const NO_COMPANION = 0xffffffff;
export const NO_ORBIT = 0xffffffff;

export const HEADER_LAYOUT = {
  magic: 0,            // 4 bytes ASCII
  version: 4,          // uint32
  count: 8,            // uint32
  nameTableOffset: 12, // uint32
  nameTableLength: 16, // uint32
  elementsOffset: 20,  // uint32 (orbital-elements section start; 0 when empty)
  elementsCount: 24,   // uint32 (orbital-elements rows; 0 when section is empty)
  // bytes 28..31 reserved
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
  elementsOffset: 4,
  elementsCount: 4,
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
  orbitIdx: 44,   // uint32 (NO_ORBIT = no orbital elements; otherwise row in elements section)
} as const;

/** Per-field byte width keyed by RECORD_LAYOUT name. As with
 *  HEADER_FIELD_SIZES the test suite derives non-overlap + bound checks
 *  from this map so any new field gets coverage by extending one place. */
export const RECORD_FIELD_SIZES: Record<keyof typeof RECORD_LAYOUT, number> = {
  x: 4, y: 4, z: 4, absmag: 4, ci: 4, physRadius: 4,
  companion: 4, nameOffset: 4,
  spectClass: 1, lumClass: 1, conIndex: 1, flags: 1, ampUnits: 1,
  period: 2, hip: 4, orbitIdx: 4,
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
  binarySecondary: 0x20,
} as const;
export const FLAG_HAS_NAME = FLAGS.hasName;
export const FLAG_IS_SOL = FLAGS.isSol;
export const FLAG_HAS_BAYER = FLAGS.hasBayer;
export const FLAG_BINARY_PRIMARY = FLAGS.binaryPrimary;
export const FLAG_BINARY_SECONDARY = FLAGS.binarySecondary;

/** Bits intentionally left free for future use — adding functionality
 *  that fits inside one of these does not require a BINARY_VERSION bump.
 *  The reservation is pinned by a regression test: drifting RESERVED into
 *  any FLAGS value forces a deliberate edit here. */
export const RESERVED_FLAG_BITS = 0x08 | 0x40 | 0x80;

// ---- Geometric binary inference -----------------------------------------

// Pairs within this 3D distance are flagged as a physical binary/multiple
// system. 0.005 pc ≈ 1030 AU — wide-binary territory. Gaia resolves most
// bound pairs wider than ~0.5 arcsec so this captures the visually-
// renderable cases.
export const BINARY_MAX_SEP_PC = 0.005;

// Below this 3D separation a pair is considered visually un-renderable —
// the two discs would overlap to one pixel even at minimum focus distance.
// 5e-6 pc ≈ 1 AU. Used as the safety-net threshold in `inferBinaries`:
// mutual pairs below this where *neither* component came from
// `applyMultipleOverridesPure` are assumed to be AT-HYG rows with a
// collapsed (shared) parallax solution that the WDS+ORB6 cross-match
// pipeline didn't catch — the fainter member is dropped from the catalog
// with a warn-log naming both HIPs. Famous close pairs (α Cen, Sirius,
// Procyon, Castor) are protected because their components are injected /
// overridden by the multiples pipeline.
export const MIN_RENDER_SEPARATION_PC = 5e-6;

// Structural type of a star record consumed by `inferBinaries`. The build
// script's full Star type extends this; the helper only reads/writes the
// fields named here. `hip` is optional and only used to make the
// sub-threshold drop warn-log identifiable.
export interface BinaryStar {
  x: number;
  y: number;
  z: number;
  absmag: number;
  flags: number;
  companionIdx: number;
  hip?: number | null;
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
  protectedIndices: ReadonlySet<number> = new Set(),
): { pairs: number; mutualPairs: number; droppedSubThreshold: number } {
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
  // directed nearest). Above MIN_RENDER_SEPARATION_PC, flag the brighter
  // as primary. Below, when neither member came from the multiples
  // override layer, the pair is a collapsed-parallax AT-HYG artefact the
  // multiples pipeline didn't catch — drop the fainter with a warn-log.
  // Iterate i < j to handle each pair exactly once.
  let mutualPairs = 0;
  const minSepSq = MIN_RENDER_SEPARATION_PC * MIN_RENDER_SEPARATION_PC;
  const subDrops: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = stars[i].companionIdx;
    if (j < 0 || j <= i) continue;
    if (stars[j].companionIdx !== i) continue;

    const dxv = stars[j].x - stars[i].x;
    const dyv = stars[j].y - stars[i].y;
    const dzv = stars[j].z - stars[i].z;
    const d2 = dxv * dxv + dyv * dyv + dzv * dzv;

    if (
      d2 < minSepSq &&
      !protectedIndices.has(i) &&
      !protectedIndices.has(j)
    ) {
      const fainter = stars[i].absmag > stars[j].absmag ? i : j;
      const kept = fainter === i ? j : i;
      const idTag = (s: BinaryStar) =>
        s.hip != null && s.hip > 0
          ? `HIP ${s.hip}`
          : `(no HIP, xyz=${s.x.toFixed(4)},${s.y.toFixed(4)},${s.z.toFixed(4)} absmag=${s.absmag.toFixed(2)})`;
      console.warn(
        `sub-threshold mutual pair below MIN_RENDER_SEPARATION_PC ` +
          `(${Math.sqrt(d2).toExponential(2)} pc): dropping fainter ` +
          `${idTag(stars[fainter])} (kept ${idTag(stars[kept])})`,
      );
      subDrops.push(fainter);
      continue;
    }

    mutualPairs++;
    markPrimary(stars, [i, j]);
  }

  // Splice dropped fainter components out, descending so earlier indices
  // remain valid. Rewrite companionIdx of survivors that pointed at a
  // dropped slot (set to -1) or at a later slot (shift down by 1).
  if (subDrops.length > 0) {
    subDrops.sort((a, b) => b - a);
    for (const idx of subDrops) {
      stars.splice(idx, 1);
      for (const s of stars) {
        if (s.companionIdx === idx) s.companionIdx = -1;
        else if (s.companionIdx > idx) s.companionIdx--;
      }
    }
  }

  return { pairs, mutualPairs, droppedSubThreshold: subDrops.length };
}

// ---- Multiple-star override application ---------------------------------

// One parsed row from data/multiples.tsv. The build-binaries.py pipeline
// emits per-component rows for every WDS pair it keeps; `hipOrSyn` is
// either an integer HIP (string-encoded) for components already present
// in AT-HYG, or `SYN-NNN` for synthetic secondaries injected by the
// pipeline (Sirius B, α Cen B's orbit-resolved position, etc.).
export interface MultipleOverrideRow {
  systemId: string;
  comp: string;
  hipOrSyn: string;
  x: number;
  y: number;
  z: number;
  absmag: number;
  ci: number;
  spect: string;
  name: string;
  source: string;
  regime: number;
}

// Subset of the build-catalog Star fields that `applyMultipleOverridesPure`
// touches when overwriting a HIP row. Build scripts add their own fields
// (companion, hd, hr, flam, gl, etc.) on top — those are owned by the SYN
// factory the caller supplies.
export interface OverridableStar {
  x: number;
  y: number;
  z: number;
  absmag: number;
  ci: number;
  spectClass: number;
  lumClass: number;
  physicalRadius: number;
  flags: number;
  proper: string | null;
  hip: number | null;
  spectDisplay: string | null;
  fromOverride: boolean;
}

/** Apply `data/multiples.tsv` rows to the catalog. HIP rows locate an
 *  existing star by Hipparcos number and overwrite position + photometry
 *  + spectrum + (optionally) name; SYN-NNN rows are constructed by the
 *  caller-supplied factory and appended.
 *
 *  Duplicates collapse: build-binaries.py emits the same HIP / SYN-id
 *  once per WDS pair the component appears in, so famous primaries like
 *  Sirius A show up 5+ times with identical values. First-write wins;
 *  subsequent rows are skipped.
 *
 *  HIP rows whose HIP is not in `stars` are silently counted as
 *  `hipMissing` — these are AT-HYG rows that fell out of `readStars`
 *  upstream (e.g. exceeded MAX_DIST_PC).
 *
 *  Sets `fromOverride = true` on every star this helper touched or
 *  injected so the caller can build a "protected" index set after the
 *  catalog sort and pass it to `inferBinaries` (sub-threshold drop is
 *  meant for unfixed AT-HYG-native artefacts, not pipeline output).
 *
 *  The override `name` field is only copied onto a HIP row when it is
 *  non-empty — most rows have a blank name and the helper preserves the
 *  AT-HYG proper name in that case. */
export function applyMultipleOverridesPure<T extends OverridableStar>(
  stars: T[],
  overrides: MultipleOverrideRow[],
  makeSyn: (row: MultipleOverrideRow) => T,
): {
  hipOverridden: number;
  hipMissing: number;
  synInjected: number;
  byRegime: Record<number, number>;
} {
  const hipToIndex = new Map<number, number>();
  for (let i = 0; i < stars.length; i++) {
    const h = stars[i].hip;
    if (h !== null && h > 0) hipToIndex.set(h, i);
  }

  const seenHip = new Set<number>();
  const seenSyn = new Set<string>();
  let hipOverridden = 0;
  let hipMissing = 0;
  let synInjected = 0;
  const byRegime: Record<number, number> = {};

  for (const row of overrides) {
    if (row.hipOrSyn.startsWith('SYN-')) {
      if (seenSyn.has(row.hipOrSyn)) continue;
      seenSyn.add(row.hipOrSyn);
      const star = makeSyn(row);
      star.fromOverride = true;
      stars.push(star);
      synInjected++;
      byRegime[row.regime] = (byRegime[row.regime] ?? 0) + 1;
      continue;
    }

    const hip = parseInt(row.hipOrSyn, 10);
    if (!Number.isFinite(hip) || hip <= 0) continue;
    if (seenHip.has(hip)) continue;
    seenHip.add(hip);
    const idx = hipToIndex.get(hip);
    if (idx === undefined) {
      hipMissing++;
      continue;
    }

    const s = stars[idx];
    s.x = row.x;
    s.y = row.y;
    s.z = row.z;
    s.absmag = row.absmag;
    s.ci = row.ci;

    const spectInfo = parseSpectral(row.spect);
    s.spectClass = spectInfo.classIdx;
    s.lumClass = spectInfo.lumClass;
    s.physicalRadius = physicalRadius(row.absmag, spectInfo);
    s.spectDisplay = row.spect
      ? row.spect.replace(/\*+$/, '').trim().replace(/\s+/g, ' ')
      : s.spectDisplay;

    if (row.name) {
      s.proper = row.name;
      s.flags |= FLAG_HAS_NAME;
    }

    s.fromOverride = true;
    hipOverridden++;
    byRegime[row.regime] = (byRegime[row.regime] ?? 0) + 1;
  }

  return { hipOverridden, hipMissing, synInjected, byRegime };
}
