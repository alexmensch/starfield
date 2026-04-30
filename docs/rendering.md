# Rendering

Everything visual on the WebGL side: the star pipeline (instanced quads,
two passes, physical-size, luminosity softness, variability), the dust
extinction layer, the galactic reference layer (disc + grid sphere +
Sol/GC arrows), molecular clouds, and the volumetric Milky Way band.
For the underlying physics and density profiles, see `SCIENCE.md`.

## Star rendering: instanced quads, two passes

Stars are rendered as **instanced unit-quads**, not `THREE.Points`. Points
were capped by the driver-defined `gl_PointSize` max (commonly 64–511 px)
— too small for the close-range physical-size rendering, which can
target up to 50% of the viewport. Each instance is one `aCorner` vertex
× 4, expanded to screen-space pixels in the vertex shader by projecting
the star centre, then offsetting each corner in clip space by
`corner × pxSize / viewport × 2 × centre.w` (the `×w` makes the offset
perspective-correct so stars stay a fixed pixel size regardless of
depth).

Rendering is **three passes over the same instanced geometry**:

- **Core depth-mask** (`renderOrder = -4`). Depth-only pass over disc-pass
  cores (`glow ≥ uCoreThreshold`). `colorWrite = false`, `depthWrite =
  true` — emits no colour but stamps near-z into the depth buffer before
  any background layer renders. Causes the Milky Way, molecular clouds,
  galactic disc, and galactic grid (all `depthTest: true`) to depth-fail
  behind close-range disc cores rather than bleeding through. Mesh
  `visible` is gated CPU-side: each frame, a tight `Float32Array` loop
  over `_localPositions` returns `true` on the first star within
  `dThresh = uPhysMaxPx × uRefDistPc / CORE_MASK_MIN_PX` (≈ 0.5 pc with
  default settings). When no star is that close, the entire draw call is
  skipped.
- **Disc pass** (`renderOrder = 0`). Stars where `vPhysRatio ≥ 0.5` —
  i.e. the physical-size term dominates the final `max(appSize,
  physSize)`. Premultiplied-alpha blend + `depthTest` + `depthWrite`.
  Halo fragments (`glow < uCoreThreshold`) push `gl_FragDepth = 1.0` so
  they paint dim haze without occluding the later glow pass — distant
  stars peek through the halo additively.
- **Glow pass** (`renderOrder = 1`). Stars where `vPhysRatio < 0.5`.
  Additive blending + depthTest but no depthWrite, so overlapping
  distant-field stars accumulate brightness (Milky Way density stays
  alive) and glows correctly depth-fail against any disc drawn in pass 2.

All three materials share a single `InstancedBufferGeometry` and the
same `uniforms` map (the only divergent uniform is `uRenderMode` bound
to its material). The disc pass discards fragments with `vPhysRatio <
0.5`; the glow pass discards `vPhysRatio ≥ 0.5`; the core mask discards
both `vPhysRatio < 0.5` and `glow < uCoreThreshold`.

`uHideFocusIdx` (int) suppresses a single star across all three passes
by collapsing its vertex to a clip-space sentinel (`gl_Position =
vec4(2, 2, 2, 1)`) when `gl_InstanceID == uHideFocusIdx`. Defaults to
`-1` (no suppression). Used by OBSERVE mode (camera parked at the focal
star — disc would render from inside) and held pinned to the source
star throughout an observe-launched warp so the reorient phase doesn't
flash the focal disc as the camera pulls away. Cleared back to `-1` by
`finishWarp` for navigate-mode arrivals; reset to the new anchor by
`swapObserveAnchor` for observe→observe arrivals.

`ShaderMaterial({ glslVersion: THREE.GLSL3 })`. Vertex shader uses `uint`
uniforms and bitwise ops for the spectral-class mask. Do **not** downgrade to
GLSL1 — the mask logic would need to be rewritten as per-class bools.

Mono mode swaps both materials to `MultiplyBlending` + disables depth
for an ink-on-paper look against the light canvas.

## Physical-size rendering

Each star's final pixel size is `max(appSize, physSize) × pixelRatio`
in the vertex shader:

- `appSize` is the brightness-based term:
  `mix(uSizeMin, uSizeMax, sqrt(brightness))` where
  `brightness = clamp((uMaxAppMag - appMag) / uSizeSpan, 0, 1)`. Dominates
  for distant stars. The √Δm shape comes from a Gaussian-PSF model: a
  star's "perceived disc" is where the PSF intensity exceeds the
  detection threshold, which grows as the square root of magnitudes
  above threshold (see `SCIENCE.md` §Stellar perception model). The
  endpoints `uSizeMin/Max` are derived per-frame from the active
  magnitude preset's angular targets converted to pixels (see
  §Magnitude presets and angular-size calibration below).
- `physSize = sizeAtRef × (uRefDistPc / dPc)` where `sizeAtRef` linearly
  maps `log10(physicalRadius)` between catalog min and max into
  `[uPhysMinPx, uPhysMaxPx]`. At the reference distance
  (`uRefDistPc = controls.minDistance = 0.005 pc`), the biggest star in
  the catalog renders at `uPhysMaxPx` pixels; smallest at `uPhysMinPx`.
  Dominates at close range, falls off as `1/d`.

