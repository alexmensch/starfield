# stellata-zsr.1 — Star-colour calibration: findings and recommendation

**Status**: research deliverable for `stellata-zsr.1`. Pinned 2026-05-17.

Long-form companion to the artefacts in this folder (`coverage.txt`,
`sample_comparison.txt`, `apsis_coverage.txt`, `sample_swatches.png`,
`hr_panels.png`, `scene_swatches.png`).

## TL;DR

1. The current shader's `ciToColor` piecewise gradient is meaningfully
   wrong at the cool/red end (K/M giants and supergiants) — ΔE > 50
   vs physical blackbody, visually oversaturated orange-red. Fixing
   this is **a single shader-and-LUT swap** that ships independently
   and visibly improves how Antares / Betelgeuse / Aldebaran read.
2. Ingesting Gaia DR3 Apsis (`teff_gspphot` / `logg_gspphot`) takes
   joint (Teff, logg) coverage from **29.3% to 85.1% of the catalogue
   (2.87× improvement)**. The colour-fidelity gain over a B-V-driven
   blackbody is modest (B-V already proxies most of the giant/MS
   discrimination via chromaticity), but Apsis pays off across many
   adjacent surfaces: physical radius, dust cross-check, future
   metallicity-aware rendering. Naturally slots into `stellata-dch`'s
   Phase 1 ingest manifest.
3. Implementation falls into two independent tiers; Tier 1 is the
   user-visible win and ships standalone, Tier 2 is a `dch`-coupled
   ingest with broader payoff.

## Evidence summary

### Coverage stats (`coverage.txt`)

| Bucket | Count | % of 317,175 |
|---|---|---|
| Total records | 317,175 | 100.0% |
| `ci` empty in CSV | 13,074 | 4.1% |
| `spect` parseable | 209,817 | 66.1% |
| **`spect` parseable AND `lumClass` known** | **92,995** | **29.3%** |
| `ci` empty AND `spect` present | 6,622 | 2.1% |
| Both empty | 6,452 | 2.0% |

The 29.3% "lumClass known" number is the critical gating fact for
non-Apsis blackbody approaches: less than a third of the catalogue can
be honestly placed on the giant-vs-MS axis without external data.

### Per-star three-way comparison (`sample_comparison.txt`)

Largest ΔE between current `ciToColor` and physical blackbody:

| Star | Spect | B-V | Current (A) | Blackbody @ Teff(spect) (B) | ΔE_AB |
|---|---|---|---|---|---|
| Antares | M1.5 Iab | 1.83 | (255,156,110) | (255,205,151) | 64.1 |
| Betelgeuse | M2 Iab | 1.86 | (255,153,106) | (255,202,144) | 61.4 |
| Aldebaran | K5 III | 1.54 | (255,182,145) | (255,220,184) | 54.5 |
| Sirius B | DA2 | 0.00 | (196,216,248) | (166,189,255) | 40.5 |
| Proxima | M5.5 V | 1.81 | (255,158,113) | (255,190,120) | 33.3 |
| Arcturus | K1.5 III | 1.23 | (255,210,182) | (255,231,208) | 32.9 |
| Mintaka | O9.5 II | -0.17 | (183,209,251) | (161,186,255) | 32.2 |
| Procyon | F5 IV-V | 0.43 | (228,234,241) | (252,247,255) | 31.1 |

The cool/red end is where the current shader fails hardest. Reds get
oversaturated; warm yellows get pushed toward apricot. The scene-style
swatch (`scene_swatches.png`) shows this is **visible** under
additive-glow-on-black rendering, not just a Lab-space number.

### HR-panel observations (`hr_panels.png`)

- Panel A (`ciToColor` current): continuous, but mis-tuned at the
  cool end (over-saturated reds). Hot end (sub-zero B-V) is fine.
- Panel B (blackbody at `Teff(spect)` via current T_TABLE):
  **discretised into 80 colour clusters** because T_TABLE only
  resolves class + subclass, not luminosity class. Same letter + digit
  on the giant branch and main sequence get the same colour. This is
  the visual proof that a naive "swap to T_TABLE blackbody" would
  regress continuity.
- Panel C (blackbody at `Teff(B-V)` via Ballesteros 2012):
  continuous AND physical. B-V is a strong proxy for both Teff and
  logg in practice — giant-branch stars in panel C separate naturally
  from the main sequence at the same spectral class because their
  observed B-V differs.

Panel C is the visual answer to "can we ship colour-fidelity gains
**without** an external catalogue ingest?" — yes, by feeding a
blackbody LUT from Ballesteros(B-V) rather than from the T_TABLE.

### Empirical Apsis coverage (`apsis_coverage.txt`)

Probed by querying `gaiadr3.astrophysical_parameters` for a random
1000-source-id sample drawn from AT-HYG.gaia (seed 20260517):

| Metric | Count | % of sample |
|---|---|---|
| Sample size | 1,000 | — |
| Returned by Apsis (any column non-null) | 999 | 99.9% |
| `teff_gspphot` AND `logg_gspphot` | 607 | 60.8% |
| `teff_gspspec` AND `logg_gspspec` | 605 | 60.6% |
| **UNION — (Teff, logg) from gspphot OR gspspec** | **847** | **84.8%** |
| Both pipelines have (Teff, logg) | 365 | 36.5% |

Projected to the 314,865-row AT-HYG.gaia subset:
**~266,690 stars with (Teff, logg) from Apsis (~85% of the catalogue)**,
vs 92,995 with known lumClass from spectral parsing today (~29%).
**2.87× coverage improvement.**

