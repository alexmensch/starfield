# Science — sources, formulas, and modelling decisions

This file is the canonical record of every external dataset that goes
into Stellata, the physics that's applied to it at build and render
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
- **Hipparcos CCDM + MultFlag cross-reference**: VizieR
  `I/239/hip_main`, HIP main catalogue. We commit a three-column
  slice (`-out=HIP,CCDM,MultFlag`) as `data/hip_ccdm.tsv`, used as
  the HIP-keyed visual-doubles flag. CCDM links each Hipparcos
  star to the Catalog of the Components of Double and Multiple
  stars (Dommanget & Nys 1994); `MultFlag` is Hipparcos's own
  multiplicity confidence flag. A star is flagged as a visual
  double when both CCDM is non-blank *and* `MultFlag ∈ {C, G, O}`,
  which keeps Hipparcos-confirmed pairs and rejects CCDM-listed
  optical pairs (line-of-sight chance alignments) that Hipparcos
  did not model. Unlike TDSC there is no bright-star saturation
  gap (Sirius, Mizar, Castor, α Cen, Albireo all carry CCDM IDs
  with confirming `MultFlag`).
- **Washington Double Star Catalog (WDS)** + **Sixth Catalog of Orbits
  of Visual Binary Stars (ORB6)**: Mason et al (2001), AJ 122, 3466
  (WDS); Hartkopf, Mason & Worley (2001), AJ 122, 3472 (ORB6).
  Maintained continuously at the U.S. Naval Observatory and Georgia
  State University. Used to recover binary-pair geometry that AT-HYG
  collapses to a single row: visually-resolved separations ρ and
  position angles θ from WDS, full orbital element fits (P, T, e,
  a, i, ω, Ω) from ORB6 for ~4k systems. Raw fixed-width text files
  committed under `data/`, downloaded directly from
  http://www.astro.gsu.edu/wds/:
    - `wds_summ.txt` — main summary, ~157k pair systems with ρ/θ,
      component magnitudes, spectral types, HIP/HD cross-IDs
      (`Webtextfiles/wdsweb_summ2.txt`).
    - `wds_notes.txt` — notes accompanying the catalog
      (`Webtextfiles/wdsnewnotes_main.txt`).
    - `wds_refs.txt` — discoverer codes and references
      (`Webtextfiles/wdsnewref.txt`).
    - `orb6_orbits.txt` — orbital elements (`orb6/orb6orbits.txt`).
  Field offsets are documented upstream in `wdsweb_format.txt` and
  the ORB6 ReadMe; consulted by `scripts/build-binaries.py` but not
  committed. Retrieved 2026-05-11. Public-domain (U.S. Government
  work).
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

> **Molecular cloud sources shelved for v1.0.** Zucker et al. 2020 +
> 2021 cloud distances and 3D bounding boxes drive the molecular-cloud
> ellipsoid layer, which is committed but not rendered in v1.0 while
> the visual treatment is being refined. The build script
> (`scripts/build-clouds.py`) and source files
> (`data/molecular-clouds/`) remain in the repository for the future
> re-enable.

## Multiple-star pipeline

The base AT-HYG catalogue collapses several famous close pairs to a
single row (α Cen A and B share a Hipparcos solution; Sirius B isn't in
the classic-IDs subset at all). `scripts/build-binaries.py` cross-matches
WDS + ORB6 against AT-HYG and emits one row per resolved component to
`data/multiples.tsv`. The pipeline computes each secondary's J2000 sky
offset from the primary under one of three regimes:

1. **Regime 1 — visually resolved.** Apply the WDS *last-epoch* ρ
   (arcsec) and θ (degrees east of north) directly to A's catalog
   position via a tangent-plane projection. Used when no orbital
   solution exists.
2. **Regime 2 — ORB6 orbit.** Solve Kepler's equation at J2000.0 with
   the published elements (P, T₀, e, a, i, ω, Ω), then apply the
   Thiele-Innes transformation to obtain (ρ, θ) — same projection as
   Regime 1 from there. Multi-fit systems are tie-broken by orbit
   grade (lowest numeric grade wins; ties go to the most recent
   reference year).
