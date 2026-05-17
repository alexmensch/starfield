// FocusController — extracted from stellata.ts (stellata-9mm.194.8).
// Owns the focus FSM (focusedStar / focusedCloud / focusedPlanetSystem),
// the focus-park lerp slot, pin-engage geometry, and the per-kind
// FocusTarget factories. Absorbs the FocusOps shim WarpController has
// been carrying since 9mm.194.5; one import line update each on
// WarpController and ObserveTransition.
//
// Public entry points map 1:1 to the prior Stellata methods:
//
//   setFocus(idx)                  — star focus FSM (clears cloud first)
//   setFocusedCloud(idx)           — cloud "soft focus"
//   focusStar(idx, opts)           — click/select-driven focus + park lerp
//   flyToCloud(idx, opts)          — cloud-side analogue of focusStar
//   setOrbitTarget(idx)            — orbit pivot + focus, camera stays put
//   setOrbitTargetCloud(idx)       — cloud-side analogue
//   unfocus(opts)                  — animated zoom-out + clear focus
//   recenterFocusToStar(idx)       — floating-origin pivot to a star
//   tick(nowMs)                    — drives the focus-park lerp
//
// Cross-controller coupling lives behind the `FocusOps` interface — the
// canonical home is now this module; warp-controller.ts and
// observe-transition.ts import it from here. The frame-anchor primitive
// (`recenterOrigin`, `worldOffset`, `starLocalPosition`) stays on
// Stellata, threaded in through the `FrameAnchor` dep — cleaner
// extraction is coupled to the StarPipeline extract (9mm.43) and
// deferred until then.
//
// Bus events emitted from here:
//   'focus' (number | null), 'cloudFocus' (number | null),
//   'planetSystem' (PlanetSystem | null), 'focusLerp' (boolean),
//   'cameraMode' (CameraMode — from setFocus's observe-cleanup branch),
//   'state' (at every focus mutation + the focus-lerp edges).
//
// Docs: docs/architecture.md (FocusTarget contract, pin-to-center,
// floating origin), docs/camera-warp.md (warp callers), docs/camera-
// observe.md (observe callers).

import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { Catalog } from '../loaders/catalog-loader';
import type { CameraMode, StellataEventMap } from '../stellata';
import type { EventBus } from '../util/event-bus';
import type { AimController } from './aim-controller';
import type { ObserveControls } from './observe-controls';
import type { ObserveTransition } from './observe-transition';
import type { WarpController } from './warp-controller';
import type { FocusTarget } from './focus-target';
import type { MolecularClouds } from '../molecular-clouds/molecular-clouds';
import { cloudViewingDistancePc } from '../molecular-clouds/molecular-clouds';
import {
  type PlanetSystem,
  getPlanetSystem,
  hasPlanets,
} from '../solar-system/planet-system';
import { R_SUN_PC } from '../solar-system/astronomy-constants';
import { chartPlateauDistancePc } from '../chart-mode/chart-disc-pure';
import * as starPhysics from './star-physics';
import {
  type FocusLerpState,
  newFocusLerpFrom,
  parkDistance,
  tickFocusLerp,
} from './focus-transition';
import { warpArrivalEaseFn } from './warp-tuning';
import { FOCUS_LERP_MS } from './timing';
import { alignCameraUpToQuaternion } from './up-align-pure';

/** Fallback orbit-controls floor when no star is focused. Sized to keep
 *  the camera comfortably outside any single star's physical envelope
 *  (Sol's photosphere at 2.25×10⁻⁸ pc, Earth's orbit at 4.85×10⁻⁶ pc) so
 *  approaching origin without an explicit focus anchor doesn't enter the
 *  extreme-close-range regime where float32 matrix cancellation drifts
 *  the projected center off-screen. To get closer than this, focus a
 *  star — `minOrbitDistForStar` then returns the per-star physical floor. */
export const GLOBAL_MIN_DIST_PC = 5e-3;

/** Squared-length threshold below which `controls.target` is treated as
 *  coincident with the local origin (= focal-star position). Engages the
 *  uPinFocusToCenter shader pin so the focused star renders at NDC (0,0)
 *  regardless of float32 cancellation. 1e-12 pc² ≈ (1e-6 pc)² ≈ 0.2 AU
 *  — under this, the geometric pin is the right answer. */
export const PIN_ENGAGE_THRESHOLD_SQ_PC = 1e-12;

/** Floor on a catalog `physicalRadius[idx]` (in solar radii) before
 *  converting to parsecs (`* R_SUN_PC`). Keeps R > 0 in geometric
 *  formulas. Six pre-existing sites floor the same quantity at 1e-9 or
 *  1e-6 inconsistently (stellata-9mm.195); migrate them off the literals
 *  as part of that bead, not here. */
