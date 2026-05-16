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
const REFERENCE_VIEWPORT_PX = 800;

function makeCandidate(o: Partial<LabelCandidate>): LabelCandidate {
  return {
    id: o.id ?? 'x',
    centerAbs: o.centerAbs ?? new THREE.Vector3(),
    maxAxis: o.maxAxis ?? 100,
  };
}

function makeParams(overrides: Partial<RankingParams> = {}): RankingParams {
  return {
    cameraAbs: overrides.cameraAbs ?? new THREE.Vector3(),
    galacticCentreAbs: overrides.galacticCentreAbs ?? GALACTIC_CENTRE_PC,
    fovDeg: overrides.fovDeg ?? REFERENCE_FOV_DEG,
    viewportHeightPx: overrides.viewportHeightPx ?? REFERENCE_VIEWPORT_PX,
    topN: overrides.topN ?? 5,
    minPixelSize: overrides.minPixelSize ?? 6,
    mwInsideDiscPc: overrides.mwInsideDiscPc ?? 10_000,
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
    // Camera within 1 pc of GC → well inside the 10 kpc default guard.
    const cam = GALACTIC_CENTRE_PC.clone();
    const cands: LabelCandidate[] = [
      makeCandidate({
        id: 'mw', centerAbs: GALACTIC_CENTRE_PC, maxAxis: 15_000,
      }),
      makeCandidate({
        id: 'lmc', centerAbs: new THREE.Vector3(15_000, 5_000, -42_000), maxAxis: 4_500,
      }),
    ];
    const result = computeVisibleLabels(cands, makeParams({ cameraAbs: cam }));
    expect(result.size).toBe(0);
  });

  it('outside the disc: ranks by apparent pixel size, returns top N', () => {
    // Camera 50 kpc away from GC, looking at three candidates of
    // wildly different sizes at the same distance. Largest wins.
    const cam = new THREE.Vector3(50_000, 0, 0).add(GALACTIC_CENTRE_PC);
    const ref = new THREE.Vector3(0, 0, 0).add(GALACTIC_CENTRE_PC);
    const cands: LabelCandidate[] = [
      makeCandidate({ id: 'big', centerAbs: ref.clone(), maxAxis: 5_000 }),
      makeCandidate({ id: 'mid', centerAbs: ref.clone(), maxAxis: 500 }),
      makeCandidate({ id: 'small', centerAbs: ref.clone(), maxAxis: 50 }),
    ];
    const result = computeVisibleLabels(cands, makeParams({
      cameraAbs: cam, topN: 2, minPixelSize: 0.01,
    }));
    expect(result.size).toBe(2);
    expect(result.has('big')).toBe(true);
    expect(result.has('mid')).toBe(true);
    expect(result.has('small')).toBe(false);
  });

  it('sub-pixel cutoff drops candidates below minPixelSize', () => {
    // Camera 1 Mpc out — a 50 pc dwarf subtends 0.6 arcsec ≈ ~0.005 px
    // at 60° FOV / 800 px height. Below any reasonable floor.
    const cam = new THREE.Vector3(1_000_000, 0, 0).add(GALACTIC_CENTRE_PC);
    const cands: LabelCandidate[] = [
      makeCandidate({
        id: 'tiny', centerAbs: GALACTIC_CENTRE_PC, maxAxis: 50,
      }),
      makeCandidate({
        id: 'mw', centerAbs: GALACTIC_CENTRE_PC, maxAxis: 15_000,
      }),
    ];
    const result = computeVisibleLabels(cands, makeParams({ cameraAbs: cam }));
    // MW at 1 Mpc subtends ~1.7° ≈ 24 px, passes the 6 px default.
    // Tiny dwarf doesn't.
    expect(result.has('mw')).toBe(true);
    expect(result.has('tiny')).toBe(false);
  });

  it('topN=0 disables labels entirely', () => {
    const cam = new THREE.Vector3(50_000, 0, 0).add(GALACTIC_CENTRE_PC);
    const cands: LabelCandidate[] = [
      makeCandidate({ id: 'a', centerAbs: GALACTIC_CENTRE_PC, maxAxis: 5_000 }),
    ];
    const result = computeVisibleLabels(cands, makeParams({
      cameraAbs: cam, topN: 0,
    }));
    expect(result.size).toBe(0);
  });

  it('mwInsideDiscPc=0 disables the inside-MW guard entirely', () => {
    // Camera at GC. With guard=0, MW still has to pass apparent-size /
    // and survive the sub-pixel filter — but it should NOT be empty
    // purely because of the guard.
    const cam = GALACTIC_CENTRE_PC.clone();
    const cands: LabelCandidate[] = [
      makeCandidate({
        id: 'mw', centerAbs: GALACTIC_CENTRE_PC, maxAxis: 15_000,
      }),
    ];
    // Use camToObj=1 floor in computeVisibleLabels (so the angular
    // size doesn't blow up to π at distance 0), then the candidate
    // passes the sub-pixel filter trivially.
    const result = computeVisibleLabels(cands, makeParams({
      cameraAbs: cam, mwInsideDiscPc: 0,
    }));
    expect(result.has('mw')).toBe(true);
  });

  it('outside the disc but everything is sub-pixel → empty', () => {
    // No mwInsideDisc trigger, but all candidates are too far away to
    // earn a label.
    const cam = new THREE.Vector3(50_000_000, 0, 0).add(GALACTIC_CENTRE_PC);
    const cands: LabelCandidate[] = [
      makeCandidate({
        id: 'mw', centerAbs: GALACTIC_CENTRE_PC, maxAxis: 15_000,
      }),
    ];
    const result = computeVisibleLabels(cands, makeParams({ cameraAbs: cam }));
    expect(result.size).toBe(0);
  });
});
