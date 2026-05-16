# Integration-shell decomposition

Authoritative design for `stellata-9mm.194` — the epic that splits the
3947-line `stellata.ts` into a thin composition layer + focused
controller classes, flattens 73 sibling files into thematic subfolders,
and locks the conventions that keep the codebase from drifting back
into the same shape. Read this before executing any of the child beads
194.1 / .3 / .4 / .5 / .6 / .7 / .8 / .9.

## Why this exists

Two costs were piling up: LLM context tokens (every Read of
`stellata.ts` cost ~30k tokens of mostly-irrelevant code) and human
review surface (a 4kloc class with 9 state structs is uncomfortable to
review in isolation). Splitting into per-controller files reduces both
costs and prevents the "one giant file" failure mode from compounding.

The design is bottom-up: extract the leaves (Picker → Aim → Warp →
Observe → Focus) so each PR is mechanical, then absorb the final
Focus controller as the integration test that proves the composition
is clean.

## Folder taxonomy

Two folder categories, plus a tightly-scoped root.

### Per-subsystem folders

Every physical or thematic subsystem of the model owns a folder. The
folder owns the renderer file(s), the layer-specific loader, the
tuning section (debug-panel), `*-pure.ts` helpers, and tests. Today:

- `solar-system/` — planets, orbit rings, planet body field,
  ephemerides, heliopause, time, time-readout, perceptual-magnitude,
  phase-function, astronomy-constants, planet-labels, first-load.
- `local-group/` — local-group, local-group-loader, local-group-tuning.
- `milkyway/` — milkyway, milkyway-tuning.
- `galactic/` — galactic-disc, galactic-fade, galactic-grid,
  galactic-coords.
- `molecular-clouds/` — molecular-clouds, cloud-loader.
- `chart-mode/` — chart-mode, chart-labels.

`solar-system/` is not a special case. It is the heaviest example
(~12 files) of the per-subsystem pattern. `milkyway/` is the lightest
(2 files). Same rule applies.

### Cross-cutting type folders

Plumbing that isn't owned by a single subsystem:

- `overlays/` — SVG over canvas: constellation, disc-mask, focus-ring,
  distance-vector, hud, poi, arrow-fade, arrow-path, dirty-attr,
  overlay-project.
- `camera/` — camera controllers + state machines + picker + camera
  primitives: controls (TrackballControls wrapper), observe-controls,
  picker, aim-controller, warp-controller, warp-pure,
  observe-transition, focus-controller, focus-transition,
  up-align-pure, star-geometry, star-physics, constants,
  warp-button, mode-toggle.
- `loaders/` — only cross-cutting loaders without a layer home:
  catalog-loader, dust-loader.
- `ui/` — HUD widgets, panels, toggles, formatters, keyboard:
  panel-layout, scale-bar, theme-toggle, unit-toggle, distance-util,
  distance-gated-label, keyboard-shortcuts, keyboard-shortcuts-pure,
  dom-util.
- `util/` — generic primitives: event-bus, url-state.
- `typeahead/` — typeahead, typeahead-util, constellation-typeahead,
  search.
- `modals/` — info-modal, brand-modal, help-modal, modal-dismiss.
- `debug/` — debug, debug-panel, perf-hud, pin-debug-hud,
  arrow-fade-debug-hud, star-tuning.
- `shaders/` — GLSL source (unchanged).

### Root

`main.ts`, `stellata.ts`, `index.html`, `styles.css`, `globals.d.ts`,
`stellata-events.test.ts`. (`disc-blend.test.ts` rides at the root
with `applyDiscBlendDefaults`; it moves with the StarPipeline extract
in `stellata-9mm.43`.)

## Folder & module conventions (for future additions)

The five rules below are the convention envelope. They live here as
the authoritative source, in `CLAUDE.md` as a peer to the existing
"Code conventions — DRY overrides the system prompt" section (so they
load every session), and in bd memory
`stellata-folder-and-controller-conventions` (so `bd prime` surfaces
them automatically).

