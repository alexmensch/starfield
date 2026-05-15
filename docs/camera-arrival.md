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

Every existing arrival site interpolates **camera position** by time
with the same piecewise-quadratic smoothstep — `f(t) = 2t² for t < 0.5,
else 1 − 2(1−t)²`. That damps the **time** profile but does nothing
about the `1/d` term in angular space. Smoothstep at the end of position
still lands with `dd/dt = 0`, but `dθ/dd = −2R/d²` is enormous at small
d, so the angular rate blows up just before zero velocity arrests it.
The user perceives a slam.

The fix is to evolve `log d` smoothly instead of `d`. Equal time per
decade of distance gives equal time per octave of angular size, which
is the perceptually-uniform metric — the camera reads as continuously
decelerating across the entire visible arrival, not flashing into the
last frame.

## Inventory of arrival sites

Every camera motion that lands at parkDist re-implements its own easing
inline today. The unification target is one helper that the three real
arrivals delegate to.

| Path | Location | Duration | Endpoint |
|---|---|---|---|
| Focus-park lerp (star, cloud) | `focus-transition.ts:tickFocusLerp` | `FOCUS_LERP_MS = 2000` ms | `parkDist` |
| Warp Fly phase | `stellata.ts:updateWarp` | `WARP_T_MIN_MS … WARP_T_MAX_MS` (5–20 s) | `endOffset` (≈ destination `parkDist`) |
| Navigate-mode unfocus | `stellata.ts:unfocus` | `OBSERVE_TRANSITION_MS = 1200` ms | `parkDist` (outbound) |

**Excluded: Warp Phase 3 (observe→observe arrivals).** Phase 3's
position track lerps `pEnd → (0,0,0)` over `OBSERVE_TRANSITION_MS`. The
endpoint is the destination star's local origin, not parkDist — that's
the OBSERVE-mode invariant: in OBSERVE the camera occupies the focused
star's local origin so the user "stands on" the star and only rotates
the view. The lerp is the observe-mode handover that absorbs the
parkDist-sized gap between Fly's endpoint and OBSERVE's origin, not an
angular-slam arrival. Distance changes ~1 decade in 1.2 s — smoothstep
already feels right, the helper's log-d profile delivers nothing
perceptual, and forcing `d_end = 0` through it would require an
exception case for zero gain. Phase 3 stays inline; the helper covers
park-arrivals only.

## Profile

For all park-arrivals (focus-park, warp Fly, unfocus), evolve **camera
distance from target centre** as a smoothstep over `log d`:

```
u       = clamp((nowMs − startMs) / durationMs, 0, 1)
u_eased = 3·u² − 2·u³                          // cubic Hermite smoothstep
d(u)    = d0 · (d_end / d0)^u_eased
```

The new helper adopts the cubic Hermite form `3u² − 2u³` (one
polynomial, C¹-continuous everywhere, identical to GLSL's `smoothstep`)
rather than the legacy piecewise quadratic. The shape difference is
invisible — both have `f(0)=0`, `f(1)=1`, `f(0.5)=0.5`, and zero
derivative at the endpoints; they differ by at most ~3% at the
quartiles. Adopting cubic Hermite collapses the two-branch
implementation to a single line and gives smooth jerk at `u=0.5` where
the piecewise variant has a kink.

with `d0 = |pStart − target.center|`, `d_end = parkDist`. Camera
position rides the line through `target.center` and `pStart`:

```
dir   = (pStart − target.center).normalize()
pos   = target.center + dir · d(u)
```

### Properties

- **Endpoints.** `d(0) = d0` exactly; `d(1) = d_end` exactly.
  Cubic-Hermite has `f(0) = 0`, `f(1) = 1`.
- **Zero velocity at the endpoints.** `f'(0) = f'(1) = 0`, so
  `dd/du → 0` at both ends — the camera ramps up smoothly from rest at
  the start and arrests smoothly at parkDist.
- **Uniform log-rate at the midpoint.** `f'(0.5) = 1.5`, giving peak
  octaves-per-second of `1.5·log(d_end/d0)/durationMs`. For Sol arrival
  from 1 pc (~5.3 decades), peak rate is ~7.9 dec/s — well under the
  perceptual blur threshold.
- **Direction-agnostic.** For outbound (unfocus), `d0 < d_end` and
  `log(d_end/d0) > 0` — the same formula carries the camera outward.
  No `direction` flag needed in the helper; the sign of
  `log(d_end/d0)` is enough.

### Why smoothstep on log d, not identity

Three `u_eased` candidates were considered: identity, smoothstep, and a
tanh-edge variant. Identity (`u_eased = u`) is the minimal log-distance
profile and gives constant octaves-per-second throughout — pure
log-uniform motion. It works mathematically but sacrifices two things:

1. **Non-zero velocity at the endpoints.** The camera leaves `d0` at
   full log-rate and lands at `parkDist` at full log-rate. From rest,
   the start reads as a jolt; into a hard floor, the landing reads as
   a stop, not an arrival.
2. **Mismatch with the orientation track.** `tickFocusLerp` slerps the
   camera quaternion with smoothstep easing in parallel with the
   position lerp. If position uses identity-log-d while orientation
   uses smoothstep, the two tracks diverge — orientation eases, position
   doesn't.

Smoothstep on `log d` preserves the symmetry with the orientation
slerp (same shape, same time parameter, both ease in and out) and
avoids both jolts. Tanh-edge offers nothing extra: it's a more
expensive way to spell smoothstep for this regime.

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

**Decision: single-region log-d smoothstep across `[d0, parkDist]`,
no window split.** The "decel kicks in at ~10²–10³·parkDist" property
emerges from the smoothstep shape rather than being engineered with a
seam. For typical `d0/parkDist` (≥ 10³), the last 3 decades of distance
correspond to roughly the last half of `u`, which is exactly where
smoothstep's deceleration concentrates. No knob required.

## Edge cases

1. **`d0 ≤ parkDist` (already inside park).** No-op or instant settle,
   matching today's `tickFocusLerp` short-circuit. The helper returns
   `done: true` on first tick and writes `pEnd` directly.

2. **Target without an effective radius (clouds, future generic
   focusables).** Log-distance still works — `parkDist` is the only
   per-target input the profile needs. The `effectiveRadius` field on
   `ArrivalTarget` is reserved for a future angular-rate-bounded
   variant, not used by the log-d profile itself.

3. **Outbound (unfocus).** `d0 < d_end`, `log(d_end/d0) > 0`, the same
   formula carries the camera outward over the same `u_eased`. Mirrors
   the inbound landing — zero velocity at the inside endpoint, zero
   velocity at the park endpoint. The unfocus animate path
   (`OBSERVE_TRANSITION_MS = 1200`) feels symmetric with the
   focus-park inbound.

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
```

`tickArrival` writes `camera.position` and (when `qStart`/`qEnd` are
present) `camera.quaternion`. Returns `done: true` once
`nowMs ≥ startMs + durationMs`, mirroring `tickFocusLerp`'s contract.

`parkDistance(...)` stays in `focus-transition.ts` — it computes a
per-object property and isn't a motion concern.
