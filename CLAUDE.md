# Starfield — Claude project notes

Project context and non-obvious constraints for future Claude Code sessions.
Read this before editing.

## What this is

A browser-based interactive 3D star catalog viewer. Loads the ~313k-star
AT-HYG v3.3 catalog (classic-IDs subset), cross-matches it with the GCVS
variable-star catalogue, and renders stars on the GPU. Stars are
rendered as instanced quads with two-pass shading — close-range stars
are resolved as opaque discs whose physical radius scales with the
catalog absmag + spectral class, and distant stars are additive
point-glows. Variables pulsate both in disc radius and point glow.
Ships as a Cloudflare Workers static-assets site.

## Repo layout

```
scripts/
  build-catalog.ts        CSV → binary preprocessor (run at build time)
  build-dust.py           Edenhofer dust resampler + particle sampler (Python; LFS outputs)
  sync-dust.ts            mirror data/dust → public/dust on every dev/build
  verify-catalog.ts       sanity-check tool for the generated binary
data/                                All tracked via Git LFS except the Stellarium JSON.
  athyg_33_classic_ids.csv           AT-HYG source CSV (~64 MB, LFS)
  gcvs5.txt                          GCVS main catalogue (~14 MB, LFS)
  crossid.txt                        GCVS cross-reference (~12 MB, LFS)
  stellarium-modern-skyculture.json  Stellarium constellation lines (~200 KB)
  dust/
    chunk_X_Y_Z.bin                  64 voxel chunks, 2 MiB each, LFS
    particles.bin                    50K importance-sampled dust points (LFS)
    manifest.json                    grid params + chunk index + particle count
public/
  catalog.bin             generated (gitignored, ~12 MB, binary v3)
  constellations.json     generated (gitignored)
  search-index.json       generated (gitignored, ~13 MB raw, ~2 MB gzipped)
  dust/                   gitignored mirror of data/dust/
src/
  worker.ts               Cloudflare Worker entry (just delegates to ASSETS)
  client/
    main.ts               bootstrap
    starfield.ts          Three.js scene + state machine + event bus
    catalog-loader.ts     binary parse into typed arrays
    dust-loader.ts        progressive 3D-texture chunk loader + particle binary loader
    controls.ts           right-side panel widgets (with reverse-sync)
    search.ts             dual-input focus + destination search
    constellation-overlay.ts   SVG stick-figure overlay
    disc-mask.ts          SVG mask tracking the focused star + companion discs
    distance-vector-overlay.ts chevron-based measurement line
    focus-ring-overlay.ts      dashed circle around focused star
    scale-bar.ts          bottom-left distance scale
    unit-toggle.ts, theme-toggle.ts  display-mode toggles
    distance-util.ts      fmtDist, unit state + broadcast, niceRound
    url-state.ts          URL ↔ state sync (debounced)
    info-modal.ts         first-visit welcome modal (localStorage opt-out)
    panel-layout.ts       collapse-toggle for the display-settings panel
    warp-button.ts        warp trigger (on distance label) + skip pill
    shaders/
      star.vert.glsl, star.frag.glsl              GLSL3/WebGL2
      dust-particle.vert.glsl, dust-particle.frag.glsl   shelved dust splats
    index.html, styles.css
```

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

## Binary catalog format (`public/catalog.bin`)

Fixed-size records, sorted brightest-first by `absmag`. Current version is
**v3** with a 40-byte stride. Magic stayed `HYG3` — only the version field
changed to disambiguate. v3 added the two variability fields packed into
bytes 36–39, previously reserved.

- Header (32 bytes)
  - 0–3   ASCII `HYG3`
  - 4–7   `uint32` version (currently 3)
  - 8–11  `uint32` count
  - 12–15 `uint32` nameTableOffset
  - 16–19 `uint32` nameTableLength
  - 20–31 reserved
- Record (40 bytes per star)
  - 0–11  `float32 × 3`  x, y, z in parsecs (equatorial, Sol at origin)
  - 12–15 `float32`      absmag
  - 16–19 `float32`      ci (B–V colour index, default 0.65 for missing)
  - 20–23 `float32`      physicalRadius in solar radii (computed at build time)
  - 24–27 `uint32`       companionIdx (record index of binary companion; `0xFFFFFFFF` = none)
  - 28–31 `uint32`       nameOffset (into name table, valid when flag bit 0 set; `0` = none)
  - 32    `uint8`        spectClass (0=O 1=B 2=A 3=F 4=G 5=K 6=M 7=C/S/W 8=?)
  - 33    `uint8`        luminosityClass (0=VII/D … 9=Ia+/0, 255=unknown — see below)
  - 34    `uint8`        constellation index (0–87 into `constellations.json`; 255=none)
  - 35    `uint8`        flags (bit 0=has_name, 1=is_sol, 2=has_bayer, 4=is_binary_primary)
  - 36    `uint8`        **variability amplitude** in 0.05 mag units (0 = not variable)
  - 37    `uint8`        reserved (future: variability type)
  - 38–39 `uint16`       **variability period** in 0.1 days (0 = not variable, max 6553.5 d)
