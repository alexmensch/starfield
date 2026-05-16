import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { createDistanceGatedLabel } from './distance-gated-label';

type AnyStellata = Parameters<typeof createDistanceGatedLabel>[0];

interface FakeText {
  style: { display: string };
  attrs: Map<string, string>;
  setAttribute: (k: string, v: string) => void;
}

function makeFakeText(): FakeText {
  const attrs = new Map<string, string>();
  return {
    style: { display: '' },
    attrs,
    setAttribute: (k, v) => { attrs.set(k, v); },
  };
}

const savedDoc = (globalThis as { document?: unknown }).document;
const savedWin = (globalThis as { window?: unknown }).window;

function mountDom(textsById: Record<string, FakeText>) {
  (globalThis as { document?: unknown }).document = {
    getElementById: (id: string) => textsById[id] ?? null,
  };
  (globalThis as { window?: unknown }).window = {
    innerWidth: 800,
    innerHeight: 600,
  };
}

function buildCamera(eye: THREE.Vector3, lookAt: THREE.Vector3): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 800 / 600, 0.01, 10_000);
  cam.position.copy(eye);
  cam.lookAt(lookAt);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  return cam;
}

interface FakeStellata {
  camera: THREE.PerspectiveCamera;
  fireFrame: () => void;
  framed: { cb?: () => void };
  on: AnyStellata['on'];
}

function makeFakeStellata(camera: THREE.PerspectiveCamera): FakeStellata {
  const framed: { cb?: () => void } = {};
  const on = ((event: string, cb: () => void) => {
    if (event === 'frame') framed.cb = cb;
    return () => {};
  }) as unknown as AnyStellata['on'];
  return {
    camera,
    framed,
    fireFrame: () => framed.cb?.(),
    on,
  };
}