const MIN_PHYSICAL_RADIUS_R_SUN = 1e-9;

/** Floating-origin primitive — stays on the integration shell so the
 *  star-pipeline buffer rewrite + `iPositionAttr.needsUpdate` happen
 *  next to the resources they touch. Cleaner extraction is coupled to
 *  the StarPipeline extract (9mm.43). */
export interface FrameAnchor {
  recenterOrigin(newOrigin: THREE.Vector3): THREE.Vector3 | null;
  getWorldOffset(): Readonly<THREE.Vector3>;
  starLocalPosition(idx: number): THREE.Vector3;
  starLocalPositionInto(idx: number, out: THREE.Vector3): THREE.Vector3;
}

/** Cross-controller seam consumed by WarpController. FocusController
 *  implements it; the runtime swap in Stellata is `focus: this` →
 *  `focus: this.focus` in one line. Frame-anchor and vector-slot
 *  methods are delegated to the integration shell via deps. */
export interface FocusOps {
  /** FocusTarget describing whichever object is currently focused
   *  (star or cloud), or null if nothing is focused. Source side of
   *  a warp. */
  currentFocusTarget(): FocusTarget | null;
  /** Build a FocusTarget for a star at catalog index `idx`. */
  makeStarFocusTarget(idx: number): FocusTarget;
  /** Build a FocusTarget for the cloud at index `idx`, or null when
   *  the cloud layer hasn't loaded or the index is out of range. */
  makeCloudFocusTarget(idx: number): FocusTarget | null;
  /** Star position in the renderer's local frame. */
  starLocalPosition(idx: number): THREE.Vector3;
  /** Shift the floating origin to `newOrigin`, returning the applied
   *  delta. The returned Vector3 is shared scratch — copy if needed
   *  beyond the synchronous call. Returns null on no-op. */
  recenterOrigin(newOrigin: THREE.Vector3): THREE.Vector3 | null;
  /** Star-specific shorthand: recenterOrigin onto catalog[idx] PLUS
   *  the focus-state book-keeping. No event emit; caller decides when
   *  to fan out 'focus' / 'state'. */
  recenterFocusToStar(idx: number): THREE.Vector3 | null;
  setFocus(idx: number | null): void;
  setFocusedCloud(idx: number | null): void;
  /** Distance-vector slots — cleared on warp arrival regardless of
   *  which kind the warp targeted. */
  setVectorTo(idx: number | null): void;
  setVectorToCloud(idx: number | null): void;
  getFocusedStar(): number | null;
  getFocusedCloud(): number | null;
  /** True when an observe enter / exit transition is in flight ('unfocus'
   *  excluded). startWarp bails so warp doesn't collide. */
  isObserveTransitionActive(): boolean;
  cancelFocusLerp(): void;
  cancelUnfocusLerp(): void;
}

export interface FocusControllerDeps {
  camera: THREE.PerspectiveCamera;
  controls: TrackballControls;
  observeControls: ObserveControls;
  catalog: Catalog;
  bus: EventBus<StellataEventMap>;
  frameAnchor: FrameAnchor;
  aim: AimController;
  uHideFocusIdxRef: { value: number };
  getCameraMode: () => CameraMode;
  setCameraModeValue: (m: CameraMode) => void;
  getClouds: () => MolecularClouds | null;
  /** Vector slots stay on the integration shell — FocusController calls
   *  these from `focusStar` / `flyToCloud` / `unfocus` to clear the
   *  vector when focus changes. */
  setVectorTo: (idx: number | null) => void;
  setVectorToCloud: (idx: number | null) => void;
  /** Lazy refs due to circular construction: warp + observe consume
   *  FocusOps from this controller, so they're built after. Resolved
   *  at request time. */
  getWarp: () => WarpController;
  getObserve: () => ObserveTransition;
}

export class FocusController implements FocusOps {
  private readonly deps: FocusControllerDeps;
  private focusedStar: number | null = null;
  private focusedCloud: number | null = null;
  private focusedPlanetSystem: PlanetSystem | null = null;
  private planetSystemToken = 0;
  private focusLerpState: FocusLerpState | null = null;

  // Scratch — only safe inside its single synchronous call site.
  private readonly tmpRecenter = new THREE.Vector3();

  constructor(deps: FocusControllerDeps) {
    this.deps = deps;
  }

  // ─── queries ───────────────────────────────────────────────────────

