# Build and data

The build pipeline that turns the raw catalogues in `data/` into
renderer-ready binaries in `public/`. Everything in this doc is about
`scripts/*` and the file formats they produce. For the science of *what*
gets computed (Stefan–Boltzmann radii, etc.), see `SCIENCE.md`.

## Binary catalog format (`public/catalog.bin`)

Fixed-size records, sorted brightest-first by `absmag`. Current version is
**v4** with a 44-byte stride. Magic and version step together
(v3=`HYG3`, v4=`HYG4`). v4 added a `uint32` HIP at bytes 40–43 so the
URL-state encoder can use Hipparcos numbers as stable star IDs that
survive future catalog reorderings.

- Header (32 bytes)
  - 0–3   ASCII `HYG4`
  - 4–7   `uint32` version (currently 4)
  - 8–11  `uint32` count
  - 12–15 `uint32` nameTableOffset
  - 16–19 `uint32` nameTableLength
  - 20–31 reserved
- Record (44 bytes per star)
  - 0–11  `float32 × 3`  x, y, z in parsecs (equatorial, Sol at origin)
  - 12–15 `float32`      absmag
  - 16–19 `float32`      ci (B–V colour index, default 0.65 for missing)
  - 20–23 `float32`      physicalRadius in solar radii (computed at build time)
  - 24–27 `uint32`       companionIdx (record index of binary companion; `0xFFFFFFFF` = none)
  - 28–31 `uint32`       nameOffset (into name table, valid when flag bit 0 set; `0` = none)
  - 32    `uint8`        spectClass (0=O 1=B 2=A 3=F 4=G 5=K 6=M 7=C/S/W 8=?)
  - 33    `uint8`        luminosityClass (0=VII/D … 9=Ia+/0, 255=unknown — see below)
  - 34    `uint8`        constellation index (0–87 into `constellations.json`; 255=none)
  - 35    `uint8`        flags (bit 0=has_name, 1=is_sol, 2=has_bayer, 4=is_binary_primary)
  - 36    `uint8`        **variability amplitude** in 0.05 mag units (0 = not variable)
  - 37    `uint8`        reserved (future: variability type)
  - 38–39 `uint16`       **variability period** in 0.1 days (0 = not variable, max 6553.5 d)
  - 40–43 `uint32`       **HIP** (Hipparcos number; 0 = no HIP). Only ~37%
                          of the catalogue carries HIP — the rest are filled
                          with 0 and fall back to row-index addressing in
                          shared URLs. Max observed HIP is 120,404 (fits in
                          17 bits) so 24 bits would suffice, but `uint32`
                          keeps the record stride a multiple of 4.
- Name table: length-prefixed UTF-8 strings (`uint16` length then bytes).
  **Offset 0 is reserved** as the "no name" sentinel (2 zero bytes of
  padding); real names start at offset ≥ 2.

Luminosity class encoding (Morgan–Keenan):
`0=VII/D (white dwarf), 1=VI/sd, 2=V (dwarf), 3=IV (subgiant), 4=III
(giant), 5=II (bright giant), 6=Ib, 7=Iab, 8=Ia, 9=Ia+/0 (hypergiant),
255=unknown`.

Amplitude encoding saturates at 255 × 0.05 = 12.75 mag; periods over
6553.5 days clamp to the uint16 max. Both limits cover the vast
majority of real variables (a few multi-decade symbiotics and extreme
eclipsers clip but those render imperceptibly slowly anyway).

The byte plan above is encoded once in `scripts/catalog-pure.ts` as
`HEADER_LAYOUT`, `RECORD_LAYOUT`, `HEADER_SIZE`, `RECORD_SIZE`, `MAGIC`,
`BINARY_VERSION`, and `NO_COMPANION`. Writer (`scripts/build-catalog.ts`),
runtime reader (`src/client/catalog-loader.ts`), and the verify tool
(`scripts/verify-catalog.ts`) all index off those constants — there are
no inline byte offsets to drift apart. If you add fields, keep the
44-byte stride (pad as needed), extend `RECORD_LAYOUT`, and **bump
`BINARY_VERSION` + `MAGIC`** in `catalog-pure.ts`. Free flag bits today
are `0x08`, `0x20`, `0x40`, `0x80` (see `FLAG_*` exports). Layout
consistency is pinned by the `binary-format constants` block in
`scripts/catalog-pure.test.ts`.

