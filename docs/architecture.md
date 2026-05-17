# Architecture

Cross-cutting patterns the rest of the codebase assumes: event flow,
state machine for clicks, and the floating-origin precision trick. Read
this before changing focus/vector behavior, state mutation paths, or
anything that reads star positions. For the `?v=` URL wire format see
`docs/url-state.md`.

## Event bus on `Stellata`

Subscribers register via `stellata.on(name, fn)` and receive a typed
payload per event. `on` returns an unsubscribe — call it to detach.
The payload map is `StellataEventMap` in `stellata.ts`.

- `'focus'` (`number | null`) — focused star changed (from any source).
- `'cloudFocus'` (`number | null`) — focused molecular cloud changed.
- `'planetSystem'` (`PlanetSystem | null`) — focused star's planet
  system loaded, cleared, or swapped.
- `'vector'` / `'vectorCloud'` (`number | null`) — distance-vector
  destination changed (mutually exclusive star vs cloud destinations).
- `'filter'` (`Readonly<FilterState>`) — any filter patch applied.
- `'cameraMode'` (`'navigate' | 'observe'`) — camera mode flipped.
  Used by the mode toggle, search-row label swap, and scale-bar
  (which switches to angular degrees in observe).
- `'warp'` (`boolean`) — warp animation start/finish.
- `'pois'` (`readonly number[]`) — observe-mode pinned-star list
  changed.
- `'frame'` (no payload) — called after each render, used by all SVG
  overlays.
- `'state'` (no payload) — fires on any discrete state mutation. This
  is what the URL-sync module listens to. Don't fire it from a
  `'frame'` handler for camera changes — the URL sync has its own
  frame hook with hash comparison for that.

## Click-state machine (`stellata.ts onPointerUp`)

| condition | action |
| --- | --- |
| no focus | focus on clicked |
| clicked = focused, no vector | unfocus |
| clicked = focused, vector drawn | clear vector (stay focused) |
| clicked = vector tip | `focusStar(tip)` — focus-park lerp (or no-op when already inside park), clear vector |
| clicked = other | draw/replace vector from focus → clicked |

This is the UX the user settled on. No double-click, no modifier keys.

Clouds are full participants in this state machine alongside stars — see
`docs/molecular-clouds.md` for how cloud picks dispatch through
`onPointerUp`.

In OBSERVE mode the click-state machine no-ops on the canvas — `onPointerUp`
short-circuits while `cameraMode === 'observe'`. Clicks land on the
custom look-around controller (direct-manipulation drag + wheel-FOV)
instead. The SVG-layer Sol/GC arrow labels remain clickable; they route
through `aimAt(localPoint)`, which has its own observe-mode branch that
slerps the camera quaternion in place.

## OBSERVE mode and the warp state machine

OBSERVE parks the camera at the focused star's local origin and hides
the focal disc via `uHideFocusIdx`. Two gotchas worth noting up front:

1. **`cameraMode` stays `'observe'` throughout an observe→observe warp.**
   `startWarp` from observe disables `observeControls` and sets a
   per-warp `returnToObserve` flag, but does not flip `cameraMode` or
   emit `'cameraMode'`. The animate loop branches on `warpState`
   first, so the value is purely cosmetic during the flight — but every
   listener bound to `'cameraMode'` (mode toggle, search-row
   label, etc.) stays settled. Without this, observe→observe arrival
   visibly flickers through navigate mid-warp.
2. **`finishWarp` re-anchors via `swapObserveAnchor`**, not `setFocus`,
   when `returnToObserve` is true. `setFocus` would see
   `cameraMode === 'observe'` and run its observe-cleanup branch
   (`uHideFocusIdx = -1`, emit `'cameraMode'`), recreating the
   flicker. `swapObserveAnchor` recentres the floating origin, updates
   `focusedStar`, repoints `uHideFocusIdx` to the new anchor, and snaps
   the camera to `(0, 0, 0)` local without touching `cameraMode`.

Source-star hide (`uHideFocusIdx = focusedStar`) stays pinned across the
entire warp duration when launched from observe — the reorient phase
starts with the camera *at* the source star, and unhiding it would
briefly render the disc from inside.

## Picking a constellation aims the camera