Among the Apsis-resolved stars in our sample:
- 28.5% giants (logg < 3.5)
- 30.6% subgiants (3.5 ≤ logg < 4.0)
- 40.9% MS (logg ≥ 4.0)

The ~60% giant + subgiant share is the population currently being
rendered with MS-only T_TABLE Teff (the panel-B artefact). Apsis is
how we honestly fix that.

## Recommendation

### Tier 1 — Replace `ciToColor` with blackbody → sRGB LUT (ship standalone)

**Goal**: fix the cool/red oversaturation without waiting on any
external data ingest. **Independent of `stellata-dch`.**

**Approach**:

1. Replace the 3-stop piecewise gradient in
   `src/client/shaders/star.vert.glsl` with a sampled 1-D LUT texture
   (256 entries, RGB float16 or uint8) mapping a B-V-derived Teff →
   gamma-encoded sRGB. The LUT is precomputed at build time via
   `research/star-spectral-rendition/blackbody_color.py`'s `blackbody_to_srgb` (Planck
   + CIE 1931 Wyman 2013 fits + sRGB D65 transform, cross-checked
   against Mitchell Charity's reference table to ΔE ≤ 5 over the
   visually-meaningful range).
2. Routing per star:
   - if `ci` present: Teff = Ballesteros(B-V), sample LUT.
   - elif `spect` parseable: Teff = T_TABLE(class, subclass), sample LUT.
     Already what we compute for the Stefan-Boltzmann radius chain;
     re-use.
   - if white-dwarf: Teff = 50400 / wd_subclass (already in
     `catalog-pure.ts` `tempKelvin`), sample LUT.
   - else: solar fallback (no behaviour change vs today).
3. Dust reddening: the existing `effectiveCi = iCi + absorbAV / R_V`
   path remains — we just feed the resulting reddened B-V into
   Ballesteros and the LUT. Identical interface shape; better fidelity.

**Build-time helper** (TypeScript):
- New `scripts/blackbody-lut.ts`: ports `blackbody_color.py` to
  emit a 256-entry RGB LUT spanning B-V ∈ [-0.4, 2.0]. Embedded as a
  static `Float32Array` or `Uint8Array` constant in
  `src/client/shaders/blackbody-lut.ts` (so build-time precomputation
  has no runtime cost).
- Vitest: pin LUT byte signature so future changes go through a
  conscious bump.

**Acceptance**:
- HR diagram in-scene matches `hr_panels.png` panel C (continuous,
  physical chroma).
- Antares / Betelgeuse / Aldebaran / Sirius B / Mintaka smoke-tested
  manually per `alex-stellata-smoke-tests` (per-star expected RGB in
  `sample_comparison.txt`).
- No regression for warm A/F/G main sequence stars (smallest ΔE
  bucket — current shader is already close).

**Scope**: single PR. No schema bump (no new per-star fields). One
shader change + one LUT helper + tests + SCIENCE.md citation.

### Tier 2 — Ingest Gaia DR3 Apsis (rides `stellata-dch` Phase 1)

**Goal**: shift from B-V-derived Teff (good proxy) to spectroscopic
Teff + logg + metallicity + extinction (the canonical source). Pays
off across multiple surfaces beyond colour.

**Approach** (mirrors `dch` Phase 1 Bead pattern):

1. New refresh script `scripts/refresh-gaia-apsis.py` using the
   `scripts/refresh_lib.py` shared TAP client from `dch` Bead A (P1,
   in-flight). ADQL query: per-source-id pull of `teff_gspphot`,
   `logg_gspphot`, `mh_gspphot`, `azero_gspphot`, plus the gspspec
   equivalents as the fallback tier (see "union" empirical numbers
   above — both pipelines combined are needed for the 85% coverage).
2. Committed output: `data/gaia_dr3_apsis.tsv` (LFS, projected
   ~15-25 MB for ~266k rows × ~8 columns).
3. `scripts/build-catalog.ts` integration: when emitting v6 binary
   (in flight as `dch` Bead M — surface `gaia_source_id` per record),
   piggyback an Apsis-derived Teff field (`teff` float16, 2 bytes)
   per record. Routing precedence:
   - if Apsis (gspphot OR gspspec): use direct spectroscopic Teff.
   - else: T_TABLE(spect, lumClass) where lumClass known.
   - else: Ballesteros(B-V) where ci present.
   - else: solar fallback.
4. Tier 1 LUT is now keyed by Teff directly rather than by B-V —
   same shader path, different upstream Teff source. Tier 1 stays
   in production unchanged for stars without Apsis.
5. Optional follow-ons enabled by Apsis:
   - Cross-check `azero_gspphot` vs the Edenhofer dust map along the
     same line of sight; surface disagreements as a research diagnostic
     (NOT a swap — Edenhofer remains canonical, but disagreement
     locations are interesting).
   - Use `logg_gspphot` to refine the Stefan-Boltzmann physical-radius
     chain (`physicalRadius` in `catalog-pure.ts` currently uses
     spectral-class-only Teff for non-WD stars).
   - Metallicity-aware colour offsets (low priority — small effect).

**Dependencies**:
- `dch.21` (Bead A — `refresh_lib.py`) lands first. Apsis refresh
  script reuses the TAP client + retry + batching infrastructure.
- `dch` Phase 3 Bead M (v6 binary format) lands first IF Tier 2
  surfaces Teff per record. Alternative: ship Apsis ingest as
  TSV-only first (no binary surfacing) and let the runtime read
  it as a side index keyed by `gaia_source_id`. Lighter integration.

**Acceptance**: HR diagram in-scene retains panel-C-like continuity
but with giant/MS separation visibly improved at the cool end. Smoke
on Pollux (K0 III, lumClass III) vs HD 26367 (K0 V, lumClass V) —
they should now read distinctly.

