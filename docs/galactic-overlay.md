# Galactic reference system

Three layers anchor the local star clump against the Milky Way's geometry:
the galactic disc outline (always-on midplane ring + bulge wireframe), the
toggleable galactic coordinate sphere, and the HUD layer (Sol/GC arrows
plus the OBSERVE-mode ring). Together they give the user "which way is
out, and how far am I from the centre" without obscuring the local stars.

**Shared module** `galactic-coords.ts` exports `GAL_TO_ICRS` (Matrix4)
and `GALACTIC_CENTRE_PC` (Vector3 at R₀ = 8.122 kpc), built from the
J2000 IAU galactic-pole and galactic-centre angles with explicit
re-orthogonalisation. The Milky Way volumetric layer
(see `docs/milky-way.md`) reuses these constants directly — keep the
module minimal and stable.

**Galactic disc outline** (`galactic-disc.ts`) — *always on in dark mode,
hidden in chart mode*. A 15 kpc midplane ring, two thickness rings at
±400 pc, and a 3 kpc × 1.5 kpc bulge wireframe (three orthogonal ring
loops in the galactic frame), all centred on the galactic centre — Sol
sits ~8 kpc *inside* the disc, not at its middle. Each ring is a basic
`LineLoop` whose vertices are pre-baked once into absolute ICRS via
`GAL_TO_ICRS` plus the GC offset; per frame `discGroup.position` is
rebased to `-worldOffset` (via `.copy(worldOffset).negate()` on the
group's own position vector so the shared `worldOffset` is never
mutated). Opacity smoothsteps from 0 to 0.55 between **500 pc and 5 kpc**
distance-from-Sol so the disc stays out of the way for local browsing
and reveals as the user zooms out. In chart mode the layer is hidden
entirely — a 15 kpc reference ring reads as visual noise on a paper-chart
aesthetic, and the arrows + sphere already provide orientation.

**Galactic coordinate sphere** (`galactic-grid.ts`, toggleable) —
equator + 16 latitude rings every 10° (range −80° to +80°) + 36
meridians every 10°, radius 50 kpc.

- The **equator** is a `Line2` with `LineMaterial` (from
  `three/examples/jsm/lines/`) at 2.4 px screen-space width — basic
  `LineBasicMaterial.linewidth` silently clamps to 1 in WebGL on most
  platforms, so Line2 is the only reliable way to get a thicker stroke.
  256 segments around the full loop; the small joint-wedge "ticks" you
  may notice are an inherent artefact of fat-line miters at non-trivial
  angles. `LineMaterial` requires its `resolution` uniform to track the
  canvas, so `Stellata.onResize` calls `galacticGrid.setResolution(w, h)`.
  Bumping segment count to 1024 hides the ticks but was rejected as
  visually similar; we kept 256.
- **Latitude rings + meridians** are basic `LineLoop` / `Line` at 0.45
  opacity. The polar bunching of 36 meridians is eased by trimming
  every other meridian (l = 10°, 30°, …) to ±80° latitude — the
  every-20° set still goes pole-to-pole unbroken.
- **No pole markers.** Earlier iterations had small + crosses at
  NGP/SGP; they read as visual clutter and were dropped.
- The whole sphere tracks the camera each frame
  (`gridGroup.position.copy(camera.position)`), so it conceptually
  represents "the sky from here". Orientation is fixed in absolute
  galactic space so b=0 / l=0 stay correctly aimed through any camera
  move including warp.

**Sol + Galactic Centre arrows** (part of the HUD — `hud-overlay.ts`,
toggled by `filter.showHud`, separately from the sphere/grid). Rendered
as **SVG** paths inside `#overlay`, not 3D meshes. Geometry is computed
entirely in screen space:

1. Project the origin (focused star's local position when focused, else
   `controls.target`) into screen pixels. If the projection is degenerate
   — the OBSERVE steady state, where the camera sits at the focal star —
   fall back to screen centre. Same fallback applies for the rare frames
   near a transition endpoint where the focal-star projection collapses.
2. Derive the projected arrow direction in 2D. Two paths, picked by which
   one is well-defined this frame: (a) project an auxiliary point a small
   step along the 3D direction from `origin` and take the screen-space
   delta — gets perspective right when `origin` ≠ camera; (b) fall back
   to the direct screen vector from the anchor to the projected target —
   the aux-step collapses when `origin` sits at the camera (OBSERVE
   steady state, where the camera is parked at the focal star), and a
   target-projection from the screen-centre anchor gives the right
   angular direction since camera == origin in that case.
