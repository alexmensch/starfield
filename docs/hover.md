# Hover labels

The hover-label subsystem (`src/client/hover/`) surfaces a small floating
card next to the cursor after a 280 ms dwell. One engine, many providers:
each renderable layer (stars, Sol planets, Local Group wireframes,
heliopause apex, future nebulae / Radcliffe Wave segments / probes)
implements `HoverProvider` and registers with the engine; the engine
owns the pointer listener, the dwell timer, the cross-provider
disambiguator, and the `#tooltip` render.

## Architecture

- **`hover-engine.ts`** — canvas pointer listener, 280 ms dwell, 14 px
  pick threshold, hide-on-drag / hide-on-leave / hide-on-pointermove
  gating, tooltip placement and on-screen clamping. Provider-agnostic;
  pulled out of the prior `bindHoverTooltip` so future layers wire in
  without engine edits.
- **`hover-types.ts`** — the `HoverProvider` contract:
  `pick(event) → HoverHit | null` and `format(hit) → HoverPayload`.
  `HoverPayload` is `{ name, lines: string[] }` — at most ~5 sub-lines
  per the design gate so the card stays glanceable.
- **`hover-pick-disambiguator.ts`** — when multiple providers return a
  hit for the same cursor position, pick the closest to the camera, with
  the prime/fallback tier as the higher-priority key. Prime always beats
  fallback regardless of camera distance.
- **`*-hover-provider.ts`** — one per layer. Owns the pick path,
  typically mirroring the renderer's draw predicate (see Rule 2 below).
- **`formatters/*-hover-format.ts`** — one per layer. Pure functions
  with their own vitest coverage; the provider calls into them.

## UX conventions

These rules apply to every provider and to any future always-on hover
affordance added later (click-to-pin, sticky tooltips, mobile-touch
hover analogue, etc.).

### Rule 1 — Spell out unit / quantity terms

Sub-lines write quantity names out in full (`Radius`, `Period`, `Vmag`)
rather than the bare initial letter (`R`, `P`, `V`). Single-letter
labels are too compressed for the user's eye to parse at a 280 ms hover
delay; the user has time to read a word.

`Vmag` is the canonical shorthand for V-band apparent magnitude in this
UX. Use `Vmag` verbatim in new providers that surface a V-band apparent
magnitude.

The prefix convention is for measured-quantity sub-lines, not for
free-form location strings. The bare distance-and-context first line
is fine without a label when it reads as a location (`Lyra · 7.1 pc`,
`0.310 AU · Vmag -2.5`).

### Rule 1a — Line ordering for object cards

The planet hover card layout:

```
<name>
<distance> · Vmag <m>
Period <years> yr
Radius <km> km
```

Reasoning: the distance line pairs naturally with apparent magnitude
(both are observer-relative quantities that change as the camera moves).
Period sits on its own line directly under the distance because orbital
period is the user's first "is this a fast inner planet or a slow outer
one?" tell, and reading it just below the AU distance keeps the
cause-and-effect (closer orbits ⇒ shorter periods) on adjacent lines.
Radius sits on the bottom as the physical-body fact that doesn't change
with viewpoint.

Layout shape (distance+mag line, then per-quantity stack lines)
generalises to other layers: observer-relative quantities on the first
sub-line; intrinsic per-object quantities on their own lines below.

### Rule 2 — Visibility ⇒ hoverable. No focus-gate on hover.

Hover providers do NOT gate `pick` or `format` on the focused-host or
focused-star state. Any object the user can see on screen — and only
objects the user can see — should surface a hover card.

How to apply:

- Providers gate ONLY on visibility — magnitude-cutoff for emissive
  objects, distance / extent culling for wireframes, layer-shelved flags
  for un-registered providers. The same visibility logic the renderer
  uses to decide "draw this quad or not" is the right gate.