**Scope**: 1 new refresh script + 1 ingest beat + 1 catalog-build
integration. Filed as a sibling under `stellata-dch` rather than
under `stellata-zsr`, since the infrastructure overlap is total.

### Tier 3 — Deferred / opportunistic

- **Pecaut & Mamajek 2013 extended T_TABLE** (class × lumClass) baked
  into `catalog-pure.ts` as a richer offline fallback for the ~30%
  of catalogue that has lumClass but won't get Apsis. Refines Tier 1.
  No new data ingest; library lookup + recompute. Defer until Tier 2
  ships, since Tier 2 already handles most of the giant-vs-MS
  ambiguity for the 60% of stars with Apsis.
- **Metallicity-aware colour shift** (B-V → Teff mappings differ slightly
  for [M/H] ≠ 0). Effect is small; defer indefinitely.
- **Display P3 wide-gamut output** (filed as `stellata-zsr.2`).
  Investigated empirically — see `p3_swatches.py` /
  `p3_swatches.png`. Honest finding: **negligible benefit for
  blackbody star rendering.** DCI-P3 and sRGB share the same blue
  primary, and the Planckian locus stays inside both gamuts for all
  T > ~1700 K (Stellata's coolest star is Proxima at 3170 K). Only
  the synthetic 1500 K row in the comparison shows visible
  sRGB-clipping. Bead is filed for the day Stellata renders
  non-Planckian saturated colours (nebula emission lines such as
  Hα ~ 0.708xy that DO fall outside sRGB; planet auroral colours;
  saturated chart-mode UI palettes), at which point the dual-LUT +
  canvas-colour-space + shader-audit infrastructure becomes worth
  building.

## Coordination with `stellata-dch`

`dch` was rewritten 2026-05-15 as the source-ID-anchored catalogue
pipeline rewrite (5-layer architecture, ~28 children under it). Phase 1
acquires Gaia DR3 HIP/Tycho cross-walks, astrometry, NSS orbits, and
Bailer-Jones distances — all routed through a shared
`scripts/refresh_lib.py` TAP client. **It does not currently include
Apsis.** Tier 2 above is the proposed extension.

Integration points:
- Reuse `dch.21` (refresh_lib) infrastructure verbatim — no new
  shared library.
- The Apsis refresh script slots in as a Phase 1 sibling to Beads
  B/C/D/E (HIP xmatch, Tycho xmatch, HIP2 reduction, NSS orbits).
- v6 binary format (`dch` Bead M) is the natural carrier for an
  Apsis-derived Teff field — adding 2 bytes per record alongside
  the planned 8-byte `gaia_source_id` is cheap.
- Phase 5 of `dch` ("spectral / mass refinement") already plans
  spectral-class work for the multi-star pipeline; Apsis Teff +
  logg directly improves the mass-ratio inference for stars with
  spectral type. Worth raising in Phase 5 scoping.

## Files committed under `research/star-spectral-rendition/`

| File | Purpose |
|---|---|
| `requirements.txt` | numpy + matplotlib + requests + Pillow pinned for the venv |
| `.gitignore` | excludes `.venv/`, `__pycache__/`, `per_star.tsv` (14 MB derived) |
| `display-p3.icc` | macOS Display P3 ICC profile (536 B), embedded by `p3_swatches.py` |
| `parse_spectral.py` | Python port of `catalog-pure.ts` `parseSpectral` + `tempKelvin` |
| `test_parse_spectral.py` | 14-case parity check against the TS reference (passes) |
| `blackbody_color.py` | Planck + CIE 1931 → sRGB **and Display P3**; Mitchell Charity cross-check (ΔE ≤ 5 in visible range) |
| `coverage.py` | Step 1 — counts of ci / spect / lumClass coverage over the CSV |
| `coverage.txt` | Step 1 output |
| `per_star.tsv` | per-row parsed fields (~313k rows) consumed by `hr_panels.py` |
| `compare_sample_stars.py` | Step 2b — three-way comparison for 20 reference stars |
| `sample_comparison.txt` | Step 2b output (text table) |
| `sample_swatches.png` | Step 2b output (visual swatch grid) |
| `hr_panels.py` | Step 2c — HR-diagram three-panel render |
| `hr_panels.png` | Step 2c output |
| `scene_swatches.py` | Step 4 — additive-glow-on-black perceptual swatch |
| `scene_swatches.png` | Step 4 output |
| `apsis_sample.py` | Step 3 — Gaia TAP empirical coverage probe |
| `apsis_sample.tsv` | Step 3 raw rows |
| `apsis_coverage.txt` | Step 3 summary |
| `p3_swatches.py` | Tier 3 follow-up — Display P3 vs sRGB demonstration |
| `p3_swatches.png` | Display-P3-tagged comparison image (open in Preview/Safari on a P3 monitor) |
| `RECOMMENDATION.md` | this file |

Every script is re-runnable from this directory with
`.venv/bin/python <script>.py`. The Apsis probe is deterministic for
the same `RANDOM_SEED` constant.

## FAQ / Terminology

Captured from the project conversation around this recommendation. Organised by topic rather than question order. Intended as a self-contained reference so future sessions don't have to re-derive these definitions.

### Photometry and colour

**Colour index (`ci`).** In stellar photometry, the difference (in magnitudes) between brightness measured through two filters. AT-HYG's `ci` column is specifically Johnson B−V. Not the dielectric constant; nothing to do with electromagnetism.

**B−V.** Apparent magnitude in Johnson B band minus apparent magnitude in Johnson V band. Because magnitudes are inverted (smaller = brighter):
- Hot star: brighter in B than V → B−V negative (Mintaka: −0.17).
- Cool star: brighter in V than B → B−V positive (Betelgeuse: +1.86; Sol: +0.65).

**Johnson B filter ("blue").** Centred at ~445 nm, FWHM ~94 nm (roughly 400–490 nm). Sits in the blue part of the visible spectrum, near the Balmer-jump absorption edge from hydrogen — which is what makes B such a sensitive temperature diagnostic.

**Johnson V filter ("visual").** Centred at ~551 nm, FWHM ~88 nm (roughly 505–595 nm). Yellow-green region. "Visual" because it was designed to **approximately match the photopic sensitivity of the dark-adapted human eye** (peak ~555 nm). Not a perfect match to CIE photopic luminance — V is narrower — but a deliberate "this is roughly what the eye sees" passband. Both B and V were defined in the 1950s by Harold Johnson using specific glass filters and a 1P21 photomultiplier; modern reproductions shape glass to match the original passbands.

**B−V zero-point.** Anchored historically to **Vega** (α Lyrae, A0V): the Johnson-Vega magnitude system defines Vega as magnitude 0 in every band, so B−V = 0 for Vega by construction. The whole Johnson-Vega system is anchored there. Sirius A happens to read near zero coincidentally — it's a similar A-type star. (Note: `sample_comparison.txt` shows **Sirius B** at 0.00, not Sirius A — Sirius B is the white-dwarf companion, and the 0.00 reflects an AT-HYG rounding/fallback for the WD, not the physical anchor.)

**Why there are no "green" stars.** Blackbody radiation is a smooth, single-peaked curve. Wien's law gives a 5800 K star (Sol) a peak emission wavelength of ~500 nm — yes, in the green. But the curve is broad: a 5800 K blackbody radiates substantial power across blue, green, and red. Your eye integrates the visible band, three cone types compete, and the brain calls it **white**.

For perception to read "green", you'd need a spectrum that **suppresses** both blue and red while leaving green high. A blackbody can't do that — it's monotonic on either side of the peak. As T decreases, the peak shifts red AND the blue tail shrinks AND the red tail grows: red wins. As T increases, the peak shifts into UV, the entire visible curve flattens, and the result reads blue-white. There's no thermal-emission configuration that suppresses red and blue while passing green. Stars walk a path from blue-white → white → yellow-white → orange → red as they cool, skipping "green" entirely.

(Emission nebulae *can* read green — OIII at 500.7 nm is a narrow forbidden-line emission, not a blackbody. Different physics. Filed as a future motivator for Display P3 wide-gamut output in `stellata-zsr.2`.)

**ΔE (delta-E).** A colour-science term, not temperature, not Maxwell's equations. The E is from German *Empfindung* (perception / sensation). ΔE is a perceptual distance metric in CIE Lab colour space. Rough rules of thumb:
- ΔE ≈ 2.3: just-noticeable difference.
- ΔE > 10: "obviously different."
- ΔE > 50 (Antares, Betelgeuse vs physical blackbody): "wrong colour, not a subtle shift."

### Stellar spectroscopy and atmospheres

**Spectral class (O B A F G K M).** Fundamentally a **temperature** classification, ordered hot → cool. Originally drawn from absorption-line patterns: hotter atmospheres ionise hydrogen away, leaving weak H lines; cooler ones keep metals neutral, producing strong metal lines. Today we read "spectral class ≈ Teff bin." Subclass digits 0–9 subdivide each letter (e.g., A0 hotter than A9). Extra classes: L T Y for cool brown dwarfs, W for Wolf-Rayets, D for white dwarfs.

**Luminosity class (I–VII).** Fundamentally a **surface-gravity** classification. Determined by line widths and ratios, not by colour. Same Teff, same B−V — distinguishable only by line-profile analysis.
- I: supergiant (logg ~0–1).
- II: bright giant.
- III: giant (logg ~2–3).
- IV: subgiant (logg ~3.5).
- V: main sequence / dwarf (logg ~4.0–4.5).
- VI: subdwarf.
- VII: white dwarf (logg ~8).

**Pressure broadening (physics).** In a denser photosphere (high surface gravity ⇒ atmosphere compressed deep, particle density n high), each absorbing atom is hit by neighbouring particles much more often than in a low-density giant atmosphere. Two mechanisms widen absorption lines:
- **Stark broadening (electric):** any passing charged particle (free electron, nearby ion) carries a Coulomb field that perturbs the absorber's energy levels via the Stark effect. The absorption frequency shifts during each perturbation. Averaged across the photosphere column, the line spreads in frequency. Width scales roughly as n_e^(2/3) for hydrogen. Hydrogen Balmer lines (Hγ width especially) are the workhorse logg diagnostic for hot stars.
- **Collisional / van der Waals broadening (neutral):** brief collisions with neutral atoms shorten the lifetime of the excited state. Heisenberg ΔE·Δt ~ ℏ means a shorter lifetime gives a broader energy uncertainty, so a broader line.

Low gravity = puffed-out atmosphere = orders-of-magnitude lower density = perturbations rare = sharp narrow lines. That's the entire luminosity-class diagnostic.

**Effective temperature (Teff).** Temperature of a blackbody emitting the same total bolometric flux as the star. It's the *physical* quantity; colour and spectral class are *observational proxies*. Inference paths (most → least direct):
- Detailed spectroscopic model-atmosphere fit (Apsis GSP-Spec) — best.
- Multi-band photometric SED fit + parallax (Apsis GSP-Phot) — good.
- Single colour index → empirical relation (Ballesteros) — workable.
- Spectral class look-up (`T_TABLE`) — coarsest.

**Ballesteros 2012 relation.** Clean empirical fit mapping B−V → Teff, calibrated against stars with both measured independently:

```
Teff = 4600 × (1/(0.92(B−V) + 1.7) + 1/(0.92(B−V) + 0.62))   [K]
```

Works well A through K; less accurate for extreme M dwarfs and hot O stars. The basis for Tier 1's continuous-chroma LUT routing where `ci` is present — every star with a `ci` value gets a continuous Teff out, no discretisation, which is why Panel C in `hr_panels.png` is smooth.

**logg.** log₁₀ of surface gravity in cgs (cm/s²). g = GM/R², so big radius ⇒ low logg. Ballparks: supergiant ~0–1, giant ~2–3, subgiant ~3.5, MS dwarf ~4–4.5, white dwarf ~8. *The* spectroscopic discriminator between a K-giant and a K-dwarf at identical Teff.

**Metallicity [M/H].** Brackets-mean-log convention pervades stellar spectroscopy:

```
[M/H] = log₁₀(N_metals/N_H)_star − log₁₀(N_metals/N_H)_Sun
```

- `[M/H] = 0`: solar metallicity.
- `+0.3`: 2× solar.
- `−1.0`: 1/10 solar.
- `−4`: very old halo star.
- `−6+`: most metal-poor Pop II stars known.

"Metals" in astronomy = everything heavier than helium (so C, N, O are "metals" — terminologically loose vs chemistry). `[Fe/H]` (iron specifically) is the workhorse proxy because iron has many strong absorption lines and is easy to measure.

### Stellar populations and evolution

**Population I / II / III.** Stellar classes by metallicity. The age inversion matters and is counterintuitive:
- **Pop III**: hypothetical first stars, essentially zero metals. Never directly observed. Predicted to have been massive, short-lived, gone in <1 Gyr.
- **Pop II**: old halo stars, low metals (typical [Fe/H] −1 to −3), ages ~10–13 Gyr.
- **Pop I**: disc stars like Sol, high metals (typical [Fe/H] ~0), ages ≤10 Gyr.

**Older stars have LOWER metallicity.** Each generation forms from gas enriched by prior supernovae, so successive populations are progressively metal-richer. The cosmic ISM gets metal-richer over time; each star is a frozen snapshot of ISM metallicity at the moment it formed.

**Metallicity within a star's own lifetime.** Mostly **frozen** at the value of the natal gas cloud. Even though heavy-element fusion happens in the core, the products stay there during the main sequence — they don't mix to the surface. So Sol's surface [Fe/H] today equals what it was 4.6 Gyr ago at formation.

Exceptions (surface composition *does* change):
- **First dredge-up** (ascending the RGB): deepening convective envelope brings up CN-processed material. Alters C/N/O ratios slightly. Total [M/H] essentially unchanged.
- **Third dredge-up** (TP-AGB, intermediate-mass stars 1.5–8 M☉): repeated convective episodes bring up s-process elements (Ba, Sr, Y) from helium-burning shells. A TP-AGB star really does become surface-metal-enriched in s-process species before shedding its envelope — this is where most s-process elements in the universe originate.
- **Massive stars in late evolution** (Wolf-Rayet, RSG): wind / mass loss strips outer layers and exposes processed material. Drastic surface-composition changes.

**Metal release into the ISM.** Metals stay locked in stellar cores until something violent happens. The channels:
- **Stellar winds** — throughout life, strong in massive stars and AGB stars. Radiation pressure on dust drives them.
- **Planetary nebula ejection** — end of life for low/intermediate-mass stars (≲ 8 M☉). Envelope shed over ~10⁴ yr; exposed core becomes a white dwarf. Carries up third-dredge-up s-process elements.
- **Core-collapse supernovae** — for stars > 8 M☉. Cataclysmic ejection. Major source of α-elements (O, Ne, Mg, Si, S, Ca, Ti) plus Fe from Si-burning shell.
- **Type Ia supernovae** — white-dwarf binaries; thermonuclear runaway. Major source of galactic iron-peak elements.
- **Neutron-star mergers** — r-process elements (gold, lanthanides, uranium). Confirmed by GW170817 / kilonova observation.

A star that "just gradually dies" without one of these — very low-mass stars (< 0.5 M☉) — eventually becomes a helium white dwarf with minimal mass loss. But: MS lifetime of a 0.3 M☉ red dwarf is ~10¹³ years, vs universe age of 1.38 × 10¹⁰ years. **Not a single low-mass star in the universe has finished its MS yet.** The "gradual cooling-to-extinction" path is a real evolutionary endpoint at timescales that haven't elapsed.

**Main Sequence (MS).** Core hydrogen fusion. The long stable phase. Sol has been here 4.6 Gyr and has ~5 Gyr left. ~90% of all observable stars are on the MS right now because it's the longest-lived phase.

**Red Giant Branch (RGB).** Inert helium core, hydrogen-shell burning, hugely expanded cool envelope. Climbs the right side of the HR diagram nearly vertically at ~3500 K. Surface temperature pins to the Hayashi line because the envelope is fully convective.

**Asymptotic Giant Branch (AGB).** Inert C/O core, *two* burning shells (He inside, H outside). Two-shell configuration is unstable — He-shell flashes every ~10⁵ yr drive **thermal pulses**, each pulse triggering convective dredge-up of carbon and s-process elements. Strong winds throughout (10⁻⁷ to 10⁻⁴ M☉/yr); ends with envelope stripped entirely → planetary nebula + white dwarf.

**Sol's HR-diagram trajectory** (coordinates as (Teff, L) in (K, L☉)):

| Phase | Time | (Teff, L) | Notes |
|---|---|---|---|
| Pre-MS Hayashi descent | T = −50 Myr | (~4000, 10 → 1) | Near-vertical fall at cool Teff |
| Pre-MS Henyey track | T ~ −10 Myr | (~4000 → 5600, 1) | Leftward jog onto MS |
| ZAMS | T = 4.6 Gyr ago | (5600, 0.7) | "Faint young Sun" — geological puzzle |
| Today | T = 0 | (5772, 1.0) | By definition |
| End of MS | T + 5 Gyr | (5800, 1.7) | Core H exhausted |
| Subgiant slide | T + 5–5.5 Gyr | (5800 → 4800, ~2) | Horizontal rightward |
| Base of RGB | T + 5.5 Gyr | (4800, 2) | H-shell burning starts |
| Up the RGB | 5.5–7.5 Gyr | (3500, 2 → 2700) | Near-vertical climb at Hayashi temperature; radius ~170 R☉ ≈ 0.8 AU |
| RGB tip / He flash | T + 7.5 Gyr | (3100, 2700) | Degenerate core ignites He |
| Red clump | T + 7.6 Gyr | (4700, 50) | Stable He-core + H-shell burning, ~100 Myr |
| Up the AGB | 7.6–7.71 Gyr | (3000, 3000+) | Second giant ascent; thermal pulses; s-process dredge-up |
| Post-AGB horizontal sprint | T + 7.71 Gyr + ~30 kyr | (3000 → 100,000, 3000) | Envelope stripped; core exposed; near-horizontal traverse leftward across the HRD top |
| Planetary nebula | T + 7.71 Gyr + 30 kyr | (~100,000, ~3000) | Hot core ionises ejected envelope; ~10⁴–5×10⁴ yr |
| White-dwarf cooling | T + 7.72 Gyr → ∞ | (100,000 → <1000, 1 → 10⁻⁹) | Diagonal descent toward lower-right; no more fusion |
| Eventual "black dwarf" | T + ~10¹⁵ yr | (~0, ~0) | Theoretical endpoint; no WD has yet had time to cool this far |

Five distinct HRD regions across Sol's life: MS (longest), giant branches (modest), connecting phases (brief), post-AGB horizontal sprint (eyeblink), WD cooling track (eternity).

### HR diagram and age dating

**Turnoff stars.** In a coeval population (cluster), the star at the kink where the main sequence meets the subgiant branch — the heaviest star still on the MS. Its mass tells you the cluster's age via MS-lifetime lookup (τ_MS ≈ 10 Gyr × (M/M☉)^(-2.5)). This is the most reliable absolute age dating method in astrophysics. Anchors everything from galactic disc ages to the age of the universe.

**HR diagram of a coeval population (cluster).** *The* age oracle. Every star formed at the same time from the same gas, so they share (age, [Fe/H]) and differ only in mass. Read age off the turnoff; cross-check with RGB slope, subgiant location, RGB-tip luminosity, red-clump position, HB colour, faint-end of WD cooling sequence. System is wildly over-determined → cluster ages accurate to ~5–10%. M92: 13.2 Gyr. Pleiades: 110 Myr. 47 Tuc: 11 Gyr.

The one ambiguity is metallicity: lower [Fe/H] makes stars sit slightly hotter and bluer at the same age. Broken by measuring [Fe/H] spectroscopically (or fitting from colour-magnitude shape) and choosing the right isochrone family.

**HR diagram of mixed-age field stars.** Age-blind for **individuals** because of age-mass-metallicity degeneracy — a 1-Gyr 1-M☉ star sits at nearly the same HRD point as a 6-Gyr 1-M☉ star. The MS migration over 5 Gyr is small (~0.2 dex in L, ~100 K in Teff) and easily swamped by metallicity scatter.

But not age-blind for **populations**. Two techniques work:

**White-dwarf luminosity function (WDLF).** A WD's cooling age is a clean function of its current Teff / luminosity (set by the WD mass-radius relation + thermal physics of degenerate matter). The *oldest* WD in a population is the faintest. Plot WD counts vs L → sharp drop-off at the faint end → that's the cooling age of the oldest WDs, i.e., the age of the first stars in the population that have finished their MS. Disc WDLF cutoff gives ~8–10 Gyr; globular WDLF cutoffs give ~11–13 Gyr (independent confirmation of cluster turnoff ages from a totally different physical clock).

Refinement: "we have lots of WDs" doesn't directly mean "10 Gyr old" — most WDs come from 1–4 M☉ progenitors with MS lifetimes of 0.2–10 Gyr. The age signal is **how cool is the coolest WD**, not "do we have WDs." A 4000 K, 0.6 M☉ WD has been cooling for ~10 Gyr; that's the clock.

**Population synthesis.** Treat the observed CMD as a superposition of coeval populations (a star formation history), each weighted by stellar mass formed at that epoch. Fit the mixture to observed star counts in each (colour, magnitude) bin. Output: SFH curve. For the Milky Way:
- **Halo**: single old burst ~12.5 Gyr ago, low [Fe/H].
- **Thick disc**: ~10–12 Gyr, formed quickly, intermediate [Fe/H].
- **Thin disc**: continuous SFH ~10 Gyr ago to present; star formation ongoing.
- **Bulge**: mostly old, ~10 Gyr.

So the Milky Way's "age" is ~13 Gyr for its oldest stars, with ongoing SF since. Number is robust because oldest globular turnoffs, halo WDLF cutoffs, and halo subgiant ages all converge.

**Comparing galaxies via CMD shape.** How galaxy classification works observationally:
- **Ellipticals**: red sequence dominates, no upper MS, no bright blue stars. Population uniformly old, no SF for ~1+ Gyr.
- **Spiral discs**: blue cloud + red sequence. Mix of ongoing + old.
- **Starburst / blue compact dwarfs**: upper MS dominates. SF right now.
- **Local Group dSphs (Draco, Ursa Minor)**: old halo-like, no SF for ~10 Gyr.
- **LMC/SMC**: mixed, ongoing SF, young clusters.

**Stellata's catalog selection bias.** AT-HYG classic-IDs is **apparent-magnitude-limited** — preferentially includes intrinsically luminous stars (giants, OB stars, bright MS A/F) and dramatically under-samples the faint MS and especially the white-dwarf cooling sequence. ~10 named WDs survive (Sirius B, Procyon B, Van Maanen's, 40 Eri B, etc.); the faint WDs that would pin a WDLF cutoff are nowhere near the catalog. Plotting Stellata's HRD shows the population shape qualitatively but cannot extract galactic SFH quantitatively — selection has thrown away the diagnostic faint-end data.

