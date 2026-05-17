// ObserveTransition tests (stellata-9mm.194.6). The four mode-switch
// entry points + the unfocus-lerp variant + cancellation paths +
// isActive / isAnyActive contracts. Hybrid arrival-curve internals are
// covered by arrival-curves.test.ts and camera-motion.test.ts — here we
// just confirm ObserveTransition routes the right context into the
// shared helpers.
//
// The harness mirrors warp-controller.test.ts's shape: stub controls,
// observeControls, AimController, plus a FocusFixture that records
// every call into the ObserveFocusOps surface. setCameraModeValue is
// wired to a mutable closure so the controller's "Stellata still owns
// cameraMode" handshake works end-to-end.

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import {
  ObserveTransition,
  type ObserveFocusOps,
  type ObserveTransitionDeps,
} from './observe-transition';
import type { AimController } from './aim-controller';
import type { ObserveControls } from './observe-controls';
import type { CameraMode, StellataEventMap } from '../stellata';
import { EventBus } from '../util/event-bus';
import { OBSERVE_TRANSITION_MS } from './timing';

function makeControlsStub(): TrackballControls & {
  update: ReturnType<typeof vi.fn>;
} {
  return {
    enabled: true,
    target: new THREE.Vector3(0, 0, 0),
    minDistance: 0,
    update: vi.fn(),
  } as unknown as TrackballControls & { update: ReturnType<typeof vi.fn> };
}

function makeObserveControlsStub(): ObserveControls & {
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
} {
  return {
    enable: vi.fn(),
    disable: vi.fn(),
  } as unknown as ObserveControls & {
    enable: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
  };
}

function makeAimStub(): AimController & { cancel: ReturnType<typeof vi.fn> } {
  return {
    cancel: vi.fn(),
  } as unknown as AimController & { cancel: ReturnType<typeof vi.fn> };
}

interface FocusFixture {
  ops: ObserveFocusOps;
  calls: {
    setFocus: Array<number | null>;
    setVectorTo: Array<number | null>;
    setVectorToCloud: Array<number | null>;
  };
  parkDistByIdx: Map<number, number>;
  setFocusedStar(idx: number | null): void;
  setBusy(busy: boolean): void;
}

function makeFocus(): FocusFixture {
  let focusedStar: number | null = null;
  let busy = false;
  const parkDistByIdx = new Map<number, number>();
  const calls = {
    setFocus: [] as Array<number | null>,
    setVectorTo: [] as Array<number | null>,
    setVectorToCloud: [] as Array<number | null>,
  };
  const ops: ObserveFocusOps = {
    getFocusedStar: () => focusedStar,
    setFocus: (idx) => { focusedStar = idx; calls.setFocus.push(idx); },
    setVectorTo: (idx) => { calls.setVectorTo.push(idx); },
    setVectorToCloud: (idx) => { calls.setVectorToCloud.push(idx); },
    parkDistForStar: (idx) => parkDistByIdx.get(idx) ?? 1.0,
    isCameraBusy: () => busy,
  };
  return {
    ops,
    calls,
    parkDistByIdx,
    setFocusedStar: (idx) => { focusedStar = idx; },
    setBusy: (b) => { busy = b; },
  };
}

interface Harness {
  observe: ObserveTransition;
  camera: THREE.PerspectiveCamera;
  controls: ReturnType<typeof makeControlsStub>;
  observeControls: ReturnType<typeof makeObserveControlsStub>;
  aim: ReturnType<typeof makeAimStub>;
  uHide: { value: number };
  bus: EventBus<StellataEventMap>;
  focus: FocusFixture;
  setCameraMode(m: CameraMode): void;
  getCameraMode(): CameraMode;
  busEvents: Array<{ name: string; payload: unknown }>;
}

