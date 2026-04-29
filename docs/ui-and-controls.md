# UI and controls

The right-side settings panel, top-left brand surface,
TrackballControls tuning, the warp animation, gestures, layout
containers, and a few CSS gotchas that bit hard enough to be worth
documenting.

## Brand box and About / Credits modals

`.ui-top-left` is a fixed top-left container holding the "Starfield"
title plus a small `about · credits` link row (always visible — no
hover affordance, since touch devices have no hover state). Both
links open `<div class="modal">` cards that reuse the welcome-modal
styling. ESC, the close button, or the backdrop dismisses; there's
no "don't show again" opt-out because the modals are user-initiated.

`brand-modal.ts` wires both modals via `data-modal-dismiss`
attributes on the close button and backdrop. The `.ui-top-left`
container sits independently of `.ui-top` so changes to the
right-side stack's width / wrap behaviour don't affect the brand.

## Per-group collapse in the settings panel

Two layers of collapse: the panel as a whole (top-level, key
`starfield.panel-collapsed`) and each `<section class="group"
data-group="...">` independently (key
`starfield.group-collapsed.<name>`). Both default to expanded;
both persist to `localStorage`. Wired in `panel-layout.ts`. The
group header is the click target — `<header class="group-header">`
with an `<h3>` title and a chevron `<button class="group-toggle">`.
`.row-actions` (reset / all / none) live inside `.group-body`, not
the header, so their clicks don't bubble into the toggle.

## Constellation typeahead

`constellation-typeahead.ts` replaces the old `<select id="con-select">`
with an `<input id="con-input">` + dropdown. Substring filter against
constellation name plus 3-letter IAU code; full alphabetised list shows
when the input is empty and focused. Single-select — picking fires
both `setFilter({ highlightCon })` and `aimAtConstellation`, matching
the prior `<select>` behaviour. Reverse-sync from `onFilterChange`
keeps the input in step with URL restores. Reset button (`#con-reset`)
clears the highlight.

## Reverse-sync in `controls.ts`

Widgets subscribe to `starfield.onFilterChange` and write DOM from the filter
state. This is how URL restores and `naked eye`/`all` presets update sliders
and chip states. **Setting `.value` programmatically does NOT dispatch
`input`**, so there's no feedback loop. If you add a filter field, remember
to handle it in `syncFromFilter`.

The FOV control reads `starfield.getCameraFov()` directly inside
`syncFromFilter` rather than going through `FilterState` — FOV lives on
the camera, not the filter — but otherwise behaves the same. `setCameraFov`
fires the filter-change handlers so the slider re-syncs after a debug-panel
or URL-restore change.

## Magnitude presets and override flags

Three magnitude presets live in `MAG_PRESETS` (`starfield.ts`): `naked-eye`,
`binoculars`, `all`. Buttons in the panel dispatch on `data-preset` →
`starfield.applyMagnitudePreset(name)`. The preset is the canonical source
of `maxAppMag` and `sizeSpan`, plus angular sizeMin/Max which are converted
to pixels per current viewport.

Per-field override flags (`sizeMinOverridden`, `sizeMaxOverridden`,
`sizeSpanOverridden` on `FilterState`) decide whether a preset switch
or viewport resize gets to write into that field. Slider input sets the
flag; the per-section reset buttons (`size-reset`, `span-reset`) call
`clearSizeOverrides([...])` which clears the flag(s) and writes the
active preset's value back. `maxAppMag` has no override flag — clicking
a preset always sets it; the magnitude slider can still tweak it (and
the value survives viewport resizes since `recomputePresetPxSizes` only
touches sizeMin/Max).

URL state carries `preset=` when not on the default (`naked-eye`); `mag=`
only when diverged from the active preset's value; `smin/smax/span` only
when their override flag is true. Receiver applies the preset first, then
layers the explicit overrides on top.

## Field of view

