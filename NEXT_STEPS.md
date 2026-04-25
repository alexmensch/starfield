# Starfield — next steps

A roadmap for the remaining ISM (interstellar medium) and post-ISM work.
Each section is self-contained enough to drive a separate Claude Code
session against — open a fresh chat, paste the relevant section, go.

The session that produced Phase 1 (per-star extinction) and shelved
Phase 2 (particle-cloud visualisation) ran on 2026-04-24/25; commit log
under `git log --oneline | head -20` is the canonical record of what
landed.

## Current state

Done:
- **Phase 1: per-star extinction** — Edenhofer 2023 dust map resampled
  onto a 512³ ICRS Cartesian voxel grid, served as 64 chunks via LFS,
  progressively uploaded to a `Data3DTexture` on the client, raymarched
  in the star vertex shader to dim + redden stars by line-of-sight A_V.
  See `CLAUDE.md` "Dust extinction" section for details.

Shelved (dark code):
- **Phase 2: dust visualisation layer** — particles loaded but rendered
  at strength = 0 by default. Revisit notes below.

Not started:
- Phase 3a: molecular cloud catalog
- Phase 3b: nebulae catalogs (PN, RNe, H II, SNR)
- Phase 4a: Local Bubble shell mesh
- Phase 4b: Radcliffe Wave spine

There's also one pre-existing rendering bug to chase
(`memory/project_rectangular_blocks_todo.md`) — pre-dates the dust
work, parking until ISM is done.

---

## Revisit dust visualisation

**Status:** infrastructure complete, default off, needs render tuning.

**The fundamental tension:** real interstellar dust is *dark*. It
absorbs starlight; it doesn't emit. The current particle implementation
renders dust as additive warm-brown glows, which is visually pretty but
inverts physical reality. A user looking at the additive fog sees
"glowing dust everywhere" when in reality those regions are *darker*
than empty space.

The per-star extinction layer (Phase 1, shipped) is the physically
honest representation — stars behind dust dim and redden. That's what
an observer at Sol would actually see.

**Open questions to settle before re-enabling particles:**

1. **What's the role of the visualisation layer?** Two possible framings:
   - **(a)** "Show me where the dust is" — a non-physical overlay, clearly
     marked as visualisation, similar to how astronomical maps overlay
     contour lines. Additive glow is fine here, just label it as such.
   - **(b)** "Make the dust visible against starlight" — physically
     motivated darkening using `MultiplyBlending` so dust patches
     occlude stars rather than emitting light. This is closer to truth
     but only visible where there are bright background stars.
2. **Particle splat tuning** — current values (`MIN_PX = 30`, `MAX_PX = 80`,
   brightness range 0.04–0.15) are a starting point; needs side-by-side
   testing to find the splat-size / brightness combination where dense
   regions feel like fog and diffuse regions stay below the perceptual
   floor. The goal is "smooth from overlap, never individual specks."
3. **Importance sampling tradeoff** — current density-weighted sampling
   over-represents dense cores; sqrt or log weighting gives more
   diffuse-region representation but flattens the cores. A two-tier
   approach (80% density-weighted + 20% uniform-where-d>threshold) might
   be the right balance.
4. **UX entry point** — currently console-only via
   `starfield.setParticleStrength(x)`. Promoting to a user-facing toggle
   needs UI design (probably a checkbox under "Display Settings" with a
   short label like "Show interstellar dust").

**Files to touch:**
- `src/client/shaders/dust-particle.vert.glsl` — splat sizing, brightness
- `src/client/shaders/dust-particle.frag.glsl` — falloff curve, blend mode
- `scripts/build-dust.py` `sample_particles()` — importance-sampling
- `src/client/starfield.ts` `attachDustParticles()` — blend mode if changing

**What NOT to change:** the per-star extinction layer is shipped and
working. Don't tune it during particle work; it's the physical baseline.

**Reference for the abandoned fullscreen-fog approach:** see
`memory/feedback_raymarch_for_nebulae.md` — fullscreen raymarch produced
unfixable banding/jitter at far zoom. Don't go back to it for the all-sky
volume; it's the right tool only for small per-nebula AABBs.

---

## Phase 3a: molecular cloud catalog + labels

**Goal:** named, searchable molecular clouds (Taurus, Ophiuchus,
Perseus, Aquila Rift, etc.) with optional translucent ellipsoid
highlights and labels.