1. **Physical / visual / thematic subsystems get a folder from day 1.**
   When adding the next layer in the closer-to-Sol queue (Local Bubble,
   nebulae, Radcliffe Wave, etc.), the first file lands in
   `src/client/<name>/`, not flat. Day 1 includes: the renderer file,
   its loader (if catalog-driven), its `*-pure.ts` helpers, its tests,
   its tuning section if there's a debug panel hook. `CLAUDE.md`'s
   module roster gets the entry in the same PR.

2. **Cross-cutting plumbing lands in the matching type folder.**
   `overlays/`, `loaders/`, `ui/`, `util/`, `camera/`, `typeahead/`,
   `modals/`, `debug/`. A new top-level type folder is only justified
   when 3+ files belong in it — otherwise it lives in the nearest
   existing folder.

3. **Controllers extract at write time, not retrospectively.** Any
   new state on `Stellata` with the shape "state struct + tick +
   dispose + state-changes-via-method" lands as its own controller
   class. Camera-bound controllers live in
   `camera/<name>-controller.ts`; layer-bound controllers live in the
   layer folder. The integration shell never grows another 4kloc
   monster again — that is what this epic is correcting.

4. **Pure helpers extract at second use, not third.** When a function
   / constant / schema is used in two places, lift to its canonical
   home with a `*-pure.ts` test file in the same PR. Tests IMPORT
   constants, never redefine. (Operational form of
   `stellata-named-constants-and-dry`; overrides the system-prompt
   "wait for the third call site" default.)

5. **No multi-paragraph in-code prose.** Physics derivations,
   calibration rationale, tuning history → `SCIENCE.md` or
   `docs/*.md`, with a one-line code-side pointer
   (`// see SCIENCE.md § Star size physics`). Soft ceiling: 12 lines
   per comment block in `src/client/*.ts`. This is `stellata-9mm.194.7`
   as a permanent rule, not a one-off audit.

These five sit alongside the existing memories `defer-doc-updates`,
`commit-granularity`, `stellata-test-coverage-discipline`,
`stellata-consistency-at-the-seam`, `stellata-rename-and-stale-prose-sweep`.
Together they form the convention envelope going forward.

## Controller boundaries

The five controllers extracted from `stellata.ts`, in bottom-up
extraction order. Each entry locks the public surface, owned state,
owned constants, owned bus events, and composition dependencies that
the corresponding bead (194.3 / .4 / .5 / .6 / .8) will execute
against.

### Picker — `camera/picker.ts` (194.3)

Pure resolver. The click-state machine stays in `stellata.ts` as
composition-layer orchestration. Routing every dispatch back into
Picker via callbacks would make Picker a second integration shell —
moves the coupling, doesn't reduce it.

- **State:** none.
- **Public surface:**

  ```ts
  pickStar(clientX: number, clientY: number, pixelThreshold?: number): number  // -1 = miss
  pickCloud(clientX: number, clientY: number): number | null
  ```

- **Owned helpers / constants:** `sortedDistRange`, `MIN_DISC_HIT_RADIUS_PX`.
- **Deps (constructor):** `renderer.domElement`, `camera`, `catalog`,
  `() => filter`, `() => localPositions`, sorted index views
  (`sortedByDistFromSol`, `sortedDistFromSol`), `() => clouds`, fov
  and viewport uniform refs, `renderedSizePxFn`.
- **Bus events:** none.
- **Dispose:** none (pure functions; no listeners or scene resources).
- **Tests:** prime / fallback tiers, pixel proximity, cluster + Double-Double
  case, spectral-mask filter, distance window.

### AimController — `camera/aim-controller.ts` (194.4)

- **State:** `AimState | null`, `ObserveAimState | null`.
- **Public surface:**

  ```ts
  aimAt(pointLocal: Vector3): void
  cancel(): void
  isActive(): boolean              // navigate-mode aim
  isObserveAimActive(): boolean
  tick(nowMs: number): void
  tickObserve(nowMs: number): void
  dispose(): void
  ```

