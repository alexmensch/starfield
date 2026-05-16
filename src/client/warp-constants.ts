// Warp + camera-lerp timing constants shared between `stellata.ts`
// (the warp state machine consumer) and `warp-tuning.ts` (the debug
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
// Adding new warp / lerp duration knobs: define them here, re-export
// or import from `stellata.ts` and `warp-tuning.ts` as needed.

// Canonical 2 s duration used everywhere the camera lerps under
// non-warp dispatch — focus-park glide, warp reorient phase, aim
// animation upper bound. One literal so the three motions read as
// the same family. (`WARP_T_K_MS` below is a log-scale flight
// coefficient with different semantics — it stays separate.)
export const CAMERA_LERP_MS = 2000;

export const WARP_T_MIN_MS = 5000;
export const WARP_T_MAX_MS = 20000;
export const WARP_T_K_MS = 2000;
export const WARP_REORIENT_MS = CAMERA_LERP_MS;
export const FOCUS_LERP_MS = CAMERA_LERP_MS;

// Aim animation: rotate the camera around `controls.target` so a chosen
// world point lands at the centre of the view. Capped at 2 s so even a
// 180° swing stays snappy; floored at 250 ms so trivial nudges still ease.
export const AIM_T_MAX_MS = CAMERA_LERP_MS;
export const AIM_T_MIN_MS = 250;

// OBSERVE-mode entry/exit translate animation. Travel distance is always
// parkDistForStar (sub-parsec) so a fixed duration reads as a brief glide
// rather than a warp.
export const OBSERVE_TRANSITION_MS = 1200;
