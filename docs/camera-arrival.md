# Camera arrival profile

How the camera decelerates as it lands on a focused object — star,
cloud, planet, or any future click-focusable host. Companion to
`docs/camera-controls.md` (steady-state geometry), `docs/camera-warp.md`
(warp animation phases), and `docs/camera-observe.md` (OBSERVE mode).
Defines the math the `camera-motion.ts` helper applies.

## The angular-arrival problem

A star's angular subtense scales as `θ = 2·atan(R/d)`, which for
`d >> R` reduces to `θ ≈ 2R/d`. Half the perceptual change in apparent
size happens in the **last decade** of distance, and three-quarters in
the last two decades. The disc stays a pinprick for most of the
approach, then explodes into the frame in the final ~100 ms.

Before this PR, every **park-arrival site** — the three rows in the
inventory below (focus-park, warp Fly, navigate-mode unfocus) —
interpolated **camera position** by time with a piecewise-quadratic
smoothstep — `f(t) = 2t² for t < 0.5, else 1 − 2(1−t)²`. (Warp Phase 3
also lerps camera position by time, but is excluded from this list:
it's already cubic-Hermite, lands at the focal star's local origin
rather than parkDist, and is an OBSERVE handover rather than an
arrival — see § Inventory.) That damped the **time** profile but did
nothing about the `1/d` term in angular space. Smoothstep at the end
of position still lands with `dd/dt = 0`, but `dθ/dd = −2R/d²` is
enormous at small d, so the angular rate blew up just before zero
velocity arrested it. The user perceived a slam.

The fix is to evolve `log d` smoothly instead of `d`. Equal time per
decade of distance gives equal time per octave of angular size, which
is the perceptually-uniform metric — the camera reads as continuously
decelerating across the entire visible arrival, not flashing into the
last frame.

## Inventory of arrival sites

The three real park-arrivals delegate to `camera-motion.ts`'s
`tickArrival` helper — the deceleration shape lives in exactly one
place and the helper owns both the time and the distance profile.

| Path | Location | Duration | Endpoint |
|---|---|---|---|
| Focus-park lerp (star, cloud) | `focus-transition.ts:tickFocusLerp` | `FOCUS_LERP_MS = 2000` ms | `parkDist` |
| Warp Fly phase | `stellata.ts:updateWarp` | `WARP_T_MIN_MS … WARP_T_MAX_MS` (3–20 s) | `endOffset` (≈ destination `parkDist`) |
| Navigate-mode unfocus | `stellata.ts:unfocus` | `OBSERVE_TRANSITION_MS = 1800` ms | `parkDist` (outbound) |

**Excluded: Warp Phase 3 (observe→observe arrivals).** Phase 3's
position track lerps `pEnd → (0,0,0)` over `OBSERVE_TRANSITION_MS` and
is already eased with cubic-Hermite `u²·(3 − 2u)` — the same shape the
helper adopts in § Profile, applied to the position lerp directly
rather than to `log d`. The endpoint is the destination star's local
origin, not parkDist — that's the OBSERVE-mode invariant: in OBSERVE
the camera occupies the focused star's local origin so the user
"stands on" the star and only rotates the view. The lerp is the
observe-mode handover that absorbs the parkDist-sized gap between
Fly's endpoint and OBSERVE's origin, not an angular-slam arrival.
Distance changes ~1 decade in 1.2 s and running it through the
helper's log-d profile would force `d_end = 0` — a degenerate case
that needs a zero-gain exception for no perceptual benefit. Phase 3
stays inline because the geometry isn't a park-arrival, not because
the easing form differs from the helper's.

## Profile

The shipped arrival profile is a **hybrid two-regime curve**: linear-d
piecewise-quadratic in the far approach (parallax-driven), quintic
smootherstep on angular size in the close approach
(angular-growth-driven), joined at a seam where both regimes arrive at
zero velocity. The hybrid is the ONLY user-facing arrival profile;
`arrival-curves.ts` keeps a cubic-Hermite log-d smoothstep internally as
a fallback for kinds without a geometric radius (clouds) and for
outbound trajectories (unfocus), where the regime split doesn't apply.

