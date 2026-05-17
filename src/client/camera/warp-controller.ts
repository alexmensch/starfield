// 3-phase warp FSM (reorient → fly → post-arrival). Coupling via
// `FocusOps` (defined in ./focus-controller; re-exported here).
//
// See docs/camera-warp.md and docs/camera-arrival.md.

import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { CameraMode, StellataEventMap } from '../stellata';
import type { EventBus } from '../util/event-bus';
import type { FocusTarget } from './focus-target';
import { type FocusOps } from './focus-controller';
import type { ObserveControls } from './observe-controls';

export type { FocusOps };
import {
  type ArrivalState,
  newArrival,
  shiftArrivalWaypoints,
  tickArrival,
} from './camera-motion';
import { shiftWarpWaypoints } from './warp-pure';
import { WARP_BASE_DIR } from './timing';
import {
  recordLastWarp,
  warpArrivalEaseFn,
  warpArrivalHybridSeamK,
  warpChartPhase3Alpha,
  warpChartPhase3ScalingEnabled,
  warpChartPlateauMargin,
  warpFlyTKMs,
  warpFlyTMaxMs,
  warpFlyTMinMs,
  warpMidFlyRecentreFrac,
  warpObserveTransitionMs,
  warpReorientMs,
} from './warp-tuning';
import { hybridUSeam } from './arrival-curves';

export type WarpPhaseKind = 'reorient' | 'fly' | 'post-arrival';

export interface WarpPhaseInfo {
  kind: WarpPhaseKind;
  elapsedMs: number;
  totalMs: number;
  u: number;
  recenteredToDest: boolean;
  chartPlateauDist: number | null;
  chartPlateauTriggered: boolean;
  flyRegime?: 'outer' | 'inner' | 'fallback';
  flyArrivalUSeam?: number;
}

export interface WarpInfo {
  A: Readonly<THREE.Vector3>;
  B: Readonly<THREE.Vector3>;
  destKind: 'star' | 'cloud';
  destIdx: number;
}

export interface WarpControllerDeps {
  camera: THREE.PerspectiveCamera;
  controls: TrackballControls;
  observeControls: ObserveControls;
  /** Direct handle on `material.uniforms.uHideFocusIdx` — the source
   *  star stays pinned to -1 except across the observe-launch reorient
   *  (where it's already pinned to the source by setCameraMode), so the
   *  controller only writes -1 on navigate-mode arrival and `dest.idx`
   *  on observe→observe arrival via swapObserveAnchor. */
  uHideFocusIdxRef: { value: number };
  bus: EventBus<StellataEventMap>;
  getCameraMode: () => CameraMode;
  /** Whether chart mode is currently engaged — read at startWarp to
   *  decide whether to cache the chart plateau-trigger distance. */
  isChartMode: () => boolean;
  /** Live `uChartMagBright` shader uniform — read at startWarp to feed
   *  `dest.chartPlateauDistance(magBright)`. */
  getChartMagBright: () => number;
  focus: FocusOps;
}

interface WarpState {
  startTimeMs: number;
  reorientMs: number;
  durationMs: number;
  postArrivalMs: number;
  A: THREE.Vector3;
  dir0: THREE.Vector3;
  mag0: number;
  dirBack: THREE.Vector3;
  pStart: THREE.Vector3;
  pEnd: THREE.Vector3;
  endOffset: number;
  sourceOffset: number;
  source: FocusTarget;
  dest: FocusTarget;
  recenteredToDest: boolean;
  returnToObserve: boolean;
  startQuaternion: THREE.Quaternion;
  flyEndQuaternion?: THREE.Quaternion;
  reorientEndQuaternion?: THREE.Quaternion;
  flyArrival: ArrivalState;
  flyArrivalUSeam: number;
  chartPlateauDist: number | null;
  chartPlateauTriggered: boolean;
  chartPhase3Scaled: boolean;
}

export class WarpController {
  private readonly deps: WarpControllerDeps;
  private state: WarpState | null = null;

  // Per-tick scratch — reused so the warp animation never allocates.
  // q0 / q1 / tmp drive the reorient + post-arrival slerps; tmpLocal is
  // the local-frame dest position the per-frame lookAt reads; tmpAbs is
  // the absolute-frame anchor the mid-Fly recentre reads; tmpWarpInfoB
  // backs the shared B slot getWarpInfo returns.
  private readonly q0 = new THREE.Quaternion();
  private readonly q1 = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly tmpLocal = new THREE.Vector3();
  private readonly tmpAbs = new THREE.Vector3();
  private readonly tmpWarpInfoB = new THREE.Vector3();