**Data sources:**
- **Wang et al. 2025** (arXiv:2509.07670) — 3,345 clouds, 90 pc to
  4.3 kpc, all-sky. Machine-readable table likely on Harvard Dataverse
  or CDS VizieR; check the paper's data availability section.
- **Zucker et al. 2020** (Star Formation Handbook compendium) —
  ~300 local clouds with high-quality distances <2.5 kpc. Dataverse:
  https://dataverse.harvard.edu/ search for "Zucker Star Formation Handbook".
  Best for clouds with established common names.
- **Cahlon et al. 2024** (arXiv:2311.00063 / ApJ 961, 153) — derived
  from the Edenhofer map directly, so its catalog is consistent with
  our voxel grid by construction.

**Per-cloud data to keep:** common name (if any), Galactic l/b/distance
→ converted to ICRS xyz, effective radius, mass, mean density,
cross-references between catalogs.

**Implementation sketch:**
- Add a Python step to `scripts/build-dust.py` (or a new
  `scripts/build-clouds.py`) that ingests the catalogs and emits
  `data/dust/clouds.json` (~few hundred KB).
- Load alongside `manifest.json` in `main.ts`.
- Add cloud names to `search-index.json` (or a separate cloud index)
  so the existing search box can fly to "Taurus".
- Render: optional translucent ellipsoid per cloud at the centroid,
  sized by catalog radius. SVG label at projected centroid (reuse the
  constellation-overlay pattern in `constellation-overlay.ts`).
- UI toggle: "Show molecular clouds" checkbox in the panel.

**Watch out for:**
- Coordinate frames — Wang/Zucker tables are Galactic; convert to ICRS
  on ingest to match catalog.bin.
- Cloud-to-cloud overlap — same physical cloud may appear in two
  catalogs with different IDs. Need a dedup pass keyed on common name
  + position.

**Estimate:** 4–8 hours for a polished first pass.

---

## Phase 3b: nebulae catalogs (PN, RNe, H II, SNR)

**Goal:** classical named nebulae (Orion Nebula, Ring Nebula, Helix,
Veil, Horsehead, etc.) as discrete blob objects with type-based colour
coding and search-bar entries.

**Data sources** (filter to within ~3 kpc to match the dust volume):
- **Strasbourg-ESO Catalogue of Galactic Planetary Nebulae** (Acker
  et al. 1992, updated): VizieR `V/84` or HEASARC `PLNEBULAE`.
  ~1,500 PNe with up to four independent distance estimates each.
- **Merged Catalog of Reflection Nebulae** (Magakian 2003): VizieR
  `J/A+A/399/141` or HEASARC `REFNEBULAE`. 913 reflection nebulae;
  cross-match the illuminating star to ATHYG via HD/HIP for distance.
- **Sharpless H II catalog**: VizieR `VII/20`. 313 entries; pair with
  Avedisova's "Catalogue of Star-Forming Regions" (VizieR `V/115`)
  for derived distances since the original catalog has none.
- **SIMBAD TAP query** for unified all-types fetch: object types `PN`,
  `RNe`, `HII`, `SNR` with a distance cut, via `astroquery.simbad`.

**Per-nebula data:** ID, common name, type, RA/Dec/distance → xyz,
angular size → physical radius, illuminating star (for RNe).

**Rendering — this is where raymarching IS appropriate.** Each nebula
occupies a small AABB (typically 1–50 pc), so per-nebula raymarching
with 16–32 samples is dense in voxel-space and produces smooth
volumetrics without the aliasing that killed the all-sky fog. See
`memory/feedback_raymarch_for_nebulae.md` for context. Recover the fog
shader pattern from git history at commit `5ad5444` if useful — it's a
clip-space fullscreen triangle, ray-AABB slab intersection, fixed-step
march with log-encoded density decode.

**Type-based visuals:**
- H II regions — warm reddish-pink, soft sphere with density falloff
- Planetary nebulae — greenish-teal, often shell-like; small central
  point + thin shell
- Reflection nebulae — bluish, irregular blob biased toward the
  illuminating star's colour (look up via ATHYG cross-ref)
- Supernova remnants — filamentary; pink→blue gradient by age

**No photographs.** All visuals procedural, matching the rest of the
app's aesthetic.

**Watch out for:**
- Many PNe have only rough distance estimates; drop entries with
  no parsed distance.
- Filter to ATHYG-relevant volume — most distant PNe (>5 kpc) won't
  render usefully and clutter search.
- Procedural shape variation per type — without it, every nebula is a
  blob and the type encoding gets lost.

