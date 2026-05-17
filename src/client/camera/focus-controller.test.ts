// FocusController tests (stellata-9mm.194.8). Exercise the focus FSM
// + focus-park lerp + pin engage geometry + FocusTarget round-trip +
// the observe-cleanup / unfocus-close-zoom branches of setFocus /
// unfocus. The hybrid arrival-curve internals are covered by
// arrival-curves.test.ts; star-physics formulas have their own tests
// in star-physics.test.ts. Here we just confirm FocusController
// routes the right context into each helper and fires the right
// events.

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import {
  FocusController,
  type FocusControllerDeps,
  type FrameAnchor,
  GLOBAL_MIN_DIST_PC,
  PIN_ENGAGE_THRESHOLD_SQ_PC,
} from './focus-controller';
import type { AimController } from './aim-controller';
import type { ObserveControls } from './observe-controls';
import type { ObserveTransition } from './observe-transition';
import type { WarpController } from './warp-controller';
import type { Catalog } from '../loaders/catalog-loader';
import type { CameraMode, StellataEventMap } from '../stellata';
import { EventBus } from '../util/event-bus';
import { FOCUS_LERP_MS } from './timing';

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

function makeAimStub(): AimController & {
  cancel: ReturnType<typeof vi.fn>;
  isActive: ReturnType<typeof vi.fn>;
} {
  return {
    cancel: vi.fn(),
    isActive: vi.fn(() => false),
  } as unknown as AimController & {
    cancel: ReturnType<typeof vi.fn>;
    isActive: ReturnType<typeof vi.fn>;
  };
}

interface WarpStub {
  isActive: ReturnType<typeof vi.fn>;
  isRecenteredToDest: ReturnType<typeof vi.fn>;
}
function makeWarpStub(): WarpController & WarpStub {
  return {
    isActive: vi.fn(() => false),
    isRecenteredToDest: vi.fn(() => false),
  } as unknown as WarpController & WarpStub;
}

interface ObserveStub {
  isActive: ReturnType<typeof vi.fn>;
  isAnyActive: ReturnType<typeof vi.fn>;
  cancelTransition: ReturnType<typeof vi.fn>;
  cancelUnfocusLerp: ReturnType<typeof vi.fn>;
  startExit: ReturnType<typeof vi.fn>;
  startUnfocusLerp: ReturnType<typeof vi.fn>;
}
function makeObserveStub(): ObserveTransition & ObserveStub {
  return {
    isActive: vi.fn(() => false),
    isAnyActive: vi.fn(() => false),
    cancelTransition: vi.fn(),
    cancelUnfocusLerp: vi.fn(),
    startExit: vi.fn(),
    startUnfocusLerp: vi.fn(),
  } as unknown as ObserveTransition & ObserveStub;
}

// Minimal Catalog stub for FocusController. Seeds N stars at evenly
// spaced positions along +X with a uniform physical radius so
// parkDistForStar / minOrbitDistForStar are deterministic. solIndex
// defaults to 0 so the initial `setFocus(0)` round-trip mirrors the
// production cold-start.
function makeCatalog(opts: {
  count?: number;
  positions?: number[];
  physicalRadius?: number;
  absmag?: number[];
  solIndex?: number;
} = {}): Catalog {
  const count = opts.count ?? 4;
  const positions = new Float32Array(count * 3);
  if (opts.positions) {
    for (let i = 0; i < opts.positions.length; i++) positions[i] = opts.positions[i];
  } else {
    // Stars at (0,0,0), (10,0,0), (50,0,0), (100,0,0) by default.
    const xs = [0, 10, 50, 100];
    for (let i = 0; i < count; i++) positions[i * 3] = xs[i] ?? i * 10;
  }
  const physicalRadius = new Float32Array(count).fill(opts.physicalRadius ?? 1.0);
  const absmag = new Float32Array(count);
  if (opts.absmag) {
    for (let i = 0; i < opts.absmag.length; i++) absmag[i] = opts.absmag[i];
  } else {
    absmag.fill(0);
  }
  return {
    count,
    positions,
    absmag,
    ci: new Float32Array(count),
    spectClass: new Float32Array(count),
    luminosityClass: new Uint8Array(count).fill(255),
    physicalRadius,
    constellation: new Float32Array(count),
    flags: new Uint8Array(count),
    companion: new Int32Array(count).fill(-1),
    periodDays: new Float32Array(count),
    amplitudeMag: new Float32Array(count),
    hip: new Uint32Array(count),
    names: new Map(),
    solIndex: opts.solIndex ?? 0,
    constellations: [],
  };
}