3. Build `shaftStart = originScreen + shaftStartPx × screenDir` and `tip =
   shaftStart + shaftLengthPx × screenDir`, both in pixels. The shared
   `buildArrowSvgPath` helper emits the chevron arrowhead perpendicular
   to the projected shaft, so the wings always face the camera by
   construction (no 3D billboard math required). `shaftStartPx` is mode-
   aware (see "Shaft start radius" below) so the arrows attach to the
   visible ring — focus ring in navigate, HUD ring in observe — and lerp
   smoothly through the transition.

Critical invariant: `shaftStartPx` is applied in **screen space**, not
3D world space, so the gap from anchor to shaft start is always exact
regardless of how aligned the arrow's 3D direction is with the camera
view axis. This is what makes the navigate-mode arrows clear the 24 px
focus ring at every viewing angle (28 px = 24 + 4 halo gap), and what
makes the observe-mode arrows attach to the HUD ring rim at every FOV.
Computing the offset in 3D world space and then projecting (the obvious-
but-wrong approach) collapses the gap to sub-pixel when `dir` is parallel
to the view axis, and the shaft ends up inside whichever ring is meant
to clear it.

`shaftLengthPx` is nominally `ARROW_PIXEL_LENGTH = 110` but cinches
inward when the projected target sits inside the nominal shaft: the
target's local-frame position is projected and its screen offset along
`screenDir` gives `projAlong`. If `projAlong < 110 + shaftStartPx +
sizeMax`, the shaft shortens so the chevron tip sits `sizeMax` px short
of the target — keeps the arrow from crowding (or overlapping) the
target's rendered disc when zoomed in close. `sizeMax` is the
camera-panel "Max" pixel size. Below 8 px of remaining shaft we hide
rather than draw a stub.

