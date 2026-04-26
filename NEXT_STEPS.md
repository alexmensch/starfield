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
- Phase 4c: Galactic reference system (always-on disc + toggleable sphere/arrows)
- Phase 5: Milky Way analytic background
- Phase 6: Realism indicator + per-star dust slab fallback
- Phase 7: ATHYG `reduced_m12` catalog upgrade
- Phase 8: Star chart mode
- Phase 9: Local-sky camera mode (depends on 5 + 8)
- Phase 10: Wander mode (autonomous gravity-field camera)
- Phase 11: Exoplanets around host stars
- Phase 12a: Solar-system layer (time scrubber + planets + heliopause + scale rings)
- Phase 12b: Deep-space probes (depends on 12a)

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

## Phase 4c: Galactic reference system

**Goal:** orient the user against the Milky Way's geometry. The ATHYG
catalog is heavily Sol-biased — when zoomed out, the local clump gives
no sense of scale relative to the full galaxy. Three reference layers
fix that:

1. **Galactic disc outline** — *always on*, fades in as the camera
   pulls away from Sol. Anchors the local star clump's scale against
   the galaxy.
2. **Galactic coordinate sphere** — toggleable. b/l grid centred on
   the camera, fixed "sky" feel.
3. **Sol + Galactic Centre arrows** — toggleable with the sphere.
   Two 3D arrows from the focused star (or `controls.target`) pointing
   at Sol and the Galactic Centre, with distance labels.

Per user direction, the sphere and arrows share **one** FilterState
toggle (panel is already crowded; UX redesign deferred to a separate
session). The disc is not toggleable — it's the orientation primitive
the catalog itself was missing.

**Shared coordinate frame:** `src/client/galactic-coords.ts` exports

- `GAL_TO_ICRS` — single `THREE.Matrix4` rotation built from the J2000
  constants (galactic north pole at RA=192.85° / Dec=27.13°; galactic
  centre at RA=266.40° / Dec=−28.94°).
- `GALACTIC_CENTRE_PC` — `Vector3` of the galactic centre's absolute
  equatorial position. Use `R₀ = 8.122 kpc` so the constant aligns with
  Phase 5's planned analytic background, which will reuse this module.

**Galactic disc outline (always on):**

Three line components, all positioned in absolute equatorial space
**centred on `GALACTIC_CENTRE_PC`** — Sol sits ~8 kpc out *inside* the
disc, not at its centre:

- **Midplane ring** — `LineLoop` at the galactic b=0 great circle,
  radius 15 kpc, ~128 segments.
- **Thickness rings** — two `LineLoop`s offset ±400 pc along the
  galactic z-axis, same radius. Communicates disc scale-height visually
  when viewed edge-on.
- **Bulge** — small wireframe ellipsoid (~3 kpc radius, ~1.5 kpc thick)
  at `GALACTIC_CENTRE_PC`. `WireframeGeometry(EllipsoidGeometry)` or
  three orthogonal ring loops.

All three live in a single `THREE.Group`. Geometry vertices are
pre-transformed at construction (galactic frame → ICRS via
`GAL_TO_ICRS`, plus offset by `GALACTIC_CENTRE_PC`) so they live in
absolute equatorial space. Per frame:

```
discGroup.position.copy(worldOffset).clone().negate()
```

Don't `.negate()` `worldOffset` directly — it mutates in place and
breaks every other consumer.

`renderOrder = -1`, `depthWrite = false`, `depthTest = true` — close
stars correctly occlude. `LineBasicMaterial`, warm amber stroke
(suggest `#a08660`), default opacity tuned by zoom (below).

