import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  LocalGroupLayer,
  computeVisibleLabels,
  DEFAULT_TOP_N,
  DEFAULT_MIN_PIXEL_SIZE_PX,
  DEFAULT_MW_INSIDE_DISC_PC,
  setTopN,
  setMinPixelSize,
  setMwInsideDiscPc,
  type LabelCandidate,
  type RankingParams,
} from './local-group';
import type { LgCatalog, LgObject } from './local-group-loader';
import { FADE_INNER_PC, FADE_OUTER_PC } from './galactic-fade';
import { GALACTIC_CENTRE_PC } from './galactic-coords';

function makeObject(o: Partial<LgObject>): LgObject {
  return {
    name: o.name ?? 'Test',
    id: o.id ?? 'test',
    centerAbs: o.centerAbs ?? new THREE.Vector3(10000, 0, 0),
    kind: o.kind ?? 'ellipsoid',
    axes: o.axes ?? [100, 80, 80],
    quat: o.quat ?? new THREE.Quaternion(),
    source: o.source ?? 'LVDB',
    distanceFromSol: o.distanceFromSol ?? 10000,
  };
}

function makeCatalog(objects: LgObject[]): LgCatalog {
  return { count: objects.length, objects };
}

describe('LocalGroupLayer', () => {
  it('builds three meridian LineLoops per ellipsoid object', () => {
    const layer = new LocalGroupLayer(makeCatalog([
      makeObject({ kind: 'ellipsoid' }),
      makeObject({ kind: 'ellipsoid', id: 'b' }),
    ]));
    // 2 objects × 3 rings = 6 LineLoops.
    expect(layer.group.children.length).toBe(6);
    layer.dispose();
  });

  it('builds three LineLoops per disc object (midplane + thickness pair)', () => {
    const layer = new LocalGroupLayer(makeCatalog([
      makeObject({ kind: 'disc' }),
    ]));
    expect(layer.group.children.length).toBe(3);
    layer.dispose();
  });

  it('starts hidden with material opacity = 0 — fades in via update()', () => {
    const layer = new LocalGroupLayer(makeCatalog([makeObject({})]));
    const mat = (layer.group.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial;
    expect(mat.opacity).toBe(0);
    layer.dispose();
  });

  it('update() at distFromSol < FADE_INNER_PC keeps the layer hidden', () => {
    const layer = new LocalGroupLayer(makeCatalog([makeObject({})]));
    layer.update(new THREE.Vector3(), FADE_INNER_PC - 100);
    expect(layer.group.visible).toBe(false);
    layer.dispose();
  });

  it('update() at distFromSol > FADE_OUTER_PC shows the layer at full base opacity', () => {
    const layer = new LocalGroupLayer(makeCatalog([makeObject({})]));
    layer.update(new THREE.Vector3(), FADE_OUTER_PC + 1000);
    expect(layer.group.visible).toBe(true);
    const mat = (layer.group.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial;
    expect(mat.opacity).toBeGreaterThan(0);
    layer.dispose();
  });

  it('update() applies -worldOffset to the group position (floating origin)', () => {
    const layer = new LocalGroupLayer(makeCatalog([makeObject({})]));
    const wo = new THREE.Vector3(1234, -5678, 9012);
    layer.update(wo, FADE_OUTER_PC + 1000);
    expect(layer.group.position.x).toBe(-1234);
    expect(layer.group.position.y).toBe(5678);
    expect(layer.group.position.z).toBe(-9012);
    layer.dispose();
  });

  it('setMonochrome(true) hides the layer in chart mode (no chart-mode treatment yet)', () => {
    const layer = new LocalGroupLayer(makeCatalog([makeObject({})]));
    layer.setMonochrome(true);
    layer.update(new THREE.Vector3(), FADE_OUTER_PC + 1000);
    expect(layer.group.visible).toBe(false);
    layer.dispose();
  });

  it('per-object silhouette samples include 12*5 + 2 = 62 points', () => {
    const layer = new LocalGroupLayer(makeCatalog([makeObject({})]));
    expect(layer.sampleCount(0)).toBe(62);
    layer.dispose();
  });

  it('silhouette samples land within the bounding sphere of the (rotated, translated) ellipsoid', () => {
    const center = new THREE.Vector3(50000, 12000, -8000);
    const axes: [number, number, number] = [3730, 4960, 6000];
    const layer = new LocalGroupLayer(makeCatalog([makeObject({
      centerAbs: center, axes, kind: 'ellipsoid',
    })]));
    const tmp = new THREE.Vector3();
    const maxAxis = Math.max(...axes);
    for (let i = 0; i < layer.sampleCount(0); i++) {
      layer.getAbsSample(0, i, tmp);
      const r = tmp.sub(center).length();
      // All samples sit on the ellipsoid surface, so r ≤ maxAxis (+ float
      // slop). The poles sit exactly at c=6000.
      expect(r).toBeLessThanOrEqual(maxAxis + 1e-6);
    }
    layer.dispose();
  });

  it('shares a single material across all rings (per-frame opacity write hits one slot)', () => {
    const layer = new LocalGroupLayer(makeCatalog([
      makeObject({ kind: 'ellipsoid' }),
      makeObject({ kind: 'ellipsoid', id: 'b' }),
      makeObject({ kind: 'disc', id: 'c' }),
    ]));
    const materials = new Set(layer.group.children.map(
      (c) => (c as THREE.LineLoop).material as THREE.LineBasicMaterial,
    ));
    expect(materials.size).toBe(1);
    layer.dispose();
  });
});

// Reference setup for the ranking helper — camera and reference values
// chosen so each test reads cleanly without per-test arithmetic clutter.
const REFERENCE_FOV_DEG = 60;
const REFERENCE_VIEWPORT_W = 800;
const REFERENCE_VIEWPORT_H = 600;

function makeCandidate(o: Partial<LabelCandidate>): LabelCandidate {
  return {
    id: o.id ?? 'x',
    centerAbs: o.centerAbs ?? new THREE.Vector3(),
    maxAxis: o.maxAxis ?? 100,
  };
}

/** Build a fully-populated RankingParams from a camera eye + look-at
 *  pair, with per-test tunable overrides. The camera looks at `target`
 *  with a 60° FOV in a 800×600 viewport unless overridden. */
function makeParams(
  eye: THREE.Vector3,
  target: THREE.Vector3,
  overrides: Partial<RankingParams> = {},
): RankingParams {
  const cam = new THREE.PerspectiveCamera(
    REFERENCE_FOV_DEG,
    REFERENCE_VIEWPORT_W / REFERENCE_VIEWPORT_H,
    0.01,
    1e9,
  );
  cam.position.copy(eye);
  cam.lookAt(target);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  return {
    cameraAbs: eye,
    galacticCentreAbs: GALACTIC_CENTRE_PC,
    worldOffset: new THREE.Vector3(),
    matrixWorldInverse: cam.matrixWorldInverse,
    projectionMatrix: cam.projectionMatrix,
    fovDeg: REFERENCE_FOV_DEG,
    viewportWidthPx: REFERENCE_VIEWPORT_W,
    viewportHeightPx: REFERENCE_VIEWPORT_H,
    topN: 5,
    minPixelSize: 6,
    mwInsideDiscPc: 10_000,
    ...overrides,
  };
}

describe('computeVisibleLabels — global apparent-size ranking', () => {
  // Reset live tunables to defaults each test so cross-test mutation
  // can't introduce false signal.
  beforeEach(() => {
    setTopN(DEFAULT_TOP_N);
    setMinPixelSize(DEFAULT_MIN_PIXEL_SIZE_PX);
    setMwInsideDiscPc(DEFAULT_MW_INSIDE_DISC_PC);
  });

  it('inside-MW guard: empty result when camera is inside the disc threshold', () => {
    const eye = GALACTIC_CENTRE_PC.clone();
    const target = eye.clone().add(new THREE.Vector3(1, 0, 0));
    const cands: LabelCandidate[] = [
      makeCandidate({ id: 'mw', centerAbs: GALACTIC_CENTRE_PC, maxAxis: 15_000 }),
      makeCandidate({ id: 'lmc', centerAbs: new THREE.Vector3(15_000, 5_000, -42_000), maxAxis: 4_500 }),
    ];
    const result = computeVisibleLabels(cands, makeParams(eye, target));
    expect(result.size).toBe(0);
  });

  it('outside the disc: ranks by apparent pixel size, returns top N', () => {
    // Camera 50 kpc behind GC along +X, looking at GC. Three candidates
    // collocated AT GC with different sizes — largest wins.
    const eye = new THREE.Vector3(50_000, 0, 0).add(GALACTIC_CENTRE_PC);
    const target = GALACTIC_CENTRE_PC.clone();
    const cands: LabelCandidate[] = [
      makeCandidate({ id: 'big', centerAbs: target.clone(), maxAxis: 5_000 }),
      makeCandidate({ id: 'mid', centerAbs: target.clone(), maxAxis: 500 }),
      makeCandidate({ id: 'small', centerAbs: target.clone(), maxAxis: 50 }),
    ];
    const result = computeVisibleLabels(cands, makeParams(eye, target, {
      topN: 2, minPixelSize: 0.01,
    }));
    expect(result.size).toBe(2);
    expect(result.has('big')).toBe(true);
    expect(result.has('mid')).toBe(true);
    expect(result.has('small')).toBe(false);
  });

  it('sub-pixel cutoff drops candidates below minPixelSize', () => {
    const eye = new THREE.Vector3(1_000_000, 0, 0).add(GALACTIC_CENTRE_PC);
    const target = GALACTIC_CENTRE_PC.clone();
    const cands: LabelCandidate[] = [
      makeCandidate({ id: 'tiny', centerAbs: target.clone(), maxAxis: 50 }),
      makeCandidate({ id: 'mw', centerAbs: target.clone(), maxAxis: 15_000 }),
    ];
    const result = computeVisibleLabels(cands, makeParams(eye, target));
    expect(result.has('mw')).toBe(true);
    expect(result.has('tiny')).toBe(false);
  });

  it('topN=0 disables labels entirely', () => {
    const eye = new THREE.Vector3(50_000, 0, 0).add(GALACTIC_CENTRE_PC);
    const target = GALACTIC_CENTRE_PC.clone();
    const cands: LabelCandidate[] = [
      makeCandidate({ id: 'a', centerAbs: target.clone(), maxAxis: 5_000 }),
    ];
    const result = computeVisibleLabels(cands, makeParams(eye, target, { topN: 0 }));
    expect(result.size).toBe(0);
  });

  it('mwInsideDiscPc=0 disables the inside-MW guard entirely', () => {
    // Camera at GC. With guard=0, MW competes for a label slot via
    // apparent size — at zero distance it definitely passes any
    // reasonable sub-pixel floor.
    const eye = GALACTIC_CENTRE_PC.clone();
    const target = eye.clone().add(new THREE.Vector3(1, 0, 0));
    const cands: LabelCandidate[] = [
      // Place the "MW" candidate slightly in front of the camera so
      // the behind-camera filter doesn't reject it.
      makeCandidate({
        id: 'mw',
        centerAbs: eye.clone().add(new THREE.Vector3(100, 0, 0)),
        maxAxis: 15_000,
      }),
    ];
    const result = computeVisibleLabels(cands, makeParams(eye, target, {
      mwInsideDiscPc: 0,
    }));
    expect(result.has('mw')).toBe(true);
  });

  it('skips candidates behind the camera even when otherwise huge', () => {
    // Camera looks down -Z. The "front" candidate is at -Z relative to
    // the camera; the "behind" candidate is at +Z (behind). Without
    // the behind-camera filter, both would compete for the top slot
    // — the bug Alex flagged.
    const eye = new THREE.Vector3(0, 0, 0).add(GALACTIC_CENTRE_PC);
    const target = eye.clone().add(new THREE.Vector3(0, 0, -1));
    const cands: LabelCandidate[] = [
      makeCandidate({
        id: 'front',
        centerAbs: eye.clone().add(new THREE.Vector3(0, 0, -10_000)),
        maxAxis: 1_000,
      }),
      makeCandidate({
        id: 'behind',
        centerAbs: eye.clone().add(new THREE.Vector3(0, 0, 10_000)),
        maxAxis: 1_000,
      }),
    ];
    const result = computeVisibleLabels(cands, makeParams(eye, target, {
      mwInsideDiscPc: 0,
    }));
    expect(result.has('front')).toBe(true);
    expect(result.has('behind')).toBe(false);
  });

  it('skips candidates whose projected silhouette falls outside the viewport', () => {
    // Camera at origin looking down -Z. "centre" sits straight ahead;
    // "off-right" sits hugely far to the +X side at the same depth,
    // so its centroid lands well outside the +X viewport edge AND its
    // silhouette doesn't reach back into the viewport.
    const eye = new THREE.Vector3(0, 0, 0).add(GALACTIC_CENTRE_PC);
    const target = eye.clone().add(new THREE.Vector3(0, 0, -1));
    const cands: LabelCandidate[] = [
      makeCandidate({
        id: 'centre',
        centerAbs: eye.clone().add(new THREE.Vector3(0, 0, -1000)),
        maxAxis: 50,
      }),
      makeCandidate({
        id: 'off-right',
        centerAbs: eye.clone().add(new THREE.Vector3(100_000, 0, -1000)),
        maxAxis: 50,
      }),
    ];
    const result = computeVisibleLabels(cands, makeParams(eye, target, {
      mwInsideDiscPc: 0,
    }));
    expect(result.has('centre')).toBe(true);
    expect(result.has('off-right')).toBe(false);
  });

  it('big object with off-screen centroid still counts when silhouette overlaps viewport', () => {
    // Centroid sits a little past the +X edge of the viewport, but the
    // object is large enough that its disc edge reaches back inside
    // the screen — the MW-disc-at-grazing-incidence case. Without
    // silhouette-padding, this candidate would be wrongly excluded.
    const eye = new THREE.Vector3(0, 0, 0).add(GALACTIC_CENTRE_PC);
    const target = eye.clone().add(new THREE.Vector3(0, 0, -1));
    // At depth d=1000 with 60° vertical FOV / aspect 4:3, the
    // half-width on screen is d·tan(30°)·(4/3) ≈ 770. A centroid at
    // x=900 sits just past the right edge; an object of radius 500
    // reaches back to x=400, well inside the viewport.
    const cands: LabelCandidate[] = [
      makeCandidate({
        id: 'huge-edge',
        centerAbs: eye.clone().add(new THREE.Vector3(900, 0, -1000)),
        maxAxis: 500,
      }),
    ];
    const result = computeVisibleLabels(cands, makeParams(eye, target, {
      mwInsideDiscPc: 0,
    }));
    expect(result.has('huge-edge')).toBe(true);
  });
});