Arrow hidden when the projected direction is < 1 px long (camera is
looking exactly along the arrow's 3D direction); rare and there's no
useful 2D direction to draw. Sol arrow also hidden when focused on Sol —
pointing at yourself adds nothing.

**HUD ring.** A translucent screen-centred circle drawn in OBSERVE mode
(and during the navigate↔observe transition) when `showHud` is on. The
ring's radius is fixed in **angular** units — it represents a constant
visual cone in the camera's field of view, so its on-screen pixel radius
scales **inversely with FOV**:

```
ringRadiusPx(fov, sizeMaxPx) = 5 × sizeMaxPx × (10 / fov)
```

Anchor: at the narrowest FOV (10°) the radius is `5 × f.sizeMax` — the
factor of 5 keeps the ring legibly large at typical FOVs (raw `sizeMax`
is single-digit pixels and would render as a dot). Above 10° the ring
shrinks `1/fov`, keeping the same angular size. Tying the anchor to `sizeMax` keeps the ring on the same visual
scale as the brightest stars in the scene; widening the camera FOV makes
both the stars and the ring shrink in lockstep, so the ring stays a
small but visible HUD widget at any zoom. The Sol/GC arrows attach to
the rim and swivel around it as the user looks around — the ring is the
visualisation of the conceptual "starts at this angular distance"
attachment point.

During the navigate→observe transition the ring grows from radius 0 to
`ringRadiusPx`, eased by the same `f` that drives `updateObserveTransition`.
The reverse direction shrinks it back to 0. The focus ring
(`focus-ring-overlay.ts`) does the opposite — its 24 px radius lerps to
0 on enter, back to 24 on exit — so the two circles morph through each
other and the arrows feel continuously attached to whichever circle is
dominant. The eased progress is exposed by
`Stellata.getObserveTransitionProgress()`.

**Shaft start radius (unified).** `hud-overlay.ts` computes a single
`shaftStartPx` per frame as `activeRing + RING_HALO_GAP_PX` (4 px), where
`activeRing` is whichever ring is dominant this frame:

| State                                   | `activeRing`                                   |
| --------------------------------------- | ---------------------------------------------- |
| Navigate, no transition                 | `FOCUS_RING_RADIUS_PX` (24)                    |
| Observe, no transition                  | `ringRadiusPx(fov, sizeMaxPx)` (= R)           |
| Enter transition (`navigate → observe`) | `max(24·(1-f), R·f)`                           |
| Exit transition (`observe → navigate`)  | `max(24·f, R·(1-f))`                           |

So the arrow shaft sits 4 px outside whichever circle is currently
visible — same halo gap in both steady states, smooth lerp through the
transition. In the OBSERVE steady
state the focal-star projection is degenerate (camera sits at the focal
star), so the anchor falls back to screen centre — and the post-
transition switch is invisible because the projection has already drifted
to centre by `f = 1`. Distance labels measure from `origin` (the focal
star or `controls.target`) so the displayed distance reflects "from the
focal star", which is meaningful in both modes.

SVG distance labels (`#sol-arrow-label`, `#gc-arrow-label`) sit at
`tip + (LABEL_OFFSET_PX + ARROW_HEAD_DEPTH_PX, -LABEL_OFFSET_PX)` —
same exact offsets as the distance vector's label. Labels are
**clickable** (`pointer-events: auto` + cursor:pointer) — clicking
either invokes `Stellata.aimAt(localPoint)` which slerps the camera
around `controls.target` to centre the named object in view. Duration
scales with rotation angle, capped at 2 s and floored at 250 ms;
TrackballControls is disabled for the duration so its damping doesn't
fight the slerp. In-flight aim is superseded if a warp starts.

**Shared arrow path** (`arrow-path.ts`) — the `buildArrowSvgPath(shaftStartX,
shaftStartY, tipX, tipY)` helper builds shaft + chevron arrowhead given
two screen-space endpoints. Used by both the distance vector overlay and
the Sol/GC arrows so all three on-screen arrows share one silhouette,
one chevron size (5 × 4 px), and one label-placement convention. Also
exports `ARROW_LABEL_OFFSET_PX` and `ARROW_LABEL_PADDING_PX`.

The **distance vector** (`distance-vector-overlay.ts`) was unified onto
the same path during Phase 4c — it's now a solid shaft + chevron rather
than a chain of repeated chevrons. Symmetric 28 px insets from each
star (was asymmetric 28/14). Label format unified to
`<destination name> · <distance>` (matches Sol/GC's `<target> ·
<distance>` form), and the label is anchored at the chevron tip with
the same offset as the Sol/GC labels rather than at the vector midpoint.
The warp suffix follows by full label width (label switched from
`text-anchor="middle"` to `start`).

**State + UI:** two independent FilterState booleans:

- `showGalacticGrid` — gates the 3D grid sphere only. URL `grid=1`,
  default-omitted. Panel checkbox lives under **Overlays**.
- `showHud` — gates the HUD: Sol/GC arrows in both modes, plus the
  OBSERVE-mode ring. URL `hud=1`, default-omitted. Panel checkbox lives
  under **Navigation** ("Head up display (HUD)") since the HUD's role is
  navigational orientation. Future HUD widgets hang off the same flag.

The disc has no toggle by design — it's the orientation primitive the
catalog itself was missing, and is hidden in chart mode anyway.

**Chart mode** (see `docs/chart-mode.md`):
- Disc layer hides entirely (the 15 kpc reference ring reads as
  visual noise on a paper-chart background).
- Sphere + grid swap stroke colour to dark grey (`#3a3530`), no
  transparency, no blending. The equator/line opacity split is dropped
  in chart mode (paper-chart aesthetic doesn't fade).
- Sol/GC arrows + HUD ring + POI ring/arrow/labels all flip to a deep
  saturated blue palette (`rgba(30, 64, 175, 0.85)`, the existing
  `--accent` token) with white halos on labels — distinct from
  pure-black chart ink so the HUD reads as a separate navigational
  layer. Strong contrast against the beige paper background (~7:1).
  Distance vector keeps a separate dark slate stroke since it's a
  measurement, not part of the HUD. All routed via CSS on
  `.gal-arrow*`, `.hud-ring`, `.poi-*`, and `#dist-line*` — no
  per-frame palette logic; `setMonochrome(on)` on `HudOverlay` is
  intentionally empty since the SVG class routing handles it.

**Warp visibility:** `updateGalacticLayers` hides the 3D disc + grid
groups while `warpState !== null`; SVG arrow paths and labels are
hidden via the existing `body.warping #overlay { display: none }` rule.

**Camera matrix freshness:** `updateGalacticLayers` calls
`camera.updateMatrixWorld()` before any SVG projection. `controls.update()`
mutates `camera.position`/`quaternion` but doesn't propagate to
`matrixWorld`/`matrixWorldInverse` — the renderer would do that for us,
but the SVG projection runs *before* `renderer.render()`, so without
this call the labels lag by one frame during fast camera moves.
