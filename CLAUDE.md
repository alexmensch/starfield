# Starfield — Claude project notes

Project context and non-obvious constraints for future Claude Code sessions.
Read this before editing.

## What this is

A browser-based interactive 3D star catalog viewer. Loads the ~313k-star
AT-HYG v3.3 catalog (classic-IDs subset), cross-matches it with the GCVS
variable-star catalogue, and renders stars on the GPU. Stars are
rendered as instanced quads with three-pass shading — a depth-only core
mask, an opaque disc pass for close-range stars (physical radius scaled
by catalog absmag + spectral class), and an additive point-glow pass for
distant stars. All three share a unified super-Gaussian intensity
profile whose plateau-vs-Gaussian shape morphs with distance and
luminosity class. Variables pulsate both in disc radius and point glow.
Ships as a Cloudflare Workers static-assets site.

## Repo layout

```
scripts/
  build-catalog.ts        CSV → binary preprocessor (run at build time)
  build-clouds.py         Zucker 2020/2021 → clouds.json (Python; tiny output)
  build-dust.py           Edenhofer dust resampler + particle sampler (Python; LFS outputs)
  sync-dust.ts            mirror data/dust → public/dust on every dev/build
  verify-catalog.ts       sanity-check tool for the generated binary
data/                                All large catalogs tracked via Git LFS.
  athyg_33_classic_ids.csv           AT-HYG source CSV (~64 MB, LFS)
  gcvs5.txt                          GCVS main catalogue (~14 MB, LFS)
  crossid.txt                        GCVS cross-reference (~12 MB, LFS)
  stellarium-modern-skyculture.json  Stellarium constellation lines (~200 KB)
  molecular-clouds/
    zucker2020-tablea1.tsv           Zucker 2020 cloud distances (~88 KB)
    zucker2021-table1.dat            Zucker 2021 3D bounding boxes (~1 KB)
    zucker2021-table2.dat            Zucker 2021 radial profile fits (kept for future)
    zucker2021-table3.dat            Zucker 2021 cloud masses (kept for future)
  dust/
    chunk_X_Y_Z.bin                  64 voxel chunks, 2 MiB each, LFS
    particles.bin                    50K importance-sampled dust points (LFS)
    manifest.json                    grid params + chunk index + particle count
public/
  catalog.bin             generated (gitignored, ~12 MB, binary v3)
  constellations.json     generated (gitignored)
  search-index.json       generated (gitignored, ~13 MB raw, ~2 MB gzipped)
  clouds.json             generated (gitignored, ~30 KB)
  dust/                   gitignored mirror of data/dust/
src/
  worker.ts               Cloudflare Worker entry (just delegates to ASSETS)
  client/
    main.ts               bootstrap
    starfield.ts          Three.js scene + state machine + event bus
    catalog-loader.ts     binary parse into typed arrays
    dust-loader.ts        progressive 3D-texture chunk loader + particle binary loader
    controls.ts           right-side panel widgets (with reverse-sync)
    search.ts             dual-input focus + destination search
    constellation-overlay.ts   SVG stick-figure overlay
    disc-mask.ts          SVG mask tracking the focused star + companion discs
    distance-vector-overlay.ts chevron-based measurement line
    focus-ring-overlay.ts      dashed circle around focused star
    cloud-loader.ts       fetch + parse public/clouds.json
    molecular-clouds.ts   3D ellipsoid render layer + raycast pick + fly-to
    scale-bar.ts          bottom-left distance scale
    unit-toggle.ts        pc/ly toggle in the panel
    theme-toggle.ts       programmatic theme API (no live UI; default dark)
    distance-util.ts      fmtDist, unit state + broadcast, niceRound
    url-state.ts          URL ↔ state sync (debounced)
    info-modal.ts         first-visit welcome modal (localStorage opt-out)
    brand-modal.ts        about / credits modals from the top-left brand box
    constellation-typeahead.ts  filter-by-name+code picker for #con-input
    panel-layout.ts       top-level + per-group collapse for the settings panel
    warp-button.ts        warp trigger (on distance label) + skip pill
    mode-toggle.ts        navigate / observe pill in the top-right card
    observe-controls.ts   look-around controller (drag yaw+pitch, wheel FOV)
    debug.ts              window.debug.* registration; hosts the tuning panel
    debug-panel.ts        generic chrome (slider/colour/section helpers)
    star-tuning.ts        debug section: star-disc profile knobs
    milkyway-tuning.ts    debug section: Milky Way layer tuning
    shaders/
      star.vert.glsl, star.frag.glsl              GLSL3/WebGL2
      dust-particle.vert.glsl, dust-particle.frag.glsl   shelved dust splats
      cloud.vert.glsl, cloud.frag.glsl                   molecular cloud ellipsoids
    index.html, styles.css
```