The build script also asserts every headline count (record count, GCVS
xrefs, binary inference output, CCDM doubles, name-table entries,
search-index entries, etc.) against
`scripts/build-catalog-expected.json` at the end of each run. A
deliberate change refreshes the manifest with
`UPDATE_BUILD_COUNTS=1 npm run build:catalog`; an unintended drift
exits non-zero with a per-key diff. `scripts/build-counts.ts` carries
the pure comparator + formatter and has its own vitest coverage.

## Search index (`public/search-index.json`)

Separate from `catalog.bin` so the main binary stays rendering-focused.
One JSON array entry per star that has at least one searchable identifier
(proper name, Bayer, Flamsteed, HIP, HD, HR, or Gliese). Short keys
(`i/p/b/f/hip/hd/hr/gl/c/s`) to keep wire size down — file is ~13 MB raw,
~2 MB gzipped. Loaded in parallel with `catalog.bin` in `main.ts`. The
`s` field carries the raw spectral designation from the AT-HYG source
("G2 V", "M1.5Iab-b", "K0III+K7V", …) for the hover tooltip display.

Field shape pinned in `scripts/catalog-pure.ts` as the `SearchEntry`
interface — the writer (`build-catalog.ts`) and the reader
(`src/client/search.ts`) both import it; drift = compile error.

Identifier dispatch in `search.ts`:
- Regex-prefix forms (`HIP 27989`, `HD 39801`, `HR 2061`, `Gl 559A`) go
  through `Map<number, number>` direct lookups — no fuzzy scoring.
- Flamsteed (`58 Ori`) also uses a direct `"${num} ${con}"` map.
- Everything else (proper name, Bayer forms) is Fuse-fuzzy.
- For each Bayer'd star, multiple index entries are emitted so any of
  `α Cen` / `Alpha Cen` / `Alp Cen` / `Alf Cen` / `Alpha Centaurus` find
  the star. "Alf" is added only for α (most-commonly alternate-spelled).

The dropdown deduplicates by star index so a star with multiple matching
Bayer variants shows up once.

## Stick figures from Stellarium

Classical asterism lines are sourced from Stellarium's modern sky culture
`index.json` (CC/MIT-compatible, HIP-indexed). The source file is
committed to `data/stellarium-modern-skyculture.json` — it essentially
never changes, so fetching it at build time each time would be wasted
work.

Pipeline in `scripts/build-catalog.ts`:

1. The HYG CSV parser reads the `hip` column into each star record.
2. After sorting stars by absmag (so record indices are final), a
   `hipToIndex: Map<number, number>` is built from the post-sort order.
   Duplicate HIPs (rare — binary companions) keep the brightest entry
   (first-write wins).
3. `buildFigureLines(hipToIndex)` walks each Stellarium constellation's
   `lines` array and resolves every HIP to a record index, producing
   `Map<conIndex, number[][]>`.
4. Resolved `lines` are merged into the emitted `constellations.json`
   alongside `{ code, name }`. A polyline is kept only if ≥2 points
   survive.

**Reliability rule: any unresolved HIP is a hard build error** — unless
it's in `KNOWN_MISSING_HIPS`. That map documents HIPs that Stellarium
references but HYG has no 3D position for (empty x/y/z/parallax in the
CSV), with a human-readable justification each. Currently:

- `5165` (α Phe / Ankaa) — Phoenix loses most of its figure without this
  star, but HYG can't carry it.
- `89341` (μ Sgr / Polis) — one Sagittarius polyline degrades from 3
  points to 2, shape still recognisable.