**Estimate:** 1–2 days for catalogs + ingest + rendering. The
volumetric raymarching for the per-nebula effect is ~half the work.

---

## Phase 4a: Local Bubble shell mesh

**Goal:** translucent surface mesh of the Local Bubble (low-density
ISM cavity surrounding the Sun, ~200 pc radius). Subtle by default,
toggleable for emphasis. Gives the user immediate context that the Sun
sits *inside* a bubble.

**Data sources:**
- **O'Neill, Zucker, Goodman & Edenhofer 2024** ("The Local Bubble Is
  a Local Chimney", ApJ 973, 136 / arXiv:2407.18238). The paper should
  have a data availability section; if not, check Catherine Zucker's
  GitHub: https://github.com/catherinezucker
- **Zucker et al. 2022** (Nature, "Star formation near the Sun is
  driven by the expansion of the Local Bubble") — earlier 3D mesh.
  Also linked from her interactive 3D gallery at
  https://catherinezucker.github.io/

**Implementation sketch:**
- Source format likely OBJ/PLY/HDF5 mesh. Convert at preprocessor time
  to a tiny binary (vertex positions + face indices). Few thousand
  vertices typically.
- Three.js: `THREE.Mesh` with `THREE.MeshBasicMaterial({ transparent:
  true, opacity: 0.05, side: DoubleSide, blending: AdditiveBlending })`.
- Subtle inner/outer gradient via vertex colours (front-facing vs
  back-facing) so users can perceive 3D shape.
- Label "Local Bubble" at the centroid, similar to constellation
  labels.
- UI toggle.

**Watch out for:**
- Coordinate frame — likely Galactic; rotate to ICRS on ingest.
- Mesh might be in different units (kpc vs pc); verify scale.
- Front-vs-back face ordering matters for the gradient effect.

**Estimate:** 3–5 hours.

---

## Phase 4b: Radcliffe Wave spine

**Goal:** glowing polyline showing the ~3 kpc oscillating gas wave
that passes near the Sun. Famous nearby structure, narratively
striking, very small data.

**Data sources:**
- **Alves et al. 2020** (Nature, original discovery).
- **Konietzka et al. 2024** — oscillation phase data.
- Catherine Zucker's GitHub / interactive gallery again is the
  practical entry point for the spine point list (~100 points).

**Implementation sketch:**
- Read ~100 (x, y, z) spine points from source. Tiny — kilobytes.
- Render as a `Line2` (Three.js fat line helper) with emissive
  shader, optionally colour-coded by oscillation phase from
  Konietzka 2024.
- Label "Radcliffe Wave" at midpoint of the spine.
- UI toggle.
- Bonus: when toggled on, highlight catalogued molecular clouds that
  are part of the wave (cross-ref against Phase 3a's cloud catalog).

**Watch out for:**
- Coordinate frame conversion (Galactic → ICRS).
- The wave extends across ~3 kpc, well past the 1.25 kpc Edenhofer
  volume; the spine itself is fine to render outside the dust grid,
  it just won't have associated dust at its extreme ends.

**Estimate:** 2–4 hours.

---

## Future feature backlog (post-ISM)

Captured during this session for after the ISM roadmap above lands.
These are *not* immediate next steps — surface them when the user is
ready to plan post-ISM work, not before. Full notes in
`~/.claude/projects/-Users-alexm-github-alexmensch-starfield/memory/project_future_features_backlog.md`:

- Confirmed exoplanets overlaid on host stars (NASA Exoplanet Archive)
- Real-time solar-system body positions (JPL Horizons / VSOP87)
- Voyager 1 & 2 (and Pioneer / New Horizons) interstellar probe positions
- Oort cloud — translucent shell, ~2,000–200,000 AU
- Planetarium / "sky from here" mode — view the sky from any star
- Galactic-plane reference grid + "Galactic centre" arrow

---

## Other open items

- **Rectangular block artifact** in the default star render
  (`memory/project_rectangular_blocks_todo.md`) — pre-existing, unrelated
  to ISM work, debug after ISM lands.

---

## How to start a session against one of these

A self-contained prompt for a future Claude session looks something like:

> Read `NEXT_STEPS.md` and `CLAUDE.md`. We're tackling **[phase name]**.
> Don't worry about the other phases. Walk me through the plan before
> writing code, and let's stick to the realism-first / visibility-by-control
> default behaviour the rest of the app uses.

Then paste or reference the relevant section above as context.
