// Navigate↔observe mode-switch orchestrator. The 'unfocus' kind is
// the navigate-mode close-zoom outbound lerp — shares state shape with
// enter/exit but isn't an observe transition, so isActive / getProgress
// exclude it; isAnyActive is the union used by Stellata.isCameraBusy().
//
// See docs/camera-observe.md.

import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { CameraMode, StellataEventMap } from '../stellata';
import type { EventBus } from '../util/event-bus';
import type { AimController } from './aim-controller';
import type { ObserveControls } from './observe-controls';
import {
  type ArrivalState,
  newArrival,
  tickArrival,
} from './camera-motion';
import { OBSERVE_TRANSITION_MS } from './timing';
import { warpArrivalEaseFn } from './warp-tuning';
import { alignCameraUpToQuaternion } from './up-align-pure';

/** Cross-controller seam consumed by ObserveTransition. Stellata
 * implements this in 194.6; in 194.8 it migrates to FocusController and
 *  the controller's import seam updates in one line. */
export interface ObserveFocusOps {
  getFocusedStar(): number | null;
  /** Full setFocus path — fires 'focus' / 'cloudFocus' / 'state'. Used
   *  by the 'exit' kind's finish branch when `clearFocusOnExit` is true
   *  (the search-row X-button path). */
  setFocus(idx: number | null): void;
  /** Distance-vector slots — cleared at setMode('observe') because
   *  measurement endpoints don't survive the perspective change to
   *  "I'm standing on the source." */
  setVectorTo(idx: number | null): void;
  setVectorToCloud(idx: number | null): void;
  /** Focal star's effective minDistance — consumed by the 'exit' kind's
   *  toPos (a backward pull-out along the camera's current forward
   *  direction, distance = parkDist). */
  parkDistForStar(idx: number): number;
  /** True while ANY camera-driving animation is in flight (warp, aim,
   *  focus-lerp, or this controller's own state via `isAnyActive()`).
   *  setMode bails on busy so the user can't re-trigger mid-transition. */
  isCameraBusy(): boolean;
}

interface ObserveTransitionState {
  startTimeMs: number;
  durationMs: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  // 'enter' parks the camera at the focused star (toPos = origin under
  // the floating-origin frame). 'exit' translates to the star's effective
  // minDistance along the camera's current backward direction; on
  // completion controls.target snaps to the focal star and
  // TrackballControls re-enables. 'unfocus' is the navigate-mode
 // close-zoom outbound lerp: focus has already been cleared
  // when the lerp starts, the camera lerps from its close-orbit position
  // outward to the former focal star's parking distance, and on
  // completion controls.minDistance is tightened to that parking
  // distance so manual zoom-in is bounded.
  kind: 'enter' | 'exit' | 'unfocus';
  // Only meaningful for 'exit'. When true, finish() calls setFocus(null)
  // right after the camera lands at minDistance — used by the X button on
  // the location search so the user gets the same zoom-out animation
  // whether they're returning to navigate-with-focus or fully unfocusing.
  clearFocusOnExit?: boolean;
  // Only meaningful for 'unfocus'. controls.minDistance to set when the
  // lerp lands. The caller (Stellata.unfocus) clamps minDistance to the
  // pre-animation eye distance before starting the lerp so the camera
  // doesn't get pushed outward when the lerp begins; this value tightens
  // minDistance to the parking distance once the lerp completes.
  finalMinDistance?: number;
  // Park-arrival state for 'unfocus' (the outbound zoom from inside
  // parkDist back to the former focal star's park distance). Set only on
  // the unfocus path; tick() delegates that branch to tickArrival so
 // 's log-distance profile can be swapped in by touching the
  // helper alone. enter/exit aren't park-arrivals (see
  // docs/camera-arrival.md § Inventory) and keep their inline
  // time-smoothstep.
  arrival?: ArrivalState;
}

export interface ObserveTransitionDeps {
  camera: THREE.PerspectiveCamera;
  controls: TrackballControls;
  observeControls: ObserveControls;
  /** Aim slerps in flight need to clear on observe-exit (their post-flight
   *  re-enable would fight the upcoming exit / TrackballControls
   *  handover). The controller calls `aim.cancel()` at every startExit
   *  entry. */
  aim: AimController;
  /** Direct handle on `material.uniforms.uHideFocusIdx`. The 'enter' kind
   *  pins the focal star to invisible at finish (the user is standing
   *  ON the star — its disc would render from the interior). 'exit'
   *  flips it back to -1 at start. */
  uHideFocusIdxRef: { value: number };
  bus: EventBus<StellataEventMap>;
  focus: ObserveFocusOps;
  getCameraMode: () => CameraMode;
  /** Raw field setter — the controller writes mode then emits
   *  'cameraMode' itself. Stellata still owns the field; this callback
   *  is just the write. */
  setCameraModeValue: (mode: CameraMode) => void;
}