If a future Stellarium update introduces new references to missing HIPs,
the build fails until each is explicitly added to
`KNOWN_MISSING_HIPS` with rationale. Don't relax the check to a soft
warning — the whole point of using Stellarium's HIP-indexed data (vs.
fuzzy RA/Dec position matching) is deterministic mapping.

## Physical radius and spectral parsing

`parseSpectral` in `build-catalog.ts` walks tolerant regexes over the (often
messy) AT-HYG `spect` string to extract `{ classIdx, subclass, lumClass,
isWhiteDwarf }`. It handles the common pathological forms seen in the
catalog (composite `"K0III+K6V"`, prefix colons, ranges like `"F5-F9"`,
subdwarf `sdB`, white-dwarf `DA2`, etc.) by using prefix-anchored matches
for the luminosity numeral and falling back to `lumClass=255` when no
pattern matches.

`physicalRadius` then computes R/R☉ via Stefan–Boltzmann:

```
T       = interp(T_TABLE[classIdx], subclass)
BC      = interp(BC_TABLE[classIdx], subclass)
Mbol    = absmag + BC
L/L☉    = 10^((4.74 − Mbol) / 2.5)
R/R☉    = sqrt(L/L☉) × (T_sun/T)²
```

Tables are main-sequence values — cooler for giants/supergiants in reality
— but the Mbol side of the equation absorbs the luminosity-class
difference, so the end result lands close to published radii (Sol≈1.03,
Sirius≈1.81, Vega≈2.68, Rigel≈75, Betelgeuse≈700, all within ~10% of
canonical values). Clamped to `[0.08, 2500]` so pathological catalog
rows don't produce absurd sizes. White dwarfs are special-cased to
0.013 R☉ (typical WD radius; absmag doesn't translate reliably for them).

## Multiple-star override application

Before the absmag sort and geometric binary pass, `build-catalog.ts`
calls `applyMultipleOverridesPure` against the per-component rows that
`scripts/build-binaries.py` emits to `data/multiples.tsv`. Two row
shapes:

- **HIP rows** (`hip` column is an integer) locate the existing
  `BinaryStar` by Hipparcos number and overwrite `x/y/z/absmag/ci/spect`
  — `spectClass`, `lumClass`, `physicalRadius`, and `spectDisplay` are
  rebuilt from the new spectrum. `proper` is only overwritten when the
  override row's `name` column is non-empty, so blank-name rows (the
  common case for HIP primaries) preserve the AT-HYG proper name.
- **SYN-NNN rows** (`hip` column is the literal token `SYN-` plus an
  integer) append a brand-new `BinaryStar` constructed via the
  build-script factory: no HIP, no constellation membership (`conIndex
  = 255`), no GCVS lookup (`periodDays = amplitudeMag = 0`), and
  `FLAG_HAS_NAME` set when the override carries a proper name. These are
  the Sirius B / α Cen B-orbit / Castor Aa1+Aa2 / Algol Aa1+Aa2
  components that AT-HYG drops or collapses.

Duplicate rows collapse: `build-binaries.py` emits the same HIP / SYN-id
once per WDS pair the component belongs to (Sirius A appears 5×), so
the helper applies the first row and skips identical re-applications.
HIPs that aren't in the post-`readStars` catalog (filtered for distance
/ missing absmag) are counted under `hipMissing` and silently skipped.

Each touched / appended star carries a transient `fromOverride = true`
marker; after the absmag sort the caller builds a `Set<number>` of
those indices and hands it to `inferBinaries` as the protected set for
the sub-threshold safety net (see next section).

Build-log shape:

```
Applying multiple-star overrides from data/multiples.tsv...
  22877 HIP overrides, 27905 SYN injected, 1 HIPs not in catalog;
  by regime: r1=49361 r2=1421 r3=0 in 104ms
```

The per-regime breakdown (`r1` visual ρ/θ, `r2` ORB6 orbit at J2000,
`r3` spectroscopic / inclination-less ORB6) summed across HIP overrides
and SYN injections is the headline number — drift here signals that
`build-binaries.py` lost a data source or filter shifted.