  constructor(deps: WarpControllerDeps) {
    this.deps = deps;
  }

  isActive(): boolean { return this.state !== null; }

  /** True after the mid-Fly (or phase-3) recentre has moved the floating
   *  origin onto the destination. Mirrors WarpState.recenteredToDest so
   *  the pin-to-NDC guard in the integration shell can engage during the
   *  post-recentre Fly window without reaching into private state. */
  isRecenteredToDest(): boolean {
    return this.state !== null && this.state.recenteredToDest;
  }

  /** Star-destination warp — flies from the currently focused thing
   *  (star or cloud) to a star at `destIdx`. No-ops if there's no focus,
   *  the destination equals the source, or the two are coincident in
   *  catalog space. */
  warpTo(destIdx: number): void {
    if (destIdx === this.deps.focus.getFocusedStar()) return;
    const source = this.deps.focus.currentFocusTarget();
    if (!source) return;
    const A = new THREE.Vector3();
    if (!source.localPositionInto(A)) return;
    const B = this.deps.focus.starLocalPosition(destIdx);
    this.startWarp(A, B, source, this.deps.focus.makeStarFocusTarget(destIdx));
  }

  /** Cloud-destination warp — flies from the currently focused thing
   *  to a cloud's centroid. Arrival distance is the cloud's recommended
   *  viewing distance (per FocusTarget.parkRadius). */
  warpToCloud(destIdx: number): void {
    if (destIdx === this.deps.focus.getFocusedCloud()) return;
    const dest = this.deps.focus.makeCloudFocusTarget(destIdx);
    if (!dest) return;
    const source = this.deps.focus.currentFocusTarget();
    if (!source) return;
    const A = new THREE.Vector3();
    if (!source.localPositionInto(A)) return;
    const B = new THREE.Vector3();
    if (!dest.localPositionInto(B)) return;
    this.startWarp(A, B, source, dest);
  }

  /** Jump to the end state of an in-flight warp. No-op when idle. */
  skip(): void {
    if (this.state) this.finishWarp();
  }

  /** Per-frame tick. The integration shell dispatches here exactly when
   *  `isActive()` is true; the controller doesn't gate on
   *  observe-transition / aim / focus-lerp because those are mutually
   *  exclusive with warp by construction (startWarp cancels each). */
  tick(nowMs: number): void {
    if (!this.state) return;
    this.updateWarp(nowMs);
  }

  /** Read-only snapshot of in-flight warp endpoints + destination
   *  identity. B is a shared scratch slot — callers must NOT mutate
   *  and must not retain it across frames. */
  getWarpInfo(): WarpInfo | null {
    const w = this.state;
    if (!w) return null;
    if (!w.dest.localPositionInto(this.tmpWarpInfoB)) return null;
    return {
      A: w.A,
      B: this.tmpWarpInfoB,
      destKind: w.dest.kind,
      destIdx: w.dest.idx,
    };
  }

  /** Read-only snapshot of in-flight warp phase + progress, for the
   *  debug-panel warp tuning readout. Returns null when no warp is
   *  active. `nowMs` defaults to `performance.now()` so production
   *  callers don't need to thread time through; tests pass the same
   *  clock they use to drive `tick(nowMs)` so the two views agree. */
  getWarpPhase(nowMs: number = performance.now()): WarpPhaseInfo | null {
    const w = this.state;
    if (!w) return null;
    const elapsed = nowMs - w.startTimeMs;
    if (elapsed < w.reorientMs) {
      const u = elapsed / w.reorientMs;
      return {
        kind: 'reorient', elapsedMs: elapsed, totalMs: w.reorientMs, u,
        recenteredToDest: w.recenteredToDest,
        chartPlateauDist: w.chartPlateauDist,
        chartPlateauTriggered: w.chartPlateauTriggered,
      };
    }
    const flyElapsed = elapsed - w.reorientMs;
    if (flyElapsed < w.durationMs) {
      const u = w.durationMs > 0 ? flyElapsed / w.durationMs : 1;
      const uSeam = w.flyArrivalUSeam;
      const flyRegime: 'outer' | 'inner' | 'fallback' =
        uSeam < 0 ? 'fallback' : u < uSeam ? 'outer' : 'inner';
      return {
        kind: 'fly', elapsedMs: flyElapsed, totalMs: w.durationMs, u,
        recenteredToDest: w.recenteredToDest,
        chartPlateauDist: w.chartPlateauDist,
        chartPlateauTriggered: w.chartPlateauTriggered,
        flyRegime,
        flyArrivalUSeam: uSeam,
      };
    }
    const postElapsed = flyElapsed - w.durationMs;
    const u = w.postArrivalMs > 0 ? Math.min(1, postElapsed / w.postArrivalMs) : 1;
    return {
      kind: 'post-arrival', elapsedMs: postElapsed,
      totalMs: w.postArrivalMs, u,
      recenteredToDest: w.recenteredToDest,
      chartPlateauDist: w.chartPlateauDist,
      chartPlateauTriggered: w.chartPlateauTriggered,
    };
  }

