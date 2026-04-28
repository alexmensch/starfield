# Science — sources, formulas, and modelling decisions

This file is the canonical record of every external dataset that goes
into Starfield, the physics that's applied to it at build and render
time, and the deliberate simplifications made along the way. It serves
two audiences:

- **Claude Code sessions** — when adding or changing anything science-driven,
  read this first to understand the sources, the model in use, and what
  has been explicitly ruled out.
- **Human readers** — a self-contained reference describing what's
  scientifically grounded in the visualisation, and where the simplifications
  live.

Implementation details live in the docs under `docs/`; this file points
into them where relevant.

## Data sources

- **AT-HYG v3.3** (stellar catalogue): https://codeberg.org/astronexus/athyg
  — maintained by David Nash. The classic-IDs subset at
  `data/subsets/athyg_33_classic_ids.csv` is what we consume (every star
  carries at least one classical designation: IAU proper name, Bayer,
  Flamsteed, HIP, HD, HR, or Gliese). Licence CC-BY-SA-4.0.
- **GCVS 5.1** (variable-star catalogue + cross-identification):
  http://www.sai.msu.su/gcvs/gcvs/ — Samus et al, Sternberg Astronomical
  Institute. `gcvs5.txt` (main file) + `crossid.txt` (Hip/HD/Tyc/etc. →
  GCVS name mappings). Free for research/educational use with
  attribution.
- **Stellarium modern sky culture** (constellation stick figures):
  https://github.com/Stellarium/stellarium/tree/master/skycultures/modern
  — MIT-licensed JSON, HIP-indexed polylines. Committed as
  `data/stellarium-modern-skyculture.json`; essentially never changes.
- **Edenhofer 2023 3D dust map** (interstellar extinction + ISM density):
  https://doi.org/10.5281/zenodo.8187943 — Gordian Edenhofer & Greg Green.
  Downloaded via the `dustmaps` Python package and resampled by
  `scripts/build-dust.py` onto a 512³ Cartesian voxel grid in ICRS pc.
  Produces `data/dust/chunk_*.bin` (64 chunks, 128 MiB total, LFS) plus
  `data/dust/particles.bin` (50K importance-sampled dust points, LFS).
  Density in E_ZGR per parsec; A_V/E_ZGR ≈ 2.742 at V band.
- **Zucker et al. 2020** (cloud distance compendium):
  https://doi.org/10.1051/0004-6361/201936145 — VizieR `J/A+A/633/A51`,
  table A1, fetched via `vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=...`
  and committed as `data/molecular-clouds/zucker2020-tablea1.tsv`. 326
  sightlines through ~96 unique named SF clouds (Aquila Rift, Cepheus,
  IC 1396, etc.) with 5%-precision distances. CC-BY 4.0.
- **Zucker et al. 2021** (3D structure of local clouds):
  https://doi.org/10.3847/1538-4357/ac1f96 — Harvard Dataverse, three
  tables (DOIs `10.7910/DVN/CAVMAQ`, `QKYR3G`, `EIPHPR`). Table 1 (12
  famous local SF clouds) gives axis-aligned 3D bounding boxes in
  galactic Cartesian heliocentric pc — these become the ellipsoid axes
  for Taurus / Ophiuchus / Orion A/B/λ / etc. Tables 2, 3 (radial-profile
  fits + masses) committed for future use; not consumed today. CC-BY 4.0.

The Zucker tables are processed by `scripts/build-clouds.py` into
`public/clouds.json` (~30 KB). Z2021 is authoritative for the 12 clouds
it covers; Z2020 fills the long tail as spheres with radius estimated
from per-cloud sightline spread (or 5 pc default for singletons).

## Stellar physics

**Physical radius.** Each star's `physicalRadius` (in solar radii) is
computed at build time via Stefan–Boltzmann, given the absolute
magnitude and parsed spectral class:

```
T       = interp(T_TABLE[classIdx], subclass)
BC      = interp(BC_TABLE[classIdx], subclass)
Mbol    = absmag + BC
L/L☉    = 10^((4.74 − Mbol) / 2.5)
R/R☉    = sqrt(L/L☉) × (T_sun/T)²
```

T and BC tables are main-sequence values — cooler for giants/supergiants
in reality — but the Mbol side of the equation absorbs the
luminosity-class difference, so the end result lands close to published
radii (Sol≈1.03, Sirius≈1.81, Vega≈2.68, Rigel≈75, Betelgeuse≈700, all
within ~10% of canonical values). Clamped to `[0.08, 2500]` so
pathological catalog rows don't produce absurd sizes. White dwarfs are
special-cased to 0.013 R☉ (typical WD radius; absmag doesn't translate
reliably for them).

Implementation: `scripts/build-catalog.ts`, see
`docs/build-and-data.md` §Physical radius and spectral parsing for the
spectral-string parser and the surrounding pipeline.

## Stellar perception model