// FrameAnchor stub — mirrors the production behaviour: shifts a
// per-instance worldOffset, lets star-local positions roll through
// (catalog.positions - worldOffset).
interface FrameStub {
  anchor: FrameAnchor;
  worldOffset: THREE.Vector3;
  catalog: Catalog;
  recenterCalls: THREE.Vector3[];
}
function makeFrameAnchor(catalog: Catalog): FrameStub {
  const worldOffset = new THREE.Vector3();
  const recenterCalls: THREE.Vector3[] = [];
  const anchor: FrameAnchor = {
    recenterOrigin: (newOrigin) => {
      const dx = newOrigin.x - worldOffset.x;
      const dy = newOrigin.y - worldOffset.y;
      const dz = newOrigin.z - worldOffset.z;
      if (dx === 0 && dy === 0 && dz === 0) return null;
      worldOffset.copy(newOrigin);
      recenterCalls.push(new THREE.Vector3(dx, dy, dz));
      return new THREE.Vector3(dx, dy, dz);
    },
    getWorldOffset: () => worldOffset,
    starLocalPosition: (idx) => {
      const p = catalog.positions;
      return new THREE.Vector3(
        p[idx * 3] - worldOffset.x,
        p[idx * 3 + 1] - worldOffset.y,
        p[idx * 3 + 2] - worldOffset.z,
      );
    },
    starLocalPositionInto: (idx, out) => {
      const p = catalog.positions;
      out.set(
        p[idx * 3] - worldOffset.x,
        p[idx * 3 + 1] - worldOffset.y,
        p[idx * 3 + 2] - worldOffset.z,
      );
      return out;
    },
  };
  return { anchor, worldOffset, catalog, recenterCalls };
}

interface Harness {
  focus: FocusController;
  camera: THREE.PerspectiveCamera;
  controls: ReturnType<typeof makeControlsStub>;
  observeControls: ReturnType<typeof makeObserveControlsStub>;
  aim: ReturnType<typeof makeAimStub>;
  warp: WarpController & WarpStub;
  observe: ObserveTransition & ObserveStub;
  catalog: Catalog;
  frame: FrameStub;
  uHide: { value: number };
  bus: EventBus<StellataEventMap>;
  busEvents: Array<{ name: string; payload: unknown }>;
  vectorTo: Array<number | null>;
  vectorToCloud: Array<number | null>;
  setCameraMode: (m: CameraMode) => void;
  getCameraMode: () => CameraMode;
}