### Why two regimes

No single-regime profile on log-d space can deliver the perceptual
rhythm the viewer expects. Camera linear velocity is
`d · f' · |log_ratio| / T_warp` and `d` shrinks geometrically across
the warp, so linear velocity peaks very early
(`u ≈ √(t_accel / (v · |log_ratio|)) ≈ 0.16` for a Sol-from-10-pc
warp under any log-d curve) and decreases monotonically afterward
regardless of the curve's `f'(u)` shape. Background-star parallax flow
tracks linear velocity, so the camera reads as "decelerating" after the
early peak no matter what `f` looks like.

Splitting the warp into two regimes — each with its own geometry —
lets the early phase use **linear-d** (keeps linear velocity high, so
parallax sweep stays salient) and the late phase use **angular size**
(keeps perceptual approach alive even as linear velocity collapses).

### Geometry

Per-warp constants captured at resolve time:

```
R         = target.physicalRadius() (pc)               // from catalog
d_seam    = seam_k · parkDist                          // default seam_k = 100
θ_seam    = R / d_seam
θ_end     = R / d_end
u_seam    = clamp(log(d_0 / d_seam) / log(d_0 / d_end), 0.3, 0.85)
```

**Outer (`u ∈ [0, u_seam]`)** — piecewise-quadratic on linear distance
from `d_0` to `d_seam`:

```
τ           = u / u_seam
f_outer(τ)  = 2·τ²              if τ < 0.5
              1 − 2·(1 − τ)²    if τ ≥ 0.5
d_target(u) = d_0 − f_outer(τ) · (d_0 − d_seam)
```

Matches the pre-2br.3 main-branch "rocket impulse" feel exactly on the
truncated range `[d_0, d_seam]`: constant linear acceleration to
τ = 0.5, constant linear deceleration after. Linear velocity stays
high through the cruise, so background-star parallax remains the
dominant cue.

**Inner (`u ∈ [u_seam, 1]`)** — quintic smootherstep on angular size
`θ = R / d`:

```
σ            = (u − u_seam) / (1 − u_seam)
S(σ)         = 10·σ³ − 15·σ⁴ + 6·σ⁵
θ(σ)         = θ_seam + S(σ) · (θ_end − θ_seam)
d_target(u)  = R / θ(σ)
```

`S'(0) = S'(1) = 0` AND `S''(0) = S''(1) = 0`, so the regime arrives
with zero velocity AND zero acceleration — the cleanest possible
perceptual standstill. The visual cue is destination disc growth,
which is what the user tracks once parallax has collapsed at short
range.

**v = 0 handoff at the seam.** Both regimes arrive at the seam with
zero velocity (outer's piecewise-quad ends at v = 0; inner's quintic
starts at v = 0 via `S'(0) = 0`), so the handoff is velocity-continuous
without the matching constraint that killed the previously-rejected
dWindow split (see § "What about a two-region split at dWindow?"
below). The trade-off is a momentary neutral coast at the seam, which
is perceptually masked because parallax has already collapsed by then
and angular growth hasn't yet become salient.

**Time split.** `u_seam` is auto-computed from log-distance share with
a clamp so each regime always gets meaningful time. Not exposed as a
panel slider — letting `u_seam` and `seam_k` drift independently would
confuse the perceptual model.

### Log-d equivalent — preserved `tickArrival` formula

The hybrid is exposed via `arrival-curves.ts` as
`easeHybrid(u, d_0, d_end, R, seam_k)` and `resolveHybridCurve`. The
function builds `d_target(u)` in real distance space (linear-d outer +
angular-size inner) but RETURNS the log-d-equivalent eased-u value:

```
f(u) = log(d_target(u) / d_0) / log(d_end / d_0)
```