`Stellata.aimAtConstellation(conIndex)` swings the camera so the chosen
constellation is centred in view, without moving `controls.target` or
changing orbit radius — only the camera's position on the orbit sphere
moves. The aim point is the brightness-weighted centroid of the top-8
figure stars as ranked by apparent magnitude **from the current orbit
target** (not from Sol). This matters when the user has travelled far
from Sol: the same constellation is still centred on whichever members
visually dominate from *there*, not from Earth.

Called **only from the constellation dropdown change handler** in
`controls.ts`. URL state restore, reset button, and any other path that
sets `highlightCon` via `setFilter` deliberately do **not** trigger the
aim — a shareable URL's camera pose is authoritative, and the "reset"
button means "clear the selection", not "jump somewhere".

In OBSERVE mode the orbit-pivot rotation is degenerate (camera ≈
target), so `aimAtConstellation` instead routes the centroid through
`aimAt(c)`, which slerps the camera quaternion in place — same code
path Sol/GC label clicks use.

## Warp controller (`camera/warp-controller.ts`)

`WarpController` owns the 3-phase warp FSM:

1. **Reorient** — quaternion slerp + radial easing around the source
   anchor, ending with the camera on the A→B line outside the source's
   parking radius. Per-frame `lookAt(A)` in navigate mode; a captured
   `reorientEndQuaternion` for observe-launches where `mag0 ≈ 0`
   collapses the lookAt path.
2. **Fly** — position lerp along the line, delegated to
   `camera-motion.ts`'s `tickArrival` so focus-park, unfocus, and warp
   Fly share one arrival profile. Fires a one-shot mid-Fly
   floating-origin recentre onto the destination via `tryMidFlyRecentre`
   once the camera passes the trajectory midpoint, plus a chart-mode
   plateau-trigger that pivots to phase 3 early when the destination
   disc has flatlined.
3. **Post-arrival** — quaternion slerp back to the warp-start orientation
   (parallax view), plus an observe-mode position lerp `pEnd → B`. Skipped
   on navigate arrivals because `TrackballControls.update()`'s per-frame
   `lookAt(target)` would overwrite a slerped quaternion one frame later.

Public surface — `warpTo(destIdx)`, `warpToCloud(destIdx)`, `skip()`,
`tick(nowMs)`, `isActive()`, `isRecenteredToDest()`, `getWarpInfo()`,
`getWarpPhase(nowMs?)`, `dispose()`.

Cross-controller coupling lives behind the `FocusOps` interface
(declared in `focus-controller.ts`, re-exported from
`warp-controller.ts` for back-compat with prior import paths):
per-kind `FocusTarget` factories, current-focus dispatch,
floating-origin recentre, mutation of `focusedStar` / `focusedCloud` /
vector slots, observe-transition busy gate, and the lerp-cancel pair
`startWarp` calls before claiming the camera. `FocusController` is
the implementor (9mm.194.8); the frame-anchor and vector-slot
methods on the interface are delegated back to the integration shell
via `FrameAnchor` and `setVectorTo` / `setVectorToCloud` deps so the
star-pipeline buffer (`_localPositions`) keeps living next to the
resources it touches.

Bus events emitted from the controller:
- `'warp'` (boolean) — true at startWarp, false at finishWarp.
- `'state'` — at startWarp, at finishWarp (via swapObserveAnchor on
  observe→observe arrivals, or via `setFocus` / `setFocusedCloud` on
  navigate arrivals).
- `'focus'` (number | null) — only from `swapObserveAnchor`.

See `docs/camera-warp.md` for the phase math and `docs/camera-arrival.md`
for the shared Fly arrival profile.

## Aim controller (`camera/aim-controller.ts`)

`AimController` owns the two aim-slerp state machines:

- **navigate slot** — orbits the camera around `controls.target` at
  constant radius, slerping two quaternions that rotate `WARP_BASE_DIR`
  to the start / end radial directions. Disables TrackballControls for
  the duration so its damping doesn't fight the slerp.
- **observe slot** — camera position is fixed at the focal star's local
  origin; only the camera quaternion changes, slerping the live pose
  toward a `lookAt(point)` target. Disables `ObserveControls` so a stray
  drag doesn't fight the slerp.

