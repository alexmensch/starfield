import * as THREE from 'three';

// Custom look-around controller for OBSERVE mode. Drag rotates the camera in
// place (yaw around the camera's current up, pitch around the camera's right
// axis). Wheel adjusts the camera FOV. Two-finger roll on Safari continues
// to mutate camera.up directly via Starfield's existing handlers — yaw uses
// camera.up, so a tilted head still produces a sensible horizontal sweep.
//
// Coexists with TrackballControls: when this controller is enabled, the
// caller should set TrackballControls.enabled = false. We attach our own
// pointer/wheel listeners on enable() and detach them on disable() so the
// two control schemes never see the same gesture.
export class ObserveControls {
  private static ROTATE_SPEED = 0.005;     // radians per CSS pixel
  private static FOV_STEP_PER_WHEEL = 1.5; // degrees per typical wheel notch
  private static FOV_MIN = 10;
  private static FOV_MAX = 120;
  // Hard pitch limit. Yaw is around camera.up (world-vertical), pitch is
  // around the screen-right axis derived from the camera quaternion. As the
  // forward vector approaches camera.up the screen-right axis flips its
  // world orientation, which makes left/right swap on the next yaw input —
  // the classic FPS pole singularity. Clamping pitch a hair shy of ±90°
  // keeps yaw on the same side of the pole and avoids the swap, matching
  // every first-person game that uses a fixed world-up convention.
  private static PITCH_LIMIT = Math.PI / 2 - 0.01;

  private canvas: HTMLCanvasElement;
  private camera: THREE.PerspectiveCamera;
  private setFov: (fov: number) => void;
  private getFov: () => number;

  private enabled = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private activePointerId: number | null = null;

  // Reusable scratch so per-frame motion allocates nothing.
  private tmpQ = new THREE.Quaternion();
  private tmpRight = new THREE.Vector3();
  private tmpFwd = new THREE.Vector3();

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
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.dragging = false;
    this.activePointerId = null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.dragging = true;
    this.activePointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    this.dragging = false;
    this.activePointerId = null;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (dx === 0 && dy === 0) return;

    // Yaw around camera.up (the world-vertical we maintain across two-finger
    // roll). Drag-right rotates the camera right, so the world drags left;
    // negate dx for the conventional first-person feel.
    const yaw = -dx * ObserveControls.ROTATE_SPEED;
    let pitch = -dy * ObserveControls.ROTATE_SPEED;

    // Clamp pitch so the forward vector can't cross either pole. asin of
    // (forward · up) is the signed angle off the equatorial plane: +π/2
    // looking straight up, -π/2 straight down. Yaw is rotation around
    // camera.up so it preserves this dot product, hence sampling forward
    // before the yaw apply is fine.
    this.tmpFwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const dotUp = clamp(this.tmpFwd.dot(this.camera.up), -1, 1);
    const currentPitch = Math.asin(dotUp);
    pitch = clamp(
      pitch,
      -ObserveControls.PITCH_LIMIT - currentPitch,
      ObserveControls.PITCH_LIMIT - currentPitch,
    );

    this.tmpQ.setFromAxisAngle(this.camera.up, yaw);
    this.camera.quaternion.premultiply(this.tmpQ);

    // Camera-right axis after the yaw — premultiply rotated the basis in
    // world space, so re-derive the right vector from the updated quaternion
    // before applying pitch.
    this.tmpRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.tmpQ.setFromAxisAngle(this.tmpRight, pitch);
    this.camera.quaternion.premultiply(this.tmpQ);
    this.camera.quaternion.normalize();
  };

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