export class ObserveTransition {
  private readonly deps: ObserveTransitionDeps;
  private state: ObserveTransitionState | null = null;

  constructor(deps: ObserveTransitionDeps) {
    this.deps = deps;
  }

  /** True when an observe-mode transition (enter or exit) is in flight.
   *  The 'unfocus' kind is excluded — it reuses the state slot for a
   *  navigate-mode lerp and shouldn't surface to UI / overlay code that's
   *  gating on observe-mode visibility. */
  isActive(): boolean {
    return this.state !== null && this.state.kind !== 'unfocus';
  }

  /** Union of all three kinds — true whenever the state slot is occupied.
   *  Drives Stellata.isCameraBusy() so a new camera-driving action can't
   *  fire while a navigate-mode close-zoom is mid-flight. */
  isAnyActive(): boolean {
    return this.state !== null;
  }

  /** Eased progress of the in-flight observe-mode camera translate, or
   *  null if no transition is active. `f` matches the easing inside
   *  `tick()` so overlays that lerp alongside the camera (focus ring
   *  shrink, HUD ring grow) stay in sync visually. The 'unfocus' lerp
   *  reuses the same state slot but isn't an observe transition — hide
   *  it from this getter so overlay code stays steady-state-navigate
   *  during the lerp. */
  getProgress(): { f: number; kind: 'enter' | 'exit' } | null {
    const s = this.state;
    if (!s || s.kind === 'unfocus') return null;
    const t = Math.min(1, (performance.now() - s.startTimeMs) / s.durationMs);
    const f = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    return { f, kind: s.kind };
  }

  /** Switch between the two camera modes. OBSERVE parks the camera at
   *  the focused star and swaps TrackballControls for an in-place
   *  look-around controller. NAVIGATE is the default orbit-camera flow.
   *
   *  Defensive against:
   *    - re-entry while a transition is in flight (no-op via
   *      `focus.isCameraBusy()`)
   *    - request matching the current mode (no-op)
   *    - OBSERVE without a focused star (no-op — the UI gates the toggle
   *      but URL state could carry mode=observe without a focus)
   *    - OBSERVE during warp / aim (no-op — those animations own the
   *      camera, surfaced via `focus.isCameraBusy()`)
   *
   *  `animate=false` skips the transition; used by URL restore so a
   *  shared link with mode=observe lands instantly at the parked pose. */
  setMode(mode: CameraMode, opts: { animate?: boolean } = {}): void {
    if (mode === this.deps.getCameraMode()) return;
    if (this.deps.focus.isCameraBusy()) return;
    if (mode === 'observe') {
      const focusedStar = this.deps.focus.getFocusedStar();
      if (focusedStar === null) return;
      // Drop any drawn vector — measurement endpoints don't survive a
      // perspective change to "I'm standing on the source."
      this.deps.focus.setVectorTo(null);
      this.deps.focus.setVectorToCloud(null);
      this.deps.setCameraModeValue('observe');
      this.deps.controls.enabled = false;
      if (opts.animate === false) {
        // Snap. Camera quaternion is preserved; only its position moves
        // to the focal star's local origin. Hide the focal star here
        // since there's no transition to defer to.
        this.deps.camera.position.set(0, 0, 0);
        this.deps.uHideFocusIdxRef.value = focusedStar;
        this.deps.observeControls.enable();
      } else {
        // Animated entry: keep the focal star visible during the glide.
        // finish() with kind='enter' sets uHideFocusIdx once the camera
        // is parked at the star, so the star doesn't pop out before the
        // camera reaches it.
        this.state = {
          startTimeMs: performance.now(),
          durationMs: OBSERVE_TRANSITION_MS,
          fromPos: this.deps.camera.position.clone(),
          toPos: new THREE.Vector3(0, 0, 0),
          kind: 'enter',
        };
      }
      this.deps.bus.emit('cameraMode', 'observe');
      this.deps.bus.emit('state');
      return;
    }

    // mode === 'navigate'
    this.startExit({
      animate: opts.animate !== false,
      clearFocusOnExit: false,
    });
  }

