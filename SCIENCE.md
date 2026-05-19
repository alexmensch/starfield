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

## Scope principles

Three overarching principles govern how the model is built and which
detail is in scope at which range. Every individual modelling decision
below should be consistent with these.

### Data fidelity — "best possible model based on current observational data and knowledge"

Stellata is a physical-accuracy project, not a stylised visualisation.
The catalog grows in well-defined releases (Gaia DR4 expected late 2026,
periodic AT-HYG refreshes), not continuously, so one-time data-
processing investment pays off forever. There is no manual review path
— 300k+ stars cannot be hand-checked, so the data-processing
infrastructure itself has to be correct.

When scoping data-processing / cross-match / catalog-ingest work:

1. **Default to the hard upfront generalised solution, not a famous-
   star carve-out + heuristic fallback.** The "tier just beyond the
   famous ones" is always the trap — solve the class of problem, not
   the visible exemplars. If "the system would need 20 hand-curated
   overrides" the system is wrong, not the data.
2. **Prefer official source-ID cross-walks** (HIP numbers, Gaia source
   IDs, NSS catalogs, SIMBAD identifiers) over position-based matching
   when the cross-walk exists. Position-based matching is the fallback,
   not the primary strategy.
3. **Hand-curated overrides** (e.g. `data/local-group/overrides.tsv`)
   are acceptable only for truly singular edge cases where no canonical
   source resolves them, or for objects a catalog excludes by
   construction (M31, M33 in LVDB's `dwarf_all`) — not as a substitute
   for systematic data engineering.
4. **Ship-less-accurate-now vs ship-more-accurate-later: prefer the
   latter for catalog/data work.** UX and rendering polish can iterate;
   the catalog underpinning the model can't be re-shipped without
   re-rendering everything.
5. **All matching/processing must keep working when external catalogs
   upgrade.** When refactoring a cross-match, ask: does this depend on
   hand-tuned values that won't survive a DR4 swap? If yes, the
   refactor isn't done.
6. **Validation matters at scale.** Spot-checking 5 famous stars
   doesn't tell you what's happening at star #150,000. When shipping a
   new processing stage, build a parallel automated check (compare
   against SIMBAD distances for a random sample, etc.) in the same
   change.

### Detail gradient — highest-density measurable info near Earth, simpler model further out

Per-object near, statistical far. When scoping a layer beyond the
AT-HYG catalog reach, prefer statistical / aggregate sources (HiPS-
derived counts, binned populations) over hand-extending per-object
data. The closer-to-Sol layer queue lives in the prioritisation
framework (`bd memories stellata-prioritization-framework`); the
mapping of catalog sources to the regime where they earn their keep is
the CDS / VizieR ecosystem orientation captured in `bd show
stellata-36y`.

### Defer detail until zoom affordance

Defer per-object detail rendering (textures, atmospheric haloes,
banding, surface shading, day-night phase, ring systems, exoplanet
bodies) until the user can actually navigate close enough to see it.

Stellata bodies are billboarded discs sized via θ = 2·atan(R/d). At
any host-relative camera distance more than a few thousand body-radii,
every object floor-clamps to the pixel-size minimum and per-detail
differences become invisible. Coding the detail before the user can
perceive it is wasted effort and wasted bundle.

When scoping a new visual layer, ask first: at what camera-to-object
distance is this detail perceptible? If the answer is closer than the
user can navigate to under existing focus + minDistance affordances,
file the detail under the relevant zoom-in epic (currently
`stellata-2f6` for planet detail, `stellata-bk5.3` for exoplanet
bodies) and ship the layer without it. Don't reach for shader
complexity to compensate for a perceptual constraint that's better
fixed by a camera affordance.

Same logic generalises beyond planets — any catalog object rendered as
a billboarded disc has the same regime: detail beyond a single
representative colour earns its keep only when the user can fly close
enough to see it.

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

> **Molecular cloud sources currently shelved.** Zucker et al. 2020 +
> 2021 cloud distances and 3D bounding boxes drive the molecular-cloud
> ellipsoid layer, which is committed but not currently rendered while
> the visual treatment is being refined. The build script
> (`scripts/build-clouds.py`) and source files
> (`data/molecular-clouds/`) remain in the repository for the future
> re-enable.

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

There is no source-aware filtering. The 44-byte v4 binary record
preserves none of the `*_src` columns either, so the renderer can't
distinguish a Tycho-positioned, Gaia-distanced row from a "pure"
Hipparcos one — every star is shaded by the same physical model
(§Stellar physics, §Stellar perception model).

**Bailer-Jones DR3 distance override.** AT-HYG's `dist` for the
~98% G_R3 majority is Gaia DR3's naive `1 / π` parallax inversion —
unbiased only when parallax S/N is high. For low-S/N parallaxes (the
distant luminous stars that dominate the visual scene's outer
volume) the inverse-parallax estimator catastrophically fails:
its sampling distribution has a long tail to large distances, and a
handful of supergiants end up at 9–14 kpc instead of their true
2–5 kpc. Bailer-Jones et al. 2021 (AJ 161, 147 — CDS I/352)
publishes Bayesian distance posteriors for every Gaia DR3 source
that combine the parallax likelihood with a Galactic-density prior;
the photogeometric variant additionally combines the prior with G
and BP–RP photometry. At high S/N the posterior collapses onto the
likelihood (well-measured stars don't move); at low S/N it collapses
onto the prior (catastrophic outliers get pulled back to plausible
disc distances). This is the principled fix and we apply it
uniformly: any AT-HYG row carrying a Gaia DR3 source_id swaps its
`dist`, `x0`, `y0`, `z0`, and `absmag` for the Bailer-Jones-derived
values (photogeometric `r_med_photogeo` preferred, geometric
`r_med_geo` as fallback when photogeo is absent). Recomputing
`absmag` matters as much as the positional update — without it,
stars get *placed* at the new distance but *lit* for the old one,
breaking the disc/glow size chain. The override fires for 99.5% of
Gaia-DR3-bearing AT-HYG rows; the residual 0.5% are source_ids
absent from the Bailer-Jones publication (mostly the small G_R2 /
HIP / GJ tail) and keep their AT-HYG values. The override also
rescues ~15 stars previously dropped at filter (3): catastrophic
parallax inversions whose Bayesian distance is < 50 kpc.

Data file: `data/bailer-jones-dr3.tsv` (~310k rows, refreshed by
`scripts/refresh-bailer-jones.py`).

**LMC kinematic distance refinement.** Bailer-Jones's Galactic-density
prior has no LMC — so for AT-HYG's ~60 LMC supergiants (HDE 268xxx
range), the posterior peaks somewhere intermediate (5–20 kpc) instead
of the LMC's true ~50 kpc. Without a second layer this regresses today's
behaviour: a "line of stars between MW and LMC in the intergalactic
void". After the B-J override fires we run a population-specific second
pass: any row inside a 15° cone of the LMC photometric centre
(RA 78.76°, Dec −69.19°) whose proper motion lies within ±0.5 mas/yr of
the LMC bulk centre-of-mass PM (van der Marel & Kallivayalil 2014:
+1.85 mas/yr in RA, +0.20 mas/yr in Dec) has its `dist` snapped to the
LMC's eclipsing-binary distance (49.594 kpc, Pietrzyński et al. 2019,
Nature 567, 200; CDS J/other/Natur/567.200), with `x0`/`y0`/`z0`/`absmag`
recomputed from the new distance. ~54 rows are flagged at LMC depth
each build — close to the ~60 estimated from the AT-HYG/Gaia source
data. SMC, Sgr dSph, and other Magellanic-system populations are too
faint for AT-HYG's brightness cut today; the same approach will extend
when DR4 lands or AT-HYG goes deeper.

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

