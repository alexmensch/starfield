# Local Group wireframe layer

A second always-on reference overlay alongside the Milky Way disc
(`docs/galactic-overlay.md`). Renders LineLoop outlines for the Magellanic
Clouds, Sagittarius dSph, classical dSphs, and LVDB ultra-faints within
250 kpc of Sol — plus the Milky Way label (the disc itself stays in
`galactic-disc.ts`; only the SVG label lives here).

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
                      Sagittarius dSph.

scripts/
  build-local-group.ts        I/O orchestration + idempotency.
  build-local-group-pure.ts   pure helpers (RA/Dec→ICRS, quaternion
                              construction per orient kind, override
                              merge, distance filter). vitest-covered.

public/local-group.json       generated artifact (gitignored).
```

Refresh of `lvdb-snapshot.csv` is a manual step — per
`frozen-external-data` the build never reaches the network:

```
curl -sSL \
  https://raw.githubusercontent.com/apace7/local_volume_database/main/data/dwarf_all.csv \
  -o data/local-group/lvdb-snapshot.csv
npm run build:local-group -- --force
```

## Override schema

`data/local-group/overrides.tsv` carries one row per object whose LVDB
summary is too coarse for meaningful 3D rendering:

| Column              | Notes |
| ------------------- | ----- |
| `name`              | Matches LVDB's `name` column for merge. |
| `a_pc / b_pc / c_pc`| Local-frame semi-axes in parsecs. |
| `orient`            | Orientation spec — see below. |
| `label_threshold_pc`| Camera-to-object distance for label fade-in; empty = no label. |
| `ref_doi`           | Primary structural reference. |

Override **replaces** the structural detail an LVDB row would otherwise
produce; **position (RA/Dec/distance) still comes from LVDB.** Other
LVDB-only dwarfs render as sky-plane oblate ellipsoids from
`rhalf_physical` + `ellipticity` + `position_angle` — no override row
needed.

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

- A per-frame visibility predicate (camera-to-object-centre distance
  past the threshold; chart mode hides).
- A silhouette-sample generator. The MW label samples **32 points
  around the 15 kpc disc rim** (galactic-disc.ts's
  `MIDPLANE_RADIUS_PC`) — anchoring at the GC bulge center sat the
  label on the small ~3 kpc core instead of the disc edge, so the
  rim ring is the right silhouette curve for the label-engine's
  support-point picker. Per-object dwarf labels use the same
  12 × 5 + 2 = 62 sample grid as the heliopause.
- The same screen-space anchor convention as the heliopause: bottom-
  right at a constant 10 px gap.

### Threshold policy

The MW and LG labels use **opposite** predicate directions because
Sol's relation to each is different:

| Family                                        | Predicate | Threshold |
| --------------------------------------------- | --------- | --------- |
| MW label                                      | `camera-to-GC ≥ T` (fires when **outside** the disc; Sol sits inside it) | `MW_LABEL_THRESHOLD_PC` = 10 kpc |
| Override-supplied (Large MC, Small MC at 30 kpc; Sgr at 10 kpc) | `camera-to-object ≤ T` (fires when **close enough** to identify) | `overrides.tsv` `label_threshold_pc` column |
| Classical dSph (M_V ≤ −7.5, no override)      | same close-approach | `DEFAULT_LABEL_THRESHOLD_PC` = 20 kpc |
| Ultra-faint (M_V > −7.5, no override)         | same close-approach | `SIZE_RELATIVE_LABEL_FACTOR × max(axes)` (N = 10) — so a 50 pc Bootes II surfaces inside ~500 pc, a 270 pc Sculptor-class inside ~2.7 kpc |

The fallback policy lives in `effectiveLabelThresholdPc(obj)`, exported
from `local-group.ts` for testability (the DOM-binding wrapper around
`createDistanceGatedLabel` isn't directly unit-testable). From the
canonical first-load park at Sol every LG object is tens of kpc away
— **all hidden by design**; labels reveal as the camera flies in.

The size-relative factor `N` (default 10) is mutable at runtime
through the **Deep field** debug-panel section
(`src/client/local-group-tuning.ts`). The predicate re-reads the live
factor each frame, so slider tweaks apply without re-mounting the
labels. `DEFAULT_SIZE_RELATIVE_LABEL_FACTOR` is the build-time
constant tests pin against; `getSizeRelativeLabelFactor()` /
`setSizeRelativeLabelFactor()` are the runtime accessors.

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

- **M31, M33, NGC 205, M32, IC 10, NGC 6822, and Leo A / IC 1613 /
  WLM** — past the current 250 kpc camera envelope. Tracked under
  `stellata-1ui` (1.5–2 Mpc expansion; deferred).
- **Star catalogues for LMC/SMC/Sgr stellar populations** — AT-HYG
  depth doesn't reach LMC/SMC reliably; Sgr dSph red giants are
  marginal. See `stellata-cds-data-sources-and-detail-gradient`.
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
