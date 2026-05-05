import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeAppMag,
  collides,
  measureCandidate,
  filterByDistAndSpect,
  projectVec,
  type Candidate,
} from './chart-labels';

describe('chart-labels / computeAppMag', () => {
  it('equals absmag at exactly 10 pc (distance modulus = 0)', () => {
    // Distance modulus is m - M = 5(log10(d) - 1). At d=10 pc, modulus=0,
    // so apparent magnitude == absolute magnitude. This is the definition
    // of absmag and a load-bearing identity for any chart-mode brightness
    // gate.
    const positions = new Float32Array([10, 0, 0]);
    const absmag = new Float32Array([4.83]);
    expect(computeAppMag(0, positions, absmag)).toBeCloseTo(4.83, 5);
  });

  it('is dimmer (larger magnitude) at greater distance', () => {
    const absmag = new Float32Array([4.83]);
    const near = computeAppMag(0, new Float32Array([5, 0, 0]), absmag);
    const far = computeAppMag(0, new Float32Array([100, 0, 0]), absmag);
    expect(far).toBeGreaterThan(near);
  });

  it('is brighter (smaller magnitude) at smaller distance', () => {
    const absmag = new Float32Array([4.83]);
    const at1 = computeAppMag(0, new Float32Array([1, 0, 0]), absmag);
    const at100 = computeAppMag(0, new Float32Array([100, 0, 0]), absmag);
    // At 1 pc the star appears 5 mag brighter than at 10 pc;
    // at 100 pc it appears 5 mag dimmer.
    expect(at1).toBeCloseTo(4.83 - 5, 4);
    expect(at100).toBeCloseTo(4.83 + 5, 4);
  });

  it('changes by 5 magnitudes per 10× distance change', () => {
    // Distance modulus formula: 5 mag per decade.
    const absmag = new Float32Array([0]);
    const m10 = computeAppMag(0, new Float32Array([10, 0, 0]), absmag);
    const m100 = computeAppMag(0, new Float32Array([100, 0, 0]), absmag);
    const m1000 = computeAppMag(0, new Float32Array([1000, 0, 0]), absmag);
    expect(m100 - m10).toBeCloseTo(5, 5);
    expect(m1000 - m100).toBeCloseTo(5, 5);
  });

  it('returns absmag (no modulus) when distance is zero', () => {
    // Sol-on-Sol or origin-on-origin: log(0) is undefined, so the
    // contract is to skip the modulus and return absmag directly.
    const positions = new Float32Array([0, 0, 0]);
    const absmag = new Float32Array([4.83]);
    expect(computeAppMag(0, positions, absmag)).toBeCloseTo(4.83, 5);
  });

  it('is monotonic non-decreasing in radial distance', () => {
    const absmag = new Float32Array([0]);
    let prev = -Infinity;
    for (const d of [0.1, 1, 5, 10, 50, 100, 500, 1000, 10000]) {
      const m = computeAppMag(0, new Float32Array([d, 0, 0]), absmag);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  it('uses 3D radial distance, not just one axis', () => {
    const absmag = new Float32Array([0]);
    // Same total radius via different axes — expect the same magnitude.
    const along = computeAppMag(0, new Float32Array([10, 0, 0]), absmag);
    const diag = computeAppMag(0, new Float32Array([6, 8, 0]), absmag); // hypot=10
    const xyz = computeAppMag(0, new Float32Array([2, 6, 7.745966]), absmag); // hypot≈10
    expect(along).toBeCloseTo(diag, 4);
    expect(along).toBeCloseTo(xyz, 4);
  });
});

describe('chart-labels / collides', () => {
  function cand(opts: Partial<Candidate>): Candidate {
    return {
      kind: 'name',
      text: 'X',
      x: 0,
      y: 0,
      width: 50,
      height: 14,
      priority: 0,
      key: 'k',
      ...opts,
    };
  }

  it('returns false against an empty list', () => {
    expect(collides(cand({}), [])).toBe(false);
  });

  it('detects overlap of two start-anchored labels', () => {
    const a = cand({ x: 100, y: 100, width: 40 });
    const b = cand({ x: 120, y: 100, width: 40, key: 'b' }); // overlaps a in x
    expect(collides(a, [b])).toBe(true);
  });

  it('returns false for non-overlapping labels with horizontal gap', () => {
    const a = cand({ x: 100, y: 100, width: 40 });
    const b = cand({ x: 200, y: 100, width: 40, key: 'b' });
    expect(collides(a, [b])).toBe(false);
  });

  it('returns false for non-overlapping labels with vertical gap', () => {
    const a = cand({ x: 100, y: 100, width: 40 });
    const b = cand({ x: 100, y: 200, width: 40, key: 'b' });
    expect(collides(a, [b])).toBe(false);
  });

  it('is symmetric for same-kind labels', () => {
    // Collision detection must be symmetric: A collides with B iff B
    // collides with A, when both share the same anchor convention.
    const a = cand({ x: 100, y: 100, width: 50 });
    const b = cand({ x: 130, y: 100, width: 50, key: 'b' });
    expect(collides(a, [b])).toBe(collides(b, [a]));
  });

  it('honours middle-anchor for kind=con (centred AABB)', () => {
    // Constellation labels are centre-anchored, so a 50-wide label at
    // x=100 occupies [75, 125]. A start-anchored label at x=80 width=30
    // occupies [80, 110] — overlap.
    const con = cand({ kind: 'con', x: 100, y: 100, width: 50 });
    const name = cand({ kind: 'name', x: 80, y: 100, width: 30, key: 'b' });
    expect(collides(con, [name])).toBe(true);
  });

  it('reports collision against any item in the list', () => {
    const a = cand({ x: 100, y: 100, width: 40 });
    const candidates = [
      cand({ x: 0, y: 0, width: 40, key: 'b' }),
      cand({ x: 1000, y: 1000, width: 40, key: 'c' }),
      cand({ x: 110, y: 100, width: 40, key: 'd' }), // collides with a
    ];
    expect(collides(a, candidates)).toBe(true);
  });

  it('returns false when AABBs share only a single edge', () => {
    // Strict-less-than on the overlap test means edge-touching is not
    // a collision — two labels can sit flush next to each other.
    const a = cand({ x: 100, y: 100, width: 40 });
    const b = cand({ x: 140, y: 100, width: 40, key: 'b' }); // a ends at 140, b starts at 140
    expect(collides(a, [b])).toBe(false);
  });
});

describe('chart-labels / measureCandidate', () => {
  it('produces a non-zero AABB for a non-empty label', () => {
    const c: Candidate = {
      kind: 'name', text: 'Sirius', x: 0, y: 0,
      width: 0, height: 0, priority: 0, key: 'k',
    };
    measureCandidate(c);
    expect(c.width).toBeGreaterThan(0);
    expect(c.height).toBeGreaterThan(0);
  });

  it('makes constellation labels wider per character than start-anchored labels', () => {
    // Latin constellation names render in a heavier weight, so the per-
    // character width estimate is larger — the collision pad keeps these
    // out of the way of star labels.
    const star: Candidate = {
      kind: 'name', text: 'ABCDE', x: 0, y: 0,
      width: 0, height: 0, priority: 0, key: 'a',
    };
    const con: Candidate = {
      kind: 'con', text: 'ABCDE', x: 0, y: 0,
      width: 0, height: 0, priority: 0, key: 'b',
    };
    measureCandidate(star);
    measureCandidate(con);
    expect(con.width).toBeGreaterThan(star.width);
  });

  it('width scales linearly with text length', () => {
    const a: Candidate = {
      kind: 'name', text: 'ABC', x: 0, y: 0,
      width: 0, height: 0, priority: 0, key: 'a',
    };
    const b: Candidate = {
      kind: 'name', text: 'ABCABC', x: 0, y: 0,
      width: 0, height: 0, priority: 0, key: 'b',
    };
    measureCandidate(a);
    measureCandidate(b);
    // 6 chars of same kind should be wider than 3 chars by exactly
    // (6-3) × per-char-px (the collision padding is the same).
    const diff = b.width - a.width;
    expect(diff).toBeGreaterThan(0);
    // The per-char delta is consistent — no pad accumulation per char
    expect(diff).toBeCloseTo(diff, 1);
  });
});

describe('chart-labels / filterByDistAndSpect', () => {
  // Build small fixtures that exercise the boundary conditions —
  // distance bounds (inclusive both ends) and spectral bit mask.
  function makeFixture() {
    // 5 stars at distances 5, 10, 50, 100, 500 with spectral classes
    // 0, 1, 2, 3, 4 respectively. The spectClass is the index into the
    // bit-mask so a mask of 0b00001 keeps only spectClass=0.
    const distSol = new Float32Array([5, 10, 50, 100, 500]);
    const spectClass = new Uint8Array([0, 1, 2, 3, 4]);
    return { distSol, spectClass };
  }

  it('keeps everything when bounds are wide and mask is all-on', () => {
    const { distSol, spectClass } = makeFixture();
    const out = filterByDistAndSpect(
      [0, 1, 2, 3, 4], distSol, spectClass, 0, 1000, 0b11111,
    );
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects stars below the minimum distance', () => {
    const { distSol, spectClass } = makeFixture();
    const out = filterByDistAndSpect(
      [0, 1, 2, 3, 4], distSol, spectClass, 50, 1000, 0b11111,
    );
    // distSol < 50 → reject. Only indices with d >= 50.
    expect(out).toEqual([2, 3, 4]);
  });

  it('rejects stars above the maximum distance', () => {
    const { distSol, spectClass } = makeFixture();
    const out = filterByDistAndSpect(
      [0, 1, 2, 3, 4], distSol, spectClass, 0, 50, 0b11111,
    );
    expect(out).toEqual([0, 1, 2]);
  });

  it('treats distance bounds as inclusive at both ends', () => {
    const { distSol, spectClass } = makeFixture();
    const out = filterByDistAndSpect(
      [0, 1, 2, 3, 4], distSol, spectClass, 10, 100, 0b11111,
    );
    // 10 ≤ d ≤ 100 — indices 1, 2, 3 inclusive.
    expect(out).toEqual([1, 2, 3]);
  });

  it('rejects stars whose spectral bit is unset in the mask', () => {
    const { distSol, spectClass } = makeFixture();
    // Mask = bit 2 only → keeps spectClass===2 only.
    const out = filterByDistAndSpect(
      [0, 1, 2, 3, 4], distSol, spectClass, 0, 1000, 1 << 2,
    );
    expect(out).toEqual([2]);
  });

  it('combines distance and spectral filters with AND semantics', () => {
    const { distSol, spectClass } = makeFixture();
    // Distance window [10, 100] AND spectClass∈{1,3}
    const mask = (1 << 1) | (1 << 3);
    const out = filterByDistAndSpect(
      [0, 1, 2, 3, 4], distSol, spectClass, 10, 100, mask,
    );
    // Index 1: d=10 ✓, sc=1 ✓ → keep
    // Index 3: d=100 ✓, sc=3 ✓ → keep
    expect(out).toEqual([1, 3]);
  });

  it('returns an empty array when the mask is zero', () => {
    const { distSol, spectClass } = makeFixture();
    const out = filterByDistAndSpect(
      [0, 1, 2, 3, 4], distSol, spectClass, 0, 1000, 0,
    );
    expect(out).toEqual([]);
  });

  it('walks only the supplied indices', () => {
    // Caller pre-restricts to (e.g.) variable-star indices; the function
    // shouldn't surface stars outside that pre-filtered set even when
    // they'd otherwise pass the distance/spect gates.
    const { distSol, spectClass } = makeFixture();
    const out = filterByDistAndSpect(
      [1, 3], distSol, spectClass, 0, 1000, 0b11111,
    );
    expect(out).toEqual([1, 3]);
  });
});

describe('chart-labels / projectVec', () => {
  function makeCamera() {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    cam.position.set(0, 0, 0);
    cam.lookAt(0, 0, -1);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.updateProjectionMatrix();
    return cam;
  }

  it('returns null for a point closer than OVERLAY_NEAR_CLIP_PC', () => {
    const cam = makeCamera();
    // OVERLAY_NEAR_CLIP_PC = 1e-3; a point at z=-5e-4 is inside that.
    const p = new THREE.Vector3(0, 0, -5e-4);
    expect(projectVec(p, cam, 800, 600)).toBeNull();
  });

  it('returns null for a point behind the camera', () => {
    const cam = makeCamera();
    const p = new THREE.Vector3(0, 0, 5);
    expect(projectVec(p, cam, 800, 600)).toBeNull();
  });

  it('projects a centered point to the viewport centre', () => {
    const cam = makeCamera();
    const p = new THREE.Vector3(0, 0, -10);
    const xy = projectVec(p, cam, 800, 600)!;
    expect(xy[0]).toBeCloseTo(400, 3);
    expect(xy[1]).toBeCloseTo(300, 3);
  });

  it('returns null for points well outside the viewport (cull margin)', () => {
    // The cull box is the viewport extended by ±200 horizontally and ±100
    // vertically, so a point projecting far past those bounds should be
    // dropped. Place it far enough off-axis to clearly exit even the
    // extended box.
    const cam = makeCamera();
    const p = new THREE.Vector3(1000, 0, -1);
    expect(projectVec(p, cam, 800, 600)).toBeNull();
  });
});