  getFocusedStar(): number | null { return this.focusedStar; }
  getFocusedCloud(): number | null { return this.focusedCloud; }
  getFocusedPlanetSystem(): PlanetSystem | null { return this.focusedPlanetSystem; }
  isFocusLerpActive(): boolean { return this.focusLerpState !== null; }

  /** True while *any* camera-driving animation is in flight: warp,
   *  aim-slerp, focus-park lerp, OR an observe transition (enter / exit /
   *  navigate-close-zoom unfocus). ObserveTransition reads this through
   *  the ObserveFocusOps seam. */
  isCameraBusy(): boolean {
    return this.deps.getWarp().isActive()
      || this.deps.aim.isActive()
      || this.focusLerpState !== null
      || this.deps.getObserve().isAnyActive();
  }

  /** True when an observe-mode transition (enter or exit) is in flight.
   *  The 'unfocus' kind is excluded — it reuses the controller's state
   *  slot for a navigate-mode lerp and shouldn't surface to UI/overlay
   *  code gating on observe-mode visibility. */
  isObserveTransitionActive(): boolean {
    return this.deps.getObserve().isActive();
  }

  /** Threshold squared-length below which `controls.target` engages the
   *  focused-star pin. Surfaced for the pin debug HUD so the displayed
   *  rule matches the runtime constant exactly. */
  getPinEngageThresholdSq(): number { return PIN_ENGAGE_THRESHOLD_SQ_PC; }

  /** Whether the focused-star pin (uPinFocusToCenter) would engage right
   *  now, mirroring the per-frame guard in animate(). Read by the pin
   *  section of the unified debug panel (`debug.panel()`) to display
   *  live state.
   *
   *  The warp guard releases when `warp.isRecenteredToDest()` is true:
   *  after the mid-Fly recentre (stellata-2br.5) the destination is at
   *  local (0,0,0) and the camera is doing `lookAt(local origin)` per
   *  frame. focus-park lerp stays guarded — that path slerps through a
   *  non-lookAt arc where pin-to-centre would snap the focal star to
   *  NDC origin before the slerp finishes turning into it. */
  isPinEngaged(): boolean {
    const warp = this.deps.getWarp();
    return (
      this.focusedStar !== null
      && this.deps.getCameraMode() === 'navigate'
      && (!warp.isActive() || warp.isRecenteredToDest())
      && !this.deps.aim.isActive()
      && !this.focusLerpState
      && this.deps.controls.target.lengthSq() < PIN_ENGAGE_THRESHOLD_SQ_PC
    );
  }

  /** Auto-park target — pure star-physics helper applied with the
   *  current camera. Exposed for the ObserveFocusOps seam. */
  parkDistForStar(idx: number): number {
    return starPhysics.parkDistForStar({
      catalog: this.deps.catalog,
      idx,
      fovMinorRad: starPhysics.fovMinorRad(this.deps.camera),
    });
  }

  // ─── frame anchor + vector slot delegation ─────────────────────────

  starLocalPosition(idx: number): THREE.Vector3 {
    return this.deps.frameAnchor.starLocalPosition(idx);
  }
  recenterOrigin(newOrigin: THREE.Vector3): THREE.Vector3 | null {
    return this.deps.frameAnchor.recenterOrigin(newOrigin);
  }
  setVectorTo(idx: number | null): void { this.deps.setVectorTo(idx); }
  setVectorToCloud(idx: number | null): void { this.deps.setVectorToCloud(idx); }

  // ─── star/cloud focus FSM ──────────────────────────────────────────