  dispose(): void {
    this.state = null;
  }

  private startWarp(
    A: THREE.Vector3,
    B: THREE.Vector3,
    source: FocusTarget,
    dest: FocusTarget,
  ): void {
    if (this.state) return;
    const focus = this.deps.focus;
    focus.cancelUnfocusLerp();
    focus.cancelFocusLerp();
    if (focus.isObserveTransitionActive()) return;
    // Warp launched from OBSERVE: leave cameraMode='observe' for the
    // duration so search-row, mode toggle, and any mode-bound UI don't
    // flicker through navigate. The animate loop branches off the
    // warp slot first, so the cosmetic mode value never reaches
    // observeUpdateTarget. uHideFocusIdx stays pinned to the source
    // for the reorient — unhiding it would briefly render the source
    // disc from the camera's interior.
    //
    // returnToObserve gates the post-arrival parallax slerp + observe
    // re-entry. Restricted to star destinations because observe-mode
    // parks the camera AT the focal object's local origin and that
    // invariant is only set up for stars today.
    let returnToObserve = false;
    if (this.deps.getCameraMode() === 'observe') {
      this.deps.observeControls.disable();
      returnToObserve = dest.kind === 'star';
    }
    const endOffset = dest.parkRadius();
    const AB = new THREE.Vector3().subVectors(B, A);
    const distPc = AB.length();
    if (distPc < 1e-6) {
      // Source and destination share a world position — e.g. AT-HYG
      // stores α Cen A (HIP 71683) and B (HIP 71681) at identical
      // x0/y0/z0 because the ~17.6 AU separation is below catalog
      // precision. The camera has nowhere to fly, but switching focus
      // still gives feedback (search row, focus ring, scale bar, vector
      // all retarget). Apply the destination's focus + emit immediately
      // — equivalent to a degenerate warp that lands at u=0. Route
      // through setFocus / setFocusedCloud so their own observe-cleanup
      // branches fire (the FocusTarget contract doesn't model those).
      if (dest.kind === 'star') focus.setFocus(dest.idx);
      else focus.setFocusedCloud(dest.idx);
      return;
    }
    const forward = AB.clone().divideScalar(distPc);

    // Reorient-end direction (from A): opposite to travel, so after the
    // reorient A is in front of the camera and B is further along the
    // same line.
    const dirBack = forward.clone().negate();
    // Source-side park keyed to the SOURCE's size, not the destination's,
    // so the reorient point isn't embedded inside a giant source star /
    // cloud when warping toward something tiny.
    const sourceOffset = source.parkRadius();
    const pStart = A.clone().addScaledVector(dirBack, sourceOffset);
    const pEnd = B.clone().addScaledVector(forward, -endOffset);

    const p0 = this.deps.camera.position.clone();
    const radial = new THREE.Vector3().subVectors(p0, A);
    const mag0 = radial.length();
    // If the user is somehow exactly at A (shouldn't happen; minDistance
    // guards against it), seed an arbitrary direction so the reorient
    // still runs instead of NaN-ing out.
    const dir0 = mag0 > 1e-9 ? radial.divideScalar(mag0) : dirBack.clone();

    // Warp duration / phase-3 / reorient durations + arrival curve are
    // read from the warp-tuning module so the debug panel can override
    // them live (next warp picks up the change). When the panel is
    // closed or its sliders untouched, the getters return the shipped
    // defaults (`WARP_T_*`, `WARP_REORIENT_MS`, `OBSERVE_TRANSITION_MS`,
    // hybrid arrival), so behaviour is identical to a build without
    // the panel.
    const reorientMs = warpReorientMs();
    const durationMs = Math.min(
      warpFlyTMaxMs(),
      warpFlyTMinMs() + warpFlyTKMs() * Math.log10(1 + distPc),
    );
    const postArrivalMs = returnToObserve ? warpObserveTransitionMs() : 0;
    // Resolve the arrival curve with per-warp context. The hybrid curve
    // consumes `{ d0, dEnd, targetRadius }`; missing R or outbound
    // trajectory triggers the cubic-Hermite log-d fallback inside the
    // closure (clouds, future kinds without a geometric radius).
    const flyD0 = pStart.distanceTo(B);
    const flyDestR = dest.physicalRadius();
    const arrivalEaseFn = warpArrivalEaseFn({
      d0: flyD0,
      dEnd: endOffset,
      targetRadius: flyDestR,
    });
    // Cache the outer→inner seam u-value for the live regime indicator
    // in the debug-panel warp readout. getWarpPhase reads this; the
    // hybrid curve itself recomputes the same value internally, so the
    // two stay in sync as long as the formula matches.
    const flyArrivalUSeam = hybridUSeam(
      flyD0,
      endOffset,
      flyDestR,
      warpArrivalHybridSeamK(),
    );

    this.deps.controls.enabled = false;
    // Point orbit-target at the destination from the moment the warp
    // begins so the scale bar reflects distance-to-destination
    // throughout (decreases monotonically from ~|AB| to the
    // destination's endOffset). Camera orientation is controlled
    // separately via camera.lookAt during updateWarp, so the reorient
    // can still keep A centered visually.
    this.deps.controls.target.copy(B);
    // Observe-mode warp starts with the camera AT A (mag0 ≈ 0) and a
    // user-chosen look direction. lookAt(A) per frame collapses to
    // "snap to facing forward" the moment the camera moves off A, so
    // we slerp the quaternion across the reorient phase instead.
    // Endpoint = the orientation lookAt(A) would produce from pStart,
    // captured here so the reorient interpolates from observe view to
    // fly orientation smoothly.
    let reorientEndQuaternion: THREE.Quaternion | undefined;
    if (returnToObserve) {
      const m = new THREE.Matrix4().lookAt(pStart, A, this.deps.camera.up);
      reorientEndQuaternion = new THREE.Quaternion().setFromRotationMatrix(m);
    }
    // Chart-mode plateau-trigger gate. Chart is observe-only
    // (chart-mode.ts auto-clears on observe→navigate), and the plateau
    // only matters when the destination disc is magnitude-driven — both
    // conditions captured here so the Fly phase doesn't have to
    // re-derive them per frame. `warpChartPlateauMargin()` lets the
    // debug panel scale the trigger distance — >1 fires earlier
    // (farther out), <1 fires later (deeper into the plateau).
    const rawPlateauDist =
      returnToObserve && this.deps.isChartMode()
        ? dest.chartPlateauDistance(this.deps.getChartMagBright())
        : null;
    const chartPlateauDist =
      rawPlateauDist !== null ? rawPlateauDist * warpChartPlateauMargin() : null;
    const warpStartMs = performance.now();
    this.state = {
      startTimeMs: warpStartMs,
      reorientMs,
      durationMs,
      // Post-arrival slerp only runs when we're returning to OBSERVE.
      // Navigate-mode arrival re-engages TrackballControls, whose
      // update() calls camera.lookAt(target=B) every frame — applying
      // a 1.2 s parallax slerp there would just be overwritten one
      // frame later when controls re-asserts itself, leaving the user
      // with a jarring snap-back. Skipping the slerp on navigate keeps
      // the landing visually consistent with how navigate-mode focuses
      // already work.
      postArrivalMs,
      A,
      dir0,
      mag0,
      dirBack,
      pStart,
      pEnd,
      endOffset,
      sourceOffset,
      source,
      dest,
      recenteredToDest: false,
      returnToObserve,
      startQuaternion: this.deps.camera.quaternion.clone(),
      reorientEndQuaternion,
      flyArrival: newArrival({
        pStart,
        pEnd,
        target: { center: B, parkDist: endOffset },
        startMs: warpStartMs + reorientMs,
        durationMs,
        easeUFn: arrivalEaseFn,
      }),
      flyArrivalUSeam,
      chartPlateauDist,
      chartPlateauTriggered: false,
      chartPhase3Scaled: false,
    };
    this.deps.bus.emit('warp', true);
    this.deps.bus.emit('state');
  }

