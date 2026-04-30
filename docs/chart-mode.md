# Chart mode (Phase 8)

Paper-aesthetic alternate render path inspired by Sky Atlas 2000.0
(chart 22 reference). Activated by `M` keyboard or
`setFilter({ chart: true })`. **Observe-only** — the `chart-mode.ts`
orchestrator listens to `onCameraModeChange` and auto-clears the flag
on observe→navigate. URL state persists `chart=1` only when both flags
are set (FLAG_CHART = 1 << 6 in the flags byte; see
`docs/architecture.md` §URL state).

`chart-mode.ts` toggles five things on entry:

1. `body.chart` class for CSS palette swaps (paper background, ink
   labels, monochrome topbar / brand box / typeahead).
2. `applyTheme('mono')` — flips the existing dark-mode palette to the
   mono palette (already in `theme-toggle.ts`).
3. `setCloudsIsobar(true)` + `setMilkywayIsobar(true)` — swaps the
   relevant fragment shaders to isobar branches (below).
4. `startChartLabels()` — registers the per-frame label engine
   (`chart-labels.ts`).
5. Constellation overlay flips to "always draw every constellation"
   (vs. only the highlighted one) so the chart shows the full asterism
   network.

Exit reverses each step.

## Star disc sizing — magnitude-driven

In chart mode the vertex shader replaces `max(appSize, physSize)` with
a **linear-in-magnitude** mapping (= log10-in-flux by definition of
magnitude):

```glsl
chartT = clamp(
  (appMag - uChartMagBright) / max(uMaxAppMag - uChartMagBright, 0.001),
  0, 1);
pxSize = mix(uChartDiscMaxPx, uChartDiscMinPx, chartT);
vPhysRatio = 1.0;  // force the frag shader's disc-pass branch
```

Three tunable uniforms shared with JS via `getChartDiscParams()`:

- `uChartDiscMaxPx` (default 16 px) — diameter at the bright end.
- `uChartDiscMinPx` (default 1.5 px) — diameter at the faint end.
- `uChartMagBright` (default −2.0) — magnitude that maps to MAX
  (covers Sirius/Vega/etc. at any vantage short of standing-on-a-
  bright-star).

The mapping is **range-aware** — sliding the magnitude limit from 6.5
to 15 spreads the same disc-size range across more stars instead of
crowding everything to one corner. Variability magMod is added to
`appMag` *before* this formula runs so the inner disc keeps pulsing.

## Chart-mode disc rendering — flat hard-edged + per-vertex AA

The fragment shader's `uMonochrome > 0.5` branch renders a flat
disc (no super-Gaussian profile, no halo, no luminosity-class
softening) with a **one-pixel antialiased outer edge**:

```glsl
float aa = max(vAaWidth, 1e-3);
float disc = 1.0 - smoothstep(0.5 - aa, 0.5, r);
outColor = vec4(vec3(1.0 - disc), 1.0);  // black ink under MultiplyBlending
```

`vAaWidth = 1 / pxSize` is computed per-vertex and passed as a
varying. **Don't switch to `fwidth(r)`** — `length(vUv)` has an
undefined screen-space derivative at the quad centre (vUv = (0,0)),
which produces faint or invisible discs at any size. Per-vertex AA is
stable because the value is independent of the fragment's UV
position. The vertex shader sets `vAaWidth` in every return path
(early-out, hide-focus, invisible cull, both pxSize branches) so the
varying is always defined.

The disc-pass branch hard-clips at `vAppMag > uMaxAppMag` (no soft
taper, since a sub-pixel fade-in band reads as a hard cutoff anyway
on a paper chart).

## Isobar contours — Milky Way + molecular clouds

Both layers' fragment shaders gain an `if (uChartIsobar > 0.5)` branch
that renders a **single thin line** instead of the volumetric body:

- **Milky Way** (`milkyway.frag.glsl`): `line = 1 - smoothstep(fw*0.5,
  fw*1.5, |appMag - uMaxAppMag|)` where `fw = fwidth(appMag)`. The
  contour tracks "where the integrated brightness would equal the
  slider limit" — drag the magnitude slider and the contour moves
  through the band like a topographic line. Discarded outside the
  line so depth stays clean.
