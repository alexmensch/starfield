# Performance instrumentation + optimisations

How to profile a running build, what's already been tuned, and where to
look first when something feels slow.

## Running the perf HUD

The HUD is an opt-in dev tool, not a user feature. Activation paths:

- **`debug.panel()`** in the dev console — opens the unified debug
  panel; the Perf section is one of four
  collapsible sections inside it. Opening the panel installs the
  instrumentation (one-shot, swaps the module-level no-op
  `mark`/`measure`/`frame` functions to real implementations).
  Calling again toggles the panel off; instrumentation stays installed
  so ring buffers keep filling and the histogram has data on re-open.
  Collapsing the Perf section gates per-tick DOM writes but not the
  ring-buffer fills.

There is **no URL param and no keyboard shortcut.** Both paths existed
during the original profiling work and were removed deliberately —
end users could land on the HUD by accident, and the data is only
useful to a developer who can read the section labels.

The Perf section shows three rolling-window stats up top
(`FPS avg`, `low`, `gpu Xms`) over a sortable section table
(top 8 by avg ms, descending) and a 60-frame `frame.total`
histogram. The DOM updates at ~5 Hz so the panel itself doesn't show
up as a hot path in its own measurements.

## Instrumented sections

The instrumentation is structured as named `mark`/`measure` pairs that
write into per-label ring buffers (60 frames) and an end-of-frame
`frame()` that flips them. Sections silent for a full ring window
get garbage-collected so e.g. `chart.*` entries drop off the HUD
after exiting chart mode (otherwise the average would lag forever).

| Label                   | Where (`src/client/`)            | What it measures |
| ----------------------- | -------------------------------- | ---------------- |
| `frame.total`           | `stellata.ts` `animate()`       | Full frame body, the histogram source. |
| `controls.update`       | `stellata.ts` `animate()`       | TrackballControls / observe-controls update branch. |
| `pre-render`            | `stellata.ts` `animate()`       | Per-frame uniform writes + galactic + Milky Way reposition. |
| `coreMask`              | `stellata.ts` `animate()`       | The binary-search `shouldEnableCoreMask()` (see below). |
| `gpu.render`            | `stellata.ts` `animate()`       | The `renderer.render()` call — three-pass star draw + overlays. |
| `onFrame.total`         | `stellata.ts` `animate()`       | The full `'frame'` emit loop (overlays, chart labels). |
| `chart.names`           | `chart-labels.ts` `tick()`       | Proper-name label projection + culling. |
| `chart.bayer`           | `chart-labels.ts` `tick()`       | Bayer-letter Greek-glyph pass. |
| `chart.constellations`  | `chart-labels.ts` `tick()`       | Constellation centroid recompute + label placement. |
| `chart.clouds`          | `chart-labels.ts` `tick()`       | Molecular cloud labels (no-op while clouds are shelved). |
| `chart.collision`       | `chart-labels.ts` `tick()`       | Sort + greedy AABB collision pass. |
| `chart.dom`             | `chart-labels.ts` `tick()`       | SVG attribute writes for surviving labels. |
| `chart.glyphs.var`      | `chart-labels.ts` `tick()`       | Variable-ring `<circle>` projection + emission. |
| `chart.glyphs.bin`      | `chart-labels.ts` `tick()`       | Binary-wing `<line>` projection + emission. |

Adding a measurement: import `mark`/`measure` from `perf-hud.ts` and
wrap the block. Both functions are unconditional — when
`buildPerfSection` has not yet been called they're a single indirect
call to a no-op, V8 inlines them fine. Don't subscribe the HUD itself
to the `'frame'` event; the `frame()` flush runs once per render after
`onFrame.total` has finalised, so its DOM update doesn't leak into
the measured numbers.

## What got optimised

Ordered by impact. Each item shipped as a separate commit.

### `shouldEnableCoreMask` — sorted-distance binary-search window

`stellata.ts:2578`. The core depth-mask is only useful when a star
is rendered close enough to the camera to occlude others, so the
test is "any star within `dThresh` pc of the camera?" The original
implementation scanned all 313k positions every frame in every
mode.

Build-time setup (`stellata.ts:546`): sort the indices by distance
from Sol once; store the sorted index and parallel distances as
`Uint32Array` + `Float32Array`. At query time, compute
`camDistFromSol = (camera.position + worldOffset).length()` (the
absolute frame, not the floating-origin local frame), binary-search
for `[camDistFromSol − dThresh, camDistFromSol + dThresh]`, and
walk only that window. Triangle-inequality guarantees no candidate
falls outside it.

Typical window: 50–500 candidates instead of 313k. Same boolean
result.

### Chart-labels: scratch `Vector3` for projection

`chart-labels.ts:136`. `projectVec()` originally allocated a fresh
`Vector3` per call via `p.clone().applyMatrix4(...)`. With four
candidate sets (proper names, Bayer, variables, binaries) that's
5–15k Vector3 allocations per frame, the dominant GC pressure
source.

Replaced with a module-level `projVec` scratch deliberately
*not* aliased with the existing `tmpV3` — the latter is held
across the projection in `projectStar`, so a shared scratch would
clobber the input.

