import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  attachFontsReadyInvalidation,
  makeLabelWidthCache,
  projectWithNearClip,
  viewportSegmentExit,
} from './distance-vector-overlay';

// Set up a perspective camera at the origin looking down -Z, mirroring the
// canonical Stellata camera. matrixWorldInverse and projectionMatrix must
// be brought up to date manually since there's no Three.js render loop in
// node tests.
function makeCamera(opts: { fov?: number; aspect?: number; near?: number; far?: number } = {}) {
  const cam = new THREE.PerspectiveCamera(
    opts.fov ?? 50,
    opts.aspect ?? 1,
    opts.near ?? 0.01,
    opts.far ?? 1000,
  );
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  cam.updateProjectionMatrix();
  return cam;
}

describe('distance-vector-overlay / projectWithNearClip', () => {
  const W = 800;
  const H = 600;

  it('returns null when source point is behind the camera', () => {
    const cam = makeCamera();
    // Source z=+1 in world frame → behind a camera looking -Z. No origin
    // means no meaningful arrow root; bail.
    const a = new THREE.Vector3(0, 0, 1);
    const b = new THREE.Vector3(0, 0, -10);
    expect(projectWithNearClip(a, b, cam, W, H)).toBeNull();
  });

  it('returns null when source point is exactly at the near plane', () => {
    const cam = makeCamera({ near: 0.5 });
    // Source view-space z must be strictly < -near (i.e., further than the
    // near plane), not equal. The threshold is half-open to avoid a
    // degenerate projection.
    const a = new THREE.Vector3(0, 0, -0.5);
    const b = new THREE.Vector3(0, 0, -10);
    expect(projectWithNearClip(a, b, cam, W, H)).toBeNull();
  });

  it('projects a centered point to viewport center', () => {
    const cam = makeCamera();
    const a = new THREE.Vector3(0, 0, -10);
    const b = new THREE.Vector3(0, 0, -20);
    const out = projectWithNearClip(a, b, cam, W, H);
    expect(out).not.toBeNull();
    expect(out!.pA[0]).toBeCloseTo(W / 2, 3);
    expect(out!.pA[1]).toBeCloseTo(H / 2, 3);
    expect(out!.pB[0]).toBeCloseTo(W / 2, 3);
    expect(out!.pB[1]).toBeCloseTo(H / 2, 3);
  });

  it('projects a point right of center to a higher x pixel', () => {
    const cam = makeCamera();
    const a = new THREE.Vector3(0, 0, -10);
    const b = new THREE.Vector3(2, 0, -10); // right of camera
    const out = projectWithNearClip(a, b, cam, W, H)!;
    expect(out.pA[0]).toBeCloseTo(W / 2, 3);
    expect(out.pB[0]).toBeGreaterThan(W / 2);
    // y unchanged — both points lie in the camera's horizontal plane
    expect(out.pA[1]).toBeCloseTo(out.pB[1], 3);
  });

  it('projects a point above center to a smaller y pixel', () => {
    // SVG y axis is flipped (y=0 at top), so a world +y point maps to a
    // smaller y pixel.
    const cam = makeCamera();
    const a = new THREE.Vector3(0, 0, -10);
    const b = new THREE.Vector3(0, 2, -10);
    const out = projectWithNearClip(a, b, cam, W, H)!;
    expect(out.pB[1]).toBeLessThan(H / 2);
  });

  it('clips destination to the near plane when only it is behind the camera', () => {
    const cam = makeCamera({ near: 0.1 });
    // Source slightly in front; destination behind the camera, off-axis.
    const a = new THREE.Vector3(1, 0, -1);
    const b = new THREE.Vector3(1, 0, 1);
    const out = projectWithNearClip(a, b, cam, W, H);
    expect(out).not.toBeNull();
    // pB ends up further to the right than pA (preserving direction of travel)
    expect(out!.pB[0]).toBeGreaterThan(out!.pA[0]);
  });

  it('returns null when destination is on the near plane and segment cannot cross', () => {
    const cam = makeCamera({ near: 0.1 });
    // Both source and dest at the threshold plane → degenerate segment.
    // Source at threshold returns null on the source check before getting
    // to the destination clip.
    const a = new THREE.Vector3(0, 0, -0.1);
    const b = new THREE.Vector3(0, 0, -0.1);
    expect(projectWithNearClip(a, b, cam, W, H)).toBeNull();
  });

  it('clamps off-screen destination so SVG path coordinates stay bounded', () => {
    // Place destination far enough off-axis to land outside the viewport
    // by a large margin if unclamped. The clamp is MAX_OFFSCREEN_FACTOR
    // (1.5) × diagonal — pB must remain inside that disc.
    const cam = makeCamera();
    const a = new THREE.Vector3(0, 0, -10);
    const b = new THREE.Vector3(1000, 0, -10); // way off to the right
    const out = projectWithNearClip(a, b, cam, W, H)!;
    const dx = out.pB[0] - out.pA[0];
    const dy = out.pB[1] - out.pA[1];
    const len = Math.hypot(dx, dy);
    const maxAllowed = Math.hypot(W, H) * 1.5;
    expect(len).toBeLessThanOrEqual(maxAllowed + 1);
  });

  it('preserves direction of travel under off-screen clamp', () => {
    const cam = makeCamera();
    const a = new THREE.Vector3(0, 0, -10);
    const b = new THREE.Vector3(1000, 500, -10); // up-right and off-screen
    const out = projectWithNearClip(a, b, cam, W, H)!;
    // Direction (sign of dx, dy) preserved post-clamp.
    expect(out.pB[0] - out.pA[0]).toBeGreaterThan(0);
    expect(out.pB[1] - out.pA[1]).toBeLessThan(0); // SVG y inverted
  });
});

