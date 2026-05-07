# Stellata — Claude project notes

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
  catalog-pure.ts         pure helpers (parseSpectral, physicalRadius, GCVS parsers, inferBinaries)
  catalog-pure.test.ts    vitest tests for catalog-pure
data/                                All large catalogs tracked via Git LFS.
  athyg_33_classic_ids.csv           AT-HYG source CSV (~64 MB, LFS)
  gcvs5.txt                          GCVS main catalogue (~14 MB, LFS)
  crossid.txt                        GCVS cross-reference (~12 MB, LFS)
  hip_ccdm.tsv                       Hipparcos HIP↔CCDM cross-reference (LFS) — visual-doubles flag
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
  catalog.bin             generated (gitignored, ~13 MB, binary v4)
  constellations.json     generated (gitignored)
  search-index.json       generated (gitignored, ~13 MB raw, ~2 MB gzipped)
  clouds.json             generated (gitignored, ~30 KB)
  dust/                   gitignored mirror of data/dust/
src/
  worker.ts               Cloudflare Worker entry (passthrough to ASSETS)
  client/
    main.ts               bootstrap
    stellata.ts          Three.js scene + state machine + event bus
    catalog-loader.ts     binary parse into typed arrays
    dust-loader.ts        progressive 3D-texture chunk loader + particle binary loader
    controls.ts           right-side panel widgets (with reverse-sync)
    search.ts             dual-input focus + destination search
    constellation-overlay.ts   SVG stick-figure overlay
    disc-mask.ts          SVG mask tracking the focused star + companion discs
    distance-vector-overlay.ts chevron-based measurement line
    focus-ring-overlay.ts      dashed circle around focused star
    poi-overlay.ts        observe-mode pinned-star labels + arrows + rings
    cloud-loader.ts       fetch + parse public/clouds.json
    molecular-clouds.ts   3D ellipsoid render layer + raycast pick + fly-to
    scale-bar.ts          bottom-left SVG widget: scene-scale bar + perspective z-axis indicator pointing at the focused star/cloud
    unit-toggle.ts        pc/ly toggle in the panel
    theme-toggle.ts       programmatic theme API (no live UI; default dark)
    distance-util.ts      fmtDist + fmtDistAuto (pc/ly above 0.01 pc, AU below), unit state + broadcast, niceRound
    url-state.ts          URL ↔ state sync (debounced)
    info-modal.ts         first-visit welcome modal (localStorage opt-out)
    brand-modal.ts        about / credits modals from the top-left brand box
    constellation-typeahead.ts  filter-by-name+code picker for #con-input
    typeahead-util.ts     shared helpers for the two typeaheads (cap, hover-class swap)
    dom-util.ts           shared escapeHtml for innerHTML splicing
    panel-layout.ts       top-level + per-group collapse for the settings panel
    warp-button.ts        warp trigger (on distance label) + skip pill
    mode-toggle.ts        navigate / observe pill in the top-right card
    observe-controls.ts   look-around controller (drag yaw+pitch, wheel FOV)
    debug.ts              window.debug.* registration; hosts the tuning panel
    debug-panel.ts        generic chrome (slider/colour/section helpers)
    star-tuning.ts        debug section: star-disc profile knobs
    milkyway-tuning.ts    debug section: Milky Way layer tuning
    pin-debug-hud.ts      debug.pin() — focused-star pin diagnostics
    arrow-fade-debug-hud.ts  debug.arrows() — Sol/GC arrow draw state + fade
    keyboard-shortcuts.ts global keydown dispatch (R/G/C/H/S/O/W/M/+/−/=/?/Esc)
    help-modal.ts         shortcut help overlay (the `?` target)
    chart-mode.ts         observe-only chart-mode orchestrator (theme + isobar + label engine)
    chart-labels.ts       per-frame chart label engine + SVG glyphs (variable rings, binary wings)
    planet-system.ts      per-star PlanetSystem data model + Sol planet table (3re.6 groundwork)
    star-system.ts        per-host orbit-rings + planet bodies layer (3re.7, 3re.4)
    planet-labels.ts      per-planet body-anchored labels for the focused host (3re.4 / 3re.9 contract)
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
npm test                # vitest run (regression-prevention suite)
npm run test:watch      # vitest in watch mode
npm run test:coverage   # vitest run with v8 coverage
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
- **`docs/rendering.md`** — star pipeline core: instanced quads, three
  passes (core depth-mask + disc + glow), super-Gaussian intensity
  profile, physical-size, luminosity softness, variable pulsation,
  per-star dust extinction. Read when touching the star shaders or
  the magnitude / size / dust knobs.
