# UI and controls

The right-side settings panel, top-left brand surface, keyboard
shortcuts, layout containers, and a few CSS gotchas that bit hard
enough to be worth documenting. For TrackballControls tuning and the
two-finger roll gesture, see `docs/camera-controls.md`; for the warp
animation see `docs/camera-warp.md`; for OBSERVE camera mode see
`docs/camera-observe.md`.

## Brand box, About/Credits modal, and Share

`.ui-top-left` is a fixed top-left container holding the "Stellata"
title plus a small `about · share ⧉` link row (always visible — no
hover affordance, since touch devices have no hover state). The
`.brand-box` flex column is `align-items: center` so the narrow
title and the wider link row sit symmetrically around the centre
axis.

`about` opens a single tabbed `<div class="modal">` card that
combines what used to be two separate modals. The title row is a
`.modal-tabs` tab bar: `ABOUT STELLATA · credits`, with the active
tab at title weight (`var(--fg)`) and the inactive at `var(--fg-dim)`
acting as a `.link-btn`-style click target. Clicking the inactive
tab swaps which `.modal-pane` is visible and flips both `is-active`
states. Opening from the brand box always resets to the About tab —
no last-viewed memory. ESC, the close button, or the backdrop
dismisses; there's no "don't show again" opt-out because the modal
is user-initiated.

`share ⧉` copies `window.location.href` (which encodes the full
view via `url-state.ts`) to the clipboard and briefly flips its
trailing glyph to `✓` on success or `⨯` on failure (insecure context
/ no `navigator.clipboard`). The `.share-link` class width-locks the
slot so the glyph swap never reflows the flex row.

`brand-modal.ts` wires the modal-dismissal helper, the tab swap,
and the share-button click handler in one `bindBrandModals()` call.
The `.ui-top-left` container sits independently of `.ui-top` so
changes to the right-side stack's width / wrap behaviour don't
affect the brand.

## Keyboard shortcuts

`keyboard-shortcuts.ts` owns a single `keydown` listener and dispatches
to existing public APIs — every shortcut is a thin wrapper, so future
behavioural changes propagate automatically.

**Bindings** (also surfaced via the `?` help modal):

| Key | Action |
| --- | --- |
| `G` | Open the Go picker — focus a star, set a destination, or change observe location |
| `O` | Switch to observe mode (gated on `getFocusedStar() !== null`) |
| `M` | Toggle chart mode (gated on `cameraMode === 'observe'`; auto-clears on observe→navigate) |
| `W` | Trigger the warp animation (handled by `warp-button.ts`, not this module) |
| `C` | Open the Constellation picker (double-tap toggles `showConstellation`) |
| `R` | Reset Camera-section sliders (size min/max, dynamic range, FOV, exaggeration) |
| `H` | Toggle `showHud` |
| `S` | Toggle `showGalacticGrid` |
| `+` / `-` | Magnitude limit ± 0.5 (clamped to [-2, 15]) |
| `=` | `applyMagnitudePreset('naked-eye')` |
| `?` | Open the keyboard-shortcuts help modal |
| `Esc` | Cascade: observe→navigate (animated exit) → clear destination → clear focus |

**Capture phase.** The listener is registered with `{capture: true}`
because foreground-modal listeners (info / about / credits / help)
sit on `document` in bubble phase and flip `hidden=true` when ESC
fires. A bubble-phase window listener would observe the post-close
state and the cascade would run on top of the modal's own dismissal.
Capture lets us sample modal visibility *before* anyone else handles
the key.

**Modifier guard.** Shortcuts skip when `ctrlKey | metaKey | altKey`
is held so Cmd+R reload, Cmd+= zoom, etc. aren't intercepted. Shift
is fine — it's how `+` and `?` are typed on US layouts.

**ESC priority chain** (top of the keydown handler, before the
shortcut switch):

1. **Open kb-modal first.** The `Typeahead` class bails its own ESC
   when `results.length === 0` (e.g., an empty Go modal), so the
   shortcut module owns ESC for the kb-modal regardless of input
   focus. Closes both modals (idempotent) and `preventDefault`s.
2. **Other foreground modals** (`.modal`) — return without action so
   their own document listener can close them.
