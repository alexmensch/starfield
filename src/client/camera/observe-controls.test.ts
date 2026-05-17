import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { ObserveControls } from './observe-controls';

// Lightweight DOM event-target shim. The vitest config runs in Node, so
// we model just the API ObserveControls touches: addEventListener /
// removeEventListener storage, dispatchEvent that invokes registered
// handlers in registration order, plus the pointer-capture helpers.
class EventTargetShim {
  private listeners = new Map<string, Array<(e: Event) => void>>();
  private captured = new Set<number>();
  addEventListener(type: string, h: (e: Event) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(h);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, h: (e: Event) => void) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(h);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(type: string, e: Event): boolean {
    const arr = this.listeners.get(type);
    if (!arr) return true;
    for (const h of arr.slice()) h(e);
    return true;
  }
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) { this.captured.delete(id); }
  clientWidth = 800;
  clientHeight = 600;
}

// PointerEvent / WheelEvent shapes the controller actually reads. Plain
// objects are sufficient — no need to drag in jsdom.
function pe(type: string, opts: {
  pointerId?: number; clientX?: number; clientY?: number; button?: number;
} = {}): PointerEvent {
  return {
    type,
    pointerId: opts.pointerId ?? 1,
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
    button: opts.button ?? 0,
    preventDefault() {},
  } as unknown as PointerEvent;
}

function setupGlobals() {
  // ObserveControls reads window.innerWidth/Height in pixelToWorldDir.
  // Stub just enough so the unit-tests run in node.
  Object.assign(globalThis, {
    window: { innerWidth: 800, innerHeight: 600, addEventListener: () => {}, removeEventListener: () => {} },
    document: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
  });
}

function makeController() {
  setupGlobals();
  const canvas = new EventTargetShim() as unknown as HTMLCanvasElement & EventTargetShim;
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.001, 1000);
  camera.position.set(0, 0, 10);
  let fov = camera.fov;
  const setFov = (next: number) => { fov = next; camera.fov = next; };
  const getFov = () => fov;
  const ctrl = new ObserveControls(canvas, camera, setFov, getFov);
  return { ctrl, canvas, camera };
}

describe('ObserveControls / drag lifecycle', () => {
  beforeEach(() => setupGlobals());

  it('captures the pointer on pointerdown and releases on pointerup', () => {
    const { ctrl, canvas } = makeController();
    ctrl.enable();
    canvas.dispatchEvent('pointerdown', pe('pointerdown', { pointerId: 7 }));
    expect(canvas.hasPointerCapture(7)).toBe(true);
    canvas.dispatchEvent('pointerup', pe('pointerup', { pointerId: 7 }));
    expect(canvas.hasPointerCapture(7)).toBe(false);
  });

  it('rotates the camera quaternion when a drag move is dispatched', () => {
    const { ctrl, canvas, camera } = makeController();
    ctrl.enable();
    const q0 = camera.quaternion.clone();
    canvas.dispatchEvent('pointerdown', pe('pointerdown', { pointerId: 1, clientX: 400, clientY: 300 }));
    canvas.dispatchEvent('pointermove', pe('pointermove', { pointerId: 1, clientX: 600, clientY: 300 }));
    // Quaternion should have changed under a non-trivial drag — one of
    // the components must differ from the starting orientation.
    expect(camera.quaternion.equals(q0)).toBe(false);
  });

  it('ignores pointermove events without a preceding pointerdown', () => {
    const { ctrl, canvas, camera } = makeController();
    ctrl.enable();
    const q0 = camera.quaternion.clone();
    canvas.dispatchEvent('pointermove', pe('pointermove', { pointerId: 1, clientX: 600, clientY: 300 }));
    expect(camera.quaternion.equals(q0)).toBe(true);
  });

  it('ignores moves from an unrelated pointer mid-drag', () => {
    const { ctrl, canvas, camera } = makeController();
    ctrl.enable();
    canvas.dispatchEvent('pointerdown', pe('pointerdown', { pointerId: 1, clientX: 400, clientY: 300 }));
    const q1 = camera.quaternion.clone();
    canvas.dispatchEvent('pointermove', pe('pointermove', { pointerId: 99, clientX: 600, clientY: 300 }));
    // Different pointerId mid-drag must not move the camera.
    expect(camera.quaternion.equals(q1)).toBe(true);
  });

  it('cancels the drag on pointercancel without launching momentum', () => {
    const { ctrl, canvas, camera } = makeController();
    ctrl.enable();
    canvas.dispatchEvent('pointerdown', pe('pointerdown', { pointerId: 5, clientX: 400, clientY: 300 }));
    canvas.dispatchEvent('pointermove', pe('pointermove', { pointerId: 5, clientX: 500, clientY: 300 }));
    canvas.dispatchEvent('pointercancel', pe('pointercancel', { pointerId: 5 }));
    const qAtCancel = camera.quaternion.clone();
    // Advance time slightly and run update — the cancelled drag must
    // not produce any momentum-driven rotation.
    ctrl.update();
    expect(camera.quaternion.equals(qAtCancel)).toBe(true);
    // Capture must be released by the cancel handler.
    expect(canvas.hasPointerCapture(5)).toBe(false);
  });

  it('disable() removes listeners and prevents further drags', () => {
    const { ctrl, canvas, camera } = makeController();
    ctrl.enable();
    ctrl.disable();
    const q0 = camera.quaternion.clone();
    canvas.dispatchEvent('pointerdown', pe('pointerdown', { pointerId: 1, clientX: 400, clientY: 300 }));
    canvas.dispatchEvent('pointermove', pe('pointermove', { pointerId: 1, clientX: 600, clientY: 300 }));
    // No handlers attached → no rotation.
    expect(camera.quaternion.equals(q0)).toBe(true);
  });

  it('wheel scroll adjusts FOV via the setFov callback', () => {
    setupGlobals();
    const canvas = new EventTargetShim() as unknown as HTMLCanvasElement & EventTargetShim;
    const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.001, 1000);
    const setFov = vi.fn();
    const getFov = () => 50;
    const ctrl = new ObserveControls(canvas, camera, setFov, () => getFov());
    ctrl.enable();
    canvas.dispatchEvent('wheel', { deltaY: 100, preventDefault() {} } as unknown as WheelEvent);
    expect(setFov).toHaveBeenCalledTimes(1);
    // Positive deltaY → wider FOV (zoom out).
    expect(setFov.mock.calls[0][0]).toBeGreaterThan(50);
  });
});
