import * as THREE from 'three';

// Direct-manipulation look-around for OBSERVE mode. Premultiply
// camera.quaternion by the shortest rotation that takes the
// pointer-move ray direction → the pointer-down ray direction; the
// world point under the cursor stays glued there across the drag.
//
// Coexists with TrackballControls — caller must set
// TrackballControls.enabled = false while this is enabled.
// See docs/camera-observe.md.
export class ObserveControls {
  private static FOV_STEP_PER_WHEEL = 1.5; // degrees per typical wheel notch
  private static FOV_MIN = 10;
  private static FOV_MAX = 120;

  // Momentum / inertia after release. Time constant of the exponential
  // decay (e-fold time) — at 0.4 s the rotation falls to ~37% of its
  // release speed after ~half a second, ~14% after a second, and is
  // visually stopped (below MOMENTUM_MIN_SPEED for any normal release
  // velocity) by ~2 s. Looser than TrackballControls' navigate-mode
  // damping by design — the direct-manip drag has no "throw" of its
  // own, so a longer glide gives flicks somewhere to land.
  private static MOMENTUM_TAU_SEC = 0.4;
  // Stop momentum below this angular speed (rad/sec). 0.001 rad/sec ≈
  // 0.06°/sec — sub-pixel motion at any sane FOV/window combo.
  private static MOMENTUM_MIN_SPEED = 0.001;
  // Don't kick off momentum if the last move event is older than this
  // when the user releases — they paused before letting go and almost
  // certainly meant to stop.
  private static MOMENTUM_MAX_RELEASE_GAP_MS = 80;
  // Cap dt per momentum step so a stalled rAF (tab background, GC) on
  // resume doesn't apply one giant rotation.
  private static MOMENTUM_MAX_STEP_SEC = 0.1;

  private readonly canvas: HTMLCanvasElement;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly setFov: (fov: number) => void;
  private readonly getFov: () => number;

  private enabled = false;
  private dragging = false;
  private activePointerId: number | null = null;

  // World-space direction of the world point grabbed at pointer-down.
  // Reused throughout the drag so the same point follows the cursor.
  private dGrabbed = new THREE.Vector3();

  // Reusable scratch for the per-move unproject + rotation.
  private dCurrent = new THREE.Vector3();
  private rotQ = new THREE.Quaternion();

  // Last applied per-event rotation, kept as axis-angle so we can read
  // an instantaneous angular velocity off it at release. lastMoveTimeMs
  // is the timestamp of the move event that produced lastRotAxis /
  // lastRotAngle.
  private lastRotAxis = new THREE.Vector3();
  private lastRotAngle = 0;
  private lastMoveTimeMs = 0;

  // Live momentum state, advanced by update() each frame after release.
  // momentumSpeed = 0 means no momentum to apply.
  private momentumAxis = new THREE.Vector3();
  private momentumSpeed = 0; // rad / sec
  private momentumLastMs = 0;

  constructor(
    canvas: HTMLCanvasElement,
    camera: THREE.PerspectiveCamera,
    setFov: (fov: number) => void,
    getFov: () => number,
  ) {
    this.canvas = canvas;
    this.camera = camera;
    this.setFov = setFov;
    this.getFov = getFov;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    // pointerdown captures the pointer to the canvas via setPointerCapture
    // (in onPointerDown), so subsequent pointermove/up/cancel for that
    // pointer are routed to the canvas regardless of cursor position. No
    // need for window-level move listeners — the captured-pointer events
    // arrive even when the cursor leaves the canvas mid-drag.
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    // Cmd-Tab / app-switcher / tab-hide can preempt the drag without ever
    // delivering pointerup or pointercancel. On return, dragging would
    // resume from a stale dGrabbed and the next pointermove would whip
    // the camera. Treat blur and tab-hide as cancel events.
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.cancelDrag();
  }

  // Reset all live drag/momentum state. Used by disable(), onPointerCancel,
  // and the blur/visibilitychange handlers — all four are "the pointer is
  // no longer ours" events that must wipe the same fields in lockstep.
  // onPointerUp does not call this because release legitimately promotes
  // the last per-event rotation to a momentum velocity.
  private cancelDrag() {
    if (this.activePointerId !== null) this.releaseCapture(this.activePointerId);
    this.dragging = false;
    this.activePointerId = null;
    this.momentumSpeed = 0;
    this.lastRotAngle = 0;
  }

  // Best-effort pointer-capture release. Wrapped because hasPointerCapture
  // can be false (capture was already released by the browser, e.g. on
  // pointercancel) and releasePointerCapture throws if the pointer wasn't
  // captured by this element.
  private releaseCapture(pointerId: number) {
    try {
      if (this.canvas.hasPointerCapture(pointerId)) {
        this.canvas.releasePointerCapture(pointerId);
      }
    } catch {
      // ignore — capture state is best-effort cleanup
    }
  }

