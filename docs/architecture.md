# Architecture

Cross-cutting patterns the rest of the codebase assumes: event flow,
state machine for clicks, URL state restoration, and the floating-origin
precision trick. Read this before changing focus/vector behavior, state
mutation paths, or adding any code that reads star positions.

## Event bus on `Starfield`

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

## Click-state machine (`starfield.ts onPointerUp`)

| condition | action |
| --- | --- |
| no focus | focus on clicked |
| clicked = focused, no vector | unfocus |
| clicked = focused, vector drawn | clear vector (stay focused) |
| clicked = vector tip | `focusStar(tip)` — teleport to 2 pc from tip, clear vector |
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

`Starfield.aimAtConstellation(conIndex)` swings the camera so the chosen
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

## URL state

All URL state lives in a single opaque param: `?v=<base64url>`. The blob
is a binary, versioned envelope — version byte, 32-bit presence
bitmask, then only the fields that diverge from canonical defaults. So
a fully-default state has no `?v=` at all, a typical share lands at
~30–50 chars, and worst-case (every field overridden) tops out around
110 chars. See `src/client/url-state.ts` for the format and `FIELDS`
table.

- `url-state.ts applyFromUrl` runs **before** `startUrlSync` subscribes, so
  applying the URL on load doesn't echo back into history.
- Default-compression: a field is encoded only when its value differs
  from the canonical default. Encoder pre-computes the presence mask
  in one walk, then writes only the bytes for set bits. Default state
  produces no `?v=` at all (clean URL).
- Star focus is encoded with a tag bit — high bit set ⇒ HIP number,
  clear ⇒ row index. HIPs survive future catalog reorderings; index
  fallback exists for the ~63% of catalog stars without a HIP. Sol is
  the canonical default focus and is encoded by *omitting* the field;
  "explicitly unfocused" uses a separate zero-byte presence bit so the
  three states (default Sol / specific star / cleared) stay
  unambiguous.
- If `?v=` carries a focus without camera params (a hand-typed share),
  `applyDecodedView` calls `focusStar` which teleports the camera. If
  camera params are also present, it uses `setOrbitTarget` so the
  explicit camera wins.
- Camera changes are tracked via `onFrame` with a stringified-coord hash
  and a 300 ms debounced writer. The hash covers position, target,
  **and** `camera.up` — so two-finger roll (which only mutates `up`)
  still triggers a URL update.
- `camera.up` round-trips when it differs from `(0, 1, 0)` and is
  applied **before** focus/orbit dispatch because `focusStar` /
  `setOrbitTarget` call `controls.update()` which reads `camera.up` to
  derive orientation.
- `mode=observe` is applied **after** camera params + `controls.update()`
  so the saved pose lands first; the receiver then
  `setCameraMode('observe', { animate: false })` if the bit is set and
  a focused star exists. Default-omitted (navigate).
- The URL writer skips frame-hash updates while
  `isObserveTransitionActive()` is true, mirroring the warp guard — the
  observe enter/exit translate animates camera position and would
  otherwise flood history with intermediate poses.

Cloud-related state (cloud focus, cloud measurement vector, MC overlay
toggle) lives in the same `?v=` blob — see `docs/molecular-clouds.md`.

**Adding a field.** Claim the next free presence bit in `FIELDS`,
declare its type and bytes, and add encode/decode logic in
`currentStateOf` / `applyDecodedView`. Old shared URLs decode fine
because their bit is 0 in the presence mask. Don't repurpose retired
bits for ~6 months of deploy overlap. Breaking-shape changes (resizing
existing fields, semantic shifts) bump `SCHEMA_VERSION`.

**Console helpers.** `window.debug.decodeView('AQAA…')` decodes a blob
and `console.table`s the fields; `window.debug.encodeView()` returns
the blob for the current Starfield state. Useful when debugging a
shared URL that someone reports.

## Floating origin (large-world precision)

Close-range orbit of a star far from Sol used to jitter visibly because
Three.js composes its `modelViewMatrix` at float32 precision. At 1 kpc
from Sol, the translation column quantises to ~10⁻⁴ pc — 2–3% of the
min-orbit radius — so every frame the projected position snapped around
by a few pixels.

Fix: the renderer runs in a **floating local frame** whose origin tracks
the currently focused star.

- `Starfield.worldOffset` is the absolute-space coordinate that
  currently sits at the renderer's (0,0,0). Starts at Sol.
- `Starfield._localPositions` (exposed via `starfield.localPositions`)
  is a `Float32Array` of `catalog.positions − worldOffset`. It's bound
  to the `iPosition` instance attribute and is what every overlay and
  pick path projects through.
- `recenterOrigin(newOrigin)` rewrites the local-positions buffer using
  JS Number (= float64) subtraction and shifts `camera.position` and
  `controls.target` by the same delta so the user sees no jump.
- `setFocus(idx)` calls `recenterOrigin` automatically — focusing a star
  pins the frame to it, unfocusing snaps the origin back to Sol.

The key precision win: the big `absolute − offset` subtractions happen
in JS float64 on the CPU, producing small float32 deltas near zero with
~10⁻³⁸ resolution. The GPU's modelview matrix then only carries
kilo-parsec-scale values when the camera is far from the local origin
(i.e. zoomed out, where pixel-level jitter is imperceptible anyway).

Implications for code that reads positions:
- **Rendering / projection math** must use `starfield.localPositions`
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

URL round-trip works without special handling because sender and
receiver both recenter on the same focus star. Camera/target serialise
in local frame; loading the URL recenters to the same absolute origin
and the local coordinates apply unchanged. The unfocused state has
`worldOffset = (0,0,0)` by construction, so camera/target in that state
are already in absolute space.