## Star colour calibration

Per-star chromaticity is sampled from a 256-entry blackbody → sRGB
lookup table indexed by B-V. The table is precomputed at build time
(`scripts/blackbody-lut.ts` → `src/client/shaders/blackbody-lut.ts`)
and bound to the star shader as a 256×1 `DataTexture`. Each entry
folds three physically-grounded steps:

1. **B-V → effective temperature** via the Ballesteros (2012) empirical
   relation,
   `T_eff = 4600 × (1/(0.92(B-V) + 1.7) + 1/(0.92(B-V) + 0.62))`,
   calibrated against stars with both indices measured independently.
   Accurate across A–K main-sequence, with reasonable extrapolation
   into M and hot B.
2. **Planck × CIE 1931** — the Planck spectrum at T_eff is integrated
   against the CIE 1931 2° standard-observer colour-matching functions,
   using the analytical multi-Gaussian fits in Wyman, Sloan & Shirley
   (2013). The fits reproduce the tabulated CMFs to ~1%, well below
   the chromaticity threshold relevant for star rendering.
3. **XYZ → sRGB D65** — the standard linear sRGB transform (IEC
   61966-2-1), peak-normalised per entry to preserve chroma, then
   gamma-encoded via the sRGB piecewise transfer function. Out-of-gamut
   negative components (hot O-stars whose Planckian chromaticity falls
   outside sRGB) clip to zero before normalisation.