A **soft taper** runs in the fragment shader's glow pass: stars within
+0.5 mag of `uMaxAppMag` survive vertex culling and fade in glow
intensity via `1 - smoothstep(uMaxAppMag, uMaxAppMag + 0.5, vAppMag)`
so the limit doesn't pop in/out as the slider moves. The disc pass
hard-clips at `uMaxAppMag` (resolved discs in the fade region would
render as a sub-pixel speck and read as a hard cutoff anyway).

## Magnitude presets and angular-size calibration

Three presets live in `MAG_PRESETS` in `starfield.ts`: `naked-eye`
(m_lim = 6.5, span = 8 mag), `binoculars` (10.5, 12), and `all`
(15, 17). Each carries `sizeMinArcsec` / `sizeMaxArcsec` — the *angular*
size of the threshold disc and the saturation disc on the sky, derived
from the eye's PSF width (σ = `STAR_PSF_ARCSEC` = 30″) scaled by a
per-preset exaggeration constant in `STAR_EXAGGERATION_K_DEFAULTS`
(naked-eye = 12, binoculars = 9, all = 5). The literal PSF puts
threshold stars at sub-pixel size on a 60° viewport; the exaggeration
scales σ up to a readable pixel range while preserving the √Δm ratios
between stars. K is per-preset because the population mix changes with
the magnitude limit — wider catalogs use a smaller K so the denser star
population doesn't wash out into a solid field. The K table is
module-level mutable so the debug panel can sweep the active preset's
K visually — `setStarExaggerationK(k)` patches the active preset (or a
named one), recomputes `MAG_PRESETS`, and re-applies the active
preset's pixel sizes to non-overridden fields.

`computePresetPxSizes(name)` converts arcsec → pixels via
`arcsecPerPx = (camera.fov × 3600) / max(window.innerWidth, innerHeight)`.
Using `max(w, h)` instead of just height gives consistent absolute
star sizes across portrait/landscape orientations and ultrawide
monitors. `applyMagnitudePreset(name)` (preset-button click) writes
activePreset + maxAppMag + sizeSpan + sizeMin/Max, respecting per-field
override flags. `recomputePresetPxSizes()` (viewport resize / FOV
change / K change) only updates non-overridden sizeMin/Max — manual
maxAppMag and sizeSpan tweaks survive resizes.

**Override flags** (`sizeMinOverridden`, `sizeMaxOverridden`,
`sizeSpanOverridden` on `FilterState`) are set by slider input and
cleared by the per-section reset buttons (`size-reset` clears
sizeMin+sizeMax, `span-reset` clears sizeSpan). Once cleared, the
field snaps back to the active preset's value. This is what lets
manual tweaks survive preset switches and viewport resizes.

**Camera FOV** defaults to `DEFAULT_FOV` = 50° vertical and is
user-tunable via the FOV slider in the panel (`#fov`, range 10°–120°).
`setCameraFov(fov)` updates `camera.fov`, calls
`updateProjectionMatrix()`, and triggers `recomputePresetPxSizes()`
so non-overridden star sizes scale appropriately. URL `fov=` carries
the value when diverged from default.

`uPhysMaxPx = 0.5 × min(viewportW, viewportH)` in CSS pixels — the
biggest catalog star at min orbit distance therefore fills 50% of the
smaller viewport axis. Updated on resize.

`uPhysMinPx = 2 px` — smallest stars at min orbit don't disappear.

A varying `vPhysRatio = physSize / max(pxSize, 0.001)` is passed to the
fragment shader to drive the pass split (above) and the luminosity-class
softness blending (below).

## Star intensity profile

Both the disc and glow passes share a single **super-Gaussian** falloff
shape, parameterised so the perceived bright disc fills the calibrated
quad to its edge:

```
raw  = exp(-K · (2r)^n)            with K = -ln(uVisibleThreshold)
glow = max(0, (raw − uVisibleThreshold) / (1 − uVisibleThreshold))
```

The threshold subtraction makes `glow = 0` exactly at `r = 0.5`, so the
visible region matches the calibrated `sizeMaxArcsec` instead of fading
into a long sub-perceptual tail. `uVisibleThreshold` controls fullness:
higher → wider visible disc, sharper transition; lower → softer, longer
tail. Default 0.2.

`n` is driven by two inputs:

- **Distance** via `vPhysRatio`: low values (distant unresolved point)
  produce a soft Gaussian-like falloff (n ≈ 2–3); high values (close-range
  resolving disc) produce a wide plateau with a sharp edge (n ≈ 5–10).
  This replicates the "atmospheric blur" feel without a separate blur
  pass — distant stars naturally read as fuzzy, close stars read as
  resolved discs. Implementation: `distN = mix(uDistNMin, uDistNMax,
  smoothstep(0, 0.5, vPhysRatio))`.
- **Luminosity** via `vSoftness = clamp(iLumClass / 9, 0, 1)` from
  per-instance `iLumClass` (0=WD, 2=V, 4=III, 6–9=supergiant classes,
  255=unknown → V). Hypergiants stay fuzzier than dwarfs at equivalent
  distance via a multiplicative bias: `n = distN × mix(uLumBiasMin,
  uLumBiasMax, vSoftness)`. Default range `1.0 → 0.6`.

