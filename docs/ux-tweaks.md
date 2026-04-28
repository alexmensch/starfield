# UX knobs

Reference table of common tweaks the user may ask for and where to find them.
See also `docs/rendering.md`, `docs/ui-and-controls.md`, and `docs/overlays.md`
for the surrounding context.

## Known UX knobs you may be asked to tweak

- **Orbit feel** — `rotateSpeed` / `dynamicDampingFactor` in
  `starfield.ts` constructor.
- **Right-click pan on/off** — `noPan` flag.
- **Chevron density** — `CHEVRON_SPACING_PX` / `_HALF_WIDTH` / `_DEPTH` in
  `distance-vector-overlay.ts`.
- **Focus ring size** — `RADIUS_PX` in `focus-ring-overlay.ts`.
- **Constellation polygon prominence** — `#con-polygon` stroke/fill in
  `styles.css` (currently deliberately subtle).
- **Star size defaults** — `MAG_PRESETS` table in `starfield.ts`. Each
  entry is `(maxAppMag, sizeSpan)`; sizeMin/Max are derived from
  `STAR_PSF_ARCSEC × starExaggerationK[preset]` (with the √Δm factor
  for max).
- **Star exaggeration constants** — `STAR_EXAGGERATION_K_DEFAULTS` in
  `starfield.ts`, keyed per magnitude preset (naked-eye = 12,
  binoculars = 9, all = 5). Higher = bolder, more cartoonish stars;
  lower = more literal physics. Per-preset because wider catalogs need
  smaller K to avoid washing out. Live-tunable via the debug panel —
  the slider drives whichever preset is currently active.
- **Default camera FOV** — `DEFAULT_FOV` (50°) in `starfield.ts`. Reset
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
  `WARP_T_K_MS` (ms-per-log10-parsec slope) in `starfield.ts`. Also
  `WARP_REORIENT_MS`. Arrival offset is per-star via `minDistForStar`.
- **Physical-size ceiling** — `computePhysMaxPx` in `starfield.ts`
  returns 50% of the smaller viewport axis. Biggest catalog star at
  min orbit distance fills this much. Lower to reduce how dominant
  supergiants feel up close.
- **Variability time compression** — `uSecondsPerDay = 0.2` (1 catalog
  day = 0.2 s real time) and `uMinPeriodSec = 4` (minimum effective
  cycle length, prevents strobing) in `starfield.ts` shared-uniforms.
- **Variability trough floor** — `VAR_TROUGH_FLOOR_FRACTION = 0.2` in
  the vertex shader (and mirrored in `renderedSizePx`). Trough won't
  shrink below 20% of the star's current baseline size.
- **Luminosity-class softness range** — `mix(3.0, 1.8, vSoftness)` for
  glow falloff and `mix(0.48, 0.38, vSoftness)` for disc edge AA in
  `star.frag.glsl`. Widen the gaps for more dramatic differentiation.
- **Binary-companion viewport margin** — `BINARY_VIEWPORT_HALF_ANGLE_RAD`
  in `starfield.ts` (25°). Controls how much padding is left around a
  system when focused. Smaller angle = more padding.
- **Info-modal dismissal** — cleared by removing the
  `starfield.info-dismissed` localStorage key.
- **Panel collapse default** — persisted under `starfield.panel-collapsed`
  (`'0'` = expanded, `'1'` = collapsed, missing = collapsed by default for
  first-time visitors). The default-collapsed check is phrased as
  `!== '0'` in `panel-layout.ts` so absence of the key means collapsed.