If `data/multiples.tsv` is absent the build logs and continues with
the pre-overrides catalog (the AT-HYG-only path that has the
collapsed-α-Cen / missing-Sirius-B problem).

## Geometric binary inference

`inferBinaries` in `build-catalog.ts` runs after the absmag sort and
the multiple-star override application (above), so record indices are
final modulo the sub-threshold drop pass at the bottom of this section.
Spatial grid keyed at `BINARY_MAX_SEP_PC = 0.005 pc` (≈1030 AU) using a
three-axis hash; for each star, check own cell + 26 neighbours and
record the nearest neighbour within the threshold.

Why this threshold: at the current `minDistance = 0.005 pc` orbit,
anything farther than that subtends >45° from the camera — it wouldn't
fit the viewport as a visual "system", which is what the render layer
wants. Wider bound pairs exist in the catalog but won't render usefully.

What you'll see from the classic_ids subset *with* the multiples
pipeline in place: ~14k mutual pairs. The pure AT-HYG pass alone gives
~14 (most wide-binary companions of classical-ID primaries don't carry
classical IDs themselves); the bulk of the pairs come from the SYN
secondaries injected by `applyMultipleOverridesPure` — Sirius B, Castor
Aa1/Aa2, Algol Aa1/Aa2, every WDS companion the cross-match resolved.

Each star records its **directed** nearest in `companionIdx`: A's
nearest may be B while B's nearest is some third star C. The
relation is one-way. The renderer reads this as "the partner to keep
in frame" (zoom-fit, disc-mask), which is well-defined even when
asymmetric.

Flag bit 4 (`0x10`) is stricter: set only on the **brighter member of
a mutual pair** — A↔B where each is the other's directed nearest.
Mutual-only avoids over-flagging in dense clusters where a star's
directed nearest happens to be a third star already paired with
someone else, and ensures the chart-mode wings glyph appears once
per system on the canonical anchor.

**Sub-threshold safety net.** Mutual pairs below
`MIN_RENDER_SEPARATION_PC = 5e-6 pc` (~1 AU) where *neither* component
is in the protected set passed by the caller are treated as
collapsed-parallax AT-HYG artefacts the multiples pipeline didn't
catch — the fainter member is spliced out of `stars[]` with a
`console.warn` naming both HIPs (or both xyz+absmag when the rows are
HIP-less), and `companionIdx` pointers of surviving stars are rewritten
so no index dangles. Protected indices are exactly the
`fromOverride`-marked rows from the override application step; famous
close pairs (α Cen, Sirius, Procyon, Castor, Algol) sit in there and
are never dropped. In a clean build this fires zero or one time —
existing fires are AT-HYG rows that share an astrometric solution and
have no HIP.

## GCVS variability cross-match

`parseGcvsMain` + `parseGcvsCrossref` in `build-catalog.ts` read two
files from `data/`:

- `gcvs5.txt` — pipe-delimited fixed-width; we pull the GCVS designation,
  period (days), and magnitude amplitude (from max-mag / min-mag-I).
  Rows without a parseable period, or with zero amplitude, are skipped
  (constant stars, supernovae, irregular variables we can't render
  periodically).
- `crossid.txt` — maps foreign-catalogue IDs (`Hip nnnn`, `HD nnnn`, …)
  to GCVS designations. Only `Hip` and `HD` are extracted since AT-HYG
  carries those.

`applyVariability` then walks the post-sort catalog and for each star
tries HIP first, HD fallback, to find a GCVS name, then looks up the
period+amp. Typical match rate: ~3.7k out of 313k classic_ids stars —
most catalog stars aren't variable, but the ones that are tend to be
the astronomically interesting ones (Betelgeuse, Mira, Algol,
Cepheids, etc.).

Both GCVS files are tracked via Git LFS rather than downloaded at build
time — they update rarely (yearly-ish). If bumping to a new GCVS
version, re-download from http://www.sai.msu.su/gcvs/ and replace the
existing files; LFS handles the large-blob storage on push.