That keeps the existing `tickArrival` formula
`d(u) = d_0 · (d_end/d_0)^f(u)` unchanged — the hybrid geometry lives
entirely inside the curve closure, the consumer is none the wiser.

### Properties

- **Endpoints.** `d(0) = d_0` exactly; `d(1) = d_end` exactly.
- **Zero velocity at endpoints.** Outer's piecewise-quad has
  `dd/du = 0` at u = 0; inner's quintic has both `dd/du = 0` and
  `d²d/du² = 0` at u = 1. The arrival settles with no abrupt jolt.
- **Direction-agnostic for inbound only.** Hybrid applies only when
  `d_end < d_0`. Outbound trajectories (unfocus) trigger the
  cubic-Hermite fallback.
- **Tunable via `seam_k`.** Default `100`. Slider range `0 – 2000`,
  step 10. `seam_k ≤ 1` degenerates to pure outer (no inner regime,
  matches pre-2br.3 main-branch warp) — useful as a comparison
  baseline. `seam_k · parkDist > d_0` degenerates to pure inner (no
  outer regime), with the inner spanning the full warp from `d_0` to
  `d_end`.

### Fallbacks

`easeHybrid` returns cubic-Hermite log-d smoothstep
(`f(u) = 3u² − 2u³`) when:

- `targetRadius` is null (clouds — ellipsoid axes don't reduce to a
  single geometric R; future opaque ensembles).
- The trajectory is outbound (`d_end > d_0`, e.g. the unfocus path).
- The per-warp `ArrivalCurveContext` is missing at resolution time.

### Wire-up

All four arrival-curve call sites (warp Fly, focus-park for stars and
clouds, navigate-mode unfocus) pass an `ArrivalCurveContext` carrying
`{ d_0, d_end, targetRadius }`. `FocusTarget.physicalRadius()`
provides `R`; stars read it from the catalog, clouds return `null`.

The warp-tuning debug panel exposes a single `seam k` slider.
Capture-at-warp-start semantics in `warpArrivalEaseFn(ctx)` mean
live-tuning the slider mid-flight doesn't mutate an in-flight warp —
the next warp picks up the new value.

## What about a two-region split at `dWindow`?

An obvious alternative is a two-region design: smoothstep on linear-d
for `d > dWindow`, swap to log-d inside the window, with
`dWindow ≈ 512 · parkDist` (geometric centre of the user's empirical
400–1000 range) and `u_eased` chosen so velocity is continuous at the
seam. The motivation is to preserve today's far-field feel and only
change the close-approach behaviour.

The velocity-continuity constraint kills this design.

Outside the window, smoothstep on linear-d ends with `dd/dt = 0` at
`d = dWindow`. Inside the window, log-d with any `u_eased` whose
derivative is non-zero at the entry — including identity — starts with
`dd/dt = −dWindow · ln(dWindow/parkDist) / T_in`, which is firmly
non-zero. The two profiles can be made velocity-continuous only by
matching slopes, which solves for a time split:

```
T_out / T_in  =  (d0 − dWindow) / (dWindow · ln(dWindow/parkDist))
```

For Sol focus from 1 pc with `dWindow = 512·parkDist ≈ 1000 AU`,
`parkDist ≈ 1 AU`:

- `d0 − dWindow ≈ 1 pc − 0.005 pc ≈ 0.998 pc`
- `dWindow · ln(dWindow/parkDist) ≈ 0.005 · ln(512) ≈ 0.031 pc`
- `T_out / T_in ≈ 32`

So velocity-continuity forces 97% of the 2-second arrival outside the
window and 3% inside. The "decelerate across the last 3 decades"
property collapses to "decelerate across the last 60 ms," which is
essentially the slam we're trying to fix. The further `d0` is from
`dWindow`, the worse the ratio.