  private finishWarp(): void {
    const state = this.state;
    if (!state) return;
    // Record warp summary for the debug-panel readout BEFORE clearing
    // state. Cheap (one object write to a module-level slot). Source
    // identity comes from the FocusTarget snapshotted at startWarp;
    // total ms is wall-clock since warp start.
    recordLastWarp({
      sourceKind: state.source.kind,
      sourceIdx: state.source.idx,
      destKind: state.dest.kind,
      destIdx: state.dest.idx,
      totalMs: performance.now() - state.startTimeMs,
      plateauFired: state.chartPlateauTriggered,
      plateauScaledPhase3: state.chartPhase3Scaled,
      plateauDistPc: state.chartPlateauDist,
    });
    const Bout = this.tmpLocal;
    const B = state.dest.localPositionInto(Bout) ? Bout.clone() : null;
    if (!B) {
      // Cloud detached mid-warp (shouldn't happen in practice); bail
      // gracefully to a clean state rather than NaN-ing the camera.
      this.state = null;
      this.deps.controls.enabled = true;
      this.deps.bus.emit('warp', false);
      return;
    }
    // Final parked pose. Differs by destination mode:
    //   observe: camera at B, quaternion = startQuaternion (post-arrival
    //            slerp end — same celestial direction the user was
    //            looking at warp start, now from the new vantage). The
    //            post-arrival phase already lerped position pEnd → B, so
    //            this is a no-op match against the last animation frame.
    //            For observe→observe arrivals the floating origin was
    //            already moved onto B at phase-3 start; swapObserveAnchor's
    //            geometric half is a no-op here, only its observe-tail
    //            (uHide + camera snap) runs.
    //   navigate: camera at B − endOffset · forward (orbit radius matches
    //            the arrival we animated to), lookAt(B) so the orbit
    //            invariant TrackballControls.update() will enforce next
    //            frame matches the parked pose.
    if (state.returnToObserve) {
      this.deps.camera.position.copy(B);
      this.deps.camera.quaternion.copy(state.startQuaternion).normalize();
    } else {
      const forward = new THREE.Vector3().subVectors(B, state.pStart).normalize();
      this.deps.camera.position.copy(B).addScaledVector(forward, -state.endOffset);
      this.deps.camera.lookAt(B);
    }
    this.deps.controls.target.copy(B);
    this.state = null;
    // Clear both vector slots — vector destination has been reached.
    this.deps.focus.setVectorTo(null);
    this.deps.focus.setVectorToCloud(null);
    if (state.dest.kind === 'star' && state.returnToObserve) {
      // observe→observe arrival. swapObserveAnchor finalises the anchor
      // swap — sets uHideFocusIdx to the destination, snaps the camera
      // to local origin, and (if it hasn't already been done at phase-3
      // start for jitter mitigation) recentres the floating origin and
      // updates focused-star state. No cameraMode flip through navigate
      // (which is what setFocus would do, triggering a 'cameraMode'
      // event flicker).
      this.swapObserveAnchor(state.dest.idx);
      this.deps.observeControls.enable();
      // controls.enabled stays false — observe owns the camera now.
    } else {
      // Navigate-mode arrival. Source-star hide expires with the warp;
      // the destination star (if any) renders normally.
      this.deps.uHideFocusIdxRef.value = -1;
      if (state.recenteredToDest) {
        // Mid-Fly recentre already mutated focus state via
        // `dest.applyFocus`. Fire the deferred event family here so the
        // search-row label, planet system, distance vector etc. settle
        // in lock-step with the camera landing rather than ~half a warp
        // duration early. Calling setFocus / setFocusedCloud directly
        // would short-circuit (focusedStar / focusedCloud already
        // matches dest.idx) and silently drop the 'focus' / 'cloudFocus'
        // emit; emitting via the FocusTarget keeps the contract clean.
        state.dest.emitFocusEvents();
        if (state.dest.kind === 'star') {
          // Mid-Fly recentre put the destination at local (0,0,0) and
          // shifted camera + target by the same delta — controls.target
          // is already clean. Reassert the parked pose so subsequent
          // TrackballControls.update() lands at the canonical orbit
          // distance.
          const forward = new THREE.Vector3().subVectors(B, state.pStart).normalize();
          this.deps.controls.target.set(0, 0, 0);
          this.deps.camera.position.copy(forward).multiplyScalar(-state.endOffset);
          this.deps.camera.lookAt(this.deps.controls.target);
        }
      } else if (state.dest.kind === 'star') {
        this.deps.focus.setFocus(state.dest.idx);
        // Re-anchor camera and target in the clean dest-local frame after
        // setFocus's recenterOrigin runs. The earlier writes used B from
        // _localPositions (Float32) while recenterOrigin's dx is computed
        // fresh in float64 — the difference leaves controls.target offset
        // by a ~|AB|·1e-7 residual, which on long warps to small stars
        // disengages the pin guard (lengthSq < 1e-12) and lands the dest
        // visibly off-centre. Snapping to clean values here avoids that.
        const forward = new THREE.Vector3().subVectors(B, state.pStart).normalize();
        this.deps.controls.target.set(0, 0, 0);
        this.deps.camera.position.copy(forward).multiplyScalar(-state.endOffset);
        this.deps.camera.lookAt(this.deps.controls.target);
      } else {
        this.deps.focus.setFocusedCloud(state.dest.idx);
      }
      this.deps.controls.enabled = true;
      this.deps.controls.update();
    }
    this.deps.bus.emit('warp', false);
  }