Dust reddening composes upstream of the LUT: the shader integrates A_V
along the camera-to-star sightline via the Edenhofer 3D dust map and
shifts the B-V used for LUT sampling by `E(B-V) = A_V / 3.1`. The LUT
input is therefore the **observed** (dust-reddened) B-V from the
camera's vantage, not the intrinsic value, so colour drifts physically
as the camera traverses dust between observer and star (the Mu Cephei
"Garnet Star ↔ Peach Star" case study in
`research/star-spectral-rendition/RECOMMENDATION.md`).

The LUT spans B-V ∈ [-0.4, +2.0] in 256 entries; values are clamped
to the endpoints before sampling. Hotter / cooler tails saturate at
the endpoint colour, which is fine for the catalog's working range
(intrinsic OB stars bottom out around -0.3; the reddest M-supergiants
reach B-V ≈ +2.0–2.5 only after substantial line-of-sight extinction).

Sources:

- Ballesteros, F.J. (2012). New insights into black bodies.
  *Europhysics Letters* 97, 34008.
  https://doi.org/10.1209/0295-5075/97/34008
- Wyman, C., Sloan, P.-P., Shirley, P. (2013). Simple analytic
  approximations to the CIE XYZ color matching functions. *Journal of
  Computer Graphics Techniques* 2(2), 1–11.
  https://doi.org/10.5281/zenodo.10049479
- IEC 61966-2-1:1999. Multimedia systems and equipment — Colour
  measurement and management — Part 2-1: Colour management — Default
  RGB colour space — sRGB.
- Cross-check reference: Mitchell Charity's tabulated blackbody RGBs
  at http://www.vendian.org/mncharity/dir3/blackbody/ (agreement
  ΔE ≤ 5 across 3000–30000 K).

Implementation: `scripts/blackbody-lut.ts` (LUT generator + pure
helpers), `src/client/shaders/blackbody-lut.ts` (generated artifact),
`src/client/shaders/star.vert.glsl` (`ciToColor` sampler), and
`src/client/stellata.ts::makeColorLutTexture`.

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
`src/client/camera/star-physics.ts` (CPU-side `renderedSizePx`
mirror); see `docs/rendering.md` §Variable star rendering, and
`docs/build-and-data.md` §GCVS variability cross-match for the
build-time matching rules.

## Solar system

When a host star with planets is focused, Stellata renders the eight
planets, Pluto, faint orbit rings, and the heliopause boundary in the
local frame around the host. Sol is the only populated host so far; the
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
(Unix seconds, double). `t` is currently pinned to "now" with no scrubber
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

## Local Group wireframes

The Local Group wireframe layer renders LineLoop outlines for confirmed-
galaxy members out to the canonical 2 Mpc Local Group boundary —
M31 + M33 + the Andromeda subgroup, plus the outer dIrrs (NGC 6822,
IC 10, IC 1613, Leo A, WLM, Sextans A/B, …). Geometry is representational
(stylised LineLoop ellipsoids and discs), but every position, distance,
and structural parameter comes from peer-reviewed catalogues:

**Primary catalogue**: Pace et al. 2024, *Local Volume Database*, Open
Journal of Astrophysics, arXiv:2411.07424 (CC0). A frozen snapshot of
the `dwarf_all` table lives at `data/local-group/lvdb-snapshot.csv` —
909 rows covering the full Local Volume. The build pipeline
(`scripts/build-local-group.ts`) filters to `confirmed_real = 1`,
`confirmed_galaxy = 1`, and heliocentric distance ≤ 2 Mpc; ~121
objects pass the filter.

LVDB provides position (ra, dec, distance), projected half-light
radius (`rhalf_physical`), ellipticity, and position angle for each
dwarf. The build script projects these into a sky-plane oblate
ellipsoid for the default rendering path:

- `a_pc = rhalf_physical` (semi-major axis in the sky plane)
- `b_pc = a_pc · (1 − ellipticity)` (sky-plane minor axis)
- `c_pc = b_pc` (line-of-sight extent — axially symmetric around the
  projected major axis; line-of-sight 3D extent is generally not
  observationally constrained)