- Name table: length-prefixed UTF-8 strings (`uint16` length then bytes).
  **Offset 0 is reserved** as the "no name" sentinel (2 zero bytes of
  padding); real names start at offset ≥ 2.

Luminosity class encoding (Morgan–Keenan):
`0=VII/D (white dwarf), 1=VI/sd, 2=V (dwarf), 3=IV (subgiant), 4=III
(giant), 5=II (bright giant), 6=Ib, 7=Iab, 8=Ia, 9=Ia+/0 (hypergiant),
255=unknown`.

Amplitude encoding saturates at 255 × 0.05 = 12.75 mag; periods over
6553.5 days clamp to the uint16 max. Both limits cover the vast
majority of real variables (a few multi-decade symbiotics and extreme
eclipsers clip but those render imperceptibly slowly anyway).

If you add fields, keep the 40-byte stride (pad as needed) and **bump
`version`** in both the writer and reader.

## Search index (`public/search-index.json`)

Separate from `catalog.bin` so the main binary stays rendering-focused.
One JSON array entry per star that has at least one searchable identifier
(proper name, Bayer, Flamsteed, HIP, HD, HR, or Gliese). Short keys
(`i/p/b/f/hip/hd/hr/gl/c/s`) to keep wire size down — file is ~13 MB raw,
~2 MB gzipped. Loaded in parallel with `catalog.bin` in `main.ts`. The
`s` field carries the raw spectral designation from the AT-HYG source
("G2 V", "M1.5Iab-b", "K0III+K7V", …) for the hover tooltip display.

Identifier dispatch in `search.ts`:
- Regex-prefix forms (`HIP 27989`, `HD 39801`, `HR 2061`, `Gl 559A`) go
  through `Map<number, number>` direct lookups — no fuzzy scoring.
- Flamsteed (`58 Ori`) also uses a direct `"${num} ${con}"` map.
- Everything else (proper name, Bayer forms) is Fuse-fuzzy.
- For each Bayer'd star, multiple index entries are emitted so any of
  `α Cen` / `Alpha Cen` / `Alp Cen` / `Alf Cen` / `Alpha Centaurus` find
  the star. "Alf" is added only for α (most-commonly alternate-spelled).

The dropdown deduplicates by star index so a star with multiple matching
Bayer variants shows up once.

## Architectural notes you'll want before touching code

### Event bus on `Starfield`

- `onFocusChange(idx | null)` — focused star changed (from any source).
- `onVectorChange(toIdx | null)` — distance-vector destination changed.
- `onFilterChange(filter)` — any filter patch applied.
- `onFrame()` — called after each render, used by all SVG overlays.
- `onStateChange()` — fires on any discrete state mutation. This is what the
  URL-sync module listens to. Don't fire it from `onFrame` for camera changes —
  the URL sync has its own frame hook with hash comparison for that.

### Click-state machine (`starfield.ts onPointerUp`)

| condition | action |
| --- | --- |
| no focus | focus on clicked |
| clicked = focused, no vector | unfocus |
| clicked = focused, vector drawn | clear vector (stay focused) |
| clicked = vector tip | `focusStar(tip)` — teleport to 2 pc from tip, clear vector |
| clicked = other | draw/replace vector from focus → clicked |

This is the UX the user settled on. No double-click, no modifier keys.

### Picking a constellation aims the camera

`Starfield.aimAtConstellation(conIndex)` swings the camera so the chosen
constellation is centred in view, without moving `controls.target` or
changing orbit radius — only the camera's position on the orbit sphere
moves. The aim point is the brightness-weighted centroid of the top-8
figure stars as ranked by apparent magnitude **from the current orbit
target** (not from Sol). This matters when the user has travelled far
from Sol: the same constellation is still centred on whichever members
visually dominate from *there*, not from Earth.

Called **only from the constellation dropdown change handler** in
`controls.ts`. URL state restore, reset button, and any other path that
sets `highlightCon` via `setFilter` deliberately do **not** trigger the
aim — a shareable URL's camera pose is authoritative, and the "reset"
button means "clear the selection", not "jump somewhere".

### Constellation stick-figure overlay

