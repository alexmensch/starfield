# Architecture

Cross-cutting patterns the rest of the codebase assumes: event flow,
state machine for clicks, and the floating-origin precision trick. Read
this before changing focus/vector behavior, state mutation paths, or
anything that reads star positions. For the `?v=` URL wire format see
`docs/url-state.md`.

## Event bus on `Stellata`

- `onFocusChange(idx | null)` — focused star changed (from any source).
- `onVectorChange(toIdx | null)` — distance-vector destination changed.
- `onFilterChange(filter)` — any filter patch applied.
- `onCameraModeChange(mode)` — camera mode flipped between `'navigate'` and
  `'observe'`. Used by the mode toggle, search-row label swap, and
  scale-bar (which switches to angular degrees in observe).
- `onFrame()` — called after each render, used by all SVG overlays.
- `onStateChange()` — fires on any discrete state mutation. This is what the
  URL-sync module listens to. Don't fire it from `onFrame` for camera changes —
  the URL sync has its own frame hook with hash comparison for that.

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
   fire `onCameraModeChange`. The animate loop branches on `warpState`
   first, so the value is purely cosmetic during the flight — but every
   listener bound to `onCameraModeChange` (mode toggle, search-row
   label, etc.) stays settled. Without this, observe→observe arrival
   visibly flickers through navigate mid-warp.
2. **`finishWarp` re-anchors via `swapObserveAnchor`**, not `setFocus`,
   when `returnToObserve` is true. `setFocus` would see
   `cameraMode === 'observe'` and run its observe-cleanup branch
   (`uHideFocusIdx = -1`, fire `onCameraModeChange`), recreating the
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
- `recenterOrigin(newOrigin)` rewrites the local-positions buffer using
  JS Number (= float64) subtraction and shifts `camera.position` and
  `controls.target` by the same delta so the user sees no jump.
- `setFocus(idx)` calls `recenterOrigin` on focus. **Unfocus does
  *not* recenter** — `worldOffset` stays at the former focal object
  so camera/target/iPosition all remain in their float32-clean local
  frame. Recentering on unfocus used to cause a visible jump (the
  `idx===null` branch shifted `target` by the focal star's full world
  position, breaking the pin invariant below and re-introducing
  cancellation in the projection chain).
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
  `pickStar` / `renderedSizePx` / `aimAtConstellation` paths do this.
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
`focusedStar !== null && cameraMode === 'navigate' && !warpState
&& !aimState && controls.target.lengthSq() < 1e-12`.

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

**Fix for #1 and #2** lives at the choke point in `setFocus`'s
`idx !== null` branch: after `recenterOrigin`, subtract `target` from
`camera.position` (preserving cam-to-target offset) and snap target to
`(0,0,0)`. Eliminates both residuals for every caller of `setFocus`.

Limitations: pan moves target away → pin disengages (intentional;
post-pan the focused star isn't at view centre). Doesn't fire in
observe mode, during warp, or during aim animations — the mid-warp
close-approach drift would need pin generalisation to support
non-origin pin targets.

**Where to look:**
- `src/client/shaders/star.vert.glsl` — `uPinFocusToCenter` decl + use site.
- `src/client/stellata.ts` — `GLOBAL_MIN_DIST_PC = 5e-3 pc`, `setFocus`
  body (the post-recenter snap to origin in the focused branch; empty
  unfocus branch), per-frame pin guard in the animate loop.
- `src/client/url-state.ts` — `DecodedView.worldOffset`, encoder/loader.
- `src/client/url-state.test.ts` — round-trip regression test.
- `src/client/pin-debug-hud.ts` — Pin section in the unified debug
  panel (`debug.panel()`); live readouts with latched directional
  extremes. **Always use this when investigating any "star drifts
  off-screen" report.**
