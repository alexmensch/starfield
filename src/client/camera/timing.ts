// Camera-wide timing constants shared between `stellata.ts` (the warp
// state machine + camera-lerp consumer) and `warp-tuning.ts` (the debug
// panel that exposes them as live-tunable knobs). Lifted to their own
// module to break the import cycle that the tuning surface otherwise
// introduces: `stellata.ts` imports the getter functions from
// `warp-tuning`, while `warp-tuning` needs these constants as the
// initial knob defaults. Reading them via `stellata.ts` left the
// constants in the temporal dead zone at module-load time —
// `warp-tuning`'s top-level `const knobs = { ... }` initializer ran
// before stellata's `export const WARP_REORIENT_MS = ...` line was
// evaluated, so the catalogue (and indeed the rest of the app) never
// got to boot.
//
// Adding new camera / lerp / numeric-floor knobs: define them here,
// re-export or import from `stellata.ts` and `warp-tuning.ts` as needed.

import * as THREE from 'three';

// Canonical 2 s duration for non-warp camera lerps — focus-park glide
// and the aim-animation upper bound. (`WARP_REORIENT_MS` was once part
// of this family but tuning moved it off the literal; the warp's
// reorient phase reads slightly snappier than a generic camera glide.)
export const CAMERA_LERP_MS = 2000;

export const WARP_T_MIN_MS = 3000;
export const WARP_T_MAX_MS = 20000;
export const WARP_T_K_MS = 3000;
export const WARP_REORIENT_MS = 1800;
export const FOCUS_LERP_MS = CAMERA_LERP_MS;

// Aim animation: rotate the camera around `controls.target` so a chosen
// world point lands at the centre of the view. Capped at 2 s so even a
// 180° swing stays snappy; floored at 250 ms so trivial nudges still ease.
export const AIM_T_MAX_MS = CAMERA_LERP_MS;
export const AIM_T_MIN_MS = 250;

// OBSERVE-mode entry/exit translate animation. Travel distance is always
// parkDistForStar (sub-parsec) so a fixed duration reads as a brief glide
// rather than a warp.
export const OBSERVE_TRANSITION_MS = 1800;

// Camera-distance floor used by sites that need a finite log10(dCam) or
// atan(R/dCam) at close approach. 1e-30 pc is well below any orbit the
// camera can actually reach, so it never affects rendering — it just
// keeps Math.log10 / division well-defined at the singular point.
export const DCAM_LOG_FLOOR_PC = 1e-30;

// Arbitrary reference axis for the warp reorient slerp. Any fixed unit
// vector works — `setFromUnitVectors(WARP_BASE_DIR, dir)` produces a
// quaternion rotating this vector to `dir`, and slerp between two such
// quaternions gives the shortest-arc interpolation on the sphere.
export const WARP_BASE_DIR = new THREE.Vector3(0, 0, 1);