## CCDM double-star cross-match

Visual binaries get the same `flags` bit 4 the geometric pass uses, so
chart mode renders wings on either source with no renderer-side
changes. The geometric pass alone yields ~14 pairs (the only AT-HYG
rows where both components survive the classic-IDs cut); the CCDM
pass pulls in everything else where the primary has a HIP — Sirius,
Mizar, Castor, α Cen, Polaris, Albireo, γ And, ε Lyr, etc.

`parseHipCcdm` in `build-catalog.ts` reads `data/hip_ccdm.tsv`, a
three-column slice of the **Hipparcos main catalogue** (VizieR
`I/239/hip_main`). The `CCDM` column on each Hipparcos row carries
the cross-reference into the Catalog of the Components of Double
and Multiple stars (Dommanget & Nys 1994), the curated pre-WDS
register of visual doubles. CCDM alone is too permissive — it
lumps physical pairs together with wide line-of-sight optical
pairs that happen to land near each other on the sky, so flagging
on `CCDM != ""` alone tags Vega, Pollux, and ~19k other stars
including a substantial optical-pair tail.

To gate optical pairs out, we additionally filter on Hipparcos's
own `MultFlag` (H59) column:

| `MultFlag` | Meaning                                | Action |
|------------|----------------------------------------|--------|
| `C`        | Component star in a Hipparcos system   | keep   |
| `G`        | Double resolved within Hipparcos field | keep   |
| `O`        | Orbit known (spectroscopic / astrom.)  | keep   |
| blank      | CCDM listed but Hipparcos didn't model | drop   |
| `V`        | Variability-induced double             | drop   |
| `X`        | Stochastic, low confidence             | drop   |

This drops the bulk of optical pairs while preserving every
binary Hipparcos itself confirmed.

A handful of canonical visual doubles fall through the gate
because Hipparcos modelled them as single stars (`Ncomp=1`,
blank `MultFlag`) — typically wide pairs where the secondary is
faint or angularly outside what Hipparcos resolved.
**`KNOWN_VISUAL_DOUBLES`** in `build-catalog.ts` recovers them
unconditionally. The structure is a list of `{components, reason}`
systems — each entry is one physical system whose `components`
array is the HIPs known to belong to it (one or more) plus a
human-readable justification. The same primary-only flagging that
applies to real CCDM groups applies here, so 61 Cyg A and B share
one entry rather than two and only the brighter (A) gets the
wings glyph. Current list: Polaris (sep 18″ Polaris B), ε¹ Lyr
(inner pair 2.4″), 61 Cyg A+B (the famous nearby K-dwarf pair).
Visual review of new chart-mode renders may surface more — extend
conservatively.

Why this and not TDSC or WDS directly:

- **TDSC** (Fabricius et al. 2002) is built from Tycho-2, which
  saturates on the brightest stars (V ≲ 3) — Sirius, Mizar, Castor,
  α Cen, Polaris are all *missing* from TDSC. CCDM has no such gap.
- **WDS** itself doesn't carry HIP. Doing positional matching
  ourselves would invite false positives in dense fields. CCDM
  side-steps that by giving us the HIP↔system mapping pre-built.

The file is a VizieR TSV fetched once from
`vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=I/239/hip_main&-out=HIP,CCDM,MultFlag&-out.max=unlimited`
and committed via Git LFS. The parser tolerates VizieR's preamble
(`#` comment lines, header row, dash-separator row). Required
columns are the literal labels `HIP`, `CCDM`, and `MultFlag`; if a
future fetch renames them the build fails with a clear message
naming the actual header that was read.

No separation gate at the per-row level (CCDM and Hipparcos's
`rho` column are both inconsistently populated). The chart-mode
wings glyph is iconic rather than a depiction of resolved pair
geometry, so even Sirius B at ΔV ≈ 10 earns wings on Sirius A.

