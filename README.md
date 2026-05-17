# Stellata

*Explore the universe.*

An observational 3D model of our galaxy at every scale we've measured
it — from individual stars and their planets, through the local
interstellar medium, out to the structure of the galactic disc — and
extending outward as observation does.

Every object in Stellata comes from a published observational
catalogue or direct in-situ measurement: if we've measured it, it's
here. Theoretical predictions and conjectured structures (the Oort
cloud, anything beyond Gaia's reach) aren't. The model's scope is
bounded only by what observation has touched, and grows with it.

Try it at **[stellata.xyz](https://stellata.xyz)**.

<!-- TODO: hero screenshot — recommended: a few hundred pc out from
     Sol, looking back through the Milky Way band, constellation lines
     on, HUD ring + Sol/GC arrows visible. Conveys the "real 3D
     galaxy you can navigate" framing in one image. -->

![Stellata — hero view](docs/screenshots/hero.png)

## What's interesting about it

- **Everything is rendered live, from where you are.** Stars (all
  313,000 in the catalogue), planets, the volumetric Milky Way, the
  Local Group dwarf galaxies, the 3D dust between them — every
  object recomputes against the current camera each frame. Fly
  halfway to Sirius and the sky genuinely changes: parallax,
  reddening, occlusion are all real, not painted.

- **Close-up stars resolve as physical objects.** Approach a star and
  it stops being a dot: its disc grows to its actual radius (from
  catalogue absolute magnitude + spectral class via Stefan–Boltzmann)
  and occludes whatever is behind it. Supergiants like Betelgeuse
  fill half the viewport; white dwarfs render as crisp small points.

- **Interstellar dust dims and reddens stars correctly.** The vertex
  shader raymarches the Edenhofer 2023 3D dust map from camera to
  star at run time, so stars behind dense ISM look fainter and
  redder — exactly as you would see them.

- **Variable stars pulsate.** ~3,700 stars cross-matched with GCVS
  pulse on time-compressed cycles: Cepheids in seconds, Miras in a
  minute, Betelgeuse in ~8 minutes — visible both as brightness
  swing and as physical disc-radius change at close range.

- **The solar system at live planetary positions.** Around Sol, the
  eight planets and Pluto render at their current heliocentric
  positions (JPL Standish ephemerides, sub-arcminute accurate
  3000 BC – 3000 AD), inside the asymmetric heliopause shell
  measured by Voyager and IBEX. A small clock in the corner shows
  the UTC moment the positions correspond to.

- **The Milky Way is volumetric, not a skybox.** A bounded raymarch
  through galactic-scale density meshes produces the surface-
  brightness band — fly past the galactic centre and it reorients
  with proper parallax. Analytical mid-plane dust means the dark
  lane reads correctly.

- **A paper-chart mode for when you want to read the sky like a
  star atlas.** A second visual mode inspired by Sky Atlas 2000.0 —
  flat hard-edged discs sized linearly by magnitude, full
  Bayer/Flamsteed labels, constellation names, double-star wings,
  variable-star rings.

<!-- TODO: second screenshot — recommended: star chart mode at a
     constellation-scale FOV (Orion or Cygnus works well), showing
     the paper aesthetic, Bayer letters, and a couple of binary
     glyphs. Visually very distinct from the photographic mode
     above. -->

![Stellata — chart mode](docs/screenshots/chart-mode.png)

- **Navigate, observe, warp.** Orbit any star (navigate), or land on
  it and look around from its surface (observe). Pick a second star
  to measure the distance, then warp — an animated camera flight
  between the two with full physical scaling.

- **Shareable views.** All settings plus camera pose pack into a
  single opaque `?v=…` query param, so any view bookmarks and shares
  in 25–40 characters.

## Grounded in published science

Everything you see is calibrated against the source data. Star sizes
come from absolute magnitudes via Stefan–Boltzmann; halo softness
tracks MK luminosity class; binaries come from the Hipparcos CCDM
cross-reference filtered by MultFlag; dwarf galaxies in the Local
Group come from Pace 2024's Local Volume Database with hand-curated
structural detail for the LMC, SMC, M31, M33, and Sagittarius dSph
from the primary literature.

The full record of sources, formulas, and deliberate modelling
simplifications lives in **[SCIENCE.md](./SCIENCE.md)** — read that
for citations, DOIs, and what is and isn't observationally grounded.

## Browser support

- **WebGL2** required (any browser from 2018 onward — Safari 15+,
  Chrome 56+, Firefox 51+).
- Works on desktop and mobile. On narrow viewports the settings
  panel collapses by default and floats above the scene.

## Gestures

The two-finger rotate gesture (roll the view around the screen
centre) is available on:

- **Mobile / touch** — iOS Safari, Android Chrome, any browser that
  exposes multi-touch `touchmove` events.
- **Desktop Safari** — via the macOS trackpad two-finger rotate
  gesture, detected through Safari's non-standard `gesturechange`
  event.

Chrome and Firefox on desktop do **not** expose a rotate gesture
(they consume two-finger trackpad input for scroll/pinch only), so
roll is unavailable in those browsers by design. All other
navigation (orbit, zoom, pan) works the same everywhere.

## Known limitations

- **No proper motion over time.** Stars are rendered at their
  catalog positions; they don't move as you would see over
  astronomical timescales.
- **Variable-star pulsation uses a constant-temperature model.**
  Real pulsating variables (Miras, Cepheids) split their brightness
  change between radius and temperature; we attribute the whole
  swing to radius (`R ∝ √L`). Visually more dramatic than real
  life.
- **Only ~3,700 variables pulse** — those successfully cross-matched
  between AT-HYG (via HIP or HD) and GCVS. Variables without a
  HIP/HD cross-reference, or whose GCVS entry lacks a parseable
  period, render as non-variable.
- **Most secondaries aren't separately positioned.** ~13k primaries
  are flagged as visual doubles via the CCDM cross-match (Sirius,
  Mizar, Castor, Albireo, γ And, ε Lyr, Algol, …) and carry the
  chart-mode binary glyph, but AT-HYG only stores the primary's
  position for most of them — so apart from α Cen-style cases
  caught by the geometric pass, the secondary doesn't render as its
  own disc.
- **Spectral-class colouring is provisional.** The current B–V →
  RGB mapping is a placeholder pending a perceptually-calibrated
  pass.
- **No nebulae or dark clouds yet.** Molecular-cloud ellipsoids
  (Zucker 2020/2021) are committed but shelved for v1.0 while the
  visual treatment is refined. Diffuse and emission nebulae are not
  modelled.

## For developers

Most users won't need this section — the deployed site at
[stellata.xyz](https://stellata.xyz) is the whole product. This is
how to run it locally.

### Prerequisites

- Node 20+
- [Git LFS](https://git-lfs.com/) — catalogue source files are
  tracked via LFS. A clone without LFS will check out pointer stubs
  and the preprocessor will fail.

### Setup

```bash
git lfs install        # one-time, if you haven't already
git clone <this-repo>
cd stellata
npm install
```

All catalogue source files are included in the repo — no manual
downloads needed. The dust voxel chunks (~120 MiB total) and stellar
catalogue ride on Git LFS, so make sure that's installed before
cloning.

### Running

```bash
npm run dev
```

Runs the preprocessor (regenerating `public/catalog.bin` if the
source CSV has changed) and starts Vite on
<http://localhost:5173>.

### Other commands

| Command                   | What it does                                           |
| ------------------------- | ------------------------------------------------------ |
| `npm run build:catalog`   | Regenerate `public/catalog.bin` from the CSV           |
| `npm run build:clouds`    | Regenerate `public/clouds.json` from the Zucker tables |
| `npm run build:dust-sync` | Mirror `data/dust/` voxel chunks to `public/dust/`     |
| `npm run build`           | Full production build into `dist/`                     |
| `npm run typecheck`       | `tsc --noEmit` over everything                         |
| `npm test`                | Run the vitest regression suite                        |
| `npm run test:coverage`   | Vitest run with v8 coverage report                     |
| `npm run deploy`          | `wrangler deploy` (requires Cloudflare auth)           |

### Deploying to Cloudflare Workers

`wrangler.toml` is configured to serve `dist/` via the Workers
static-assets binding. After authenticating wrangler:

```bash
npm run build
npm run deploy
```

No additional services (R2, KV, D1) are used — the ~13 MB catalog
binary and the ~13 MB JSON search index ship as static assets
alongside the HTML/JS. Both compress well (~2 MB each gzipped).

### Project documentation

- **[CLAUDE.md](./CLAUDE.md)** — project conventions, folder layout,
  and the documentation index. Start here when navigating the
  codebase.
- **[SCIENCE.md](./SCIENCE.md)** — every data source, citation,
  formula, and modelling decision.
- **[`docs/`](./docs/)** — topic-specific deep dives (architecture,
  rendering pipeline, URL state, camera modes, etc.). The
  documentation index in CLAUDE.md describes what each one covers.

## Sponsorship

Stellata is built and maintained in my spare time. If it's useful to
you and you'd like to support continued development, sponsorship
through [GitHub Sponsors](https://github.com/sponsors/alexmensch) is
warmly welcomed.

## Contributing

The issue tracker is open — bug reports and enhancement suggestions
are welcome. External pull requests are not currently accepted; see
[`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) for the full
rationale and how to write a useful bug report or feature request.

## Licence

The code in this repository is licensed under AGPL-3.0-only. See
[`LICENSE`](./LICENSE).

Data sources retain their own licences:

- **AT-HYG v3.3** (stellar catalogue) — David Nash,
  [Codeberg](https://codeberg.org/astronexus/athyg), CC-BY-SA-4.0.
  The generated `catalog.bin` and `search-index.json` are
  derivatives and carry the same licence.
- **GCVS 5.1** (variable stars) — Samus et al at the Sternberg
  Astronomical Institute, [http://www.sai.msu.su/gcvs/gcvs/](http://www.sai.msu.su/gcvs/gcvs/).
  Free for research and educational use with attribution.
- **Hipparcos Main Catalogue + CCDM** (ESA SP-1200, 1997; Dommanget
  & Nys 1994) — public domain via [CDS](https://cdsarc.cds.unistra.fr/viz-bin/cat/I/239).
- **Stellarium modern sky culture** (constellation stick figures) —
  [Stellarium](https://github.com/Stellarium/stellarium/tree/master/skycultures/modern),
  MIT-licensed (line data; illustrations not used).
- **Edenhofer et al. 2023 3D dust map** —
  [Zenodo](https://doi.org/10.5281/zenodo.8187943), CC-BY-4.0. The
  resampled voxel grid in `data/dust/` is a derivative and carries
  the same licence.
- **Pace 2024 Local Volume Database** (dwarf galaxies) —
  [arXiv:2411.07424](https://arxiv.org/abs/2411.07424), CC0. The
  `dwarf_all` snapshot at `data/local-group/lvdb-snapshot.csv` is a
  frozen copy of the upstream table.
- **Zucker 2020 + 2021** (molecular cloud distances and bounding
  boxes; data committed but rendering shelved for v1.0) —
  [10.3847/1538-4357/ab9d24](https://doi.org/10.3847/1538-4357/ab9d24)
  and [10.3847/1538-4357/ac1f96](https://doi.org/10.3847/1538-4357/ac1f96).

See [SCIENCE.md](./SCIENCE.md) for citation details and the
peer-reviewed papers underpinning hand-curated Local Group
overrides (LMC, SMC, M31, M33, Sgr dSph, M 32, NGC 205).