function makeHarness(opts: {
  mode?: CameraMode;
  catalog?: Catalog;
} = {}): Harness {
  const catalog = opts.catalog ?? makeCatalog();
  const camera = new THREE.PerspectiveCamera(60, 1, 1e-10, 100_000);
  const controls = makeControlsStub();
  const observeControls = makeObserveControlsStub();
  const aim = makeAimStub();
  const warp = makeWarpStub();
  const observe = makeObserveStub();
  const frame = makeFrameAnchor(catalog);
  const uHide = { value: -1 };
  const bus = new EventBus<StellataEventMap>();
  let cameraMode: CameraMode = opts.mode ?? 'navigate';

  const busEvents: Array<{ name: string; payload: unknown }> = [];
  for (const name of ['focus', 'cloudFocus', 'planetSystem', 'focusLerp', 'state', 'cameraMode'] as const) {
    bus.on(name, (payload: unknown) => {
      busEvents.push({ name, payload });
    });
  }

  const vectorTo: Array<number | null> = [];
  const vectorToCloud: Array<number | null> = [];

  const deps: FocusControllerDeps = {
    camera,
    controls,
    observeControls,
    catalog,
    bus,
    frameAnchor: frame.anchor,
    aim,
    uHideFocusIdxRef: uHide,
    getCameraMode: () => cameraMode,
    setCameraModeValue: (m) => { cameraMode = m; },
    getClouds: () => null,
    setVectorTo: (idx) => { vectorTo.push(idx); },
    setVectorToCloud: (idx) => { vectorToCloud.push(idx); },
    getWarp: () => warp,
    getObserve: () => observe,
  };

  return {
    focus: new FocusController(deps),
    camera,
    controls,
    observeControls,
    aim,
    warp,
    observe,
    catalog,
    frame,
    uHide,
    bus,
    busEvents,
    vectorTo,
    vectorToCloud,
    setCameraMode: (m) => { cameraMode = m; },
    getCameraMode: () => cameraMode,
  };
}

describe('FocusController — initial state', () => {
  it('starts unfocused with no focus-lerp', () => {
    const h = makeHarness();
    expect(h.focus.getFocusedStar()).toBeNull();
    expect(h.focus.getFocusedCloud()).toBeNull();
    expect(h.focus.getFocusedPlanetSystem()).toBeNull();
    expect(h.focus.isFocusLerpActive()).toBe(false);
  });

  it('isCameraBusy is false when nothing is active', () => {
    const h = makeHarness();
    expect(h.focus.isCameraBusy()).toBe(false);
  });
});

describe('FocusController.setFocus — star focus FSM', () => {
  it('focusing a star at the origin recentres worldOffset, emits focus + state', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    expect(h.focus.getFocusedStar()).toBe(1);
    // Star 1 was at (10,0,0) — worldOffset shifted to that position.
    expect(h.frame.worldOffset.x).toBeCloseTo(10, 6);
    // controls.target snapped to local (0,0,0).
    expect(h.controls.target.x).toBeCloseTo(0, 6);
    // Emitted events end with 'focus' + 'state'.
    expect(h.busEvents.map((e) => e.name)).toEqual(['focus', 'state']);
    expect(h.busEvents[0].payload).toBe(1);
  });

  it('setFocus(null) does NOT recentre worldOffset (a7d.2.11 invariant)', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    h.busEvents.length = 0;
    h.frame.recenterCalls.length = 0;
    h.focus.setFocus(null);
    expect(h.focus.getFocusedStar()).toBeNull();
    // worldOffset stays at the former focal star (10, 0, 0).
    expect(h.frame.worldOffset.x).toBeCloseTo(10, 6);
    expect(h.frame.recenterCalls).toEqual([]);
    expect(h.busEvents.map((e) => e.name)).toEqual(['focus', 'state']);
    expect(h.busEvents[0].payload).toBeNull();
  });

  it('re-focusing the same star is a no-op (no events, no recentre)', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    h.busEvents.length = 0;
    h.frame.recenterCalls.length = 0;
    h.focus.setFocus(1);
    expect(h.busEvents).toEqual([]);
    expect(h.frame.recenterCalls).toEqual([]);
  });

  it('focusing a star clears any prior cloud focus + emits cloudFocus(null) before focus(idx)', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    // Force a cloud focus through the dedicated setter; uses a custom
    // fixture since clouds layer isn't wired here.
    // Direct invocation of setFocusedCloud(null) wouldn't help — we
    // need a non-null cloud value, so re-enter through the FocusTarget
    // round-trip below in a dedicated test.
    // For this test just verify the cloud-clear branch doesn't fire on
    // a star → star transition.
    h.busEvents.length = 0;
    h.focus.setFocus(2);
    const names = h.busEvents.map((e) => e.name);
    expect(names).toEqual(['focus', 'state']);
  });

  it('observe-cleanup branch fires when setFocus runs in observe mode', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocus(1);
    // Flip to observe mode manually (mirrors what ObserveTransition.setMode
    // would do via setCameraModeValue) then change focus.
    h.setCameraMode('observe');
    h.uHide.value = 1; // simulate observe-mode invariant
    h.busEvents.length = 0;
    h.observe.cancelTransition.mockClear();
    h.aim.cancel.mockClear();
    h.observeControls.disable.mockClear();

    h.focus.setFocus(2);
    expect(h.observe.cancelTransition).toHaveBeenCalledTimes(1);
    expect(h.aim.cancel).toHaveBeenCalledTimes(1);
    expect(h.observeControls.disable).toHaveBeenCalledTimes(1);
    expect(h.getCameraMode()).toBe('navigate');
    expect(h.uHide.value).toBe(-1);
    expect(h.controls.enabled).toBe(true);
    // Order: cameraMode → focus → state. The observe-cleanup branch
    // emits cameraMode BEFORE the focus mutation runs.
    expect(h.busEvents.map((e) => e.name)).toEqual(['cameraMode', 'focus', 'state']);
  });

  it('setFocus(null) clamps controls.minDistance to ≤ current eye distance', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    // Move camera close to the focal star (eye = 1e-4 pc < GLOBAL_MIN_DIST_PC).
    h.camera.position.set(1e-4, 0, 0);
    h.controls.target.set(0, 0, 0);
    h.focus.setFocus(null);
    expect(h.controls.minDistance).toBeLessThanOrEqual(1e-4);
    expect(h.controls.minDistance).toBeLessThan(GLOBAL_MIN_DIST_PC);
  });
});

