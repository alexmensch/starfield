# SVG overlays

The SVG layer above the canvas. Constellation stick-figures, the disc
mask that lets WebGL stars show through SVG paths, the focus ring,
the distance vector with near-plane clipping, and the shared arrow
helper that the Sol/GC arrows reuse.

The Sol/GC arrows themselves are documented in
`docs/galactic-overlay.md` because they're tightly coupled to the
galactic-overlay feature group.

## Constellation stick-figure overlay

`FilterState.showConstellation` is the master visibility flag for both
the stick-figure overlay and the chart-mode Latin-name labels (default
on, panel toggle at the top of Overlays). When false the overlay clears
itself and skips the per-frame projection pass entirely; the picker UI
in the panel is also disabled while the flag is off so users can't
mutate the unseen `highlightCon`. See `docs/ui-and-controls.md`
§Constellation typeahead.

When a constellation is highlighted, `constellation-overlay.ts` draws the
classical asterism lines (sourced from Stellarium — see
`docs/build-and-data.md` §Stick figures from Stellarium) as
an SVG `<path id="con-figure">`. Every segment is emitted as a separate
`M..L..` subpath with both endpoints pulled back by `STAR_GAP_PX`, and
the path uses `stroke-linecap: round`. Net effect: each stick-figure
line is a rounded-end segment with a circular gap around every
vertex star, so the actual star glyphs remain visible through the figure.

The `<path>` also applies `mask="url(#disc-occlude-mask)"`. The mask is
driven per-frame by `disc-mask.ts` which cuts out circles at the
projected position + rendered size of the focused star and its binary
companion (up to 4 simultaneous cutouts via a pooled `<circle>` array).
That gives the visual effect of constellation lines passing *behind* a
close-range resolved disc rather than being painted on top of it. The
cutout circle's radius tracks the disc's variable-star pulsation exactly
via `renderedSizePx` replicating the shader math, so there's no stale
gap as a variable shrinks. SVG renders above the canvas unconditionally,
so this masking is the only practical substitute for real z-ordering
between WebGL content and SVG overlays.

Earlier versions also drew a convex hull around the top-N brightest
constellation members. That layer was removed — the hull is defined by
*what's bright from Earth*, while the figure is defined by *what humans
traditionally drew as the shape*. When the camera isn't at Sol those
two answers diverge, and showing the hull was more confusing than
helpful. The 3D-deforming stick figure alone conveys the intent.

## Vector clipping at the near plane

When the destination star is behind the camera (common at close zoom —
Betelgeuse goes behind the camera when the camera is within ~20 pc of Sol),
`distance-vector-overlay.ts projectWithNearClip`:

1. transforms both endpoints to view space,
2. if destination's `viewZ >= -near`, solves for the line/near-plane
   intersection and uses it as an "effective destination" strictly in front,
3. caps the off-screen point at 1.5× viewport diagonal so SVG coords stay
   sane,
4. when the chevron tip is off-screen, anchors the distance label to
   the line's viewport-exit point (Liang-Barsky `tExit`) so it stays
   attached to the visible shaft, then clamps to `LABEL_PADDING_PX`
   from any edge.

If you see a disappearing vector, check this logic first.

## OBSERVE-mode hides

Three SVG layers conditionally hide while `cameraMode === 'observe'`:

- **Focus ring** (`focus-ring-overlay.ts`) — hidden in steady-state
  observe (the ring is meaningless when the camera sits *at* the focal
  star), but during the navigate↔observe transition its radius lerps to
  0 (enter) or back to 24 px (exit) instead of hard-hiding so it visually
  morphs through the HUD ring. The eased progress comes from
  `Starfield.getObserveTransitionProgress()`.
- **Disc mask cutouts** (`disc-mask.ts`) — the focal star and its
  binary-companion candidates are skipped when in observe, so the
  constellation overlay paints unmasked through that region (and the
  focal disc isn't rendered anyway, so there'd be nothing to mask).
- **Distance vector + To-row** — distance-vector measurement is
  meaningless from a camera parked on its own anchor; the search
  box's To-row hides via `syncFocusUI` and the underlying
  `setVectorTo` / `setVectorToCloud` setters guard against
  observe-mode calls defensively.

The Sol/GC arrows + the HUD ring do **not** hide — they're the HUD,
gated by `filter.showHud` independently of camera mode. In OBSERVE the
arrows attach to the HUD ring rim and swivel around it; through the
transition the focus ring shrinks while the HUD ring grows so the
arrows stay tangent to whichever circle is dominant. See
`docs/galactic-overlay.md` § HUD ring / Shaft start radius for the
projection math.

