# OBSERVE camera mode

A second camera mode that parks the camera at the focused star and
swaps `TrackballControls` for a custom look-around controller. Drag
mechanics, momentum, FOV-on-wheel, aim slerps, POI dispatch, and the
click handlers (single = pin a POI, double = aim-at). For the warp
animation that connects observe→observe arrivals see
`docs/camera-warp.md`; for the steady-state camera geometry see
`docs/camera-controls.md`.

The navigate↔observe mode-switch orchestrator — the
`ObserveTransitionState` slot, the `enter` / `exit` / `unfocus` kinds,
and the per-frame lerp — lives in
`src/client/camera/observe-transition.ts` (extracted from `stellata.ts`
in stellata-9mm.194.6). The integration shell composes the controller
alongside Picker / AimController / WarpController and delegates the
animate-loop tick when `observe.isAnyActive()` returns true. Stellata
still owns the `cameraMode` field (~20 unrelated read sites) and writes
it through the controller's `setCameraModeValue` dep callback so the
controller's state machine stays the canonical mode-switcher.
`alignCameraUpToQuaternion` (re-anchor `camera.up` before any `lookAt`
on the observe→navigate seam) lifted to
`src/client/camera/up-align-pure.ts` in the same PR — the controller
imports it without inheriting from Stellata. Cross-controller coupling
(focused-star inspection, parkDistForStar lookup, vector-slot clears,
focus-change side effects) lives behind the `ObserveFocusOps` interface
that Stellata implements directly today; 9mm.194.8 hands that seam to
FocusController and the `focus:` dep wire updates in one line.

Public surface:
- `setMode(mode, opts)` — mode-pill toggle, keyboard O, URL restore.
- `startExit(opts)` — search-row X-button (`clearFocusOnExit`),
  `Stellata.unfocus()`'s observe-animated branch.
- `startUnfocusLerp(from, to, finalMinDist)` — `Stellata.unfocus()`'s
  navigate-mode close-zoom branch.
- `tick(nowMs)` — animate-loop dispatcher.
- `isActive` / `isAnyActive` / `getProgress` — observer predicates;
  `isActive` excludes the `unfocus` kind so overlays gating on observe
  visibility stay steady-state-navigate during close-zoom.
- `cancelUnfocusLerp` — `FocusOps` shim for WarpController.
- `cancelTransition` — used by `Stellata.setFocus`'s observe-cleanup
  branch when the focal star is changing mid-flight.
- `dispose` — for Stellata.dispose.

## OBSERVE camera mode

A second camera mode that parks the camera at the focused star and
swaps `TrackballControls` for a custom look-around controller. Toggled
via the navigate / observe pill in the top-right card (`#mode-toggle`,
wired in `mode-toggle.ts`). The OBSERVE button is disabled until a star
is focused — the underlying `setCameraMode('observe')` no-ops without
an anchor, but disabling the button advertises the affordance up-front.

**Camera state on enter:** position lerps to `(0, 0, 0)` local (the
focused star's position under the floating origin) over
`OBSERVE_TRANSITION_MS = 1800 ms`. The focal star stays visible across
the glide and is hidden via `uHideFocusIdx = focusedStar` only at
`ObserveTransition`'s `enter` finish branch — once the camera is parked
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
- **Drag teardown.** Four code paths reset `dragging` /
  `activePointerId` / `momentumSpeed` / `lastRotAngle` to known-clean
  state via the shared `cancelDrag()` helper: `disable()` (mode change),
  `pointercancel` (OS-cancelled gesture — phone-call interrupt, system
  gesture preempt), `window.blur` (Cmd-Tab / app-switcher), and
  `document.visibilitychange` while hidden (tab swap, swipe-up app
  switcher on mobile). All four are "the pointer is no longer ours"
  events; without one of them, dragging would resume from a stale
  `dGrabbed` and the next pointermove would whip the camera. The
  navigate-mode click detector in `stellata.ts` has a parallel
  `pointercancel` partner clearing `pointerDownAt` to prevent phantom
  clicks from cross-gesture drift.
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
direction from the new vantage — see `docs/camera-warp.md` §Warp
animation phase 3.

**X button (clear focus from observe):** `unfocus()` detects observe +
focused-star and immediately clears focus *before* starting the
zoom-out animation. The search box empties via the `'focus'` event on the
click, then the camera pulls back to `parkDistForStar(formerFocal)`
along its current view direction over `OBSERVE_TRANSITION_MS`.

**Navigate-mode close-zoom unfocus** (a7d.2.6) takes the same shape:
when the user hits Esc / clicks the focused star / clicks the X while
already in navigate, and the camera sits closer than
`parkDistForStar(focal)`, `unfocus()` lerps the camera outward along
its view direction to `parkDistForStar` over `OBSERVE_TRANSITION_MS`
instead of teleporting. Reuses `ObserveTransition`'s state slot with a
third `kind: 'unfocus'`. `setFocus(null)` runs at lerp start so UI clears
immediately; `controls.minDistance` is tightened to `parkDistForStar`
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

`ObserveTransition`'s `exit` finish branch then sets `controls.target` to the
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

- *Single-click:* `picker.pickStar()` resolves the click; if a star is hit,
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
clear is wired via the `'cameraMode'` event inside the constructor, so
all three exit paths — mode toggle, focus change, search-X clear —
get the same cleanup). They round-trip through the `?v=` blob *only*
in observe mode (see §URL state), encoded HIP-only at bit 19.