describe('FocusController.focusStar — focus-park lerp', () => {
  it('near focus (eye ≤ parkDist): no lerp starts', () => {
    const h = makeHarness();
    h.focus.setFocus(0); // worldOffset = origin
    h.camera.position.set(1e-7, 0, 0); // very close
    h.busEvents.length = 0;
    h.focus.focusStar(0);
    expect(h.focus.isFocusLerpActive()).toBe(false);
  });

  it('far focus (eye > parkDist): starts a focus-park lerp and emits focusLerp(true)', () => {
    const h = makeHarness();
    h.camera.position.set(0, 0, 1000); // far away
    h.busEvents.length = 0;
    h.focus.focusStar(2); // star at (50,0,0)
    expect(h.focus.isFocusLerpActive()).toBe(true);
    const lerpEvents = h.busEvents.filter((e) => e.name === 'focusLerp');
    expect(lerpEvents).toHaveLength(1);
    expect(lerpEvents[0].payload).toBe(true);
  });

  it('cancelFocusLerp mid-lerp clears the slot and emits focusLerp(false)', () => {
    const h = makeHarness();
    h.camera.position.set(0, 0, 1000);
    h.focus.focusStar(2);
    expect(h.focus.isFocusLerpActive()).toBe(true);
    h.busEvents.length = 0;
    h.focus.cancelFocusLerp();
    expect(h.focus.isFocusLerpActive()).toBe(false);
    expect(h.busEvents).toEqual([{ name: 'focusLerp', payload: false }]);
  });

  it('focusStar bails when warp is active', () => {
    const h = makeHarness();
    h.warp.isActive.mockReturnValue(true);
    h.focus.focusStar(2);
    expect(h.focus.getFocusedStar()).toBeNull();
    expect(h.focus.isFocusLerpActive()).toBe(false);
  });

  it('focusStar with animate:false snaps the camera to parkDist instead of starting a lerp', () => {
    const h = makeHarness();
    h.camera.position.set(0, 0, 1000);
    h.focus.focusStar(2, { animate: false });
    expect(h.focus.isFocusLerpActive()).toBe(false);
    // Eye distance is now parkDist (or whatever the helper computed).
    const eye = h.camera.position.length();
    expect(eye).toBeGreaterThan(0);
    expect(eye).toBeLessThan(1); // not 1000 anymore
  });

  it('tick lands the focus-park lerp and emits focusLerp(false) at end', () => {
    const h = makeHarness();
    const startMs = 1000;
    vi.spyOn(performance, 'now').mockReturnValue(startMs);
    h.camera.position.set(0, 0, 1000);
    h.focus.focusStar(2);
    h.busEvents.length = 0;

    // Tick past the lerp duration to land it.
    h.focus.tick(startMs + FOCUS_LERP_MS + 100);

    expect(h.focus.isFocusLerpActive()).toBe(false);
    expect(h.busEvents).toEqual([{ name: 'focusLerp', payload: false }]);
    expect(h.controls.update).toHaveBeenCalled();
  });
});