User-facing slider in the panel (`#fov`, 10°–120° / 1° step) plus a reset
button that snaps to `DEFAULT_FOV` = 50°. `setCameraFov` updates
`camera.fov`, calls `updateProjectionMatrix()`, and triggers
`recomputePresetPxSizes` since arcsec/px depends on FOV.

## Debug panel

`window.debug.panel()` toggles a free-floating tuning panel. As of the
brand-rework it hosts a single section: Milky Way (brightness, density,
palette, dust). The earlier Starfield section (FOV + exaggeration K)
was retired once both controls became user-facing in the settings
panel. Generic chrome lives in `debug-panel.ts`; section builders are
in `*-tuning.ts` files. Add a new tool by writing a `build*Section`
and appending it inside `togglePanel` in `debug.ts`.
`window.debug.milkyway()` is kept as a legacy alias.

## Star size exaggeration

`#exag` slider in the Camera group — range 1 (Realistic) to 20
(Extreme), step 0.5. Drives `setStarExaggerationK`, which patches the
*active* preset's K (one of `STAR_EXAGGERATION_K_DEFAULTS`: naked-eye
= 12, binoculars = 9, all = 5) and runs `computeMagPresets` to derive
new angular size targets. The slider snaps to the active preset's K
on every preset change, and the reset button restores that preset's
default. Defaults are calibrated per preset because the visible star
population shifts dramatically with the magnitude limit — naked-eye
needs more exaggeration to feel populated, while "all" with ~313k
stars needs a smaller K to avoid the field becoming a solid wash.
Pure physical sizing leaves most stars sub-pixel at typical viewports
— at 50° / 1080-tall, K=1 puts the threshold-disc star at ~0.18 px
and floors it to 1 px. The 1-px floor in `computePresetPxSizes` is
applied symmetrically to sizeMin and sizeMax so the saturation disc
never inverts below the threshold disc at low K.
`recomputePresetPxSizes` additionally enforces `max >= min` post-patch
to handle the case where the user has manually overridden one of the
two and the other gets recomputed to a value that would invert.

## Theme

Locked to dark in the live UI. The `setMonochrome` plumbing on
`Starfield` and the `body.monochrome` palette in CSS are intentionally
retained — `applyTheme('mono')` from the console flips the chart-mode
palette for future repurposing. There's no longer a UI toggle and no
URL `t=` param.

## Camera near plane vs controls minDistance

`camera.near = 0.001`, `controls.minDistance` (when no star is focused)
= `DEFAULT_MIN_DIST_PC = 0.005` pc. The near plane must stay **strictly
less** than the closest orbit distance, otherwise a centered star lands
on the clip plane at max zoom and gets culled. If adjusting, keep that
invariant. Earlier attempts to zoom closer than 0.005 pc hit float32
precision jitter when the destination star is far from the world origin.

When a star is focused, `controls.minDistance = minDistForStar(idx)` —
**not** the 0.005 pc default. `minDistForStar` is the single source of
truth for the camera's "near-star" landing distance, used by:

- `controls.minDistance` (orbit-zoom clamp).
- Observe-exit landing position (camera pulls back to `minDistForStar`
  along its current view direction when leaving observe).
- Warp source departure (`pStart = A + dirBack × minDistForStar(destIdx)`).
- Warp arrival (`pEnd = B − forward × minDistForStar(destIdx)`).

It's computed from a per-star disc-size formula:

```
sizeAtRef = mix(uPhysMinPx, uPhysMaxPx, logRatio(physicalRadius))
discDist  = sizeAtRef × uRefDistPc / TARGET_APPROACH_DISC_PX
```

Same on-screen disc size at parking for any star — supergiants land
much further out than dwarfs. The single tunable is
`TARGET_APPROACH_DISC_PX` at the top of `starfield.ts` (currently 10
px). Binary companions still get a `Math.max(discDist, sep × BINARY_MIN_DIST_FACTOR)`
bump on top so both components stay inside the viewport half-angle
(~25°) at max zoom — the binary requirement is additive, not a
replacement.