function makeHarness(opts: { mode?: CameraMode } = {}): Harness {
  const camera = new THREE.PerspectiveCamera(60, 1, 1e-10, 100_000);
  const controls = makeControlsStub();
  const observeControls = makeObserveControlsStub();
  const aim = makeAimStub();
  const uHide = { value: -1 };
  const bus = new EventBus<StellataEventMap>();
  const focus = makeFocus();
  let cameraMode: CameraMode = opts.mode ?? 'navigate';

  const busEvents: Array<{ name: string; payload: unknown }> = [];
  for (const name of ['cameraMode', 'state'] as const) {
    bus.on(name, (payload: unknown) => {
      busEvents.push({ name, payload });
    });
  }

  const deps: ObserveTransitionDeps = {
    camera,
    controls,
    observeControls,
    aim,
    uHideFocusIdxRef: uHide,
    bus,
    focus: focus.ops,
    getCameraMode: () => cameraMode,
    setCameraModeValue: (m) => { cameraMode = m; },
  };

  return {
    observe: new ObserveTransition(deps),
    camera,
    controls,
    observeControls,
    aim,
    uHide,
    bus,
    focus,
    setCameraMode: (m) => { cameraMode = m; },
    getCameraMode: () => cameraMode,
    busEvents,
  };
}

describe('ObserveTransition — lifecycle + activity predicates', () => {
  it('starts idle — isActive / isAnyActive false, getProgress null', () => {
    const h = makeHarness();
    expect(h.observe.isActive()).toBe(false);
    expect(h.observe.isAnyActive()).toBe(false);
    expect(h.observe.getProgress()).toBeNull();
  });

  it('dispose() clears state and re-disables observation predicates', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocusedStar(7);
    h.observe.setMode('observe', { animate: true });
    expect(h.observe.isActive()).toBe(true);
    h.observe.dispose();
    expect(h.observe.isActive()).toBe(false);
    expect(h.observe.isAnyActive()).toBe(false);
    expect(h.observe.getProgress()).toBeNull();
  });
});

describe('ObserveTransition.setMode — navigate → observe (animated)', () => {
  it('builds an enter transition, drops vectors, flips controls/cameraMode, emits cameraMode+state', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocusedStar(3);
    h.camera.position.set(10, 0, 0);

    h.observe.setMode('observe', { animate: true });

    expect(h.getCameraMode()).toBe('observe');
    expect(h.controls.enabled).toBe(false);
    expect(h.focus.calls.setVectorTo).toEqual([null]);
    expect(h.focus.calls.setVectorToCloud).toEqual([null]);
    expect(h.observe.isActive()).toBe(true);
    expect(h.observe.isAnyActive()).toBe(true);
    // uHide stays -1 during the glide — focal star visible until park.
    expect(h.uHide.value).toBe(-1);
    expect(h.busEvents).toEqual([
      { name: 'cameraMode', payload: 'observe' },
      { name: 'state', payload: undefined },
    ]);
  });

  it('progress eases inline smoothstep from 0 → 1 and lerps camera.position toward origin', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocusedStar(3);
    h.camera.position.set(10, 0, 0);
    const startNow = 1000;
    vi.spyOn(performance, 'now').mockReturnValue(startNow);
    h.observe.setMode('observe', { animate: true });

    // Midway through the transition.
    const half = startNow + OBSERVE_TRANSITION_MS / 2;
    vi.spyOn(performance, 'now').mockReturnValue(half);
    const progress = h.observe.getProgress();
    expect(progress?.kind).toBe('enter');
    expect(progress?.f).toBeCloseTo(0.5, 6);

    h.observe.tick(half);
    // f=0.5 ⇒ camera at midpoint between (10,0,0) and origin.
    expect(h.camera.position.x).toBeCloseTo(5, 6);
  });

  it('finishes the enter transition at the focal-star local origin, sets uHide, enables observeControls', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocusedStar(3);
    h.camera.position.set(10, 0, 0);
    const startNow = 2000;
    vi.spyOn(performance, 'now').mockReturnValue(startNow);
    h.observe.setMode('observe', { animate: true });
    h.busEvents.length = 0;

    vi.spyOn(performance, 'now').mockReturnValue(startNow + OBSERVE_TRANSITION_MS + 1);
    h.observe.tick(startNow + OBSERVE_TRANSITION_MS + 1);

    expect(h.camera.position.x).toBe(0);
    expect(h.camera.position.y).toBe(0);
    expect(h.camera.position.z).toBe(0);
    expect(h.uHide.value).toBe(3);
    expect(h.observeControls.enable).toHaveBeenCalledTimes(1);
    expect(h.observe.isActive()).toBe(false);
    expect(h.busEvents).toEqual([{ name: 'state', payload: undefined }]);
  });
});