describe('FocusController.isPinEngaged', () => {
  it('engages when focused, navigate, target ≈ origin, no other animation', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    h.controls.target.set(0, 0, 0);
    expect(h.focus.isPinEngaged()).toBe(true);
  });

  it('disengages when no star is focused', () => {
    const h = makeHarness();
    expect(h.focus.isPinEngaged()).toBe(false);
  });

  it('disengages when target is past the threshold', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    h.controls.target.set(1e-3, 0, 0); // 1e-6 pc² > 1e-12 threshold
    expect(h.focus.isPinEngaged()).toBe(false);
  });

  it('disengages during warp until recenteredToDest', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    h.controls.target.set(0, 0, 0);
    h.warp.isActive.mockReturnValue(true);
    expect(h.focus.isPinEngaged()).toBe(false);
    h.warp.isRecenteredToDest.mockReturnValue(true);
    expect(h.focus.isPinEngaged()).toBe(true);
  });

  it('disengages during aim slerp', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    h.controls.target.set(0, 0, 0);
    h.aim.isActive.mockReturnValue(true);
    expect(h.focus.isPinEngaged()).toBe(false);
  });

  it('getPinEngageThresholdSq returns the constant', () => {
    const h = makeHarness();
    expect(h.focus.getPinEngageThresholdSq()).toBe(PIN_ENGAGE_THRESHOLD_SQ_PC);
  });
});

describe('FocusController.unfocus — close-zoom branch', () => {
  it('navigate inside parkDist: starts an unfocus lerp via ObserveTransition', () => {
    const h = makeHarness();
    h.focus.setFocus(1); // worldOffset = (10,0,0); local origin = star
    // Camera VERY close to the focal star (inside parkDist).
    h.camera.position.set(1e-7, 0, 0);
    h.controls.target.set(0, 0, 0);

    h.focus.unfocus();

    expect(h.observe.startUnfocusLerp).toHaveBeenCalledTimes(1);
    expect(h.focus.getFocusedStar()).toBeNull();
  });

  it('navigate beyond parkDist: hard clear, no unfocus lerp', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    h.camera.position.set(0, 0, 100); // way outside parkDist
    h.controls.target.set(0, 0, 0);
    h.focus.unfocus();
    expect(h.observe.startUnfocusLerp).not.toHaveBeenCalled();
    expect(h.focus.getFocusedStar()).toBeNull();
  });

  it('observe mode: starts an observe-exit then sets focus to null', () => {
    const h = makeHarness({ mode: 'navigate' });
    h.focus.setFocus(1);
    h.setCameraMode('observe'); // mimic post-enter state
    h.busEvents.length = 0;
    h.focus.unfocus();
    expect(h.observe.startExit).toHaveBeenCalledWith({ animate: true, clearFocusOnExit: false });
    expect(h.focus.getFocusedStar()).toBeNull();
  });

  it('unfocus is a no-op when warp is active', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    h.warp.isActive.mockReturnValue(true);
    h.focus.unfocus();
    expect(h.focus.getFocusedStar()).toBe(1);
  });

  it('unfocus is a no-op when nothing is focused', () => {
    const h = makeHarness();
    h.busEvents.length = 0;
    h.focus.unfocus();
    expect(h.busEvents).toEqual([]);
  });
});

