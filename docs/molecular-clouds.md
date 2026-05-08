# Molecular cloud overlay

> **Status (v1.0):** Shelved. `FilterState.showMolecularClouds` defaults
> to `false`, the user-facing toggle is removed from the panel, and the
> URL flag bit 2 is reserved (no longer encoded). The render path,
> shaders, build script, and data files are all preserved so the layer
> can be re-enabled with a default flip once the visual treatment is
> refined. Chart-mode integration (`setCloudsIsobar`) is still wired
> against the now-invisible group.

`molecular-clouds.ts` renders ~96 named local SF clouds as soft warm
ellipsoids. Originally default-on with a toggle in the Galactic-overlays
panel section; in v1.0 the toggle is gone and the layer renders nothing.
Stays visible during warp by design (flying past Taurus is a feature,
not noise) — relevant once re-enabled.

**Data:** `public/clouds.json` is the merged output of `build-clouds.py`:
- Z2021 Table 1 → 12 ellipsoid clouds with axis-aligned bounding boxes in
  galactic Cartesian. The bbox is converted to centroid + semi-axes; the
  orientation `quat` is the GAL_TO_ICRS rotation so the ellipsoid local
  axes correctly point along galactic +X/+Y/+Z when scaled by the renderer.
- Z2020 Table A1 → 84 sphere clouds (sightline-aggregated by name; sphere
  radius = max distance of any sightline from the centroid, with a 5 pc
  default for singletons and a 3 pc floor). `quat` = identity.
- Z2021 entries take precedence over Z2020 for the clouds both cover
  (Chamaeleon, Ophiuchus, Lupus, Taurus, Perseus, Pipe, Cepheus, Corona
  Australis, Orion → A/B/λ split). Sub-regions like `Ophiuchus_Arc` /
  `Pipe_B59` stay separate Z2020 spheres.

**Render:** every cloud is one shared `SphereGeometry(1, 32, 16)` mesh
scaled per-instance to its semi-axes and rotated by its quaternion. The
fragment shader derives a smooth view-direction-based density —
`pow(|n·v|, 1.5)` — so silhouettes fade rather than hard-edge. Material
uses `DoubleSide` so the layer reads correctly when the camera is inside
a cloud. **Premultiplied alpha** is critical: the shader bakes intensity
into rgb (`vec4(col × intensity, intensity)`) and the material sets
`premultipliedAlpha: true`, so additive blending becomes `(ONE, ONE)` —
without it, src.alpha multiplies into rgb a second time and the cloud
comes out ~30× too dim to see. The shaders also avoid the `#version
300 es` directive and don't redeclare auto-injected attributes
(`position`, `normal`, `modelMatrix`, etc.); doing either silently
breaks the GLSL3 compile. Mono mode swaps to a soft warm grey with
normal alpha-over.

**Unified focus / measurement / warp UX.** Clouds are full participants
in the click-state machine alongside stars. Internal state holds two
mutually-exclusive pairs: `focusedStar` / `focusedCloud` and `vectorTo`
(star idx) / `vectorToCloud`. The click handler dispatches by what was
picked under the cursor — a cloud pick from a star focus sets a
star→cloud measurement vector; a cloud pick from a cloud focus sets a
cloud→cloud vector; clicking the current vector tip (star or cloud)
triggers the appropriate teleport (`focusStar` or `flyToCloud`); pressing
W or clicking the distance label dispatches to `warpTo` or `warpToCloud`
based on which vector slot is active. The two cloud-specific carve-outs
are (a) no focus ring (the SVG overlay reads `getFocusedStar` only and
naturally ignores `focusedCloud`) and (b) arrival distance is
`cloudViewingDistancePc` (= `2.4 × max(axes)`, with a 5 pc floor)
instead of `minDistForStar`.

**Picking + hover:** per-cloud `Mesh` objects participate in
`THREE.Raycaster` intersection via the cloud `Group`.
`Stellata.pickCloud` does the raycast; the click handler in
`onPointerUp` falls back to a cloud pick when no star is hit (stars take
priority because they're the smaller, more precise target), and
`bindHoverTooltip` does the same fallback so hovering over a cloud's
body shows its name + distance + axes in the existing tooltip element.

**Search:** cloud entries share the same Fuse fuzzy index as star
entries, discriminated by a `kind: 'star' | 'cloud'` tag. The Focus
search box dispatches by kind — cloud picks call `flyToCloud` (teleport
to viewing distance + set cloud focus); the To (distance vector) box
accepts both, dispatching to `setVectorToCloud` for cloud picks.

**`setOrbitTargetCloud(cloudIdx)`:** the click-without-focus path —
mirrors `setOrbitTarget` for stars. Moves orbit pivot to the cloud
centroid and sets the cloud focus, but leaves the camera position
unchanged. Camera doesn't teleport; user pivots around the cloud from
their current vantage. Calls `setFocusedCloud` first, which clears any
star focus; since a7d.2.11 the floating origin stays at the former
focal star instead of snapping back to Sol, so the cloud's absolute
centroid is converted to local-frame coordinates by subtracting
`worldOffset` before assigning to `controls.target`.

**`flyToCloud(cloudIdx)`:** the teleport path — used by search-select
and click-vector-tip. Mirrors `focusStar`: clears prior focus + vector,
positions camera at `cloud.centerAbs + viewDir × cloudViewingDistancePc`,
and sets the cloud focus. Snap, not animation; for animated travel the
user warps via the distance label.

**`warpToCloud(destIdx)`:** the cloud-destination warp. Source point is
the currently-focused star OR cloud (`currentFocusLocalPos`); destination
is the cloud's centroid; arrival offset is `cloudViewingDistancePc`. The
internal `WarpState` carries a `destKind: 'star' | 'cloud'` discriminator
so `finishWarp` parks at the right point and dispatches to either
`setFocus` or `setFocusedCloud` on arrival.

**Floating-origin handling:** clouds live in absolute ICRS space; the
group's `position` is rebased to `-worldOffset` per frame, the same
pattern as `GalacticDisc`. So focusing on a far star (which shifts the
floating origin to that star's absolute position) doesn't move clouds
visually — they stay anchored where they should.

**URL state:** cloud focus and the cloud measurement vector ride in the
shared `?v=` blob (mutually exclusive with star focus and the star
measurement vector respectively). The MC overlay disable flag also
lives there (flags-byte bit 2, default-omitted since the layer is
default-on).

**Dev-console levers** under `stellata.cloudLayer.*`:
- `setOpacity(x)` / `setColor(0xRRGGBB)` — dark mode tuning
- `setMonoOpacity(x)` / `setMonoColor(0xRRGGBB)` — chart mode tuning
- `setDebugBoost(strength)` — force max-opacity (or `null` to restore);
  use this first when "I can't see anything" to confirm the layer is
  rendering at all.