**Zoom-based opacity** smoothsteps between *fully transparent at
≤500 pc from Sol* and *full opacity at ≥5 kpc from Sol*. "Distance
from Sol" is `||camera.position + worldOffset||`, computed in JS
float64 each frame. Disc is invisible during typical local browsing
(where it'd just be visual noise) and gradually reveals as the user
zooms out enough to need the orientation.

**Galactic coordinate sphere (toggleable):**

Single FilterState boolean `showGalacticOverlays` (default off; URL
param `gov=1`) gates sphere + arrows together.

- Galactic equator (b=0) — slightly thicker / brighter than the rest.
- Latitude circles at b = ±30°, ±60°.
- Meridian half-circles every 30° of l (12 meridians, pole to pole).
- Pole markers (small crosses) — include unless they read as visual
  clutter during testing; trivial to drop.

`THREE.LineSegments` with vertices baked in galactic frame and rotated
to ICRS via `GAL_TO_ICRS` at construction. Sphere radius = 50 kpc fixed
(well under camera far = 200 kpc, so safe at any zoom).

Sphere position **tracks `camera.position`**, not `controls.target` —
the sphere is conceptually "the sky from here" and a sky moves with the
observer. This sidesteps the warp-start retarget snap noted in
CLAUDE.md "Scale bar smoothness".

**Sol + Galactic Centre arrows (toggleable with sphere):**

Origin = focused star's local-frame position via `starLocalPosition(focusedIdx)`
when focused, else `controls.target`. Recompute each frame — origin
moves with focus, warp, and pan.

- **Sol arrow** — direction in local frame =
  `(−worldOffset − origin).normalize()`. Length scales with current
  orbit radius: `arrowLen = clamp(0.08 × controls.getRadius(), 0.5 pc, 1000 pc)`.
  Stroke = warm yellow (consistent with Sol's rendering). **Hidden when
  the focused star is Sol** (per user direction — pointing at yourself
  is silly).
- **GC arrow** — direction = `(GALACTIC_CENTRE_PC − worldOffset − origin).normalize()`.
  Same length scaling. Stroke = neutral white-cyan to distinguish from
  the Sol arrow.

Use `THREE.ArrowHelper` (built-in shaft + cone). Both
`renderOrder = -1`, `depthWrite = false` — always behind stars.

Distance labels follow the existing SVG-overlay pattern — project
arrowhead tip through camera per frame, reuse `distance-vector-overlay.ts`'s
projection + edge clamping. `fmtDist` from `distance-util.ts` for
unit-aware formatting. **Not Three.js Sprites** — keeps font rendering
consistent with every other overlay text element.

**Galactic Centre is a directional indicator only.** Per user direction:
not added to the search index, not a warp destination, no `Sgr A*` /
"Galactic Centre" search entry. Just an arrow that helps the user
orient.

**Mono mode (preview of Phase 8 chart aesthetic):**

Mono mode currently swaps stars to `MultiplyBlending` for an ink-on-paper
look against the light canvas. Anticipating Phase 8's full chart mode,
the galactic reference layers in mono should look like markings on a
classical paper star chart — **dark thin solid lines on cream, no
transparency, no additive blending**:

- Disc / sphere / arrow strokes swap to a dark grey (suggest `#3a3530`)
  at full opacity.
- `LineBasicMaterial.blending = NoBlending`, `transparent = false`,
  `opacity = 1`.
- **Disc fade-by-zoom is disabled** in mono — chart reference layers
  don't fade in/out. Disc draws at full opacity always.
- Arrow labels swap to dark text matching mono body copy.

Hook into the same code path that swaps the star materials when mono
toggles.

**Hidden during warp:**

Per user direction, warp is a "fun mode" — overlays distract. The
existing `body.warping` CSS class hides SVG overlays; extend the same
warp begin/end transitions to set `discGroup.visible = false`,
`gridSphere.visible = false`, `solArrow.visible = false`,
`gcArrow.visible = false` on warp begin and restore on warp end. SVG
arrow labels follow the existing `body.warping` rule — no new CSS
needed beyond confirming they're inside the SVG overlay element that
already gets hidden.

**Files:**

- New: `src/client/galactic-coords.ts` — `GAL_TO_ICRS` + `GALACTIC_CENTRE_PC`.
- New: `src/client/galactic-disc.ts` — disc group + zoom-based fade.
- New: `src/client/galactic-grid.ts` — coordinate sphere, camera-tracking.
- New: `src/client/galactic-arrows.ts` — Sol + GC arrows + SVG labels.
- Touch: `starfield.ts` — instantiate, scene attach, `onFrame` updates,
  mono-mode material swap, warp visibility toggle.
- Touch: `controls.ts` — single checkbox for `showGalacticOverlays`,
  reverse-sync in `syncFromFilter`.
- Touch: `url-state.ts` — `gov` field, default-compressed.
- Touch: `index.html` — checkbox markup in the panel.

**Watch out for:**

- **Floating origin**: the disc and the GC-arrow direction are
  anchored in absolute space; both need `−worldOffset` per frame. The
  sphere is camera-attached so it's already in the local frame and
  needs no offset.
- **`worldOffset` mutation**: use `.clone().negate()` — never call
  `.negate()` on `worldOffset` itself.
- **`camera.up` two-finger roll**: galactic geometry is defined in
  equatorial coords, independent of `camera.up`, so it stays correctly
  oriented through any roll.
- **SVG label z-order**: arrow labels render above the canvas (SVG is
  always above WebGL — see CLAUDE.md "Constellation stick-figure overlay").
  No disc-mask cutout is needed for labels at this scale; they're
  intentionally above stars.
- **Phase 5 dependency**: when Phase 5 (Milky Way analytic background)
  lands it will also need `GAL_TO_ICRS`. Keep `galactic-coords.ts`
  minimal and stable so Phase 5 inherits it directly.
- **Disc fade threshold tuning**: 500 pc / 5 kpc is the suggested
  smoothstep range. The Local Bubble is ~200 pc and the Edenhofer
  voxels reach 1.25 kpc, so by 500 pc the user is already past the
  high-density regime. Adjust if it reveals too early/late in testing.

**When done, also:**
- Delete the `Milky Way galactic-plane reference grid` line from the
  `Things deliberately kept out` list in `CLAUDE.md` — it's no longer
  kept out.
- Add a brief `Galactic reference system` section to `CLAUDE.md`
  alongside the dust-extinction notes, describing the always-on-disc
  vs toggleable-sphere/arrows split, mono-mode chart treatment, and
  the `galactic-coords.ts` shared module so Phase 5 leverages it.

**Estimate:** 1 day. Three small modules + mono-mode adaptation + warp
hide. Math is one rotation matrix and three Three.js primitives —
straightforward; most of the time is line-style tuning (opacity,
stroke colours, fade thresholds) and getting the mono "paper chart"
feel right.

---

## Phase 5: Milky Way analytic background

**Goal:** physically-grounded Milky Way band visible from any 3D
position. Adds an analytic stellar-density model evaluated per-fragment
in a fullscreen raymarch, integrated with the existing dust voxels.
Makes "see the sky from anywhere" a meaningful feature instead of a
sparse-points view.

**Why analytic, not panoramic:** painted sky maps (Gaia/2MASS/WISE) are
Earth-frame and can't reproject from arbitrary positions. Analytic
density evaluates from anywhere by construction.

**Model:**
- **Jurić et al. 2008** (ApJ 673, 864) — thin disk + thick disk +
  oblate power-law halo as closed-form ρ(R, Z). Constants baked into
  the shader; no dataset to load.
- **McMillan 2017** triaxial bulge term — adds the Sagittarius core
  peak that Jurić omits. Without it the band looks weirdly uniform.
- **Drimmel & Spergel-style analytic dust slab** — exp(−|z|/h) with
  h ≈ 125 pc in the Galactic frame, used everywhere beyond the
  Edenhofer voxel AABB so Sagittarius-direction extinction looks right.
- **Existing Edenhofer voxels** dominate inside their AABB; smoothly
  hand off to the slab at the boundary.

**Coordinate transform (per ray, in shader):**
ICRS Cartesian → Galactic Cartesian via fixed `mat3 R_ICRS_to_GAL`
constant → galactocentric cylindrical with R₀ = 8.122 kpc, z₀ = 20.8 pc
baked.

**Population colours:** density × luminosity-weighted colour per
component, summed:
- Thin disk: warm yellow-white
- Thick disk: redder (old, metal-poor)
- Halo: orange-yellow (K-giant dominated)
- Bulge: similar to halo
Tune by eye against the real Milky Way during shader iteration.

**Render pipeline:**
- Fullscreen pass at `renderOrder = -1`, no depthTest/Write, before
  both star passes.
- Renders into a half-res `WebGLRenderTarget`, bilinear upscale, then
  star passes blend over at full res.
- ~32 log-distributed raymarch steps. Inside dust AABB, sample the 3D
  texture per step; outside, evaluate the slab.
- **Startup FPS probe**: time two full frames; if under ~30 fps,
  default the toggle off but keep it user-enableable.

**Floating origin:** compose `worldOffset + camera.position` in JS
float64, pass as a `vec3` uniform per frame. Float32 has sub-metre
precision at kpc scale — fine for density evaluation.

**UI / state:**
- Panel checkbox "Show Milky Way background" (default on, perf-probe
  override).
- URL-state field (omit when default-on).
- **Chart mode disables this pass** (see Phase 8) — chart shows
  discrete named objects, not background glow.

**Files:**
- New: `src/client/shaders/milkyway.{vert,frag}.glsl`.
- Touch: `starfield.ts` (pass, render target, perf probe, uniforms),
  `controls.ts` (checkbox), `url-state.ts` (toggle field).

**Watch out for:**
- `memory/feedback_raymarch_for_nebulae.md` does **not** apply: that
  warned about banding from voxel sampling at far zoom. Jurić density
  is smooth analytic; voxel sampling stays bounded inside the
  well-resolved AABB. Document this in the shader comment so a future
  reader doesn't read the memory and abandon the work.
- Dust voxels are geocentred on Sol in absolute world coords. From far
  away, they correctly represent Sol-local dust but not dust near the
  camera. The slab fallback partially fixes this — see Phase 6.
- Spiral-arm overdensities (Reid et al. masers) are out of scope. Add
  later only if the smooth band looks too uniform.

**Enables:** Phase 9 (Local-sky camera mode) becomes UX-only once this
phase + Phase 8 land.

**Estimate:** 1–2 days, most of it shader iteration on colour balance
and slab/voxel handoff.

---

## Phase 6: Realism indicator + per-star dust slab fallback

**Goal:** be honest about where the high-fidelity dust data ends
without restricting where the user can travel. Free travel + clear
information.

Two parts:

**Part 1 — slab fallback for per-star extinction.** Today
`star.vert.glsl` raymarches camera→star through the Edenhofer voxel
volume only. Lines of sight that exit the AABB get zero attenuation
beyond — wrong direction at the edge. Add the same analytic dust slab
Phase 5 introduces (exp(−|z|/h), h ≈ 125 pc, Galactic frame) and
integrate it for the segment outside the voxel AABB. Per-star
extinction then has a sensible value everywhere.

If Phase 5 lands first, the slab term is already shared shader code;
this phase just calls it from the per-star shader too.

**Part 2 — high-fidelity-volume status indicator.** A small chip on
the bottom row of the UI (next to the scale bar, in `.ui-bottom`) that
toggles between:
- "high-fidelity dust volume" (camera world-position inside the
  Edenhofer AABB)
- "outside dust volume" (outside)

Optional toggle in the panel: "Show dust volume boundary" — a faint
translucent sphere mesh of radius ~1.25 kpc at world origin. Off by
default (subtle by design). When on, gives a 3D sense of where the
high-fidelity data ends.

**Files:**
- Touch: `src/client/shaders/star.vert.glsl` (call the shared slab
  function beyond AABB), `starfield.ts` (chip element + boundary
  mesh), `index.html` (chip markup), `styles.css` (chip styling),
  `controls.ts` (boundary toggle), `url-state.ts` (boundary toggle).

**Watch out for:**
- The chip should be unobtrusive — same visual weight as the scale
  bar, not a banner. If users want detail they'll toggle the boundary
  sphere.
- Slab evaluation in Galactic frame requires the same ICRS→Galactic
  rotation as Phase 5. Keep it as one shared shader function so both
  phases use identical maths.

**Estimate:** 3–5 hours, mostly UI polish.

---

## Phase 7: ATHYG `reduced_m12` catalog upgrade

**Goal:** populate the resolved-discrete star layer at intermediate
travel distances (50 pc – ~kpc from Sol), where `classic_ids` runs out
of entries because faint distant stars rarely have classical
designations.

Complements Phase 5. Phase 5 fills the diffuse glow at distance; this
phase fills the point sources at intermediate range. Together they
make travel away from Sol feel populated at every scale.

**Data source:** ATHYG v3.3 `reduced_m12` subset — apparent magnitude
≤ 12, ~2M stars. Same source repository as the current
`classic_ids`: https://codeberg.org/astronexus/athyg

**What changes:**
- `data/athyg_33_classic_ids.csv` → replace with
  `data/athyg_33_reduced_m12.csv` (~400 MB CSV, LFS).
- `scripts/build-catalog.ts` reads the bigger CSV. Same field
  mapping; same 40-byte stride; same sort-by-absmag pipeline.
- Output `public/catalog.bin` grows from ~12 MB to ~80 MB
  (~20 MB gzipped).
- `search-index.json` content unchanged — only stars with classical
  identifiers go in the search index. The added ~1.7M nameless stars
  contribute to rendering only.
- GCVS variability cross-match picks up significantly more variables
  (more HIP/HD entries are present in the bigger catalog).
- Geometric binary inference runs over more stars; expect substantially
  more pairs found, but the `BINARY_MAX_SEP_PC = 0.005 pc` threshold
  keeps the count visually relevant.

**Watch out for:**
- Initial catalog download grows from ~3 MB gzipped to ~20 MB gzipped.
  Significant for first-load on slow connections. Worth measuring
  whether progressive load (render available chunks while the rest
  streams) is needed.
- 2M instanced quads at 60 fps needs profiling on modest hardware
  (integrated GPUs, mobile). The two-pass split already handles
  overdraw efficiently, but instance-attribute memory grows linearly.
  If there's a perf cliff, fall back to `reduced_m10` (~350k stars)
  as a smaller cut.
- `classic_ids` ⊂ `reduced_m12` in practice (stars with classical IDs
  are almost all brighter than mag 12 from Earth), but verify a few
  iconic targets (Proxima, Barnard's Star, Sol-itself) survive the
  switch.
- Constellation index assignment per star uses the AT-HYG `con` column
  unchanged — works for the bigger catalog out of the box.

**Estimate:** half-day for the build pipeline change + verification
runs. Most of the time goes to catalog regeneration and perf testing.

---

## Phase 8: Star chart mode

**Goal:** present the catalog as a real star chart — named stars
labelled, constellations drawn out, named nebulae/clouds with labels.
**Replaces** the current mono toggle. Aesthetic close to a printed
astronomical chart.

**The rule:** chart shows discrete *named* objects only. No diffuse
background, no unresolved stellar density, no unnamed nebulae.

**What's drawn in chart mode:**
- Stars with proper names, Bayer designations, or Flamsteed numbers —
  labelled with their primary identifier near the glyph.
- Constellation stick figures — always on (not just when one is
  selected, as today).
- Constellation Latin names — labelled at the brightness-weighted
  centroid.
- Named nebulae from Phase 3b — drawn as their procedural shape with
  a label.
- Distance vector and focus ring — keep their current behaviour.

**What's hidden in chart mode:**
- Phase 5 Milky Way background (already noted there).
- Unnamed stars (most of the `reduced_m12` set added in Phase 7).
- Unnamed nebulae or clouds.
- Phase 4a Local Bubble translucent mesh.
- Phase 4b Radcliffe Wave spine.

**Relationship to existing mono mode:**
The current "mono" toggle becomes "chart". Underlying paper-aesthetic
plumbing (MultiplyBlending, depth disabled, light canvas) is reused;
chart mode adds the labels and always-on constellations on top. There
is no separate intermediate mode — you're either in default
(physical-realism) or chart (named-objects).

**Label density:**
Discrete-step density slider — at the lowest, only proper names plus
the brightest 1–2 Bayer stars per constellation; at the highest, all
named stars. Default: medium. Avoids label collisions in zoomed-out
views.

**Files:**
- Touch: `src/client/theme-toggle.ts` (rename concept from mono to
  chart), `starfield.ts` (label rendering for stars + nebulae +
  constellation names), `constellation-overlay.ts` (always-on path
  generation when chart mode active), `styles.css` (label
  typography), `index.html` (label density slider), `url-state.ts`
  (chart mode + density).

**Watch out for:**
- Label collision is the hard UX problem. Use a simple greedy
  reject-on-overlap pass each frame, prioritised by star brightness.
- Label readability on the paper background: thin dark text with no
  halo (chart mode is high-contrast already).
- Chart mode should still respect the camera state — labels for stars
  outside the current view-frustum are skipped.

**Estimate:** 1 day, label collision tuning is most of it.

---

## Phase 9: Local-sky camera mode

**Status:** UX-only, depends on Phase 5 (Milky Way background) +
Phase 8 (chart mode) shipping first. This was the "Planetarium / sky
from here" item in the future feature backlog; promoting it because
Phase 5 makes it newly meaningful.

**Goal:** "what does the sky look like from this star?" Park the
camera at a focal star with a wide FOV and free look-around (no orbit).
Phase 5 draws a physically-correct Milky Way from the new viewpoint
automatically since the analytic glow evaluates from any 3D position.

**Behaviour:**
- Triggered by a button in the panel ("Local sky") or a keyboard
  shortcut.
- Camera position: at the focal star's coordinates. The focal star
  itself is hidden — you're standing on/near it, not looking at it.
- Camera FOV widened to ~110° from the default ~50° — approximates a
  planetarium feel.
- Controls switch from `TrackballControls` orbit to a custom
  look-around mode (mouse drag rotates the camera in place, no
  translation). Pinch/scroll adjusts FOV instead of distance.
- Exit returns to orbit mode at a sensible distance from the star.

**What naturally falls out of being in this mode:**
- The Milky Way band looks correct from this viewpoint by Phase 5
  construction. From the LMC you'd see the disk on one side; from
  inside the Galactic plane far from Sol you'd still see a band but
  centred differently.
- All catalog stars render in their correct apparent positions and
  brightnesses from the new origin.
- Per-star extinction (Phase 1 + Phase 6 slab) gives correct
  reddening/dimming for the new line-of-sight.
- Constellations from Earth still look like constellations only when
  near Sol; from far stars they reshape correctly because the lines
  are 3D.

**Files:**
- New: `src/client/local-sky-controls.ts` — custom look-around
  controls.
- Touch: `starfield.ts` (mode switch, camera FOV, focal-star hide),
  `controls.ts` (toggle button), `url-state.ts` (mode flag).

**Watch out for:**
- Switching controls implementations cleanly. TrackballControls
  manages `camera.up` and matrix updates; the new controls need to
  preserve `camera.up` semantics for two-finger roll to keep working.
- The focal star occupying the camera position means hiding it needs
  care — simplest: filter it out of both star passes when in this
  mode.
- Optional: a faint cardinal-direction overlay (Galactic l/b ticks).
  Defer to a future tune-up — the Milky Way band itself orients you.

**Estimate:** 4–6 hours after Phases 5 and 8 land.

---

## Phase 10: Wander mode

**Status:** Standalone exploration feature. No dependencies on other
phases — can ship any time the catalog format is stable.

**Goal:** the camera behaves as a particle moving through a
precomputed gravitational field derived from the star catalog. Hit
`G`, the camera drifts autonomously through the local stellar
neighbourhood, following gradients of stellar mass density. Click /
`Esc` / `G` again to exit, leaving the camera wherever it ended up.
Naturalistic exploration without steering — dense clusters pull the
camera in, ridges deflect it.

Two parts: (1) an offline precompute script that builds a
`gravity.bin` asset, (2) runtime integration in `starfield.ts`
following the warp pattern.

### Part 1: `scripts/build-gravity.ts`

**Bounding volume.** Read star positions from `catalog.bin` (inline a
small reader, same approach `verify-catalog.ts` uses — no need to
factor a shared module). Compute max distance from Sol across all
stars, call this `R`. Grid is a cube of side `2R` centred at the
origin, voxel side ≈ `2R / 128`. Voxel centres outside the bounding
sphere of radius `R` store a zero gradient — no extrapolation past
the catalog.

**Grid.** 128³ voxels → ~25 MB output (3 × float32 per voxel). Coarse
relative to inter-star spacing near Sol (~1 pc), but that's
desirable — wander should feel like ridges and basins of density,
not orbital snap-ins on individual stars.

**Mass proxy.**
```
luminosity = 10 ^ ((4.74 − absmag) / 2.5)
mass       = max(0, luminosity ^ MASS_EXPONENT)
```
Default `MASS_EXPONENT = 0.5`. The physical mass-luminosity relation
gives ~0.286, but 0.5 keeps dim stars from being completely
swamped — a tuning lever, not a physics value. Document the physical
reference in the comment.

**Gradient computation.**
```
for each voxel center p:
  for each star i:
    r_vec   = star_position − p
    dist_sq = dot(r_vec, r_vec) + SOFTENING²
    g      += mass_i × r_vec / (dist_sq × sqrt(dist_sq))
```
Vectors are NOT normalised — magnitude encodes field strength.

**Performance.** 128³ × 313k ≈ 660 G ops. Run in Node `worker_threads`,
chunked one Z-slice per task, target <5 min on a modern laptop.
Optional optimisation: per-voxel cull stars beyond e.g. 500 pc
(at softening 2 pc, a star at 500 pc contributes ~1/250000 the
weight of one at 1 pc). Worth measuring before adding — could shave
an order of magnitude.

**Output `public/gravity.bin`.**
```
Header (32 bytes):
  0–3    ASCII "GRV1"
  4–7    uint32 grid dimension N (128)
  8–11   float32 grid half-extent in parsecs (= R)
  12–15  float32 softening value used (informational)
  16–19  float32 mass exponent used (informational)
  20–31  reserved (zeros)

Body:
  N³ records × 12 bytes — float32 x, y, z gradient
  Index order: x + y*N + z*N*N (x varies fastest)
```

Add to `.gitignore` alongside `catalog.bin`. Add `build:gravity` to
`package.json`, chained after `build:catalog` in both `dev` and
`build` scripts (depends on `catalog.bin` existing). Use the same
`isUpToDate` pattern as `build-catalog.ts`, gated on `catalog.bin`
mtime + the script's own mtime + the build-baked constants.

### Part 2: `src/client/gravity-loader.ts`

Following `catalog-loader.ts` structure:
- Fetch `gravity.bin`, validate magic + version.
- Expose `gridN`, `halfExtent`, `softening`, `massExponent`,
  `gradients: Float32Array` (length `N³ × 3`).
- Export `sampleGradient(absolutePos: THREE.Vector3): THREE.Vector3`
  with trilinear interpolation. Return zero for positions outside the
  bounding sphere.

Load in parallel with `catalog.bin` and `search-index.json` in
`main.ts`.

### Part 3: Wander state in `starfield.ts`

**State machine.** Add `'wander'` mode alongside warp. Same disable
pattern: `controls.enabled = false`, `body.classList.toggle(
'wandering', true)`, `pointerup` short-circuited, URL writer skips
camera-hash updates while active.

Entry: keyboard shortcut `G` (verified free; `W` is warp; `Esc` /
`Space` skip warp). Exit: any `pointerdown`, `Esc`, or `G` again.

**Focus interaction (option (a)).** Activating wander **unfocuses**
any current focal star (calls `setFocus(null)`), which also recentres
the floating origin to Sol. The wander particle then operates in a
clean absolute frame for the duration of the mode.

**Coordinate-frame correctness — CRITICAL.** The gradient field is
in absolute Sol-centred coordinates, matching `catalog.positions`.
After unfocus on entry, `worldOffset = (0, 0, 0)` and
`camera.position` is in absolute space, so initial sampling is
direct. But once the wander loop calls `recenterOrigin(...)` for
precision (see below), `worldOffset` becomes non-zero and
`camera.position` shifts toward zero. From that point all gradient
samples must be at `camera.position + worldOffset`, never at
`camera.position` alone. Same for the lookahead and any read-back.
This is the single most common way for the field to silently drift —
call it out in code comments around the sampling.

**Particle state.**
```typescript
private _wanderActive = false
private _wanderVelocity = new THREE.Vector3()
private _wanderDistanceSinceRecenter = 0
```

**Per-frame update `updateWander(dt)`.**
1. `samplePos = camera.position + worldOffset`.
   If `velocity.lengthSq() > ε²`, `samplePos += normalize(velocity)
   × WANDER_LOOKAHEAD_PC`.
2. `accel = sampleGradient(samplePos) × WANDER_GRAVITY_SCALE`.
3. `velocity += accel × dt × WANDER_SIM_TIME_SCALE`.
4. `velocity *= pow(WANDER_VELOCITY_DAMPING, dt × 60)` — anchors the
   "0.99 per frame" lever to 60 fps so feel is frame-rate
   independent.
5. Clamp `|velocity| ≤ WANDER_MAX_SPEED_PC_PER_S`.
6. `step = velocity × dt × WANDER_SIM_TIME_SCALE`.
   `camera.position += step`. `controls.target += step` (keep target
   moving with camera so orbit orientation is preserved on exit).
7. `_wanderDistanceSinceRecenter += step.length()`. If it crosses
   ~1 pc, call `recenterOrigin(camera.position + worldOffset)` and
   reset the counter. Keeps float32 precision good when wandering
   far from Sol.

**Initial kick (entry).** Field-scaled with a floor — guarantees
motion even in a void, and scales naturally with `GRAVITY_SCALE`
without a separate retune.
```
g         = sampleGradient(camera.position + worldOffset)
v0        = max(WANDER_KICK_FLOOR_PC_PER_S,
                WANDER_KICK_TIME_S × |g| × WANDER_GRAVITY_SCALE)
direction = normalize(controls.target − camera.position)
            (fallback: +Z if degenerate, never normalise zero)
_wanderVelocity = direction × v0
```

**Tuning levers.** Define as named constants at the top of the
wander section. Comments must call out runtime vs build-baked:
- `WANDER_SOFTENING_PC = 2.0` — **build-baked**; must match
  `build-gravity.ts`. Changing requires regenerating `gravity.bin`.
- `WANDER_MASS_EXPONENT = 0.5` — **build-baked**; same constraint.
- `WANDER_GRAVITY_SCALE = 0.1` — runtime.
- `WANDER_VELOCITY_DAMPING = 0.99` — runtime; interpreted as per-
  frame at 60 fps, applied as `pow(damping, dt × 60)`.
- `WANDER_MAX_SPEED_PC_PER_S = 20.0` — runtime.
- `WANDER_SIM_TIME_SCALE = 5.0` — runtime.
- `WANDER_LOOKAHEAD_PC = 2.0` — runtime.
- `WANDER_KICK_TIME_S = 2.0` — runtime; "free-fall seconds" worth of
  initial kick velocity.
- `WANDER_KICK_FLOOR_PC_PER_S = 1.0` — runtime; absolute floor so
  voids still produce motion.

### Files

- New: `scripts/build-gravity.ts`, `src/client/gravity-loader.ts`.
- Touch: `starfield.ts` (mode + state + `updateWander` + key
  handler), `main.ts` (parallel load, pass loader to `Starfield`),
  `package.json` (script + chain), `.gitignore`
  (`/public/gravity.bin`), `styles.css` (optional `body.wandering`
  style — e.g. cursor change or subtle vignette to signal "you are
  not driving").
- After landing, update `CLAUDE.md`: extend the floating-origin
  section with the "sample in absolute frame" contract and add a
  new "Wander mode" section.

### Watch out for

- Floating-origin sampling — covered above; single biggest landmine.
- Trilinear interpolation must clamp grid indices: a fractional
  voxel near the cube edge can land at `N − 1 + ε`; `floor` gives
  `N − 1` but `floor + 1` would read past the end.
- Unfocus-on-entry is intentional (option (a)). Don't be tempted to
  "preserve focus for the panel" — focus drives `worldOffset` and
  decoupling them is messy.
- Kick direction normalises `target − position`; defensively guard
  the degenerate case (target == position) with a fixed fallback
  vector so we never normalise zero.
- URL-sync `onFrame` skip-while-warping needs to extend to wander —
  we don't want intermediate poses serialised.
- 25 MB `gravity.bin` is a meaningful download; serve gzipped (Vite
  default for `public/` handles this) and load eagerly initially.
  Revisit lazy-load only if startup latency complaints surface.

### Estimate

1–1.5 days. Most of it is build-script worker setup plus tuning the
nine levers to a feel that's neither stuck-on-Sol nor slingshot-out-
of-the-catalog. The `starfield.ts` integration is small and follows
the warp pattern.

### Deliberately excluded

- UI controls for the tuning levers — constants in source only.
- A wander button (keyboard shortcut only).
- Apparent-magnitude or visibility input to steering — field is
  mass × position only.
- Any changes to dust / nebula rendering.

---

## Phase 11: Exoplanets around host stars

**Status:** Standalone. No phase dependencies — could ship anytime.

**Goal:** when the user zooms into a host star with confirmed
exoplanets, render them as orbiting bodies around the host with
realistic (where known) sizes and orbital geometry. Star-centric UX:
no search-by-planet-name, no planet labels in the open field —
exoplanets are a nice "you see them when you visit" reward.

Three parts: (1) build pipeline ingests NASA Exoplanet Archive data
and emits a flag in `catalog.bin` + a lazy-load `exoplanets.json`,
(2) client loader caches the lazy-load file on first focus of any
host star, (3) rendering layer draws planets + orbital rings around
the focused host. This phase fully nails Parts 1 and 2; Part 3 is
described enough to drive the implementation but specific visual
choices (orbit ring style, planet disc shading, null-radius
indicator) are deferred to whoever picks this up.

### Part 1: Data ingest in `scripts/build-catalog.ts`

**Source.** NASA Exoplanet Archive `pscomppars` table (planetary
system composite parameters — canonical "best values per planet"
view). One-off download, committed via Git LFS:

```bash
curl -o data/exoplanets_nasa.csv \
  "https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=SELECT+pl_name,hostname,hip_name,hd_name,ra,dec,sy_dist,pl_rade,pl_radj,pl_orbsmax,pl_orbper,pl_eccen,pl_bmasse,sy_pnum,st_teff,st_rad,st_lum&FORMAT=csv&TABLE=pscomppars"
git lfs track "data/exoplanets_nasa.csv"
git add .gitattributes data/exoplanets_nasa.csv
```

**Parser.** New `parseExoplanetData(csvPath)` alongside the GCVS
parsers. Returns `Map<hostname, ExoplanetSystem>` with planets
already sorted by `semi_major_axis_au` ascending (nulls last).

```typescript
interface ExoplanetSystem {
  hostname: string;
  hip: number | null;       // parsed from "HIP 12345"
  hd:  number | null;       // parsed from "HD 12345"
  gl:  string | null;       // Gliese designation if hostname is one
  ra: number | null; dec: number | null; dist_pc: number | null;
  star_teff: number | null; star_rad: number | null; star_lum: number | null;
  n_planets: number | null;
  planets: ExoplanetRecord[];
}

interface ExoplanetRecord {
  name: string;
  radius_earth: number | null;       // null = unknown — render with default + indicator
  radius_jupiter: number | null;
  mass_earth: number | null;
  semi_major_axis_au: number | null;
  period_days: number | null;
  eccentricity: number | null;       // null in NASA data when poorly constrained;
                                     // renderer should default to 0 (circular)
}
```

Empty CSV cells → `null`. Don't filter null-radius planets —
rendering layer handles that case.

**Cross-match — HIP + HD + Gliese.** After the existing post-sort
`hipToIndex` map is built, build the symmetric reverse maps:

```typescript
const exoByHip = new Map<number, ExoplanetSystem>();
const exoByHd  = new Map<number, ExoplanetSystem>();
const exoByGl  = new Map<string, ExoplanetSystem>();   // normalised "Gl 551" form
```

Then walk the sorted catalog, matching HIP first, HD second, Gliese
third (the catalog has a `gl` field; AT-HYG carries it). Result:
`exoplanetsByCatalogIdx: Map<recordIdx, ExoplanetSystem>`. Adding
Gliese over the original HIP+HD-only plan catches a few high-profile
M-dwarf hosts (Proxima = `Gl 551`, Lacaille 9352 = `Gl 887`, etc.).

**Expected match rate is ~30–50%** of NASA's ~5,800 systems. Bright-
star hosts (Tau Ceti, 51 Peg, Upsilon And, Proxima, Trappist-1)
match cleanly via HIP/HD/Gliese; faint Kepler/TESS hosts (Kepler-N,
TOI-N, KOI-N) typically don't carry any classical designation, so
they're invisible to this cross-match. Phase 7 (`reduced_m12`
catalog upgrade) does **not** lift this — the limitation is the
designation space, not catalog magnitude depth. Document in the
build log and mention in `CLAUDE.md` after landing so future Claude
sessions don't chase this as a bug.

**Catalog v3 → v4.**
- Bump the `version` uint32 in the header from `3` to `4`.
- Set flag bit 3 (`0x08`, "hasPlanet") on host stars during the
  record-writing loop. Existing bit 4 (`0x10`, isBinaryPrimary)
  unchanged.
- 40-byte stride is preserved — no struct field changes.
- Reader hard-requires v4 (no transitional v3 acceptance). General
  principle: regenerate from source whenever upstream data changes;
  binaries / indices are cheap.

**Emit `public/exoplanets.json`.** After all catalog records are
written, emit a record-index-keyed JSON of the per-system data:

```typescript
const out: Record<string, {
  hostname: string;
  dist_pc: number | null;
  star_teff: number | null;
  star_rad: number | null;
  star_lum: number | null;
  n_planets: number | null;
  planets: ExoplanetRecord[];
}> = {};
for (const [idx, system] of exoplanetsByCatalogIdx) {
  out[idx] = { hostname: system.hostname, dist_pc: system.dist_pc,
               star_teff: system.star_teff, star_rad: system.star_rad,
               star_lum: system.star_lum, n_planets: system.n_planets,
               planets: system.planets };
}
fs.writeFileSync('public/exoplanets.json', JSON.stringify(out));
```

Add `public/exoplanets.json` to `.gitignore` alongside the other
generated files. Add `data/exoplanets_nasa.csv` to the `isUpToDate`
inputs so a NASA refresh triggers a rebuild.

Expected size: ~5,800 planets × ~200 bytes ≈ 1.2 MB raw, ~300–500 KB
gzipped. Negligible — Vite's static-asset gzip on Cloudflare handles
the wire compression. Eager-load on first need is fine.

### Part 2: Client loader in `src/client/exoplanet-loader.ts`

New module. Single in-memory cache, single inflight-promise dedupe:

```typescript
interface ExoplanetData { /* matches the JSON shape above */ }

let cache: Record<string, ExoplanetData> | null = null;
let fetchPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (cache !== null) return;
  if (fetchPromise) return fetchPromise;
  fetchPromise = fetch('/exoplanets.json')
    .then(r => r.json())
    .then(data => { cache = data; });
  return fetchPromise;
}

export async function getExoplanetData(catalogIdx: number)
  : Promise<ExoplanetData | null> {
  await ensureLoaded();
  return cache?.[catalogIdx] ?? null;
}
```

Also expose `hasPlanet` on the per-record data exposed by
`catalog-loader.ts` (parse from flag bit 3).

### Part 3: Trigger + render wiring in `starfield.ts`

**Trigger.** Lazy-load fires on `setFocus(idx)` when the focused
star has `hasPlanet === true`. One fetch ever (cache is permanent
for the session); subsequent focuses on planet-bearing stars are
cache hits. Stars without planets never trigger the fetch.

```typescript
if (focusedStar.hasPlanet) {
  getExoplanetData(focusedStarIdx).then(data => {
    if (data) this.events.emit('exoplanetData', { idx: focusedStarIdx, data });
  });
}
```

Add `onExoplanetData(handler)` to the existing event bus alongside
`onFocusChange` etc.

**Render.** Out-of-scope for this phase doc to nail down — defer
the visual choices to whoever implements. Constraints to honour:
- Orbital rings drawn around the focused host using
  `semi_major_axis_au` for radius. Default `eccentricity = 0`
  (circle) when null. Rings should render in the local frame so
  floating-origin works.
- Planet body rendered with size driven by `radius_earth` (or
  `radius_jupiter` when present), scaled relative to the host
  star's `physicalRadius` so the visual ratio is roughly correct.
- **Null-radius planets are still rendered** — at a default mid-
  range size, with a visual indicator (dashed ring? `?` overlay?
  reduced opacity? — TBD). Do not filter out null-radius planets
  during preprocessing or load.
- Planets are not searchable and not labelled in the open field.
  Visible only when their host is focused. A side-panel or
  on-hover detail readout for an individual planet's stats is fair
  game.

### Files

- New: `data/exoplanets_nasa.csv` (LFS), `src/client/exoplanet-loader.ts`,
  whatever rendering modules Part 3 ends up needing.
- Touch: `scripts/build-catalog.ts` (parser + cross-match + flag +
  JSON emit + `isUpToDate`), `src/client/catalog-loader.ts`
  (hard-require v4, expose `hasPlanet`), `starfield.ts` (focus
  trigger + render integration), `main.ts` (no parallel load needed —
  loader is lazy), `.gitignore` (`/public/exoplanets.json`),
  `.gitattributes` (LFS pattern).
- After landing, update `CLAUDE.md`:
  - Binary catalog format section — document flag bit 3 and v4 bump.
  - Add a new "Exoplanets" section explaining cross-match strategy
    (HIP/HD/Gliese), expected match rate (~30–50%), and the
    Kepler/TESS-host gap that the cross-match deliberately doesn't
    chase.

### Watch out for

- `pscomppars` schema can drift if NASA changes column names. Build
  script should fail loud (not silent-null) if any expected column
  is missing from the CSV header.
- Multiple stars sharing the same HD number (composite designations,
  rare but real). First-write-wins on the reverse maps is fine but
  worth a comment so the behaviour is explicit.
- `sy_dist` (NASA) and the catalog's parallax-derived distance can
  differ slightly. For display ("distance to system: X pc") use
  `sy_dist`; for any 3D-positioning math use the catalog's position
  (more authoritative inside the local frame and consistent with
  everything else).
- Rendering must respect the floating-origin frame — orbital rings
  drawn at the host's local-frame position, not absolute. Same
  contract as constellation lines / focus ring.
- v3 → v4 hard requirement: anyone with a stale `catalog.bin` will
  get a load error. The build pipeline regenerates automatically
  via `isUpToDate`, but mention in the changelog/commit so others
  know to `rm public/catalog.bin` if they hit a magic-byte mismatch.

### Estimate

1 day for Parts 1 + 2 (data plumbing is mechanical, follows the
GCVS pattern). Part 3 (rendering) is a separate sitting — probably
half a day to a full day depending on how fancy the planet/ring
visuals get and how the null-radius indicator lands.

### Deliberately excluded

- Search-by-planet-name. Star-centric UX only — planets are a
  visit-and-discover reward, not a search target. Avoids confusing
  planet names against star names in the dropdown.
- Planet labels visible from the open starfield. Visible only when
  host is focused.
- Cross-match against TIC / KIC / Gaia DR3 IDs to capture Kepler/TESS
  hosts. The catalog doesn't carry those designations, and adding a
  parallel ID space is beyond this phase's scope. Re-evaluate if a
  future catalog upgrade brings them in.
- Apsidal motion / orbital phase animation. Static rings + static
  planet positions on the rings (or at periastron, or distributed
  by mean anomaly — a render-time choice).

---

## Phase 12a: Solar-system layer (time + planets + heliopause + scale rings)

**Status:** Standalone. Introduces the wall-clock time scrubber that
Phase 12b builds on.

**Goal:** when focused on Sol (or unfocused at Sol), render the local
solar-system context: the 8 planets in their actual at-time positions,
the heliopause boundary as an asymmetric shell, and faint reference
rings at 1 AU and 50 AU. All driven by a new `t` time variable that
defaults to the current wall-clock time and is user-scrubbable.

This is the first feature where the app cares about *actual* dates.
Existing variable-star animation continues to use its independent
cosmetic clock — `uTime` and the new `t` are orthogonal.

### The `t` time variable

Unix-seconds, double precision. Lives on the starfield filter state
alongside other filter fields. Default is `Date.now() / 1000` evaluated
at startup. URL state writes `t=<unix>` only when the user has scrubbed
away from "now"; absence in URL = "live, defaults to current wall-clock
at load time."

URL semantics intent: a shared link with `t=` preserves the sender's
chosen date; a shared link without `t=` reads as "live", so it resolves
to the receiver's local-now. This matches how shareable links should
feel — a deliberately scrubbed pose freezes time, an idle pose stays
live.

### Time-scrubber UI

Discreet. Lives in `.ui-bottom`. Broad idea: a short text readout
showing the current `t` ("Live" when matching wall-clock within
tolerance, otherwise a date), clickable to open an edit affordance.
**Detailed widget choices deferred to implementation time** — the
brief is "unobtrusive, doesn't dominate the bottom bar when nothing
solar-system is visible."

Visible only when the solar-system layer is active (focused on Sol,
or unfocused at Sol). Hidden otherwise.

### Sol-focus `minDistance` relaxation

When focused on Sol, drop `controls.minDistance` from `0.005 pc`
(≈1031 AU) down to `~0.5 AU` ≈ `2.4e-6 pc`, so the user can fly into
the inner solar system and resolve individual planets. Other focal
stars retain the existing `0.005 pc` floor.

This is safe specifically for Sol because Sol sits at the world
origin — the float32 jitter that bites at small distances *from
non-origin focal stars* (CLAUDE.md "Camera near plane vs controls
minDistance") doesn't apply when the focal frame is also the world
frame.

`camera.near` already at `0.001 pc` is fine; for Sol-focus consider
dropping to `1e-7 pc` (≈0.02 AU) so very close planet inspection
isn't culled. Keep the strict-less-than invariant
(`camera.near < minDistance`).

### Planet positions via VSOP87 (`astronomia` npm)

Add `astronomia` as a dependency. Provides full VSOP87D coefficient
tables for all 8 planets with a clean JS API — no network calls, fully
offline, ~500 KB added to bundle (acceptable; the data is the cost,
not the algorithm).

Per-frame (when solar-system layer is visible):
1. `JDE = (t / 86400) + 2440587.5`
2. For each planet, call `astronomia.planetposition.Planet(...).position(JDE)`
   → `{ lon, lat, range }` heliocentric ecliptic, radians + AU.
3. Cartesian:
   ```
   x_ecl = R cos(B) cos(L)
   y_ecl = R cos(B) sin(L)
   z_ecl = R sin(B)
   ```
4. Rotate ecliptic → ICRS equatorial (ε = 23.4392911° at J2000):
   ```
   x_eq = x_ecl
   y_eq = y_ecl cos(ε) − z_ecl sin(ε)
   z_eq = y_ecl sin(ε) + z_ecl cos(ε)
   ```
5. Convert AU → parsecs (`/ 206264.806`) for the 3D scene.

Caching: VSOP87 evaluation is cheap but not free; cache results per-
frame, recompute only when `t` changes.

### Planet rendering

Each planet as an instanced quad (similar to the star quads, separate
`InstancedBufferGeometry`). Apparent-size with floor — physical AU
sizes are tiny relative to orbital scale, so use `max(physicalRadius,
minPx)` in the vertex shader. Body colour from a small per-planet
constant table (Mercury grey, Mars rust, Jupiter banded yellow, etc.).
Optional: a faint ring/label sphere texture at higher zoom.

Faint dashed orbit ellipses rendered as Three.js `Line` instances —
one per planet, computed once from the planet's mean orbital elements
(use VSOP87 at twelve evenly-spaced mean anomalies and connect, or use
Keplerian elements directly). Re-renders only on UI-toggle, not per
frame.

DOM labels for each planet — extend the existing `meta` overlay
pattern or add a small `solar-system-labels.ts` module that does
project-and-place per frame.

### Heliopause — asymmetric ellipsoid

Best-known shape per IBEX observations + Voyager 1/2 crossing data:
- **Apex (upwind, toward solar apex):** ~122 AU. Voyager 1 crossed
  at ~121 AU on 2012-08-25.
- **Flanks (perpendicular to apex direction):** ~115 AU. Voyager 2
  crossed at ~119 AU on 2018-11-05 at ~67° from apex.
- **Heliotail (downwind):** ~200 AU. Recent IBEX/Cassini ENA data
  + global heliospheric models suggest 200–350 AU; the tail is the
  least-constrained direction. 200 AU is a defensible mid-estimate.

Apex direction: solar apex of motion through the local interstellar
medium. ICRS approx **RA 17h53m, Dec +27.4°** (Frisch & Slavin
2013 LISM inflow direction). Document the source in code so future
sessions don't ad-hoc this.

**Implementation as a clean ellipsoid + offset:**
- Total length along apex–tail axis = 122 + 200 = 322 AU.
- Major semi-axis (along apex–tail) = 161 AU.
- Equatorial semi-axes (in flank plane) = 115 AU.
- Centre of ellipsoid offset from Sol by (200 − 122)/2 = 39 AU
  toward the heliotail (anti-apex). Result: upwind boundary lands
  at 122 AU from Sol, tail boundary at 200 AU.

Construction: `SphereGeometry(1, 64, 32)` → non-uniform scale
`(115, 115, 161)` along its local axes → orient so local +Z is the
anti-apex direction → translate by 39 AU along that direction.
Convert AU → pc for the scene.

Material: low-opacity additive shell (transparent, `depthWrite=false`),
or a wireframe mesh. Pick one and tune. Label "Heliopause (~120 AU
upwind)" — the asymmetry is intentional and the label should
acknowledge it without over-specifying the tail.

Static — no `t` dependence (heliopause shape doesn't measurably
change on human timescales).

### Scale rings — 1 AU and 50 AU

Faint `LineLoop` circles in the ICRS xy-plane (close enough to the
ecliptic for visual reference; not the ecliptic plane proper, which
is tilted 23.4°). Scale anchors:
- **1 AU** — Earth's orbit, inner-system context.
- **50 AU** — Kuiper Belt outer edge, outer-system context.

Visible only when solar-system layer is active. Optional toggle
in the panel (default on).

### Files

- New:
  - `src/client/solar-system.ts` — VSOP87 driver, planet rendering,
    label placement, ring meshes.
  - `src/client/heliopause.ts` — static asymmetric mesh.
  - `src/client/time-scrubber.ts` — discreet UI in `.ui-bottom`.
- Touch:
  - `starfield.ts` — filter-state `t` field, Sol-focus `minDistance`
    swap, solar-system layer hookup.
  - `controls.ts` — possibly a panel toggle for orbits/rings.
  - `url-state.ts` — `t=` parameter (omit when "live").
  - `index.html` / `styles.css` — time-scrubber container in
    `.ui-bottom`, ring/orbit visibility classes.
  - `package.json` — add `astronomia` dependency.
- After landing, update `CLAUDE.md`:
  - Add a "Solar-system layer" section (VSOP87 coordinate transform
    chain, Sol-focus minDistance carve-out, t vs uTime distinction,
    heliopause apex direction reference).
  - Note in "Things deliberately kept out": time-series proper
    motion of stars is *still* out of scope — `t` only affects
    solar-system bodies.

### Watch out for

- **Sol-focus `minDistance` is a per-focus override.** When focus
  switches from Sol to another star, the floor must snap back to
  `0.005 pc` *before* the new focus's recenter pulls the camera
  in. `setFocus` is the right hook.
- **`t` vs `uTime`.** Don't accidentally couple them. `uTime` keeps
  ticking at `uSecondsPerDay = 0.2` regardless of where the
  scrubber is. Variable-star pulsation is cosmetic; mixing in
  wall-clock would either freeze pulsation when scrubbed or
  produce nonsensical strobing when the scrubber moves fast.
- **Ecliptic ↔ equatorial obliquity.** Use J2000 ε = 23.4392911°
  consistently. Don't reach for the time-varying obliquity term
  unless someone proves it makes a visible difference (it doesn't
  on visualisation timescales).
- **Solar-system layer is only meaningful from Sol-focus.** If you
  render planets from a Tau Ceti view they'd be sub-pixel close to
  Sol anyway, but explicit gating avoids edge cases (e.g. orbit
  ellipse meshes that shouldn't render at all when not at Sol).
- **`camera.near` invariant.** Anything that drops `minDistance`
  must keep `camera.near < minDistance`. Trivial but easy to miss
  when both shift together for Sol-focus.

### Estimate

1.5–2 days. VSOP87 wiring is mechanical (the library does the heavy
lifting), heliopause mesh + scale rings are quick, time-scrubber UI
is the most variable bit. Most time goes to making planet rendering
look good across the new much-wider zoom range.

### Deliberately excluded

- Moons (Earth's Moon, Galilean satellites, Titan, etc.). VSOP87
  doesn't cover these and the data plumbing for satellite
  ephemerides is a separate effort.
- Asteroids and minor planets. Out of scope for v1.
- Time-series proper motion of stars. Stars remain snapshot-only;
  `t` is solar-system-only.
- Time-of-day / Earth rotation effects. The scene is heliocentric;
  Earth's daily rotation has no meaning here.
- Real-time mode that animates `t` automatically forward. The
  scrubber is for explicit positioning; "Live" mode resolves to
  the current wall-clock at frame time but doesn't sweep.

---

## Phase 12b: Deep-space probes

**Status:** Depends on Phase 12a's time-scrubber framework.

**Goal:** render the five interstellar probes — Pioneer 10, Pioneer
11, Voyager 1, Voyager 2, New Horizons — at their actual positions
for the current `t`. Visible only when solar-system layer is active.
A small but emotionally significant addition: "you can see how far
they've gotten" against the scale of the solar system and the
nearest stars.

### Probe data via NASA HORIZONS

| Probe        | Launch     | HORIZONS ID | Status                |
|--------------|------------|-------------|-----------------------|
| Pioneer 10   | 1972-03-03 | `-23`       | Silent since 2003-01-23 |
| Pioneer 11   | 1973-04-06 | `-24`       | Silent since 1995-09-30 |
| Voyager 2    | 1977-08-20 | `-32`       | Active                |
| Voyager 1    | 1977-09-05 | `-31`       | Active                |
| New Horizons | 2006-01-19 | `-98`       | Active                |

### Build script: `scripts/fetch-probe-trajectories.ts`

**Manual** — `npm run fetch:probes` only, not part of the default
`build` chain. Same convention as the GCVS files (committed once,
refreshed when upstream updates).

Per probe, query HORIZONS:
```
https://ssd.jpl.nasa.gov/api/horizons.api?format=json
  &COMMAND=<id>
  &CENTER=500@10
  &MAKE_EPHEM=YES
  &EPHEM_TYPE=VECTORS
  &VEC_TABLE=2
  &REF_PLANE=FRAME
  &START_TIME=<launch date>
  &STOP_TIME=2050-01-01
  &STEP_SIZE=30d
```

`REF_PLANE=FRAME` returns ICRS equatorial directly — same frame as
ATHYG and the rest of the app. No ecliptic rotation needed.

Parse the `$$SOE…$$EOE` block, extract `JDTDB` and `X, Y, Z` (in AU)
per step. Output `data/probes/{id}.json`:
```json
{
  "id": "voyager1",
  "label": "Voyager 1",
  "launchDate": "1977-09-05",
  "launchUnix": 242265600,
  "lastContactUnix": null,
  "trajectory": [
    { "jd": 2443413.5, "x": 0.12, "y": -0.03, "z": 0.01 },
    ...
  ]
}
```

`lastContactUnix` is null for active probes, populated for Pioneer
10 (`2003-01-23`) and Pioneer 11 (`1995-09-30`).

30-day step from launch to 2050: ~880 entries × ~50 bytes = ~45 KB
per probe, ~225 KB total for 5 probes. Plain-text commit, no LFS.

### Sync to runtime

Mirror `data/probes/*.json` → `public/probes/*.json` via a small
`scripts/sync-probes.ts` (same pattern as `sync-dust.ts`). Add to
`build` and `dev` script chains. `public/probes/` gitignored.

### Runtime: `src/client/probe-loader.ts`

- Fetch all 5 JSONs in parallel (small enough — fire-and-forget at
  startup or lazy-load on first solar-system-layer activation).
- For a given `t`, find bracketing entries and **linearly
  interpolate** x/y/z. Probes move ~3–4 AU/year — 30-day samples
  are visually indistinguishable from the true smooth trajectory.
- Hide probe entirely if `t < launchUnix`.
- Visual flag for "extrapolated past last-contact": Pioneer 10 after
  2003-01-23, Pioneer 11 after 1995-09-30. Render dimmer, with a
  "(signal lost)" label suffix.

### Probe rendering

Same instanced-quad pattern as planets. Tiny — a few px. Always-
labelled when visible (probes are a discovery feature, the labels
are the point). Optional: a thin fading trail showing the
trajectory between launch and current `t`.

### Files

- New:
  - `scripts/fetch-probe-trajectories.ts` — manual HORIZONS fetcher.
  - `scripts/sync-probes.ts` — `data/probes/` → `public/probes/`.
  - `src/client/probe-loader.ts` — JSON load + interpolation.
  - `data/probes/{voyager1,voyager2,pioneer10,pioneer11,new-horizons}.json`
    — committed (no LFS).
- Touch:
  - `package.json` — `fetch:probes` script + `sync-probes` in chain.
  - `solar-system.ts` (from 12a) — register probe layer alongside
    planets, share label/render plumbing where sensible.
  - `.gitignore` — `/public/probes/`.
- After landing, extend the `CLAUDE.md` "Solar-system layer" section
  with the probe data pipeline and last-contact handling.

### Watch out for

- HORIZONS rate-limits and occasional schema drift. Fetch script
  should be defensive — clear error if `$$SOE` block is missing
  or columns are unexpected.
- Pre-launch hiding is per-probe based on `launchUnix`. Don't
  accidentally render a probe at `t = 0` (1970-01-01) where its
  trajectory array's first entry would extrapolate backward.
- Linear interpolation between widely-spaced 30-day samples is
  fine for visual purposes but should not be billed as "true
  ephemeris." Comment in code so future-you doesn't mistake it
  for a precision ephemeris API.
- Active probes' projected trajectories past *now* are HORIZONS
  forward-projections, not certainties. The data is correct as
  far as projections go but the wording in any tooltips should
  be careful.
- Annual-ish refresh: re-run `npm run fetch:probes`, commit the
  refreshed JSONs. Document the cadence in CLAUDE.md.

### Estimate

Half a day to a day. Fetch script is the bulk; runtime
interpolation + rendering is small once 12a's planet rendering is
in place.

### Deliberately excluded

- Other interstellar probes / spacecraft (Parker Solar Probe,
  JUICE, etc.) — not yet at solar-system-edge scale where they'd
  be visually meaningful in this layer.
- True ephemeris precision (sub-AU). Linear interpolation between
  monthly samples is good enough for visualisation.
- Trajectory-line rendering past current `t` for active probes.
  Trail is launch-to-now only; future projection isn't shown
  (would need clearer "this is a projection" framing in UI).

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