Physical radius already makes supergiants render much larger than dwarfs.
The softness bias adds visual *character* at similar pixel sizes — a
same-size WD and a Betelgeuse-like supergiant look materially different
even at identical diameters.

The disc pass adds two depth-handling rules on top of the shared profile:

- **Halo transparency.** When `glow < uCoreThreshold`, the fragment
  paints its dim alpha-blended colour but writes `gl_FragDepth = 1.0`
  (far plane). The later glow pass's distant stars then pass the depth
  test and accumulate additively on top — the haze stays visible while
  background stars peek through. The core mask handles the inverse
  problem (preventing MW/grid from bleeding through the bright core).
- **Discard fringe.** `glow < uDiscardThreshold` (default 0.02) drops
  the fragment entirely so the imperceptible outer pixels don't cost
  a depth write or no-op blend.

All seven knobs are live-tunable from the debug panel (`debug.panel()`)
under "Star disc": `visibleThreshold`, `coreThreshold`, `discardThreshold`,
`distN min/max`, `lumBias dwarf/hypergiant`. See `STAR_RENDER_DEFAULTS`
in `starfield.ts` for shipping values; `setStarRenderParams(patch)` is
the programmatic setter.

## Variable star rendering

Per-instance `iPeriodDays` + `iAmplitudeMag` (0 = not variable).
`uTime` advances in real seconds; `uSecondsPerDay = 0.2` compresses
catalog time (5 days/sec). `uMinPeriodSec = 4` clamps the shortest
effective cycle so sub-day variables (RR Lyrae, Algol) don't strobe.

Shader applies a **sinusoidal magnitude modulation** plus a **matching
radius factor** to the physical-size term:

- `magMod = 0.5 × ampEff × sin(2π × t / period)` adjusts `appMag`,
  affecting point-glow size for distant stars.
- `radiusFactor = 10^(-magMod / 5)` applies to `physSize`, affecting
  resolved-disc radius for close stars. This is Stefan–Boltzmann-derived:
  `R ∝ √L` at constant T, which is the defensible single-model
  assumption even though real variables also swing temperature.

`ampEff` is the per-frame *compressed* amplitude:
`min(iAmplitudeMag, 10 × min(log10(cap / baseSize), log10(1 / 0.2)))`.
Translating: effective amp is reduced so the pulse's peak at most hits
`uPhysMaxPx` and its trough at most 20% of the current baseline. This
keeps the sine smooth (no plateau clipping at the cap, no disappearing
into a pixel at the trough) across the full amplitude range from
Cepheid-sized swings to dramatic Miras.

`renderedSizePx` in `starfield.ts` replicates this whole shader pipeline
on the CPU so the SVG `disc-mask` and focus-ring overlays follow the
pulsating disc size exactly frame-by-frame.

## Dust extinction + the shelved particle layer

Per-star extinction reads the Edenhofer dust texture in `star.vert.glsl`,
raymarches camera→star, and applies A_V to `appMag` (dimming) and
E(B−V) = A_V/3.1 to `iCi` (reddening). Default strength = 1 (physical
realism); user knob: `starfield.setExtinctionStrength(x)` from the dev
console. This is the canonical "view of the dust" in the app — looking
through dust dims and reddens stars behind it, which is what you'd
actually see.

The `dust-particle.{vert,frag}.glsl` shaders, `attachDustParticles()`
method, and `setParticleStrength()` API render the same dust as discrete
additive billboards for direct visualisation. **Currently shelved** —
loaded but disabled (default strength = 0; mesh.visible = false → zero
draw cost). The visual balance between "individual particles distinct"
and "smooth additive fog from overlap" needs more iteration before
promoting to a user-facing feature. There's also a deeper question:
real interstellar dust is *dark*, not luminous, so additive rendering
is artistically pretty but inverts physical reality. See
NEXT_STEPS.md "Revisit dust visualisation" for the open questions.

The data plumbing (preprocessor, manifest, LFS, loader, mesh) is fully
wired so revisit work is purely render-tuning, not infrastructure.

## Galactic reference system

Three layers anchor the local star clump against the Milky Way's geometry.

**Shared module** `galactic-coords.ts` exports `GAL_TO_ICRS` (Matrix4)
and `GALACTIC_CENTRE_PC` (Vector3 at R₀ = 8.122 kpc), built from the
J2000 IAU galactic-pole and galactic-centre angles with explicit
re-orthogonalisation. The Milky Way volumetric layer (Phase 5) reuses
these constants directly — keep the module minimal and stable.

**Galactic disc outline** (`galactic-disc.ts`) — *always on in dark mode,
hidden in chart mode*. A 15 kpc midplane ring, two thickness rings at
±400 pc, and a 3 kpc × 1.5 kpc bulge wireframe (three orthogonal ring
loops in the galactic frame), all centred on the galactic centre — Sol
sits ~8 kpc *inside* the disc, not at its middle. Each ring is a basic
`LineLoop` whose vertices are pre-baked once into absolute ICRS via
`GAL_TO_ICRS` plus the GC offset; per frame `discGroup.position` is
rebased to `-worldOffset` (via `.copy(worldOffset).negate()` on the
group's own position vector so the shared `worldOffset` is never
mutated). Opacity smoothsteps from 0 to 0.55 between **500 pc and 5 kpc**
distance-from-Sol so the disc stays out of the way for local browsing
and reveals as the user zooms out. In chart mode the layer is hidden
entirely — a 15 kpc reference ring reads as visual noise on a paper-chart
aesthetic, and the arrows + sphere already provide orientation.

