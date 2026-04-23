# Starfield

A browser-based interactive 3D star catalog viewer. Loads the ~313,000-star
classic-IDs subset of the [AT-HYG catalog](https://codeberg.org/astronexus/athyg)
and renders it on the GPU with per-frame, camera-relative apparent magnitude,
filterable by distance, magnitude, spectral class, and constellation.

Stack: TypeScript, Three.js (WebGL2), Vite, Cloudflare Workers.

## Features

- All 313k stars rendered as GPU points, sized and coloured by apparent
  magnitude computed in the vertex shader from the current camera position.
- Filter by distance from Sol, maximum apparent magnitude (with `naked eye` /
  `binoculars` / `all` presets), spectral class, and constellation.
- Click a star to focus; click another to draw a measured distance vector
  (chevron-marked, clipped when the destination goes off-screen); click the
  far tip to travel there instantly, or hover the distance label and click
  the "→ Warp" affordance (or press `W`) for an animated flight between the
  two stars.
- Dual search inputs: one for focusing, one for measurement destination.
  Matches proper names (fuzzy), Bayer designations (`α Cen` / `Alpha Cen` /
  `Alf Cen` all work), Flamsteed numbers (`58 Ori`), and numeric catalog
  IDs (`HIP 27989`, `HD 39801`, `HR 2061`, `Gl 559A`) via direct lookup.
- Hover any star for a 280 ms-delayed tooltip with name, constellation, and
  distance from Sol.
- Constellation overlay draws the classical stick-figure asterism lines
  (sourced from Stellarium's HIP-indexed sky culture data). The figure
  deforms in true 3D as the viewpoint moves away from Sol and leaves a
  gap around every figure-star so the glyph stays visible.
- Scale bar in the bottom-left adapts to the current zoom in round pc or ly
  units.
- Two themes: dark (glowing stars on a deep-blue field) and chart (dark stars
  "inked" onto an off-white background via multiply blending).
- URL state sync: all settings plus camera pose are serialised to query
  params, so any view is bookmarkable and shareable.
- First-visit welcome modal with a "Don't show this again" opt-out
  (persisted to `localStorage`).
- Mobile-friendly responsive layout (pure CSS flex, no breakpoints) with a
  collapsible display-settings panel whose state is remembered across visits.
- Targeted reset buttons next to constellation selection, star size, and
  dynamic-range controls.
- Two-finger rotate gesture to roll the view around the center of the
  screen. See [Gesture support](#gesture-support) for platform notes.

## Prerequisites

- Node 20+
- A copy of the HYG catalog CSV (see [Input data](#input-data-format) below)

## Setup

```bash
git clone <this-repo>
cd starfield
npm install
```

Place the source CSV at `data/athyg_33_classic_ids.csv` (the path is
gitignored). The file is available from the
[AT-HYG subsets folder on Codeberg](https://codeberg.org/astronexus/athyg/src/branch/main/data/subsets)
— the classic-IDs subset selects only stars with a proper name, Bayer /
Flamsteed designation, or a catalog ID in HIPPARCOS, Henry Draper, Yale
Bright Star, or Gliese/Jahreiss (~317k stars, ~64 MB).

## Running

```bash
npm run dev
```

This runs the preprocessor (regenerating `public/catalog.bin` if the source
CSV has changed) and starts Vite on <http://localhost:5173>.

### Other commands

| Command                 | What it does                                     |
| ----------------------- | ------------------------------------------------ |
| `npm run build:catalog` | Regenerate `public/catalog.bin` from the CSV     |
| `npm run build`         | Full production build into `dist/`               |
| `npm run typecheck`     | `tsc --noEmit` over everything                   |
| `npm run deploy`        | `wrangler deploy` (requires Cloudflare auth)     |

## Deploying to Cloudflare Workers

`wrangler.toml` is configured to serve `dist/` via the Workers static-assets
binding. After authenticating wrangler:

```bash
npm run build
npm run deploy
```

No additional services (R2, KV, D1) are used — the ~4 MB catalog ships as a
static asset alongside the HTML/JS.

## Input data format

The preprocessor (`scripts/build-catalog.ts`) expects an AT-HYG v3.3
classic-IDs CSV, as produced by the
[AT-HYG project](https://codeberg.org/astronexus/athyg). The columns it
reads:

| Column        | Required | Purpose                                                              |
| ------------- | -------- | -------------------------------------------------------------------- |
| `x0, y0, z0`  | yes      | Parsecs, equatorial, Sol at origin                                   |
| `absmag`      | yes      | Absolute magnitude — drives the physical-radius computation          |
| `dist`        | no       | Used only for the `dist > 50,000 pc` outlier filter                  |
| `ci`          | no       | B–V colour index (defaults to 0.65 when missing)                     |
| `spect`       | no       | Parsed into spectral class, subclass, and luminosity class           |
| `con`         | no       | 3-letter IAU constellation code (case-insensitive)                   |
| `proper`      | no       | Human-readable star name                                             |
| `bayer`       | no       | Bayer designation short code (e.g. `Alp`, `Alp-2`)                   |
| `flam`        | no       | Flamsteed number                                                     |
| `hip`         | no       | Hipparcos ID — also used to align Stellarium stick-figure lines      |
| `hd`          | no       | Henry Draper ID (searchable as `HD nnnn`)                            |
| `hr`          | no       | Yale Bright Star ID                                                  |
| `gl`          | no       | Gliese / GJ ID                                                       |

Rows are dropped when any of `x0`, `y0`, `z0`, or `absmag` is missing, or
when `dist` exceeds 50,000 parsecs.

The renderer-facing `catalog.bin` carries positions, absmag, colour index,
spectral + luminosity class, computed physical radius in solar radii, a
binary-companion pointer, and the proper name. The search layer is a
separate `search-index.json` carrying the full identifier set per star,
loaded in parallel. Columns such as `rv`, proper-motion values, and `tyc`
are not used. See `CLAUDE.md` for the binary layout.

## Browser requirements

- **WebGL2** — the vertex shader uses GLSL ES 3.00 with `uint` uniforms and
  bitwise operators for the spectral-class mask. All browsers from 2018
  onward support this (Safari 15+, Chrome 56+, Firefox 51+).
- Works on desktop and mobile. On narrow viewports the display-settings
  panel collapses by default and floats above the scene.

## Gesture support

The two-finger rotate gesture (roll the view around the screen center) is
available on:

- **Mobile / touch** — iOS Safari, Android Chrome, any browser that exposes
  multi-touch `touchmove` events.
- **Desktop Safari** — via the macOS trackpad two-finger rotate gesture,
  detected through Safari's non-standard `gesturechange` event.

Chrome and Firefox on desktop do **not** expose a rotate gesture (they
consume two-finger trackpad input for scroll/pinch only), so roll is
unavailable in those browsers by design. All other navigation (orbit, zoom,
pan) works the same everywhere.

## Known limitations

- **Visible position jitter** when orbiting at the minimum distance from
  stars that are far from the world origin — a float32 precision issue in
  the vertex shader. Workaround: zoom out slightly.
- **No IAU constellation *boundary* dataset.** The stick-figure asterism
  lines are included (from Stellarium); the 1930 IAU region boundaries are
  not.
- **No Milky Way or galactic-plane reference.** Orientation beyond the
  nearest few constellations is easy to lose.
- **No proper motion over time.** Stars are rendered at their catalog
  positions; they don't move as you'd see over astronomical timescales.
- **Distance cap at 50,000 pc** — anything farther is treated as bad data
  and dropped. The Milky Way is only ~30 kpc across, so this is fine for
  anything in-galaxy, but it excludes catalogued extragalactic objects.
- **Constellation assignments reflect the view from Sol.** The 3-letter
  code is the IAU region the star appears in from Earth; stars in the same
  "constellation" can be physically far apart.

## Licence

The code in this repository is MIT licensed. See [`LICENSE`](./LICENSE).

The HYG / AT-HYG catalog data used by this project is made available by
David Nash under a CC-BY-SA-4.0 license. The generated `catalog.bin` is a
derivative of that data and carries the same licence. See the
[athyg repository](https://codeberg.org/astronexus/athyg) for attribution
requirements.

The classical constellation stick-figure lines are taken from
[Stellarium's modern sky culture](https://github.com/Stellarium/stellarium/tree/master/skycultures/modern).
The line data is MIT-licensed (illustrations, which this project does not
use, are separately under the Free Art License).