- For the planet layer specifically: the planet shader emits no quad
  when `appMag > maxAppMag + 0.5`; the picker mirrors that exact kill
  condition. NO additional gate on `focusedPlanetSystem !== null`.
- For heliopause: gate on `heliopause.isVisible()` (mirrors
  `group.visible` — the actual rendered shell state). Any future
  user-toggle AND's into `group.visible` and the hover surface follows
  for free.

When designing or auditing a new hover provider, walk through this
checklist:

- What's the renderer's "is this drawn?" predicate? Mirror it in the
  picker.
- Is there ANY state about focus / selection / route / mode involved in
  the gating? If yes, that's wrong — strip it.

### Rule 3 — Whole-object hit surface for extended visible objects

For extended objects whose silhouette occupies meaningful screen real
estate (heliopause shell, molecular clouds, future nebulae, Radcliffe
Wave segments, large DSOs), hover hit-tests the WHOLE projected
silhouette plus the SVG label's bounding rect (when present), not a
centroid + small radius. Tier is fallback so stars and planets visible
"through" the object still win their own prime hover via the
cross-layer disambiguator.

Different layers have different natural pick mechanisms — reuse the
existing one rather than rolling a new pickbox:

- **Three.js raycast against the rendered mesh** (clouds, via
  `MolecularClouds.raycast`) — naturally hits the whole ellipsoid
  silhouette.
- **Projected sample-point AABB** (heliopause, via
  `HELIOPAUSE_SAMPLE_POINTS_LOCAL` — the same 62 silhouette samples the
  label engine already projects every frame; shared via export so the
  hover surface can't drift from the label).
- **Per-object angular-size disc** (Local Group wireframes — already
  small enough that the disc reads as "the whole object").

When the layer has an SVG label, also hit-test the label's
`getBoundingClientRect()`. Pull the element id from a shared exported
constant (e.g. `HELIOPAUSE_LABEL_ELEMENT_ID`) so the picker and the
label engine can't drift. The bounding rect returns zero-width-zero-
height when the element is `display: none`, so the inside-bbox check
harmlessly fails whenever the label engine has hidden the label — no
extra visibility plumbing needed for the label gate.

Compact objects (stars, planet bodies, individual catalog rows) keep
the centroid + small-radius pickbox pattern. The "extended object"
trigger is "the user sees it as a shape", not "the layer has > N
rows".

When a second extended object needs the same projected-sample-AABB
approach, lift the inline logic to a helper that accepts the
sample-point iterator + label element id, parameterised on the
per-layer geometry source — per the DRY-at-second-usage rule.

### Rule 4 — HTML hover-card typography stays monospace, even in chart mode

The `#tooltip` element is an HTML overlay, not an SVG annotation. In
chart mode the `body.monochrome .tooltip` CSS rule flips background +
text colour to the paper palette (white card, dark ink); that's
sufficient for the paper aesthetic. Do NOT additionally swap the
tooltip's font-family to match the chart-labels engraved sans-serif
glyphs — the whole HTML UI (panel, search, topbar, modals) stays
`var(--font-mono)` in chart mode, and a sans-serif tooltip breaks that
visual consistency.

The boundary is HTML-vs-SVG, not chart-vs-not-chart:

- **New HTML overlay surfaces** (tooltips, cards, modals, future
  hover-equivalent affordances): inherit `var(--font-mono)` from `body`
  and stay that way in both default and chart modes.
- **Chart-mode-specific styling for HTML overlays** is limited to
  background, colour, and border treatments — typography stays mono.
  The existing `body.monochrome .tooltip` rule is the template.
- **SVG annotations** (chart-labels, chart-glyphs,
  distance-vector-overlay, etc.) are the surfaces that adopt the
  engraved sans-serif look in chart mode.
- Backdrop-filter blur is fine in chart mode on HTML overlays — the
  panel keeps it, the tooltip should keep it. The "paper isn't glassy"
  intuition is overruled by "match the panel".
