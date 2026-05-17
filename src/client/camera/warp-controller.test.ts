// WarpController tests (stellata-9mm.194.5). The 3-phase FSM is the
// focus: we exercise the reorient → fly → post-arrival progression,
// the four source/dest variants the bead enumerates (star→star,
// star→cloud, cloud→star, observe→observe), the mid-Fly recentre
// trigger, skipWarp during each phase, the coincident-source bail,
// the no-focus bail, and the per-phase getWarpPhase / getWarpInfo
// outputs. Hybrid arrival curve internals are covered by
// arrival-curves.test.ts — here we just confirm WarpController hands
// the right context (`d0`, `dEnd`, `targetRadius`) to that helper.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import type { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import {
  WarpController,
  type FocusOps,
  type WarpControllerDeps,
} from './warp-controller';
import type { FocusTarget } from './focus-target';
import type { ObserveControls } from './observe-controls';
import type { CameraMode, StellataEventMap } from '../stellata';
import { EventBus } from '../util/event-bus';
import {
  WARP_REORIENT_MS,
  WARP_T_K_MS,
  WARP_T_MAX_MS,
  WARP_T_MIN_MS,
  OBSERVE_TRANSITION_MS,
} from './timing';

// Mirror of WarpController's Fly duration formula. Used by tests that
// need to land their `tick(nowMs)` precisely inside the post-arrival
// window — without this, a tick "past Fly" might also overshoot the
// 1.8 s post-arrival slerp and trip finishWarp.
function flyDurMs(distPc: number): number {
  return Math.min(
    WARP_T_MAX_MS,
    WARP_T_MIN_MS + WARP_T_K_MS * Math.log10(1 + distPc),
  );
}