**Volume-completeness from Gaia.** The fix is a **volume-limited** sample (every star within X parsecs regardless of brightness). Gaia DR3 has made the inner ~50–100 pc around Sol effectively volume-complete down to G ~17 — catches all M dwarfs, most brown dwarfs, many faint WDs. The 50-pc "Gaia Catalogue of Nearby Stars" (GCNS) is the gold-standard volume-complete sample with WD inclusion; the 100-pc sample is standard for galactic archaeology.

Stellata's inner sphere could be made volume-complete by pulling Gaia DR3 sources within R pc that AT-HYG classic-IDs excludes — a "you can wander here, knowing every star is in the model" navigation zone. Filed as `stellata-io3.3` (deferred until `stellata-dch` lands).

### Gaia data products

**BP (Blue Photometer).** Low-resolution prism spectrophotometer, ~330–680 nm, ~120 wavelength bins. Captures the overall spectral energy distribution shape and deepest absorption features. Available for every Gaia source. Resolution R ~30–100 — doesn't resolve sharp lines.

**RP (Red Photometer).** Same instrument family as BP but ~640–1050 nm. Together BP+RP give a full optical+near-IR SED for every Gaia source.

**RVS (Radial Velocity Spectrometer).** A narrow high-resolution slice (~845–872 nm, R ~11,500) around the Ca II infrared triplet. Resolves real line shapes. Primary purpose: Doppler-shift measurement for radial velocity. Line profiles also encode Teff / logg / [M/H]. Only works for stars brighter than G_RVS ~ 14 — that's why GSP-Spec has narrower coverage than GSP-Phot.