- **Owned constants:** `AIM_T_MIN_MS`. `AIM_T_MAX_MS` and `WARP_BASE_DIR`
  are shared (see § Shared constants).
- **Bus events:** none today. An `aim: boolean` event is a follow-up
  bead, filed only if/when an overlay or HUD needs it. Keeping .4
  mechanically pure (move-only) reduces review risk.
- **Deps (constructor):** `camera`, `controls`, `observeControls`,
  `() => cameraMode`, `bus`.
- **Dispose:** drop state, unsub.
- **Tests:** slerp lifecycle, cancellation mid-slerp, navigate vs
  observe branches, dispose tear-down, angle/duration ramp pinned
  (`AIM_T_MIN_MS` floor + `2·acos(|q0·q1|)` formula).

### WarpController — `camera/warp-controller.ts` (194.5)

Heaviest controller. Owns the 3-phase warp FSM.

- **State:** `WarpState | null`.
- **Public surface:**

  ```ts
  warpTo(destIdx: number): void
  warpToCloud(destIdx: number): void
  skip(): void
  tick(nowMs: number): void
  isActive(): boolean
  getInfo(): WarpInfo | null
  dispose(): void
  ```

- **Owned helpers:** `startWarp`, `finishWarp`, `updateWarp`,
  `destLocalPositionInto`, `swapObserveAnchor` (whose only consumer is
  `finishWarp`). `shiftWarpWaypoints` stays in `camera/warp-pure.ts`
  as a pure helper and is imported.
- **Owned constants:** `WARP_T_MIN_MS`, `WARP_T_MAX_MS`, `WARP_T_K_MS`.
  `WARP_REORIENT_MS`, `OBSERVE_TRANSITION_MS`, `WARP_BASE_DIR` are
  shared (see § Shared constants).
- **Bus events:** `'warp'`.
- **Deps (constructor):** `camera`, `controls`, `observeControls`,
  `material.uniforms` (`uHideFocusIdx`), `() => clouds`,
  `() => cameraMode`, `bus`, and a **FocusOps shim**. In .5,
  WarpController takes a `stellata` reference and calls existing
  methods directly (`recenterFocusToStar`, `setFocus`,
  `setFocusedCloud`, `currentFocusLocalPos`, `parkDistForStar`). In
  .8 those methods migrate to FocusController and WarpController's
  import seam updates in one line.
- **Tests:** 3-phase FSM transitions, source/dest variants
  (star→star, star→cloud, cloud→star, observe→observe), skip
  paths, phase-3 quaternion-pin + recentre coordination,
  coincident-source bail (`distPc < 1e-6`).

### ObserveTransition — `camera/observe-transition.ts` (194.6)

- **State:** `ObserveTransitionState | null` (covers `'enter'`,
  `'exit'`, and `'unfocus'` kinds). The state slot is **owned here**
  even though `FocusController.unfocus()` writes into it: ObserveTransition
  exposes `startUnfocusLerp(...)` from day 1; the focus path calls in.
- **Public surface:**

  ```ts
  setMode(mode: CameraMode, opts: { animate?: boolean }): void
  startExit(opts: { animate: boolean; clearFocusOnExit: boolean }): void
  startUnfocusLerp(fromPos: Vector3, toPos: Vector3, finalMinDist: number): void
  tick(nowMs: number): void
  isActive(): boolean              // excludes 'unfocus' per current contract
  isAnyActive(): boolean           // includes 'unfocus' — drives isCameraBusy
  getProgress(): { f: number; kind: 'enter' | 'exit' } | null
  dispose(): void
  ```

- **Owned constants:** `OBSERVE_TRANSITION_MS` (shared).
- **Bus events:** `'cameraMode'`.
- **Deps (constructor):** `camera`, `controls`, `observeControls`,
  `material.uniforms` (`uHideFocusIdx`), `bus`, FocusOps,
  `() => focusedStar`. The `alignCameraUpToQuaternion` private lifts
  to `camera/up-align-pure.ts` so the controller can import it
  without inheriting from `Stellata`.