Both branches share `aimDurationMs`: a linear ramp from `AIM_T_MIN_MS`
(floor for trivial nudges) to `AIM_T_MAX_MS` (cap for a half-circle
swing). The observe branch's swing angle uses the geodesic quaternion
formula `2·acos(|q0·q1|)`; the navigate branch uses the planar
`acos(dir0·dir1)` between unit direction vectors.

Composition split — `Stellata.aimAt(pointLocal)` is the dispatcher that
owns the cross-controller busy gates (`warp.isActive()`,
`cancelUnfocusLerp`, `cancelFocusLerp`, `isObserveTransitionActive`)
before delegating to `this.aim.aimAt(pointLocal)`. The controller knows
only the mode it runs in and its own slot state.

Cancellation contract — `aim.cancel()` drops both slot states but does
**not** touch `controls.enabled` or call `observeControls.enable()`.
That re-enable only happens on natural completion of the slerp.
Cancellation sites (warp start, observe-exit, focus change while in
observe) are moving control elsewhere and own the next input-handler
transition themselves.

## ObserveTransition (`camera/observe-transition.ts`)

`ObserveTransition` owns the navigate↔observe mode-switch orchestrator:

- **`enter` kind** — animated navigate → observe entry. Lerps
  `camera.position` from its current pose to the focal-star local origin
  `(0,0,0)` over `OBSERVE_TRANSITION_MS = 1800` with an inline
  time-smoothstep. `uHideFocusIdx` is held at -1 across the glide so
  the focal star stays visible until the camera parks at it; the finish
  branch then writes `uHideFocusIdx = focusedStar` and enables
  `ObserveControls`.
- **`exit` kind** — animated observe → navigate exit. Captures `forward`
  from `camera.quaternion` at startExit time and translates the camera
  backward along it to `parkDistForStar(focusedStar)` so the user keeps
  facing whatever they were observing. The finish branch sets
  `controls.target = fromPos` (so `TrackballControls`' built-in
  `lookAt(target)` is a no-op for orientation), realigns `camera.up`
  via the lifted `up-align-pure` helper, runs `controls.update()`, and
  re-enables `TrackballControls`. `clearFocusOnExit` routes through
  `focus.setFocus(null)` on landing — the search-row X-button path.
- **`unfocus` kind** — navigate-mode close-zoom outbound park-arrival
  (a7d.2.6). Reuses the state slot but isn't an observe transition;
  delegated to `camera-motion.ts`'s `tickArrival` so focus-park, warp
  Fly, and unfocus all share one arrival profile. `isActive()` and
  `getProgress()` exclude it so overlays gating on observe visibility
  stay steady-state-navigate during close-zoom; `isAnyActive()` is the
  union, used by `Stellata.isCameraBusy()`. The finish branch tightens
  `controls.minDistance` to the parking distance so manual zoom-in is
  bounded.

Public surface — `setMode(mode, opts)`, `startExit(opts)`,
`startUnfocusLerp(from, to, finalMinDist)`, `tick(nowMs)`, `isActive`,
`isAnyActive`, `getProgress`, `cancelUnfocusLerp`, `cancelTransition`,
`dispose`.

Cross-controller coupling lives behind the `ObserveFocusOps` interface
(declared in `observe-transition.ts`): focused-star inspection,
`parkDistForStar` lookup, vector-slot clears at observe entry,
`setFocus` on `clearFocusOnExit`, and the `isCameraBusy` gate setMode
consults before claiming the camera. `FocusController` is the
implementor (9mm.194.8) — `parkDistForStar` reads through the same
`star-physics.ts` helper Stellata used previously, `isCameraBusy`
unions the in-flight warp / aim / focus-lerp / observe states.

Bus events emitted from the controller:
- `'cameraMode'` (CameraMode) — at every successful setMode + startExit
  entry, in lock-step with the field write through
  `setCameraModeValue`.
- `'state'` — at every cameraMode emit, plus at startUnfocusLerp and
  at each finish branch.

Stellata still owns the `cameraMode` field (~20 unrelated read sites)
and writes it through the controller's `setCameraModeValue` dep
callback so the controller's state machine stays the canonical
mode-switcher. `Stellata.setFocus`'s observe-cleanup branch is the one
remaining inline writer that bypasses startExit — it calls
`observe.cancelTransition()` to clear any in-flight slot, then sets
`cameraMode = 'navigate'` and runs an abbreviated snap (no
`controls.target.set(0,0,0)`, no `controls.update()`) because the
focal star is changing and the target needs to wait for the downstream
`recenterFocusToStar` block.