- Orientation: long axis at the catalogued position angle east of
  north; minor axes complete a right-handed basis with the line of
  sight.

**Hand-curated overrides** in `data/local-group/overrides.tsv` replace
structural detail for the singular cases LVDB's summary row can't
capture, and add the two major spirals LVDB's `dwarf_all` table omits:

- **LMC (49.59 kpc)**: inclined disc at i = 32°, line of nodes PA =
  135° (van der Marel & Kallivayalil 2014, *ApJ* 781, 121,
  DOI 10.1088/0004-637X/781/2/121; distance Pietrzyński et al. 2019,
  *Nature* 567, 200, DOI 10.1038/s41586-019-0999-4). Scale length 4.5
  kpc, scale height 1 kpc.
- **SMC (62.81 kpc)**: triaxial 1 : 1.33 : 1.61 with the longest axis
  along line of sight (Subramanian & Subramaniam 2012, *ApJ* 744, 128,
  DOI 10.1088/0004-637X/744/2/128; distance Graczyk et al. 2020,
  *ApJ* 904, 13, DOI 10.3847/1538-4357/abbb2b). Resulting semi-axes
  3.73 / 4.96 / 6.0 kpc.
- **Sagittarius dSph (26.3 kpc)**: 3D axis allocation — LVDB's
  projected ellipticity captures the sky-plane shape but not the
  line-of-sight extent (Ibata et al. 1995, *AJ* 110, 632,
  DOI 10.1086/192237).
- **M 32 (~773 kpc)**: optical-extent ellipsoid 1.6 / 1.2 / 1.2 kpc
  at PA 159°. LVDB's half-light radius of 105 pc renders sub-pixel
  at LG distances; the override uses the broader optical/D₂₅ extent
  cited in McConnachie 2012, *AJ* 144, 4
  (DOI 10.1088/0004-6256/144/1/4).
- **NGC 205 / M 110 (~835 kpc)**: 2.7 / 1.5 / 1.5 kpc at PA 170° from
  the same McConnachie 2012 review — again the optical extent rather
  than the small half-light radius.
- **M31 / Andromeda (776 kpc)**: inclined disc at i = 77°, line of
  nodes PA = 37°, 15 kpc disc radius × 500 pc thickness — the
  structural parameters from the PAndAS survey (McConnachie et al.
  2018, *ApJ* 868, 55, DOI 10.3847/1538-4357/aae8e7). Standalone row
  (not in LVDB's `dwarf_all` table; the override carries RA, Dec,
  distance directly).
- **M33 / Triangulum (840 kpc)**: inclined disc at i = 54°, line of
  nodes PA = 22°, 8.5 kpc disc radius × 400 pc thickness — distance
  from the Cepheid measurement of Bonanos et al. 2006, *ApJ* 652, 313
  (DOI 10.1086/508140). Standalone row.

Per the build's data-freshness policy (`docs/build-and-data.md`
§ Frozen external data), refreshing the LVDB snapshot is an explicit
manual step (curl + `npm run build:local-group --force`) — `npm run
build` never touches the network.

Per the data-fidelity principle above (§ Scope principles), hand-curated overrides are
the exception, reserved for objects with well-studied departures that
no canonical structural row resolves — or, in the case of M31 / M33,
for the major spirals that the LVDB `dwarf_all` table excludes by
construction. Other Local Volume dwarfs render from their LVDB row
directly. As future LVDB snapshots land, the default-path objects
update automatically; only the overrides need re-review against any
structural-paper updates.

Implementation: `src/client/local-group.ts`,
`src/client/local-group-loader.ts`, `scripts/build-local-group.ts`,
`scripts/build-local-group-pure.ts`. Rendering walkthrough in
`docs/local-group.md`.

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
- **Time-series proper motion.** Positions are a J2000.0 snapshot,
  no T-axis animation. AT-HYG carries `pm_ra`/`pm_dec` but the
  preprocessor never reads them. ~26 years past J2000.0, the highest-PM
  neighbours (Barnard's, Kapteyn's, Groombridge 1830, Lacaille 9352,
  61 Cyg A) are visibly off by 2–5 arcmin from their current sky
  positions; the rest of the catalog is well below an arcminute. Per-
  layer epoch table and the staleness audit live in
  `docs/build-and-data.md` § Reference epoch and proper motion.
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
  framings the app currently affords.
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
  minimum, so detail rendering would be invisible. See § Scope
  principles — Defer detail until zoom affordance above.