## Chart-mode labels and glyphs

`chart-labels.ts` adds two SVG layers under `#overlay` while chart
mode is active:

- `<g id="chart-labels">` — `<text>` elements for proper-named stars,
  Bayer-letter Greek glyphs, constellation Latin names, and molecular
  cloud names. Greedy collision pass over axis-aligned bounding rects;
  constellation names bypass it entirely (outline-style typography
  that reads as a sparse semi-transparent overlay à la Sky Atlas).
- `<g id="chart-glyphs">` — `<circle class="chart-variable-ring">`
  around variable stars, `<line class="chart-binary-wings">` through
  binary primaries. Both screen-aligned by construction (SVG line
  uses viewport coords; circles are circles regardless of camera
  roll).

Both layers pool their elements by stable key per frame so adding /
removing entries is free. The same `renderableAppMag` filter that
gates the GPU disc also gates the glyphs — a hidden inner disc takes
its ring or wings offscreen with it. See `docs/chart-mode.md` for
the magnitude-driven sizing formula and flux-weighted constellation
centroid math.

## Points of interest (OBSERVE-only)

`poi-overlay.ts` renders user-pinned stars (single-click on a star in
OBSERVE — see `docs/camera-modes.md` for the click dispatcher). Three
SVG groups under `#overlay`:

- `<g id="poi-arrows">` — pooled `<path>` + `<text>` per POI for
  off-screen arrows on the HUD ring rim. Arrow geometry comes from
  `buildArrowSvgPath()` (shared with Sol/GC arrows in `hud-overlay.ts`).
  Shaft start radius reuses `ringRadiusPx()` so POI arrows attach to
  the same ring as Sol/GC. Label text is the POI's best name only.
- `<g id="poi-rings">` — pooled `<circle class="poi-ring">` per POI,
  shown when the POI projects on-screen. Fixed 24 px radius (matches
  `focus-ring-overlay.ts`) so the ring + label sit at a constant pixel
  distance from the star regardless of camera FOV — important because
  the rendered disc grows/shrinks with FOV, but the ring doesn't.
- `<g id="poi-labels">` — pooled `<text>` per POI for on-screen labels
  anchored just outside the ring rim along a 45° diagonal. Format:
  `name · constellation-code · distance-from-observer`.

Click affordances (both label classes set `pointer-events: auto`):
- **On-screen label** → `Starfield.togglePoi(idx)` deselects the POI.
  The star itself stays clickable via `observeSingleClick` for the
  same effect; the label is a second, larger click target.
- **Off-screen arrow label** → `Starfield.aimAt(localPositions[idx])`
  slerps the camera so the POI lands at view centre. Mirrors the
  Sol/GC label affordance in `hud-overlay.ts`.
- **Ring** stays `pointer-events: none` so the star underneath remains
  the primary click target for `togglePoi`.

Visibility is gated as a single HUD layer: the whole stack hides when
`cameraMode !== 'observe'`, when `filter.showHud` is off, during warp
(via `body.warping #overlay` CSS), and during the navigate↔observe
transition. Chart-mode (`body.monochrome`) styling flips every HUD
stroke (gal-arrows, HUD ring, POI ring + arrow + labels) to a deep
saturated blue (`rgba(30, 64, 175, 0.85)`, the existing `--accent`
token) with a thin white halo on labels — distinct from pure-black
chart ink so the HUD reads as a separate navigational layer, ~7:1
contrast against the beige paper background. See `.poi-arrow`,
`.poi-label`, `.poi-arrow-label`, and `.poi-ring` in `styles.css`.

POIs survive page reloads via the `?v=` blob (HIP-only encoding,
observe-only emission — see `docs/build-and-data.md`-adjacent notes
in `url-state.ts`). Cleared automatically on every observe→navigate
transition; no UI element exposes "clear all" because Esc already
exits observe and clears them as a side-effect.

## SVG hide semantics

Missing coordinate attributes on SVG elements default to **0**, not "don't
render". So `line.removeAttribute('x1')` leaves a stale line at x=0. Hide
using either:

- `element.style.display = 'none'` (used for the focus ring circle), or
- `path.setAttribute('d', '')` (used for the chevron path), or
- `polygon.setAttribute('points', '')` (used for the constellation hull).
