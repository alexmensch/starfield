# Solar-system layer

Solar-system layer (`stellata-3re`). When a focusable star carries a planet
system, Stellata renders the planets as billboarded discs at their
heliocentric positions, faint orbit rings on the host's orbital plane,
and (Sol only) the heliopause boundary as a translucent asymmetric
shell. Sol is the only populated host in v1; the framework is
deliberately generic so the future exoplanet epic (`stellata-bk5`)
can plug in without changing the renderer.

## Data model

`planet-system.ts` defines the contract every host's planet system
satisfies:

- `Planet` — name, equatorial radius (km), semi-major axis (AU),
  eccentricity, type (`rocky` / `gas_giant` / `ice_giant`),
  representative RGB colour.
- `PlanetSystem` — host star catalog index, `planets` array,
  optional `positionsAt(t, out)` resolver writing 3 floats per planet
  in the host's local orbital-plane frame, optional
  `orbitOrientations` for the orbit-ring renderer.

Sync probe: `hasPlanets(catalog, idx)` — v1 hardwires "planets ⇔ Sol".
Async resolver: `getPlanetSystem(catalog, idx)` returns the system or
`null`. The Promise wrapper is intentional so `bk5` can lazily fetch
per-host JSON shards without changing the call sites.

`SOL_PLANETS` is the eight major planets + Pluto with constants
sourced from NASA Planetary Fact Sheets (radii) and JPL DE440 (mean
elements at J2000). Pluto comes from New Horizons 2015 reconnaissance.
See `SCIENCE.md` §Solar system for the citation rationale.

## Ephemerides

