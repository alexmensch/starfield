// Pure-math helpers for the warp pipeline. Lives alongside
// `perceptual-magnitude.ts` / `catalog-pure.ts` — small,
// dependency-free, vitest-covered so the invariants the warp
// jitter fix (stellata-fqw) rests on can't silently regress.

import * as THREE from 'three';

/** The positional fields of `WarpState` that live in the floating
 *  origin's local frame. Unit vectors (`dir0`, `dirBack`) are
 *  frame-invariant and not part of this bundle. */
export interface WarpPositionalFields {
  A: THREE.Vector3;
  pStart: THREE.Vector3;
  pEnd: THREE.Vector3;
}

/**
 * Migrate a warp's positional fields into a new floating-origin frame
 * by subtracting the recentre delta in place. `delta` is the value
 * `recenterOrigin` returns (`newOrigin − previous worldOffset`); every
 * point captured in the old frame must shift by `−delta` to point at
 * the same physical location in the new frame.
 *
 * Called from `updateWarp` at observe→observe phase-3 start, the only
 * frame in which the floating origin moves mid-warp. After this:
 *   - `pEnd` keeps the parallax slerp `pEnd → B` landing on the same
 *      physical waypoint (the catalog-absolute destination), so `B`
 *      re-bound in the new local frame stays at the lerp endpoint.
 *   - `A` and `pStart` stay frame-coherent with `pEnd`, eliminating
 *      the "phase-3 mutates pEnd in place but leaves A/pStart in the
 *      source frame" footgun for future readers (stellata-9mm.164).
 */
export function shiftWarpWaypoints(
  state: WarpPositionalFields,
  dx: number,
  dy: number,
  dz: number,
): void {
  state.A.x -= dx; state.A.y -= dy; state.A.z -= dz;
  state.pStart.x -= dx; state.pStart.y -= dy; state.pStart.z -= dz;
  state.pEnd.x -= dx; state.pEnd.y -= dy; state.pEnd.z -= dz;
}