3. **Regime 3 — spectroscopic / inclination-less ORB6 entries.** When
   ORB6 supplies a but no inclination, the published *a* is `a·sin i`
   and the orbit's orientation on the sky is unconstrained. We use *a*
   as the separation magnitude with a conventional position angle of
   0°. Treat the resulting (x, y, z) as schematic — the secondary's
   on-sky direction is conventional, not measured.

**Optical-pair filter** (rejects line-of-sight chance alignments;
applied in priority order):

1. *WDS Notes flag chars (cols 108-111).* Codes `S`, `U`, `X`, `Y`
   denote optical / non-physical pairs (reject); `T`, `V`, `Z` denote
   physical (keep).
2. *Gaia DR3 astrometry* (file-optional — see procedure below). When
   both components have Gaia DR3 measurements, reject if the parallax
   difference exceeds 3σ (combined error), or if the common-proper-
   motion difference exceeds 5 mas/yr.
3. *Sanity fallback.* Reject only on extreme magnitude outliers with
   no shared spectral hint — a defensive net that fires rarely.

**Gaia DR3 retrieval procedure** (manual, frozen-external pattern; no
live fetch at build time):

1. `scripts/build-binaries.py` writes `data/wds_upload.csv` on every
   run — one row per kept component with `wds_id`, `comp`, `ra_deg`,
   `dec_deg`.
2. Open the Gaia archive (`https://gea.esac.esa.int/archive/`) and
   upload `data/wds_upload.csv` as a user table.
3. Run an ADQL query joining the upload table against
   `gaiadr3.gaia_source` on a 1″ `CONTAINS(POINT, CIRCLE)` predicate,
   pulling `parallax`, `parallax_error`, `pmra`, `pmdec` per
   component.
4. Download the result and commit it to `data/gaia_dr3_binaries.tsv`
   (LFS-tracked). Re-run the build — the filter automatically picks
   it up.

When the file is absent the script continues with only the WDS-Notes
verdict + sanity fallback; the warning line states which path is
active. This keeps the build reproducible without Gaia and offers an
upgrade path the next time Alex refreshes the upload.

**Override layer.** `data/multiples-overrides.tsv` is a small hand-
curated TSV with the same schema as `multiples.tsv` plus a `notes`
column. Loaded last; rows matching an existing `(system_id, comp)`
replace the programmatic row, and rows with a novel key append. Used
for the few edge cases that the WDS+ORB6+Gaia chain can't resolve
cleanly. Empty at the time `build-binaries.py` first lands.

**Tangent-plane consistency.** Both the primary HIP cone-match and
the secondary HIP cone-match use AT-HYG's `(ra, dec)` as the tangent
basis (not the WDS precise coordinate), because AT-HYG stores xyz at
only 0.001 pc precision — for nearby stars the round-trip
`xyz → (ra, dec)` would drift the sky coordinate by tens of arcsec,
overshooting the cone-match radius. The xyz output uses
`A_xyz + sky_offset_to_icrs_xyz(...)` where the offset is computed in
the tangent plane and added directly, so the relative geometry is
preserved at micro-parsec precision even though A's absolute position
is coarse.

## Stellar catalog ingestion

AT-HYG is not a single survey — it's a heterogeneous merge that David
Nash maintains across Tycho-2 (bulk positions and photometry, ~2.5M
stars complete to V≈11), Hipparcos (the bright end), Gaia DR3 (most
distances and a small fraction of positions), and Gliese (nearby stars).
The classic-IDs subset we consume isn't a population from any one of
those — it's whichever rows from the merge carry at least one classical
designation (proper name, Bayer, Flamsteed, HIP, HD, HR, or Gliese).

**Per-row provenance.** Every row carries four `*_src` columns naming
which underlying catalog supplied each piece of data:

- `pos_src` — origin of `ra`/`dec`. ~99.4% Tycho-2 (`T`), <1% HIP / GJ.
- `dist_src` — origin of `dist` and the derived `x0`/`y0`/`z0`. ~97.9%
  Gaia DR3 (`G_R3`), ~1.2% no distance available (`N`), small remainders
  from HIP / Gaia DR2 / Gliese.
- `mag_src` — origin of apparent `mag`. ~62.5% Tycho-2 V_T (`T`),
  ~37.2% Hipparcos (`HIP`), <1% Gliese.
- `pm_src` — origin of proper motion (we ingest the columns but don't
  apply T-axis animation, so `pm_src` is unused).

