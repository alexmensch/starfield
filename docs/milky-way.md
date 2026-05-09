# Milky Way volumetric disc

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
- `-2` Molecular clouds
- `-1` Galactic disc + grid reference rings
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

**Chart mode** swaps the volumetric raymarch for a single-line **isobar
contour** along the magnitude limit (see `docs/chart-mode.md`
§Isobar contours). The diffuse glow doesn't suit a paper-chart
aesthetic, but a thin ink line tracking "where the integrated MW would
equal the visible magnitude limit" reads as an exact paper-atlas
equivalent of the volumetric band.
**Warp** keeps the layer visible in dark mode — the band reorienting
as the camera flies past the GC is the realism payoff.

**No FPS gate.** Performance optimisation deferred. Toggle via the
panel checkbox or `mw=0` URL.

**Dev tooling.** `debug.panel()` in the browser console attaches the
unified dev panel, which hosts four collapsible sections:
- **Star disc** (`star-tuning.ts`): seven sliders for the super-Gaussian
  profile knobs — visibleThreshold, coreThreshold, discardThreshold,
  distN min/max, lumBias dwarf/hypergiant. See `docs/rendering.md`
  §Star intensity profile for what each one shapes.
- **Milky Way** (`milkyway-tuning.ts`): log-scale slider for brightness
  + linear sliders for glowMagOffset / discDensity / bulgeDensity /
  extinctionStrength + colour pickers for disc + bulge palette + three
  sliders for the reddening RGB multipliers (linear since CCM channels
  exceed 1.0).
- **Perf** (`perf-hud.ts`): FPS / per-section frame timing readouts.
- **Pin** (`pin-debug-hud.ts`): focused-star pin engagement diagnostics.

Call again to detach. The `DebugTools` interface in `debug.ts` is the
registration point if you add more dev tools later.

The same setters are also available individually under
`stellata.milkywayLayer.*`:
- `setBrightness(x)` — global gain in the tone-map exponent
- `setGlowMagOffset(x)` — magnitude calibration (raise → dimmer)
- `setDiscDensity(x)` / `setBulgeDensity(x)` — per-component emission
- `setDiscColor(r,g,b)` / `setBulgeColor(r,g,b)` — pre-extinction palette
- `setExtinctionStrength(x)` — analytical dust τ multiplier
- `setReddeningRGB(r,g,b)` — per-channel τ multiplier (CCM-derived)