describe('ObserveTransition.setMode — navigate → observe (snap, animate:false)', () => {
  it('snaps the camera to origin, sets uHide immediately, no transition slot', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocusedStar(5);
    h.camera.position.set(7, 0, 0);

    h.observe.setMode('observe', { animate: false });

    expect(h.camera.position.x).toBe(0);
    expect(h.camera.position.y).toBe(0);
    expect(h.camera.position.z).toBe(0);
    expect(h.uHide.value).toBe(5);
    expect(h.observeControls.enable).toHaveBeenCalledTimes(1);
    expect(h.observe.isActive()).toBe(false);
    expect(h.observe.isAnyActive()).toBe(false);
    expect(h.busEvents).toEqual([
      { name: 'cameraMode', payload: 'observe' },
      { name: 'state', payload: undefined },
    ]);
  });
});

describe('ObserveTransition.setMode — gates', () => {
  it('no-ops when mode equals current cameraMode', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.observe.setMode('navigate');
    expect(h.busEvents).toEqual([]);
    expect(h.aim.cancel).not.toHaveBeenCalled();
  });

  it('no-ops when isCameraBusy returns true', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocusedStar(1);
    h.focus.setBusy(true);
    h.observe.setMode('observe', { animate: true });
    expect(h.busEvents).toEqual([]);
    expect(h.getCameraMode()).toBe('navigate');
  });

  it("no-ops on 'observe' entry when there's no focused star", () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocusedStar(null);
    h.observe.setMode('observe', { animate: true });
    expect(h.busEvents).toEqual([]);
    expect(h.getCameraMode()).toBe('navigate');
  });
});