3. **Active warp** — return so `warp-button.ts` can run `skipWarp()`.
4. **Editable target** — return so `search.ts` / typeahead can handle
   their own ESC (clear dropdown + blur).
5. Otherwise run the cascade.

### Go / Constellation pickers — DOM relocation

The two pickers reuse the existing `.search-wrap` (topbar) and
`#con-picker` (panel) widgets verbatim. On open, the live element is
moved into `#kb-modal-card` via `appendChild`; on close, it's restored
via `originalParent.insertBefore(widget, originalNextSibling)`. Event
listeners survive the move, so all `Typeahead` behaviour keeps working
unchanged — including OBSERVE-mode rerouting through `warpTo()`,
OBSERVE-only star filtering in `focusRunQuery`, and the None-entry
path in the constellation typeahead.

CSS-only relocation was tried first but rejected: the constellation
typeahead lives inside `data-group="overlays"` and `.panel-inner`,
both of which use `display: none` when collapsed. `display: none` on
an ancestor disables descendants regardless of their own `display`
or `position` — there's no CSS-only way to override it without
unhiding sibling content as well. DOM moves sidestep this entirely.

The Go picker's focus target depends on context: if `#search-to-row`
is visible (navigate mode with a focused star) the To input gets
focus; otherwise the Focus / Location input. `search.ts` already
toggles the row visibility per mode, so the modal automatically
mirrors what the panel would have shown.

### Close triggers

The shared `bindRelocateModal` helper closes on:

- ESC (handled in the shortcut module's capture-phase listener).
- Backdrop click (`.kb-modal-backdrop`).
- Input blur, deferred 180ms — covers `pick()`-then-blur (`Typeahead`
  blurs the input synchronously after `onSelect`), click-outside, and
  ESC inside the input. The 180ms sits just past `Typeahead`'s own
  140ms blur deferral so its result-mousedown race finishes first.
  An `onInputFocus` handler cancels the pending close, so re-focusing
  via the typeahead's X-clear button doesn't tear down the modal mid
  edit.

### Reset (R) scope

R resets only the four sliders under the panel's Camera section —
star size min/max, dynamic range, FOV, exaggeration — by calling the
same APIs that the per-row reset link buttons use:
`clearSizeOverrides(['sizeMin','sizeMax'])`, `clearSizeOverrides(['sizeSpan'])`,
`setCameraFov(DEFAULT_FOV)`, `setStarExaggerationK(getStarExaggerationKDefault())`.
Magnitude / focus / overlays / camera position are deliberately
*not* touched — those are user choices, not "default view" state.

## Per-group collapse in the settings panel

Two layers of collapse: the panel as a whole (top-level, key
`stellata.panel-collapsed`) and each `<section class="group"
data-group="...">` independently (key
`stellata.group-collapsed.<name>`). Both default to expanded;
both persist to `localStorage`. Wired in `panel-layout.ts`. The
group header is the click target — `<header class="group-header">`
with an `<h3>` title and a chevron `<button class="group-toggle">`.
`.row-actions` (reset / all / none) live inside `.group-body`, not
the header, so their clicks don't bubble into the toggle.

## Constellation typeahead

`constellation-typeahead.ts` replaces the old `<select id="con-select">`
with an `<input id="con-input">` + dropdown. Substring filter against
constellation name plus 3-letter IAU code; full alphabetised list shows
when the input is empty and focused. Single-select — picking fires
both `setFilter({ highlightCon })` and `aimAtConstellation`, matching
the prior `<select>` behaviour. Reverse-sync from the `'filter'` event
keeps the input in step with URL restores.

A synthetic `NONE_ENTRY` (`idx: -1`, `search: ''`) is prepended to the
results whenever the input is empty, so users can clear the highlight
by selecting "None" the same way they'd pick any other constellation
(Cmd+A → Delete → Enter). The empty `search` field keeps it out of
filtered results so it can't outrank a real match. `pick()` skips
`aimAtConstellation` when `idx < 0` so the clear path doesn't try to
aim at a non-existent target.

**Master toggle (`showConstellation`).** A `<input id="show-constellation">`
checkbox at the top of the Overlays group gates the entire constellation
overlay — both the highlighted-only-in-navigate and the all-at-once
chart-mode pass, plus the chart-mode Latin-name labels. When off,
`controls.ts` disables `#con-input` and adds `.disabled` to `#con-picker`
(faded sub-label), and a single `C` keypress is a no-op. A **double-tap
on `C`** flips the master toggle in either direction — single taps are
deferred by `C_DOUBLE_TAP_MS` (200 ms) so a second press inside the
window can intercept the picker-open and switch to the toggle action.
Key repeat (held key) is ignored so the flag doesn't oscillate.
`highlightCon` is preserved while disabled, so re-enabling restores
the prior selection. URL flag bit 7 (`FLAG_CON_DISABLED`) encodes the
off state; default (on) is implicit.

## Disabled-control styling

`controls.ts` toggles native `.disabled` on inputs whose state is
preserved-but-frozen, and the panel CSS leans on the standard
`:disabled` selectors so each fade lives in one place:

- `.checkbox-row input[type="checkbox"]:not(:disabled):hover` — only
  *enabled* checkboxes pick up the hover border, so a disabled box
  doesn't look interactive.
- `.checkbox-row input[type="checkbox"]:disabled` — opacity 0.45 +
  muted border so the box itself reads as disabled (matches the
  faded label text).
- `.checkbox-row input[type="checkbox"]:disabled + span` — opacity
  0.55 on the label.
- `.con-typeahead input:disabled` + `#con-picker.disabled .sub-label`
  — same fade on the typeahead row when the master toggle is off.

Two specific freezes use this:

- **Star chart mode** disables `#show-milkyway` (the Milky Way layer is
  hidden under chart anyway, see `docs/chart-mode.md`); `f.showMilkyway`
  is preserved so the toggle restores its prior state on chart-off.
- **`showConstellation === false`** disables `#con-input` and the
  surrounding `#con-picker` styling.

## Reverse-sync in `controls.ts`

Widgets subscribe to `stellata.on('filter', …)` and write DOM from the filter
state. This is how URL restores and `naked eye`/`all` presets update sliders
and chip states. **Setting `.value` programmatically does NOT dispatch
`input`**, so there's no feedback loop. If you add a filter field, remember
to handle it in `syncFromFilter`.

The FOV control reads `stellata.getCameraFov()` directly inside
`syncFromFilter` rather than going through `FilterState` — FOV lives on
the camera, not the filter — but otherwise behaves the same. `setCameraFov`
fires the filter-change handlers so the slider re-syncs after a debug-panel
or URL-restore change.

## Magnitude presets and override flags

Three magnitude presets live in `MAG_PRESETS` (`stellata.ts`): `naked-eye`,
`binoculars`, `all`. Buttons in the panel dispatch on `data-preset` →
`stellata.applyMagnitudePreset(name)`. The preset is the canonical source
of `maxAppMag` and `sizeSpan`, plus angular sizeMin/Max which are converted
to pixels per current viewport.

Per-field override flags (`sizeMinOverridden`, `sizeMaxOverridden`,
`sizeSpanOverridden` on `FilterState`) decide whether a preset switch
or viewport resize gets to write into that field. Slider input sets the
flag; the per-section reset buttons (`size-reset`, `span-reset`) call
`clearSizeOverrides([...])` which clears the flag(s) and writes the
active preset's value back. `maxAppMag` has no override flag — clicking
a preset always sets it; the magnitude slider can still tweak it (and
the value survives viewport resizes since `recomputePresetPxSizes` only
touches sizeMin/Max).

URL state encodes the preset only when not on the default
(`naked-eye`); `mag` only when diverged from the active preset's
value; `smin/smax/span` only when their override flag is true.
Receiver applies the preset first, then layers the explicit overrides
on top. See `docs/url-state.md` for the binary `?v=` format.

**Active-preset highlight.** The reverse-sync in `controls.ts` compares
`f.maxAppMag` against `MAG_PRESETS[*].maxAppMag` (epsilon 0.05) and
toggles the `.on` class on the matching preset button. The match is
value-driven, not click-driven — dragging the slider to 6.5 lights up
"naked eye" the same as clicking it. Styling lives in
`styles.css :.mag-preset.on` (accent colour + faint pill background,
matching `.toggle-btn.on`).

## Field of view

User-facing slider in the panel (`#fov`, 10°–120° / 1° step) plus a reset
button that snaps to `DEFAULT_FOV` = 50°. `setCameraFov` updates
`camera.fov`, calls `updateProjectionMatrix()`, and triggers
`recomputePresetPxSizes` since arcsec/px depends on FOV.

## Debug panel

`window.debug.panel()` toggles the unified debug panel — a draggable,
collapsible host with five sections: Star disc (`star-tuning.ts`),
Milky Way (`milkyway-tuning.ts`), Perf (`perf-hud.ts`), Pin
(`pin-debug-hud.ts`), and Arrows (`arrow-fade-debug-hud.ts`). Drag the
title bar to move it, click any section header to fold/unfold; both the
position and per-section collapse state persist in `sessionStorage`
(resets on reload, since calibration state shouldn't survive between
sessions). The chrome (drag handle, collapsible-section helper,
slider/colour helpers) lives in `debug-panel.ts`. Add a new tool by
writing either a plain section element (collapsible-section + sliders)
or a `{element, dispose, setVisible}` builder and wiring it inside
`togglePanel` in `debug.ts`.

## Star size exaggeration

`#exag` slider in the Camera group — range 1 (Realistic) to 20
(Extreme), step 0.5. Drives `setStarExaggerationK`, which patches the
*active* preset's K (one of `STAR_EXAGGERATION_K_DEFAULTS`: naked-eye
= 12, binoculars = 9, all = 5) and runs `computeMagPresets` to derive
new angular size targets. The slider snaps to the active preset's K
on every preset change, and the reset button restores that preset's
default. Defaults are calibrated per preset because the visible star
population shifts dramatically with the magnitude limit — naked-eye
needs more exaggeration to feel populated, while "all" with ~313k
stars needs a smaller K to avoid the field becoming a solid wash.
Pure physical sizing leaves most stars sub-pixel at typical viewports
— at 50° / 1080-tall, K=1 puts the threshold-disc star at ~0.18 px
and floors it to 1 px. The 1-px floor in `computePresetPxSizes` is
applied symmetrically to sizeMin and sizeMax so the saturation disc
never inverts below the threshold disc at low K.
`recomputePresetPxSizes` additionally enforces `max >= min` post-patch
to handle the case where the user has manually overridden one of the
two and the other gets recomputed to a value that would invert.

