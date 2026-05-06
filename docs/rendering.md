# Rendering: the star pipeline

The shared core of the WebGL star renderer — instanced quads, three
passes, physical-size scaling, the super-Gaussian intensity profile,
luminosity-class softness, variable-star pulsation, and the per-star
dust-extinction read. The other rendering subsystems live in sibling
docs:

- `docs/galactic-overlay.md` — disc + sphere grid + Sol/GC arrows + HUD ring
- `docs/molecular-clouds.md` — Phase 3a cloud ellipsoids
- `docs/milky-way.md` — Phase 5 volumetric disc / bulge
- `docs/chart-mode.md` — Phase 8 paper aesthetic (flat discs, isobars, labels)

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
  `dThresh = maxPhysicalRadiusPc / tan(CORE_MASK_MIN_PX × fov_y / 2 / viewport.y)`
  (the camera distance at which the catalog's largest star subtends
  `CORE_MASK_MIN_PX` pixels). When no star is that close, the entire
  draw call is skipped.
- **Disc pass** (`renderOrder = 0`). Stars where `vPhysRatio ≥ 0.5` —
  i.e. the physical-size term dominates the final `max(appSize,
  physSize)`. Per-channel `MaxEquation` blend (`CustomBlending` with
  `OneFactor` × `OneFactor`) + `depthTest` + `depthWrite`. The four
  blend fields live in one helper, `applyDiscBlendDefaults()`, called
  both at construction and on chart-mode → colour-mode swap-back, so the
  two sites can't drift. Halo fragments (`glow < uCoreThreshold`) push
  `gl_FragDepth = 1.0` so they paint dim haze without occluding the
  later glow pass — distant stars peek through the halo additively.
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

`uPinFocusToCenter` (int, default `-1`) replaces the standard projection
chain with `projectionMatrix * vec4(0, 0, -dPc, 1)` for the matched
instance, sidestepping the float32 cancellation that close-approach
otherwise produces. See `docs/architecture.md` § Pin-to-center
(`uPinFocusToCenter`) for the full rationale, the load-bearing
`controls.target` invariant, and the diagnostic HUD pointer.

`ShaderMaterial({ glslVersion: THREE.GLSL3 })`. Vertex shader uses `uint`
uniforms and bitwise ops for the spectral-class mask. Do **not** downgrade to
GLSL1 — the mask logic would need to be rewritten as per-class bools.

Chart mode (Phase 8) swaps both star materials to `MultiplyBlending` +
disables depth for an ink-on-paper look against the light canvas, and
replaces the super-Gaussian profile with flat hard-edged discs sized
linearly by magnitude. See `docs/chart-mode.md` for the full feature.

## Depth encoding

The renderer is constructed with `WebGLRenderer({ logarithmicDepthBuffer:
true })`. Linear depth doesn't have the dynamic range to handle the
camera dollying from `~1e-10` pc (intra-star) to `~3e4` pc (galactic
centre) without z-fighting at intermediate scales — log depth maps
`log(z+1) / log(far+1)` into the depth buffer so precision is roughly
constant in `log(z)` instead of collapsing near the far plane. This is
what enables `camera.near = 1e-10` (see `docs/camera-modes.md`).

Per-pass overrides on top of the chunk default:

- All star vertex/fragment shaders include the standard three.js
  `<logdepthbuf_pars_vertex/fragment>` + `<logdepthbuf_vertex/fragment>`
  chunks. The chunks populate the `vFragDepth` varying and write it
  into `gl_FragDepth` automatically — the fragment shader doesn't write
  `gl_FragDepth = gl_FragCoord.z` itself; that would be redundant.
- Off-screen-sentinel early-returns in `star.vert.glsl` and
  `dust-particle.vert.glsl` skip the `<logdepthbuf_vertex>` chunk and
  leave `vFragDepth` undefined. Safe because every vertex of the
  primitive lands at the same off-screen NDC, so the whole quad is
  clipped before rasterization and the fragment shader never runs. A
  load-bearing invariant — see the in-shader comments.
- The disc pass's halo override `gl_FragDepth = 1.0` (when
  `glow < uCoreThreshold`) writes the far-plane depth directly. `1.0`
  is the far plane in *any* depth encoding, so this works under
  log-depth without modification — distant stars in the later glow
  pass pass the depth test against haloed fragments and peek through.

Overlays (CPU-side projection in `arrow-path.ts` etc.) use a separate
constant `OVERLAY_NEAR_CLIP_PC = 1e-3` for their "is the projected
point in front of the camera?" gate. Decoupled from `camera.near`'s
GPU precision floor because overlays care about avoiding division-by-
zero in CSS pixel space, not z-buffer precision.

## Physical-size rendering

Each star's final pixel size is `max(appSize, physSize) × pixelRatio`
in the vertex shader:

- `appSize` is the brightness-based term. Below the visible-population
  window (`Δm = uMaxAppMag − appMag ≤ uSizeSpan`) it's the canonical
  `mix(uSizeMin, uSizeMax, sqrt(Δm / uSizeSpan))` Gaussian-PSF curve;
  see `SCIENCE.md` §Stellar perception model for the √Δm derivation
  (perceived radius ∝ √(magnitudes above threshold) because the visible
  footprint of a star is where PSF intensity exceeds detection). Above
  the window the size used to hard-clamp at `uSizeMax`, but that broke
  ratios in the close-approach regime — Sol and Barnard's Star at 5e-3
  pc both pinned to the cap despite a 2300× flux ratio. **Soft-knee
  saturation** (`uSizeKnee`, default 4 mag, debug-tunable) replaces the
  clamp with a Michaelis–Menten asymptote: `dMEff = uSizeSpan + uSizeKnee
  · over / (uSizeKnee + over)` where `over = Δm − uSizeSpan`. Identity
  below `uSizeSpan`, smoothly bending toward a ceiling of `uSizeSpan +
  uSizeKnee` as Δm → ∞. `uSizeKnee = 0` recovers the old hard clamp.
  Endpoints `uSizeMin/Max` are derived per-frame from the active
  magnitude preset's angular targets converted to pixels (see
  §Magnitude presets and angular-size calibration below).
- `physSize = 2·atan(R · radiusFactor / dPc) · viewport.y / uFovYRad`
  is the star's true angular diameter projected to pixels. `R` is the
  per-star physical radius in pc (decoded from the `iLogRadius` vertex
  attribute via `pow(10, iLogRadius)`); `radiusFactor` is the variability
  modulation. Falls off as `1/d` in the small-angle regime; saturates as
  `d → R` (disc fills the frame). This drops every artificial reference-
  distance + log-mapped-pixel-range knob in favour of pure geometry, so
  the on-screen disc ratio between any two stars at equal `d/R` matches
  their physical radius ratio.

A **soft taper** runs in the fragment shader's glow pass: stars within
+0.5 mag of `uMaxAppMag` survive vertex culling and fade in glow
intensity via `1 - smoothstep(uMaxAppMag, uMaxAppMag + 0.5, vAppMag)`
so the limit doesn't pop in/out as the slider moves. The disc pass
hard-clips at `uMaxAppMag` (resolved discs in the fade region would
render as a sub-pixel speck and read as a hard cutoff anyway).

## Magnitude presets and angular-size calibration

Three presets live in `MAG_PRESETS` in `stellata.ts`: `naked-eye`
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
`updateProjectionMatrix()`, mirrors the new value into `uFovYRad` (the
shader's angular-diameter scale), recomputes the focused star's orbit
floor (which depends on FOV), and triggers `recomputePresetPxSizes()`
so non-overridden star sizes scale appropriately. URL `fov=` carries
the value when diverged from default.

`uFovYRad` is the only viewport-derived shader uniform that drives
`physSize`. There is no per-pixel-range cap — a max-radius supergiant at
the orbit floor fills `ZOOM_FLOOR_FRACTION` (= 0.9) of the viewport's
minor axis purely because `minOrbitDistForStar` solves for that distance.
Smaller stars land closer to fill the same 90%; the camera near plane
(`1e-10`) gives several orders of magnitude of headroom even for white
dwarfs and Sirius B-class radii.

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
  paints its colour under the disc pass's `MaxEquation` blend (so the
  halo brightens the framebuffer per channel up to the halo's level)
  but writes `gl_FragDepth = 1.0` (far plane). The later glow pass's
  distant stars then pass the depth test and accumulate additively on
  top — the haze stays visible while background stars peek through.
  Trade-off under `MaxEquation` (vs the prior premul-alpha additive):
  faint halos against bright backgrounds wash out instead of summing,
  but disc-edge artefacts in close binaries are eliminated. The core
  mask handles the inverse problem (preventing MW/grid from bleeding
  through the bright core).
- **Discard fringe.** `glow < uDiscardThreshold` (default 0.02) drops
  the fragment entirely so the imperceptible outer pixels don't cost
  a depth write or no-op blend.

All eight knobs are live-tunable from the debug panel (`debug.panel()`)
under "Star disc": `visibleThreshold`, `coreThreshold`, `discardThreshold`,
`distN min/max`, `lumBias dwarf/hypergiant`, `sizeKnee` (the soft-knee
saturation extent above). See `STAR_RENDER_DEFAULTS` in `stellata.ts`
for shipping values; `setStarRenderParams(patch)` is the programmatic
setter.

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
`0.9 × min(viewportW, viewportH)` (the same fraction used for the
zoom-floor) and its trough at most 20% of the current baseline. This
keeps the sine smooth (no plateau clipping at the cap, no disappearing
into a pixel at the trough) across the full amplitude range from
Cepheid-sized swings to dramatic Miras.

`renderedSizePx` in `stellata.ts` replicates this whole shader pipeline
on the CPU so the SVG `disc-mask` and focus-ring overlays follow the
pulsating disc size exactly frame-by-frame.

## Dust extinction + the shelved particle layer

Per-star extinction reads the Edenhofer dust texture in `star.vert.glsl`,
raymarches camera→star, and applies A_V to `appMag` (dimming) and
E(B−V) = A_V/3.1 to `iCi` (reddening). Default strength = 1 (physical
realism); user knob: `stellata.setExtinctionStrength(x)` from the dev
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