describe('ObserveTransition.startExit — observe → navigate', () => {
  it('animated exit: flips mode, disables observe, builds exit transition with toPos along backward-forward at parkDist', () => {
    const h = makeHarness({ mode: 'observe' });
    h.focus.setFocusedStar(2);
    h.focus.parkDistByIdx.set(2, 0.5);
    // Camera at the focal-star origin (observe parks AT (0,0,0)),
    // looking down -Z. forward = (0,0,-1). toPos = -forward * parkDist
    // = (0, 0, +parkDist).
    h.camera.position.set(0, 0, 0);
    h.camera.quaternion.identity();

    h.observe.startExit({ animate: true, clearFocusOnExit: false });

    expect(h.getCameraMode()).toBe('navigate');
    expect(h.uHide.value).toBe(-1);
    expect(h.observeControls.disable).toHaveBeenCalledTimes(1);
    expect(h.aim.cancel).toHaveBeenCalledTimes(1);
    expect(h.observe.isActive()).toBe(true);
    expect(h.observe.isAnyActive()).toBe(true);
    const progress = h.observe.getProgress();
    expect(progress?.kind).toBe('exit');
    expect(h.busEvents).toEqual([
      { name: 'cameraMode', payload: 'navigate' },
      { name: 'state', payload: undefined },
    ]);
  });

  it('animated exit lands at toPos = forward * -parkDist (observe parks camera at (0,0,0)); re-enables TrackballControls', () => {
    const h = makeHarness({ mode: 'observe' });
    h.focus.setFocusedStar(2);
    h.focus.parkDistByIdx.set(2, 0.3);
    // Observe mode invariant: camera AT the focal star's local origin.
    // fromPos = (0, 0, 0); toPos = -forward * parkDist.
    h.camera.position.set(0, 0, 0);
    h.camera.quaternion.identity();
    const startNow = 5000;
    vi.spyOn(performance, 'now').mockReturnValue(startNow);
    h.controls.enabled = false;
    h.observe.startExit({ animate: true, clearFocusOnExit: false });
    h.busEvents.length = 0;

    vi.spyOn(performance, 'now').mockReturnValue(startNow + OBSERVE_TRANSITION_MS + 1);
    h.observe.tick(startNow + OBSERVE_TRANSITION_MS + 1);

    expect(h.controls.enabled).toBe(true);
    expect(h.controls.update).toHaveBeenCalled();
    // With identity quaternion, forward = (0, 0, -1), so
    // toPos = -forward * parkDist = (0, 0, 0.3).
    expect(h.camera.position.x).toBeCloseTo(0, 6);
    expect(h.camera.position.y).toBeCloseTo(0, 6);
    expect(h.camera.position.z).toBeCloseTo(0.3, 6);
    // controls.target snaps to fromPos so TrackballControls' lookAt is
    // a no-op for orientation on the next update — fromPos here is
    // (0,0,0), so target is (0,0,0).
    expect(h.controls.target.x).toBeCloseTo(0, 6);
    expect(h.controls.target.y).toBeCloseTo(0, 6);
    expect(h.controls.target.z).toBeCloseTo(0, 6);
    expect(h.observe.isActive()).toBe(false);
    expect(h.busEvents).toEqual([{ name: 'state', payload: undefined }]);
  });

  it('clearFocusOnExit=true: setFocus(null) fires at the end of the exit transition', () => {
    const h = makeHarness({ mode: 'observe' });
    h.focus.setFocusedStar(2);
    h.focus.parkDistByIdx.set(2, 0.1);
    h.camera.position.set(0, 0, 0);
    h.camera.quaternion.identity();
    const startNow = 6000;
    vi.spyOn(performance, 'now').mockReturnValue(startNow);
    h.observe.startExit({ animate: true, clearFocusOnExit: true });

    expect(h.focus.calls.setFocus).toEqual([]);

    vi.spyOn(performance, 'now').mockReturnValue(startNow + OBSERVE_TRANSITION_MS + 1);
    h.observe.tick(startNow + OBSERVE_TRANSITION_MS + 1);
    expect(h.focus.calls.setFocus).toEqual([null]);
  });

  it('animate:false snap branch resets target to (0,0,0), runs controls.update, re-enables controls', () => {
    const h = makeHarness({ mode: 'observe' });
    h.focus.setFocusedStar(2);
    h.focus.parkDistByIdx.set(2, 0.5);
    h.camera.position.set(0, 0, 0);
    h.controls.target.set(0.1, 0, -1);
    h.controls.enabled = false;

    h.observe.startExit({ animate: false, clearFocusOnExit: false });

    expect(h.getCameraMode()).toBe('navigate');
    expect(h.controls.target.x).toBe(0);
    expect(h.controls.target.y).toBe(0);
    expect(h.controls.target.z).toBe(0);
    expect(h.controls.update).toHaveBeenCalled();
    expect(h.controls.enabled).toBe(true);
    expect(h.observe.isActive()).toBe(false);
    expect(h.busEvents).toEqual([
      { name: 'cameraMode', payload: 'navigate' },
      { name: 'state', payload: undefined },
    ]);
  });

  it('animate:false + clearFocusOnExit=true also clears focus immediately', () => {
    const h = makeHarness({ mode: 'observe' });
    h.focus.setFocusedStar(2);
    h.focus.parkDistByIdx.set(2, 0.5);
    h.observe.startExit({ animate: false, clearFocusOnExit: true });
    expect(h.focus.calls.setFocus).toEqual([null]);
  });

  it('no-ops when cameraMode is already navigate', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.observe.startExit({ animate: true, clearFocusOnExit: false });
    expect(h.busEvents).toEqual([]);
    expect(h.aim.cancel).not.toHaveBeenCalled();
  });

  it('animate=true but no focused star falls through to the snap branch', () => {
    const h = makeHarness({ mode: 'observe' });
    h.focus.setFocusedStar(null);
    h.observe.startExit({ animate: true, clearFocusOnExit: false });
    // Snap path engaged: no transition slot, controls reset.
    expect(h.observe.isAnyActive()).toBe(false);
    expect(h.controls.target.x).toBe(0);
    expect(h.controls.enabled).toBe(true);
  });
});

