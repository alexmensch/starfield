// Generic focus-park primitives. Stars use these now; clouds, planets,
// and any future click-focusable type are expected to compose them with
// their own R_pc / dMinFloor inputs so the focus UX stays uniform.

import * as THREE from 'three';
import { AU_PC } from './astronomy-constants';

export interface ParkDistanceInputs {
  /** Effective object radius in parsecs (Reff for stars; major semi-axis
   *  for clouds; etc). */
  R_pc: number;
  /** Type-specific manual-zoom floor — the distance at which a free-orbit
   *  user can no longer pull the camera in. For stars this is the 90 %-fill
   *  floor; clouds will pass their analogue. */
  dMinFloor: number;
  /** Optional additional floor (e.g. binary-companion bump for stars). */
  extraFloor?: number;
}

/**
 * Where the camera auto-parks when focusing an object. Lands 1 AU outside
 * the object's surface — close enough that Sol parks at ~1.005 AU (just
 * outside Earth's orbit) — but never closer than the manual-zoom floor or
 * any type-specific extra floor.
 */
export function parkDistance(opts: ParkDistanceInputs): number {
  return Math.max(
    AU_PC + opts.R_pc,
    opts.dMinFloor,
    opts.extraFloor ?? 0,
  );
}

export interface FocusLerpState {
  startTimeMs: number;
  durationMs: number;
  /** Camera position snapshot at lerp start (local frame). */
  fromPos: THREE.Vector3;
  /** Park position the camera lerps to. */
  toPos: THREE.Vector3;
}

/**
 * Build a focus lerp from the current camera pose. The destination is the
 * point at `parkDist` from `target`, along the current eye-to-target line —
 * so the camera glides in along its existing viewing direction rather than
 * jumping sideways. Degenerate case (camera coincident with target) falls
 * back to +Z so the lerp still produces a sensible destination.
 */
export function newFocusLerpFrom(
  cameraPos: THREE.Vector3,
  target: THREE.Vector3,
  parkDist: number,
  durationMs: number,
  startTimeMs: number,
): FocusLerpState {
  const offset = new THREE.Vector3().subVectors(cameraPos, target);
  if (offset.lengthSq() === 0) offset.set(0, 0, 1);
  offset.normalize().multiplyScalar(parkDist);
  const toPos = new THREE.Vector3().addVectors(target, offset);
  return {
    startTimeMs,
    durationMs,
    fromPos: cameraPos.clone(),
    toPos,
  };
}

/** Smoothstep easing — matches the observe-transition shape so multiple
 *  in-flight lerps read as the same camera motion family. */
function easeSmoothstep(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

/**
 * Advance the lerp. Writes the eased position into `camera.position`.
 * Returns true while the lerp is still in flight, false once it has
 * landed at `toPos`.
 */
export function tickFocusLerp(
  state: FocusLerpState,
  nowMs: number,
  camera: THREE.PerspectiveCamera,
): boolean {
  const t = Math.min(1, (nowMs - state.startTimeMs) / state.durationMs);
  const f = easeSmoothstep(t);
  camera.position.lerpVectors(state.fromPos, state.toPos, f);
  return t < 1;
}