  // Swap the OBSERVE anchor to a new star without going through setFocus's
  // observe-cleanup branch (which would flip cameraMode to navigate and
  // emit a 'cameraMode' event, briefly flickering UI bound to mode).
  // Used by finishWarp on observe→observe arrival. Idempotent on the
  // geometric half: if the phase-3 recentre already landed focusedStar
  // on newIdx, only the observe-specific tail runs (anchor hide + camera
  // snap to local origin). The 'focus' event fires unconditionally so
  // the deferred-from-phase-3 case still emits in lockstep with arrival.
  private swapObserveAnchor(newIdx: number): void {
    if (this.deps.focus.getFocusedStar() !== newIdx) {
      this.deps.focus.recenterFocusToStar(newIdx);
    }
    this.deps.uHideFocusIdxRef.value = newIdx;
    // Park at the new anchor's local origin — observe invariant is
    // camera at (0,0,0) under the floating origin. Quaternion preserved
    // from the post-arrival slerp end state.
    this.deps.camera.position.set(0, 0, 0);
    this.deps.bus.emit('focus', newIdx);
    this.deps.bus.emit('state');
  }

  // Mid-flight floating-origin recentre onto the warp destination. Fires
  // at most once per warp, gated on the camera having passed the
  // trajectory midpoint (|camera − B|² < ¼·|B − A|², i.e. closer to
  // dest than source — Alex's "source star is behind the camera" cue).
  // Under the cubic-Hermite log-d Fly profile this fires comfortably
  // before the Float32 chaos zone — for a 200 pc → 1 AU Sol arrival,
  // midpoint is at u ≈ 0.34, chaos zone at u ≈ 0.66.
  //
  // After firing: dest.localPositionInto returns ≈(0,0,0) for the
  // rest of the warp, lookAt(local origin) escapes the B−camera.position
  // ULP fight, and focus state is mutated in place via dest.applyFocus
  // (events fire from finishWarp via dest.emitFocusEvents so search-row
  // label etc. settle in lock-step with the camera landing).
  // Kind-agnostic via FocusTarget; used by both the navigate Fly branch
  // and the observe→observe phase-3 branch.
  private tryMidFlyRecentre(state: WarpState): void {
    if (state.recenteredToDest) return;
    const tmp = this.tmpAbs;
    if (!state.dest.localPositionInto(tmp)) return;
    const cb = this.deps.camera.position;
    const dx = tmp.x - cb.x, dy = tmp.y - cb.y, dz = tmp.z - cb.z;
    const cbDist2 = dx * dx + dy * dy + dz * dz;
    const ax = tmp.x - state.A.x, ay = tmp.y - state.A.y, az = tmp.z - state.A.z;
    const abDist2 = ax * ax + ay * ay + az * az;
    // Past trajectory midpoint? Fall through to the recentre; else bail.
    // The fraction (0.25 = midpoint by default) is tunable via the warp
    // debug panel — lower fires the recentre later (less of Fly in the
    // dest-local frame), higher fires it earlier.
    const frac = warpMidFlyRecentreFrac();
    if (cbDist2 >= frac * frac * abDist2) return;
    // `anchorInto` overwrites `tmp` from local-frame to absolute-frame.
    if (!state.dest.anchorInto(tmp)) return;
    const delta = this.deps.focus.recenterOrigin(tmp);
    if (!delta) return;
    shiftWarpWaypoints(state, delta.x, delta.y, delta.z);
    shiftArrivalWaypoints(state.flyArrival, delta.x, delta.y, delta.z);
    // Float32 residual snap (same shape as setFocus's). The earlier
    // `controls.target.copy(B)` at startWarp set target from a Vector3
    // derived via `_localPositions` (Float32) — the value has ~|B|·1e-7
    // ULP relative to true B. recenterOrigin then shifts target by a
    // delta computed fresh in float64 from raw catalog reads, leaving
    // target at `(true_B − rounded_B)` which is the ULP residual.
    // lengthSq = ~|B|²·1e-14 fails the 1e-12 pin guard on any non-
    // trivial warp (Sol→Rigel: ~|265pc|²·1e-14 ≈ 7e-10, ~700× over
    // threshold). Snap target to clean (0,0,0) and shift camera by
    // the same residual to preserve the cam-to-target offset — the
    // user-visible pose doesn't change, but the pin guard engages
    // for the post-recentre Fly window as designed.
    const t = this.deps.controls.target;
    this.deps.camera.position.x -= t.x;
    this.deps.camera.position.y -= t.y;
    this.deps.camera.position.z -= t.z;
    t.set(0, 0, 0);
    // Same float32-residual class lives in the cached waypoints.
    // Reconstruct canonical dest-local geometry from `dirBack` (a unit
    // vector — ULP ~|1|·2^-23, multiplied by `endOffset` of ~5e-6 pc
    // yields ~5e-13 pc residual, well below any visual threshold).
    // `state.flyArrival.dir` was cached from the `pStart − target.center`
    // difference at newArrival time — that difference is translation-
    // invariant under the shift, so `dir` is still correct without
    // re-derivation.
    state.flyArrival.target.center.set(0, 0, 0);
    state.flyArrival.pEnd.copy(state.dirBack).multiplyScalar(state.endOffset);
    state.pEnd.copy(state.dirBack).multiplyScalar(state.endOffset);
    state.dest.applyFocus();
    state.recenteredToDest = true;
  }

