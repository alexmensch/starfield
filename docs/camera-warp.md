# Warp animation

The animated camera flight between the focused star (A) and the
distance-vector destination (B). State machine, phase math, scale-bar
behaviour, and the navigate↔observe interactions on launch/arrival.
For the steady-state camera geometry (minDistance / TrackballControls)
see `docs/camera-controls.md`; for OBSERVE mode see
`docs/camera-observe.md`.

## Warp animation

An animated camera flight between the focused star (A) and the distance
vector destination (B). Trigger: click the yellow distance label on the
SVG overlay (hovering reveals a "→ Warp" suffix), or press `W`. Skip: the
muted ghost pill at top-center (shown only while warping), or `Esc` /
`Space`. Click-tip-to-travel routes through `focusStar(idx)` for
consistency with search-select (parks at `parkDistForStar(idx)` — same
auto-park every landing uses; lerps over `FOCUS_LERP_MS` or stays put
when already inside park, see `docs/camera-observe.md` § Focus-park
lerp).

Two- or three-phase animation in `stellata.ts updateWarp`, depending
on whether the warp re-enters OBSERVE on arrival:

1. **Reorient** (`WARP_REORIENT_MS` = 1800). Camera position
   spherically slerps around A from wherever the user was to `A +
   dirBack × sourceOffset` (on the travel line, offset behind A from
   B's perspective). Simultaneously the orbit distance eases linearly
   from `mag0` down to `sourceOffset`. End state: A is centered and B
   is straight ahead, beyond A. Quaternion slerp is used for the
   angular interp (robust against antipodal starting positions).
   `sourceOffset` is the source's own auto-park distance (see
   `docs/camera-controls.md` § Camera near plane vs controls minDistance),
   separate from `endOffset` (the destination's). Decoupling these
   handles asymmetric warps cleanly: a Betelgeuse → Sol flight starts
   well outside Betelgeuse's giant disc and arrives at Sol's small park
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
   Camera position rides the line from `pStart` (= A + dirBack ×
   sourceOffset) to `pEnd` (= B − forward × endOffset), delegated to
   `camera-motion.ts`'s `tickArrival` so the Fly phase shares the
   shipped arrival profile with focus-park and unfocus. The profile is
   the **hybrid two-regime curve** — linear-d piecewise-quad outer
   (rocket-impulse, parallax-driven) → quintic smootherstep on
   angular-size inner (smooth perceptual landing on disc growth), with
   a single tunable seam-distance multiplier. See
   `docs/camera-arrival.md` § Profile for the geometry and the
   panel-knob wiring. `camera.lookAt(B)` throughout.

   **Mid-Fly floating-origin recentre.** The moment the camera passes
   the trajectory midpoint (`|camera − B|² < ¼·|B − A|²` — the
   "source star is behind the camera" cue), `updateWarp` calls
   `tryMidFlyRecentre`, which shifts the floating origin onto the
   destination's absolute anchor and migrates the in-flight
   `WarpState` waypoints + `ArrivalState` cached vectors into the
   new frame via `shiftWarpWaypoints` + `shiftArrivalWaypoints`.
   After the shift, `dest.localPositionInto` returns ≈(0,0,0), so
   the per-frame `lookAt(B)` becomes `lookAt(local origin)` —
   geometrically equivalent, numerically clean.

   Why this exists: any log-d Fly profile (cubic-Hermite fallback for
   clouds + outbound, and the hybrid curve's inner regime on θ for
   stars) parks the camera inside `|B − camera| < ULP(|B|)` for some
   non-trivial window of long-range arrivals (e.g. Betelgeuse → Sol).
   In that zone `B − camera.position` loses all Float32 precision and
   the `lookAt` quaternion jitters across representable values, so
   the destination renders off-screen for several frames before
   `finishWarp` recentres and snaps it to NDC origin. Recentring
   mid-Fly eliminates the chaos zone entirely (stellata-2br.5). The
   issue was first surfaced under the cubic-Hermite log-d profile,
   which sat inside that zone for the last ~19 % of Fly; the hybrid
   curve's angular-size inner regime is geometrically cleaner but
   still terminates close enough to the destination that the same
   recentre is the right answer.

   Kind-agnostic via the `FocusTarget` contract — works for any
   focusable kind that implements `anchorInto` and `applyFocus`.
   `dest.applyFocus()` mutates focus state in place; the deferred
   event family is fired from `finishWarp` via
   `dest.emitFocusEvents()` so the search-row label and friends
   settle in lock-step with the camera landing rather than ~half a
   warp duration early.

   **Chart-mode plateau-trigger.** Chart mode renders stars as
   magnitude-driven discs (`pxSize = mix(maxPx, minPx, chartT)` with
   `chartT = clamp((appMag − magBright)/(maxAppMag − magBright), 0, 1)`
   — see `docs/chart-mode.md` §Star disc sizing). Once the camera is
   close enough that `appMag ≤ uChartMagBright`, `chartT` floors to 0
   and the disc plateaus at `uChartDiscMaxPx`. Under both the hybrid
   inner regime and the cubic-Hermite fallback, the camera spends much
   longer in the close-approach window than under the legacy piecewise
   profile — so the user can sit for hundreds of milliseconds inside
   the plateau zone watching a disc that doesn't grow, with no
   perceptual progress signal. Pivot to phase 3 early instead: when
   chart mode is active (observe-only) at warp start, cache the
   plateau distance via
   `dest.chartPlateauDistance(uChartMagBright)` (`chart-disc-pure.ts`
   solves the distance-modulus identity for the threshold magnitude:
   `d = 10^((magBright − absMag + 5)/5)` pc — Sol's default plateau
   sits at ~0.43 pc, Betelgeuse's at ~58.9 pc). During Fly, once the
   camera is inside that radius AND mid-Fly recentre has fired, pin
   `state.pEnd` to the current camera position and shrink
   `state.durationMs` to the elapsed Fly time so the next frame falls
   into phase 3 with `flyEndQuaternion` captured from the live
   lookAt(dest) orientation. Phase 3's parallax slerp then carries
   the perceptual progress signal across the plateau zone (a flatlined
   disc + a rotating camera reads as motion). Gated on
   `recenteredToDest` so the dest-local position check is well-conditioned
   (target at (0,0,0), no ULP residual) and so the transition can't fire
   before the floating-origin shift cleans up the projection chain.
   Clouds return `null` from `chartPlateauDistance` — chart mode
   renders them as isobar contours rather than discs, no plateau to
   detect.

3. **Post-arrival reorient** (only when `returnToObserve`, duration =
   `OBSERVE_TRANSITION_MS` = 1800 ms). Quaternion slerps from the
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

   The floating origin is recentred onto B at the start of phase 3
   (not at `finishWarp`). Without this, both the camera and B sit at
   the same kpc-scale magnitude in the source-local frame for the
   1.2 s slerp window, and `matrixWorldInverse * B` loses float32
   precision — visible as the destination star jittering as the
   quaternion rotates (stellata-fqw). After the recentre B is at local
   `(0,0,0)` and the camera lerps in from a small offset; the
   projection chain stays clean. `uHideFocusIdx` still points at the
   source for the rest of phase 3 so the destination remains visible
   throughout the parallax slerp; `swapObserveAnchor` at `finishWarp`
   re-points it to the destination on landing. Mirrors the
   navigate-mode path (`setFocus(destIdx)` recentre at `finishWarp`),
   pulled forward by `postArrivalMs`.

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