See `docs/camera-observe.md` for the per-feature notes (drag mechanics,
HUD locators, click dispatch) and the inherited contract that the
controller honours.

## FocusController (`camera/focus-controller.ts`)

`FocusController` owns the focus FSM and the focus-park lerp:

- **Focus state** — `focusedStar`, `focusedCloud`, `focusedPlanetSystem`,
  `planetSystemToken`. Mutually exclusive (star ↔ cloud); the second
  setter clears the first via the standard `setFocus(null)` /
  `setFocusedCloud(null)` paths so a single event ordering rule
  (`'cloudFocus'` before `'focus'`) covers every swap.
- **Focus-park lerp** — `focusLerpState` plus `startFocusLerp` /
  `endFocusLerp` so subscribers see exactly one true→false `'focusLerp'`
  edge per lerp regardless of how many `setFocus` writes happen during
  the in-flight animation. `tick(nowMs)` ticks the lerp through
  `tickFocusLerp`; the integration shell dispatches here when
  `isFocusLerpActive()` is true.
- **Click/select-driven focus** — `focusStar`, `setOrbitTarget`,
  `flyToCloud`, `setOrbitTargetCloud`, `unfocus`. Each gates on
  `getWarp().isActive()` and cancels any in-flight focus-park /
  unfocus lerp before claiming the camera.
- **Pin geometry** — `isPinEngaged()`, `getPinEngageThresholdSq()`.
  The per-frame guard reads the controller; see the dedicated
  Pin-to-center section below.
- **`FocusTarget` factories** — `makeStarFocusTarget`,
  `makeCloudFocusTarget`, `currentFocusTarget`. Each closes over the
  current focus state and the controller's deps (catalog, controls,
  camera, bus, frame anchor, clouds getter) so the returned object can
  read absolute / local positions, mutate per-kind state, and emit
  through the shared event bus without exposing controller privates to
  `focus-target.ts`.

Public surface — see the file for the full method list. The cross-
controller seam is the `FocusOps` interface (consumed by WarpController)
and `ObserveFocusOps` (consumed by ObserveTransition); FocusController
implements both, with frame-anchor + vector-slot methods delegated
back to the integration shell.

Construction cycle — `WarpController` and `ObserveTransition` both
take `focus: FocusOps` from `FocusController`, but `FocusController`'s
guards read back into those controllers (`getWarp().isActive()` etc.).
The cycle is broken by `getWarp: () => this.warp` and
`getObserve: () => this.observe` lazy refs: FocusController is
constructed first (with neither dep wired), Warp + Observe are
constructed next (with `focus: this.focus`), and the lazy getters
resolve at first request. This is the same pattern Picker uses for
async-attached layers (`getClouds`, `getLocalGroup`).

Bus events emitted from the controller:
- `'focus'` (number | null), `'cloudFocus'` (number | null),
  `'planetSystem'` (PlanetSystem | null) — focus state mutations.
- `'focusLerp'` (boolean) — focus-park lerp start / end edges.
- `'cameraMode'` (CameraMode) — from `setFocus`'s observe-cleanup
  branch (focal star changing while in observe mode).
- `'state'` — at every focus mutation + focus-lerp edges.

The `FrameAnchor` interface stays on Stellata — `recenterOrigin`,
`getWorldOffset`, `starLocalPosition`, `starLocalPositionInto`. These
read or rewrite the star-pipeline `_localPositions` buffer plus
the `iPositionAttr.needsUpdate` write, which all live next to the
ShaderMaterial they touch. Cleaner extraction is coupled to the
StarPipeline extract (9mm.43) and deferred until then.

## Floating origin (large-world precision)

Close-range orbit of a star far from Sol used to jitter visibly because
Three.js composes its `modelViewMatrix` at float32 precision. At 1 kpc
from Sol, the translation column quantises to ~10⁻⁴ pc — 2–3% of the
min-orbit radius — so every frame the projected position snapped around
by a few pixels.

Fix: the renderer runs in a **floating local frame** whose origin tracks
the currently focused star.