### Chart-labels: cached constellation centroids

`chart-labels.ts:240`. Constellation centroids are flux-weighted
positions over every member star (88 constellations × ~30 members
per frame, with `Math.pow` per member). The centroid barely moves
under camera translation since the constellation spans hundreds of
pc and the camera typically moves ≪ 1 pc per frame.

Cache the centroids and recompute only when either condition fires:

- Camera moved more than `√CENTROID_RECOMPUTE_DIST_SQ ≈ 0.5 pc`
  since the last recompute.
- Filter version bumped (subscribed via `stellata.on('filter', …)`).

The centroid is still re-projected to screen every frame (88 cheap
matrix transforms) — it's the inner per-member loop that's elided.
Net: ~30× reduction in `chart.constellations` on a stationary
camera.

`startChartLabels()` initialises `lastCentroidCamPos` to NaN so the
first frame after entering chart mode always recomputes.

### Chart-labels: pre-binned eligibility lists for variables + binaries

`chart-labels.ts:120`. The variable / binary index lists run to a
few thousand entries. Each frame the previous code walked the full
list, applied the spectral-mask + min/max distance-from-Sol gates
(static parts of `renderableAppMag`), then projected.

Pre-bin into `variableEligible` / `binaryEligible` on filter change
(via `stellata.on('filter', …)`); the per-frame loops drop the
spectral + distance-from-Sol checks because eligibility already
encodes them, and the cheap remaining work (magnitude gate +
projection) only runs against the pruned set. Restrictive filters
typically cut the eligible set by 80–90%.

This pass also reordered the loops so the `appMag > maxAppMag`
test runs *before* projection (free win — pure reorder).

### Chart-labels: dirty-tracked SVG attribute writes

`chart-labels.ts:132`. `setAttribute` triggers SVG attribute
parsing + style invalidation even when the new value matches the
old. The pooled label / circle / line objects now cache the last
written `x` / `y` / `cx` / `cy` / `r` / `x1` / `x2`. Skip the
write when the new value differs by less than `ATTR_DIRTY_PX = 0.05`
(matches the `.toFixed(1)` display precision so visually identical
attributes are coalesced). Drives `chart.dom` toward zero on a
stationary camera once the centroid cache is in.

### Chart-labels: full-tick skip when nothing changed

`chart-labels.ts:251`. The chart label engine's output is purely a
function of camera pose, filter state, and viewport size — variable
pulsation animates on the GPU via `uTime`, the CPU labels don't
move. Hash that tuple at the top of `tick()`:

```ts
camera.position.equals(lastTickCamPos) &&
camera.quaternion.equals(lastTickCamQuat) &&
centroidsVersion === lastTickFilterVersion &&
w === lastTickViewportW &&
h === lastTickViewportH
```

When all five match, the entire body returns early before any
projection. NaN sentinels on `startChartLabels()` entry guarantee
the first frame after engaging chart mode always runs.

This is the asymptote: idle chart-mode CPU cost approaches
navigate-mode idle cost.

### Overlay self-gating fast-paths

`disc-mask.ts`, `distance-vector-overlay.ts`, `poi-overlay.ts`,
`focus-ring-overlay.ts`. Each overlay subscribes to `'frame'` and
runs every frame regardless of state. The empty-state path (no
focus / no vector) bails in <10 ns before doing any DOM work.
Visibility transitions are tracked via a local boolean so
`hide()` / `show()` are idempotent — no redundant `display`
mutations or `setAttribute` sweeps when the state didn't change.

Don't unsubscribe / resubscribe — the on/off churn is fragile
and the static fast-path is enough.

## What we deliberately did *not* do

Each was considered and rejected; flagged here so it doesn't get
re-prosecuted.

- **Throttle the chart engine to 30 Hz.** Tempting on idle, but
  observe-mode look-around drag is the case where the engine is
  most active, and 30 Hz labels against 60 Hz GPU render stutter
  visibly. The full-tick skip (above) gets the same idle win
  without the regression risk.
- **Move label projection to GPU (transform feedback / compute).**
  Would require rebuilding chart-mode rendering as instanced quads
  with a glyph atlas, throwing away CSS theming, crisp DPI scaling,
  and accessibility text. The CPU side is close enough to free with
  dirty tracking.
- **Optimise the O(n²) collision pass.** Bounded by accepted-label
  count (a few hundred); not the bottleneck. `chart.collision`
  consistently shows up below `chart.dom` in HUD readings.

## Where to look first when something is slow

1. Open dev console, run `debug.panel()` and expand the Perf section.
   Sit in the suspect mode
   for ~5 s with hands off; then again under typical interaction.
2. Read the section table top-down. The histogram tells you whether
   it's a sustained cost or a periodic spike.
3. If `gpu.render` dominates, the bottleneck is in shaders /
   overdraw — see `docs/rendering.md` and the milky-way / dust
   docs.
4. If `onFrame.total` dominates and it's not chart mode, suspect a
   per-frame overlay; check the self-gating fast-paths haven't
   regressed.
5. If `chart.*` dominates, the eligibility lists or centroid cache
   may have invalidated unexpectedly — check whether the `'filter'`
   event is firing more than expected.