You can rescue Design B by *abandoning* velocity-continuity and fixing
the inside fraction (e.g. `T_in = 0.7·T`). But that introduces a
visible kink at the seam — the camera transitions from a near-zero
linear-d velocity to a non-zero log-d velocity over zero time — and
adds two knobs (`dWindow`, `T_in/T`) for a result that the
single-region log-d profile delivers with neither knob.

**Historical decision (superseded).** The original conclusion was
"single-region log-d smoothstep, no window split" — the smoothstep
shape made the velocity-continuous dWindow design unworkable AND
arguably unnecessary because cubic-Hermite's tail naturally
decelerates across the last few decades. That conclusion has since
been revisited.

Smoke testing the log-d cubic-Hermite (and the trapezoidal-in-log-d
alternative) revealed a different problem: linear velocity collapses
geometrically across any log-d profile, so background-star parallax
reads as decelerating from very early in the warp regardless of the
curve's `f(u)` shape. The resolution shipped in 1.12.0 is the
**hybrid two-regime design** — see § Profile above. The hybrid IS a
two-region split, but with different math:

- Outer uses **linear-d** piecewise-quad (not smoothstep on linear-d).
  Different shape, different endpoint behaviour.
- Inner uses **angular-size** quintic smootherstep (not log-d).
  Different geometry entirely.
- Both regimes hand off at v = 0, so the velocity-continuity
  constraint that forced the 97 % / 3 % time split in the dWindow
  analysis above doesn't apply — the seam absorbs zero velocity
  rather than matching a non-zero one.