  /** Shared exit path from OBSERVE → navigate. Used by:
   *    - the navigate-mode toggle (setMode('navigate'), focus retained)
   *    - the location-search X button (clearFocusOnExit=true; setFocus
   *      runs on landing)
   *    - the chart-mode disengage path (currently routes through setMode
   *      via the chart-mode orchestrator)
   *    - Stellata.unfocus()'s observe-animated branch (animate=true,
   *      clearFocusOnExit=false; the caller invokes setFocus(null) after
   *      startExit so the search box empties immediately while the camera
   *      glides outward)
   *
   *  Always emits the mode-change + state-change events so listeners
   *  settle once per exit regardless of which path triggered it. */
  startExit(opts: { animate: boolean; clearFocusOnExit: boolean }): void {
    if (this.deps.getCameraMode() !== 'observe') return;
    this.deps.setCameraModeValue('navigate');
    this.deps.uHideFocusIdxRef.value = -1;
    this.deps.observeControls.disable();
    // Cancel any in-flight observe aim — its post-flight re-enable would
    // fight the upcoming exit transition / TrackballControls handover.
    this.deps.aim.cancel();

    const focusedStar = this.deps.focus.getFocusedStar();
    if (!opts.animate || focusedStar === null) {
      // Hard switch. controls.target snaps back to the focal star's
      // local origin (or world origin when unfocused) and
      // TrackballControls re-enables.
      this.deps.controls.target.set(0, 0, 0);
      alignCameraUpToQuaternion(this.deps.camera);
      this.deps.controls.update();
      this.deps.controls.enabled = true;
      this.state = null;
      if (opts.clearFocusOnExit) this.deps.focus.setFocus(null);
    } else {
      // Pull back along the camera's current view direction so whatever
      // the user was just looking at stays roughly forward after exit.
      // Distance = the focal star's effective minDistance, so orbit
      // picks up exactly where it would on a fresh focus.
      const forward = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(this.deps.camera.quaternion);
      const minDist = this.deps.focus.parkDistForStar(focusedStar);
      this.state = {
        startTimeMs: performance.now(),
        durationMs: OBSERVE_TRANSITION_MS,
        fromPos: this.deps.camera.position.clone(),
        toPos: forward.multiplyScalar(-minDist),
        kind: 'exit',
        clearFocusOnExit: opts.clearFocusOnExit,
      };
    }
    this.deps.bus.emit('cameraMode', 'navigate');
    this.deps.bus.emit('state');
  }

 /** Navigate-mode close-zoom outbound lerp. The user has
   *  unfocused from inside the focal star's park distance; instead of
   *  teleporting them outward to parkDist, lerp the camera position from
   *  `fromPos` (close-orbit pose) to `toPos` (along the camera→target
   *  axis at the former focal star's parkDist). On completion,
   *  controls.minDistance is tightened to `finalMinDistance` so manual
   *  zoom-in is bounded.
   *
   *  Callers (Stellata.unfocus's navigate-close-zoom branch):
   *  - must have ALREADY cleared focus and clamped controls.minDistance
   *    to ≤ current eye distance — otherwise TrackballControls fights
   *    the lerp's outward motion at the first tick.
   *  - must NOT toggle controls.enabled (see the inline comment in
   *    Stellata.unfocus for the TrackballControls pointerup race). */
  startUnfocusLerp(
    fromPos: THREE.Vector3,
    toPos: THREE.Vector3,
    finalMinDist: number,
  ): void {
    const startMs = performance.now();
    const eye = fromPos.distanceTo(this.deps.controls.target);
    this.state = {
      startTimeMs: startMs,
      durationMs: OBSERVE_TRANSITION_MS,
      fromPos: fromPos.clone(),
      toPos: toPos.clone(),
      kind: 'unfocus',
      finalMinDistance: finalMinDist,
      arrival: newArrival({
        pStart: fromPos,
        pEnd: toPos,
        target: { center: this.deps.controls.target, parkDist: finalMinDist },
        startMs,
        durationMs: OBSERVE_TRANSITION_MS,
        // Outbound — d0 < dEnd (camera was inside parkDist, moving
        // outward to minDist). The hybrid curve detects outbound and
        // falls back to cubic-Hermite; passing `targetRadius: null`
        // enforces the same path even if a future curve cared about
        // direction.
        easeUFn: warpArrivalEaseFn({
          d0: eye,
          dEnd: finalMinDist,
          targetRadius: null,
        }),
      }),
    };
    this.deps.bus.emit('state');
  }