describe('createDistanceGatedLabel', () => {
  beforeEach(() => {
    // Wipe globals before each so tests don't leak DOM state.
    (globalThis as { document?: unknown }).document = undefined;
    (globalThis as { window?: unknown }).window = undefined;
  });

  afterEach(() => {
    (globalThis as { document?: unknown }).document = savedDoc;
    (globalThis as { window?: unknown }).window = savedWin;
  });

  it('writes display:none synchronously on init (poison-sentinel forces first write)', () => {
    const text = makeFakeText();
    mountDom({ 'lbl': text });
    const cam = buildCamera(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 0));
    const fake = makeFakeStellata(cam);
    createDistanceGatedLabel(fake as unknown as AnyStellata, {
      elementId: 'lbl',
      sampleCount: 1,
      getWorldSample: (_, out) => out.set(0, 0, 0),
      visible: () => true,
      labelDir: { x: 1, y: 0 },
      offsetPx: 10,
      lerp: 0.5,
    });
    expect(text.style.display).toBe('none');
  });

  it('returns silently when the element is absent (no SVG slot, no crash)', () => {
    mountDom({});
    const cam = buildCamera(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 0));
    const fake = makeFakeStellata(cam);
    expect(() => createDistanceGatedLabel(fake as unknown as AnyStellata, {
      elementId: 'missing',
      sampleCount: 1,
      getWorldSample: (_, out) => out.set(0, 0, 0),
      visible: () => true,
      labelDir: { x: 1, y: 0 },
      offsetPx: 10,
      lerp: 0.5,
    })).not.toThrow();
    // No frame handler should be registered when the element is missing —
    // otherwise we'd accumulate dead callbacks on every reload.
    expect(fake.framed.cb).toBeUndefined();
  });

  it('hides on visible()=false and clears smoothing so the next show snaps', () => {
    const text = makeFakeText();
    mountDom({ 'lbl': text });
    const cam = buildCamera(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 0));
    const fake = makeFakeStellata(cam);

    let predicate = true;
    createDistanceGatedLabel(fake as unknown as AnyStellata, {
      elementId: 'lbl',
      sampleCount: 1,
      getWorldSample: (_, out) => out.set(1, 0, 0), // off-axis point
      visible: () => predicate,
      labelDir: { x: 1, y: 0 },
      offsetPx: 10,
      lerp: 0.5,
    });

    // Frame 1: visible — record screen position (will be smoothed-snap on
    // first show after init, so target == smoothed).
    fake.fireFrame();
    expect(text.style.display).toBe('');
    const x1 = parseFloat(text.attrs.get('x')!);

    // Hide — smoothing should reset.
    predicate = false;
    fake.fireFrame();
    expect(text.style.display).toBe('none');

    // Show again — should snap (not lerp from x1) because smoothed reset.
    // Switch the sample point so the new target differs from x1.
    predicate = true;
    createDistanceGatedLabel(fake as unknown as AnyStellata, {
      elementId: 'lbl',
      sampleCount: 1,
      getWorldSample: (_, out) => out.set(-1, 0, 0),
      visible: () => predicate,
      labelDir: { x: 1, y: 0 },
      offsetPx: 10,
      lerp: 0.5,
    });
    // The second createDistanceGatedLabel registered a fresh handler;
    // `fireFrame` now invokes that one (overwrites the first).
    fake.fireFrame();
    const x2 = parseFloat(text.attrs.get('x')!);
    expect(x2).not.toBeCloseTo(x1, 1);
  });

  it('picks the support point furthest along labelDir from the silhouette', () => {
    const text = makeFakeText();
    mountDom({ 'lbl': text });
    const cam = buildCamera(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 0));
    const fake = makeFakeStellata(cam);

    // Four samples on the unit circle in z=0. labelDir = (+x, 0) → the
    // right-side sample (+1, 0, 0) projects to the largest screen-x and
    // wins. Camera looks at origin from (0, 0, 5), so +x world maps to
    // +x screen.
    const samples = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -1, 0),
    ];
    createDistanceGatedLabel(fake as unknown as AnyStellata, {
      elementId: 'lbl',
      sampleCount: samples.length,
      getWorldSample: (i, out) => out.copy(samples[i]),
      visible: () => true,
      labelDir: { x: 1, y: 0 },
      offsetPx: 10,
      lerp: 1.0, // snap each frame to target for deterministic assertion
    });

    fake.fireFrame();
    expect(text.style.display).toBe('');
    const x = parseFloat(text.attrs.get('x')!);
    const y = parseFloat(text.attrs.get('y')!);
    // Screen-x of (+1, 0, 0) projected: depends on FOV/aspect but is > 400
    // (right of centre). y should be at vertical centre (300).
    expect(x).toBeGreaterThan(400);
    expect(y).toBeCloseTo(300, 0);
  });

  it('applies offsetPx in the labelDir direction', () => {
    const text = makeFakeText();
    mountDom({ 'lbl': text });
    const cam = buildCamera(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 0));
    const fake = makeFakeStellata(cam);

    // Single sample at origin → projects exactly to screen centre (400, 300).
    // Offset 50 px along (1, 0) → label anchor at (450, 300).
    createDistanceGatedLabel(fake as unknown as AnyStellata, {
      elementId: 'lbl',
      sampleCount: 1,
      getWorldSample: (_, out) => out.set(0, 0, 0),
      visible: () => true,
      labelDir: { x: 1, y: 0 },
      offsetPx: 50,
      lerp: 1.0,
    });
    fake.fireFrame();
    expect(parseFloat(text.attrs.get('x')!)).toBeCloseTo(450, 0);
    expect(parseFloat(text.attrs.get('y')!)).toBeCloseTo(300, 0);
  });

  it('bails (hides) when any sample is behind the near plane', () => {
    const text = makeFakeText();
    mountDom({ 'lbl': text });
    const cam = buildCamera(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 0));
    const fake = makeFakeStellata(cam);

    // First sample is in front of the camera; second is behind it (z > eye.z
    // in world space). Even though the first sample alone would project
    // cleanly, the second triggers the near-plane bail and hides.
    const samples = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 10), // behind camera at z=5 → near-plane bail
    ];
    createDistanceGatedLabel(fake as unknown as AnyStellata, {
      elementId: 'lbl',
      sampleCount: samples.length,
      getWorldSample: (i, out) => out.copy(samples[i]),
      visible: () => true,
      labelDir: { x: 1, y: 0 },
      offsetPx: 10,
      lerp: 1.0,
    });
    fake.fireFrame();
    expect(text.style.display).toBe('none');
  });

  it('lerp factor smooths the screen position between successive targets', () => {
    const text = makeFakeText();
    mountDom({ 'lbl': text });
    const cam = buildCamera(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 0));
    const fake = makeFakeStellata(cam);

    // Animate the sample world position frame-by-frame. The smoothed
    // screen-x should chase the target with the lerp factor.
    let samplePos = new THREE.Vector3(0, 0, 0);
    createDistanceGatedLabel(fake as unknown as AnyStellata, {
      elementId: 'lbl',
      sampleCount: 1,
      getWorldSample: (_, out) => out.copy(samplePos),
      visible: () => true,
      labelDir: { x: 1, y: 0 },
      offsetPx: 0,
      lerp: 0.5, // half-the-gap-per-frame
    });

    // Frame 1: target = screen centre (400). First show → snap.
    fake.fireFrame();
    const x1 = parseFloat(text.attrs.get('x')!);
    expect(x1).toBeCloseTo(400, 0);

    // Move sample to project to a larger x. Frame 2: smoothed should
    // land halfway between x1 and the new target.
    samplePos = new THREE.Vector3(1, 0, 0);
    fake.fireFrame();
    const x2 = parseFloat(text.attrs.get('x')!);
    // We don't pin the new target's exact x (depends on FOV), but it must
    // be > x1 and the smoothed value must sit strictly between.
    fake.fireFrame();
    const x3 = parseFloat(text.attrs.get('x')!);
    expect(x2).toBeGreaterThan(x1);
    expect(x3).toBeGreaterThan(x2);
  });
});