- **Tests:** all 4 mode-switch entry points (mode pill, keyboard O,
  click while focused, double-click in observe), the swap-anchor edge
  case, the unfocus-lerp variant with its `finalMinDistance`
  write-back, dispose clears state without flicker.

### FocusController — `camera/focus-controller.ts` (194.8)

Largest controller; extracted last. Absorbs the FocusOps shim that
WarpController carried since .5.

- **State:** `focusedStar`, `focusedCloud`, `focusedPlanetSystem`,
  `planetSystemToken`, `focusLerpState`.
- **Public surface** (also the `FocusOps` interface other controllers
  consume — defined as a TS interface in `camera/focus-controller.ts`
  and re-exported so WarpController / ObserveTransition can depend
  on the interface, not the concrete class):

  ```ts
  // queries
  getFocusedStar(): number | null
  getFocusedCloud(): number | null
  getFocusedPlanetSystem(): PlanetSystem | null
  isPinEngaged(): boolean
  isFocusLerpActive(): boolean
  currentFocusLocalPos(): Vector3 | null
  parkDistForStar(idx: number): number
  minOrbitDistForStar(idx: number): number
  // commands
  focusStar(idx: number, opts?: { animate?: boolean }): void
  setFocus(idx: number | null): void
  setFocusedCloud(idx: number | null): void
  setOrbitTarget(idx: number): void
  setOrbitTargetCloud(idx: number): void
  flyToCloud(idx: number, opts?: { animate?: boolean }): void
  unfocus(opts?: { animate?: boolean }): void
  cancelFocusLerp(): void
  cancelUnfocusLerp(): void
  // internal seams (called by warp / observe — exported via @internal)
  recenterFocusToStar(idx: number): Vector3 | null
  startFocusLerp(state: FocusLerpState): void
  // tick
  tick(nowMs: number): void
  dispose(): void
  ```

- **Owned constants:** `GLOBAL_MIN_DIST_PC`, `ZOOM_FLOOR_FRACTION`,
  `VAR_TROUGH_FLOOR_FRACTION`, `PIN_ENGAGE_THRESHOLD_SQ_PC`,
  `BINARY_VIEWPORT_HALF_ANGLE_RAD`, `BINARY_MIN_DIST_FACTOR`.
  `FOCUS_LERP_MS` and `DCAM_LOG_FLOOR_PC` are shared.
- **Bus events:** `'focus'`, `'cloudFocus'`, `'planetSystem'`,
  `'focusLerp'`.
- **Deps (constructor):** `camera`, `controls`, `catalog`, `bus`,
  FrameAnchor (recenterOrigin), ObserveTransition (the unfocus-lerp
  dispatch), `material.uniforms` (`uHideFocusIdx` for the
  observe-cleanup branch).
- **Tests:** near-focus / far-focus / cancel mid-lerp / pin-engage
  threshold, observe-cleanup branch on focus change, unfocus close-zoom
  path, worldOffset preservation invariant on unfocus.

## Cross-cutting decisions

### `worldOffset` ownership — FrameAnchor on Stellata

`worldOffset`, `_localPositions`, `recenterOrigin`, and the per-frame
pin uniform write stay on the composition shell. Controllers consume
a small interface:

```ts
interface FrameAnchor {
  recenterOrigin(newOrigin: Vector3): Vector3 | null
  getWorldOffset(): Readonly<Vector3>
}
```

This is a TS interface, not a new file. The `_localPositions`
instance buffer is the star pipeline's `iPositionAttr` data — clean
extraction is likely coupled to the StarPipeline extract
(`stellata-9mm.43`) and is deferred until then.

### Click FSM stays on Stellata