- **Molecular clouds** (`cloud.frag.glsl`): `line = 1 -
  smoothstep(fw*0.5, fw*1.5, |density - t|)` where `t` is a
  magnitude-driven density threshold and `fw = fwidth(density)`.
  Same idea against the per-cloud density field.

Black ink colour (`uChartInkColor` / `uMonoColor` set to `0x000000`),
no alpha gradient — the line is solid, paper-chart-style, not a
shaded falloff. `setCloudsIsobar` and `setMilkywayIsobar` on the
respective layer modules toggle the branch and pass the
`uMaxAppMag` uniform reference.

## Label engine + glyphs (`chart-labels.ts`)

Per-frame engine that emits two SVG layers under `#overlay`:

- `<g id="chart-labels">` — `<text>` elements for proper-named stars,
  Bayer-letter Greek glyphs (drawn from `bayerMap` built in
  `search.ts`), constellation Latin names, and molecular cloud names.
- `<g id="chart-glyphs">` — `<circle class="chart-variable-ring">`
  per visible variable, `<line class="chart-binary-wings">` per
  visible binary primary (catalog flag bit 4).

**Greedy collision pass** with axis-aligned bounding rectangles, sorted
by priority (proper name 1 → Bayer 2 → cloud 3). Constellation names
**bypass** the collision pass entirely — they always render with
outline-style typography (16 px, 0.32em letter-spacing, weight 600,
`rgba(0,0,0,0.55)`, no halo) so they read as a sparse semi-transparent
overlay à la Sky Atlas, allowed to overlap small star symbols
underneath.

The constellation centroid is the **flux-weighted** position of every
member (`weight = 10^(-0.4 × appMag)` per star) recomputed each frame
from the current camera vantage. The visibility gate uses
`min(appMag) ≤ maxAppMag` over all members. Iterating every member
per frame is cheap (a few thousand) and was needed to fix a bug where
constellations with no single dominant intrinsic-brightest star (Vela,
Pyxis, Sagittarius, etc.) silently dropped their label.

**Variable rings** size to the bright-extreme magnitude
(`appMag - amplitude/2`) plus a `VARIABLE_RING_MIN_GAP_PX = 1.0` radial
gap, so the ring stays visibly outside the inner disc even at peak
phase for low-amplitude variables. The gap means the ring no longer
encodes "exact maximum brightness" — that's a deliberate trade for
glyph legibility.

**Binary wings** are screen-aligned horizontal `<line>`s extending
`discPx/2 + BINARY_WING_EXTENSION_PX` (4 px) past each disc edge.
SVG line coordinates are in viewport space, so the wings stay
horizontal regardless of camera roll by construction. Both glyph
classes share the per-frame `renderableAppMag` filter — same
spectMask + distance gates as the GPU disc — so a hidden inner disc
takes its glyph offscreen with it. Dust extinction is intentionally
**not** replicated CPU-side (per-star raymarch too expensive for
the label loop).

**Pooling.** Each `<text>` / `<circle>` / `<line>` is keyed by stable
identity (`n:idx`, `b:idx`, `c:conIdx`, `m:cloudIdx`) so adding /
removing nodes is free across frames. Unused entries are detached at
the end of each tick.

## Picking under chart mode

`pickStar` (`starfield.ts`) two fixes for the small-disc / variable
case:

1. **Variable bright-extreme filter.** Filter check uses
   `appMag - amplitude/2` so a variable whose disc is only visible at
   peak phase remains pickable across the whole cycle. Without this,
   GPU shows the disc but the picker can't see it.
2. **Disc hit-radius floor.** `MIN_DISC_HIT_RADIUS_PX = 4`. Tiny
   chart-mode discs (1–2 px) get a 4 px hit target so the cursor can
   realistically land within it; larger discs are unaffected. The
   14 px proximity fallback is unchanged but only fires if no other
   disc has won, which on a crowded chart it often has.

## Limits

- AT-HYG only stores the primary for most visual doubles (Sirius A,
  Castor A, Mizar A, γ And A, etc.) — the geometric binary inference
  in `build-catalog.ts` therefore can't pair them. Only α Cen has
  both A and B as catalog rows, so today's chart only draws wings on
  systems where both components made it into the source catalog. A
  curated HIP list of canonical visual doubles (or a WDS catalog
  import) would extend this; see `docs/build-and-data.md`
  §Geometric binary inference.
