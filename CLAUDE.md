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

## Code conventions — DRY overrides the system prompt

The Claude Code system prompt's "Three similar lines is better than a
premature abstraction" / "a bug fix doesn't need surrounding cleanup"
defaults do NOT apply to this codebase. They are overridden by:

- **Extract at second usage, not third.** When you would write a
  function, constant, schema, or block that already exists in
  substantively the same form elsewhere in the repo, factor it out
  and parameterise the differences. If the two call sites have
  slightly different tolerances, wrap conventions, blend modes, or
  similar — pass those as arguments. That IS the abstraction. Two
  call sites is the trigger; do not wait for a third.
- **Copy-paste with an "attribution comment" is never acceptable.**
  If a prior session's note reads "lift later only if a third call
  site appears", "copy-paste with attribution comment", or similar —
  that note contradicts this rule. Ignore it and do the extract now.
- **Review-grade at write time.** Duplicated logic, magic numbers,
  and parallel implementations are review-blocking defects here. Code
  that would fail review should not be written in the first place.
  Full rules in bd memories `alex-pr-review-style` and
  `stellata-named-constants-and-dry` (run `bd memories <key>` to read).

## Folder & module conventions

The codebase is organised by per-subsystem folder + cross-cutting type
folder + a minimal root. Adding a new module follows five rules so we
don't re-incur the kind of flat-folder / 4kloc-integration-shell drift
that motivated `stellata-9mm.194`:

- **Physical / visual / thematic subsystems get a folder from day 1.**
  When adding the next layer of the model (Local Bubble, nebulae,
  Radcliffe Wave, etc.), the first file lands in `src/client/<name>/`,
  not flat. Day 1 includes: the renderer file, its loader, its
  `*-pure.ts` helpers, its tests, its tuning section. CLAUDE.md's
  module roster gets the entry in the same PR. Existing examples:
  `solar-system/`, `local-group/`, `milkyway/`, `galactic/`,
  `molecular-clouds/`, `chart-mode/`.
- **Cross-cutting plumbing lands in the matching type folder.**
  Includes small one-off helpers — texture/buffer factories, parsers,
  adapters, sentinel constants — not just large utilities. `overlays/`,
  `camera/`, `loaders/`, `ui/`, `util/`, `typeahead/`, `modals/`,
  `debug/`. A new top-level type folder is only justified when 3+
  files belong there.
- **Controllers extract at write time, not retrospectively.** State
  with the shape "state struct + tick + dispose + state-changes-via-method"
  lands as its own controller class. Camera-bound: `camera/<name>-controller.ts`.
  Layer-bound: in the layer folder.
- **`stellata.ts` is the integration shell, not a default home.** New
  module-scope functions — factories, adapters, pure transforms — go
  in their matching subsystem folder even when small (a 5–20 line
  helper still qualifies). Default question before adding a top-level
  `function` / `const` in `stellata.ts`: would a future reader look
  here, or in `shaders/` / `loaders/` / `camera/` / `util/` / the
  layer's folder? If anywhere else, put it there. If genuinely nowhere
  else, that's the signal a new subsystem folder is justified, not
  that `stellata.ts` should grow. Generated artifacts marked
  `// AUTO-GENERATED` cannot host hand-written helpers — pair them
  with a sibling wrapper module (e.g. `foo-data.ts` generated +
  `foo.ts` hand-written) so regen never clobbers the wrapper.
- **No multi-paragraph in-code prose.** Physics derivations,
  calibration rationale, tuning history → `SCIENCE.md` or
  `docs/<area>.md`, with a one-line code-side pointer (`// see
  SCIENCE.md § Star size physics`). Soft ceiling: 12 lines per
  comment block in `src/client/*.ts`. The pure-helpers-extract-at-
  second-use companion to this rule is the DRY override stated in
  "Code conventions" above.

Controller-specific architectural prose lives in the matching
`docs/*.md` (`docs/architecture.md`, `docs/camera-warp.md`,
`docs/camera-observe.md`, `docs/camera-arrival.md`), updated by each
extraction PR as the boundary it documents stabilises. Code-review
patterns that catch recurring bug shapes are in
`docs/authoring-patterns.md`.