## Theme

Locked to dark in the live UI. The `setMonochrome` plumbing on
`Stellata` and the `body.monochrome` palette in CSS are intentionally
retained — `applyTheme('mono')` from the console flips the chart-mode
palette for future repurposing. There's no longer a UI toggle and the
theme is not part of the URL `?v=` state.

## Layout containers: `.ui-top-left`, `.ui-top`, `.ui-bottom`

The whole overlay UI is three pure-CSS fixed containers — **no breakpoints,
no JS measurements**. An earlier attempt used `ResizeObserver` to drive
`panel.style.top` / `maxHeight`; the user explicitly rejected that ("use
native html/css... we shouldn't dictate layout"). Do not reintroduce it.

- `.ui-top-left` — fixed top-left, holds the brand box. Independent of
  `.ui-top` so the right-side stack's width / wrap behaviour stays
  untouched.
- `.ui-top` — fixed top-right, `flex-direction: column`, bottom-bounded.
  Children in DOM order: topbar ("Navigate" heading + Focus/To search),
  then panel (Settings). Because panel is a flex child below the topbar,
  it can never overlap it — no measurement needed.
- `.ui-bottom` — fixed full-width along the bottom, `flex-wrap: wrap`,
  `align-items: flex-end`. Children: scale-bar widget (left, see
  §Bottom-left widget below), meta (right, with `margin-left: auto`
  for pull-apart). When the row doesn't fit, wrap puts them on
  separate rows naturally.
- `.meta` is just the catalog count (`.meta-count`, e.g. "313,242
  stars"). Focused-object name + distance moved into the scale-bar
  widget's z-axis indicator, where they sit alongside the camera-to-
  focus distance for a single consolidated readout.
- Both containers set `pointer-events: none` on themselves and `auto` on
  direct children, so clicks fall through empty regions to the canvas.

## Bottom-left widget: scene-scale bar + focus z-axis indicator

`scale-bar.ts` is a single SVG with two parts that can show
independently:

**Horizontal scale bar (always visible).** Targets ~20% of viewport
width; `niceRound` snaps the represented distance to a 1/2/5×10^N
value, then the bar's pixel width tracks `nicePc × pxPerPc` exactly so
it lands on a clean number. Three internal ticks at 25/50/75% break
the length up so the user can read sub-divisions without thinking.
Label is centred on the **right endcap**, not the bar midpoint —
internal ticks made a midpoint-anchored label read as "this distance
applies to the nearest tick". In OBSERVE mode the bar switches to
angular-extent-of-sky in degrees (FOV-driven) since "scene scale at
camera-target depth" is meaningless when the camera sits on the focal
star.

**Perspective z-axis indicator (visible when a star or cloud is
focused, hidden in OBSERVE).** A 10vw line rising from the bar's left
endpoint at the projected angle from there to the focused object's
on-screen position — the line literally aims at what it labels. When
the projection is unusable (target behind camera, delta < 4 px,
pre-layout) the line falls back to a default 45°. Clamped to the
upper hemisphere (`-165°` to `-15°`) so heavy panning can't fold the
line below the bar. The tip carries a ⇥-style endcap (perpendicular
bar bracketing a triangular arrowhead) representing the "object
plane"; the focused object's name rides along the projected
continuation of the line a few px past the tip with text running
horizontally; the camera-to-focus distance is rotated along the line
itself.

**Unit auto-switch.** Both labels (bar value and z-axis distance) use
`fmtDistAuto` from `distance-util.ts`: pc/ly above 0.01 pc (respecting
the user's pc/ly toggle), AU below. The threshold is a one-way switch
where "0.005 pc" reads as awkward but "1031 AU" lands in the user's
mental Voyager / outer-Oort frame of reference. Sub-AU readings stay
in AU with 3-decimal precision (orbit floor for Sol-class is ~0.005
AU, so we never need scientific notation in normal use). See
`distance-util.ts AU_SWITCH_PC` for the constant.

**Warp behaviour.** While a warp is in flight, the z-axis indicator
shows the source while the camera is on the source side of the warp
axis, then flips to the destination once `(camera − A) · (B − A) > 0`.
Trajectory-relative test, not camera-attitude — stays stable under
future curved-warp paths (a7d.2.9). Reads `Stellata.getWarpInfo()` for
the destination identity + endpoints. The horizontal scale-bar
behaviour is independent: its scene-scale already targets B from warp
start (since `controls.target` is repointed at B at warp launch — see
`docs/camera-warp.md` § Scale-bar smoothness).

**SVG sizing.** `overflow: visible` on the SVG so off-default-angle
z-axis lines and long names extend past the SVG bounds without being
clipped (the widget is non-interactive, so overflow is fine). The SVG
height is computed for the worst-case (default-angle) z-axis projection
regardless of actual angle or visibility, so the bar's screen position
is steady across focus/unfocus and any line angle.

## `[hidden]` specificity and `.modal { display: grid }`

The HTML `hidden` attribute maps to `[hidden] { display: none }` in the UA
stylesheet — specificity (0,1,0). `.modal { display: grid }` has the same
specificity (0,1,0), and site stylesheets win ties, so `modal.hidden = true`
had **no visible effect** on the modal. Fixed globally with
`[hidden] { display: none !important; }` in `styles.css`. If you add
another class that sets `display` on an element that may be `hidden`ed
imperatively, you're already covered — but don't remove the `!important`
rule.

## `backdrop-filter` creates stacking contexts

Both `.topbar` and `.panel` use `backdrop-filter: blur(6px)`, which
silently creates a stacking context. Children's `z-index` is then clamped
to that context — so `.search-results` with `z-index: 12` inside `.topbar`
was painted **below** `.panel` (which has no z-index but appears later in
DOM order). Fixed by giving `.topbar` an explicit `z-index: 1` to lift its
whole context above `.panel`. If you add more blurred panels, remember
that every one of them is a new stacking boundary.