When a constellation is highlighted, `constellation-overlay.ts` draws the
classical asterism lines (sourced from Stellarium — see next section) as
an SVG `<path id="con-figure">`. Every segment is emitted as a separate
`M..L..` subpath with both endpoints pulled back by `STAR_GAP_PX`, and
the path uses `stroke-linecap: round`. Net effect: each stick-figure
line is a rounded-end segment with a circular gap around every
vertex star, so the actual star glyphs remain visible through the figure.

The `<path>` also applies `mask="url(#disc-occlude-mask)"`. The mask is
driven per-frame by `disc-mask.ts` which cuts out circles at the
projected position + rendered size of the focused star and its binary
companion (up to 4 simultaneous cutouts via a pooled `<circle>` array).
That gives the visual effect of constellation lines passing *behind* a
close-range resolved disc rather than being painted on top of it. The
cutout circle's radius tracks the disc's variable-star pulsation exactly
via `renderedSizePx` replicating the shader math, so there's no stale
gap as a variable shrinks. SVG renders above the canvas unconditionally,
so this masking is the only practical substitute for real z-ordering
between WebGL content and SVG overlays.

Earlier versions also drew a convex hull around the top-N brightest
constellation members. That layer was removed — the hull is defined by
*what's bright from Earth*, while the figure is defined by *what humans
traditionally drew as the shape*. When the camera isn't at Sol those
two answers diverge, and showing the hull was more confusing than
helpful. The 3D-deforming stick figure alone conveys the intent.

### Stick figures from Stellarium

Classical asterism lines are sourced from Stellarium's modern sky culture
`index.json` (CC/MIT-compatible, HIP-indexed). The source file is
committed to `data/stellarium-modern-skyculture.json` — it essentially
never changes, so fetching it at build time each time would be wasted
work.

Pipeline in `scripts/build-catalog.ts`:

1. The HYG CSV parser reads the `hip` column into each star record.
2. After sorting stars by absmag (so record indices are final), a
   `hipToIndex: Map<number, number>` is built from the post-sort order.
   Duplicate HIPs (rare — binary companions) keep the brightest entry
   (first-write wins).
3. `buildFigureLines(hipToIndex)` walks each Stellarium constellation's
   `lines` array and resolves every HIP to a record index, producing
   `Map<conIndex, number[][]>`.
4. Resolved `lines` are merged into the emitted `constellations.json`
   alongside `{ code, name }`. A polyline is kept only if ≥2 points
   survive.

**Reliability rule: any unresolved HIP is a hard build error** — unless
it's in `KNOWN_MISSING_HIPS`. That map documents HIPs that Stellarium
references but HYG has no 3D position for (empty x/y/z/parallax in the
CSV), with a human-readable justification each. Currently:

- `5165` (α Phe / Ankaa) — Phoenix loses most of its figure without this
  star, but HYG can't carry it.
- `89341` (μ Sgr / Polis) — one Sagittarius polyline degrades from 3
  points to 2, shape still recognisable.

If a future Stellarium update introduces new references to missing HIPs,
the build fails until each is explicitly added to
`KNOWN_MISSING_HIPS` with rationale. Don't relax the check to a soft
warning — the whole point of using Stellarium's HIP-indexed data (vs.
fuzzy RA/Dec position matching) is deterministic mapping.

### Vector clipping at the near plane

When the destination star is behind the camera (common at close zoom —
Betelgeuse goes behind the camera when the camera is within ~20 pc of Sol),
`distance-vector-overlay.ts projectWithNearClip`:

1. transforms both endpoints to view space,
2. if destination's `viewZ >= -near`, solves for the line/near-plane
   intersection and uses it as an "effective destination" strictly in front,
3. caps the off-screen point at 1.5× viewport diagonal so SVG coords stay
   sane,
4. clamps the label position to `LABEL_PADDING_PX` from any edge so the
   distance stays readable.

If you see a disappearing vector, check this logic first.

### SVG hide semantics

Missing coordinate attributes on SVG elements default to **0**, not "don't
render". So `line.removeAttribute('x1')` leaves a stale line at x=0. Hide
using either:

- `element.style.display = 'none'` (used for the focus ring circle), or
- `path.setAttribute('d', '')` (used for the chevron path), or
- `polygon.setAttribute('points', '')` (used for the constellation hull).

### Reverse-sync in `controls.ts`

Widgets subscribe to `starfield.onFilterChange` and write DOM from the filter
state. This is how URL restores and `naked eye`/`all` presets update sliders
and chip states. **Setting `.value` programmatically does NOT dispatch
`input`**, so there's no feedback loop. If you add a filter field, remember
to handle it in `syncFromFilter`.

### URL state

- `url-state.ts applyFromUrl` runs **before** `startUrlSync` subscribes, so
  applying the URL on load doesn't echo back into history.
