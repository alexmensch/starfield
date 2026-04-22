# Starfield — Claude project notes

Project context and non-obvious constraints for future Claude Code sessions.
Read this before editing.

## What this is

A browser-based interactive 3D star catalog viewer. Loads the ~118k-star HYG
catalog, computes per-vertex apparent magnitude on the GPU as the camera moves,
and renders stars as additive point sprites coloured by B–V index. Ships as a
Cloudflare Workers static-assets site.

## Repo layout

```
scripts/
  build-catalog.ts        CSV → binary preprocessor (run at build time)
  verify-catalog.ts       sanity-check tool for the generated binary
data/
  hyglike_from_athyg_v33.csv         source CSV (gitignored, ~38 MB)
  stellarium-modern-skyculture.json  Stellarium constellation lines (committed, ~200 KB)
public/
  catalog.bin             generated (gitignored, ~3.8 MB)
  constellations.json     generated (gitignored)
src/
  worker.ts               Cloudflare Worker entry (just delegates to ASSETS)
  client/
    main.ts               bootstrap
    starfield.ts          Three.js scene + state machine + event bus
    catalog-loader.ts     binary parse into typed arrays
    controls.ts           right-side panel widgets (with reverse-sync)
    search.ts             dual-input focus + destination search
    constellation-overlay.ts   SVG convex-hull polygon
    distance-vector-overlay.ts chevron-based measurement line
    focus-ring-overlay.ts      dashed circle around focused star
    scale-bar.ts          bottom-left distance scale
    unit-toggle.ts, theme-toggle.ts  display-mode toggles
    distance-util.ts      fmtDist, unit state + broadcast, niceRound
    url-state.ts          URL ↔ state sync (debounced)
    info-modal.ts         first-visit welcome modal (localStorage opt-out)
    panel-layout.ts       collapse-toggle for the display-settings panel
    warp-button.ts        warp trigger (on distance label) + skip pill
    shaders/star.vert.glsl, star.frag.glsl    GLSL3/WebGL2
    index.html, styles.css
```

## Binary catalog format (`public/catalog.bin`)

Fixed-size records, sorted brightest-first by `absmag`. Stride is 32 bytes.

- Header (32 bytes)
  - 0–3   ASCII `HYG3`
  - 4–7   `uint32` version (currently 1)
  - 8–11  `uint32` count
  - 12–15 `uint32` nameTableOffset
  - 16–19 `uint32` nameTableLength
  - 20–31 reserved
- Record (32 bytes per star)
  - 0–11  `float32 × 3`  x, y, z in parsecs (equatorial, Sol at origin)
  - 12–15 `float32`      absmag
  - 16–19 `float32`      ci (B–V colour index, default 0.65 for missing)
  - 20    `uint8`        spectClass (0=O 1=B 2=A 3=F 4=G 5=K 6=M 7=C/S/W 8=?)
  - 21    `uint8`        constellation index (0–87 into `constellations.json`; 255=none)
  - 22    `uint8`        flags (bit 0 = has name, bit 1 = is Sol)
  - 23    reserved (alignment)
  - 24–27 `uint32`       nameOffset (into name table, only valid when bit 0 set)
  - 28–31 reserved
- Name table: length-prefixed UTF-8 strings (`uint16` length then bytes)

If you add fields, keep the 32-byte stride (pad as needed) and **bump
`version`** in both the writer and reader.

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
| clicked = vector tip | travel there (clear vector, refocus tip) |
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

### Shader requires WebGL2 / GLSL3

`ShaderMaterial({ glslVersion: THREE.GLSL3 })`. Vertex shader uses `uint`
uniforms and bitwise ops for the spectral-class mask. Do **not** downgrade to
GLSL1 — the mask logic would need to be rewritten as per-class bools.

Mono mode and colour mode share the same shader but branch on
`uMonochrome`. Mono uses `MultiplyBlending` + emits `vec3(1 - glow)` to "ink"
a light canvas; colour uses `AdditiveBlending` + emits `vColor * glow` to glow
on a dark canvas. `depthTest` is off in both.

### Camera near plane vs controls minDistance

`camera.near = 0.001`, `controls.minDistance = 0.005`. The near plane must
stay **strictly less** than the closest orbit distance, otherwise a centered
star lands on the clip plane at max zoom and gets culled. If adjusting, keep
that invariant. `WARP_END_OFFSET_PC` (currently `0.005`) is kept equal to
`minDistance` so the warp's arrival parks exactly at the closest user-
orbitable distance — earlier attempts to go closer hit float32 precision
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
`Space`. Click-tip-to-travel remains as an instant teleport — unchanged.

Two-phase animation in `starfield.ts updateWarp`:

1. **Reorient** (`WARP_REORIENT_MS` = 2000). Camera keeps
   `camera.lookAt(A)` locked the whole time; its position spherically
   slerps around A from wherever the user was to `A + dirBack *
   WARP_END_OFFSET_PC` (i.e. on the travel line, offset behind A from B's
   perspective). Simultaneously the orbit distance eases linearly from
   `mag0` down to `WARP_END_OFFSET_PC`. End state: A is centered and B is
   straight ahead, beyond A. Quaternion slerp is used for the angular
   interp (robust against antipodal starting positions).

2. **Fly** (log-scaled duration, `WARP_T_MIN_MS` to `WARP_T_MAX_MS`).
   Straight-line lerp from `pStart` to `pEnd` with a symmetric
   accelerate/decelerate profile: `f(t) = 2t²` for `t < 0.5`, else
   `1 - 2(1-t)²`. `camera.lookAt(B)` throughout.

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

**Known issue**: visible position jitter on stars when orbiting at the
minimum distance (~0.005 pc) from stars that are far from the world
origin (~1000+ pc out). Classic float32 catastrophic cancellation in the
vertex shader's `distance(worldPos, uCameraPos)` and
`modelViewMatrix * position` — both large magnitudes subtracting to a
tiny delta. An earlier emulated-double-precision fix (split camera
uniform into Hi/Lo float32 pair, use `mat3(modelViewMatrix) * (worldPos
- uCameraPosHi - uCameraPosLo)`) didn't resolve it visibly and was
reverted. Needs revisiting with a better diagnosis — possibly the
projection matrix at very-close near plane also loses precision.

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

### Preprocessor idempotency

`scripts/build-catalog.ts isUpToDate` skips rebuild if `catalog.bin` is newer
than both the source CSV and the script itself. If you change field mapping
but not the script mtime (e.g. edit in a way that updates atime only), you
may need to `touch scripts/build-catalog.ts` or delete `public/catalog.bin`.

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
  `WARP_REORIENT_MS` and `WARP_END_OFFSET_PC` there.
- **Info-modal dismissal** — cleared by removing the
  `starfield.info-dismissed` localStorage key.
- **Panel collapse default** — persisted under `starfield.panel-collapsed`
  (`'0'` = expanded, `'1'` = collapsed, missing = collapsed by default for
  first-time visitors). The default-collapsed check is phrased as
  `!== '0'` in `panel-layout.ts` so absence of the key means collapsed.

## Things deliberately kept out of v1

Noted here so we don't re-debate scope:

- IAU constellation **boundary** datasets (only the asterism lines are
  included — boundaries would be a separate Stellarium dataset).
- Milky Way galactic-plane reference grid.
- HR diagram side panel.
- Bayer / Flamsteed designations in search (binary doesn't carry them).
- WASD / flight controls (removed after v1 review).
- Desktop two-finger roll on Chrome / Firefox (no rotate gesture exists in
  those browsers; Safari-only on desktop by design).
- Time-series proper motion (positions are snapshot-only).