- `Stellata.worldOffset` is the absolute-space coordinate that
  currently sits at the renderer's (0,0,0). Starts at Sol.
- `Stellata._localPositions` (exposed via `stellata.localPositions`)
  is a `Float32Array` of `catalog.positions − worldOffset`. It's bound
  to the `iPosition` instance attribute and is what every overlay and
  pick path projects through.
- `Stellata.recenterOrigin(newOrigin)` (exposed via the `FrameAnchor`
  seam) rewrites the local-positions buffer using JS Number (= float64)
  subtraction and shifts `camera.position` and `controls.target` by the
  same delta so the user sees no jump. The two callers are
  `FocusController.recenterFocusToStar` (focus mutations) and
  `WarpController.tryMidFlyRecentre` (mid-flight pivot onto the
  destination).
- `FocusController.setFocus(idx)` calls `recenterOrigin` on focus.
  **Unfocus does *not* recenter** — `worldOffset` stays at the former
  focal object so camera/target/iPosition all remain in their
  float32-clean local frame. Recentering on unfocus used to cause a
  visible jump (the `idx===null` branch shifted `target` by the focal
  star's full world position, breaking the pin invariant below and
  re-introducing cancellation in the projection chain).
- **Default-load** (a7d.2.8) auto-engages `setFocus(catalog.solIndex)`
  before the first frame so URL-less loads start with the pin engaged
  and the per-Sol orbit floor in effect, matching every other entry
  point (warp arrival, observe→navigate, search-select). The URL
  encoder treats Sol as the canonical default focus and *omits* the
  field when focused on Sol; "explicitly unfocused" rides a separate
  presence bit so the three states (default-Sol / specific star /
  cleared) round-trip unambiguously.

The key precision win: the big `absolute − offset` subtractions happen
in JS float64 on the CPU, producing small float32 deltas near zero with
~10⁻³⁸ resolution. The GPU's modelview matrix then only carries
kilo-parsec-scale values when the camera is far from the local origin
(i.e. zoomed out, where pixel-level jitter is imperceptible anyway).

Implications for code that reads positions:
- **Rendering / projection math** must use `stellata.localPositions`
  (same frame as `camera.position` and `controls.target`). The disc
  mask, focus ring, distance vector, constellation overlay, and all
  `Picker.pickStar` / `renderedSizePx` / `aimAtConstellation` paths
  do this.
- **Distance-from-Sol** (the distSol filter, hover-tooltip distances,
  the Sol locator-arrow label) must use `catalog.positions` *or* must
  compute `||localPosition + worldOffset||` in JS float64. The shader's
  distSol filter consumes a precomputed per-instance `iDistSol`
  attribute instead of `length(iPosition)`, because the latter is now
  a local-frame value. The Sol arrow uses the float64 sum approach so
  its distance label updates correctly under any focus.
- `starLocalPosition(i)` (formerly `starWorldPosition`) returns the
  local-frame vector — use it for camera math, never for Sol-distance.

URL round-trip works without special handling for the focused case
because sender and receiver both recenter on the same focus star.
Camera/target serialise in local frame; loading the URL recenters to
the same absolute origin and the local coordinates apply unchanged.

For unfocused-but-not-at-Sol, the URL serialises a `worldOffset` field
(FIELDS_V2 bit 20, vec3 Float32, appended to the end for forward-compat
with older clients). The encoder emits it when `focusedStar === null`
AND `worldOffset` isn't ≈Sol; cam/tgt then encode in the local frame
and round-trip with full Float32 precision. The loader applies
`setWorldOffset` *before* cam/tgt and resets cam/tgt to defaults so a
missing `view.cam` / `view.tgt` produces a sane pose in the new local
frame. Old URLs without `worldOffset` decode as Sol-anchored (legacy
behaviour).

The general design treats `worldOffset` as a free Float32 vec3 anchor
(not a catalog ref): future object types (clouds, planets, probes,
exoplanets) can each set it on focus without coupling to the star
catalog index space. Float32 precision is sufficient at any magnitude
because the user-visible pose is the cam/tgt offset *within* the
local frame, stored at full Float32 precision relative to the anchor.

## FocusTarget contract

