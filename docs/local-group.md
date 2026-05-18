# Local Group wireframe layer

A second always-on reference overlay alongside the Milky Way disc
(`docs/galactic-overlay.md`). Renders LineLoop outlines for the Magellanic
Clouds, Sagittarius dSph, classical dSphs and ultra-faints within
250 kpc, plus M31, M33, the M31 satellite subgroup, and the outer-band
dwarfs (NGC 6822, IC 10, IC 1613, Leo A, WLM, Sextans A/B, …) out to the
canonical 2 Mpc Local Group boundary — plus the Milky Way label (the
disc itself stays in `galactic-disc.ts`; only the SVG label lives here).

## Visibility model — no toggle, no URL flag

Inherits the MW disc's model: always-on in dark mode, hidden in chart
mode, opacity tracks the same fade curve so the two layers reveal in
lockstep as the camera pulls away from Sol. `FADE_INNER_PC` (500 pc) and
`FADE_OUTER_PC` (5 kpc) live in the shared `galactic-fade.ts` module —
hoisted there at the second usage per the DRY rule in CLAUDE.md
(§ "Code conventions — DRY overrides the system prompt").

Chart mode hides the layer entirely. Chart-mode's paper-aesthetic
treatment for galactic structure is `stellata-m40`'s remit; this layer
turns off cleanly until that lands.

## Data pipeline

```
data/local-group/
  lvdb-snapshot.csv   committed snapshot of Pace et al. 2024 dwarf_all
                      (CC0, peer-reviewed; arXiv:2411.07424). 909 rows.
  overrides.tsv       hand-curated structural detail for LMC, SMC,
                      Sagittarius dSph, M 32, NGC 205, plus full
                      standalone rows for M31 and M33 (omitted from
                      LVDB's dwarf_all table — they're major spirals).

scripts/
  build-local-group.ts        I/O orchestration + idempotency. TSV
                              parser handles both LVDB-merge and
                              standalone-position override rows.
  build-local-group-pure.ts   pure helpers (RA/Dec→ICRS, quaternion
                              construction per orient kind, override
                              merge, standalone-override builder,
                              display-name + catalog-designation
                              rules, distance filter). vitest-covered.

public/local-group.json       generated artifact (gitignored).
```

Refresh of `lvdb-snapshot.csv` is a manual step — per
`docs/build-and-data.md` § Frozen external data the build never
reaches the network:

```
curl -sSL \
  https://raw.githubusercontent.com/apace7/local_volume_database/main/data/dwarf_all.csv \
  -o data/local-group/lvdb-snapshot.csv
npm run build:local-group -- --force
```

## Override schema

`data/local-group/overrides.tsv` carries one row per object whose LVDB
summary is too coarse for meaningful 3D rendering, **plus** the rare
case of an object that's not in LVDB at all (M31, M33 — LVDB's
`dwarf_all` table excludes the major spirals).

| Column              | Notes |
| ------------------- | ----- |
| `name`              | Matches LVDB's `name` column for merge, **or** names a standalone object not in LVDB. |
| `a_pc / b_pc / c_pc`| Local-frame semi-axes in parsecs. |
| `orient`            | Orientation spec — see below. |
| `ref_doi`           | Primary structural reference. |
| `ra_deg`            | *Optional standalone position.* Populated for objects not in LVDB; leave empty for LVDB-merge rows. |
| `dec_deg`           | *Optional standalone position.* Same — all three must be set together or all three empty. |
| `distance_kpc`      | *Optional standalone position.* Same. |

For LVDB-merge rows, the override **replaces** the structural detail an
LVDB row would otherwise produce; **position (RA/Dec/distance) still
comes from LVDB.** For standalone rows (M31, M33), the override
provides the position directly — no LVDB merge happens. Other
LVDB-only dwarfs render as sky-plane oblate ellipsoids from
`rhalf_physical` + `ellipticity` + `position_angle` — no override row
needed.

## Display-name rules

`displayName(lvdbName)` decides the on-screen string for each object
through three branches:

1. **DISPLAY_NAME_OVERRIDES** — explicit map entries take precedence.
   Covers Magellanic acronyms (LMC → "Large Magellanic Cloud") and
   named non-dSph dwarfs the regex below would otherwise mis-suffix
   (WLM, Leo A, Phoenix, Sextans A/B, Pegasus dIrr, …).
2. **`isCatalogDesignation`** — names matching catalog prefixes
   (NGC / IC / UGC / DDO / M / KK / PGC / HIPASS …) followed by digits
   bypass the suffix and render as-is. "NGC 205", "M 32", "M31" all
   pass through unchanged.