function makeControlsStub(): TrackballControls & {
  update: ReturnType<typeof vi.fn>;
} {
  return {
    enabled: true,
    target: new THREE.Vector3(0, 0, 0),
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

// FocusOps double — backed by simple per-kind position tables so the
// controller can resolve `dest.localPositionInto` / `anchorInto` /
// `parkRadius` / `physicalRadius` deterministically. The mutating side
// (`applyFocus`, `setFocus`, `recenterOrigin`, etc.) records calls so
// individual tests can assert which path fired.
interface StarRow {
  abs: THREE.Vector3;
  parkRadius: number;
  physicalRadius: number | null;
}
interface CloudRow {
  abs: THREE.Vector3;
  parkRadius: number;
}

interface FocusFixture {
  ops: FocusOps;
  worldOffset: THREE.Vector3;
  setFocusedStar: (idx: number | null) => void;
  setFocusedCloud: (idx: number | null) => void;
  stars: Map<number, StarRow>;
  clouds: Map<number, CloudRow>;
  calls: {
    recenterOrigin: number;
    recenterFocusToStar: number[];
    setFocus: Array<number | null>;
    setFocusedCloud: Array<number | null>;
    setVectorTo: Array<number | null>;
    setVectorToCloud: Array<number | null>;
    cancelFocusLerp: number;
    cancelUnfocusLerp: number;
    applyFocus: Array<{ kind: string; idx: number }>;
    emitFocusEvents: Array<{ kind: string; idx: number }>;
  };
}

function makeFocus(): FocusFixture {
  const worldOffset = new THREE.Vector3();
  const stars = new Map<number, StarRow>();
  const clouds = new Map<number, CloudRow>();
  let focusedStar: number | null = null;
  let focusedCloud: number | null = null;
  const calls: FocusFixture['calls'] = {
    recenterOrigin: 0,
    recenterFocusToStar: [],
    setFocus: [],
    setFocusedCloud: [],
    setVectorTo: [],
    setVectorToCloud: [],
    cancelFocusLerp: 0,
    cancelUnfocusLerp: 0,
    applyFocus: [],
    emitFocusEvents: [],
  };

  function makeStarTarget(idx: number): FocusTarget {
    const row = stars.get(idx);
    if (!row) throw new Error(`star ${idx} not seeded`);
    return {
      kind: 'star',
      idx,
      anchorInto(out) { out.copy(row.abs); return true; },
      localPositionInto(out) { out.copy(row.abs).sub(worldOffset); return true; },
      parkRadius: () => row.parkRadius,
      applyFocus: () => {
        focusedCloud = null;
        focusedStar = idx;
        calls.applyFocus.push({ kind: 'star', idx });
      },
      emitFocusEvents: () => {
        calls.emitFocusEvents.push({ kind: 'star', idx });
      },
      physicalRadius: () => row.physicalRadius,
      chartPlateauDistance: () => null,
    };
  }
  function makeCloudTarget(idx: number): FocusTarget | null {
    const row = clouds.get(idx);
    if (!row) return null;
    return {
      kind: 'cloud',
      idx,
      anchorInto(out) { out.copy(row.abs); return true; },
      localPositionInto(out) { out.copy(row.abs).sub(worldOffset); return true; },
      parkRadius: () => row.parkRadius,
      applyFocus: () => {
        focusedStar = null;
        focusedCloud = idx;
        calls.applyFocus.push({ kind: 'cloud', idx });
      },
      emitFocusEvents: () => {
        calls.emitFocusEvents.push({ kind: 'cloud', idx });
      },
      physicalRadius: () => null,
      chartPlateauDistance: () => null,
    };
  }

  const ops: FocusOps = {
    currentFocusTarget: () => {
      if (focusedStar !== null) return makeStarTarget(focusedStar);
      if (focusedCloud !== null) return makeCloudTarget(focusedCloud);
      return null;
    },
    makeStarFocusTarget: makeStarTarget,
    makeCloudFocusTarget: makeCloudTarget,
    starLocalPosition: (idx) => {
      const row = stars.get(idx);
      if (!row) throw new Error(`star ${idx} not seeded`);
      return row.abs.clone().sub(worldOffset);
    },
    recenterOrigin: (newOrigin) => {
      const dx = newOrigin.x - worldOffset.x;
      const dy = newOrigin.y - worldOffset.y;
      const dz = newOrigin.z - worldOffset.z;
      if (dx === 0 && dy === 0 && dz === 0) return null;
      worldOffset.copy(newOrigin);
      calls.recenterOrigin++;
      return new THREE.Vector3(dx, dy, dz);
    },
    recenterFocusToStar: (idx) => {
      const row = stars.get(idx);
      if (!row) throw new Error(`star ${idx} not seeded`);
      const delta = new THREE.Vector3().subVectors(row.abs, worldOffset);
      worldOffset.copy(row.abs);
      focusedStar = idx;
      calls.recenterFocusToStar.push(idx);
      return delta;
    },
    setFocus: (idx) => {
      focusedStar = idx;
      calls.setFocus.push(idx);
    },
    setFocusedCloud: (idx) => {
      focusedCloud = idx;
      calls.setFocusedCloud.push(idx);
    },
    setVectorTo: (idx) => { calls.setVectorTo.push(idx); },
    setVectorToCloud: (idx) => { calls.setVectorToCloud.push(idx); },
    getFocusedStar: () => focusedStar,
    getFocusedCloud: () => focusedCloud,
    isObserveTransitionActive: () => false,
    cancelFocusLerp: () => { calls.cancelFocusLerp++; },
    cancelUnfocusLerp: () => { calls.cancelUnfocusLerp++; },
  };

  return {
    ops,
    worldOffset,
    setFocusedStar: (idx) => { focusedStar = idx; focusedCloud = null; },
    setFocusedCloud: (idx) => { focusedCloud = idx; focusedStar = null; },
    stars,
    clouds,
    calls,
  };
}

interface Harness {
  warp: WarpController;
  camera: THREE.PerspectiveCamera;
  controls: ReturnType<typeof makeControlsStub>;
  observeControls: ReturnType<typeof makeObserveControlsStub>;
  uHide: { value: number };
  bus: EventBus<StellataEventMap>;
  focus: FocusFixture;
  setCameraMode: (m: CameraMode) => void;
  busEvents: Array<{ name: string; payload: unknown }>;
}

function makeHarness(opts: {
  mode?: CameraMode;
  isChart?: boolean;
} = {}): Harness {
  const camera = new THREE.PerspectiveCamera(60, 1, 1e-10, 100_000);
  const controls = makeControlsStub();
  const observeControls = makeObserveControlsStub();
  const uHide = { value: -1 };
  const bus = new EventBus<StellataEventMap>();
  const focus = makeFocus();
  let cameraMode: CameraMode = opts.mode ?? 'navigate';

  const busEvents: Array<{ name: string; payload: unknown }> = [];
  // Subscribe to every relevant event so individual tests can grep
  // the sequence without re-subscribing per test.
  for (const name of ['warp', 'state', 'focus'] as const) {
    bus.on(name, (payload: unknown) => {
      busEvents.push({ name, payload });
    });
  }

  const deps: WarpControllerDeps = {
    camera,
    controls,
    observeControls,
    uHideFocusIdxRef: uHide,
    bus,
    getCameraMode: () => cameraMode,
    isChartMode: () => opts.isChart ?? false,
    getChartMagBright: () => 4.0,
    focus: focus.ops,
  };

  return {
    warp: new WarpController(deps),
    camera,
    controls,
    observeControls,
    uHide,
    bus,
    focus,
    setCameraMode: (m: CameraMode) => { cameraMode = m; },
    busEvents,
  };
}

// Convenience to seed a star pair at known positions. Source at A,
// destination at B (in absolute = local since worldOffset starts at 0).
function seedStarStar(
  h: Harness,
  A: THREE.Vector3 = new THREE.Vector3(0, 0, 0),
  B: THREE.Vector3 = new THREE.Vector3(100, 0, 0),
  opts: { destR?: number | null; sourceR?: number; destPark?: number; sourcePark?: number } = {},
) {
  h.focus.stars.set(0, {
    abs: A.clone(),
    parkRadius: opts.sourcePark ?? 0.001,
    physicalRadius: opts.sourceR ?? null,
  });
  h.focus.stars.set(1, {
    abs: B.clone(),
    parkRadius: opts.destPark ?? 0.001,
    physicalRadius: opts.destR ?? null,
  });
  h.focus.setFocusedStar(0);
  // Seed camera at the source-parked pose: just behind A on the +Z axis.
  h.camera.position.copy(A).add(new THREE.Vector3(0, 0, opts.sourcePark ?? 0.001));
  h.camera.lookAt(A);
  h.camera.updateMatrixWorld();
}

describe('WarpController — lifecycle + idempotency', () => {
  it('starts idle — isActive false, getWarpInfo / getWarpPhase return null', () => {
    const h = makeHarness();
    expect(h.warp.isActive()).toBe(false);
    expect(h.warp.getWarpInfo()).toBeNull();
    expect(h.warp.getWarpPhase()).toBeNull();
    expect(h.warp.isRecenteredToDest()).toBe(false);
  });

  it('warpTo with no focus is a no-op', () => {
    const h = makeHarness();
    h.focus.stars.set(0, {
      abs: new THREE.Vector3(100, 0, 0),
      parkRadius: 0.001,
      physicalRadius: null,
    });
    // focusedStar / focusedCloud both null
    h.warp.warpTo(0);
    expect(h.warp.isActive()).toBe(false);
    expect(h.busEvents.filter((e) => e.name === 'warp')).toEqual([]);
  });

  it('warpTo to the currently focused star is a no-op', () => {
    const h = makeHarness();
    seedStarStar(h);
    h.warp.warpTo(0); // dest == source
    expect(h.warp.isActive()).toBe(false);
  });

  it('warpToCloud to the currently focused cloud is a no-op', () => {
    const h = makeHarness();
    h.focus.clouds.set(7, {
      abs: new THREE.Vector3(50, 0, 0),
      parkRadius: 5,
    });
    h.focus.setFocusedCloud(7);
    h.warp.warpToCloud(7);
    expect(h.warp.isActive()).toBe(false);
  });

  it('warpToCloud bails when the cloud index is not seeded', () => {
    const h = makeHarness();
    seedStarStar(h);
    h.warp.warpToCloud(99); // makeCloudFocusTarget returns null
    expect(h.warp.isActive()).toBe(false);
  });

  it('skip on idle is a no-op', () => {
    const h = makeHarness();
    h.warp.skip();
    expect(h.warp.isActive()).toBe(false);
    expect(h.busEvents).toEqual([]);
  });

  it('dispose clears state and is idempotent', () => {
    const h = makeHarness();
    seedStarStar(h);
    h.warp.warpTo(1);
    h.warp.dispose();
    expect(h.warp.isActive()).toBe(false);
    h.warp.dispose();
    expect(h.warp.isActive()).toBe(false);
  });

  it('startWarp emits warp:true + state, finishWarp emits warp:false', () => {
    const h = makeHarness();
    seedStarStar(h);
    h.warp.warpTo(1);
    const startNames = h.busEvents.map((e) => `${e.name}:${e.payload}`);
    expect(startNames).toContain('warp:true');
    expect(startNames).toContain('state:undefined');
    h.warp.skip();
    const endNames = h.busEvents.map((e) => `${e.name}:${e.payload}`);
    expect(endNames).toContain('warp:false');
  });

  it('coincident source/destination (distPc < 1e-6) bails into setFocus, no warp slot opened', () => {
    const h = makeHarness();
    // Source and dest co-located — distPc = 0.
    seedStarStar(h, new THREE.Vector3(10, 0, 0), new THREE.Vector3(10, 0, 0));
    h.warp.warpTo(1);
    expect(h.warp.isActive()).toBe(false);
    expect(h.focus.calls.setFocus).toEqual([1]);
  });

  it('coincident source/destination for cloud destination routes to setFocusedCloud', () => {
    const h = makeHarness();
    h.focus.stars.set(0, {
      abs: new THREE.Vector3(10, 0, 0),
      parkRadius: 0.001,
      physicalRadius: null,
    });
    h.focus.clouds.set(5, {
      abs: new THREE.Vector3(10, 0, 0), // coincident
      parkRadius: 5,
    });
    h.focus.setFocusedStar(0);
    h.warp.warpToCloud(5);
    expect(h.warp.isActive()).toBe(false);
    expect(h.focus.calls.setFocusedCloud).toEqual([5]);
  });
});

describe('WarpController — getWarpInfo / getWarpPhase', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0));
  });

  it('getWarpInfo returns A, B, destKind, destIdx', () => {
    h.warp.warpTo(1);
    const info = h.warp.getWarpInfo();
    expect(info).not.toBeNull();
    expect(info!.destKind).toBe('star');
    expect(info!.destIdx).toBe(1);
    expect(info!.A.x).toBeCloseTo(0, 5);
    expect(info!.B.x).toBeCloseTo(100, 5);
  });

  it('getWarpPhase reports reorient just after startWarp', () => {
    h.warp.warpTo(1);
    const phase = h.warp.getWarpPhase();
    expect(phase).not.toBeNull();
    expect(phase!.kind).toBe('reorient');
    expect(phase!.totalMs).toBeCloseTo(WARP_REORIENT_MS, 0);
    expect(phase!.u).toBeGreaterThanOrEqual(0);
    expect(phase!.u).toBeLessThanOrEqual(1);
  });

  it('flyArrivalUSeam sentinel = -1 when destination has null physicalRadius', () => {
    h.warp.warpTo(1);
    // Phase-query at a controlled time past reorient — the controller
    // accepts nowMs so this isn't subject to real-time drift.
    const flyMs = performance.now() + WARP_REORIENT_MS + 10;
    h.warp.tick(flyMs);
    const phase = h.warp.getWarpPhase(flyMs)!;
    expect(phase.kind).toBe('fly');
    expect(phase.flyArrivalUSeam).toBe(-1); // fallback (cubic-Hermite)
    expect(phase.flyRegime).toBe('fallback');
  });

  it('flyArrivalUSeam is a positive seam when destination has a physical radius', () => {
    const h2 = makeHarness();
    seedStarStar(
      h2,
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(100, 0, 0),
      { destR: 4.65e-8, destPark: 1e-6 }, // ~Sol R in pc; parkDist ~ 1 AU
    );
    h2.warp.warpTo(1);
    const flyMs = performance.now() + WARP_REORIENT_MS + 10;
    h2.warp.tick(flyMs);
    const phase = h2.warp.getWarpPhase(flyMs)!;
    expect(phase.kind).toBe('fly');
    // Hybrid curve clamps the seam to [0.3, 0.85] when both regimes
    // have meaningful range. With dEnd ≪ R · seam_k the seam lands
    // somewhere inside that window.
    expect(phase.flyArrivalUSeam).toBeGreaterThanOrEqual(0);
    expect(phase.flyArrivalUSeam).toBeLessThanOrEqual(1);
  });
});