describe('FocusController.makeStarFocusTarget — round-trip', () => {
  it('applyFocus mutates focus state, emitFocusEvents fires the bus', () => {
    const h = makeHarness();
    const target = h.focus.makeStarFocusTarget(2);
    expect(target.kind).toBe('star');
    expect(target.idx).toBe(2);

    target.applyFocus();
    expect(h.focus.getFocusedStar()).toBe(2);

    h.busEvents.length = 0;
    target.emitFocusEvents();
    // No prior cloud focus → no cloudFocus(null) clearing event.
    expect(h.busEvents.map((e) => e.name)).toEqual(['focus', 'state']);
    expect(h.busEvents[0].payload).toBe(2);
  });

  it('applyFocus on a star clears any prior cloud focus and emits cloudFocus(null)', () => {
    const h = makeHarness();
    // Synthesise a cloud focus via FocusTarget applyFocus path. Since
    // makeCloudFocusTarget returns null without a clouds layer, we
    // instead invoke setFocusedCloud directly to seed the state.
    // Use a sentinel cloud index (FocusController doesn't validate idx
    // against a missing clouds layer in setFocusedCloud).
    h.focus.setFocusedCloud(42);
    expect(h.focus.getFocusedCloud()).toBe(42);

    const target = h.focus.makeStarFocusTarget(1);
    target.applyFocus();
    expect(h.focus.getFocusedStar()).toBe(1);
    expect(h.focus.getFocusedCloud()).toBeNull();

    h.busEvents.length = 0;
    target.emitFocusEvents();
    expect(h.busEvents.map((e) => e.name)).toEqual(['cloudFocus', 'focus', 'state']);
    expect(h.busEvents[0].payload).toBeNull();
  });

  it('parkRadius matches starPhysics.parkDistForStar', () => {
    const h = makeHarness();
    const target = h.focus.makeStarFocusTarget(2);
    const direct = h.focus.parkDistForStar(2);
    expect(target.parkRadius()).toBe(direct);
  });

  it('anchorInto writes absolute catalog position', () => {
    const h = makeHarness();
    const target = h.focus.makeStarFocusTarget(2);
    const out = new THREE.Vector3();
    target.anchorInto(out);
    expect(out.x).toBe(50);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('physicalRadius applies the MIN_PHYSICAL_RADIUS_R_SUN floor', () => {
    const tinyCat = makeCatalog({ physicalRadius: 0 });
    const h = makeHarness({ catalog: tinyCat });
    const target = h.focus.makeStarFocusTarget(1);
    const r = target.physicalRadius();
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0);
  });
});

describe('FocusController — frame anchor delegation', () => {
  it('starLocalPosition reflects current worldOffset', () => {
    const h = makeHarness();
    h.focus.setFocus(1); // worldOffset = (10,0,0)
    const local0 = h.focus.starLocalPosition(0); // star 0 is at (0,0,0) abs
    expect(local0.x).toBeCloseTo(-10, 6);
    const local1 = h.focus.starLocalPosition(1);
    expect(local1.x).toBeCloseTo(0, 6);
  });

  it('recenterOrigin delegates to the FrameAnchor', () => {
    const h = makeHarness();
    h.focus.recenterOrigin(new THREE.Vector3(5, 0, 0));
    expect(h.frame.worldOffset.x).toBe(5);
  });
});

describe('FocusController — vector slot delegation', () => {
  it('setVectorTo and setVectorToCloud call through to dep callbacks', () => {
    const h = makeHarness();
    h.focus.setVectorTo(3);
    h.focus.setVectorToCloud(null);
    expect(h.vectorTo).toEqual([3]);
    expect(h.vectorToCloud).toEqual([null]);
  });

  it('focusStar clears any in-flight vector', () => {
    const h = makeHarness();
    h.focus.focusStar(2);
    expect(h.vectorTo).toEqual([null]);
  });
});

describe('FocusController.dispose', () => {
  it('clears focus state', () => {
    const h = makeHarness();
    h.focus.setFocus(1);
    h.focus.dispose();
    expect(h.focus.getFocusedStar()).toBeNull();
    expect(h.focus.getFocusedCloud()).toBeNull();
    expect(h.focus.isFocusLerpActive()).toBe(false);
  });
});