## Repo layout

```
scripts/
  build-catalog.ts        CSV → binary preprocessor (run at build time)
  build-clouds.py         Zucker 2020/2021 → clouds.json (Python; tiny output)
  build-local-group.ts    LVDB + overrides.tsv → local-group.json (stellata-38m)
  build-local-group-pure.ts  pure helpers (RA/Dec→ICRS, orient → quaternion, override merge)
  build-local-group-pure.test.ts  vitest tests for build-local-group-pure
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
  bailer-jones-dr3.tsv               Bailer-Jones 2021 DR3 Bayesian distance posteriors (~14 MB, LFS)
  stellarium-modern-skyculture.json  Stellarium constellation lines (~200 KB)
  molecular-clouds/
    zucker2020-tablea1.tsv           Zucker 2020 cloud distances (~88 KB)
    zucker2021-table1.dat            Zucker 2021 3D bounding boxes (~1 KB)
    zucker2021-table2.dat            Zucker 2021 radial profile fits (kept for future)
    zucker2021-table3.dat            Zucker 2021 cloud masses (kept for future)
  local-group/
    lvdb-snapshot.csv                Pace 2024 LVDB dwarf_all (~430 KB, regular git — under the LFS threshold)
    overrides.tsv                    hand-curated LMC / SMC / Sgr structural detail
  dust/
    chunk_X_Y_Z.bin                  64 voxel chunks, 2 MiB each, LFS
    particles.bin                    50K importance-sampled dust points (LFS)
    manifest.json                    grid params + chunk index + particle count
public/
  catalog.bin             generated (gitignored, ~13 MB, binary v4)
  constellations.json     generated (gitignored)
  search-index.json       generated (gitignored, ~13 MB raw, ~2 MB gzipped)
  clouds.json             generated (gitignored, ~30 KB)
  local-group.json        generated (gitignored, ~20 KB)
  dust/                   gitignored mirror of data/dust/
src/
  worker.ts               Cloudflare Worker entry (passthrough to ASSETS)
  client/
    main.ts               bootstrap
    stellata.ts           Three.js scene + state machine + event bus
    star-pipeline.ts      InstancedBufferGeometry + disc/glow/coreMask
                          ShaderMaterials + meshes; owns applyDiscBlendDefaults
                          + setMonochromeBlend + dispose. Extracted from
                          stellata.ts in 9mm.43.
    index.html, styles.css, globals.d.ts
    stellata-events.test.ts integration-shell event-emission test
    disc-blend.test.ts    star-disc/glow blend-equation parity test
    star-pipeline.test.ts dispose + uniform-sharing + blend defaults
    shaders/
      star.vert.glsl, star.frag.glsl              GLSL3/WebGL2
      planet.vert.glsl, planet.frag.glsl          three-pass instanced planet bodies (3re.16-17)
      perceptual-disc.glsl                        shared point-of-light disc/glow chunk (stars + planets)
      dust-particle.vert.glsl, dust-particle.frag.glsl   shelved dust splats
      cloud.vert.glsl, cloud.frag.glsl                   molecular cloud ellipsoids
    # ─── per-subsystem folders (rule 1) ─────────────────────────────
    solar-system/         planet-system, orbit-rings-layer, planet-body-field,
                          perceptual-magnitude, planet-labels, time, time-readout,
                          ephemeris, astronomy-constants, heliopause, first-load,
                          phase-function (+ tests for each)
    local-group/          local-group, local-group-loader, local-group-tuning
                          (+ tests). Local Group wireframes + MW + dwarf labels
    milkyway/             milkyway, milkyway-tuning. Volumetric disc + bulge
    galactic/             galactic-disc, galactic-fade, galactic-grid,
                          galactic-coords (+ tests). Disc outline / b-l grid /
                          GALACTIC_CENTRE_PC / shared fade smoothstep
    molecular-clouds/     molecular-clouds, cloud-loader (+ tests). Shelved
    dust/                 dust-particle-layer (+ tests). Instanced additive
                          billboards; shelved (strength=0 → mesh hidden
                          → zero per-frame cost). DustField + dust-loader stay
                          in loaders/. Extracted from stellata.ts in 9mm.194/70.
    chart-mode/           chart-mode, chart-labels, chart-disc-pure (+ tests).
                          Observe-only paper aesthetic
    hover/                hover-engine, hover-types, hover-pick-disambiguator,
                          per-layer hover providers, formatters/ (5 + tests)
    # ─── cross-cutting type folders (rule 2) ────────────────────────
    overlays/             constellation-overlay, disc-mask (+ pure),
                          distance-vector-overlay, focus-ring-overlay,
                          hud-overlay, poi-overlay, dirty-attr, overlay-project,
                          arrow-fade, arrow-path (+ tests)
    camera/               controls, observe-controls, focus-transition,
                          focus-target, arrival-curves, camera-motion, warp-pure,
                          warp-button, warp-tuning, mode-toggle, star-geometry,
                          star-physics, camera-up-align, up-align-pure, picker,
                          aim-controller, warp-controller, observe-transition,
                          focus-controller (+ tests).
                          timing.ts — CAMERA_LERP_MS / WARP_*_MS /
                          AIM_*_MS / OBSERVE_TRANSITION_MS / DCAM_LOG_FLOOR_PC /
                          WARP_BASE_DIR (canonical camera-wide constants;
                          renamed from warp-constants in 9mm.194.1).
                          picker.ts — pure target resolver; click + hover
                          pick paths for stars / clouds / planets / Local Group /
                          heliopause (extracted from stellata.ts in 9mm.194.3)
                          aim-controller.ts — mode-aware aim slerps (navigate
                          orbit-pivot + observe quaternion-in-place), shared
                          `aimDurationMs` ramp (extracted from stellata.ts in
                          9mm.194.4)
                          warp-controller.ts — 3-phase warp FSM (reorient
                          → fly → post-arrival) + WarpState + tryMidFlyRecentre
                          + swapObserveAnchor + FocusOps cross-controller seam
                          (extracted from stellata.ts in 9mm.194.5)
                          observe-transition.ts — navigate↔observe FSM:
                          ObserveTransitionState + setMode + startExit +
                          startUnfocusLerp + ObserveFocusOps seam (extracted
                          from stellata.ts in 9mm.194.6)
                          up-align-pure.ts — alignCameraUpToQuaternion
                          helper (lifted from stellata.ts in 9mm.194.6;
                          paired with the existing camera-up-align.test.ts
                          algebra fixture)
                          star-physics.ts — per-star camera/screen geometry:
                          fovMinorRad, peakAmplitudeFactor,
                          binaryCompanionFloorPc, minOrbitDistForStar,
                          parkDistForStar, renderedSizePx,
                          renderedDiscPxAtPeak, getChartDiscParams +
                          canonical ZOOM_FLOOR_FRACTION /
                          VAR_TROUGH_FLOOR_FRACTION /
                          BINARY_VIEWPORT_HALF_ANGLE_RAD /
                          BINARY_MIN_DIST_FACTOR (extracted from
                          stellata.ts in 9mm.194.9; sits between
                          star-geometry's pure formulae and the
                          per-frame uniform reads in stellata)
                          focus-controller.ts — focus FSM + focus-park
                          lerp + per-kind FocusTarget factories +
                          pin-engage geometry; FocusOps seam consumed
                          by WarpController; ObserveFocusOps seam
                          consumed by ObserveTransition. Canonical home
                          for GLOBAL_MIN_DIST_PC + PIN_ENGAGE_THRESHOLD_SQ_PC.
                          FrameAnchor (recenterOrigin + worldOffset +
                          starLocalPosition) stays on stellata.ts —
                          cleaner extraction is coupled to the
                          StarPipeline extract (9mm.43). Extracted from
                          stellata.ts in 9mm.194.8.
    loaders/              catalog-loader, dust-loader (+ tests). cloud-loader
                          lives under molecular-clouds/; local-group-loader
                          under local-group/
    ui/                   panel-layout, scale-bar, theme-toggle, unit-toggle,
                          distance-util, distance-gated-label, keyboard-shortcuts
                          (+ pure), dom-util (+ tests)
    util/                 event-bus, url-state (+ tests). Project-agnostic plumbing
    typeahead/            typeahead, typeahead-util, constellation-typeahead,
                          search (+ tests). Picker UI surface
    modals/               info-modal, brand-modal, help-modal, modal-dismiss.
                          Welcome / about / help overlays
    debug/                debug, debug-panel, perf-hud, pin-debug-hud,
                          arrow-fade-debug-hud, star-tuning (+ tests).
                          Debug-panel chrome + per-area tuning sections
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
  cross-match, reference epoch + PM-not-applied contract, idempotency.
  Read when touching `scripts/` or `data/`.
- **`docs/architecture.md`** — event bus, click-state machine, focused
  constellation aim, floating origin, pin-to-center, FocusTarget
  contract. The cross-cutting patterns the rest of the codebase
  assumes. Read when changing state flow, focus/vector behaviour, or
  anything that reads star positions. The 194 extraction chain adds
  per-controller sections (Picker / Aim / Warp / ObserveTransition /
  Focus) here as each one lands.
- **`docs/authoring-patterns.md`** — write-time consistency rules
  (lifecycle pairing, sibling symmetry, sentinel-init for dirty-track,
  single source of truth for time / camera state). Read before adding
  a new `bus.on()` call, a sibling of an existing helper, a sentinel-
  init dirty-track pattern, or any state struct shifted mid-animation.
- **`docs/url-state.md`** — `?v=` URL wire format: v3 envelope,
  presence mask, per-component vec3 sub-masks, legacy v1/v2 decode,
  process for adding a field, console helpers. Read when touching
  `url-state.ts` or changing what serialises to `?v=`.
- **`docs/rendering.md`** — full render stack table (WebGL renderOrder
  + SVG source order + per-layer visibility gates), then the star
  pipeline core: instanced quads, three passes (core depth-mask + disc
  + glow), super-Gaussian intensity profile, physical-size, luminosity
  softness, variable pulsation, per-star dust extinction. Read when
  touching the star shaders or the magnitude / size / dust knobs, or
  when reasoning about why one layer paints on top of another.
- **`docs/galactic-overlay.md`** — galactic disc outline, coordinate
  sphere (b/l grid), Sol/GC SVG arrows, HUD ring, navigate↔observe
  shaft-start lerp. Read when touching any of those layers.
- **`docs/local-group.md`** — Local Group wireframe layer (LMC, SMC,
  Sagittarius dSph, classical dSphs, LVDB ultra-faints — plus M31,
  M33, NGC 205, M 32, IC 10 and the outer-band dIrrs out to 2 Mpc),
  MW label, per-object dwarf labels via the shared distance-gated
  label engine. Data pipeline + override schema (with optional
  standalone-position columns for objects not in LVDB) + orient
  specs + quaternion construction. Read when touching `local-group.{ts,
  test.ts}`, `local-group-loader.ts`, `scripts/build-local-group*.ts`,
  or `data/local-group/`.
- **`docs/molecular-clouds.md`** — cloud ellipsoids: data, shader,
  the unified cloud-as-focus / cloud-as-vector-tip click and warp UX.
  Read when touching `molecular-clouds.ts` or cloud picking.
- **`docs/milky-way.md`** — volumetric disc + bulge: density
  profiles, magnitude-consistency conversion, analytical-only dust,
  render-order placement, brightness/glow calibration. Read when
  tuning `milkyway.{ts,frag.glsl}`.
- **`docs/solar-system.md`** — solar-system layer (`stellata-3re`):
  JPL Standish ephemerides, planet-bodies + orbit-rings + heliopause
  rendering, ecliptic-vs-galactic-plane orientation rule, time `t`
  and the UTC readout, Sol-focus minDistance relaxation, the canonical
  no-URL first-load view (5 AU galactic-centre-aimed park via `first-load.ts`).
  Read when touching `ephemeris.ts`,
  `time.ts`, `planet-system.ts`, `orbit-rings-layer.ts`,
  `planet-body-field.ts`, `perceptual-magnitude.ts`,
  `planet-labels.ts`, `heliopause.ts`, `first-load.ts`, or any
  `planet.*.glsl` / `heliopause.*.glsl` / `perceptual-disc.glsl`.
- **`docs/chart-mode.md`** — paper aesthetic: flat hard-edged discs,
  isobar contours for MW + clouds, the per-frame
  label / glyph engine, picking under chart mode. Read when touching
  `chart-mode.ts`, `chart-labels.ts`, or any chart-specific shader
  branch.
- **`docs/overlays.md`** — SVG layers above the canvas: constellation
  stick-figures, disc-mask, focus ring, distance vector with near-plane
  clipping. (The Sol/GC SVG arrows are documented in
  `docs/galactic-overlay.md` alongside the rest of the galactic
  overlay feature.) Read when touching anything in `*-overlay.ts` or
  `*-mask.ts`.
- **`docs/hover.md`** — hover-label engine, per-layer providers and
  formatters, and the four UX conventions (spell out units, no
  focus-gate on hover, whole-object hit surface for extended objects,
  HTML monospace typography in chart mode). Read when touching
  anything in `src/client/hover/` or adding a hover surface to a new
  layer.
- **`docs/ui-and-controls.md`** — layout containers, panel
  reverse-sync, magnitude presets + override flags, FOV / theme /
  debug-panel hooks, brand box, keyboard shortcuts (single capture-
  phase listener + DOM-relocate modal for the Go / Constellation
  pickers), CSS gotchas (`[hidden]` specificity, `backdrop-filter`
  stacking contexts). Read when touching the panel/topbar.
- **`docs/camera-controls.md`** — near-plane vs minDistance invariant,
  TrackballControls tuning, two-finger roll gesture (platform-split).
  Read when touching camera geometry or gesture handling.
- **`docs/camera-warp.md`** — warp animation (3-phase state machine),
  scale-bar smoothness, navigate↔observe interactions at launch /
  arrival, floating-origin recentre. Read when touching focus travel
  or warp UX.
- **`docs/camera-observe.md`** — OBSERVE mode: look-around controller,
  drag mechanics, momentum, FOV-on-wheel, aim slerps, POI dispatch,
  single/double click handlers, navigate-mode close-zoom unfocus.
  Read when touching observe-mode behaviour.
- **`docs/camera-arrival.md`** — angular-arrival problem and the
  log-distance smoothstep profile the `camera-motion.ts` helper applies
  to focus-park, warp Fly, and unfocus. Worked examples for Sol /
  Betelgeuse, why the two-region `dWindow` split was rejected, why
  warp Phase 3 stays inline. Read when touching `camera-motion.ts`,
  `focus-transition.ts`, or the arrival branches of `updateWarp` /
  `unfocus`.
- **`docs/deployment.md`** — Wrangler config, `@cloudflare/workers-types`
  global leak, `compatibility_date`, `custom_domain` DNS auto-registration.
  Read when changing deployment or worker code.
- **`docs/ux-tweaks.md`** — reference table of UX knobs (orbit feel,
  chevron density, focus-ring size, panel defaults, etc.) and where to
  find them. Read when the user asks for a tweak.
- **`docs/performance.md`** — `perf-hud.ts` instrumentation, the
  `debug.panel()` activation path, the per-frame sections measured in
  `animate()` / `chart-labels.ts`, and the chart-mode optimisations
  (centroid cache, eligibility prefilter, dirty-tracked SVG writes,
  full-tick skip, sorted-distance core-mask window). Read when
  profiling, tuning a hot path, or wiring new instrumentation.

## Temporarily shelved

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
- WASD / flight controls (removed after early review).
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