**Galactic coordinate sphere** (`galactic-grid.ts`, toggleable) —
equator + 16 latitude rings every 10° (range −80° to +80°) + 36
meridians every 10°, radius 50 kpc.

- The **equator** is a `Line2` with `LineMaterial` (from
  `three/examples/jsm/lines/`) at 2.4 px screen-space width — basic
  `LineBasicMaterial.linewidth` silently clamps to 1 in WebGL on most
  platforms, so Line2 is the only reliable way to get a thicker stroke.
  256 segments around the full loop; the small joint-wedge "ticks" you
  may notice are an inherent artefact of fat-line miters at non-trivial
  angles. `LineMaterial` requires its `resolution` uniform to track the
  canvas, so `Starfield.onResize` calls `galacticGrid.setResolution(w, h)`.
  Bumping segment count to 1024 hides the ticks but was rejected as
  visually similar; we kept 256.
- **Latitude rings + meridians** are basic `LineLoop` / `Line` at 0.45
  opacity. The polar bunching of 36 meridians is eased by trimming
  every other meridian (l = 10°, 30°, …) to ±80° latitude — the
  every-20° set still goes pole-to-pole unbroken.
- **No pole markers.** Earlier iterations had small + crosses at
  NGP/SGP; they read as visual clutter and were dropped.
- The whole sphere tracks the camera each frame
  (`gridGroup.position.copy(camera.position)`), so it conceptually
  represents "the sky from here". Orientation is fixed in absolute
  galactic space so b=0 / l=0 stay correctly aimed through any camera
  move including warp.

**Sol + Galactic Centre arrows** (part of the HUD — `hud-overlay.ts`,
toggled by `filter.showHud`, separately from the sphere/grid). Rendered
as **SVG** paths inside `#overlay`, not 3D meshes. Geometry is computed
entirely in screen space:

1. Project the origin (focused star's local position when focused, else
   `controls.target`) into screen pixels. If the projection is degenerate
   — the OBSERVE steady state, where the camera sits at the focal star —
   fall back to screen centre. Same fallback applies for the rare frames
   near a transition endpoint where the focal-star projection collapses.
2. Derive the projected arrow direction in 2D. Two paths, picked by which
   one is well-defined this frame: (a) project an auxiliary point a small
   step along the 3D direction from `origin` and take the screen-space
   delta — gets perspective right when `origin` ≠ camera; (b) fall back
   to the direct screen vector from the anchor to the projected target —
   the aux-step collapses when `origin` sits at the camera (OBSERVE
   steady state, where the camera is parked at the focal star), and a
   target-projection from the screen-centre anchor gives the right
   angular direction since camera == origin in that case.
3. Build `shaftStart = originScreen + shaftStartPx × screenDir` and `tip =
   shaftStart + shaftLengthPx × screenDir`, both in pixels. The shared
   `buildArrowSvgPath` helper emits the chevron arrowhead perpendicular
   to the projected shaft, so the wings always face the camera by
   construction (no 3D billboard math required). `shaftStartPx` is mode-
   aware (see "Shaft start radius" below) so the arrows attach to the
   visible ring — focus ring in navigate, HUD ring in observe — and lerp
   smoothly through the transition.

Critical invariant: `shaftStartPx` is applied in **screen space**, not
3D world space, so the gap from anchor to shaft start is always exact
regardless of how aligned the arrow's 3D direction is with the camera
view axis. This is what makes the navigate-mode arrows clear the 24 px
focus ring at every viewing angle (28 px = 24 + 4 halo gap), and what
makes the observe-mode arrows attach to the HUD ring rim at every FOV.
Computing the offset in 3D world space and then projecting (the obvious-
but-wrong approach) collapses the gap to sub-pixel when `dir` is parallel
to the view axis, and the shaft ends up inside whichever ring is meant
to clear it.

`shaftLengthPx` is nominally `ARROW_PIXEL_LENGTH = 110` but cinches
inward when the projected target sits inside the nominal shaft: the
target's local-frame position is projected and its screen offset along
`screenDir` gives `projAlong`. If `projAlong < 110 + shaftStartPx +
sizeMax`, the shaft shortens so the chevron tip sits `sizeMax` px short
of the target — keeps the arrow from crowding (or overlapping) the
target's rendered disc when zoomed in close. `sizeMax` is the
camera-panel "Max" pixel size. Below 8 px of remaining shaft we hide
rather than draw a stub.