## Local commands

```bash
npm run build:catalog   # regenerate binary (idempotent)
npm run dev             # preprocess + Vite dev server
npm run build           # full production build
npm run typecheck       # tsc --noEmit over src/ and scripts/
npm run deploy          # wrangler deploy (requires auth)
npx tsx scripts/verify-catalog.ts   # dump header + spot-check records
```

## Documentation index

This file is the always-loaded entry point. The rest of the project's
constraints, formulas, and gotchas live in topic-specific docs that
Claude Code should read on demand when working on the relevant area.

- **`SCIENCE.md`** — every external data source (catalogues, papers, DOIs,
  licences) and the physics/modelling decisions baked into the build
  pipeline and renderer. Read when adding or changing anything
  science-driven, or to look up a citation.
- **`docs/build-and-data.md`** — binary catalog format, search index,
  build scripts (`build-catalog.ts`, `build-clouds.py`, `build-dust.py`),
  Stellarium HIP resolution, geometric-binary inference, GCVS
  cross-match, idempotency. Read when touching `scripts/` or `data/`.
- **`docs/architecture.md`** — event bus, click-state machine, focused
  constellation aim, URL state, floating origin. The cross-cutting
  patterns the rest of the codebase assumes. Read when changing state
  flow, focus/vector behaviour, or anything that reads star positions.
- **`docs/rendering.md`** — star pipeline (instanced quads, three
  passes including the core depth-mask, super-Gaussian intensity
  profile, physical-size, luminosity softness, variability), Milky Way
  volumetric disc, molecular clouds, galactic reference layer (disc +
  grid), HUD (Sol/GC arrows + OBSERVE ring + transition lerp), dust
  extinction. Read when touching anything visual on the WebGL side.
- **`docs/overlays.md`** — SVG layers above the canvas: constellation
  stick-figures, disc-mask, focus ring, distance vector with near-plane
  clipping. (The Sol/GC SVG arrows are documented in `docs/rendering.md`
  alongside the rest of the galactic overlay feature.) Read when
  touching anything in `*-overlay.ts` or `*-mask.ts`.
- **`docs/ui-and-controls.md`** — layout containers, panel reverse-sync,
  TrackballControls tuning, warp animation, two-finger roll, info modal,
  CSS gotchas (`[hidden]` specificity, `backdrop-filter` stacking
  contexts), camera near plane invariant. Read when touching the
  panel/topbar, controls behaviour, or animations.
- **`docs/deployment.md`** — Wrangler config,
  `@cloudflare/workers-types` global leak, `compatibility_date`. Read
  when changing deployment or worker code.
- **`docs/ux-tweaks.md`** — reference table of UX knobs (orbit feel,
  chevron density, focus-ring size, panel defaults, etc.) and where to
  find them. Read when the user asks for a tweak.

## Things deliberately kept out

Noted here so we don't re-debate scope:

- IAU constellation **boundary** datasets (only the asterism lines are
  included — boundaries would be a separate Stellarium dataset).
- HR diagram side panel.
- WASD / flight controls (removed after v1 review).
- Desktop two-finger roll on Chrome / Firefox (no rotate gesture exists in
  those browsers; Safari-only on desktop by design).
- Time-series proper motion (positions are snapshot-only, no T animation).
- Spiral-arm overdensities in the Milky Way volumetric background. The
  Reid et al. masers offer a maser-anchored spiral model that could ride
  atop the smooth disc profile, but the smooth band reads convincingly
  enough that re-introducing higher spatial frequency (and the aliasing
  risk it carries through 32-step raymarching) isn't worth the complexity.
- Irregular / supernova variables (GCVS entries without a period are
  skipped — can't animate without one).
- Temperature-swing component of variable-star brightness change. We use
  `R ∝ √L` (constant-T assumption); real pulsating variables split the
  brightness change between R and T swings. Modelling T changes per
  variable type is more complexity than the visualisation warrants.