**GSP (General Stellar Parametrizer).** Family of Gaia DPAC pipelines that derive astrophysical parameters from the raw spectra.
- **GSP-Phot**: ingests BP/RP low-res spectra + parallax + integrated G magnitude. Bayesian MCMC fits a grid of synthetic stellar-atmosphere model templates (PHOENIX, MARCS, A-star libraries) parametrised by (Teff, logg, [M/H], A0 extinction, distance). Returns posterior best-fit + uncertainties. Coverage is huge because every star Gaia observed has BP/RP.
- **GSP-Spec**: ingests the RVS spectrum, fits a different model library (MatisseGauguin / GAUGUIN algorithms) by matching observed line depths and shapes in the Ca II triplet region. Returns Teff, logg, [M/H], [α/Fe], and for the brightest stars individual element abundances (Fe, Ca, Mg, Si, …). Smaller coverage, more direct chemistry.

The 84.8% empirical Apsis coverage in `apsis_coverage.txt` is the **union** of "has GSP-Phot result" ∪ "has GSP-Spec result." Most stars get only Phot; brighter stars get both.

**FLAME (Final Luminosity Age Mass Estimator).** Downstream Apsis module that takes GSP-Phot/Spec-derived (Teff, L, [M/H]) and runs isochrone fitting against stellar-evolution tracks to extract **age** and **mass** per star. DR3 FLAME ages are highly uncertain for MS field stars (±2–4 Gyr typical) — useful for population statistics but not for individual ages. DR4 will significantly improve FLAME via longer baseline + tighter Apsis inputs. Filed as `stellata-3f8.1`, deferred until DR4.