Warp, focus-park lerp, mid-Fly recentre, and any future camera-transition
code consume focusable objects through the **`FocusTarget` interface**
(`src/client/camera/focus-target.ts`). The warp animation has no
kind-switch statements — adding a new focusable kind (planet, probe,
nebula, exoplanet, …) consists of:

1. Implementing the interface (typically as a factory method on
   `FocusController` that returns an object closing over the per-kind
   catalog / state / event-bus references).
2. Plumbing pick / click handling for the new kind so its
   `FocusTarget` can be passed to `startWarp` / `focusStar`-style
   entry points.

That's it. The warp internals (`updateWarp`, `finishWarp`, mid-Fly
recentre, pin guard, scale-bar focus tracking, …) stay agnostic above
this seam and do not need to change. This is the bar set by
stellata-2br.5 — no future-kind work should ever need to touch the
warp animation code again.

### The interface

```ts
interface FocusTarget {
  readonly kind: 'star' | 'cloud';   // extend the union per new kind
  readonly idx: number;
  anchorInto(out: Vector3): boolean;        // absolute-space anchor
  localPositionInto(out: Vector3): boolean; // current floating-frame position
  parkRadius(): number;                     // camera-to-anchor at parked pose
  applyFocus(): void;                       // per-kind state mutation, no events
  emitFocusEvents(): void;                  // deferred event family fire
  physicalRadius(): number | null;          // geometric radius (pc) or null when undefined
  chartPlateauDistance(magBright: number): number | null;  // chart-mode disc plateau distance
}
```