  setFocus(idx: number | null): void {
    // Star and cloud focus are mutually exclusive — selecting either one
    // clears the other. Both setters end up here for the cloud-clear leg
    // so the cloud-focus event always fires before the star-focus event,
    // letting UI listeners settle in the right order.
    const cloudCleared = this.focusedCloud !== null;
    if (cloudCleared) {
      this.focusedCloud = null;
      this.deps.bus.emit('cloudFocus', null);
    }
    if (this.focusedStar === idx) {
      if (cloudCleared) this.deps.bus.emit('state');
      return;
    }
    // OBSERVE depends on a focused star anchor. Any change to the anchor
    // (unfocus or switch to another star) bails out of observe immediately.
    // Snap rather than animate because a transition needs the original
    // anchor to mean anything.
    if (this.deps.getCameraMode() === 'observe') {
      // Snap-exit observe BEFORE the focus mutation runs: an in-flight
      // 'enter' / 'exit' transition references the OLD focal star via
      // fromPos/toPos and must be dropped before the floating-origin
      // recentre downstream. This path deliberately does NOT touch
      // controls.target or call controls.update() — the camera is at
      // local (0,0,0) right now and target is set by the
      // recenterFocusToStar block below.
      this.deps.getObserve().cancelTransition();
      this.deps.aim.cancel();
      this.deps.setCameraModeValue('navigate');
      this.deps.uHideFocusIdxRef.value = -1;
      this.deps.observeControls.disable();
      alignCameraUpToQuaternion(this.deps.camera);
      this.deps.controls.enabled = true;
      this.deps.bus.emit('cameraMode', 'navigate');
    }
    // Recenter the floating origin only when *focusing* a star. The new
    // origin snaps to the focal star's absolute position, so close-range
    // rendering happens with tiny coordinate values and the projection
    // chain stays float32-clean. On *unfocus* (idx === null) we leave
    // worldOffset alone — the camera is wherever it was, and continuing
    // to render in the (former focal star's) local frame keeps every
    // close-orbit precision invariant intact across the focus → unfocus
    // transition (stellata-a7d.2.11).
    if (idx !== null) {
      this.recenterFocusToStar(idx);
      // After recenterOrigin, the focused star is at local (0,0,0). Snap
      // controls.target to (0,0,0) and shift camera by the same delta so
      // the camera-to-target relationship is preserved — the user-visible
      // pose doesn't change. Without this, target lands at -dx (where dx
      // is whatever recenterOrigin shifted by) and the per-frame pin guard
      // (target.lengthSq < 1e-12) silently disengages whenever Sol's
      // catalog offset (5e-6 pc) or a long warp's |AB|·1e-7 Float32
      // residual leaks through.
      const t = this.deps.controls.target;
      this.deps.camera.position.x -= t.x;
      this.deps.camera.position.y -= t.y;
      this.deps.camera.position.z -= t.z;
      t.set(0, 0, 0);
    } else {
      this.focusedStar = null;
      // Unfocus: clamp the new minDistance to ≤ current eye distance so
      // TrackballControls doesn't push the camera outward when the user was
      // sitting closer than GLOBAL_MIN_DIST_PC to the (former) focal star.
      // Once minDistance is below current eye, future zoom-out is free; the
      // 5e-3 pc unfocused floor latches once the user has zoomed out past it.
      const eye = this.deps.camera.position.distanceTo(this.deps.controls.target);
      this.deps.controls.minDistance = Math.min(GLOBAL_MIN_DIST_PC, eye);
      this.refreshPlanetSystem(null);
    }
    this.deps.bus.emit('focus', idx);
    this.deps.bus.emit('state');
  }

  setFocusedCloud(idx: number | null): void {
    if (idx !== null && this.focusedStar !== null) {
      // Clear the star focus first; setFocus(null) doesn't touch
      // focusedCloud unless it was already set, so no event noise.
      this.setFocus(null);
    }
    if (this.focusedCloud === idx) return;
    this.focusedCloud = idx;
    this.deps.bus.emit('cloudFocus', idx);
    this.deps.bus.emit('state');
  }

  /** Star-focused recentre: pivot the floating origin onto catalog[idx]
   *  AND update the focus-state book-keeping (focusedStar, per-star
   *  minDistance, planet-system reload). No 'focus' / 'state' event
   *  emit — caller fires those when the camera has landed (setFocus,
   *  WarpController.swapObserveAnchor, WarpController.tryMidFlyRecentre
   *  via dest.emitFocusEvents at finishWarp). */
  recenterFocusToStar(newIdx: number): THREE.Vector3 | null {
    const p = this.deps.catalog.positions;
    const delta = this.deps.frameAnchor.recenterOrigin(this.tmpRecenter.set(
      p[newIdx * 3], p[newIdx * 3 + 1], p[newIdx * 3 + 2],
    ));
    this.focusedStar = newIdx;
    this.deps.controls.minDistance = starPhysics.minOrbitDistForStar({
      catalog: this.deps.catalog,
      idx: newIdx,
      fovMinorRad: starPhysics.fovMinorRad(this.deps.camera),
    });
    this.refreshPlanetSystem(newIdx);
    return delta;
  }

  // Reload the focused star's planet system. Called from every code path
  // that mutates focusedStar (setFocus + makeStarFocusTarget.applyFocus).
  // The token guard drops a previous in-flight load if the focus changes
  // again before the Promise resolves — relevant once stellata-bk5
  // introduces truly async fetches; for Sol the resolve happens on the
  // next microtask, ahead of the next animation frame.
  private refreshPlanetSystem(idx: number | null): void {
    const token = ++this.planetSystemToken;
    if (idx === null || !hasPlanets(this.deps.catalog, idx)) {
      if (this.focusedPlanetSystem !== null) {
        this.focusedPlanetSystem = null;
        this.deps.bus.emit('planetSystem', null);
      }
      return;
    }
    void getPlanetSystem(this.deps.catalog, idx).then((ps) => {
      if (token !== this.planetSystemToken) return;
      if (this.focusedPlanetSystem === ps) return;
      this.focusedPlanetSystem = ps;
      this.deps.bus.emit('planetSystem', ps);
    });
  }