Distant stars (the brightness-driven `appSize` term) are rendered with
a Gaussian-PSF detection-threshold model rather than a literal angular
mapping. A real star is geometrically a point; what an observer
perceives as the star's "disc" is its PSF on the retina out to where
the intensity drops below the detection threshold. For a Gaussian PSF
of width σ this gives:

```
r_perceived(Δm) = σ × √(2 ln(10) / 2.5 × Δm) ≈ σ × √(1.84 × Δm)
```

where Δm = m_lim − m is the magnitudes by which a star sits above the
detection threshold.

**σ value.** We use σ = 30″ for the unaided eye (set by ocular
aberrations + diffraction at a 7 mm dark-adapted pupil). No atmospheric
seeing, no spike-rendering — the camera is in space and we model a
clean PSF.

**Magnitude limits per preset.** `naked-eye` = 6.5 (Bortle-1 dark sky);
`binoculars` = 10.5 (typical 7×50 dark sky, derived from
m_lim_eye + 5·log₁₀(50/7) ≈ +4.3 mag aperture gain); `all` = 15
(matches the catalog/UI slider ceiling, no physical motivation).

**Exaggeration K.** Literal physics at 50° vertical FOV / 1080 px
puts the threshold disc at ~0.25 px and Sirius (Δm = 8) at ~1 px —
both invisible. `starExaggerationK` (default 16) scales σ up so the
threshold disc lands at a readable 1–2 px. Critically, the √Δm shape
is preserved between stars, so *ratios* against the volumetric Milky
Way bulge (rendered at its real angular size) stay correct.

**Soft taper.** Real stars near the detection threshold fade across
~0.5 mag rather than popping at the limit. The shader extends
visibility to `m_lim + 0.5` and fades glow intensity via a smoothstep
across that band; the disc pass keeps the hard limit since resolved
discs at threshold would render as a sub-pixel speck.

**Viewport calibration.** Sizes are stored in arcsec internally and
converted to pixels per-frame via
`arcsec_per_px = (FOV × 3600) / max(viewport_w, viewport_h)`. Using
the larger viewport dimension as the reference gives consistent
absolute pixel sizes across portrait/landscape orientations, at the
cost of strict angular fidelity in the secondary axis. Three.js's
`camera.fov` is the *vertical* FOV; horizontal arcsec/px would be
identical only for square viewports.

Implementation: `src/client/shaders/star.{vert,frag}.glsl` (`sqrt`
brightness curve + smoothstep taper) and `src/client/starfield.ts`
(`MAG_PRESETS`, `applyMagnitudePreset`, `computePresetPxSizes`).
Live tuning via `debug.panel()` in the browser console.

## Variable-star modelling

GCVS provides a period and a magnitude amplitude per matched star.
The shader applies a sinusoidal magnitude modulation plus a matching
radius factor to the physical-size term:

- `magMod = 0.5 × ampEff × sin(2π × t / period)` adjusts `appMag`
  (affects point-glow size for distant stars).
- `radiusFactor = 10^(-magMod / 5)` applies to `physSize` (affects
  resolved-disc radius for close stars). This is Stefan–Boltzmann-derived:
  `R ∝ √L` at constant T, which is the defensible single-model assumption
  even though real variables also swing temperature.

GCVS rows without a parseable period, or with zero amplitude, are
skipped at build time — that excludes constant stars, supernovae, and
irregular variables. Typical match rate: ~3.7k of 313k catalog stars.

Implementation: `src/client/shaders/star.vert.glsl` and
`src/client/starfield.ts` (CPU-side `renderedSizePx` mirror); see
`docs/rendering.md` §Variable star rendering, and
`docs/build-and-data.md` §GCVS variability cross-match for the
build-time matching rules.

## Galactic coordinate system

The shared module `src/client/galactic-coords.ts` exports two constants
used wherever the code needs to anchor in galactic geometry:

- `GAL_TO_ICRS` — a `Matrix4` rotation built from the J2000 IAU
  galactic-pole and galactic-centre angles, with explicit
  re-orthogonalisation to suppress float drift.
- `GALACTIC_CENTRE_PC` — a `Vector3` placing Sgr A* at R₀ = 8.122 kpc
  along the galactic +X axis (then rotated into ICRS by `GAL_TO_ICRS`).

These are reused by:

- The galactic disc-outline reference layer.
- The galactic coordinate sphere (b/l grid).
- The Sol/GC SVG arrow overlay.
- The volumetric Milky Way disc + bulge layer.
- The molecular cloud `quat` orientation for Z2021 ellipsoids.

Implementation details: see `docs/rendering.md` §Galactic reference
system.

## Milky Way density profiles

The volumetric Milky Way layer raymarches through two proxy meshes —
a disc and a bulge — and accumulates emission along the camera→fragment
ray. The density at each step is:

- **Disc**: `density0 × exp(-(R-R₀)/3000pc) × exp(-|z|/300pc)` — single
  double-exponential thin-disc-like profile in galactocentric cylindrical
  coordinates. The originally-planned Jurić thin/thick/halo decomposition
  was simplified out during iteration; the smooth single component reads
  convincingly enough that the extra components weren't worth the
  calibration cost.