  private updateWarp(nowMs: number): void {
    const state = this.state;
    if (!state) return;
    const elapsed = nowMs - state.startTimeMs;

    if (elapsed < state.reorientMs) {
      // Reorient phase: spherically slerp the camera's radial direction
      // from the user's starting angle around A to `dirBack`, while
      // linearly easing the distance from A from `mag0` down to
      // sourceOffset. Look-at stays locked on A so A remains centered
      // in view the whole time. Quaternion slerp robustly handles any
      // starting angle including antipodal cases.
      const u = elapsed / state.reorientMs;
      const f = u * u * (3 - 2 * u);

      this.q0.setFromUnitVectors(WARP_BASE_DIR, state.dir0);
      this.q1.setFromUnitVectors(WARP_BASE_DIR, state.dirBack);
      this.q0.slerp(this.q1, f);
      this.tmp.copy(WARP_BASE_DIR).applyQuaternion(this.q0);

      const mag = state.mag0 * (1 - f) + state.sourceOffset * f;
      this.deps.camera.position.copy(state.A).addScaledVector(this.tmp, mag);
      if (state.reorientEndQuaternion) {
        // Observe-mode launch: slerp the camera quaternion from the
        // user's view direction to the fly-start orientation. Replaces
        // lookAt(A), which would snap to "facing forward" the instant
        // the camera leaves A.
        this.q0.copy(state.startQuaternion).slerp(state.reorientEndQuaternion, f);
        this.deps.camera.quaternion.copy(this.q0).normalize();
      } else {
        this.deps.camera.lookAt(state.A);
      }
      return;
    }

    // Fly phase: symmetric accelerate/decelerate along the A→B line.
    // Position easing rides camera-motion.ts's shared park-arrival
    // profile (same helper as focus-park and unfocus); the per-frame
    // lookAt(B) continues to drive camera orientation so the
    // destination stays centred while the camera approaches.
    const flyElapsed = elapsed - state.reorientMs;
    if (flyElapsed < state.durationMs) {
      tickArrival(state.flyArrival, nowMs, this.deps.camera);
      // Mid-Fly recentre — pull the floating-origin shift forward from
      // finishWarp the moment the camera passes the trajectory midpoint.
      // Without this, the last ~19 % of Fly under cubic-Hermite log-d
      // sits inside `|B − camera| < ULP(|B|)`, where lookAt(B) jitters
      // across Float32 representations and the destination renders
      // off-screen for several frames before finishWarp's recentre
      // snaps it to NDC origin. After this recentre
      // `dest.localPositionInto` returns ≈(0,0,0), so lookAt below
      // becomes lookAt(local origin) — geometrically equivalent,
      // numerically clean.
      if (!state.recenteredToDest) {
        this.tryMidFlyRecentre(state);
      }
      const out = this.tmpLocal;
      const haveDest = state.dest.localPositionInto(out);
      if (haveDest) {
        this.deps.camera.lookAt(out);
      }
      // Chart-mode close-approach plateau-trigger. The chart-style disc
      // plateaus at `uChartDiscMaxPx` once `appMag ≤ magBright`, so
      // further Fly produces no visible disc growth — under the
      // cubic-Hermite log-d profile that "no progress signal" window
      // can span hundreds of milliseconds. Pivot Fly → phase 3 early
      // and let the parallax slerp carry the perceptual cue across the
      // plateau zone. Gated on `recenteredToDest` so the trigger only
      // fires once the destination is at local (0,0,0).
      if (
        state.chartPlateauDist !== null &&
        !state.chartPlateauTriggered &&
        state.recenteredToDest &&
        haveDest &&
        this.deps.camera.position.distanceToSquared(out) <=
          state.chartPlateauDist * state.chartPlateauDist
      ) {
        // End Fly NOW: set pEnd to the current camera position so
        // phase 3's first frame snaps to where we already are (and
        // captures flyEndQuaternion from the lookAt(dest) we just
        // applied), then lerps pEnd → B over postArrivalMs. Updating
        // durationMs to the current flyElapsed falls the next frame
        // straight into the post-arrival branch without an extra Fly
        // tick. state.flyArrival is no longer ticked, so its cached
        // pEnd doesn't need updating.
        state.pEnd.copy(this.deps.camera.position);
        state.durationMs = flyElapsed;
        state.chartPlateauTriggered = true;
        // Optional chart phase-3 duration scaling (debug-panel knob).
        // For long warps where the plateau distance is large compared
        // to endOffset, the default fixed-duration phase 3 sweeps a
        // lot of distance in 1200 ms which can feel too fast. Scale by
        // 1 + α·log10(d_trigger / endOffset) so longer plateau-to-park
        // hauls get proportionally more time. Default-off; the knob
        // reads from warp-tuning at the trigger moment so the user can
        // dial it in across smoke warps.
        if (warpChartPhase3ScalingEnabled()) {
          const dTrigger = this.deps.camera.position.distanceTo(out);
          if (dTrigger > state.endOffset && state.endOffset > 0) {
            const alpha = warpChartPhase3Alpha();
            const scale = 1 + alpha * Math.log10(dTrigger / state.endOffset);
            state.postArrivalMs *= Math.max(1, scale);
            state.chartPhase3Scaled = true;
          }
        }
      }
      return;
    }

    // Post-arrival phase: slerp the quaternion from the fly-end
    // "looking at destination" orientation back to the warp's captured
    // starting orientation, AND for observe→observe arrivals lerp
    // position from pEnd → B so the parallax view ends with the
    // camera exactly at the destination star (rather than offset by
    // endOffset, which would leave a hidden teleport for
    // swapObserveAnchor to absorb at finishWarp). The user sees the
    // same celestial direction they had at warp start, now from the
    // new vantage — foreground stars shift via parallax, distant Milky
    // Way stays roughly fixed.
    const postElapsed = flyElapsed - state.durationMs;
    if (postElapsed < state.postArrivalMs) {
      const out = this.tmpLocal;
      let B = state.dest.localPositionInto(out) ? out : null;
      if (!state.flyEndQuaternion) {
        // Pin the camera to the canonical fly-end pose before snapshot
        // so the slerp doesn't inherit a half-stepped frame.
        this.deps.camera.position.copy(state.pEnd);
        if (B) this.deps.camera.lookAt(B);
        state.flyEndQuaternion = this.deps.camera.quaternion.clone();
        // observe→observe arrivals: pull the destination recentre
        // forward from finishWarp to phase-3 start. The parallax slerp
        // lasts OBSERVE_TRANSITION_MS during which the camera sits on
        // top of the destination star in the source's local frame;
        // with both camera and B at kpc-scale magnitudes,
        // matrixWorldInverse * B loses float32 precision and the
        // destination jitters as the quaternion rotates.
        // After this recentre the destination is at local (0,0,0) and
        // the camera lerps in from a small offset, so the projection
        // chain stays clean for the entire phase 3. uHideFocusIdx still
        // points at the source for the duration so the destination
        // remains visible during the parallax slerp; swapObserveAnchor
        // at finishWarp re-points it to the destination on landing.
        //
 // After this is just tryMidFlyRecentre invoked at a
        // different time — the navigate-mode mid-Fly path uses the
        // same dispatch. Skipped when the mid-Fly path already fired.
        if (state.returnToObserve && !state.recenteredToDest) {
          this.tryMidFlyRecentre(state);
          // _localPositions has been rewritten — re-bind B in the new
          // frame for the lerp below to land on (0,0,0).
          B = state.dest.localPositionInto(out) ? out : null;
        }
      }
      // Destination star stays visible across post-arrival so the user
      // sees it throughout the parallax slerp; swapObserveAnchor at
      // finishWarp hides it on landing. uHideFocusIdx still points at
      // the source for this whole window (set at warp start, by
      // setCameraMode('observe')'s entry-end hide or a prior
      // swapObserveAnchor) — source is far away by post-arrival so its
      // hidden state is invisible.
      const u = postElapsed / state.postArrivalMs;
      const f = u * u * (3 - 2 * u);
      this.q0.copy(state.flyEndQuaternion).slerp(state.startQuaternion, f);
      this.deps.camera.quaternion.copy(this.q0).normalize();
      if (state.returnToObserve && B) {
        this.deps.camera.position.lerpVectors(state.pEnd, B, f);
      }
      return;
    }

    this.finishWarp();
  }
}
