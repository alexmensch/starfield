# Camera modes, controls, and warp

The orbit-controls tuning, the navigate↔observe state machine, the
warp animation that ties them together, and the gestures that drive
all three. Everything visible-on-screen here is HUD or transitional —
for the steady-state HUD widgets (Sol/GC arrows, the OBSERVE ring) see
`docs/galactic-overlay.md`.

## Camera near plane vs controls minDistance

`camera.near = 1e-10`, `controls.minDistance` (when no star is focused)
= `GLOBAL_MIN_DIST_PC = 5e-3` pc. The unfocused floor sits well above
the float32-cancellation threshold so an unfocused orbit can't drift
into the regime where projection precision breaks down — to get any
closer than that, the user must focus a star, which then engages the
per-star `minOrbitDistForStar` floor (sub-pc for Sol-class) plus the
`uPinFocusToCenter` shader pin (see `docs/architecture.md`
§ Pin-to-center) which sidesteps the float32 cancellation entirely. The near plane must stay
**strictly less** than the closest orbit distance, otherwise a centered
star lands on the clip plane at max zoom and gets culled. The log depth
buffer (Phase 0, `logarithmicDepthBuffer: true` on the WebGL renderer)
gives this configuration uniform precision in `log(z)`, so the
multi-decade range from sub-AU close approach to 100 kpc background
renders without z-fighting.

When a star is focused, two distinct distances are in play —
deliberately decoupled so manual zoom can push past the auto-park
distance. Both come from the **true angular geometry** of the star's
disc through the camera lens — `θ = 2·atan(R / d)`:

1. **Manual-zoom floor** — `controls.minDistance =
   minOrbitDistForStar(idx)`. Solves for `d` such that the disc fills
   `ZOOM_FLOOR_FRACTION` (= 0.9) of the viewport's minor axis:
   ```
   d_min = R / tan(ZOOM_FLOOR_FRACTION × fov_minor / 2)
   ```
   `fov_minor = min(fov_x, fov_y)` so the 90% target reads consistently
   across portrait + landscape viewports. Binary companions get an
   additional `Math.max(d_min, sep × BINARY_MIN_DIST_FACTOR)` bump so
   the partner stays in frame. This lets the user orbit close enough
   that any star fills 90% of the smaller viewport axis at max zoom,
   with `d_min` scaling linearly with the star's physical radius —
   inspecting a Sol-class star vs Betelgeuse vs Sirius B looks the same
   on screen.

2. **Auto-park target** — `minDistForStar(idx)`: where the camera
   automatically lands. Used by:

   - `focusStar(idx)`'s default park distance (search-select,
     click-vector-tip, default-load Sol focus). Was a fixed 2 pc
     before a7d.2.4; now uses the same geometric solve as every other
     auto-park so all entry points land at the same on-screen disc
     coverage.
   - Observe-exit landing position (camera pulls back to
     `minDistForStar` along its current view direction when leaving
     observe).
   - Warp source departure (`pStart = A + dirBack × sourceOffset`,
     where `sourceOffset = minDistForStar(source)` for star sources or
     `cloudViewingDistancePc(source)` for cloud sources — decoupled
     from `endOffset` so a giant source like Betelgeuse warping to
     Sol doesn't place `pStart` inside the source's rendered disc).
   - Warp arrival (`pEnd = B − forward × endOffset`, with
     `endOffset = minDistForStar(destIdx)`).

   Same geometric solve at a smaller fraction so the disc reads as a
   clear feature without dominating the frame:
   ```
   d_park = R / tan(TARGET_PARK_FRACTION × fov_minor / 2)
   ```
   `TARGET_PARK_FRACTION` = 0.10. Floored at `2 × d_min` so the parking
   distance always sits clearly above the manual-zoom limit (only
   matters at extreme aspect ratios; for reasonable viewports
   `d_park ≈ 9 × d_min` naturally). Binary companions get the same
   half-angle bump on top.

   Mirrors `renderedSizePx`'s physical-size term exactly. Both
   `minOrbitDistForStar` and `minDistForStar` re-evaluate on focus
   change, FOV change (via `setCameraFov`), and viewport resize (since
   aspect changes shift `fov_minor`).

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
- `minDistance = GLOBAL_MIN_DIST_PC = 5e-3` (when no star is focused;
  per-star `minOrbitDistForStar` overrides on focus). `maxDistance = 100_000`.

## Warp animation

An animated camera flight between the focused star (A) and the distance
vector destination (B). Trigger: click the yellow distance label on the
SVG overlay (hovering reveals a "→ Warp" suffix), or press `W`. Skip: the
muted ghost pill at top-center (shown only while warping), or `Esc` /
`Space`. Click-tip-to-travel is an instant teleport that routes through
`focusStar(idx)` for consistency with search-select (parks at
`minDistForStar(idx)` — same geometric auto-park every landing uses).

Two- or three-phase animation in `stellata.ts updateWarp`, depending
on whether the warp re-enters OBSERVE on arrival:

1. **Reorient** (`WARP_REORIENT_MS` = 2000). Camera position
   spherically slerps around A from wherever the user was to `A +
   dirBack × sourceOffset` (on the travel line, offset behind A from
   B's perspective). Simultaneously the orbit distance eases linearly
   from `mag0` down to `sourceOffset`. End state: A is centered and B
   is straight ahead, beyond A. Quaternion slerp is used for the
   angular interp (robust against antipodal starting positions).
   `sourceOffset` is the source's own auto-park distance (see
   §Camera near plane vs controls minDistance), separate from
   `endOffset` (the destination's). Decoupling these handles
   asymmetric warps cleanly: a Betelgeuse → Sol flight starts well
   outside Betelgeuse's giant disc and arrives at Sol's small park
   radius, with neither endpoint inside the other star.

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
   Straight-line lerp from `pStart` (= A + dirBack × sourceOffset) to
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

Scale-bar smoothness: `controls.target` is pointed at **B** from the
moment the warp begins (not just at arrival). Camera orientation is
controlled independently via `camera.lookAt`, so the reorient phase can
still keep A centered visually while the horizontal scale bar (which
reads scene-scale at the camera-target depth) already reflects
distance-to-destination — this avoids a jarring scale-bar snap when the
target would otherwise switch from A to B at arrival.

The bottom-left widget's separate **focus z-axis indicator** (the
perspective recession line above the scale bar; see
`docs/ui-and-controls.md` §Bottom-left widget) follows a different
rule: during warp it shows the source star/cloud while the camera is
on the source side of the A→B axis, and flips to the destination once
`(camera − A) · (B − A) > 0`. Trajectory-relative test, not camera-
attitude — stays stable under future curved-warp paths. Implemented
via `Stellata.getWarpInfo()`.

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

**Look-around controller (`observe-controls.ts`) — direct manipulation:**
- Drag grabs whatever world point sits under the cursor at pointer-down
  and keeps it under the cursor for the rest of the drag. Like
  fingertip-dragging the inside of a celestial sphere.
- **Mechanism.** On pointer-down, `pixelToWorldDir` converts the cursor
  pixel into a world-space ray direction `dGrabbed` — built from
  FOV/aspect and rotated by the live `camera.quaternion`, no
  `unproject()` (avoids depending on `matrixWorld` being up-to-date,
  which matters because pointer-move can fire multiple times between
  frames). On every pointer-move we recompute the cursor's world
  direction `dCurrent` the same way and pre-multiply
  `camera.quaternion` by the shortest rotation
  `setFromUnitVectors(dCurrent, dGrabbed)`. Premultiply rotates the
  camera's basis in world space; the pixel under the cursor — whose
  *camera-local* direction is fixed by FOV/aspect/pixel — therefore
  now points at `dGrabbed` in world. Repeat per move event and the
  grabbed world point is glued to the cursor pixel-perfectly.
- **No fixed yaw axis, no pole singularity, no pitch clamp.** Each drag
  rotates around whatever screen-relative axis matches the cursor
  motion. Shortest-path rotations are well-defined through ±90°, so a
  vertical drag passes straight over NGP and out the far side without
  the camera getting stuck.
- **Roll-independent.** A two-finger Safari twist mutates
  `camera.quaternion` (the live image roll) **and** `camera.up`. The
  direct-manipulation controller doesn't read `camera.up`, but the URL
  encoder does — leaving `up` stale would lose the roll on every
  reload, since URL restore rebuilds the quaternion from cam/tgt/up
  before observe is engaged. The twist changes which world point is
  under each pixel, but pointer-down captures whatever's under the
  cursor at that moment and pointer-move keeps it there. So the user
  can rotate the screen image to match the sky overhead and dragging
  still drags the world along intuitively.
- **Release momentum.** On `pointermove` we extract the per-event
  rotation as axis-angle (`lastRotAxis`, `lastRotAngle`,
  `lastMoveTimeMs`). On `pointerup`, if the gap between the last move
  and the release is ≤ `MOMENTUM_MAX_RELEASE_GAP_MS` (80 ms — releases
  after a longer pause are deliberate stops, not flicks), we promote
  that to an angular velocity (`momentumAxis`, `momentumSpeed` in
  rad/sec). `update()` runs every frame from Stellata's animate loop
  while in observe (and not in a transition / aim slerp): it applies
  `momentumSpeed · dt` of rotation around `momentumAxis` and decays
  `momentumSpeed` by `exp(-dt / MOMENTUM_TAU_SEC)` per step. `dt` is
  capped at 100 ms so a stalled rAF (background tab, GC pause) doesn't
  resume with one giant rotation. `MOMENTUM_TAU_SEC = 0.4` is looser
  than TrackballControls' navigate damping by design — the direct-manip
  drag has no "throw" of its own, so a longer glide (~2 s before fully
  stopped) gives flicks somewhere to land. A new `pointerdown` zeroes
  `momentumSpeed` so the user can grab and stop instantly.
- **Aim-at slerps don't preserve roll.** `aimAt`'s OBSERVE branch
  builds the target via `Matrix4.lookAt(pos, point, camera.up)` with
  `camera.up = (0, 1, 0)`, so a slerp triggered by the constellation
  typeahead, Sol/GC labels, or canvas double-click lands with ICRS Y
  as screen-up and unwinds any roll the user had applied. Acceptable
  trade-off — aim-at is an explicit "take me there" command, not a
  drag, and re-twisting after arrival is cheap.