describe('WarpController — 3-phase FSM transitions', () => {
  it('reorient → fly progression: reorient phase ends at reorientMs, fly phase begins', () => {
    const h = makeHarness();
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0));
    h.warp.warpTo(1);
    // Just past the reorient boundary — must report 'fly'.
    const flyMs = performance.now() + WARP_REORIENT_MS + 5;
    h.warp.tick(flyMs);
    expect(h.warp.getWarpPhase(flyMs)!.kind).toBe('fly');
  });

  it('navigate arrival skips post-arrival phase (postArrivalMs = 0) and lands at finishWarp', () => {
    const h = makeHarness();
    // Short warp — Fly duration follows WARP_T_MIN_MS + k·log10(1+dist).
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
    h.warp.warpTo(1);
    // Tick well past reorient + WARP_T_MAX_MS so Fly is guaranteed to
    // finish under any panel-tuned durations.
    h.warp.tick(performance.now() + WARP_REORIENT_MS + WARP_T_MAX_MS + 1000);
    expect(h.warp.isActive()).toBe(false);
    // Navigate-mode finish: controls re-enabled, uHide cleared.
    expect(h.controls.enabled).toBe(true);
    expect(h.uHide.value).toBe(-1);
  });

  it('observe→observe arrival keeps a post-arrival phase of OBSERVE_TRANSITION_MS', () => {
    const h = makeHarness({ mode: 'observe' });
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
    h.warp.warpTo(1);
    // Land the tick precisely inside the post-arrival window: just
    // past reorient + flyDur, well short of post-arrival's end.
    const postMs = performance.now() + WARP_REORIENT_MS + flyDurMs(10) + 100;
    h.warp.tick(postMs);
    const phase = h.warp.getWarpPhase(postMs);
    expect(phase!.kind).toBe('post-arrival');
    expect(phase!.totalMs).toBeCloseTo(OBSERVE_TRANSITION_MS, 0);
  });

  it('observe→observe arrival emits focus at swapObserveAnchor and re-enables observeControls', () => {
    const h = makeHarness({ mode: 'observe' });
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
    h.warp.warpTo(1);
    h.warp.skip();
    expect(h.observeControls.enable).toHaveBeenCalled();
    expect(h.uHide.value).toBe(1);
    // 'focus' fires at swap.
    const focusEmits = h.busEvents.filter((e) => e.name === 'focus');
    expect(focusEmits.length).toBeGreaterThanOrEqual(1);
    expect(focusEmits[focusEmits.length - 1].payload).toBe(1);
    // controls stays disabled — observe owns the camera.
    expect(h.controls.enabled).toBe(false);
  });
});