- Default-compression: fields are omitted when they match defaults. Empty
  URL = first-run state.
- `focus=-1` is the sentinel for "explicitly unfocused" (so the default (Sol)
  isn't ambiguous with "param missing").
- If the URL has `focus` without camera params (a hand-typed share), we call
  `focusStar` which teleports the camera. If it has camera params too, we use
  `setOrbitTarget` so the explicit camera wins.
- Camera changes are tracked via `onFrame` with a stringified-coord hash and
  a 300 ms debounced writer. The hash covers position, target, **and**
  `camera.up` — so two-finger roll (which only mutates `up`) still triggers
  a URL update.
- `camera.up` round-trips via `ux/uy/uz` params. They're written only when
  `up` differs from `(0, 1, 0)` and applied **before** `focusStar` /
  `setOrbitTarget` in `applyFromUrl` because those call `controls.update()`
  which reads `camera.up` to derive orientation.

### Star rendering: instanced quads, two passes

Stars are rendered as **instanced unit-quads**, not `THREE.Points`. Points
were capped by the driver-defined `gl_PointSize` max (commonly 64–511 px)
— too small for the close-range physical-size rendering, which can
target up to 50% of the viewport. Each instance is one `aCorner` vertex
× 4, expanded to screen-space pixels in the vertex shader by projecting
the star centre, then offsetting each corner in clip space by
`corner × pxSize / viewport × 2 × centre.w` (the `×w` makes the offset
perspective-correct so stars stay a fixed pixel size regardless of
depth).

Rendering is **two passes over the same instanced geometry**:

- **Disc pass** (`renderOrder = 0`). Stars where `vPhysRatio ≥ 0.5` —
  i.e. the physical-size term dominates the final `max(appSize,
  physSize)`. Premultiplied-alpha blend + `depthTest` + `depthWrite`, so
  close-range opaque discs occlude anything behind them.
- **Glow pass** (`renderOrder = 1`). Stars where `vPhysRatio < 0.5`.
  Additive blending + depthTest but no depthWrite, so overlapping
  distant-field stars accumulate brightness (Milky Way density stays
  alive) and glows correctly depth-fail against any disc drawn in pass 1.

Both passes share a single `InstancedBufferGeometry` and a shared
`uniforms` map (the only divergent uniform is `uRenderMode` bound to its
material). The disc pass discards fragments with `vPhysRatio < 0.5`; the
glow pass discards `vPhysRatio ≥ 0.5`. To avoid a visible "pop" at the
threshold as a star transitions from glow to disc during zoom-in, the
glow pass morphs its profile from "tight point-glow" to "flat disc" as
`vPhysRatio` approaches 0.5 via a `max(pointGlow, flatDisc × flatness)`
blend — so the disc pass takes over with matching geometry.

`ShaderMaterial({ glslVersion: THREE.GLSL3 })`. Vertex shader uses `uint`
uniforms and bitwise ops for the spectral-class mask. Do **not** downgrade to
GLSL1 — the mask logic would need to be rewritten as per-class bools.

Mono mode swaps both materials to `MultiplyBlending` + disables depth
for an ink-on-paper look against the light canvas.

### Physical-size rendering

Each star's final pixel size is `max(appSize, physSize) × pixelRatio`
in the vertex shader:

- `appSize` is the brightness-based term: `mix(uSizeMin, uSizeMax,
  brightnessClamp(appMag))`. Dominates for distant stars. User-tunable
  via the right-panel star-size sliders.
- `physSize = sizeAtRef × (uRefDistPc / dPc)` where `sizeAtRef` linearly
  maps `log10(physicalRadius)` between catalog min and max into
  `[uPhysMinPx, uPhysMaxPx]`. At the reference distance
  (`uRefDistPc = controls.minDistance = 0.005 pc`), the biggest star in
  the catalog renders at `uPhysMaxPx` pixels; smallest at `uPhysMinPx`.
  Dominates at close range, falls off as `1/d`.

`uPhysMaxPx = 0.5 × min(viewportW, viewportH)` in CSS pixels — the
biggest catalog star at min orbit distance therefore fills 50% of the
smaller viewport axis. Updated on resize.

`uPhysMinPx = 2 px` — smallest stars at min orbit don't disappear.

A varying `vPhysRatio = physSize / max(pxSize, 0.001)` is passed to the
fragment shader to drive the pass split (above) and the luminosity-class
softness blending (below).

### Luminosity-class softness

Per-instance `iLumClass` (0=WD, 2=V, 4=III, 6–9=supergiant classes,
255=unknown) feeds a `vSoftness = clamp(iLumClass / 9, 0, 1)` varying
(unknown defaults to V). In the fragment shader:

- Glow pass exponent: `pow(core, mix(3.0, 1.8, vSoftness))`. White
  dwarfs get a tight core (exp 3.0); hypergiants get a wider halo (1.8).
- Disc pass edge: `smoothstep(mix(0.48, 0.38, vSoftness), 0.5, r)`. WDs
  get a ~2% AA band (crisp); supergiants get ~12% (fuzzy), suggesting
  extended atmospheres.

Physical radius (above) already makes supergiants render much larger
than dwarfs. Softness adds visual *character* at similar pixel sizes —
a same-size Sirius-B-like WD and a Betelgeuse-like supergiant look
materially different even when rendered at identical diameters.

### Variable star rendering

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

### Camera near plane vs controls minDistance

`camera.near = 0.001`, `controls.minDistance = 0.005` (via
`DEFAULT_MIN_DIST_PC`). The near plane must stay **strictly less** than
the closest orbit distance, otherwise a centered star lands on the clip
plane at max zoom and gets culled. If adjusting, keep that invariant.
Per-focus `minDistance` is bumped by `minDistForStar(idx)` when the
focused star has a binary companion, so both components stay in the
vertical viewport half-angle (~25°) at max zoom. Warp end-offset uses
the same per-star value so animated arrivals park at the right distance.
Earlier attempts to zoom closer than 0.005 pc hit float32 precision
jitter when the destination star is far from the world origin.

### TrackballControls tuning

We're using `TrackballControls`, not `OrbitControls`, because the user wants
unbounded orbit past the poles (`OrbitControls` clamps polar angle, stalling
at the zenith/nadir — you'll see `cx=0` in the URL when it happens).

Current settings:
- `rotateSpeed = 3.0` (TBC defaults high; 3 feels natural)
- `zoomSpeed = 1.1`
- `panSpeed = 0.6`
- `dynamicDampingFactor = 0.15` (this is the damping knob; not
  `enableDamping`/`dampingFactor` like OrbitControls)
- `staticMoving = false` (keeps damping on)
- `noPan = false` (right-click pans; set `true` to disable)
- `minDistance = 0.005`, `maxDistance = 100_000`

### Warp animation

An animated camera flight between the focused star (A) and the distance
vector destination (B). Trigger: click the yellow distance label on the
SVG overlay (hovering reveals a "→ Warp" suffix), or press `W`. Skip: the
muted ghost pill at top-center (shown only while warping), or `Esc` /
`Space`. Click-tip-to-travel is an instant teleport that routes through
`focusStar(idx)` for consistency with search-select (2 pc viewing
distance, camera teleports along with the orbit target).

Two-phase animation in `starfield.ts updateWarp`:

1. **Reorient** (`WARP_REORIENT_MS` = 2000). Camera keeps
   `camera.lookAt(A)` locked the whole time; its position spherically
   slerps around A from wherever the user was to `A + dirBack ×
   endOffset` (on the travel line, offset behind A from B's
   perspective). Simultaneously the orbit distance eases linearly from
   `mag0` down to `endOffset`. End state: A is centered and B is
   straight ahead, beyond A. Quaternion slerp is used for the angular
   interp (robust against antipodal starting positions). `endOffset`
   is `minDistForStar(destIdx)` — i.e. per-star, larger for binaries
   so the arrival parks at a distance where both system members fit.

2. **Fly** (log-scaled duration, `WARP_T_MIN_MS` to `WARP_T_MAX_MS`).
   Straight-line lerp from `pStart` (= A + dirBack × endOffset) to
   `pEnd` (= B − forward × endOffset) with a symmetric
   accelerate/decelerate profile: `f(t) = 2t²` for `t < 0.5`, else
   `1 − 2(1−t)²`. `camera.lookAt(B)` throughout.

Scale bar smoothness: `controls.target` is pointed at **B** from the
moment the warp begins (not just at arrival). Camera orientation is
controlled independently via `camera.lookAt`, so the reorient phase can
still keep A centered visually while the scale bar already reflects
distance-to-destination — this avoids a jarring scale-bar snap when the
target would otherwise switch from A to B at arrival.

During warp: `controls.enabled = false` (no orbit), pointer-up click
handling is short-circuited, URL writer skips frame-hash updates (camera
is changing every frame and we don't want to serialise intermediate
poses), and `body.warping` toggles a CSS class that hides the entire
SVG overlay (distance vector, figure, focus ring) since their per-frame
reprojection looks chaotic under fast travel.

Distance-label-as-warp-trigger UI:
`index.html` wraps the distance label and a static `→ Warp` sibling
`<text>` in a `<g id="dist-ui">`. The group has `pointer-events: auto`
and `:hover` reveals the warp suffix via CSS opacity transition. The
label itself is still `text-anchor="middle"` and positioned dead-center
on the measurement vector; the warp suffix is computed each frame as
`mx + label.getComputedTextLength()/2 + WARP_GAP_PX` so the distance
stays visually anchored while the suffix extends to the right.

### Floating origin (large-world precision)

Close-range orbit of a star far from Sol used to jitter visibly because
Three.js composes its `modelViewMatrix` at float32 precision. At 1 kpc
from Sol, the translation column quantises to ~10⁻⁴ pc — 2–3% of the
min-orbit radius — so every frame the projected position snapped around
by a few pixels.

Fix: the renderer runs in a **floating local frame** whose origin tracks
the currently focused star.

- `Starfield.worldOffset` is the absolute-space coordinate that
  currently sits at the renderer's (0,0,0). Starts at Sol.
- `Starfield._localPositions` (exposed via `starfield.localPositions`)
  is a `Float32Array` of `catalog.positions − worldOffset`. It's bound
  to the `iPosition` instance attribute and is what every overlay and
  pick path projects through.
- `recenterOrigin(newOrigin)` rewrites the local-positions buffer using
  JS Number (= float64) subtraction and shifts `camera.position` and
  `controls.target` by the same delta so the user sees no jump.
- `setFocus(idx)` calls `recenterOrigin` automatically — focusing a star
  pins the frame to it, unfocusing snaps the origin back to Sol.

The key precision win: the big `absolute − offset` subtractions happen
in JS float64 on the CPU, producing small float32 deltas near zero with
~10⁻³⁸ resolution. The GPU's modelview matrix then only carries
kilo-parsec-scale values when the camera is far from the local origin
(i.e. zoomed out, where pixel-level jitter is imperceptible anyway).

Implications for code that reads positions:
- **Rendering / projection math** must use `starfield.localPositions`
  (same frame as `camera.position` and `controls.target`). The disc
  mask, focus ring, distance vector, constellation overlay, and all
  `pickStar` / `renderedSizePx` / `aimAtConstellation` paths do this.
- **Distance-from-Sol** (UI labels, distSol filter, `describeStar`) must
  use `catalog.positions` — that's the immutable absolute buffer. The
  shader's distSol filter consumes a precomputed per-instance `iDistSol`
  attribute instead of `length(iPosition)`, because the latter is now a
  local-frame value.
- `starLocalPosition(i)` (formerly `starWorldPosition`) returns the
  local-frame vector — use it for camera math, never for Sol-distance.

URL round-trip works without special handling because sender and
receiver both recenter on the same focus star. Camera/target serialise
in local frame; loading the URL recenters to the same absolute origin
and the local coordinates apply unchanged. The unfocused state has
`worldOffset = (0,0,0)` by construction, so camera/target in that state
are already in absolute space.

### Two-finger roll gesture (platform-split)

`starfield.ts` adds a two-finger rotate gesture that rolls the view around
the center of the screen by rotating `camera.up` around the forward vector
(`target - position`). TrackballControls reads `camera.up` every `update()`,
so the new orientation persists through subsequent orbit/zoom without
touching the controls' internals.

Implementation split:

- **Mobile / touch** — listens for `touchstart`/`touchmove` with exactly two
  touches, computes the `atan2` angle between them, and applies the delta
  per move. Single-finger drags are ignored (TrackballControls handles them
  via pointer events, separate from the touch event stream, so there is no
  conflict).
- **Desktop Safari** — listens for the non-standard `gesturestart` /
  `gesturechange` events (WebKit only). `event.rotation` is degrees,
  cumulative since `gesturestart`, positive clockwise. We `preventDefault`
  to suppress Safari's page-level zoom; TrackballControls still receives
  the accompanying wheel events for pinch-zoom.
- **Chrome / Firefox on desktop** — no rotate gesture exists in those
  browsers (two-finger trackpad is scroll-only, pinch fires wheel+ctrlKey
  but no rotation). Roll is unavailable there by design. Do not spend
  effort trying to polyfill it.

Sign convention: finger rotation CW on the screen → world rotates CW.
`rollCamera(-delta)` achieves this because `applyAxisAngle(forward, θ)`
rotates `camera.up` CCW when viewed from behind the forward vector
(standard right-hand rule), and rotating `up` CCW in world space makes
world content appear CW in the camera's view.

### Layout containers: `.ui-top` and `.ui-bottom`

The whole overlay UI is two pure-CSS flex containers — **no breakpoints, no
JS measurements**. An earlier attempt used `ResizeObserver` to drive
`panel.style.top` / `maxHeight`; the user explicitly rejected that ("use
native html/css... we shouldn't dictate layout"). Do not reintroduce it.

- `.ui-top` — fixed top-right, `flex-direction: column`, bottom-bounded.
  Children in DOM order: topbar (brand + search), then panel (display
  settings). Because panel is a flex child below the topbar, it can never
  overlap it — no measurement needed.
- `.ui-bottom` — fixed full-width along the bottom, `flex-wrap: wrap`,
  `align-items: flex-end`. Children: scale-bar (left), meta (right, with
  `margin-left: auto` for pull-apart). When the row doesn't fit, wrap puts
  them on separate rows naturally.
- `.meta` has `overflow-wrap: anywhere` — star names can be long and we
  want them to break within the narrow column when necessary.
- Both containers set `pointer-events: none` on themselves and `auto` on
  direct children, so clicks fall through empty regions to the canvas.

### `[hidden]` specificity and `.modal { display: grid }`

The HTML `hidden` attribute maps to `[hidden] { display: none }` in the UA
stylesheet — specificity (0,1,0). `.modal { display: grid }` has the same
specificity (0,1,0), and site stylesheets win ties, so `modal.hidden = true`
had **no visible effect** on the modal. Fixed globally with
`[hidden] { display: none !important; }` in `styles.css`. If you add
another class that sets `display` on an element that may be `hidden`ed
imperatively, you're already covered — but don't remove the `!important`
rule.

### `backdrop-filter` creates stacking contexts

Both `.topbar` and `.panel` use `backdrop-filter: blur(6px)`, which
silently creates a stacking context. Children's `z-index` is then clamped
to that context — so `.search-results` with `z-index: 12` inside `.topbar`
was painted **below** `.panel` (which has no z-index but appears later in
DOM order). Fixed by giving `.topbar` an explicit `z-index: 1` to lift its
whole context above `.panel`. If you add more blurred panels, remember
that every one of them is a new stacking boundary.

### `@cloudflare/workers-types` leaks globally

Do not add it to the tsconfig `types` array — its DOM re-declarations bleed
into the client types and break `querySelector<T>`. `src/worker.ts` currently
inlines its own minimal `Fetcher` interface; don't swap back to the type
package without a second tsconfig for the worker build.

### Wrangler config: observability + smart placement

`wrangler.toml` currently has `placement = { mode = "smart" }` and an
`[observability]` block split into `[observability.logs]` (enabled,
persisted, 10% head sampling, with invocation logs) and
`[observability.traces]` (defined but disabled). The top-level
`[observability]` block must keep `head_sampling_rate` defined for the
deployment to accept the nested subsection config — wrangler treats the
top-level field as the default applied when sub-blocks omit their own
rate.

`compatibility_date` is pinned to `2026-04-22`. Bump deliberately when you
need new runtime features; `wrangler deploy` will log that it's overriding
whatever the dashboard has.

`routes` must appear **before** `[assets]` in the TOML — TOML sections
claim every line after them until the next section header, so a top-level
array after a `[section]` would be parsed as part of that section.

### Physical radius and spectral parsing

`parseSpectral` in `build-catalog.ts` walks tolerant regexes over the (often
messy) AT-HYG `spect` string to extract `{ classIdx, subclass, lumClass,
isWhiteDwarf }`. It handles the common pathological forms seen in the
catalog (composite `"K0III+K6V"`, prefix colons, ranges like `"F5-F9"`,
subdwarf `sdB`, white-dwarf `DA2`, etc.) by using prefix-anchored matches
for the luminosity numeral and falling back to `lumClass=255` when no
pattern matches.

`physicalRadius` then computes R/R☉ via Stefan–Boltzmann:

```
T       = interp(T_TABLE[classIdx], subclass)
BC      = interp(BC_TABLE[classIdx], subclass)
Mbol    = absmag + BC
L/L☉    = 10^((4.74 − Mbol) / 2.5)
R/R☉    = sqrt(L/L☉) × (T_sun/T)²
```

Tables are main-sequence values — cooler for giants/supergiants in reality
— but the Mbol side of the equation absorbs the luminosity-class
difference, so the end result lands close to published radii (Sol≈1.03,
Sirius≈1.81, Vega≈2.68, Rigel≈75, Betelgeuse≈700, all within ~10% of
canonical values). Clamped to `[0.08, 2500]` so pathological catalog
rows don't produce absurd sizes. White dwarfs are special-cased to
0.013 R☉ (typical WD radius; absmag doesn't translate reliably for them).

### Geometric binary inference

`inferBinaries` in `build-catalog.ts` runs after the absmag sort so record
indices are final. Spatial grid keyed at `BINARY_MAX_SEP_PC = 0.005 pc`
(≈1030 AU) using a three-axis hash; for each star, check own cell + 26
neighbours and record the nearest neighbour within the threshold.

Why this threshold: at the current `minDistance = 0.005 pc` orbit,
anything farther than that subtends >45° from the camera — it wouldn't
fit the viewport as a visual "system", which is what the render layer
wants. Wider bound pairs exist in the catalog but won't render usefully.

What you'll see from the classic_ids subset: ~14 pairs. Feels low but is
accurate. The subset selects stars with classical designations, and most
"wide binary" companions in physically-bound pairs don't have their own
classical ID — the brighter primary does. The pairs we do find are
almost all famous named visual binaries (α Cen A/B, Alula Australis,
Struve 2398, etc.). Reaching thousands of pairs would require the fuller
`reduced_m10` subset, which has a different selection profile.

Each side of a pair stores the other's index in `companionIdx`. The
**brighter** of the two (lower absmag) is flagged as primary via flag
bit 4, so the renderer can quickly identify system anchors.

### GCVS variability cross-match

`parseGcvsMain` + `parseGcvsCrossref` in `build-catalog.ts` read two
files from `data/`:

- `gcvs5.txt` — pipe-delimited fixed-width; we pull the GCVS designation,
  period (days), and magnitude amplitude (from max-mag / min-mag-I).
  Rows without a parseable period, or with zero amplitude, are skipped
  (constant stars, supernovae, irregular variables we can't render
  periodically).
- `crossid.txt` — maps foreign-catalogue IDs (`Hip nnnn`, `HD nnnn`, …)
  to GCVS designations. Only `Hip` and `HD` are extracted since AT-HYG
  carries those.

`applyVariability` then walks the post-sort catalog and for each star
tries HIP first, HD fallback, to find a GCVS name, then looks up the
period+amp. Typical match rate: ~3.7k out of 313k classic_ids stars —
most catalog stars aren't variable, but the ones that are tend to be
the astronomically interesting ones (Betelgeuse, Mira, Algol,
Cepheids, etc.).

Both GCVS files are tracked via Git LFS rather than downloaded at build
time — they update rarely (yearly-ish). If bumping to a new GCVS
version, re-download from http://www.sai.msu.su/gcvs/ and replace the
existing files; LFS handles the large-blob storage on push.

### Preprocessor idempotency

`scripts/build-catalog.ts isUpToDate` skips rebuild if `catalog.bin`,
`constellations.json`, **and** `search-index.json` are newer than all
source inputs (AT-HYG CSV, Stellarium JSON, GCVS files, and the script
itself). If you change field mapping but not the script mtime (e.g.
edit in a way that updates atime only), you may need to
`touch scripts/build-catalog.ts` or delete the generated files.

## Local commands

```bash
npm run build:catalog   # regenerate binary (idempotent)
npm run dev             # preprocess + Vite dev server
npm run build           # full production build
npm run typecheck       # tsc --noEmit over src/ and scripts/
npm run deploy          # wrangler deploy (requires auth)
npx tsx scripts/verify-catalog.ts   # dump header + spot-check records
```

## Known UX knobs you may be asked to tweak

- **Orbit feel** — `rotateSpeed` / `dynamicDampingFactor` in
  `starfield.ts` constructor.
- **Right-click pan on/off** — `noPan` flag.
- **Chevron density** — `CHEVRON_SPACING_PX` / `_HALF_WIDTH` / `_DEPTH` in
  `distance-vector-overlay.ts`.
- **Focus ring size** — `RADIUS_PX` in `focus-ring-overlay.ts`.
- **Constellation polygon prominence** — `#con-polygon` stroke/fill in
  `styles.css` (currently deliberately subtle).
- **Star size defaults** — `FilterState` defaults in `starfield.ts` and
  matching slider `value`s in `index.html`.
- **Max apparent magnitude presets** — `data-mag` attributes on
  `.mag-preset` buttons in `index.html`.
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

### Dust extinction + the shelved particle layer

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

## Things deliberately kept out

Noted here so we don't re-debate scope:

- IAU constellation **boundary** datasets (only the asterism lines are
  included — boundaries would be a separate Stellarium dataset).
- Milky Way galactic-plane reference grid.
- HR diagram side panel.
- WASD / flight controls (removed after v1 review).
- Desktop two-finger roll on Chrome / Firefox (no rotate gesture exists in
  those browsers; Safari-only on desktop by design).
- Time-series proper motion (positions are snapshot-only, no T animation).
- Irregular / supernova variables (GCVS entries without a period are
  skipped — can't animate without one).
- Temperature-swing component of variable-star brightness change. We use
  `R ∝ √L` (constant-T assumption); real pulsating variables split the
  brightness change between R and T swings. Modelling T changes per
  variable type is more complexity than the visualisation warrants.
