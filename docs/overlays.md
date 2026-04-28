# SVG overlays

The SVG layer above the canvas. Constellation stick-figures, the disc
mask that lets WebGL stars show through SVG paths, the focus ring,
the distance vector with near-plane clipping, and the shared arrow
helper that the Sol/GC arrows reuse.

The Sol/GC arrows themselves are documented in `docs/rendering.md`
§Galactic reference system because they're tightly coupled to the
galactic-overlay feature group.

## Constellation stick-figure overlay

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
4. clamps the label position to `LABEL_PADDING_PX` from any edge so the
   distance stays readable.

If you see a disappearing vector, check this logic first.

## SVG hide semantics

Missing coordinate attributes on SVG elements default to **0**, not "don't
render". So `line.removeAttribute('x1')` leaves a stale line at x=0. Hide
using either:

- `element.style.display = 'none'` (used for the focus ring circle), or
- `path.setAttribute('d', '')` (used for the chevron path), or
- `polygon.setAttribute('points', '')` (used for the constellation hull).