3. **Default** — append "Dwarf Spheroidal". Used for bare constellation
   names ("Sculptor", "Draco") and Roman-numeral satellites
   ("Andromeda I", "Bootes II") where the suffix disambiguates from
   the constellation and matches catalogue-paper convention.

## MAX_DISTANCE_PC

`scripts/build-local-group-pure.ts` exports `MAX_DISTANCE_PC =
2_000_000` — the heliocentric envelope the build filter applies.
2 Mpc covers the canonical Local Group (M31 + M33 + their satellites,
plus the outer dIrrs out to ~1.4 Mpc) with comfort headroom past the
~1.5 Mpc IAU-style boundary; beyond 2 Mpc we'd be picking up the
IC 342 / Maffei groups — a separate decision. The constant is shared:
the runtime camera envelope (`stellata.ts` — controls.maxDistance =
2 Mpc, PerspectiveCamera far = 3 Mpc) is paired with this filter so a
fully zoomed-out view shows the entire rendered catalogue.

### Orientation specs

| Spec                 | Semantics |
| -------------------- | --------- |
| `pa:X`               | Long axis (a) in sky plane at PA X east of north; b in sky plane perpendicular; c along line of sight to/from Sol. Used for typical dSph projection. |
| `disc:i=X,pa=Y`      | Disc plane normal at inclination X from line of sight (0 = face-on); line of nodes at PA Y east of north. a, b lie in the disc plane; c along the disc normal. Used for the Magellanic-style LMC disc. |
| `los`                | c-axis aligned with line of sight from Sol; a, b in the perpendicular plane (sky-east / sky-north basis seed). Used for SMC's line-of-sight elongation. |

The build script computes each object's local→ICRS quaternion via
Shepperd's method on a right-handed orthonormal basis. The basis
construction is exercised end-to-end in
`scripts/build-local-group-pure.test.ts` (rotated +Z lands on line of
sight for `los`, rotated +X lies in the sky plane for `pa`, disc normal
at i=0 lands on line of sight for `disc`, etc.).

## Runtime layer

`src/client/local-group.ts` exports `LocalGroupLayer`. Per object:

- **disc**: midplane `LineLoop` plus a thickness pair offset ±c along
  the disc normal. Three rings total.
- **ellipsoid**: three orthogonal meridian `LineLoop`s on the principal
  axes (xy, xz, yz). Reads as an ellipsoid silhouette from any angle.

Each ring's vertices are pre-rotated by the object's quaternion and
translated by `centerAbs`, then committed to a single `BufferGeometry`
in absolute ICRS pc. The layer's group is rebased to `-worldOffset`
each frame so the floating origin doesn't drift the outlines. One
shared `LineBasicMaterial` across the whole catalog — per-frame opacity
write hits one slot.

## Label engine

