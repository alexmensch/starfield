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