The two source families have meaningfully different magnitude
distributions: HIP-sourced rows average `mag ≈ 8.4`, while Tycho-sourced
rows average `mag ≈ 10.2` and reach the Tycho-2 completeness limit at
V_T ≈ 11.5. This matters because rendering decisions like the
`naked-eye` (m_lim = 6.5) preset draw essentially only from the HIP
family, while widening to `binoculars` (10.5) or `all` (15) progressively
exposes the Tycho-dominated population.

**What we keep at build time.** `scripts/build-catalog.ts` (`readStars`)
applies three filters and nothing else:

1. Drop rows missing `x0`/`y0`/`z0` (no usable 3D position).
2. Drop rows missing `absmag` (can't size or shade them).
3. Drop rows with `dist > 50,000 pc` (out of any plausible volume of
   interest; safety net for catalog noise).

There is no source-aware filtering. The 48-byte v5 binary record
preserves none of the `*_src` columns either, so the renderer can't
distinguish a Tycho-positioned, Gaia-distanced row from a "pure"
Hipparcos one — every star is shaded by the same physical model
(§Stellar physics, §Stellar perception model).

**Known cross-match completeness artefact.** Filter (1) above is the
load-bearing one: AT-HYG can only emit `x0`/`y0`/`z0` for a Tycho-2
star when that star's Gaia DR3 distance lookup succeeded, and Gaia DR3's
crossmatch success rate is *spatially non-uniform* — Gaia scans the sky
in great-circle strips with overlapping caustics, and DR3's footprint
has visible cutoffs along the ecliptic plane. The result is that
contiguous patches of Tycho-2 stars get distances (and survive into our
binary) while adjacent patches don't. Those boundaries surface in the
rendered scene as axis-aligned rectangular regions of denser, fainter
stars — invisible at `maxAppMag` ≤ ~9 (the Tycho-mag population is
filtered out anyway), increasingly obvious from there to `all` at
mag 15. A denser future ingest from the same AT-HYG pipeline will likely
make the rectangles *more* prominent before they smooth out, since the
Tycho+Gaia-DR3 composite rows are the bulk of the new population.
Treatment (filter by source, wait for Gaia DR4, or live with it) is
deferred until a denser-than-mag-11 ingest makes the call necessary.

Implementation: `scripts/build-catalog.ts` (filters live in `readStars`,
binary schema in the `pack*` helpers); see `docs/build-and-data.md` for
the per-record byte layout and the GCVS / CCDM cross-match passes that
run after the AT-HYG read.

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
both invisible. `starExaggerationK` scales σ up so the threshold disc
lands at a readable 1–2 px. K is per-preset because the population
mix changes with the magnitude limit: defaults are `naked-eye` 12,
`binoculars` 9, `all` 5 — wider catalogs use a smaller K so the dense
star population doesn't wash the field out. Critically, the √Δm shape
is preserved between stars within a preset, so *ratios* against the
volumetric Milky Way bulge (rendered at its real angular size) stay
correct.

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
brightness curve + smoothstep taper) and `src/client/stellata.ts`
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
`src/client/stellata.ts` (CPU-side `renderedSizePx` mirror); see
`docs/rendering.md` §Variable star rendering, and
`docs/build-and-data.md` §GCVS variability cross-match for the
build-time matching rules.

## Solar system

When a host star with planets is focused, Stellata renders the eight
planets, Pluto, faint orbit rings, and the heliopause boundary in the
local frame around the host. Sol is the only populated host in v1; the
machinery is generic so future exoplanet-host work (`stellata-bk5`)
can plug in without changing the renderer.