Mirrors the disc term of `renderedSizePx` exactly. Keep the two in sync
if the shader's physical-size math changes.

## TrackballControls tuning

We're using `TrackballControls`, not `OrbitControls`, because the user wants
unbounded orbit past the poles (`OrbitControls` clamps polar angle, stalling
at the zenith/nadir — you'll see `cx=0` in the URL when it happens).

Current settings:
- `rotateSpeed = 3.0` (TBC defaults high; 3 feels natural)
- `zoomSpeed = 1.1`
- `panSpeed = 0.6`
- `dynamicDampingFactor = 0.15` (this is the damping knob; not
  `enableDamping`/`dampingFactor` like OrbitControls)
- `staticMoving = false` (keeps damping on)
- `noPan = false` (right-click pans; set `true` to disable)
- `minDistance = 0.005`, `maxDistance = 100_000`

## Warp animation

An animated camera flight between the focused star (A) and the distance
vector destination (B). Trigger: click the yellow distance label on the
SVG overlay (hovering reveals a "→ Warp" suffix), or press `W`. Skip: the
muted ghost pill at top-center (shown only while warping), or `Esc` /
`Space`. Click-tip-to-travel is an instant teleport that routes through
`focusStar(idx)` for consistency with search-select (2 pc viewing
distance, camera teleports along with the orbit target).

Two- or three-phase animation in `starfield.ts updateWarp`, depending
on whether the warp re-enters OBSERVE on arrival:

1. **Reorient** (`WARP_REORIENT_MS` = 2000). Camera position
   spherically slerps around A from wherever the user was to `A +
   dirBack × endOffset` (on the travel line, offset behind A from B's
   perspective). Simultaneously the orbit distance eases linearly from
   `mag0` down to `endOffset`. End state: A is centered and B is
   straight ahead, beyond A. Quaternion slerp is used for the angular
   interp (robust against antipodal starting positions). `endOffset`
   is `minDistForStar(destIdx)` — see §Camera near plane vs controls
   minDistance for the disc-size formula plus binary bump.

   Camera orientation during the reorient depends on launch mode:
   - **Navigate launch:** `camera.lookAt(A)` is called every frame.
     With `mag0 > 0` this keeps A perfectly centered as the camera
     swings around it.
   - **Observe launch** (`returnToObserve`, `mag0 ≈ 0`): the
     lookAt-per-frame approach degenerates — the camera starts on top
     of A, so `lookAt(A)` snaps to "facing forward" the instant the
     position moves off A. Instead we slerp the camera quaternion from
     `startQuaternion` (the user's observe view direction) to a
     `reorientEndQuaternion` captured at warp start (= the orientation
     `lookAt(A)` would produce from `pStart`). This animates the user's
     view smoothly turning from wherever they were looking to "facing
     the destination" before the fly phase begins.

2. **Fly** (log-scaled duration, `WARP_T_MIN_MS` to `WARP_T_MAX_MS`).
   Straight-line lerp from `pStart` (= A + dirBack × endOffset) to
   `pEnd` (= B − forward × endOffset) with a symmetric
   accelerate/decelerate profile: `f(t) = 2t²` for `t < 0.5`, else
   `1 − 2(1−t)²`. `camera.lookAt(B)` throughout.

3. **Post-arrival reorient** (only when `returnToObserve`, duration =
   `OBSERVE_TRANSITION_MS` = 1200 ms). Quaternion slerps from the
   fly-end "looking at B" orientation back to the `startQuaternion`
   snapshot taken at warp start. The user sees the same celestial
   direction they were facing when they picked the destination, now
   from the new vantage — foreground stars shift via parallax, distant
   Milky Way stays roughly fixed.

   Camera position **also lerps from `pEnd` to `B`** across this
   phase, so the parallax view ends with the camera exactly at the
   destination star. Without this, `swapObserveAnchor` would absorb
   an `endOffset`-sized hidden teleport at `finishWarp` (its
   `set(0,0,0)` snap), leaving the user with the impression that the
   slerp happened from the wrong vantage. The destination disc stays
   visible across the entire post-arrival window — `swapObserveAnchor`
   pins `uHideFocusIdx` to the destination only at `finishWarp`, so
   the user sees the star they're arriving at right up until the
   camera parks inside it. Hiding it earlier would feel like the star
   pops out before the camera arrives.

   Skipped on navigate-mode arrivals because `TrackballControls.update()`
   calls `camera.lookAt(target=B)` every frame and would overwrite the
   slerped quaternion one frame after `finishWarp`, leaving the user
   with a hard snap-back. Observe arrivals preserve the slerp because
   controls are disabled and `observeUpdateTarget` reads
   `controls.target` from the camera quaternion, not the other way
   around.

Scale bar smoothness: `controls.target` is pointed at **B** from the
moment the warp begins (not just at arrival). Camera orientation is
controlled independently via `camera.lookAt`, so the reorient phase can
still keep A centered visually while the scale bar already reflects
distance-to-destination — this avoids a jarring scale-bar snap when the
target would otherwise switch from A to B at arrival.

During warp: `controls.enabled = false` (no orbit), pointer-up click
handling is short-circuited, URL writer skips frame-hash updates (camera
is changing every frame and we don't want to serialise intermediate
poses), and `body.warping` toggles a CSS class that hides the entire
SVG overlay (distance vector, figure, focus ring) since their per-frame
reprojection looks chaotic under fast travel.

Warp launched from OBSERVE leaves `cameraMode` as `'observe'` for the
duration (the animate loop branches on `warpState` first, so the value
is purely cosmetic) and keeps `uHideFocusIdx` pinned to the source star
across all three phases — the reorient starts with the camera at A, and
unhiding it would briefly render the focal disc from inside. See
`docs/architecture.md` §OBSERVE mode and the warp state machine for the
finishWarp anchor-swap that avoids a mid-warp UI flicker.

Distance-label-as-warp-trigger UI:
`index.html` wraps the distance label and a static `→ Warp` sibling
`<text>` in a `<g id="dist-ui">`. The group has `pointer-events: auto`
and `:hover` reveals the warp suffix via CSS opacity transition. The
label itself is still `text-anchor="middle"` and positioned dead-center
on the measurement vector; the warp suffix is computed each frame as
`mx + label.getComputedTextLength()/2 + WARP_GAP_PX` so the distance
stays visually anchored while the suffix extends to the right.

## OBSERVE camera mode

A second camera mode that parks the camera at the focused star and
swaps `TrackballControls` for a custom look-around controller. Toggled
via the navigate / observe pill in the top-right card (`#mode-toggle`,
wired in `mode-toggle.ts`). The OBSERVE button is disabled until a star
is focused — the underlying `setCameraMode('observe')` no-ops without
an anchor, but disabling the button advertises the affordance up-front.

**Camera state on enter:** position lerps to `(0, 0, 0)` local (the
focused star's position under the floating origin) over
`OBSERVE_TRANSITION_MS = 1200 ms`. The focal star stays visible across
the glide and is hidden via `uHideFocusIdx = focusedStar` only at
`finishObserveTransition`'s `enter` branch — once the camera is parked
on top of it. Hiding it at transition start would feel like the star
vanishes before the camera arrives. `controls.enabled = false`;
`observeControls.enable()` after the transition completes. The
`animate=false` URL-restore path skips the transition and sets
`uHideFocusIdx` immediately, since there's no glide to defer to.

**Look-around controller (`observe-controls.ts`):**
- Drag rotates the camera in place: yaw around `camera.up`, pitch
  around the screen-right axis derived from the live quaternion.
- **Pitch is FPS-style clamped** (`PITCH_LIMIT = π/2 − 0.01`). Yaw is
  rotation around the world-up axis (`camera.up`); without the clamp,
  pitching past the pole flips the screen-right axis and the next yaw
  input feels like left/right are swapped — the classic FPS pole
  singularity. Shoemake-style 6-DOF (yaw around camera-local up) is
  the only alternative and was rejected because it loses the stable
  horizon.
- Wheel adjusts `camera.fov` (1.5° per notch, clamped 10–120°) instead
  of camera distance. Distance has no meaning when the camera is
  parked.
- Two-finger roll still works — `rollCamera` mutates `camera.up` for
  navigate-mode persistence and additionally rotates `camera.quaternion`
  around the forward axis when `cameraMode === 'observe'` (the orbit
  controls' camera-up read-back path doesn't run in observe, so a
  bare `camera.up` change wouldn't be visible).

**HUD locators:** Sol and Galactic-Centre arrows skip their normal 3D
projection (degenerate when camera ≈ focal star) and anchor at screen
centre with a `STAR_GAP_PX` (9 px) offset, pointing toward the
projected target. See `docs/rendering.md` §Galactic reference system
for the HUD-path branch.

**Aim from observe:** `aimAt(localPoint)` (Sol/GC labels +
constellation typeahead) has an observe-mode branch that builds a
target quaternion via `Matrix4.lookAt(camera.position, point,
camera.up)` and slerps the live quaternion to it, capped at
`AIM_T_MAX_MS = 2000`. `observeControls.disable()` for the duration so
drag input doesn't fight the slerp; re-enabled at completion. The
`aimAtConstellation` path also routes here in observe — orbit-pivot
math is degenerate at observe range.

**Search row labels:** the search-tag swaps "Focus" → "Location" via
`syncFocusUI` reading `getCameraMode()` on every focus / mode change.
Cloud entries are filtered out of the location picker (`focusRunQuery`
in `search.ts` drops `kind === 'cloud'` when in observe) — observe is
star-only by design.

**Picking a new location** routes through `warpTo(idx)` instead of
`focusStar(idx)`. The warp animation flies between anchors and the
post-arrival slerp leaves the camera pointing in the original celestial
direction from the new vantage — see §Warp animation phase 3.

**X button (clear focus from observe):** `unfocus()` detects observe +
focused-star and immediately clears focus *before* starting the
zoom-out animation. The search box empties via `onFocusChange` on the
click, then the camera pulls back to `minDistForStar(formerFocal)`
along its current view direction over `OBSERVE_TRANSITION_MS`. Capturing
`forward` from the camera quaternion before the recenter (frame-
invariant) keeps the animation aimed correctly even though
`setFocus(null)` translates camera position into Sol-centric coords
mid-call.

`finishObserveTransition` then sets `controls.target` to the
transition's `fromPos` (the observed star's location, in whichever
frame is current). Two reasons:
- The exit translates the camera backward along its forward direction
  by `minDist`, so `fromPos` lies exactly along forward at that
  distance — `TrackballControls.update()`'s built-in `lookAt(target)`
  is therefore a no-op for orientation, and the user keeps facing
  whatever they were observing.
- Setting `target = (0,0,0)` instead would point at Sol once
  `setFocus(null)` recentred the origin, and the lookAt would whip
  the camera around to face Sol. Using `fromPos` works for both the
  unfocus path (`fromPos` = star's Sol-centric position) and the
  focus-retained path (`fromPos` = `(0,0,0)` = the focused star
  before the recenter that wasn't called), since both paths capture
  `fromPos` from the camera position right before the lerp begins.

**URL state:** `mode=observe` round-trips the mode flag, applied after
camera params + `controls.update()` so the saved pose lands first. The
URL writer's debounced frame hook skips writes during
`isObserveTransitionActive()` (mirrors the warp guard).

## Two-finger roll gesture (platform-split)

`starfield.ts` adds a two-finger rotate gesture that rolls the view around
the center of the screen by rotating `camera.up` around the forward vector
(`target - position`). TrackballControls reads `camera.up` every `update()`,
so the new orientation persists through subsequent orbit/zoom without
touching the controls' internals.

Implementation split:

- **Mobile / touch** — listens for `touchstart`/`touchmove` with exactly two
  touches, computes the `atan2` angle between them, and applies the delta
  per move. Single-finger drags are ignored (TrackballControls handles them
  via pointer events, separate from the touch event stream, so there is no
  conflict).
- **Desktop Safari** — listens for the non-standard `gesturestart` /
  `gesturechange` events (WebKit only). `event.rotation` is degrees,
  cumulative since `gesturestart`, positive clockwise. We `preventDefault`
  to suppress Safari's page-level zoom; TrackballControls still receives
  the accompanying wheel events for pinch-zoom.
- **Chrome / Firefox on desktop** — no rotate gesture exists in those
  browsers (two-finger trackpad is scroll-only, pinch fires wheel+ctrlKey
  but no rotation). Roll is unavailable there by design. Do not spend
  effort trying to polyfill it.

Sign convention: finger rotation CW on the screen → world rotates CW.
`rollCamera(-delta)` achieves this because `applyAxisAngle(forward, θ)`
rotates `camera.up` CCW when viewed from behind the forward vector
(standard right-hand rule), and rotating `up` CCW in world space makes
world content appear CW in the camera's view.

## Layout containers: `.ui-top-left`, `.ui-top`, `.ui-bottom`

The whole overlay UI is three pure-CSS fixed containers — **no breakpoints,
no JS measurements**. An earlier attempt used `ResizeObserver` to drive
`panel.style.top` / `maxHeight`; the user explicitly rejected that ("use
native html/css... we shouldn't dictate layout"). Do not reintroduce it.

- `.ui-top-left` — fixed top-left, holds the brand box. Independent of
  `.ui-top` so the right-side stack's width / wrap behaviour stays
  untouched.
- `.ui-top` — fixed top-right, `flex-direction: column`, bottom-bounded.
  Children in DOM order: topbar ("Navigate" heading + Focus/To search),
  then panel (Settings). Because panel is a flex child below the topbar,
  it can never overlap it — no measurement needed.
- `.ui-bottom` — fixed full-width along the bottom, `flex-wrap: wrap`,
  `align-items: flex-end`. Children: scale-bar (left), meta (right, with
  `margin-left: auto` for pull-apart). When the row doesn't fit, wrap puts
  them on separate rows naturally.
- `.meta` has `overflow-wrap: anywhere` — star names can be long and we
  want them to break within the narrow column when necessary. Layout
  is two stacked `<div>`s: `.meta-focus` (focused-star name ·
  constellation, brighter) above `.meta-count` (catalog total, dimmer).
  Distance-from-Sol used to live in this area but now belongs to the
  Sol locator arrow's label, so the meta no longer carries it.
- Both containers set `pointer-events: none` on themselves and `auto` on
  direct children, so clicks fall through empty regions to the canvas.

## `[hidden]` specificity and `.modal { display: grid }`

The HTML `hidden` attribute maps to `[hidden] { display: none }` in the UA
stylesheet — specificity (0,1,0). `.modal { display: grid }` has the same
specificity (0,1,0), and site stylesheets win ties, so `modal.hidden = true`
had **no visible effect** on the modal. Fixed globally with
`[hidden] { display: none !important; }` in `styles.css`. If you add
another class that sets `display` on an element that may be `hidden`ed
imperatively, you're already covered — but don't remove the `!important`
rule.

## `backdrop-filter` creates stacking contexts

Both `.topbar` and `.panel` use `backdrop-filter: blur(6px)`, which
silently creates a stacking context. Children's `z-index` is then clamped
to that context — so `.search-results` with `z-index: 12` inside `.topbar`
was painted **below** `.panel` (which has no z-index but appears later in
DOM order). Fixed by giving `.topbar` an explicit `z-index: 1` to lift its
whole context above `.panel`. If you add more blurred panels, remember
that every one of them is a new stacking boundary.