| Method | Role |
|---|---|
| `anchorInto` | Input to `recenterOrigin`. The floating origin lands here when the object is focused. |
| `localPositionInto` | Per-frame `camera.lookAt(...)` source during warp Fly. Also used by overlays that project the object's position, and as the warp's source-`A` derivation in `warpTo` / `warpToCloud`. |
| `parkRadius` | The warp computes `pStart` / `pEnd` as `anchor − travelDir · parkRadius()` for source and destination respectively — symmetric across both endpoints. |
| `applyFocus` | Sets the per-kind `focusedStar` / `focusedCloud` / etc. field, updates derived state (`minDistance`, planet system attach), clears whichever sibling-kind focus was set. **No events fire.** |
| `emitFocusEvents` | Fires the deferred event family — typically `'focus'` / `'cloudFocus'` (plus a sibling-clearing `null` emit when the previously-focused object was a different kind), then `'state'`. Called from `finishWarp` after the camera lands. |
| `physicalRadius` | Geometric radius in parsecs, or `null` when the kind has no single radius (clouds — ellipsoid axes don't reduce to one). Consumed by arrival curves that need angular size — the hybrid curve's inner regime uses `θ = R/d` for the close-approach smoothstep. Kinds returning `null` silently fall back to a log-d profile. |
| `chartPlateauDistance` | Camera-to-anchor distance at which the chart-mode disc plateaus at `uChartDiscMaxPx`, given the current `uChartMagBright` threshold. Returns `null` when the chart-mode treatment isn't a magnitude-driven disc (clouds → isobar contour). Used by `updateWarp` to pivot Fly → phase 3 early when chart mode is active and the destination disc would stop growing perceptibly. |

The applyFocus/emitFocusEvents split is what lets the mid-Fly recentre
(stellata-2br.5) mutate focus state at the trajectory midpoint
without firing UI-visible events ~half a warp duration before the
camera actually arrives — events settle in lock-step with the
landing.

### How the warp consumes it

`WarpState` carries `source: FocusTarget` and `dest: FocusTarget`. The
warp animation reads geometry via the interface methods and mutates
focus state via `dest.applyFocus()` (mid-Fly recentre) and
`dest.emitFocusEvents()` (`finishWarp`). No `destKind` switches
remain in the warp pipeline; the dispatch table sits in the
`makeStarFocusTarget` / `makeCloudFocusTarget` factory methods on
`FocusController`, which is the one place that needs editing when a
new kind is added.

## Pin-to-center (`uPinFocusToCenter`)

After the physical-orbit floor (`R / tan(0.45·fovMinor)` for a Sol-class
star) brings the camera to ~5e-8 pc on close approach, float32 cancellation
in the projection chain (`projectionMatrix * modelViewMatrix * vec4(0)`)
drifts the projected centre by visible pixels even though the focused
star is mathematically at view-origin. Float64 emulation was rejected
as too heavy; instead `star.vert.glsl` exposes a `uPinFocusToCenter: int`
uniform (-1 = disabled). When set, the shader replaces the projection
chain with `projectionMatrix * vec4(0, 0, -dPc, 1)` for the matched
`gl_InstanceID` — bypassing matrix-multiply cancellation entirely. One
int uniform, ~5 lines of GLSL, no CPU cost.

JS-side per frame in `stellata.ts`: pin engages iff
`FocusController.isPinEngaged()`, which checks
`focusedStar !== null && cameraMode === 'navigate'
&& (!warp.isActive() || warp.isRecenteredToDest())
&& !aim.isActive() && !focusLerpState
&& controls.target.lengthSq() < 1e-12`.

The `warp.isRecenteredToDest()` clause relaxes the pin guard for the
post-recentre window of warp Fly: after the mid-Fly recentre
(stellata-2br.5) the destination is at local `(0,0,0)` and the camera
is doing `lookAt(local origin)` per frame, so pin-to-NDC matches the
geometry `lookAt` is already computing. The shader pin then bypasses
any residual Float32 noise in the projection chain through to
`finishWarp`. The `focusLerpState` clause stays unconditional —
focus-park slerps the camera quaternion through an arc that's not
continuously aimed at the focal star, so pinning would snap-jump it
to NDC origin before the slerp finishes rotating into it.

**Load-bearing invariant:** `controls.target` must be `(0,0,0)`
*exactly* (length < 1e-6 pc). Any code path that engages focus while
leaving target at a non-trivial residual silently disengages the pin.
Three residual sources have bitten this:

1. **Sol's catalog offset.** Sol is at AT-HYG `(5e-6, 0, 0)` pc, not
   `(0,0,0)`. `recenterOrigin(solPos)` shifts target by `5e-6` →
   guard fails on first frame.
2. **Float32 truncation on long warps.** `finishWarp`/`focusStar`
   read target from `_localPositions` (Float32Array), then
   `recenterOrigin` shifts target by a delta computed fresh in
   float64. The two representations of `|AB|` differ by Float32 ULP
   (~`|AB|·1e-7`); for Sol→Rigel (265 pc) that's `~5e-5 pc`,
   comparable to Rigel's arrival endOffset → 30%-of-screen drift.
3. **Unfocus from close approach.** Solved by removing the
   `recenterOrigin(0,0,0)` from the `setFocus(null)` branch (see
   above) — `worldOffset` stays put on unfocus.

**Fix for #1 and #2** lives at the choke point in
`FocusController.setFocus`'s `idx !== null` branch: after
`recenterOrigin`, subtract `target` from `camera.position` (preserving
cam-to-target offset) and snap target to `(0,0,0)`. Eliminates both
residuals for every caller of `setFocus`.

Limitations: pan moves target away → pin disengages (intentional;
post-pan the focused star isn't at view centre). Doesn't fire in
observe mode or during aim animations. Pin DOES fire during the
post-recentre window of warp Fly (see `warp.isRecenteredToDest()`
in the guard above); pre-recentre Fly stays guarded because the
focused star is the source, not the destination the camera is
flying toward.

**Where to look:**
- `src/client/shaders/star.vert.glsl` — `uPinFocusToCenter` decl + use site.
- `src/client/camera/focus-controller.ts` — `GLOBAL_MIN_DIST_PC = 5e-3`,
  `PIN_ENGAGE_THRESHOLD_SQ_PC = 1e-12`, `setFocus` body (the
  post-recenter snap to origin in the focused branch; empty unfocus
  branch), `isPinEngaged` gating rules.
- `src/client/stellata.ts` — per-frame pin guard in the animate loop
  (reads `focus.isPinEngaged()` + `focus.getFocusedStar()`).
- `src/client/util/url-state.ts` — `DecodedView.worldOffset`,
  encoder/loader.
- `src/client/util/url-state.test.ts` — round-trip regression test.
- `src/client/debug/pin-debug-hud.ts` — Pin section in the unified debug
  panel (`debug.panel()`); live readouts with latched directional
  extremes. **Always use this when investigating any "star drifts
  off-screen" report.**