describe('ObserveTransition.startUnfocusLerp — navigate-mode close-zoom', () => {
  it('builds an unfocus transition with finalMinDistance + arrival profile, emits state but NOT cameraMode', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.controls.target.set(0, 0, 0);
    const fromPos = new THREE.Vector3(0, 0, 0.01);
    const toPos = new THREE.Vector3(0, 0, 0.5);

    h.observe.startUnfocusLerp(fromPos, toPos, 0.5);

    expect(h.observe.isAnyActive()).toBe(true);
    // 'unfocus' is hidden from isActive / getProgress per contract —
    // overlays gating on observe visibility stay steady-state-navigate.
    expect(h.observe.isActive()).toBe(false);
    expect(h.observe.getProgress()).toBeNull();
    expect(h.busEvents).toEqual([{ name: 'state', payload: undefined }]);
  });

  it('on completion, tightens controls.minDistance to finalMinDist and calls controls.update', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.controls.target.set(0, 0, 0);
    h.controls.minDistance = 1e-4;
    const fromPos = new THREE.Vector3(0, 0, 0.01);
    const toPos = new THREE.Vector3(0, 0, 0.5);
    const startNow = 7000;
    vi.spyOn(performance, 'now').mockReturnValue(startNow);
    h.observe.startUnfocusLerp(fromPos, toPos, 0.5);
    h.busEvents.length = 0;

    vi.spyOn(performance, 'now').mockReturnValue(startNow + OBSERVE_TRANSITION_MS + 1);
    h.observe.tick(startNow + OBSERVE_TRANSITION_MS + 1);

    expect(h.controls.minDistance).toBe(0.5);
    expect(h.controls.update).toHaveBeenCalled();
    expect(h.camera.position.z).toBeCloseTo(0.5, 6);
    expect(h.observe.isAnyActive()).toBe(false);
    expect(h.busEvents).toEqual([{ name: 'state', payload: undefined }]);
  });
});

describe('ObserveTransition cancellation', () => {
  it('cancelUnfocusLerp only clears the slot when kind === unfocus', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocusedStar(1);
    h.controls.target.set(0, 0, 0);

    // 'enter' kind: cancelUnfocusLerp is a no-op.
    h.observe.setMode('observe', { animate: true });
    h.observe.cancelUnfocusLerp();
    expect(h.observe.isActive()).toBe(true);

    // 'unfocus' kind: cancelUnfocusLerp clears.
    h.observe.dispose();
    h.observe.startUnfocusLerp(
      new THREE.Vector3(0, 0, 0.01),
      new THREE.Vector3(0, 0, 0.5),
      0.5,
    );
    expect(h.observe.isAnyActive()).toBe(true);
    h.observe.cancelUnfocusLerp();
    expect(h.observe.isAnyActive()).toBe(false);
  });

  it('cancelTransition wipes any kind without touching cameraMode or emitting', () => {
    const h = makeHarness({ mode: 'observe' });
    h.focus.setFocusedStar(1);
    h.observe.setMode('navigate', { animate: true });
    h.busEvents.length = 0;
    expect(h.observe.isActive()).toBe(true);

    h.observe.cancelTransition();

    expect(h.observe.isActive()).toBe(false);
    expect(h.observe.isAnyActive()).toBe(false);
    // cameraMode left at whatever setMode set it to ('navigate' here)
    // — cancelTransition is a pure state reset.
    expect(h.getCameraMode()).toBe('navigate');
    expect(h.busEvents).toEqual([]);
  });
});

describe('ObserveTransition.getProgress — kind filtering', () => {
  it('returns null when only an unfocus lerp is active', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.observe.startUnfocusLerp(
      new THREE.Vector3(0, 0, 0.01),
      new THREE.Vector3(0, 0, 0.5),
      0.5,
    );
    expect(h.observe.getProgress()).toBeNull();
  });

  it('emits enter / exit kind exactly per the active transition', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocusedStar(1);
    h.observe.setMode('observe', { animate: true });
    expect(h.observe.getProgress()?.kind).toBe('enter');

    h.observe.dispose();
    h.setCameraMode('observe');
    h.focus.parkDistByIdx.set(1, 0.1);
    h.observe.startExit({ animate: true, clearFocusOnExit: false });
    expect(h.observe.getProgress()?.kind).toBe('exit');
  });
});