**Apsis** (Astrophysical Parameters Inference System) is the umbrella name for the whole pipeline collection: GSP-Phot, GSP-Spec, FLAME, plus other modules (ESP-HS for hot stars, ESP-UCD for ultracool dwarfs, ESP-CS for chromospheric activity, ESP-ELS for emission lines, MSC for unresolved binaries, OA for outlier analysis, DSC for source classification). All outputs land in `gaiadrN.astrophysical_parameters` keyed by `source_id`.

## Case study: Mu Cephei, the Garnet Star

A worked example of how Stellata's rendering pipeline interacts with line-of-sight dust, and what that means for the user's experience.

### The star

Mu Cephei (μ Cep, Herschel's Garnet Star) is one of the largest known stars in the Milky Way — an M2 Ia red supergiant in Cepheus, ~870 pc from Sol, sitting in a dusty region near IC 1396. Spectroscopic effective temperature around **3750 K**, an observed B−V of approximately **+2.4**, and intrinsic B−V (de-reddened) of roughly **+1.7** for its spectral class. The Earth-observed colour difference vs intrinsic implies E(B−V) ≈ 0.7 — substantial interstellar reddening.

Herschel named it "Garnet Star" in 1783 by eyepiece. The name has stuck for 240 years; the question is whether Stellata's physically-grounded rendering will reproduce that visual identity, and what the answer reveals about how the model works.

### Rendering at each stage of the pipeline

| Method | Effective Teff | sRGB |
|---|---|---|
| Pure blackbody at spectroscopic Teff (no dust, no observer) | 3750 K | (255, 206, 153) — warm peach |
| Ballesteros from observed B-V = +2.4 (dust-reddened, Earth observer) | 2804 K | (255, 178, 96) — pumpkin / amber |
| Current shader (wrong, oversaturated) at B-V = 2.4 | n/a | (255, 140, 89) — strong orange-red |
| Almandine garnet gemstone (reference) | n/a | (115, 54, 53) — deep brick / burgundy |

The structural observation: **garnet does not exist on the blackbody curve at any temperature.** Garnet sits at low R, very low G, very low B (it's a *dark* deep red). Thermal emission can't get there — by the time the spectrum is cool enough to suppress green and blue meaningfully, the red channel is already saturated at 255. The curve traverses (255, lots, lots) → (255, less, less) → (255, ~130, 0) → (255, 0, 0). It never reaches a gemstone's "red is dominant but absolute brightness is low" combination, because thermal emission can't produce that. **Garnet is a reflectance colour from a transmissive mineral, not an emission colour.** No star can really *be* the colour of a garnet.

The "Garnet Star" name is therefore a perceptual / contextual story, not a chromaticity claim:

- **Real interstellar dust reddening.** Earth-observed B−V = +2.4 vs intrinsic ~+1.7 → ~0.7 mag E(B−V), ~2.2 mag A_V along the line of sight. Photons reaching Earth have been preferentially blue-stripped. This is a genuine physical reddening, not an artefact of perception.
- **Colour contrast against hot neighbours.** Mu Cep is a few degrees from α Cep (A7 IV-V, white) and β Cep (B2 III, hot blue). The eye/brain shifts perceived hue toward the complement of surroundings, so a warm star adjacent to blue-white stars reads **redder** than it would in isolation.
- **Eyepiece saturation enhancement.** Against a jet-black sky at low photopic levels, warm-axis saturation perception is exaggerated. Red cones can saturate at the bright core of a point source while G and B desaturate around it, pushing perceived hue further toward red. Old refractor chromatic aberration smears red outward.
- **Looser 18th-century colour naming.** "Garnet" in 1783 covered a broader range than the modern mineralogical-precise burgundy — closer to "deep warm red-orange, like an ember." Some of the gap between modern almandine swatches and what a blackbody can produce is semantic drift.

### Position-dependent colour: the Stellata pipeline's key property

The most interesting feature of the pipeline for this case study is **observer-position-dependent dust reddening**. The dust-reddening correction `effectiveCi = iCi + A_V / R_V` (R_V = 3.1) samples A_V along the **line of sight from camera to star** via the Edenhofer 3D dust map. As the camera moves, the integral changes.

The consequence for the Garnet Star specifically — and for every dust-reddened star in the catalogue — is that:

- **Viewed from Earth (camera near Sol):** the line-of-sight integral covers all dust between Sol and Mu Cep — the full ~2.2 mag A_V column. The rendered colour is the dust-reddened ~(255, 178, 96), warm pumpkin-amber.
- **Viewed up close (camera near Mu Cep):** the line-of-sight integral covers essentially zero dust (Mu Cep's local cavity is mostly cleared by its own wind). The rendered colour drifts toward the **intrinsic** stellar blackbody, ~(255, 206, 153), a warm peach.
- **Viewed from somewhere beyond Mu Cep (camera far side of the dust column):** the integral covers a different dust subset — possibly *less* than the Earth-side column, depending on the 3D dust geometry. Local dust geometry along *the new* line of sight is what determines reddening, not "how far from Mu Cep the camera is" in a 1D sense.

This is **a genuine feature, not a bug**. In real astrophysics, the colour of a star **is observer-dependent**: a hypothetical observer near Mu Cephei would see a noticeably less-red star than we do from Earth, because their photons travel through less dust to reach them. Stellata's pipeline reproduces this faithfully via the 3D Edenhofer map and per-frame line-of-sight integration. Stars are not "labelled with a colour" in the model — they have an intrinsic spectrum which is filtered through the actual interstellar medium between camera and star at every frame.

### Implications for visiting Mu Cephei in Stellata

The user warping from Sol to Mu Cephei will see the rendered colour shift smoothly from pumpkin-amber (255, 178, 96) toward warm peach (255, 206, 153) as the camera traverses the intervening dust column and the line-of-sight A_V drops. The star **becomes less red** as you approach it.

This isn't a Stellata-specific quirk — it's how the universe actually works. The "Garnet Star" name is an Earth-perspective name. From a Mu-Cep-local vantage point, it would be the "Peach Star."

The same observation applies to every other notably dust-reddened object in the catalogue: Betelgeuse (modest reddening), Antares (moderate), the more distant heavily-extinct M giants in dusty regions, the obscured stars behind the galactic plane. Approach changes their colour. The further the original line-of-sight integrated through dust, the more dramatic the shift on approach.

### What this case study confirms about Tier 1 readiness

The Tier 1 LUT swap doesn't change any of the above — dust reddening is upstream of the LUT and continues to feed reddened B−V values into the LUT sampler. What Tier 1 fixes is the chromaticity mapping at each (reddened) Teff: today's piecewise gradient over-saturates the warm-red end (current Mu Cep ≈ (255, 140, 89), more vivid than physical), while Ballesteros + blackbody + sRGB lands at the physically correct (255, 178, 96). The dust column itself remains in the loop, and the observer-position-dependent rendering remains intact. Tier 1 will make Mu Cep less aggressively red than it currently looks — but the position-dependent variation as the user approaches the star (the genuine physics) will remain identical in shape, just shifted to a more honest baseline.
