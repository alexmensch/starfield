import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  LocalGroupLayer,
  effectiveLabelThresholdPc,
  SIZE_RELATIVE_LABEL_FACTOR,
} from './local-group';
import type { LgCatalog, LgObject } from './local-group-loader';
import { FADE_INNER_PC, FADE_OUTER_PC } from './galactic-fade';

function makeObject(o: Partial<LgObject>): LgObject {
  return {
    name: o.name ?? 'Test',
    id: o.id ?? 'test',
    centerAbs: o.centerAbs ?? new THREE.Vector3(10000, 0, 0),
    kind: o.kind ?? 'ellipsoid',
    axes: o.axes ?? [100, 80, 80],
    quat: o.quat ?? new THREE.Quaternion(),
    labelThresholdPc: o.labelThresholdPc ?? null,
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

  it('effectiveLabelThresholdPc: hard-coded threshold wins when present', () => {
    const obj = makeObject({ labelThresholdPc: 30_000, axes: [4500, 4500, 1000] });
    expect(effectiveLabelThresholdPc(obj)).toBe(30_000);
  });

  it('effectiveLabelThresholdPc: null falls back to N × max(axes)', () => {
    const obj = makeObject({ labelThresholdPc: null, axes: [50, 30, 30] });
    expect(effectiveLabelThresholdPc(obj)).toBe(SIZE_RELATIVE_LABEL_FACTOR * 50);
  });

  it('effectiveLabelThresholdPc: ultra-faint (50 pc) fallback ≈ 500 pc; classical-class (270 pc) fallback ≈ 2.7 kpc', () => {
    expect(effectiveLabelThresholdPc(makeObject({
      labelThresholdPc: null, axes: [50, 30, 30],
    }))).toBe(500);
    expect(effectiveLabelThresholdPc(makeObject({
      labelThresholdPc: null, axes: [270, 180, 180],
    }))).toBe(2700);
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