describe('distance-vector-overlay / viewportSegmentExit', () => {
  const W = 800;
  const H = 600;

  it('returns null when destination is inside the viewport', () => {
    expect(viewportSegmentExit(0, 0, 100, 200, W, H)).toBeNull();
    expect(viewportSegmentExit(50, 50, W / 2, H / 2, W, H)).toBeNull();
  });

  it('returns viewport edge intersection when destination is to the right', () => {
    const exit = viewportSegmentExit(W / 2, H / 2, W + 200, H / 2, W, H);
    expect(exit).not.toBeNull();
    expect(exit![0]).toBeCloseTo(W, 3);
    expect(exit![1]).toBeCloseTo(H / 2, 3);
  });

  it('returns viewport edge intersection when destination is below', () => {
    const exit = viewportSegmentExit(W / 2, H / 2, W / 2, H + 200, W, H);
    expect(exit).not.toBeNull();
    expect(exit![0]).toBeCloseTo(W / 2, 3);
    expect(exit![1]).toBeCloseTo(H, 3);
  });

  it('returns viewport edge intersection when destination is above-left', () => {
    const exit = viewportSegmentExit(W / 2, H / 2, -200, -200, W, H);
    expect(exit).not.toBeNull();
    // Exit must hit either the top (y=0) or left (x=0) edge — whichever the
    // segment hits first travelling toward (-200, -200).
    const onTop = Math.abs(exit![1]) < 1e-3;
    const onLeft = Math.abs(exit![0]) < 1e-3;
    expect(onTop || onLeft).toBe(true);
    // Either way, exit lies on the segment from (W/2, H/2) → (-200, -200)
    const t = (W / 2 - exit![0]) / (W / 2 - (-200));
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(1);
  });

  it('exit point lies on the input segment', () => {
    const ax = 100, ay = 100;
    const bx = 1500, by = 1200;
    const exit = viewportSegmentExit(ax, ay, bx, by, W, H)!;
    // Parametrise: exit = (ax + t*(bx-ax), ay + t*(by-ay)) with same t in
    // both dimensions.
    const tx = (exit[0] - ax) / (bx - ax);
    const ty = (exit[1] - ay) / (by - ay);
    expect(tx).toBeCloseTo(ty, 5);
    expect(tx).toBeGreaterThan(0);
    expect(tx).toBeLessThanOrEqual(1);
  });

  it('exit point lies on the viewport boundary', () => {
    const exit = viewportSegmentExit(W / 2, H / 2, W * 2, H / 2, W, H)!;
    // For a horizontal segment going right, exit must be on right edge.
    expect(exit[0]).toBeCloseTo(W, 3);
    expect(exit[1]).toBeGreaterThanOrEqual(0);
    expect(exit[1]).toBeLessThanOrEqual(H);
  });

  it('returns null for a horizontal segment that misses the viewport', () => {
    // Segment from (-100, -50) → (-50, -50) — both off-left, never enters.
    expect(viewportSegmentExit(-100, -50, -50, -50, W, H)).toBeNull();
  });

  it('returns the b-side exit when both endpoints are off-screen but segment crosses', () => {
    // Segment from far-left to far-right at y=H/2 — passes through the viewport.
    const exit = viewportSegmentExit(-500, H / 2, W + 500, H / 2, W, H)!;
    // The b-side exit is the right edge.
    expect(exit[0]).toBeCloseTo(W, 3);
    expect(exit[1]).toBeCloseTo(H / 2, 3);
  });

  it('handles degenerate point segment outside the viewport', () => {
    // Zero-length segment outside viewport with no direction → caller has
    // no useful exit point; the contract is to return null since the
    // segment never enters/exits anything.
    expect(viewportSegmentExit(-10, -10, -10, -10, W, H)).toBeNull();
  });
});

