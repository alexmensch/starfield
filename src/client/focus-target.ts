// Per-object contract consumed by warp / focus-lerp / arrival code.
//
// The warp + camera-transition machinery operates on FocusTargets, NEVER
// on `kind` switch statements. Adding a new focusable object kind
// (planet, probe, exoplanet, nebula, …) consists of:
//
//   1. Implementing this interface (typically as a factory on Stellata
//      returning an object that closes over the per-kind catalog /
//      state / event-bus references).
//   2. Plumbing the new kind through click / pick handling so its
//      FocusTarget can be passed to `startWarp` / `focusStar`-style
//      entry points.
//
// The warp animation code (`updateWarp`, `finishWarp`, mid-Fly
// recentre, pin guard, scale-bar focus tracking, …) is kind-agnostic
// above this seam and does not need to change.
//
// See `docs/architecture.md` § FocusTarget contract for the bigger
// picture and the rationale (stellata-2br.5 — the cubic-Hermite log-d
// Fly profile exposed a class of Float32-precision bugs in lookAt(B)
// that recentring the floating origin mid-Fly fixes; the kind-agnostic
// version of that fix lives on this contract so future kinds inherit
// the correctness automatically).

import * as THREE from 'three';

/** A focusable object — star, cloud, future planet/probe/nebula/etc. */
export interface FocusTarget {
  /** Identity tag. Used for event-payload dispatch and equality checks
   *  in higher-level code (URL state, focus-vector match-up). New kinds
   *  add a value to this union. The warp / lerp internals do not switch
   *  on `kind`. */
  readonly kind: 'star' | 'cloud';

  /** Catalog index within this kind. Carries the same value the legacy
   *  `focusedStar` / `focusedCloud` integer fields hold. Event payloads
   *  for `'focus'` / `'cloudFocus'` ship this value. */
  readonly idx: number;

  /** Absolute-space anchor (catalog-frame parsecs). This is the value
   *  passed to `recenterOrigin` when the floating origin tracks this
   *  object. Writes into `out` and returns `true` on success; returns
   *  `false` (and leaves `out` untouched) when the underlying data is
   *  unavailable (e.g., cloud layer not loaded yet). */
  anchorInto(out: THREE.Vector3): boolean;

  /** Current floating-origin local-frame position. Used by per-frame
   *  `camera.lookAt(...)` during warp Fly and by overlay projection
   *  paths. Same contract as `anchorInto`'s return value: false on
   *  unavailable-source. */
  localPositionInto(out: THREE.Vector3): boolean;

  /** Camera-to-anchor distance at the parked pose. For stars: the
   *  per-star `parkDistForStar` (90 %-fill floor or GLOBAL_MIN_DIST).
   *  For clouds: `cloudViewingDistancePc` (ellipsoid-aware). The warp
   *  computes `pStart` / `pEnd` as `anchor − travelDir · parkRadius()`
   *  for source and destination respectively. */
  parkRadius(): number;

  /** Per-kind focus-state mutation. Sets the relevant
   *  `focusedStar` / `focusedCloud` field, updates derived state
   *  (per-focus `minDistance`, planet-system attach, etc.), and clears
   *  whichever sibling focus field was previously set — all WITHOUT
   *  firing any events on the bus. Events are deferred to
   *  `emitFocusEvents` so the UI can be settled in lock-step with the
   *  camera landing (see `finishWarp`). */
  applyFocus(): void;

  /** Fire the deferred focus-event family that `applyFocus` set up.
   *  Typically `'focus'` / `'cloudFocus'` (plus a sibling-clearing null
   *  emit when the previously-focused object was of a different kind),
   *  followed by `'state'` so the URL writer serialises the new pose.
   *  Called from `finishWarp` after the camera has fully landed. */
  emitFocusEvents(): void;
}