  // ─── focus-park lerp (private state, public cancel) ────────────────

  /** Public for WarpController's FocusOps seam: cancel at startWarp
   *  time so the in-flight lerp doesn't fight the warp claim. */
  cancelFocusLerp(): void {
    this.endFocusLerp();
  }

  /** Public for WarpController's FocusOps seam. */
  cancelUnfocusLerp(): void {
    this.deps.getObserve().cancelUnfocusLerp();
  }

  /** Per-frame tick. Stellata's animate() dispatches here when
   *  `isFocusLerpActive()` is true. controls.enabled is left true
   *  throughout; the dispatcher routes here instead of controls.update(),
   *  so user drag accumulates in TC without visible effect until the
   *  lerp lands. On landing we re-issue controls.update() so TC re-syncs
   *  against the final camera pose. */
  tick(nowMs: number): void {
    const state = this.focusLerpState;
    if (!state) return;
    const stillActive = tickFocusLerp(state, nowMs, this.deps.camera);
    if (!stillActive) {
      this.endFocusLerp();
      this.deps.controls.update();
    }
  }

  // Set/clear the focus-lerp slot through these helpers so overlays
  // subscribed to the 'focusLerp' event see exactly one true → false edge
  // per lerp. Calling startFocusLerp twice in a row emits a single 'true'
  // (state changed shape but stays active); endFocusLerp() is a no-op
  // when no lerp is running.
  private startFocusLerp(state: FocusLerpState): void {
    const wasInactive = this.focusLerpState === null;
    this.focusLerpState = state;
    if (wasInactive) {
      this.deps.bus.emit('focusLerp', true);
    }
  }
  private endFocusLerp(): void {
    if (this.focusLerpState !== null) {
      this.focusLerpState = null;
      this.deps.bus.emit('focusLerp', false);
    }
  }

  // ─── click/select-driven focus paths ───────────────────────────────

  /**
   * Focus a star. With `animate: true` (default), the camera glides to
   * `parkDistForStar(idx)` over `FOCUS_LERP_MS` when the camera is
   * currently outside that park distance; otherwise the camera stays put
   * and only the focus state / orbit floor are updated. With
   * `animate: false`, the camera snaps to the park pose directly
   * (URL-restore path).
   *
   * Flow: `setFocus` translates the camera into the new floating-origin
   * frame (new star at local (0,0,0)). We capture starting orientation
   * BEFORE `setFocus`, then build the lerp AFTER — the lerp's
   * fromPos/toPos must live in the post-recentre frame, otherwise the
   * camera teleports backward and lands at `|targetOld|` past the star.
   */
  focusStar(starIndex: number, opts: { animate?: boolean } = {}): void {
    if (this.deps.getWarp().isActive()) return;
    this.cancelUnfocusLerp();
    this.cancelFocusLerp();
    const animate = opts.animate ?? true;

    // Orientation is frame-shift-invariant; capture once. After setFocus
    // we still want `fromQuat` to be the user's pre-click camera view.
    const startQuat = this.deps.camera.quaternion.clone();
    const startUp = this.deps.camera.up.clone();

    const fovMinor = starPhysics.fovMinorRad(this.deps.camera);
    const parkDist = starPhysics.parkDistForStar({
      catalog: this.deps.catalog, idx: starIndex, fovMinorRad: fovMinor,
    });
    const minOrbit = starPhysics.minOrbitDistForStar({
      catalog: this.deps.catalog, idx: starIndex, fovMinorRad: fovMinor,
    });

    // setFocus's contract: caller seeds controls.target with the new
    // star's local position in the CURRENT (pre-recentre) frame; setFocus
    // then recentres worldOffset to the new star and translates camera +
    // target by -target so both land in the new frame with target at
    // (0,0,0). Match that contract.
    this.deps.controls.target.copy(this.deps.frameAnchor.starLocalPosition(starIndex));
    this.deps.controls.minDistance = minOrbit;
    this.deps.setVectorTo(null);
    this.setFocus(starIndex);
    // From here on: the new star sits at local (0,0,0); camera.position
    // is already translated into the new frame.

    const target = this.deps.controls.target; // (0,0,0) post-recentre
    const eyeDist = this.deps.camera.position.length();

    if (animate && eyeDist > parkDist) {
      this.startFocusLerp(newFocusLerpFrom(
        this.deps.camera.position,
        startQuat,
        startUp,
        target,
        parkDist,
        FOCUS_LERP_MS,
        performance.now(),
        warpArrivalEaseFn({
          d0: eyeDist,
          dEnd: parkDist,
          targetRadius:
            Math.max(this.deps.catalog.physicalRadius[starIndex], MIN_PHYSICAL_RADIUS_R_SUN) * R_SUN_PC,
        }),
      ));
      // Deliberately do NOT toggle controls.enabled. The animate-loop
      // dispatcher routes through tick() before controls.update(), so
      // user input accumulates inside TrackballControls but doesn't
      // apply visually. Disabling here would race the click-to-focus
      // event chain — Stellata's pointerup runs before TC's dynamically-
      // added pointerup, and TC's _state would stay stuck at ROTATE
      // until the next click clears it (cursor appears captured).
    } else if (eyeDist > parkDist) {
      // animate: false snap path — outside park: place at park along
      // current eye direction with an explicit lookAt so orientation
      // matches what TC would resolve.
      const dir = this.deps.camera.position.clone().normalize();
      if (dir.lengthSq() === 0) dir.set(0, 0, 1);
      this.deps.camera.position.copy(target).addScaledVector(dir, parkDist);
      this.deps.camera.lookAt(target);
      this.deps.controls.update();
    } else {
      // Inside park: stay-put. Nothing to move.
      this.deps.controls.update();
    }
  }