- Wheel adjusts `camera.fov` (1.5° per notch, clamped 10–120°) instead
  of camera distance. Distance has no meaning when the camera is
  parked.
- In navigate-mode, `rollCamera` mutates only `camera.up`
  (TrackballControls picks up the rolled vertical on every `update()`
  and rebuilds the quaternion from it). In observe-mode `rollCamera`
  rotates both `camera.up` and `camera.quaternion` — `up` solely for
  URL persistence, `quaternion` for the actual rendered roll.

**HUD locators:** Sol and Galactic-Centre arrows are part of the HUD
(`hud-overlay.ts`, gated by `filter.showHud`). In observe their anchor
falls back to screen centre (the focal-star projection is degenerate
since camera ≈ focal star) and the shaft start radius equals the HUD
ring's `ringRadiusPx(fov, w, h)` so the arrows attach to the ring rim
and swivel around it. The same shaft-start value lerps through the
navigate↔observe transition so there's no pop on entry/exit. See
`docs/galactic-overlay.md` § HUD ring / Shaft start radius for the
formula and projection math.

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
along its current view direction over `OBSERVE_TRANSITION_MS`.

**Navigate-mode close-zoom unfocus** (a7d.2.6) takes the same shape:
when the user hits Esc / clicks the focused star / clicks the X while
already in navigate, and the camera sits closer than
`minDistForStar(focal)`, `unfocus()` lerps the camera outward along
its view direction to `minDistForStar` over `OBSERVE_TRANSITION_MS`
instead of teleporting. Reuses `observeTransition` with a third
`kind: 'unfocus'`. `setFocus(null)` runs at lerp start so UI clears
immediately; `controls.minDistance` is tightened to `minDistForStar`
on landing so manual zoom-in is bounded by the same parking distance.
Skipped (snap) when already at or beyond the floor; cancelled cleanly
by any new camera-changing action via `cancelUnfocusLerp` calls at
the entry points (`focusStar`, `startWarp`, `aimAt`,
`aimAtConstellation`, `onPointerUp`). `controls.enabled` is **not**
toggled during the lerp — the `animate()` dispatcher routes to the
lerp tick instead of `controls.update()`, so user input accumulates
inside TrackballControls but doesn't apply visually. Disabling
explicitly would race the click-to-unfocus event chain and leave
TrackballControls' `_state` stuck at `ROTATE`. Capturing
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
- Setting `target = (0,0,0)` instead would point at the local-frame
  origin (where the focal star sat) and the lookAt would whip the
  camera around to face it. Using `fromPos` works for both the
  unfocus path and the focus-retained path because each captures
  `fromPos` from the camera position right before the lerp begins —
  whatever frame the camera is in, `fromPos` is along the forward
  ray at minDist, which is what we want lookAt to be a no-op against.

**URL state:** the OBSERVE-mode flag round-trips through the `?v=`
blob (flags-byte bit 5), applied after camera params +
`controls.update()` so the saved pose lands first. The URL writer's
debounced frame hook skips writes during
`isCameraTransitionActive()` — covers warp, observe enter/exit, and
the navigate-mode unfocus lerp (a7d.2.6) so transient mid-lerp poses
don't get serialised. URL apply for `focus: 'cleared'` calls
`unfocus({ animate: false })` so a state restore doesn't fight a
following `view.cam` write.

**Click dispatch in OBSERVE.** Canvas clicks have their own dispatcher
distinct from navigate's click-state machine. `onPointerUp` defers
single-clicks for `OBSERVE_DBL_CLICK_MS = 280`; if a second click
arrives within that window AND within `OBSERVE_DBL_CLICK_DIST_PX_SQ`
(8 px²) of the first, the pending single-click is cancelled and a
**double-click** fires instead. Otherwise the **single-click** runs
when the timer elapses.

- *Single-click:* `pickStar()` resolves the click; if a star is hit,
  `togglePoi()` pins or unpins it. Sol is rejected (the dedicated
  `#sol-arrow` already covers it); stars without HIP are rejected
  (URL state is HIP-only); the cap is 16 (adding past the cap is a
  no-op). The POI overlay (`docs/overlays.md` § Points of interest)
  renders the resulting label + arrow.
- *Double-click:* unprojects the click into a world-space ray, builds
  a far point along it, and feeds that to `aimAt()` — the existing
  observe-aim path slerps the camera so the clicked direction lands
  at view centre. Works on stars, on empty sky, and on chart-mode
  background alike.

POIs clear automatically on every observe → navigate transition (the
clear is wired via `onCameraModeChange` inside the constructor, so
all three exit paths — mode toggle, focus change, search-X clear —
get the same cleanup). They round-trip through the `?v=` blob *only*
in observe mode (see §URL state), encoded HIP-only at bit 19.

## Two-finger roll gesture (platform-split)

`stellata.ts` adds a two-finger rotate gesture that rolls the view around
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