`parseHipCcdm` returns systems grouped by `CCDM_ID` (real CCDM
strings for file-driven entries, synthetic `OVERRIDE-N` keys for
the `KNOWN_VISUAL_DOUBLES` list). `applyDoublesFlag` then walks
each group, picks the **brightest** catalog member (lowest
`absmag`), and ORs `0x10` onto only that one — so each Hipparcos-
resolved system contributes exactly one chart-mode wings glyph,
matching the geometric pass's mutual-primary semantics. Stars that
are CCDM secondaries do not get the bit; they remain in the
catalog with their other flags intact. No `companionIdx` write —
the secondary often isn't in the AT-HYG classic_ids subset, and
the renderer's zoom-fit code at `stellata.ts` already guards on
`companion ≥ 0`, so a flagged-but-unpaired primary is fine.

If the CCDM file is absent the build logs and continues — the
geometric pass still runs and chart mode still works, just with the
~14-pair coverage.

## Build-binaries pipeline

`scripts/build-binaries.py` is a stdlib-only Python preprocessor that
cross-matches WDS + ORB6 against AT-HYG and emits one row per resolved
multiple-star component to `data/multiples.tsv`. Invoked
automatically by `npm run build:catalog` (and therefore by
`npm run build` / `npm run dev`).

**Inputs**

- `data/wds_summ.txt` — WDS summary, fixed-width 130-char records.
- `data/wds_notes.txt` — WDS notes; scanned for `HIP NNN` prose
  cross-references that supplement cone-match.
- `data/orb6_orbits.txt` — Sixth Catalog of Orbits, fixed-width
  264-char records. Carries explicit HIP for ~2k systems.
- `data/athyg_33_classic_ids.csv` — AT-HYG canonical positions,
  HIP-keyed.
- `data/gaia_dr3_binaries.tsv` — *optional*; engages the
  parallax + common-PM optical-pair filter when present. See
  SCIENCE.md → "Multiple-star pipeline" for the manual retrieval
  procedure.
- `data/multiples-overrides.tsv` — hand-curated edge cases, loaded
  last.

**Outputs**

- `data/multiples.tsv` (gitignored) — columns
  `system_id, comp, hip, x_pc, y_pc, z_pc, absmag, ci, spect,
  name, source, regime`. `hip` is the integer HIP or a `SYN-NNN`
  sentinel for synthesised components. `regime` is `1` (visual ρ/θ),
  `2` (ORB6 orbit), or `3` (spectroscopic / inclination-less ORB6).
- `data/wds_upload.csv` (gitignored) — `wds_id, comp, ra_deg, dec_deg`
  per kept component, written every run as input to the manual Gaia
  ADQL upload.

**Cone-match parameters**

- Primary HIP lookup: 30″ around WDS precise coordinates against AT-HYG.
  Wider than the catalogue's nominal precision because high-PM stars
  drift 10-30″ between WDS J2000 and AT-HYG's Tycho-2 / Hipparcos
  epochs.
- Secondary HIP lookup: 30″ around AT-HYG A + sky-projected `(ρ, θ)`.
  Tangent basis is AT-HYG's own `(ra, dec)` — see SCIENCE.md note on
  why round-tripping through xyz at AT-HYG's 0.001 pc storage
  precision would catastrophically miss for nearby stars.

**Idempotency**

Skips rebuild if `data/multiples.tsv` is newer than the script *and*
every input file (including the optional Gaia file when present and
the overrides file). `--force` to override; `touch scripts/build-
binaries.py` to invalidate by mtime alone.

## Preprocessor idempotency

`scripts/build-catalog.ts isUpToDate` skips rebuild if `catalog.bin`,
`constellations.json`, **and** `search-index.json` are newer than all
source inputs (AT-HYG CSV, Stellarium JSON, GCVS files, Hipparcos
CCDM TSV, `data/multiples.tsv`, and the script itself). If you change
field mapping but not the script mtime (e.g. edit in a way that updates
atime only), you may need to `touch scripts/build-catalog.ts` or delete
the generated files.