  /**
   * Advance any post-release momentum. Called from Stellata's animate
   * loop while in OBSERVE (and not in a transition / aim slerp). No-op
   * during an active drag — momentum only runs after the user has
   * released the pointer.
   */
  update() {
    if (!this.enabled) return;
    const now = performance.now();
    if (this.dragging || this.momentumSpeed === 0) {
      this.momentumLastMs = now;
      return;
    }
    const dt = Math.min(
      ObserveControls.MOMENTUM_MAX_STEP_SEC,
      (now - this.momentumLastMs) / 1000,
    );
    this.momentumLastMs = now;
    if (dt <= 0) return;

    const angle = this.momentumSpeed * dt;
    this.rotQ.setFromAxisAngle(this.momentumAxis, angle);
    this.camera.quaternion.premultiply(this.rotQ).normalize();

    this.momentumSpeed *= Math.exp(-dt / ObserveControls.MOMENTUM_TAU_SEC);
    if (this.momentumSpeed < ObserveControls.MOMENTUM_MIN_SPEED) {
      this.momentumSpeed = 0;
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.dragging = true;
    this.activePointerId = e.pointerId;
    // Capture the pointer to the canvas so subsequent move/up/cancel for
    // this pointer fire on the canvas even when the cursor leaves it.
    // Replaces the prior window-level listener routing.
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not all envs support it */ }
    this.pixelToWorldDir(e.clientX, e.clientY, this.dGrabbed);
    // New grab cancels any in-flight momentum and resets the per-event
    // rotation tracker so a subsequent quick release doesn't inherit a
    // stale axis from the previous drag.
    this.momentumSpeed = 0;
    this.lastRotAngle = 0;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.releaseCapture(e.pointerId);
    this.dragging = false;
    this.activePointerId = null;
    // Promote the last per-event rotation to an angular velocity if the
    // release was close enough in time to that move — otherwise the user
    // paused before letting go and we shouldn't fling.
    const gapMs = performance.now() - this.lastMoveTimeMs;
    if (
      this.lastRotAngle > 0 &&
      gapMs <= ObserveControls.MOMENTUM_MAX_RELEASE_GAP_MS &&
      gapMs > 0
    ) {
      this.momentumAxis.copy(this.lastRotAxis);
      this.momentumSpeed = this.lastRotAngle / (gapMs / 1000);
      this.momentumLastMs = performance.now();
    } else {
      this.momentumSpeed = 0;
    }
  };

  // Mirrors onPointerUp's drag teardown but never promotes momentum: a
  // cancelled drag (incoming call, system gesture stealing the pointer,
  // browser-side touch cancellation) is not a deliberate release, so it
  // shouldn't feel like a flick. Without this, the next pointermove would
  // continue the drag from a stale activePointerId / dragging=true.
  private onPointerCancel = (e: PointerEvent) => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.cancelDrag();
  };

  private onWindowBlur = () => {
    if (this.dragging) this.cancelDrag();
  };

  private onVisibilityChange = () => {
    if (document.hidden && this.dragging) this.cancelDrag();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.pixelToWorldDir(e.clientX, e.clientY, this.dCurrent);
    // Skip near-identity rotations so micro-jitter doesn't bleed into
    // camera.quaternion through repeated normalize() calls.
    if (this.dCurrent.dot(this.dGrabbed) > 0.9999999) return;
    this.rotQ.setFromUnitVectors(this.dCurrent, this.dGrabbed);
    this.camera.quaternion.premultiply(this.rotQ).normalize();

    // Pull axis-angle out of rotQ for momentum tracking. setFromUnitVectors
    // produces a unit quaternion, so |w| = cos(θ/2) and (x,y,z) =
    // sin(θ/2) · axis. The dot-product guard above keeps θ bounded above
    // ~1e-4 rad, so sin(θ/2) is well clear of zero.
    const w = Math.max(-1, Math.min(1, this.rotQ.w));
    const s = Math.sqrt(1 - w * w);
    if (s > 1e-5) {
      this.lastRotAxis.set(this.rotQ.x / s, this.rotQ.y / s, this.rotQ.z / s);
      this.lastRotAngle = 2 * Math.acos(w);
      this.lastMoveTimeMs = performance.now();
    }
  };

  // Convert a viewport pixel to a world-space unit ray direction from the
  // camera through that pixel. Builds the local-frame direction from
  // FOV/aspect and rotates it by camera.quaternion — avoids unproject()'s
  // dependency on matrixWorld being up-to-date, which matters because
  // multiple pointer-move events can fire between frames and we mutate
  // the quaternion on every one.
  private pixelToWorldDir(
    clientX: number,
    clientY: number,
    out: THREE.Vector3,
  ): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const xn = (clientX / w) * 2 - 1;
    const yn = -(clientY / h) * 2 + 1;
    const tanHalfFov = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect;
    out.set(xn * tanHalfFov * aspect, yn * tanHalfFov, -1);
    out.applyQuaternion(this.camera.quaternion).normalize();
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Normalise across deltaMode: pixel mode reports tens of px per notch,
    // line mode reports ~1 per notch. Treat any positive deltaY as "zoom out
    // (wider FOV)" and negative as "zoom in (narrower FOV)".
    const sign = Math.sign(e.deltaY);
    if (sign === 0) return;
    const next = clamp(
      this.getFov() + sign * ObserveControls.FOV_STEP_PER_WHEEL,
      ObserveControls.FOV_MIN,
      ObserveControls.FOV_MAX,
    );
    this.setFov(next);
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
