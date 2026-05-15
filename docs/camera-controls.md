# Camera controls

Camera setup that's mode-agnostic: near-plane vs minDistance geometry,
TrackballControls tuning, and the two-finger roll gesture that works
in both navigate and observe modes. For warp animation see
`docs/camera-warp.md`; for OBSERVE mode see `docs/camera-observe.md`.

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
buffer (`logarithmicDepthBuffer: true` on the WebGL renderer) gives this
configuration uniform precision in `log(z)`, so the
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

2. **Auto-park target** — `parkDistForStar(idx)`: where the camera
   automatically lands. Used by:

   - `focusStar(idx)`'s default park distance (search-select,
     click-vector-tip, default-load Sol focus). Since r9q.2, focus is
     a lerp-or-noop: the camera glides over `FOCUS_LERP_MS` when
     currently outside park, and stays put when already inside.
   - Observe-exit landing position (camera pulls back to
     `parkDistForStar` along its current view direction when leaving
     observe).
   - Warp source departure (`pStart = A + dirBack × sourceOffset`,
     where `sourceOffset = parkDistForStar(source)` for star sources or
     `cloudViewingDistancePc(source)` for cloud sources — decoupled
     from `endOffset` so a giant source like Betelgeuse warping to
     Sol doesn't place `pStart` inside the source's rendered disc).
   - Warp arrival (`pEnd = B − forward × endOffset`, with
     `endOffset = parkDistForStar(destIdx)`).

   Composes the generic `parkDistance(...)` primitive from
   `focus-transition.ts` with star-specific inputs:
   ```
   parkDistForStar = max(AU_PC + Reff, dMinFloor, binaryFloor)
     Reff       = R_pc · peakAmplitudeFactor       (handles variables)
     dMinFloor  = distAtFillFraction(Reff, fov_minor, ZOOM_FLOOR_FRACTION=0.9)
     binaryFloor = binaryCompanionFloorPc(idx)     (0 for non-binaries)
   ```
   Sol parks at ~1.005 AU (just outside Earth's orbit); a supergiant
   parks at the 90 %-fill clamp.

   `minOrbitDistForStar` (the manual-zoom floor — same fov-fraction
   solve at 0.9) and `parkDistForStar` re-evaluate on focus change,
   FOV change (via `setCameraFov`), and viewport resize (since aspect
   changes shift `fov_minor`).

## Focus-park lerp (r9q.2)

Click-focus on a star (or `flyToCloud` for clouds) no longer teleports.
The lerp lives in `src/client/focus-transition.ts` as the generic
`parkDistance(...)` + `newFocusLerpFrom(...)` + `tickFocusLerp(...)`
trio — stars consume it now; clouds compose the same primitives;
future focusable types (nebulae, etc.) plug in the same way.

Branch in `focusStar` / `flyToCloud`:

- **`eyeDist <= parkDist` → stay put.** Camera doesn't move; only
  `controls.target`, `controls.minDistance`, and focus state update.
- **`eyeDist > parkDist` → lerp.** Camera position lerps from
  `fromPos` to `toPos = target + (eye-direction × parkDist)` and
  camera orientation slerps in parallel from `fromQuat` to a quaternion
  that looks at the target from `toPos`. Both interpolations are
  driven by the same smoothstep, so the camera continuously rotates
  toward the new target as it flies in — "start view → pointing at
  new star from same location → flying right up to it, still facing it"
  as one continuous animation, not phased like the warp. Builds the
  lerp **after** `setFocus` recentres the floating origin so
  `fromPos` / `toPos` live in the post-recentre frame.
- **`opts.animate === false`** (URL restore) bypasses the lerp and
  snaps to the park pose. Matches the existing `unfocus({animate:false})`
  contract for URL-driven state restoration.

`controls.enabled` is **not** toggled during the lerp — the `animate()`
dispatcher routes through `updateFocusLerp` before `controls.update()`,
so user drag accumulates inside `TrackballControls` without visible
effect until the lerp lands. Disabling explicitly would race
`TrackballControls`' pointerup handler (Stellata's pointerup → focus
click runs *before* TC's dynamically-added pointerup), leaving TC's
`_state` stuck at `ROTATE` and the cursor "captured" until the next
click. Same precedent as the unfocus lerp (`docs/camera-observe.md`).

The focus-star pin (`uPinFocusToCenter`) is suppressed while the lerp
is in flight — `controls.target` is already `(0,0,0)` in the
post-recentre frame, so the pin would otherwise snap the focal star
to NDC origin while the camera is mid-rotation, making the star
appear pasted at screen centre instead of following the rotation
naturally.

`#overlay` (HUD arrows + ring, focus ring, distance vector,
constellation lines, POI labels, etc.) is hidden for the lerp's
duration via a `body.focus-lerping` class — same mechanism the warp
uses (`body.warping`), CSS rule shares the selector. Stellata fires
the `'focusLerp'` event on start / end edges; `main.ts` toggles
the body class.

`CAMERA_LERP_MS = 2000` is the canonical 2 s constant — `WARP_REORIENT_MS`,
`AIM_T_MAX_MS`, and `FOCUS_LERP_MS` all alias it so the three
camera-move animations read as the same family. `WARP_T_K_MS = 2000`
stays a separate literal because it's a log-scale flight coefficient
(see `docs/camera-warp.md`), not a duration.

`cancelFocusLerp` is wired at every site that already calls
`cancelUnfocusLerp` (`focusStar`, `flyToCloud`, `unfocus`, `startWarp`,
`aimAt`, `aimAtConstellation`, `onPointerUp`) so a follow-up
camera-changing action can't race the in-flight lerp.

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