describe('distance-vector-overlay / label-width cache + fonts.ready invalidation', () => {
  it('makeLabelWidthCache returns an empty cache', () => {
    const cache = makeLabelWidthCache();
    expect(cache.text).toBe('');
    expect(cache.px).toBe(0);
  });

  it('invalidates the cache when document.fonts.ready resolves (9mm.149)', async () => {
    // Regression for 9mm.149: when a webfont finishes loading after the
    // first getComputedTextLength call, the cached width is pinned to the
    // fallback-font measurement and the right-edge clamp / warp
    // affordance mis-anchor for the page's lifetime. fonts.ready settles
    // post-load (or fires immediately) and the listener must zero both
    // the text key and the cached px so the next per-frame call
    // re-measures with the loaded font.
    const cache = makeLabelWidthCache();
    cache.text = 'Sirius · 2.6 pc';
    cache.px = 95;
    let resolve!: () => void;
    const ready = new Promise<void>((r) => { resolve = r; });
    attachFontsReadyInvalidation(cache, { ready });
    resolve();
    // Drain microtasks so the .then() runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.text).toBe('');
    expect(cache.px).toBe(0);
  });

  it('is a no-op when the Fonts API is absent', () => {
    // Older browsers don't expose document.fonts. The pre-fix behaviour
    // was: cache stays text-keyed (re-measures when text changes, but
    // doesn't catch font-load events). The helper must not throw in that
    // case, and must leave the cache untouched.
    const cache = makeLabelWidthCache();
    cache.text = 'Vega';
    cache.px = 42;
    expect(() => attachFontsReadyInvalidation(cache, undefined)).not.toThrow();
    expect(cache.text).toBe('Vega');
    expect(cache.px).toBe(42);
  });

  it('swallows fonts.ready rejection without throwing', async () => {
    const cache = makeLabelWidthCache();
    cache.text = 'Polaris';
    cache.px = 60;
    const ready = Promise.reject(new Error('font load failed'));
    attachFontsReadyInvalidation(cache, { ready });
    await Promise.resolve();
    await Promise.resolve();
    // Cache untouched (no invalidation on rejection — graceful degradation).
    expect(cache.text).toBe('Polaris');
    expect(cache.px).toBe(60);
  });
});