The dWindow rejection is still correct for the specific question it
asked ("can we velocity-match log-d-inner to smoothstep-on-linear-d
outer?"). What it didn't anticipate was that *both* sides of the
hybrid could land at v = 0 by picking different curve shapes than the
two it considered. Keep this section as the historical record of the
log-d-only design.

## Edge cases

1. **`d0 ≤ parkDist` (already inside park).** No-op or instant settle,
   matching today's `tickFocusLerp` short-circuit. The helper returns
   `done: true` on first tick and writes `pEnd` directly.

2. **Target without an effective radius (clouds, future generic
   focusables).** The hybrid requires a single geometric `R` for the
   inner angular-size regime, so kinds that return `null` from
   `FocusTarget.physicalRadius()` trigger the cubic-Hermite log-d
   fallback. `parkDist` is the only per-target input the fallback
   needs. See § Worked examples below for the fallback's worked
   tables — still applicable to cloud arrivals today.

3. **Outbound (unfocus).** `d0 < d_end`, so the hybrid's seam concept
   doesn't apply (no "approach"). Triggers the cubic-Hermite log-d
   fallback, which carries the camera outward over the same eased-u
   shape that brought it in. The unfocus animate path
   (`OBSERVE_TRANSITION_MS = 1800`) feels symmetric with the
   focus-park inbound (when that inbound was on the fallback path).

4. **`pStart` and `pEnd` not co-linear with `target.center`.** Not a
   concern for the three helper sites today: focus-park constructs
   `pEnd` on the `pStart→target` ray, warp Fly constructs both `pStart`
   and `pEnd` on the `A→B` line offset by source/destination park
   distances, and unfocus is outbound on the same ray. If a future
   caller passes off-axis endpoints, the helper interpolates camera
   distance along the `pStart→pEnd` line using its midpoint as the
   parametric axis — same shape, slightly different geometry. Document
   if it ever comes up.

## Worked examples

These tables describe the **cubic-Hermite log-d fallback profile**
(`u_eased = 3u² − 2u³`) — what fires for cloud destinations, outbound
unfocus, and any inbound star warp whose ctx is missing. The shipped
hybrid profile uses different math for inbound star approaches; see
§ Profile above for its geometry.

**Sol from 1 pc** (`parkDist ≈ AU_PC ≈ 4.85·10⁻⁶ pc`):

| `u`  | `u_eased` | `d` (pc)    | `d / parkDist` | `d` (AU) |
|------|-----------|-------------|----------------|----------|
| 0.00 | 0.000     | 1.0         | 2.06 · 10⁵     | 206 000  |
| 0.25 | 0.156     | 0.148       | 30 500         | 30 500   |
| 0.50 | 0.500     | 2.20 · 10⁻³ | 454            | 454      |
| 0.75 | 0.844     | 3.28 · 10⁻⁵ | 6.77           | 6.77     |
| 1.00 | 1.000     | 4.85 · 10⁻⁶ | 1.0            | 1.0      |

The disc starts to be perceptible (a few arcseconds wide) around
`d/parkDist ≈ 1000`, which is `u_eased ≈ 0.436` → `u ≈ 0.457`. The
remaining 54% of the 2-second lerp (~1.09 s) spans the last 3 decades
of distance — exactly the "decelerate across the last 3 decades" the
user wants.

**Betelgeuse from 200 pc** (`R ≈ 1000·R_sun ≈ 4.65 AU`,
`parkDist ≈ 7 AU ≈ 3.4·10⁻⁵ pc` under the 90 %-fill floor):

| `u`  | `u_eased` | `d` (pc)    | `d / parkDist` |
|------|-----------|-------------|----------------|
| 0.00 | 0.000     | 200         | 5.9 · 10⁶      |
| 0.25 | 0.156     | 17.5        | 5.2 · 10⁵      |
| 0.50 | 0.500     | 8.24 · 10⁻² | 2 430          |
| 0.75 | 0.844     | 3.88 · 10⁻⁴ | 11.4           |
| 1.00 | 1.000     | 3.4 · 10⁻⁵  | 1.0            |

The user's empirical threshold `d ≈ 0.01 pc ≈ 295·parkDist` is hit at
`u_eased ≈ 0.635` → `u ≈ 0.591`. The remaining 41% of the 2-second
lerp (~820 ms) spans those last ~2.5 decades — matches the user's
"Betelgeuse: 0.01 pc remaining" empirical kick-in.

## Helper API

```ts
// src/client/camera-motion.ts

export interface ArrivalTarget {
  center: THREE.Vector3;
  parkDist: number;
  effectiveRadius?: number;  // reserved for future angular-rate variant
}

export interface ArrivalState {
  pStart: THREE.Vector3;
  pEnd: THREE.Vector3;
  qStart?: THREE.Quaternion;
  qEnd?: THREE.Quaternion;
  target: ArrivalTarget;
  startMs: number;
  durationMs: number;
  // Cached at construction for the log-d profile:
  d0: number;     // |pStart − target.center|
  dEnd: number;   // |pEnd − target.center| (= target.parkDist for the three helper sites)
}

export function newArrival(...): ArrivalState;
export function tickArrival(
  state: ArrivalState,
  nowMs: number,
  camera: THREE.PerspectiveCamera,
): { done: boolean };

/** Migrate an in-flight ArrivalState into a new floating-origin frame
 *  by shifting every cached position by `−delta`. Used by warp's
 *  mid-Fly recentre (stellata-2br.5) so the per-frame `tickArrival`
 *  math stays consistent after the floating origin moves onto the
 *  destination. `d0` / `dEnd` / `dir` are translation-invariant so
 *  no recompute is needed. Sibling to `shiftWarpWaypoints` in
 *  `warp-pure.ts`. */
export function shiftArrivalWaypoints(
  state: ArrivalState,
  dx: number, dy: number, dz: number,
): void;
```

`tickArrival` writes `camera.position` and (when `qStart`/`qEnd` are
present) `camera.quaternion`. Returns `done: true` once
`nowMs ≥ startMs + durationMs`, mirroring `tickFocusLerp`'s contract.

`parkDistance(...)` stays in `focus-transition.ts` — it computes a
per-object property and isn't a motion concern. The per-object
geometry that warp / arrival reads (anchor, local position,
park radius) flows through the `FocusTarget` contract — see
`docs/architecture.md` § FocusTarget contract.