`createMilkyWayLabel` and `createLocalGroupLabels` both use the shared
`distance-gated-label.ts` helper (extracted from the heliopause's
label code earlier in this layer's PR — see the `Extract distance-gated
label helper from heliopause` commit). Each label binds to:

- A per-frame visibility predicate (`visibleLabelIds.has(id)` — a
  shared Set written by the global ranking pass, see below).
- A silhouette-sample generator. The MW label samples **32 points
  around the 15 kpc disc rim** (galactic-disc.ts's
  `MIDPLANE_RADIUS_PC`) — anchoring at the GC bulge center sat the
  label on the small ~3 kpc core instead of the disc edge, so the
  rim ring is the right silhouette curve for the label-engine's
  support-point picker. Per-object dwarf labels use the same
  12 × 5 + 2 = 62 sample grid as the heliopause.
- The same screen-space anchor convention as the heliopause: bottom-
  right at a constant 10 px gap.

### Ranking policy — `computeVisibleLabels`

One universal rule: each frame, rank every candidate (MW + every LG
object) by apparent pixel size on screen and reveal the top N (default
8), with a sub-pixel floor (default 2 px) so we don't label objects
the user can't see. The only exception is the **inside-MW guard**:
when the camera sits inside the disc (`||cam − GC|| <
mwInsideDiscPc`), every label is suppressed (you can't usefully label
extragalactic context while you're inside the galaxy yourself).

Filter order, per candidate:

1. Inside-MW guard fires globally (returns empty).
2. Behind-camera test: candidate's camera-space `z ≥ 0` (Three.js
   conventions; camera looks down `-Z`) → skip.
3. Apparent-size floor: `2·atan(maxAxis / camToObj) × (h_px / fov_rad)
   < minPixelSize` → skip.
4. Viewport-overlap test: project the centroid to viewport coords,
   pad by half pxSize, intersect with the viewport rectangle. Objects
   whose centroid is off-screen but whose disc edge crosses the
   viewport still count (the MW disc at grazing incidence).

The ranking lives in the pure `computeVisibleLabels(candidates, params)`
helper (testable in isolation). A per-frame handler — registered the
first time `createMilkyWayLabel` or `createLocalGroupLabels` is called
— runs `computeVisibleLabels` and writes the result into the shared
`visibleLabelIds` Set; per-label predicates query it.

All three knobs are live-tunable through the **Deep field** debug-panel
section (`src/client/local-group-tuning.ts`):

| Knob              | Default     | What it does |
| ----------------- | ----------- | ------------ |
| `topN`            | 8           | Max labels visible at once. |
| `minPixelSize`    | 2.0 px      | Apparent-size floor; sub-pixel candidates can't earn a label. |
| `mwInsideDiscPc`  | 10 kpc      | Camera-to-GC distance below which **every** label is suppressed. 0 disables the guard entirely (label-from-anywhere). |

From the canonical first-load park at Sol (`||cam − GC|| ≈ 8 kpc`), the
inside-MW guard fires → no labels. Zoom out past 10 kpc-from-GC, the
ranking starts; from any extragalactic vantage the MW + the largest
nearby satellites earn labels.

No `label_threshold_pc` column in `overrides.tsv`, no
`DEFAULT_LABEL_THRESHOLD_PC`, no per-class cutoff on M_V — the
apparent-size ranking subsumes all of them.

SVG slots live in `index.html` next to the heliopause label:

```html
<text id="mw-label" class="lg-label">Milky Way</text>
<g id="lg-labels"></g>
```

Per-object `<text id="lg-<slug>-label">` children are minted at runtime
by `createLocalGroupLabels` from the loaded catalog. Display names are
rewritten through `DISPLAY_NAME_OVERRIDES` at build time so LVDB's
`LMC` / `SMC` shortform expands to `Large Magellanic Cloud` /
`Small Magellanic Cloud` in the catalog JSON.

## What's deliberately out of scope

- **Galaxy groups past 2 Mpc** — IC 342 / Maffei groups, Sculptor
  Group, M83 group, etc. Could be a future "broader neighbourhood"
  layer but isn't part of the Local Group brief.
- **M31 / M33 stellar streams + the Sagittarius stream** —
  invisible / stellar-scale, not a wireframe primitive.
- **Star catalogues for LMC/SMC/Sgr stellar populations** — AT-HYG
  depth doesn't reach LMC/SMC reliably; Sgr dSph red giants are
  marginal. See `SCIENCE.md` § Scope principles — Detail gradient.
- **Chart-mode glyphs for Local Group / dSph members** — owned by
  `stellata-m40.4`.
- **Galactic-disc fade-curve rework** — the current 500 pc / 5 kpc
  band reveals both layers in a single coherent step.

## References

Data sources are committed under `data/local-group/`. Primary
citations:

- **Pace et al. 2024**, *Local Volume Database*, Open Journal of
  Astrophysics (arXiv:2411.07424). CC0.
  <https://github.com/apace7/local_volume_database>
- **Pietrzyński et al. 2019**, *Nature* 567, 200
  (DOI: 10.1038/s41586-019-0999-4) — LMC distance.
- **van der Marel & Kallivayalil 2014**, *ApJ* 781, 121
  (DOI: 10.1088/0004-637X/781/2/121) — LMC structure.
- **Graczyk et al. 2020**, *ApJ* 904, 13
  (DOI: 10.3847/1538-4357/abbb2b) — SMC distance.
- **Subramanian & Subramaniam 2012**, *ApJ* 744, 128
  (DOI: 10.1088/0004-637X/744/2/128) — SMC structure.
- **Ibata et al. 1995**, *AJ* 110, 632 (DOI: 10.1086/192237) —
  Sagittarius dSph discovery + structure.
- **McConnachie et al. 2018**, *ApJ* 868, 55
  (DOI: 10.3847/1538-4357/aae8e7) — M31 inclined-disc structure from
  the PAndAS survey (i ≈ 77°, PA ≈ 37°).
- **Bonanos et al. 2006**, *ApJ* 652, 313 (DOI: 10.1086/508140) —
  M33 Cepheid distance (840 ± 11 kpc) + disc inclination.
- **McConnachie 2012**, *AJ* 144, 4
  (DOI: 10.1088/0004-6256/144/1/4) — Local Group structural review
  used for the M 32 + NGC 205 override entries.
