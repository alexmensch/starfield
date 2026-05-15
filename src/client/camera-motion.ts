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

/** Frozen arrival snapshot. `d0` / `dEnd` are cached at construction so
 *  the per-tick math never re-resolves `target.center`; in 2br.3 they
 *  become the inputs to the log-distance profile. */
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
  return {
    pStart,
    pEnd,
    qStart: opts.qStart?.clone(),
    qEnd: opts.qEnd?.clone(),
    target,
    startMs: opts.startMs,
    durationMs: opts.durationMs,
    d0: pStart.distanceTo(target.center),
    dEnd: pEnd.distanceTo(target.center),
  };
}

// Piecewise-quadratic smoothstep — the legacy easing every park-arrival
// site used inline. Kept as the helper's curve through stellata-2br.2 so
// the refactor is provably a no-op (see camera-motion.test.ts curve pin).
// stellata-2br.3 swaps the body to the cubic-Hermite log-distance profile
// from docs/camera-arrival.md.
function easeArrival(u: number): number {
  return u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
}

/** Advance one frame. Writes `camera.position` (and, when both
 *  `qStart`/`qEnd` are present, `camera.quaternion`). Returns
 *  `{ done: true }` once `nowMs ≥ startMs + durationMs`. */
export function tickArrival(
  state: ArrivalState,
  nowMs: number,
  camera: THREE.PerspectiveCamera,
): { done: boolean } {
  const u = Math.min(1, (nowMs - state.startMs) / state.durationMs);
  const f = easeArrival(u);
  camera.position.lerpVectors(state.pStart, state.pEnd, f);
  if (state.qStart && state.qEnd) {
    camera.quaternion.copy(state.qStart).slerp(state.qEnd, f);
  }
  return { done: u >= 1 };
}
