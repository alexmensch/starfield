import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { type ArrivalState, newArrival, shiftArrivalWaypoints, tickArrival } from './camera-motion';
import { AU_PC } from './astronomy-constants';

// Co-linear arrival builder. pStart at d0 along +X, pEnd at dEnd along +X,
// target at the origin — so the camera's x coordinate IS its distance from
// the target throughout the lerp. The log-distance profile is therefore
// closed-form in cam.position.x.
function makeCoLinear(d0: number, dEnd: number, durationMs = 1000): ArrivalState {
  return newArrival({
    pStart: new THREE.Vector3(d0, 0, 0),
    pEnd: new THREE.Vector3(dEnd, 0, 0),
    target: { center: new THREE.Vector3(0, 0, 0), parkDist: dEnd },
    startMs: 0,
    durationMs,
  });
}

function makeCamera(): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(50, 1, 1e-7, 1000);
}

// Reference implementation of d(u) — the cubic-Hermite log-distance profile
// from docs/camera-arrival.md § Profile. The helper runs the same Math.pow
// in the same order, so `toBe` (bit-exact) holds.
function expectedD(d0: number, dEnd: number, u: number): number {
  const f = u * u * (3 - 2 * u);
  return d0 * Math.pow(dEnd / d0, f);
}

describe('camera-motion newArrival', () => {
  it('caches d0, dEnd, and dir at construction', () => {
    const s = makeCoLinear(5, 1);
    expect(s.d0).toBe(5);
    expect(s.dEnd).toBe(1);
    expect(s.dir.x).toBe(1);
    expect(s.dir.y).toBe(0);
    expect(s.dir.z).toBe(0);
  });

  it('clones inputs so caller scratch vectors do not bleed into state', () => {
    const pStart = new THREE.Vector3(5, 0, 0);
    const pEnd = new THREE.Vector3(1, 0, 0);
    const center = new THREE.Vector3(0, 0, 0);
    const qStart = new THREE.Quaternion();
    const qEnd = new THREE.Quaternion(0, 0, 0, 1);
    const s = newArrival({
      pStart, pEnd, qStart, qEnd,
      target: { center, parkDist: 1 },
      startMs: 0, durationMs: 1000,
    });
    pStart.set(99, 99, 99);
    pEnd.set(99, 99, 99);
    center.set(99, 99, 99);
    qStart.set(0.5, 0.5, 0.5, 0.5);
    expect(s.pStart.equals(new THREE.Vector3(5, 0, 0))).toBe(true);
    expect(s.pEnd.equals(new THREE.Vector3(1, 0, 0))).toBe(true);
    expect(s.target.center.equals(new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(s.qStart!.x).toBe(0);
    // The cached dir is computed from the cloned pStart, not the caller's
    // reference — mutating pStart afterwards must not perturb it.
    expect(s.dir.x).toBe(1);
    expect(s.dir.y).toBe(0);
    expect(s.dir.z).toBe(0);
  });

  it('caches a zero dir when pStart coincides with target.center', () => {
    // Pathological case for the three helper sites (camera at the target
    // origin). tickArrival writes camera to target.center, so the lerp
    // settles there instead of producing NaN from a zero-length normalize.
    const s = newArrival({
      pStart: new THREE.Vector3(0, 0, 0),
      pEnd: new THREE.Vector3(1, 0, 0),
      target: { center: new THREE.Vector3(0, 0, 0), parkDist: 1 },
      startMs: 0, durationMs: 1000,
    });
    expect(s.d0).toBe(0);
    expect(s.dir.x).toBe(0);
    expect(s.dir.y).toBe(0);
    expect(s.dir.z).toBe(0);
  });
});

describe('camera-motion tickArrival — curve pin (cubic-Hermite log-distance)', () => {
  // d0 = 5, dEnd = 1 along +X. d(u) = 5 · (1/5)^(3u² − 2u³).
  //
  // f(u) at quartiles:    {0, 0.15625, 0.5, 0.84375, 1}
  // d(u) at quartiles:    {5,         0.2^0.15625 · 5,  √5,  0.2^0.84375 · 5,  1}
  //
  // Pinned bit-exact via toBe so any drift in the formula or the helper
  // (e.g. accidental f → u swap, lost short-circuit, wrong direction)
  // fails the suite. Per stellata-test-coverage-discipline.
  it.each([
    { u: 0,    nowMs: 0    },
    { u: 0.25, nowMs: 250  },
    { u: 0.5,  nowMs: 500  },
    { u: 0.75, nowMs: 750  },
    { u: 1,    nowMs: 1000 },
  ])('u=$u → d(u) along +X matches the formula bit-exact', ({ u, nowMs }) => {
    const s = makeCoLinear(5, 1);
    const cam = makeCamera();
    const { done } = tickArrival(s, nowMs, cam);
    expect(cam.position.x).toBe(expectedD(5, 1, u));
    expect(cam.position.y).toBe(0);
    expect(cam.position.z).toBe(0);
    expect(done).toBe(u >= 1);
  });

  it('lands at the geometric mean √(d0·dEnd) at u=0.5', () => {
    const s = makeCoLinear(5, 1);
    const cam = makeCamera();
    tickArrival(s, 500, cam);
    expect(cam.position.x).toBe(Math.sqrt(5));
  });
});

describe('camera-motion tickArrival — worked examples (docs/camera-arrival.md)', () => {
  // Sol from 1 pc. parkDist ≈ AU_PC per the doc's worked example. Doc
  // table at u ∈ {0, 0.25, 0.5, 0.75, 1} shows d (pc) ≈
  //   {1.0, 0.148, 2.20·10⁻³, 3.28·10⁻⁵, AU_PC}.
  // The toBe pin locks the helper to the formula; the toBeCloseTo cross-
  // check locks the doc's rounded values to the helper. If either drifts,
  // the suite fails.
  it.each([
    { u: 0,    nowMs: 0,    docD: 1.0,     docPrecision: 12 },
    { u: 0.25, nowMs: 250,  docD: 0.148,   docPrecision: 3  },
    { u: 0.5,  nowMs: 500,  docD: 2.20e-3, docPrecision: 5  },
    { u: 0.75, nowMs: 750,  docD: 3.28e-5, docPrecision: 7  },
    { u: 1,    nowMs: 1000, docD: AU_PC,   docPrecision: 12 },
  ])('Sol from 1 pc — u=$u → d ≈ $docD pc', ({ u, nowMs, docD, docPrecision }) => {
    const s = makeCoLinear(1, AU_PC);
    const cam = makeCamera();
    tickArrival(s, nowMs, cam);
    expect(cam.position.x).toBe(expectedD(1, AU_PC, u));
    expect(cam.position.x).toBeCloseTo(docD, docPrecision);
  });

  // Betelgeuse from 200 pc. parkDist ≈ 7 AU per the doc's worked example
  // (4.65 AU body + 90 %-fill floor). Doc table at u ∈ {0, 0.25, 0.5,
  // 0.75, 1} shows d (pc) ≈
  //   {200, 17.5, 8.24·10⁻², 3.88·10⁻⁴, 7·AU_PC}.
  it.each([
    { u: 0,    nowMs: 0,    docD: 200,       docPrecision: 10 },
    { u: 0.25, nowMs: 250,  docD: 17.5,      docPrecision: 1  },
    { u: 0.5,  nowMs: 500,  docD: 8.24e-2,   docPrecision: 4  },
    { u: 0.75, nowMs: 750,  docD: 3.88e-4,   docPrecision: 6  },
    { u: 1,    nowMs: 1000, docD: 7 * AU_PC, docPrecision: 12 },
  ])('Betelgeuse from 200 pc — u=$u → d ≈ $docD pc', ({ u, nowMs, docD, docPrecision }) => {
    const s = makeCoLinear(200, 7 * AU_PC);
    const cam = makeCamera();
    tickArrival(s, nowMs, cam);
    expect(cam.position.x).toBe(expectedD(200, 7 * AU_PC, u));
    expect(cam.position.x).toBeCloseTo(docD, docPrecision);
  });
});

describe('camera-motion tickArrival — monotonicity', () => {
  it('inbound (d0 > dEnd): distance strictly decreases across the lerp', () => {
    const s = makeCoLinear(100, 1);
    const cam = makeCamera();
    let prev = Infinity;
    for (let i = 0; i <= 20; i++) {
      tickArrival(s, i * 50, cam);
      const d = cam.position.x;
      if (i > 0) expect(d).toBeLessThan(prev);
      prev = d;
    }
  });

  it('outbound (d0 < dEnd): distance strictly increases across the lerp', () => {
    const s = makeCoLinear(1, 100);
    const cam = makeCamera();
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      tickArrival(s, i * 50, cam);
      const d = cam.position.x;
      if (i > 0) expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });
});

describe('camera-motion tickArrival — endpoints and done', () => {
  it('lands exactly on pStart at u=0', () => {
    const s = makeCoLinear(5, 1);
    const cam = makeCamera();
    tickArrival(s, 0, cam);
    expect(cam.position.equals(s.pStart)).toBe(true);
  });

  it('lands exactly on pEnd at u=1', () => {
    const s = makeCoLinear(5, 1);
    const cam = makeCamera();
    tickArrival(s, 1000, cam);
    expect(cam.position.equals(s.pEnd)).toBe(true);
  });

  it('clamps past the endpoint when nowMs overshoots durationMs', () => {
    const s = makeCoLinear(5, 1);
    const cam = makeCamera();
    const { done } = tickArrival(s, 999_999, cam);
    expect(done).toBe(true);
    expect(cam.position.equals(s.pEnd)).toBe(true);
  });

  it('clamps to pStart when nowMs is below startMs', () => {
    const s = makeCoLinear(5, 1);
    const cam = makeCamera();
    const { done } = tickArrival(s, -100, cam);
    expect(done).toBe(false);
    expect(cam.position.equals(s.pStart)).toBe(true);
  });

  it('done is false at nowMs just under durationMs and true at exactly durationMs', () => {
    const s = makeCoLinear(5, 1);
    const cam = makeCamera();
    expect(tickArrival(s, 999, cam).done).toBe(false);
    expect(tickArrival(s, 1000, cam).done).toBe(true);
  });
});

describe('camera-motion tickArrival — zero velocity at endpoints', () => {
  // Cubic-Hermite has f'(0) = f'(1) = 0, so dd/du → 0 at both endpoints.
  // Verify by sampling the numerical derivative near each endpoint and
  // checking it's at least an order of magnitude smaller than the slope
  // at u = 0.5 (where f'(0.5) = 1.5 — the curve's peak rate).
  function numericalSlope(s: ArrivalState, u: number, eps: number, cam: THREE.PerspectiveCamera): number {
    const ms = (u + eps) * s.durationMs;
    tickArrival(s, ms - eps * s.durationMs, cam);
    const d_lo = cam.position.x;
    tickArrival(s, ms, cam);
    const d_hi = cam.position.x;
    return Math.abs((d_hi - d_lo) / eps);
  }

  it('numerical |dd/du| at u→0 is ≪ |dd/du| at u=0.5', () => {
    const s = makeCoLinear(100, 1);
    const cam = makeCamera();
    const slopeStart = numericalSlope(s, 0, 0.001, cam);
    const slopeMid = numericalSlope(s, 0.5, 0.001, cam);
    expect(slopeStart).toBeLessThan(slopeMid / 10);
  });

  it('numerical |dd/du| at u→1 is ≪ |dd/du| at u=0.5', () => {
    const s = makeCoLinear(100, 1);
    const cam = makeCamera();
    const slopeEnd = numericalSlope(s, 0.999, 0.001, cam);
    const slopeMid = numericalSlope(s, 0.5, 0.001, cam);
    expect(slopeEnd).toBeLessThan(slopeMid / 10);
  });
});

describe('camera-motion tickArrival — degenerate d0 == dEnd', () => {
  it('keeps the camera at d0 throughout (log ratio = 0, graceful no-op)', () => {
    const s = makeCoLinear(5, 5);
    const cam = makeCamera();
    for (const nowMs of [0, 250, 500, 750, 1000]) {
      tickArrival(s, nowMs, cam);
      expect(cam.position.x).toBe(5);
      expect(cam.position.y).toBe(0);
      expect(cam.position.z).toBe(0);
    }
  });
});

describe('camera-motion tickArrival — outbound mirror (unfocus)', () => {
  it('carries the camera from inside parkDist outward via the same formula', () => {
    // d0 = 0.5, dEnd = 1. At u=0.5: d = √(0.5·1) = √0.5 ≈ 0.707.
    const s = makeCoLinear(0.5, 1);
    const cam = makeCamera();
    tickArrival(s, 500, cam);
    expect(cam.position.x).toBe(Math.sqrt(0.5));
  });

  it('lands exactly at pEnd at u=1 even when outbound', () => {
    const s = makeCoLinear(0.5, 1);
    const cam = makeCamera();
    tickArrival(s, 1000, cam);
    expect(cam.position.equals(s.pEnd)).toBe(true);
  });
});

describe('camera-motion tickArrival — quaternion track', () => {
  it('slerps the camera quaternion when both qStart and qEnd are provided', () => {
    // 180° rotation about +Y so f=0.5 lands halfway (90° about +Y).
    const qStart = new THREE.Quaternion();
    const qEnd = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI,
    );
    const s = newArrival({
      pStart: new THREE.Vector3(5, 0, 0),
      pEnd: new THREE.Vector3(1, 0, 0),
      qStart, qEnd,
      target: { center: new THREE.Vector3(0, 0, 0), parkDist: 1 },
      startMs: 0, durationMs: 1000,
    });
    const cam = makeCamera();
    // u = 0.5 → f = 0.5 → 90° about +Y.
    tickArrival(s, 500, cam);
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    expect(cam.quaternion.x).toBeCloseTo(expected.x, 12);
    expect(cam.quaternion.y).toBeCloseTo(expected.y, 12);
    expect(cam.quaternion.z).toBeCloseTo(expected.z, 12);
    expect(cam.quaternion.w).toBeCloseTo(expected.w, 12);
  });

  it('leaves the camera quaternion alone when qStart/qEnd are omitted', () => {
    const s = makeCoLinear(5, 1);
    const cam = makeCamera();
    cam.quaternion.set(0.1, 0.2, 0.3, 0.92736);
    const before = cam.quaternion.clone();
    tickArrival(s, 500, cam);
    expect(cam.quaternion.x).toBe(before.x);
    expect(cam.quaternion.y).toBe(before.y);
    expect(cam.quaternion.z).toBe(before.z);
    expect(cam.quaternion.w).toBe(before.w);
  });
});

describe('camera-motion shiftArrivalWaypoints', () => {
  // Floating-origin frame change mid-arrival: all cached positions
  // shift by the same delta. d0/dEnd/dir are translation-invariant
  // (derived from differences), so the tick math is unchanged after
  // the shift.
  it('translates pStart, pEnd, and target.center in place', () => {
    const s = makeCoLinear(200, 5e-6);
    shiftArrivalWaypoints(s, 1, 2, 3);
    expect(s.pStart.x).toBe(199);
    expect(s.pStart.y).toBe(-2);
    expect(s.pStart.z).toBe(-3);
    expect(s.pEnd.x).toBe(5e-6 - 1);
    expect(s.pEnd.y).toBe(-2);
    expect(s.pEnd.z).toBe(-3);
    expect(s.target.center.x).toBe(-1);
    expect(s.target.center.y).toBe(-2);
    expect(s.target.center.z).toBe(-3);
  });

  it('leaves d0, dEnd, and dir untouched (translation-invariant)', () => {
    const s = makeCoLinear(200, 5e-6);
    const d0Before = s.d0;
    const dEndBefore = s.dEnd;
    const dirBefore = s.dir.clone();
    shiftArrivalWaypoints(s, 1e9, -1e9, 42);
    expect(s.d0).toBe(d0Before);
    expect(s.dEnd).toBe(dEndBefore);
    expect(s.dir.x).toBe(dirBefore.x);
    expect(s.dir.y).toBe(dirBefore.y);
    expect(s.dir.z).toBe(dirBefore.z);
  });

  it('preserves the per-tick camera trajectory across a frame change', () => {
    // Tick once in the original frame, record camera position; reset,
    // shift the state, re-tick at the same nowMs in the shifted frame,
    // and confirm the camera position has shifted by exactly the same
    // delta. The post-recentre Fly continues on the same physical path.
    const s = makeCoLinear(200, 5e-6);
    const cam = makeCamera();
    tickArrival(s, 500, cam);
    const before = cam.position.clone();

    const sShifted = makeCoLinear(200, 5e-6);
    shiftArrivalWaypoints(sShifted, 1, 2, 3);
    const camShifted = makeCamera();
    tickArrival(sShifted, 500, camShifted);
    expect(camShifted.position.x).toBe(before.x - 1);
    expect(camShifted.position.y).toBe(before.y - 2);
    expect(camShifted.position.z).toBe(before.z - 3);
  });
});