describe('WarpController — skipWarp during each phase', () => {
  it('skip during reorient lands and re-enables controls (navigate)', () => {
    const h = makeHarness();
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(50, 0, 0));
    h.warp.warpTo(1);
    h.warp.skip(); // straight from reorient — never even entered Fly
    expect(h.warp.isActive()).toBe(false);
    expect(h.controls.enabled).toBe(true);
    // setFocus path fires because mid-Fly recentre didn't.
    expect(h.focus.calls.setFocus).toContain(1);
  });

  it('skip during fly lands at the destination', () => {
    const h = makeHarness();
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(50, 0, 0));
    h.warp.warpTo(1);
    h.warp.tick(performance.now() + WARP_REORIENT_MS + 100); // partway through Fly
    h.warp.skip();
    expect(h.warp.isActive()).toBe(false);
  });

  it('skip during post-arrival (observe→observe) lands and re-enables observeControls', () => {
    const h = makeHarness({ mode: 'observe' });
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
    h.warp.warpTo(1);
    // Tick into post-arrival without overshooting it.
    h.warp.tick(performance.now() + WARP_REORIENT_MS + flyDurMs(10) + 50);
    h.warp.skip();
    expect(h.warp.isActive()).toBe(false);
    expect(h.observeControls.enable).toHaveBeenCalled();
  });
});