- **Bulge**: `density0 × exp(-r'/1000pc)` where
  `r' = sqrt(R² + (z/q)²)` is the oblate-spheroid radius with q = 0.6.
  Simple exponential rather than McMillan's power-law-times-Gaussian —
  the latter produced too-tight a "ball" that read as point-source-like
  in iteration.

Each component multiplies a population colour pre-integration so the
band's hue varies by line of sight. Defaults are visually calibrated;
see `docs/rendering.md` §Milky Way volumetric disc (Phase 5) for the
calibrated values, the magnitude-consistency conversion that ties
Milky Way brightness to the same magnitude slider as the discrete star
catalog, and the full coordinate-handling chain.

## Interstellar dust extinction

Two distinct dust paths exist in the renderer:

**Per-star extinction.** `star.vert.glsl` raymarches the Edenhofer 2023
voxel grid camera→star and applies:

- `A_V` to `appMag` (dimming).
- `E(B−V) = A_V / 3.1` to `iCi` (reddening of the colour index).

Default strength = 1 (physical realism). Source units are E_ZGR per
parsec; the conversion `A_V / E_ZGR ≈ 2.742` at V band is baked in.

**Volumetric Milky Way dust.** Analytical-only, no voxel sampling.
Profile is `norm × exp(-(R-R₀)/3500pc) × exp(-|z|/125pc)` —
Drimmel & Spergel-style thin-disc dust. Per step, opacity converts to
per-channel optical depth via CCM-derived reddening multipliers
`(0.76, 1.0, 1.35)` — red transmits most, blue extincts away — applied
with Beer-Lambert running attenuation including a half-step
self-shielding term. Default global strength = 0.45.

The Edenhofer voxel grid is **deliberately not used** for the Milky Way
band — voxel structure (~5 pc native) aliases into visible streaks
along long camera→fragment rays (8–15 kpc) regardless of step
distribution. Voxels stay in use for short per-star sightlines;
molecular cloud ellipsoids carry the discrete near-cloud detail in
front of the smooth analytical band.

Implementation: `src/client/shaders/star.vert.glsl` (per-star) and
`src/client/shaders/milkyway.frag.glsl` (volumetric); see
`docs/rendering.md` §Dust extinction + the shelved particle layer and
§Milky Way volumetric disc (Phase 5).

## Binary inference threshold

Binaries are inferred geometrically at build time using a separation
threshold of `BINARY_MAX_SEP_PC = 0.005 pc` (≈1030 AU). Rationale: at
the renderer's `minDistance = 0.005 pc` orbit, anything farther than
that separation subtends >45° from the camera — it wouldn't fit the
viewport as a visual "system", which is what the render layer cares
about. Wider physically-bound pairs exist in the catalog but won't
render usefully.

Yields ~14 pairs out of the classic_ids subset — almost all famous
named visual binaries (α Cen A/B, Alula Australis, Struve 2398, etc.).
The brighter member of each pair is flagged as primary.

Implementation: `scripts/build-catalog.ts`; see
`docs/build-and-data.md` §Geometric binary inference for the spatial-
hash details.

## Constellation stick figures

Classical asterism lines come from Stellarium's modern sky culture
(MIT-licensed, HIP-indexed). Each Stellarium polyline references stars
by HIP number, which is resolved against AT-HYG's `hip` column at build
time. Any unresolved HIP is a hard build error unless explicitly listed
(with rationale) in `KNOWN_MISSING_HIPS` — currently α Phe (HIP 5165)
and μ Sgr (HIP 89341), both stars Stellarium references that have empty
position columns in the AT-HYG CSV.

Implementation: `scripts/build-catalog.ts`; see
`docs/build-and-data.md` §Stick figures from Stellarium for the
pipeline + missing-HIP policy.

## Modelling decisions deliberately not made

These are the science-flavoured items from the project-wide scope list
in `CLAUDE.md`. Restated here so the rationale lives alongside the
science it relates to.

- **IAU constellation boundary datasets.** Only the asterism lines are
  included — boundaries would be a separate Stellarium dataset and
  carry no visual benefit at the camera scales the app operates in.
- **Time-series proper motion.** Positions are snapshot-only, with no
  T-axis animation. AT-HYG carries proper-motion columns but we don't
  use them.
- **Spiral-arm overdensities** in the Milky Way volumetric background.
  The Reid et al. masers offer a maser-anchored spiral model that could
  ride atop the smooth disc profile, but the smooth band reads
  convincingly enough that re-introducing higher spatial frequency
  (and the aliasing risk it carries through 32-step raymarching) isn't
  worth the complexity.
- **Irregular / supernova variables.** GCVS entries without a period are
  skipped — can't animate without one.
- **Temperature-swing component of variable-star brightness change.**
  We use `R ∝ √L` (constant-T assumption); real pulsating variables
  split the brightness change between R and T swings. Modelling T
  changes per variable type is more complexity than the visualisation
  warrants.