  setOrbitTarget(starIndex: number): void {
    this.deps.controls.target.copy(this.deps.frameAnchor.starLocalPosition(starIndex));
    this.deps.controls.update();
    this.setFocus(starIndex);
  }

  /** Cloud-side analogue of focusStar — used by search-select and
   *  click-vector-tip. Routes through the same focus-park primitives
   *  (r9q.3) so the lerp-or-noop UX matches stars. `animate: false`
   *  (URL restore) snaps without a transition. setFocus(null) below
   *  leaves worldOffset alone (a7d.2.11), so no frame-shift handling
   *  is needed here — target is `cloud.centerAbs - worldOffset` in the
   *  current local frame both before and after the focus clear. */
  flyToCloud(idx: number, opts: { animate?: boolean } = {}): void {
    const clouds = this.deps.getClouds();
    if (!clouds) return;
    const cloud = clouds.clouds[idx];
    if (!cloud) return;
    if (this.deps.getWarp().isActive()) return;
    this.cancelUnfocusLerp();
    this.cancelFocusLerp();

    if (this.focusedStar !== null) this.setFocus(null);
    this.deps.setVectorTo(null);
    this.deps.setVectorToCloud(null);

    const animate = opts.animate ?? true;
    const startQuat = this.deps.camera.quaternion.clone();
    const startUp = this.deps.camera.up.clone();

    const target = new THREE.Vector3().copy(cloud.centerAbs).sub(this.deps.frameAnchor.getWorldOffset());
    this.deps.controls.target.copy(target);
    const parkDist = parkDistance({
      R_pc: Math.max(cloud.axes[0], cloud.axes[1], cloud.axes[2]),
      dMinFloor: cloudViewingDistancePc(cloud),
    });
    const eyeDist = this.deps.camera.position.distanceTo(target);

    if (animate && eyeDist > parkDist) {
      // Cloud destination — `targetRadius: null` triggers the hybrid
      // curve's fallback to cubic-Hermite. Clouds have no single
      // geometric R (ellipsoid axes), so angular-size driving doesn't
      // apply.
      this.startFocusLerp(newFocusLerpFrom(
        this.deps.camera.position,
        startQuat,
        startUp,
        target,
        parkDist,
        FOCUS_LERP_MS,
        performance.now(),
        warpArrivalEaseFn({
          d0: eyeDist,
          dEnd: parkDist,
          targetRadius: null,
        }),
      ));
      // controls.enabled stays true — see focusStar's comment.
    } else if (eyeDist > parkDist) {
      const dir = new THREE.Vector3()
        .subVectors(this.deps.camera.position, target)
        .normalize();
      if (dir.lengthSq() === 0) dir.set(0, 0, 1);
      this.deps.camera.position.copy(target).addScaledVector(dir, parkDist);
      this.deps.camera.lookAt(target);
      this.deps.controls.update();
    } else {
      this.deps.controls.update();
    }
    this.setFocusedCloud(idx);
  }