Arrow hidden when the projected direction is < 1 px long (camera is
looking exactly along the arrow's 3D direction); rare and there's no
useful 2D direction to draw. Sol arrow also hidden when focused on Sol —
pointing at yourself adds nothing.

**HUD ring.** A translucent screen-centred circle drawn in OBSERVE mode
(and during the navigate↔observe transition) when `showHud` is on. The
ring's radius is fixed in **angular** units — it represents a constant
visual cone in the camera's field of view, so its on-screen pixel radius
scales **inversely with FOV**:

```
ringRadiusPx(fov, sizeMaxPx) = 5 × sizeMaxPx × (10 / fov)
```

Anchor: at the narrowest FOV (10°) the radius is `5 × f.sizeMax` — the
factor of 5 keeps the ring legibly large at typical FOVs (raw `sizeMax`
is single-digit pixels and would render as a dot). Above 10° the ring
shrinks `1/fov`, keeping the same angular size. Tying the anchor to `sizeMax` keeps the ring on the same visual
scale as the brightest stars in the scene; widening the camera FOV makes
both the stars and the ring shrink in lockstep, so the ring stays a
small but visible HUD widget at any zoom. The Sol/GC arrows attach to
the rim and swivel around it as the user looks around — the ring is the
visualisation of the conceptual "starts at this angular distance"
attachment point.

During the navigate→observe transition the ring grows from radius 0 to
`ringRadiusPx`, eased by the same `f` that drives `updateObserveTransition`.
The reverse direction shrinks it back to 0. The focus ring
(`focus-ring-overlay.ts`) does the opposite — its 24 px radius lerps to
0 on enter, back to 24 on exit — so the two circles morph through each
other and the arrows feel continuously attached to whichever circle is
dominant. The eased progress is exposed by
`Starfield.getObserveTransitionProgress()`.

**Shaft start radius (unified).** `hud-overlay.ts` computes a single
`shaftStartPx` per frame as `activeRing + RING_HALO_GAP_PX` (4 px), where
`activeRing` is whichever ring is dominant this frame:

| State                                   | `activeRing`                                   |
| --------------------------------------- | ---------------------------------------------- |
| Navigate, no transition                 | `FOCUS_RING_RADIUS_PX` (24)                    |
| Observe, no transition                  | `ringRadiusPx(fov, sizeMaxPx)` (= R)           |
| Enter transition (`navigate → observe`) | `max(24·(1-f), R·f)`                           |
| Exit transition (`observe → navigate`)  | `max(24·f, R·(1-f))`                           |

So the arrow shaft sits 4 px outside whichever circle is currently
visible — same halo gap in both steady states, smooth lerp through the
transition. In the OBSERVE steady
state the focal-star projection is degenerate (camera sits at the focal
star), so the anchor falls back to screen centre — and the post-
transition switch is invisible because the projection has already drifted
to centre by `f = 1`. Distance labels measure from `origin` (the focal
star or `controls.target`) so the displayed distance reflects "from the
focal star", which is meaningful in both modes.

SVG distance labels (`#sol-arrow-label`, `#gc-arrow-label`) sit at
`tip + (LABEL_OFFSET_PX + ARROW_HEAD_DEPTH_PX, -LABEL_OFFSET_PX)` —
same exact offsets as the distance vector's label. Labels are
**clickable** (`pointer-events: auto` + cursor:pointer) — clicking
either invokes `Starfield.aimAt(localPoint)` which slerps the camera
around `controls.target` to centre the named object in view. Duration
scales with rotation angle, capped at 2 s and floored at 250 ms;
TrackballControls is disabled for the duration so its damping doesn't
fight the slerp. In-flight aim is superseded if a warp starts.

**Shared arrow path** (`arrow-path.ts`) — the `buildArrowSvgPath(shaftStartX,
shaftStartY, tipX, tipY)` helper builds shaft + chevron arrowhead given
two screen-space endpoints. Used by both the distance vector overlay and
the Sol/GC arrows so all three on-screen arrows share one silhouette,
one chevron size (5 × 4 px), and one label-placement convention. Also
exports `ARROW_LABEL_OFFSET_PX` and `ARROW_LABEL_PADDING_PX`.

The **distance vector** (`distance-vector-overlay.ts`) was unified onto
the same path during Phase 4c — it's now a solid shaft + chevron rather
than a chain of repeated chevrons. Symmetric 28 px insets from each
star (was asymmetric 28/14). Label format unified to
`<destination name> · <distance>` (matches Sol/GC's `<target> ·
<distance>` form), and the label is anchored at the chevron tip with
the same offset as the Sol/GC labels rather than at the vector midpoint.
The warp suffix follows by full label width (label switched from
`text-anchor="middle"` to `start`).

**State + UI:** two independent FilterState booleans:

- `showGalacticGrid` — gates the 3D grid sphere only. URL `grid=1`,
  default-omitted. Panel checkbox lives under **Overlays**.
- `showHud` — gates the HUD: Sol/GC arrows in both modes, plus the
  OBSERVE-mode ring. URL `hud=1`, default-omitted. Panel checkbox lives
  under **Navigation** ("Head up display (HUD)") since the HUD's role is
  navigational orientation. Future HUD widgets hang off the same flag.

The disc has no toggle by design — it's the orientation primitive the
catalog itself was missing, and is hidden in chart mode anyway.

**Chart mode** (mono):
- Disc layer hides entirely.
- Sphere + grid swap stroke colour to dark grey (`#3a3530`), no
  transparency, no blending. The equator/line opacity split is dropped
  in chart mode (paper-chart aesthetic doesn't fade).
- Distance vector + Sol/GC arrows + HUD ring all collapse to the same
  dark-grey-on-white-halo palette via CSS rules on `.gal-arrow*`,
  `#dist-line*`, and `.hud-ring` — no per-frame palette logic;
  `setMonochrome(on)` on `HudOverlay` is intentionally empty since the
  SVG class routing handles it.

**Warp visibility:** `updateGalacticLayers` hides the 3D disc + grid
groups while `warpState !== null`; SVG arrow paths and labels are
hidden via the existing `body.warping #overlay { display: none }` rule.

**Camera matrix freshness:** `updateGalacticLayers` calls
`camera.updateMatrixWorld()` before any SVG projection. `controls.update()`
mutates `camera.position`/`quaternion` but doesn't propagate to
`matrixWorld`/`matrixWorldInverse` — the renderer would do that for us,
but the SVG projection runs *before* `renderer.render()`, so without
this call the labels lag by one frame during fast camera moves.

## Molecular cloud overlay (Phase 3a)

`molecular-clouds.ts` renders ~96 named local SF clouds as soft warm
ellipsoids. Default-on; toggle in the Galactic-overlays panel section,
URL param `mc=0` to disable. Stays visible during warp by design (flying
past Taurus is a feature, not noise).

**Data:** `public/clouds.json` is the merged output of `build-clouds.py`:
- Z2021 Table 1 → 12 ellipsoid clouds with axis-aligned bounding boxes in
  galactic Cartesian. The bbox is converted to centroid + semi-axes; the
  orientation `quat` is the GAL_TO_ICRS rotation so the ellipsoid local
  axes correctly point along galactic +X/+Y/+Z when scaled by the renderer.
- Z2020 Table A1 → 84 sphere clouds (sightline-aggregated by name; sphere
  radius = max distance of any sightline from the centroid, with a 5 pc
  default for singletons and a 3 pc floor). `quat` = identity.
- Z2021 entries take precedence over Z2020 for the clouds both cover
  (Chamaeleon, Ophiuchus, Lupus, Taurus, Perseus, Pipe, Cepheus, Corona
  Australis, Orion → A/B/λ split). Sub-regions like `Ophiuchus_Arc` /
  `Pipe_B59` stay separate Z2020 spheres.

**Render:** every cloud is one shared `SphereGeometry(1, 32, 16)` mesh
scaled per-instance to its semi-axes and rotated by its quaternion. The
fragment shader derives a smooth view-direction-based density —
`pow(|n·v|, 1.5)` — so silhouettes fade rather than hard-edge. Material
uses `DoubleSide` so the layer reads correctly when the camera is inside
a cloud. **Premultiplied alpha** is critical: the shader bakes intensity
into rgb (`vec4(col × intensity, intensity)`) and the material sets
`premultipliedAlpha: true`, so additive blending becomes `(ONE, ONE)` —
without it, src.alpha multiplies into rgb a second time and the cloud
comes out ~30× too dim to see. The shaders also avoid the `#version
300 es` directive and don't redeclare auto-injected attributes
(`position`, `normal`, `modelMatrix`, etc.); doing either silently
breaks the GLSL3 compile. Mono mode swaps to a soft warm grey with
normal alpha-over.

**Unified focus / measurement / warp UX.** Clouds are full participants
in the click-state machine alongside stars. Internal state holds two
mutually-exclusive pairs: `focusedStar` / `focusedCloud` and `vectorTo`
(star idx) / `vectorToCloud`. The click handler dispatches by what was
picked under the cursor — a cloud pick from a star focus sets a
star→cloud measurement vector; a cloud pick from a cloud focus sets a
cloud→cloud vector; clicking the current vector tip (star or cloud)
triggers the appropriate teleport (`focusStar` or `flyToCloud`); pressing
W or clicking the distance label dispatches to `warpTo` or `warpToCloud`
based on which vector slot is active. The two cloud-specific carve-outs
are (a) no focus ring (the SVG overlay reads `getFocusedStar` only and
naturally ignores `focusedCloud`) and (b) arrival distance is
`cloudViewingDistancePc` (= `2.4 × max(axes)`, with a 5 pc floor)
instead of `minDistForStar`.

**Picking + hover:** per-cloud `Mesh` objects participate in
`THREE.Raycaster` intersection via the cloud `Group`.
`Starfield.pickCloud` does the raycast; the click handler in
`onPointerUp` falls back to a cloud pick when no star is hit (stars take
priority because they're the smaller, more precise target), and
`bindHoverTooltip` does the same fallback so hovering over a cloud's
body shows its name + distance + axes in the existing tooltip element.

**Search:** cloud entries share the same Fuse fuzzy index as star
entries, discriminated by a `kind: 'star' | 'cloud'` tag. The Focus
search box dispatches by kind — cloud picks call `flyToCloud` (teleport
to viewing distance + set cloud focus); the To (distance vector) box
accepts both, dispatching to `setVectorToCloud` for cloud picks.

**`setOrbitTargetCloud(cloudIdx)`:** the click-without-focus path —
mirrors `setOrbitTarget` for stars. Moves orbit pivot to the cloud
centroid and sets the cloud focus, but leaves the camera position
unchanged. Camera doesn't teleport; user pivots around the cloud from
their current vantage. Calls `setFocusedCloud` first, which clears any
star focus → recenters the floating origin to Sol → the cloud's
absolute centroid is then directly usable as `controls.target`.

**`flyToCloud(cloudIdx)`:** the teleport path — used by search-select
and click-vector-tip. Mirrors `focusStar`: clears prior focus + vector,
positions camera at `cloud.centerAbs + viewDir × cloudViewingDistancePc`,
and sets the cloud focus. Snap, not animation; for animated travel the
user warps via the distance label.

**`warpToCloud(destIdx)`:** the cloud-destination warp. Source point is
the currently-focused star OR cloud (`currentFocusLocalPos`); destination
is the cloud's centroid; arrival offset is `cloudViewingDistancePc`. The
internal `WarpState` carries a `destKind: 'star' | 'cloud'` discriminator
so `finishWarp` parks at the right point and dispatches to either
`setFocus` or `setFocusedCloud` on arrival.

**Floating-origin handling:** clouds live in absolute ICRS space; the
group's `position` is rebased to `-worldOffset` per frame, the same
pattern as `GalacticDisc`. So focusing on a far star (which shifts the
floating origin to that star's absolute position) doesn't move clouds
visually — they stay anchored where they should.

**URL state:** `cloud=N` for the focused cloud (mutually exclusive with
`focus=N`), `toc=N` for a cloud measurement destination (mutually
exclusive with `to=N`), and `mc=0` to hide the layer (default omitted).

**Dev-console levers** under `starfield.cloudLayer.*`:
- `setOpacity(x)` / `setColor(0xRRGGBB)` — dark mode tuning
- `setMonoOpacity(x)` / `setMonoColor(0xRRGGBB)` — chart mode tuning
- `setDebugBoost(strength)` — force max-opacity (or `null` to restore);
  use this first when "I can't see anything" to confirm the layer is
  rendering at all.

## Milky Way volumetric disc (Phase 5)

`milkyway.ts` + `shaders/milkyway.{vert,frag}.glsl` render the integrated
surface brightness of unresolved Galactic stars by raymarching through
**two proxy meshes** anchored at the galactic centre — a flattened disc
(30 × 30 × 1.2 kpc envelope) and an oblate bulge (10 × 10 × 6 kpc
envelope), both rotated so their short axes align with NGP. Each
fragment ray-sphere-intersects its mesh in mesh-local frame, then
raymarches log-distributed steps from front-face entry (or the camera
position, if the camera is inside the mesh) to the back-face fragment,
accumulating emission with running dust extinction. The two meshes'
contributions add via additive blending. Default-on; URL `mw=0`
disables. Hidden in chart mode.

**Why a volumetric mesh, not a skybox.** An earlier version (rev 1) put
the integration in a 50 kpc camera-anchored skybox sphere and marched
camera→back-surface. Mathematically defensible, but visually it was a
"theatre backdrop": the geometry doing the work was a 2D sphere
enclosing the camera, so flying past the bulge produced no parallax —
the band reoriented in odd ways and the disc never read as an actual 3D
shape from outside. The volumetric-mesh approach replaces the enclosing
sphere with the *actual disc shape*, so standard 3D rasterisation
handles parallax by construction. From outside, you see a flattened
glowing lens; from inside, the path length through the volume varies
naturally with view direction (long along the plane, short toward NGP)
producing the right band geometry. The earlier rev's notes about
inverse(P×V) precision issues are no longer relevant — there's no
matrix inversion in this path.

**Density profiles** (constants baked into `milkyway.ts`; no runtime
data loads):
- **Disc**: `density0 × exp(-(R-R₀)/3000pc) × exp(-|z|/300pc)` — single
  double-exponential thin-disc-like profile. The originally-planned
  Jurić thin/thick/halo decomposition was simplified out during
  iteration; the smooth single component reads convincingly enough that
  the extra components weren't worth the calibration cost.
- **Bulge**: `density0 × exp(-r'/1000pc)` where `r' = sqrt(R² + (z/q)²)`
  is the oblate-spheroid radius with q = 0.6. Simple exponential
  rather than McMillan's power-law-times-Gaussian — the latter
  produced too-tight a "ball" that read as point-source-like in
  iteration.

Each component multiplies a population colour pre-integration, so the
band's hue varies by line of sight. Defaults are visually calibrated
(see commit `5a650b2`):
- DISC_COLOR pale-lavender (171,168,223), DENSITY0 = 1.5
- BULGE_COLOR near-white-warm (255,246,237), DENSITY0 = 18

**Magnitude consistency with stars.** Each fragment converts integrated
emission to an effective apparent magnitude:
  `appMag = uGlowMagOffset - 2.5 × log10(integratedIntensity)`
and derives a slider-driven gain:
  `gate = max((uMaxAppMag - appMag) / uSizeSpan, 0)  // no upper clamp`
folded into the tone-map exponent:
  `result = 1 - exp(-colorAccum × brightness × gate)`

The lack of upper clamp on `gate` matters. An earlier version clamped
it to [0, 1] and applied as a post-tone-map multiplier, which made
bright sightlines plateau the moment they reached "fully visible"
(commit `4e8ff06` fixed this). Folding gate into the exponent and
removing the upper clamp lets the slider continuously lift every
sightline — dim NGP brightens, GC saturates toward white. Mental
model: max-mag depth = "more stars visible", which should brighten
both points and diffuse glow.

`uMaxAppMag` and `uSizeSpan` are passed by-reference from the star
pipeline's shared uniforms map, so any `setFilter` change propagates
without duplicate bookkeeping.

`uGlowMagOffset` (default 15.0) calibrates volumetric "density × pc"
units to the star magnitude scale. `setGlowMagOffset(x)` — lower lifts
the layer through the gate sooner; higher demands a brighter slider.

**Coordinate handling.** The mesh-local unit sphere has +X/+Y aligned
with the galactic disc plane, +Z toward NGP. mesh.scale extends to
galactocentric pc per axis (disc 15000×15000×600; bulge 5000×5000×3000).
mesh.quaternion = GAL_TO_ICRS rotates galactic axes into ICRS world
axes. The shader transforms `cameraPosition` (renderer-local) →
galactocentric ICRS (subtract uGalCenter) → galactocentric galactic
(rotate by uIcrsToGal) → mesh-local (divide by uMeshScalePc): that's
`camLocal`. Ray-sphere intersection in this frame yields entry t
(clamped ≥ 0 if camera is inside) and exit t = 1 (back-face fragment
is on the unit sphere by construction). 32 log-distributed steps run
from tEnter to 1, with `|vWorldPos - cameraPosition|` converting back
to world parsec step size for dust optical-depth maths.

**Analytical-only dust** (no voxel sampling in this layer). Profile is
`norm × exp(-(R-R₀)/3500pc) × exp(-|z|/125pc)` — Drimmel & Spergel-
style thin-disc dust. Per step, opacity converts to per-channel optical
depth via CCM-derived reddening multipliers `(0.76, 1.0, 1.35)` — red
transmits most, blue extincts away — applied with Beer-Lambert running
attenuation including a half-step self-shielding term.
`setExtinctionStrength(x)` scales the dust globally; default 0.45.

The Edenhofer dust voxel grid is **intentionally not sampled here**.
Voxels have ~5 pc native structure designed for short per-star
sightlines. Sampling at coarse step intervals along long camera→
fragment rays (8-15 kpc) aliases into visible parallel streaks
regardless of step distribution. Voxels stay in use for per-star
extinction (`star.vert.glsl`); molecular cloud ellipsoids
(`renderOrder = -2`) carry the discrete near-cloud detail in front of
the band.

**Render path.** Two meshes, both `THREE.BackSide`, additive blending,
`depthTest = true` (so the star core depth-mask at `renderOrder = -4`
can occlude this layer behind close-range disc cores), `depthWrite =
false` (the glow never occludes anything later), `frustumCulled =
false` (the local bounding sphere is at origin but world position is
GALACTIC_CENTRE_PC - worldOffset). Render order:
- `-4` Star core depth-mask (depth-only, gated on close-star presence)
- `-3` Milky Way disc + bulge (this layer)
- `-2` Molecular clouds (Phase 3a)
- `-1` Galactic disc + grid reference rings (Phase 4c)
- `0` Star disc pass
- `1` Star glow pass

The meshes are NOT camera-anchored — they sit at the galactic centre.
`update()` rebases each mesh's position to `GALACTIC_CENTRE_PC -
worldOffset` per frame so under the floating-origin recentering both
project correctly into the renderer-local frame. The `vWorldPos -
cameraPosition` subtraction in the shader is float-stable for the
same reason the star pipeline is: both operands are renderer-local
with small magnitudes.

**Brightness baseline.** `DEFAULT_BRIGHTNESS = 5.35e-6`. The
volumetric integration produces large `colorAccum` values (~10⁴–10⁵
along the GC sightline), so brightness needs to be small to keep the
tone-map curve in a useful range. Calibrated empirically alongside
GLOW_MAG_OFFSET — the two settings cooperate, so retune them together
if the visual feel changes.

**Chart mode** hides the layer entirely — diffuse glow doesn't suit a
paper-chart aesthetic; the discrete cloud layer + reference rings
carry orientation there. **Warp** keeps it visible — the band
reorienting as the camera flies past the GC is the realism payoff.

**No FPS gate.** Performance optimisation deferred. Toggle via the
panel checkbox or `mw=0` URL.

**Dev tooling.** `debug.panel()` in the browser console attaches the
shared dev panel, which today hosts two sections:
- **Star disc** (`star-tuning.ts`): seven sliders for the super-Gaussian
  profile knobs — visibleThreshold, coreThreshold, discardThreshold,
  distN min/max, lumBias dwarf/hypergiant. See §Star intensity profile
  above for what each one shapes.
- **Milky Way** (`milkyway-tuning.ts`): log-scale slider for brightness
  + linear sliders for glowMagOffset / discDensity / bulgeDensity /
  extinctionStrength + colour pickers for disc + bulge palette + three
  sliders for the reddening RGB multipliers (linear since CCM channels
  exceed 1.0).

Call again to detach. `debug.milkyway()` is a kept alias for muscle
memory. The `DebugTools` interface in `debug.ts` is the registration
point if you add more dev tools later.

The same setters are also available individually under
`starfield.milkywayLayer.*`:
- `setBrightness(x)` — global gain in the tone-map exponent
- `setGlowMagOffset(x)` — magnitude calibration (raise → dimmer)
- `setDiscDensity(x)` / `setBulgeDensity(x)` — per-component emission
- `setDiscColor(r,g,b)` / `setBulgeColor(r,g,b)` — pre-extinction palette
- `setExtinctionStrength(x)` — analytical dust τ multiplier
- `setReddeningRGB(r,g,b)` — per-channel τ multiplier (CCM-derived)