- **`docs/galactic-overlay.md`** — galactic disc outline, coordinate
  sphere (b/l grid), Sol/GC SVG arrows, HUD ring, navigate↔observe
  shaft-start lerp. Read when touching any of those layers.
- **`docs/molecular-clouds.md`** — Phase 3a cloud ellipsoids: data,
  shader, the unified cloud-as-focus / cloud-as-vector-tip click and
  warp UX. Read when touching `molecular-clouds.ts` or cloud picking.
- **`docs/milky-way.md`** — Phase 5 volumetric disc + bulge: density
  profiles, magnitude-consistency conversion, analytical-only dust,
  render-order placement, brightness/glow calibration. Read when
  tuning `milkyway.{ts,frag.glsl}`.
- **`docs/chart-mode.md`** — Phase 8 paper aesthetic: flat
  hard-edged discs, isobar contours for MW + clouds, the per-frame
  label / glyph engine, picking under chart mode. Read when touching
  `chart-mode.ts`, `chart-labels.ts`, or any chart-specific shader
  branch.
- **`docs/overlays.md`** — SVG layers above the canvas: constellation
  stick-figures, disc-mask, focus ring, distance vector with near-plane
  clipping. (The Sol/GC SVG arrows are documented in
  `docs/galactic-overlay.md` alongside the rest of the galactic
  overlay feature.) Read when touching anything in `*-overlay.ts` or
  `*-mask.ts`.
- **`docs/ui-and-controls.md`** — layout containers, panel
  reverse-sync, magnitude presets + override flags, FOV / theme /
  debug-panel hooks, brand box, keyboard shortcuts (single capture-
  phase listener + DOM-relocate modal for the Go / Constellation
  pickers), CSS gotchas (`[hidden]` specificity, `backdrop-filter`
  stacking contexts). Read when touching the panel/topbar.
- **`docs/camera-modes.md`** — TrackballControls tuning, near-plane
  vs minDistance invariant, warp animation (3-phase state machine),
  OBSERVE camera mode + look-around controller, two-finger roll
  gesture (platform-split). Read when touching camera state, focus
  travel, or gesture handling.
- **`docs/deployment.md`** — Wrangler config, `@cloudflare/workers-types`
  global leak, `compatibility_date`, `custom_domain` DNS auto-registration.
  Read when changing deployment or worker code.
- **`docs/ux-tweaks.md`** — reference table of UX knobs (orbit feel,
  chevron density, focus-ring size, panel defaults, etc.) and where to
  find them. Read when the user asks for a tweak.
- **`docs/performance.md`** — `perf-hud.ts` instrumentation, the
  `debug.perf()` activation path, the per-frame sections measured in
  `animate()` / `chart-labels.ts`, and the chart-mode optimisations
  (centroid cache, eligibility prefilter, dirty-tracked SVG writes,
  full-tick skip, sorted-distance core-mask window). Read when
  profiling, tuning a hot path, or wiring new instrumentation.

## Temporarily shelved (v1.0)

Code paths preserved; rendering / visibility disabled until the visual
treatment is refined. Don't refactor the underlying machinery away.

- **Molecular cloud overlay.** `molecular-clouds.ts`, `cloud-loader.ts`,
  the cloud shaders, and `data/molecular-clouds/` all stay; the user
  toggle is removed from settings and `FilterState.showMolecularClouds`
  defaults to `false`. URL flag bit 2 is reserved for the prior
  encoding. Chart-mode still calls `setCloudsIsobar` against the
  invisible layer so the integration is intact for re-enable.
- **Volumetric Milky Way in chart mode.** `Milkyway.setIsobar` now
  hard-hides the disc + bulge meshes when chart engages instead of
  emitting an isobar contour. The chart-isobar uniform / blending
  switches stay wired so the contour pass can return.

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

## PR template — `## Release notes` block is required

Every PR with a `package.json` version bump must fill the
`## Release notes` block in the PR body (Summary / New features /
Bugfixes / Changes). The deploy workflow extracts that block and
publishes it to the GitHub release page for the version this PR
ships, replacing the previous flat auto-generated notes. The
`release-notes-guard` CI check fails the PR if the section is empty
(HTML comments don't count). PRs labelled `skip-version-bump` are
exempt. See `RELEASING.md` for detail.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
