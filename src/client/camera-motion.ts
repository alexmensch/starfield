// Shared camera-arrival primitive. Every park-arrival in the renderer
// — focus-park (star, cloud), warp Fly phase, navigate-mode unfocus —
// constructs an `ArrivalState` and ticks it through `tickArrival`, so
// the deceleration shape lives in exactly one place. See
// `docs/camera-arrival.md` for the math and the inventory of arrival
// sites. Warp Phase 3 stays inline by design (it's an observe-mode
// handover, not a park-arrival).

import * as THREE from 'three';

/** Where the camera is heading. `parkDist` is the eventual radial
 *  distance from `center` (= `dEnd` on the helper sites). The optional
 *  `effectiveRadius` is reserved for a future angular-rate-bounded
 *  arrival variant; the current profile doesn't read it. */
export interface ArrivalTarget {
  center: THREE.Vector3;
  parkDist: number;
  effectiveRadius?: number;
}

/** Frozen arrival snapshot. `d0` / `dEnd` / `dir` are cached at construction
 *  so the per-tick math never re-resolves `target.center` or normalises
 *  a vector. `dir` is the unit ray from `target.center` toward `pStart`;
 *  the three helper sites (focus-park, warp Fly, unfocus) all place
 *  `pStart` and `pEnd` on this ray, so the log-distance profile evolves
 *  camera position along it. */
export interface ArrivalState {
  pStart: THREE.Vector3;
  pEnd: THREE.Vector3;
  qStart?: THREE.Quaternion;
  qEnd?: THREE.Quaternion;
  target: ArrivalTarget;
  startMs: number;
  durationMs: number;
  d0: number;
  dEnd: number;
  dir: THREE.Vector3;
}

export interface NewArrivalOpts {
  pStart: THREE.Vector3;
  pEnd: THREE.Vector3;
  /** When both `qStart` and `qEnd` are present, the camera quaternion
   *  slerps in lock-step with the position lerp. Omit when the caller
   *  drives camera orientation itself (warp Fly does `lookAt`, observe
   *  transitions hold the quaternion fixed). */
  qStart?: THREE.Quaternion;
  qEnd?: THREE.Quaternion;
  target: ArrivalTarget;
  startMs: number;
  durationMs: number;
}

/** Build an `ArrivalState`. Inputs are cloned so callers can mutate
 *  their scratch vectors afterwards without disturbing an in-flight
 *  lerp. */
export function newArrival(opts: NewArrivalOpts): ArrivalState {
  const target: ArrivalTarget = {
    center: opts.target.center.clone(),
    parkDist: opts.target.parkDist,
    effectiveRadius: opts.target.effectiveRadius,
  };
  const pStart = opts.pStart.clone();
  const pEnd = opts.pEnd.clone();
  const d0 = pStart.distanceTo(target.center);
  const dEnd = pEnd.distanceTo(target.center);
  // Unit ray from target.center toward pStart. Falls back to zero when
  // pStart coincides with target.center — a pathological case for the
  // three helper sites (camera at target origin), in which the lerp
  // settles at the centre.
  const dir = new THREE.Vector3().subVectors(pStart, target.center);
  if (d0 > 0) dir.divideScalar(d0);
  return {
    pStart,
    pEnd,
    qStart: opts.qStart?.clone(),
    qEnd: opts.qEnd?.clone(),
    target,
    startMs: opts.startMs,
    durationMs: opts.durationMs,
    d0,
    dEnd,
    dir,
  };
}

// Cubic-Hermite smoothstep — `3u² − 2u³`, identical to GLSL's smoothstep.
// `f(0) = 0`, `f(1) = 1`, `f'(0) = f'(1) = 0`. See
// `docs/camera-arrival.md` § Profile for why this replaced the legacy
// piecewise quadratic (one polynomial, C¹-continuous, smooth jerk at 0.5).
function easeArrival(u: number): number {
  return u * u * (3 - 2 * u);
}

/** Migrate an in-flight `ArrivalState` into a new floating-origin frame
 *  by subtracting the recentre delta from every cached point. `delta` is
 *  the value `recenterOrigin` returns (`newOrigin − previous worldOffset`);
 *  every position captured in the old frame must shift by `−delta` to
 *  point at the same physical location in the new frame.
 *
 *  d0, dEnd, and dir are translation-invariant — they're derived from
 *  the differences `pStart − target.center` and `pEnd − target.center`,
 *  both of which shift by the same amount. No recompute needed.
 *
 *  Sibling of `shiftWarpWaypoints` in `warp-pure.ts`: that helper owns
 *  the WarpState waypoint shift, this one owns the cached ArrivalState
 *  shift. Both are called together at any mid-flight recentre. */
export function shiftArrivalWaypoints(
  state: ArrivalState,
  dx: number,
  dy: number,
  dz: number,
): void {
  state.pStart.x -= dx; state.pStart.y -= dy; state.pStart.z -= dz;
  state.pEnd.x -= dx; state.pEnd.y -= dy; state.pEnd.z -= dz;
  state.target.center.x -= dx;
  state.target.center.y -= dy;
  state.target.center.z -= dz;
}

/** Advance one frame. Writes `camera.position` (and, when both
 *  `qStart`/`qEnd` are present, `camera.quaternion`). Returns
 *  `{ done: true }` once `nowMs ≥ startMs + durationMs`.
 *
 *  Position evolves as a smoothstep over `log d` — equal time per decade
 *  of distance, giving uniform octaves-per-second of angular size. See
 *  `docs/camera-arrival.md` § Profile. The endpoints are written
 *  bit-exact (`pStart` at `u ≤ 0`, `pEnd` at `u ≥ 1`) so callers that
 *  compare `camera.position.equals(pEnd)` after landing still match. */
export function tickArrival(
  state: ArrivalState,
  nowMs: number,
  camera: THREE.PerspectiveCamera,
): { done: boolean } {
  const u = Math.min(1, Math.max(0, (nowMs - state.startMs) / state.durationMs));
  if (u <= 0) {
    camera.position.copy(state.pStart);
    if (state.qStart && state.qEnd) camera.quaternion.copy(state.qStart);
    return { done: false };
  }
  if (u >= 1) {
    camera.position.copy(state.pEnd);
    if (state.qStart && state.qEnd) camera.quaternion.copy(state.qEnd);
    return { done: true };
  }
  const f = easeArrival(u);
  // d(u) = d0 · (dEnd/d0)^f. Outbound (d0 < dEnd) and inbound (d0 > dEnd)
  // share the same formula — the sign of log(dEnd/d0) carries the camera
  // the correct direction. When d0 == dEnd the ratio is 1, d stays
  // constant, and the camera doesn't move (graceful no-op).
  const d = state.d0 * Math.pow(state.dEnd / state.d0, f);
  camera.position.copy(state.target.center).addScaledVector(state.dir, d);
  if (state.qStart && state.qEnd) {
    camera.quaternion.copy(state.qStart).slerp(state.qEnd, f);
  }
  return { done: false };
}