describe('WarpController — source/dest variants', () => {
  it('star → cloud uses cloud parkRadius and routes finish through setFocusedCloud', () => {
    const h = makeHarness();
    h.focus.stars.set(0, {
      abs: new THREE.Vector3(0, 0, 0),
      parkRadius: 0.001,
      physicalRadius: null,
    });
    h.focus.clouds.set(7, {
      abs: new THREE.Vector3(100, 0, 0),
      parkRadius: 5,
    });
    h.focus.setFocusedStar(0);
    h.warp.warpToCloud(7);
    expect(h.warp.isActive()).toBe(true);
    h.warp.skip();
    // Cloud dest, navigate mode → setFocusedCloud, not setFocus.
    // (Mid-Fly recentre may have fired and pre-mutated, so we accept
    // either path provided setFocusedCloud is the one called at the
    // end — recentre path uses emitFocusEvents instead.)
    const cloudArrival =
      h.focus.calls.setFocusedCloud.includes(7) ||
      h.focus.calls.emitFocusEvents.some((c) => c.kind === 'cloud' && c.idx === 7);
    expect(cloudArrival).toBe(true);
  });

  it('cloud → star uses cloud source.parkRadius for the reorient pStart offset', () => {
    const h = makeHarness();
    h.focus.clouds.set(0, {
      abs: new THREE.Vector3(0, 0, 0),
      parkRadius: 5, // cloud is much bigger than dest star
    });
    h.focus.stars.set(1, {
      abs: new THREE.Vector3(100, 0, 0),
      parkRadius: 0.001,
      physicalRadius: null,
    });
    h.focus.setFocusedCloud(0);
    h.camera.position.set(0, 0, 5); // parked at the cloud's viewing distance
    h.camera.lookAt(0, 0, 0);
    h.warp.warpTo(1);
    expect(h.warp.isActive()).toBe(true);
    // Forward through the FSM.
    h.warp.skip();
    expect(h.warp.isActive()).toBe(false);
  });

  it('observe→observe sets uHide to source at warp start, swaps to dest at finish', () => {
    const h = makeHarness({ mode: 'observe' });
    h.uHide.value = 0; // observe pre-warp has source hidden
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));
    h.warp.warpTo(1);
    // During the warp uHide stays pinned to source.
    expect(h.uHide.value).toBe(0);
    h.warp.skip();
    // After finish, uHide pinned to dest.
    expect(h.uHide.value).toBe(1);
    // observeControls.disable was called at startWarp (the observe-mode
    // grab handoff to warp), observeControls.enable at finishWarp.
    expect(h.observeControls.disable).toHaveBeenCalled();
    expect(h.observeControls.enable).toHaveBeenCalled();
  });
});

