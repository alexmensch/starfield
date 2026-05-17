# UX knobs

Reference table of common tweaks the user may ask for and where to find them.
See also `docs/rendering.md`, `docs/galactic-overlay.md`,
`docs/molecular-clouds.md`, `docs/milky-way.md`, `docs/chart-mode.md`,
`docs/camera-controls.md`, `docs/camera-warp.md`, `docs/camera-observe.md`,
`docs/ui-and-controls.md`, and `docs/overlays.md`
for the surrounding context.

## Known UX knobs you may be asked to tweak

- **Orbit feel** — `rotateSpeed` / `dynamicDampingFactor` in
  `stellata.ts` constructor.
- **Right-click pan on/off** — `noPan` flag.
- **Chevron density** — `CHEVRON_SPACING_PX` / `_HALF_WIDTH` / `_DEPTH` in
  `distance-vector-overlay.ts`.
- **Focus ring size** — `RADIUS_PX` in `focus-ring-overlay.ts`.
  `hud-overlay.ts` mirrors the value as `FOCUS_RING_RADIUS_PX` so the
  HUD's shaft-start computation tracks the same circle.
- **HUD ring size** — `RING_SIZE_FACTOR` (5×) and `RING_FOV_ANCHOR_DEG`
  (10°) in `hud-overlay.ts`. The ring radius is
  `RING_SIZE_FACTOR × f.sizeMax × (RING_FOV_ANCHOR_DEG / fov)`. Bump the
  factor to make the OBSERVE-mode HUD ring more prominent at typical
  FOVs; lower the anchor to make zoomed-in views grow the ring more
  aggressively.
- **HUD halo gap** — `RING_HALO_GAP_PX` (4 px) in `hud-overlay.ts`.
  Distance between the active ring rim (focus ring in navigate, HUD
  ring in observe) and the start of the Sol/GC arrow shafts.
- **Constellation polygon prominence** — `#con-polygon` stroke/fill in
  `styles.css` (currently deliberately subtle).
- **Star size defaults** — `MAG_PRESETS` table in `stellata.ts`. Each
  entry is `(maxAppMag, sizeSpan)`; sizeMin/Max are derived from
  `STAR_PSF_ARCSEC × starExaggerationK[preset]` (with the √Δm factor
  for max).
- **Star exaggeration constants** — `STAR_EXAGGERATION_K_DEFAULTS` in
  `stellata.ts`, keyed per magnitude preset (naked-eye = 12,
  binoculars = 9, all = 5). Higher = bolder, more cartoonish stars;
  lower = more literal physics. Per-preset because wider catalogs need
  smaller K to avoid washing out. Live-tunable via the debug panel —
  the slider drives whichever preset is currently active.
- **Default camera FOV** — `DEFAULT_FOV` (50°) in `stellata.ts`. Reset
  button on the FOV slider snaps back here.
- **Max apparent magnitude presets** — `data-preset` attributes on
  `.mag-preset` buttons in `index.html` map to `MAG_PRESETS` keys
  (`naked-eye`, `binoculars`, `all`).
- **Soft-taper width** — the `+0.5` offset in `magOk`
  (`star.vert.glsl`) and the matching `smoothstep(uMaxAppMag, uMaxAppMag
  + 0.5, vAppMag)` in the fragment shader's glow pass. Wider = softer
  fade-in across the magnitude limit; 0 = hard cutoff.
- **Star-gap radius around constellation lines** — `STAR_GAP_PX` in
  `constellation-overlay.ts`.
- **Warp duration curve** — `WARP_T_MIN_MS`, `WARP_T_MAX_MS`,
  `WARP_T_K_MS` (ms-per-log10-parsec slope) in `stellata.ts`. Also
  `WARP_REORIENT_MS`. Arrival offset is per-star via `minDistForStar`.
- **Physical-size ceiling** — `computePhysMaxPx` in `stellata.ts`
  returns 50% of the smaller viewport axis. Biggest catalog star at
  min orbit distance fills this much. Lower to reduce how dominant
  supergiants feel up close.
- **Variability time compression** — `uSecondsPerDay = 0.2` (1 catalog
  day = 0.2 s real time) and `uMinPeriodSec = 4` (minimum effective
  cycle length, prevents strobing) in `stellata.ts` shared-uniforms.
- **Variability trough floor** — `VAR_TROUGH_FLOOR_FRACTION = 0.2` in
  the vertex shader (and mirrored in `renderedSizePx`). Trough won't
  shrink below 20% of the star's current baseline size.
- **Luminosity-class softness range** — `mix(3.0, 1.8, vSoftness)` for
  glow falloff and `mix(0.48, 0.38, vSoftness)` for disc edge AA in
  `star.frag.glsl`. Widen the gaps for more dramatic differentiation.
- **Binary-companion viewport margin** — `BINARY_VIEWPORT_HALF_ANGLE_RAD`
  in `stellata.ts` (25°). Controls how much padding is left around a
  system when focused. Smaller angle = more padding.
- **Info-modal dismissal** — cleared by removing the
  `stellata.info-dismissed` localStorage key.
- **Chart-mode disc size range** — `uChartDiscMaxPx` (16 px) and
  `uChartDiscMinPx` (1.5 px) defaults set in the shared-uniforms map
  in `stellata.ts`; spread linearly across the visible magnitude
  range. `uChartMagBright` (−2.0) is the magnitude that maps to MAX.
- **Variable-ring gap** — `VARIABLE_RING_MIN_GAP_PX` (1.0 px) in
  `chart-labels.ts`. Minimum radial gap between the outer ring and
  the peak inner disc; raise if low-amplitude variables look
  cluttered.
- **Binary-wing extension** — `BINARY_WING_EXTENSION_PX` (4 px) in
  `chart-labels.ts`. Length past each disc edge.
- **Star-name label offset** — `STAR_LABEL_OFFSET_PX` (9 px) in
  `chart-labels.ts`. Distance from the disc centre to the label
  anchor, applied as `(x + offset, y - offset)` for a top-right read.
- **Pick hit-radius floor** — `MIN_DISC_HIT_RADIUS_PX` (4 px) in
  `star-geometry.ts`, consumed by `Picker.pickStar`. Floor on the
  prime-disc hit test so
  tiny chart-mode discs stay hoverable. Raise for easier hover at the
  cost of more cases where a neighbour disc whose centre is
  marginally closer to the cursor wins over the visually-targeted
  star (`pickScore` tiebreak — see `star-geometry.ts`).
- **Pick magnitude bias** — `PICK_MAG_BIAS_PX_PER_MAG` (0.05 px/mag)
  in `star-geometry.ts`. Sub-pixel weight on `appMag` in `pickScore`
  so two coincident catalog rows (e.g. Alula Australis A/B) tiebreak
  to the brighter component without disturbing the screen-pixel
  proximity ordering for any visible separation.
- **Panel collapse default** — persisted under `stellata.panel-collapsed`
  (`'0'` = expanded, `'1'` = collapsed, missing = collapsed by default for
  first-time visitors). The default-collapsed check is phrased as
  `!== '0'` in `panel-layout.ts` so absence of the key means collapsed.