`onPointerUp`, `handleObserveClick`, `observeSingleClick`,
`observeDoubleClick`, `Target`, `sameTarget` stay on the composition
shell. They orchestrate Picker / Focus / Vector / Aim / POI — that
**is** the composition layer's job. The architecture doc points
readers here for the click-state machine; no relocation.

### POIs and vector destinations stay on Stellata

`pois`, `togglePoi`, `setPois`, `clearPois`, `getPois`, `vectorTo`,
`vectorToCloud`, `setVectorTo`, `setVectorToCloud` — small
mutually-exclusive state slots written primarily by the click FSM.
Stay on `Stellata`, emit on bus directly. Not worth their own
controller.

### `aimAtConstellation` stays on Stellata

Single-method dispatch into AimController (after computing the
brightness-weighted centroid). Self-contained on the composition
shell.

### Star-physics helper — `camera/star-physics.ts` (194.9)

Lifts `renderedSizePx`, `renderedDiscPxAtPeak`, `fovMinorRad`,
`peakAmplitudeFactor`, `getChartDiscParams`,
`getFocusedStarPeakDiscRadiusPx` into a single module. Consumers:
Picker, FocusController, chart-mode pipeline, overlays.

Extracted as **its own bead 194.9**, parallel-trackable with .7
(comment audit) and the render-pipeline extracts (9mm.43 StarPipeline,
9mm.70 DustParticleLayer). Lands before .8 (FocusController consumes
it); doesn't block any other controller. Numeric outputs pinned
(`expect(parkDistForStar(SIRIUS_IDX)).toBe(N)`) per
`stellata-test-coverage-discipline`.

### Shared constants — `camera/constants.ts`

Single source of truth for:

- `CAMERA_LERP_MS` (canonical 2 s for non-warp camera lerps)
- `FOCUS_LERP_MS`, `WARP_REORIENT_MS`, `AIM_T_MAX_MS` (derived
  references to `CAMERA_LERP_MS` — preserves the "one literal so the
  three motions read as the same family" invariant from the original
  file)
- `OBSERVE_TRANSITION_MS`
- `WARP_BASE_DIR`
- `DCAM_LOG_FLOOR_PC`

Lands in **194.1** so every subsequent controller imports from a
stable path. Tests import these constants; they are never redefined.

### Bus event ownership