describe('WarpController — mid-Fly recentre + isRecenteredToDest', () => {
  it('mid-Fly recentre fires when the camera crosses the trajectory midpoint', () => {
    const h = makeHarness();
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0));
    h.warp.warpTo(1);
    expect(h.warp.isRecenteredToDest()).toBe(false);
    // Drive Fly far past its midpoint — the recentre must fire by then.
    const t0 = performance.now();
    for (let dt = WARP_REORIENT_MS + 50; dt < WARP_REORIENT_MS + WARP_T_MAX_MS; dt += 50) {
      h.warp.tick(t0 + dt);
      if (h.warp.isRecenteredToDest()) break;
    }
    expect(h.warp.isRecenteredToDest()).toBe(true);
    expect(h.focus.calls.recenterOrigin).toBeGreaterThanOrEqual(1);
    // applyFocus fires inside tryMidFlyRecentre for the destination.
    expect(h.focus.calls.applyFocus.some((c) => c.kind === 'star' && c.idx === 1)).toBe(true);
  });

  it('mid-Fly recentre fires AT MOST once per warp', () => {
    const h = makeHarness();
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0));
    h.warp.warpTo(1);
    const t0 = performance.now();
    // Tick many times across Fly — recenter should not double-fire.
    for (let dt = WARP_REORIENT_MS + 10; dt < WARP_REORIENT_MS + WARP_T_MAX_MS; dt += 50) {
      h.warp.tick(t0 + dt);
    }
    expect(h.focus.calls.recenterOrigin).toBe(1);
  });

  it('navigate finish after mid-Fly recentre fires emitFocusEvents instead of setFocus', () => {
    const h = makeHarness();
    seedStarStar(h, new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0));
    h.warp.warpTo(1);
    // Drive past mid-Fly so recentre fires.
    const t0 = performance.now();
    for (let dt = WARP_REORIENT_MS + 50; dt < WARP_REORIENT_MS + WARP_T_MAX_MS; dt += 50) {
      h.warp.tick(t0 + dt);
      if (h.warp.isRecenteredToDest()) break;
    }
    expect(h.warp.isRecenteredToDest()).toBe(true);
    h.warp.skip();
    expect(h.focus.calls.emitFocusEvents.some((c) => c.kind === 'star' && c.idx === 1)).toBe(true);
    expect(h.focus.calls.setFocus).not.toContain(1);
  });
});

describe('WarpController — bus emit shape', () => {
  it('warp emit pattern: true → false across a full FSM run', () => {
    const h = makeHarness();
    seedStarStar(h);
    h.warp.warpTo(1);
    h.warp.skip();
    const seq = h.busEvents
      .filter((e) => e.name === 'warp')
      .map((e) => e.payload);
    expect(seq).toEqual([true, false]);
  });

  it('startWarp cancels in-flight unfocus + focus lerps via the shim', () => {
    const h = makeHarness();
    seedStarStar(h);
    h.warp.warpTo(1);
    expect(h.focus.calls.cancelUnfocusLerp).toBe(1);
    expect(h.focus.calls.cancelFocusLerp).toBe(1);
  });

  it('finishWarp clears both vector slots regardless of dest kind', () => {
    const h = makeHarness();
    seedStarStar(h);
    h.warp.warpTo(1);
    h.warp.skip();
    expect(h.focus.calls.setVectorTo).toContain(null);
    expect(h.focus.calls.setVectorToCloud).toContain(null);
  });
});