  /** Cloud-side analogue of setOrbitTarget — orbit pivot moves to the
   *  cloud centroid and the cloud becomes the soft focus, but the camera
   *  stays where it is (no teleport). User then orbits/zooms to view it.
   *  Mirrors the click-on-star UX without teleporting. */
  setOrbitTargetCloud(cloudIdx: number): void {
    const clouds = this.deps.getClouds();
    if (!clouds) return;
    const cloud = clouds.clouds[cloudIdx];
    if (!cloud) return;
    // setFocusedCloud clears any star focus first. Since a7d.2.11,
    // that doesn't recentre worldOffset back to Sol — the floating
    // origin stays at the former focal star — so subtract worldOffset
    // to translate the cloud's absolute centroid into the current
    // local frame before assigning it as controls.target.
    this.setFocusedCloud(cloudIdx);
    this.deps.controls.target.copy(cloud.centerAbs).sub(this.deps.frameAnchor.getWorldOffset());
    this.deps.controls.update();
  }

  /** Clear focus + (optionally) animate the camera back to the focal
   *  star's parking distance. Honours the warp-active guard. Branches
   *  on cameraMode: observe → animated zoom-out via ObserveTransition
   *  startExit, navigate close-zoom → ObserveTransition startUnfocusLerp;
   *  otherwise hard-clears. */
  unfocus(opts: { animate?: boolean } = {}): void {
    if (this.deps.getWarp().isActive()) return;
    if (
      this.focusedStar === null && this.focusedCloud === null
      // Vector slots live on the integration shell — Stellata.unfocus()
      // checks them BEFORE calling this method (it's the entry point
      // for the UI). FocusController only sees the focus-state path.
    ) return;
    // A focus-park lerp inbound to the same star we're now unfocusing
    // away from would otherwise race the unfocus zoom-out below.
    this.cancelFocusLerp();
    const animate = opts.animate ?? true;
    this.deps.setVectorTo(null);
    this.deps.setVectorToCloud(null);
    // X-out from OBSERVE: drive the same animated zoom-out the
    // navigate-mode toggle uses, then clear focus. startExit captures
    // forward + camera.position before setFocus(null) runs, sets
    // cameraMode='navigate' (so setFocus's observe-cleanup branch
    // skips), and builds the 'exit' transition; setFocus(null)
    // afterwards clamps controls.minDistance and emits 'focus' so the
    // search box / overlays settle within the same frame. Since
    // a7d.2.11 setFocus(null) doesn't recentre, so the animation runs
    // in the (former focal star's) local frame.
    if (animate && this.deps.getCameraMode() === 'observe' && this.focusedStar !== null) {
      this.deps.getObserve().startExit({ animate: true, clearFocusOnExit: false });
      this.setFocus(null);
      return;
    }
    // Navigate-mode close-zoom unfocus: animate the camera back to the
    // former focal star's parking distance instead of teleporting
    // (a7d.2.6). Skip when the camera is already further out than
    // parkDistForStar (the acceptance "no-op when at or beyond the
    // floor" criterion), or when there's no focused star to anchor on.
    if (
      animate
      && this.deps.getCameraMode() === 'navigate'
      && this.focusedStar !== null
      && !this.deps.getObserve().isAnyActive()
    ) {
      const focalIdx = this.focusedStar;
      const minDist = this.parkDistForStar(focalIdx);
      const fromPos = this.deps.camera.position.clone();
      const eye = fromPos.distanceTo(this.deps.controls.target);
      if (eye < minDist) {
        const dir = fromPos.clone().sub(this.deps.controls.target).normalize();
        const toPos = this.deps.controls.target.clone().addScaledVector(dir, minDist);
        // Clear focus before the lerp starts so UI listeners (search box,
        // overlays, focus-ring) update immediately. setFocus(null) clamps
        // controls.minDistance to ≤ current eye, so the camera doesn't
        // fight the lerp's outward motion. After the lerp lands, the
        // controller's finish branch tightens minDistance to minDist.
        this.setFocus(null);
        this.setFocusedCloud(null);
        // Don't toggle controls.enabled during the lerp. The animate()
        // dispatcher routes to observe.tick(), which lerps
        // camera.position directly and skips controls.update().
        // Disabling explicitly would race the click-to-unfocus event
        // chain (see ObserveTransition.startUnfocusLerp docblock).
        this.deps.getObserve().startUnfocusLerp(fromPos, toPos, minDist);
        return;
      }
    }
    this.setFocus(null);
    this.setFocusedCloud(null);
  }

  // ─── FocusTarget factories ─────────────────────────────────────────

