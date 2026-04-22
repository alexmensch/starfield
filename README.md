# Starfield

A browser-based interactive 3D star catalog viewer. Loads the ~118,000-star
[HYG catalog](https://github.com/astronexus/athyg) and renders it on the GPU
with per-frame, camera-relative apparent magnitude, filterable by distance,
magnitude, spectral class, and constellation.

Stack: TypeScript, Three.js (WebGL2), Vite, Cloudflare Workers.

## Features

- All 118k stars rendered as GPU points, sized and coloured by apparent
  magnitude computed in the vertex shader from the current camera position.
- Filter by distance from Sol, maximum apparent magnitude (with `naked eye` /
  `binoculars` / `all` presets), spectral class, and constellation.
- Click a star to focus; click another to draw a measured distance vector
  (chevron-marked, clipped when the destination goes off-screen); click the
  far tip to travel there.
- Dual search inputs: one for focusing, one for measurement destination.
  Substring / fuzzy matching over all ~500 named stars.
- Hover any star for a 280 ms-delayed tooltip with name, constellation, and
  distance from Sol.
- Constellation overlay draws a convex hull around the twelve stars that
  define each classical asterism — reshapes naturally as the viewpoint moves.
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

Place the source CSV at `data/hyglike_from_athyg_v33.csv` (the path is
gitignored). The file is available from
[astronexus/athyg](https://github.com/astronexus/athyg/blob/main/data/subsets/hyglike_from_athyg_v33.csv).

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

The preprocessor (`scripts/build-catalog.ts`) expects an HYG-format CSV, as
produced by the [athyg project](https://github.com/astronexus/athyg). The
columns it actually reads:

| Column    | Required | Purpose                                              |
| --------- | -------- | ---------------------------------------------------- |
| `x, y, z` | yes      | Parsecs, equatorial, Sol at origin                   |
| `absmag`  | yes      | Absolute magnitude                                   |
| `dist`    | no       | Used only for the `dist > 50,000 pc` outlier filter  |
| `ci`      | no       | B–V colour index (defaults to 0.65 when missing)     |
| `spect`   | no       | First character mapped to spectral class             |
| `con`     | no       | 3-letter IAU constellation code (case-insensitive)   |
| `proper`  | no       | Human-readable star name (populates search index)    |

Rows are dropped when any of `x`, `y`, `z`, or `absmag` is missing, or when
`dist` exceeds 50,000 parsecs (a few HYG rows contain distances up to
~312,500 pc which appear to be bad data or extragalactic).

Columns such as `bayer`, `flam`, `hip`, `hd`, `rv`, proper motion values,
etc. are ignored — the binary only carries what the renderer and search
need. See `CLAUDE.md` for the binary layout.

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

- **Search is limited to stars with proper names** (~500 stars). Bayer
  (e.g. "Alpha Cen") and Flamsteed designations are in the source CSV but
  not carried into the binary, so searching by them won't work in v1.
- **No constellation asterism lines.** Only the convex hull is drawn. Adding
  the classical stick-figures would need the IAU constellation-lines dataset
  as a separate asset.
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
[athyg repository](https://github.com/astronexus/athyg) for attribution
requirements.