 /** Cancel an in-flight 'unfocus' lerp so a new
   *  camera-changing action (focus, warp, aim, click) can proceed without
   *  the lerp's next tick lerping the camera away from the action's
   *  destination. No-op for observe enter/exit transitions and when no
   *  transition is active. Public so the FocusOps shim WarpController
   *  consumes can route through here without reaching into the
   *  controller's privates. */
  cancelUnfocusLerp(): void {
    if (this.state?.kind === 'unfocus') {
      this.state = null;
    }
  }

  /** Unconditional slot clear. Used by Stellata.setFocus's
   *  observe-cleanup branch when the focal star is changing mid-flight
   *  — both 'enter' and 'exit' transitions reference the OLD focal star
   *  via fromPos/toPos and must be dropped before the new focus's
   *  recentre. */
  cancelTransition(): void {
    this.state = null;
  }

  /** Per-frame tick. The integration shell dispatches here exactly when
   *  `isAnyActive()` is true; the controller doesn't gate further
   *  because the per-kind branches are mutually exclusive by
   *  construction.
   *
   *  Symmetric ease translate from `fromPos` to `toPos`, no quaternion
   *  change. Camera look direction is preserved by holding the
   *  quaternion fixed; we skip controls.update() during the run so the
   *  target doesn't tug it.
   *
   *  'unfocus' is the navigate-mode outbound park-arrival; it shares the
   *  deceleration shape with focus-park and warp Fly via tickArrival so
 * 's log-distance swap lands in one place. 'enter' / 'exit' are
   *  observe-mode handovers — endpoints are AT or near the focal star,
   *  not at parkDist — so they keep the inline time-smoothstep (see
   *  docs/camera-arrival.md § Inventory). */
  tick(nowMs: number): void {
    const state = this.state;
    if (!state) return;
    if (state.kind === 'unfocus' && state.arrival) {
      const { done } = tickArrival(state.arrival, nowMs, this.deps.camera);
      if (done) this.finish();
      return;
    }
    const t = Math.min(1, (nowMs - state.startTimeMs) / state.durationMs);
    const f = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    this.deps.camera.position.lerpVectors(state.fromPos, state.toPos, f);
    if (t >= 1) this.finish();
  }

  dispose(): void {
    this.state = null;
  }

  private finish(): void {
    const state = this.state;
    if (!state) return;
    this.state = null;
    if (state.kind === 'enter') {
      this.deps.camera.position.copy(state.toPos);
      // Hide the focal star now that the camera is parked at it.
      // Deferred from setMode so the user sees the star throughout the
      // glide — popping it out at transition start would read as "star
      // vanishes, then camera moves into its location" rather than a
      // continuous arrival.
      const focusedStar = this.deps.focus.getFocusedStar();
      if (focusedStar !== null) {
        this.deps.uHideFocusIdxRef.value = focusedStar;
      }
      this.deps.observeControls.enable();
    } else if (state.kind === 'unfocus') {
      this.deps.camera.position.copy(state.toPos);
      // Tighten controls.minDistance to the parking distance the camera
      // just landed at. The caller (Stellata.unfocus) clamped it to the
      // (smaller) start eye distance to let the lerp move outward; now
      // that the camera is parked, the same minDistance the focused star
      // had during close orbit becomes the unfocused floor.
      // controls.target was not touched during the lerp (tick() lerps
      // camera.position directly and skips controls.update()) so it
      // stays at whatever it was at unfocus start — usually (0,0,0) =
      // former focal star's local origin = a sensible orbit pivot.
      if (state.finalMinDistance !== undefined) {
        this.deps.controls.minDistance = state.finalMinDistance;
      }
      this.deps.controls.update();
    } else {
      this.deps.camera.position.copy(state.toPos);
      // Target = the camera's pre-exit position (= the observed star's
      // location, in whichever frame is current). The exit translates
      // backward along the camera's forward direction by minDist, so
      // fromPos lies exactly along forward at that distance, which makes
      // TrackballControls.update()'s lookAt(target) a no-op for
      // orientation and gives the user a sensible orbit pivot (the star
      // they just left) for any subsequent drag.
      //
      // Both exit branches (focus-retained / unfocus) leave worldOffset
      // on the former focal star — setFocus(null) doesn't recentre — so
      // fromPos is the captured camera position in that local frame.
      // target = (0,0,0) would whip the camera onto the focal star;
      // target = fromPos keeps lookAt a no-op.
      this.deps.controls.target.copy(state.fromPos);
      alignCameraUpToQuaternion(this.deps.camera);
      this.deps.controls.update();
      this.deps.controls.enabled = true;
      if (state.clearFocusOnExit) this.deps.focus.setFocus(null);
    }
    this.deps.bus.emit('state');
  }
}