Each owning controller emits its typed event. The `'state'` fan-out
also fires from the owning module, not relayed through `Stellata`.
`'frame'` stays on `Stellata`'s animate loop. `'pois'` stays on
`Stellata` (POIs aren't lifted).

## Composition shape after extraction

Constructor wiring order in `Stellata`:

1. Renderer / camera / scene / shared uniforms / star pipeline meshes
   (unchanged).
2. TrackballControls + ObserveControls.
3. Catalog precomputes (`sortedByDistFromSol`, `sortedDistFromSol`,
   `_localPositions`, `iPositionAttr`).
4. Scene layers (galactic disc, orbit rings, planet body field,
   heliopause, galactic grid, HUD overlay, Milky Way — unchanged).
5. Controllers, in dep order:
   - `picker = new Picker({...})`
   - `focus = new FocusController({frameAnchor: this, ...})`
   - `aim = new AimController({getMode: () => this.cameraMode, ...})`
   - `observe = new ObserveTransition({focus, ...})`
   - `warp = new WarpController({focus, getClouds: () => this.clouds, ...})`
6. `focus.setFocus(catalog.solIndex)` — Sol auto-engage.
7. `this.on('cameraMode', mode => mode !== 'observe' && this.clearPois())`.
8. `attachEvents()`, `animate()`.

Dispose: reverse order (warp → observe → aim → focus → picker → scene
layers → renderer).

`animate()` dispatcher:

```ts
if      (warp.isActive())        warp.tick(now);
else if (aim.isActive())         aim.tick(now);
else if (focus.isFocusLerpActive()) focus.tick(now);
else if (aim.isObserveAimActive()) { aim.tickObserve(now); observeUpdateTarget(); }
else if (observe.isAnyActive())  observe.tick(now);
else if (cameraMode === 'observe') { observeControls.update(); observeUpdateTarget(); }
else controls.update();
```

`isCameraBusy()` becomes a single OR across the four
`isActive` / `isAnyActive` calls.

## Extraction sequence and dependency graph

Bottom-up. Each step ships as its own PR with the smoke + tests in
the child bead's description.

| Step | Bead | Module | Cross-controller dep at this step | How resolved |
| --- | --- | --- | --- | --- |
| 1 | 194.1 | folder reorg + `camera/constants.ts` | n/a (mechanical move) | Single PR; no logic changes. |
| 2 | 194.3 | `camera/picker.ts` | none (leaf) | Land mechanically. |
| 3 | 194.4 | `camera/aim-controller.ts` | reads `cameraMode` | Inject `() => stellata.cameraMode`. |
| 4 | 194.5 | `camera/warp-controller.ts` | FocusController not extracted yet | Shim: WarpController takes `stellata` and calls existing focus methods. Swap to `FocusOps` interface in step 6. |
| 5 | 194.6 | `camera/observe-transition.ts` | shares state slot with `unfocus()` | `startUnfocusLerp` is public from day 1; `stellata.unfocus()` calls it. |
| 6 | 194.8 | `camera/focus-controller.ts` | absorbs warp's shim; co-imports star-physics | One-line import swap in WarpController; FocusController's exported `FocusOps` is what WarpController + ObserveTransition depend on. |

Parallel tracks (independent of 194.3-.8, after 194.1 lands):

- **194.7** — comment density audit; relocates multi-paragraph
  in-code prose to SCIENCE.md / docs/*.md.
- **194.9** — `camera/star-physics.ts` extraction; blocks .8.
- **9mm.43** — StarPipeline class extract.
- **9mm.70** — DustParticleLayer extract.

`stellata.ts` drops below 1500 lines at .8 landing — the epic-level
acceptance gate.

## Test strategy

Per `stellata-test-coverage-discipline`:

- **Per controller:** state-machine transition tests + dispose
  tear-down. State machines pin both the "happy path" and the
  cancellation paths each controller participates in.
- **`Stellata.dispose()`:** integration test extended after each
  extraction step, catching `stellata-9mm.187`-class lifecycle leaks
  at the per-step granularity rather than only at the end.
- **`stellata-events.test.ts`:** extended each step with an
  owning-controller event-source assertion (the `'warp'` event
  asserts the source is WarpController, etc.).
- **`star-physics.test.ts` (194.9):** numeric-output pinning
  (`expect(parkDistForStar(SIRIUS_IDX)).toBe(N)`); never use
  `toBeLessThanOrEqual` for calibrated values.
- **Per-controller smoke:** specified in each child bead's
  description.

## Pointers

- `docs/architecture.md` — event bus, click-state machine, floating
  origin, pin-to-center. The cross-cutting patterns these controllers
  preserve.
- `docs/camera-warp.md` — warp animation 3-phase state machine,
  navigate↔observe interactions at launch / arrival, floating-origin
  recentre. The contract WarpController inherits.
- `docs/camera-observe.md` — OBSERVE-mode look-around controller,
  navigate↔observe transitions, POI dispatch, single/double click
  handlers, close-zoom unfocus. The contract ObserveTransition + the
  click FSM inherit.
- `stellata-9mm.194` — the parent epic; children carry the
  per-controller acceptance + smoke + test surface.
- `stellata-folder-and-controller-conventions` — bd memory carrying
  the five rules from § "Folder & module conventions"; loaded every
  session via `bd prime`.
- `stellata-code-quality-epic`, `stellata-consistency-at-the-seam`,
  `stellata-named-constants-and-dry`,
  `stellata-rename-and-stale-prose-sweep`,
  `stellata-test-coverage-discipline`,
  `stellata-pattern-coverage-across-peers` — the operational rules the
  extractions execute against.