  // Per-kind FocusTarget factories. The warp / camera-transition code
  // consumes these objects rather than switching on a `destKind`
  // literal; adding a new focusable kind = adding a factory + plumbing
  // pick / click handling to it, then everything below
  // (warp animation, mid-Fly recentre, pin guard, finishWarp event
  // family) just works without touching the warp internals. See
  // `docs/architecture.md` § FocusTarget contract.

  /** Build a FocusTarget for the star at catalog index `idx`. */
  makeStarFocusTarget(idx: number): FocusTarget {
    // Captures whether a sibling-kind focus existed at the moment of
    // applyFocus, so emitFocusEvents knows whether to emit a clearing
    // 'cloudFocus' event for the displaced cloud focus. Snapshotted at
    // applyFocus time because the focus fields may be mutated by other
    // code between applyFocus and emitFocusEvents.
    let cloudWasCleared = false;
    return {
      kind: 'star',
      idx,
      anchorInto: (out) => {
        const p = this.deps.catalog.positions;
        out.set(p[idx * 3], p[idx * 3 + 1], p[idx * 3 + 2]);
        return true;
      },
      localPositionInto: (out) => {
        this.deps.frameAnchor.starLocalPositionInto(idx, out);
        return true;
      },
      parkRadius: () => this.parkDistForStar(idx),
      applyFocus: () => {
        cloudWasCleared = this.focusedCloud !== null;
        if (cloudWasCleared) this.focusedCloud = null;
        this.focusedStar = idx;
        this.deps.controls.minDistance = starPhysics.minOrbitDistForStar({
          catalog: this.deps.catalog,
          idx,
          fovMinorRad: starPhysics.fovMinorRad(this.deps.camera),
        });
        this.refreshPlanetSystem(idx);
      },
      emitFocusEvents: () => {
        if (cloudWasCleared) this.deps.bus.emit('cloudFocus', null);
        this.deps.bus.emit('focus', idx);
        this.deps.bus.emit('state');
      },
      physicalRadius: () =>
        Math.max(this.deps.catalog.physicalRadius[idx], MIN_PHYSICAL_RADIUS_R_SUN) * R_SUN_PC,
      chartPlateauDistance: (magBright) =>
        chartPlateauDistancePc(this.deps.catalog.absmag[idx], magBright),
    };
  }

  /** Build a FocusTarget for the cloud at index `idx`. Returns null
   *  when the cloud layer hasn't loaded or the index is out of range. */
  makeCloudFocusTarget(idx: number): FocusTarget | null {
    const clouds = this.deps.getClouds();
    if (!clouds) return null;
    const cloud = clouds.clouds[idx];
    if (!cloud) return null;
    let starWasCleared = false;
    return {
      kind: 'cloud',
      idx,
      anchorInto: (out) => {
        out.copy(cloud.centerAbs);
        return true;
      },
      localPositionInto: (out) => {
        const wo = this.deps.frameAnchor.getWorldOffset();
        out.copy(cloud.centerAbs).sub(wo);
        return true;
      },
      parkRadius: () => cloudViewingDistancePc(cloud),
      applyFocus: () => {
        starWasCleared = this.focusedStar !== null;
        if (starWasCleared) {
          this.focusedStar = null;
          this.refreshPlanetSystem(null);
          // Per-cloud minDistance floor isn't tracked today; mirror
          // setFocus(null)'s clamp so the controls don't trap the
          // camera further out than the cloud's parked pose.
          const eye = this.deps.camera.position.distanceTo(this.deps.controls.target);
          this.deps.controls.minDistance = Math.min(GLOBAL_MIN_DIST_PC, eye);
        }
        this.focusedCloud = idx;
      },
      emitFocusEvents: () => {
        if (starWasCleared) this.deps.bus.emit('focus', null);
        this.deps.bus.emit('cloudFocus', idx);
        this.deps.bus.emit('state');
      },
      physicalRadius: () => null,
      chartPlateauDistance: () => null,
    };
  }

  /** Build a FocusTarget describing whichever object is currently
   *  focused (star or cloud), or null if nothing is focused. Used as
   *  the `source` side of a warp; the dispatch table sits in exactly
   *  one place. */
  currentFocusTarget(): FocusTarget | null {
    if (this.focusedStar !== null) return this.makeStarFocusTarget(this.focusedStar);
    if (this.focusedCloud !== null) return this.makeCloudFocusTarget(this.focusedCloud);
    return null;
  }

  dispose(): void {
    this.focusLerpState = null;
    this.focusedStar = null;
    this.focusedCloud = null;
    this.focusedPlanetSystem = null;
  }
}