`ephemeris.ts` implements the **JPL Standish 1992 Keplerian-elements
approximation** with the cubic Jupiter–Neptune correction terms
(Table 2a/2b inlined). Sub-arcminute accuracy 3000 BC – 3000 AD,
which is overkill for billboarded discs that floor at ~2 px regardless
of zoom. VSOP87 was rejected during 3re.3: the precision difference is
invisible at user-reachable framings and the dependency cost was not
worth it. Deep-time (sub-arcminute outside Standish's window) is filed
as `stellata-1gh`.

Returned positions are heliocentric **ecliptic** parsecs, not ICRS —
the rotation onto ICRS happens in the caller via the per-host
orbital-plane orientation quaternion. Sol's quaternion is the J2000
obliquity rotation; future exoplanet hosts (`bk5`) get a galactic-
plane-aligned default per the 3re.8 rule below.

Per-`t` cache granularity is 60 seconds. At billboarded-disc pixel
scale, sub-minute planet motion is invisible — Mercury moves ~3e-5 rad
seen from Earth over 60 s, well below pixel resolution at any zoom we
afford. The cache key is `t / CACHE_GRANULARITY_SEC` floored, so
multiple frames within the same minute reuse the same `Vec3` triplet.
A future time scrubber (`stellata-nmu`) reducing the granularity to
sub-second is straightforward — the cache key just bucketises finer.

## Time `t` and the readout

`time.ts` defines `t` as a Unix-seconds double. v1 pins it to "now"
via `Stellata.getT()` returning `Date.now() / 1000`; the time scrubber
(`stellata-nmu`) plugs in via `Stellata.setT()`.

`time-readout.ts` renders the live UTC timestamp the planet positions
correspond to in `.ui-bottom`'s `#time-readout`. Visibility tracks two
gates:

1. The focused star carries a planet system (`hasPlanets`).
2. No camera transition (warp / observe-enter / observe-exit) is in
   flight — the readout would flash mid-warp otherwise.

Format is UTC Zulu: `YYYY-MM-DD HH:MM:SS UTC`. `isLive(t)` is true
when `|t − now| < 1 s`; in that case the readout appends "(live)".
Once a scrubber lands, scrubbed values drop the suffix.

`t` is **independent of `uTime`**. `uTime` is the cosmetic clock that
drives variable-star pulsation and keeps ticking at
`uSecondsPerDay = 0.2` regardless of what `t` is. Variable-star phase
must never read from `t`.

## Planet rendering

`star-system.ts` owns the per-host orbit rings + planet bodies layer.
Each frame, when a planet system is attached:

1. Call the system's `positionsAt(t, scratch)` to refresh local-frame
   positions (or fall back to a static placeholder if absent).
2. Apply the per-host orientation quaternion to rotate from local
   orbital-plane → ICRS.
3. Upload positions to the planet billboard mesh as instance
   attributes.

Planets are rendered as billboarded discs (similar to stars). The
fragment shader hard-edges the disc — no halo, no extended
atmosphere, no banding, no axial-tilt cue. Detail rendering is
**deliberately deferred** to the planet-zoom epic (`stellata-2f6`):
at every camera-to-body distance the user can currently reach, every
planet floors at the disc-pixel minimum (~2 px), so per-texture
detail would be invisible regardless of how much shader work goes
into it. See the `defer-detail-until-zoom-affordance` rule in
`CLAUDE.md`.

`planet-labels.ts` draws per-planet body-anchored SVG labels above
the canvas. The label engine is independent of the chart-mode label
engine (`chart-labels.ts`); planet labels are always-on when a planet
system is attached, and hidden in chart mode so the chart-mode glyph
contract isn't doubled up.

## Orbit rings

The orbit-ring layer (`star-system.ts` again) draws each planet's
orbit as an ellipse with the host star at one focus. Geometry:
`b = a · √(1 − e²)`, focal offset `c = a · e`. v1 places the
perihelion along the local +x axis as a placeholder; per-planet
longitude-of-perihelion landed alongside Standish elements in 3re.13.

Ring visibility is gated on an angular-separation heuristic so
distant host stars don't spam invisible rings into the framebuffer.

### Orbital plane convention

Per the 3re.8 design rule:

- **Sol's orbit rings sit on the ecliptic.** The host orientation
  quaternion rotates the local plane so +Z aligns with the ecliptic
  pole (J2000 obliquity ε = 23.4392911°). This matches what an
  observer at Sol sees on the sky.
- **All other host stars' orbit rings sit on the galactic plane.**
  Exoplanet system orientations are not generally known; aligning to
  the galactic plane gives a consistent visual "this star has
  planets" cue without implying a measured orientation we don't have.

The per-host quaternion is composed once at `getPlanetSystem` attach
time and reused for both the body positions and the ring renderer.
Ring renderer composes `Rz(Ω) · Rx(I) · Rz(ω)` per planet (from the
Sol-only `orbitOrientations` array, when present) before the
host-plane → ICRS rotation, so rings line up with the body positions
emitted by `positionsAt`.

## Heliopause boundary

`heliopause.ts` and the matching shaders. Asymmetric ellipsoid centred
on Sol, aligned to the solar apex of motion through the local
interstellar medium. Geometry is fixed (no `t` dependence on human
timescales):

- Upwind boundary at **122 AU** — Voyager 1, 2012-08-25.
- Flank at **115 AU** — Voyager 2, 2018-11-05.
- Heliotail at **200 AU** — IBEX / Cassini ENA estimate.
- Apex direction: ICRS RA 17h53m, Dec +27.4°, after Frisch & Slavin
  2013.

Construction: unit sphere → scale to (115, 115, 161) AU → translate
the centre 39 AU toward antiapex → rotate so +Z lands on the antiapex.
Result: upwind apex at +122 AU, downwind at −200 AU along the apex.

Rendering uses a Fresnel limb-darkening fragment shader: alpha peaks
at the silhouette where the view ray grazes the surface and falls to
a small floor face-on, so the upwind apex region doesn't paint the
shell as a flat disc against the starfield. Back-face culling means
the shell disappears from inside (Sol focus, zoomed in) — this is
intentional, since from inside there's nothing geometrically
informative to show.

The "Heliopause" SVG label is anchored to the upwind apex's projected
silhouette by `createHeliopauseLabel` in `main.ts`. Visibility tracks
the same orbit-ring heuristic so the label disappears in lockstep
with the planet labels when the host system is too far for the
geometry to read.

## First-load default and `minDistance` relaxation

When the URL carries no view state, `first-load.ts` applies a
canonical `FIRST_LOAD_VIEW`: camera parked at exactly **5 AU** from
Sol along a hand-tuned direction that frames Orion in the
background, with the HUD ring on and Orion highlighted. Sol stays
the default focus and the constellation overlay is on by default,
so Orion's stick figure renders without an explicit toggle. The
view is applied via `applyDecodedView` from `url-state.ts` — the
same pipeline used for `?v=` URL restores — which keeps the
"first interaction is the first URL write" contract intact:
`startUrlSync` seeds its frame-tracking baseline from the live
camera state on registration, so the URL stays empty until the
user actually moves the camera or changes a setting.

The Stellata constructor calls `setFocus(catalog.solIndex)` to
recentre the local frame on Sol but does not park the camera —
both bootstrap paths (`applyFirstLoadView` for the bare URL, and
`applyFromUrl` for `?v=` URLs) own the cam pose end-to-end and
run before first paint in `main.ts`.

Other arrival flows (warp, observe-exit, search-select) use
`minDistForStar` — only the bare-URL bootstrap reads
`first-load.ts`.

When focused on Sol, `controls.minDistance` drops to
`minOrbitDistForStar(Sol) ≈ 0.011 AU` so the user can fly into the
inner solar system and resolve individual planets. This is safe
specifically because Sol sits at the world origin — the float32
jitter that bites at small distances *from non-origin focal stars*
doesn't apply when the focal frame is also the world frame. Other
focal stars retain the global `0.005 pc` (~1031 AU) floor.

`camera.near` is at `1e-10 pc` — well below `minOrbitDistForStar` —
so very-close planet inspection isn't culled. The strict-less-than
`camera.near < minDistance` invariant holds.

## File map

- `ephemeris.ts` — JPL Standish positions; `getPlanetPositions(t)`.
- `time.ts` — `t` helpers (`tToJDE`, `isLive`).
- `time-readout.ts` — bottom-right UTC readout binding.
- `planet-system.ts` — `PlanetSystem` data model; `SOL_PLANETS`.
- `star-system.ts` — orbit-rings + planet-bodies render layer.
- `planet-labels.ts` — per-planet SVG labels.
- `heliopause.ts` — heliopause shell + apex label hook.
- `shaders/heliopause.{vert,frag}.glsl` — Fresnel-limbed shell.
- `shaders/planet.{vert,frag}.glsl` — billboarded planet disc.
- `stellata.ts` — `SOL_FIRST_LOAD_PARK_PC` constant; planet-system
  attach in the constructor; minDistance relaxation in `setFocus`.

## Gotchas

- **Ecliptic ↔ equatorial obliquity.** Use J2000 ε = 23.4392911°
  consistently when composing the Sol-host quaternion. Do not reach
  for the time-varying obliquity term — Standish's accuracy budget
  doesn't need it and the apparent-position match is unaffected.
- **`t` vs `uTime`.** Variable-star pulsation is cosmetic — it must
  never depend on `t`. The two clocks are deliberately decoupled.
- **Per-focus minDistance override.** When focus switches *away*
  from Sol, the floor must snap back to `0.005 pc` *before* the new
  focus's recenter pulls the camera in. `setFocus` is the right hook
  and already handles this; any new focus path must as well.
- **Planet-system attach is async.** `getPlanetSystem` is a Promise
  even for Sol (which resolves synchronously in v1). Don't assume the
  system is attached the same frame `setFocus` fires; the renderer
  handles `planetSystem === null` gracefully.
- **Heliopause label visibility.** Hidden when the camera is inside
  the shell or when the host is not Sol. Don't add a "show always"
  toggle without thinking through the dual gating.
- **Orbital plane rule for new hosts.** Any new planet-bearing host
  must declare its plane via the orientation quaternion. The default
  for non-Sol hosts is the galactic plane — don't accidentally
  default to the ecliptic.