**Planet positions.** Heliocentric ecliptic positions are computed
from the **JPL Standish 1992 Keplerian-elements approximation**
(https://ssd.jpl.nasa.gov/planets/approx_pos.html), with the cubic
correction terms for Jupiter through Neptune that extend the validity
window to 3000 BC – 3000 AD at sub-arcminute accuracy. Implementation
in `src/client/ephemeris.ts` works directly from the published JPL
Table 2a/2b values — no external library, no network fetch.

VSOP87 was the originally-planned ephemeris model and would offer
sub-arcsecond accuracy ±4000 years from J2000. We dropped it during
implementation: planets render as billboarded discs at a pixel-size
floor, and sub-arcminute precision is invisible at every zoom the
user can reach. The Standish approximation is ~50 lines of code over
an 8-row element table, with no dependency cost. Deep-time follow-up
is filed as `stellata-1gh`.

**Planet physical data.** Equatorial radii from NASA Planetary Fact
Sheets (https://nssdc.gsfc.nasa.gov/planetary/factsheet/). Semi-major
axes and eccentricities from JPL DE440 mean elements at J2000. Pluto
data from New Horizons 2015 reconnaissance (mean radius 1188 km,
tan-pink colour from MVIC imagery). Representative single-colour RGB
values per planet are observation-derived; pixel-accurate texturing,
banding, and atmospheric haloes are deferred to the planet-zoom
affordance epic (`stellata-2f6`).

**Planet geometric albedos** (V-band) from Mallama et al. 2018
(https://doi.org/10.1016/j.icarus.2017.05.018) and the NASA fact
sheets above: Mercury 0.142, Venus 0.689, Earth 0.434, Mars 0.170,
Jupiter 0.538, Saturn 0.499, Uranus 0.488, Neptune 0.442, Pluto 0.49
(HST + New Horizons reconnaissance). Drives the reflected-light
apparent magnitude formula (3re.16).

**Planet phase functions.** Per-planet empirical V-band phase curves
from Mallama, Krobusek, Pavlov 2018, "Comprehensive wide-band
magnitudes and albedos for the planets, with applications to
exo-planets and Planet Nine" (Icarus 282, 2017, 19–33,
https://doi.org/10.1016/j.icarus.2016.09.023). Mercury,
Venus, Mars and Jupiter each carry a polynomial
`ΔV(α°) = c1·α + c2·α² + …` from the paper's Tables A-1.2, A-2.2,
A-4.2, A-5.2; Earth uses a cubic fit through the four discrete
values published in Table A-3.1; Saturn uses a static-β = 16°
approximation of the joint α/ring-tilt formula in Table A-6.2 (the
ring contribution lands as a constant `c0 = −0.55 mag` brightness
boost). The renderer multiplies the flux factor `10^(−ΔV/2.5)` into
the apparent-magnitude formula in place of the Lambertian default
whenever a planet carries coefficients and α is inside the published
validity bound. Mallama 2018 publishes no phase polynomial for
Uranus, Neptune or Pluto — the first two because their max α from
Earth is "negligible" (the paper models latitude/temporal effects
instead), Pluto because the paper doesn't cover it. Those three —
and every exoplanet (`stellata-bk5`) — fall back to the Lambertian
phase function `φ(α) = (sin α + (π − α)·cos α)/π`. See
`src/client/phase-function.ts` for the per-planet coefficients.

**Orbital plane orientation.** Sol's planet system is rendered in its
native ecliptic plane (J2000 obliquity ε = 23.4392911°), so the ring
layout matches what an observer at Sol sees on the sky. For all
*other* host stars (future exoplanets via `stellata-bk5`), ring
planes default to the galactic plane — exoplanet-system orientations
are generally unknown, and aligning to the galactic plane gives the
user a consistent visual cue that a focused star has planets without
implying a measured orientation we don't have. The per-host-plane →
ICRS rotation is composed once at attach and reused by the orbit-ring
and planet-body renderers (`src/client/orbit-rings-layer.ts` for the
focus-only ring layer; `src/client/planet-body-field.ts` for the
global, focus-independent body field).

**Time `t`.** All planet positions are evaluated at a wall-clock `t`
(Unix seconds, double). In v1 `t` is pinned to "now" with no scrubber
UI; the bottom-right time readout displays the live UTC timestamp the
positions correspond to. `t` is independent of the cosmetic `uTime`
clock that drives variable-star pulsation — they don't share a value.

Per-`t` cache granularity is 60 seconds: at billboarded-disc pixel
scale, sub-minute planet motion is invisible (Mercury moves ~3e-5 rad
seen from Earth in 60s ≈ 6″, well below pixel resolution at any
zoom). Future time-scrubber UI (`stellata-nmu`) plugs in by overriding
`Stellata.setT()`.

**Heliopause boundary.** Modelled as an asymmetric ellipsoid centred
on Sol, aligned to the solar apex of motion through the local
interstellar medium. The cited measurements:

- Upwind boundary at **122 AU** — Voyager 1 heliopause crossing,
  2012-08-25.
- Flank inferred at **~115 AU** from Voyager 2 heliopause crossing
  2018-11-05, combined with the apex-aligned ellipsoid model.
- Heliotail at **200 AU** — IBEX / Cassini ENA observations.
- Apex direction: ICRS RA 17h53m, Dec +27.4°, after Frisch &
  Slavin 2013.

The heliopause is **static on human timescales**. Solar-cycle
variations in the upwind distance are at the few-AU level across the
11-year cycle, well below the 122 AU upwind anchor; we don't animate
the boundary.

Construction details (sphere scale, offset, rotation), rendering, and
label anchoring: see `docs/solar-system.md` § Heliopause boundary.

Implementation: `src/client/heliopause.ts` and
`src/client/shaders/heliopause.{vert,frag}.glsl`.

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

Implementation details: see `docs/galactic-overlay.md`.

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
see `docs/milky-way.md` for the calibrated values, the magnitude-
consistency conversion that ties Milky Way brightness to the same
magnitude slider as the discrete star catalog, and the full
coordinate-handling chain.

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
distribution. Voxels stay in use for short per-star sightlines.

Implementation: `src/client/shaders/star.vert.glsl` (per-star) and
`src/client/shaders/milkyway.frag.glsl` (volumetric); see
`docs/rendering.md` §Dust extinction + the shelved particle layer and
`docs/milky-way.md`.

## Binary inference threshold

Binaries are flagged at build time from two sources, both ORing onto
the same `flags` bit so the chart-mode wings glyph surfaces either:

**Geometric pass.** Spatial nearest-neighbour pass at separation
`BINARY_MAX_SEP_PC = 0.005 pc` (≈1030 AU). Rationale: at the
renderer's `minDistance = 0.005 pc` orbit, anything farther than that
subtends >45° from the camera — it wouldn't fit the viewport as a
visual "system". Yields only ~14 pairs from the classic_ids subset —
the brighter primary of most visual doubles has a classical ID, but
the secondary often doesn't, so the geometric pass can only see the
α Cen-style cases where both components survive the cut. Each side
stores the other's row index in `companionIdx`.

**CCDM + MultFlag HIP-keyed cross-match.** Hipparcos's `CCDM`
column links each HIP to the Catalog of the Components of Double
and Multiple stars (Dommanget & Nys 1994). CCDM alone is too
permissive — it tags wide line-of-sight optical pairs Hipparcos
didn't confirm — so the build script gates it with `MultFlag`,
keeping only `C` (component), `G` (resolved-in-field), and `O`
(orbit known) entries. A small curated `KNOWN_VISUAL_DOUBLES` set
in `build-catalog.ts` recovers canonical visual doubles Hipparcos
modelled as single stars (Polaris, ε¹ Lyr, 61 Cyg A/B). This
surfaces Sirius, Mizar, Castor, α Cen, Albireo, γ And, ε Lyr,
70 Oph, Procyon, Algol, etc. that the geometric pass misses. No
`companionIdx` is assigned — the secondary is usually not in the
classic_ids subset, and the renderer's zoom-fit code already
guards on `companion ≥ 0`.

Implementation: `scripts/build-catalog.ts`; see
`docs/build-and-data.md` §Geometric binary inference and
§TDSC double-star cross-match for the per-pass details.

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
- **Moons.** Earth's Moon, the Galilean satellites, Titan, Triton, etc.
  The Standish ephemerides cover only the eight major planets +
  Earth-Moon barycentre stand-in for Earth. Adding satellite
  ephemerides is a separate effort and out of scope at the camera
  framings v1 affords.
- **Asteroids and minor planets.** Ceres, Vesta, the Trojans, NEOs.
  Same reason as moons — separate ephemeris source and not visible
  as discs at any camera distance the app currently exposes.
- **Time-evolving heliopause shape.** Solar-cycle variation in the
  upwind boundary is real (~few AU peak-to-peak) but well below the
  layer's coarse 122-AU anchor; we treat the shell as static.
- **Planet textures, banding, atmospheric haloes, ring systems,
  axial-tilt cues, day-night phase shading.** All deferred to the
  planet-as-object zoom-in epic (`stellata-2f6`) — at the user-
  reachable camera distances every planet floors at the disc-pixel
  minimum, so detail rendering would be invisible. See the
  `defer-detail-until-zoom-affordance` rule in CLAUDE.md.
