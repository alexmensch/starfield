import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MolecularClouds, renderedCloudSizePx, cloudViewingDistancePc } from './molecular-clouds';
import type { Cloud, CloudCatalog } from './cloud-loader';

// Two-cloud stub catalog so the per-cloud loops in setMonochrome /
// setIsobar / applyBlending all run with `materials.length > 1`.
function makeCatalog(): CloudCatalog {
  const cloud = (id: string): Cloud => ({
    name: id,
    id,
    centerAbs: new THREE.Vector3(0, 0, 0),
    axes: [10, 10, 10],
    quat: new THREE.Quaternion(),
    source: 'Z2020',
    distanceFromSol: 100,
  });
  const clouds = [cloud('A'), cloud('B')];
  return { count: clouds.length, clouds };
}

function makeCloud(axes: [number, number, number]): Cloud {
  return {
    name: 'test',
    id: 'test',
    centerAbs: new THREE.Vector3(),
    axes,
    quat: new THREE.Quaternion(),
    source: 'Z2021T1',
    distanceFromSol: 0,
  };
}

function blendings(c: MolecularClouds): THREE.Blending[] {
  // Reach into the meshes — this is a unit test of the blending state
  // contract, not of the public API.
  return c.group.children.map(
    (m) => ((m as THREE.Mesh).material as THREE.ShaderMaterial).blending,
  );
}

describe('MolecularClouds / blending state coordination (9mm.33, mu9)', () => {
  const u1 = { value: 7.5 };

  it('starts in AdditiveBlending (colour mode, no isobar)', () => {
    const c = new MolecularClouds(makeCatalog());
    expect(blendings(c)).toEqual([THREE.AdditiveBlending, THREE.AdditiveBlending]);
  });

  it('setMonochrome(true) flips to NormalBlending (mono ink-on-paper)', () => {
    const c = new MolecularClouds(makeCatalog());
    c.setMonochrome(true);
    expect(blendings(c)).toEqual([THREE.NormalBlending, THREE.NormalBlending]);
  });

  it('setMonochrome(false) restores AdditiveBlending', () => {
    const c = new MolecularClouds(makeCatalog());
    c.setMonochrome(true);
    c.setMonochrome(false);
    expect(blendings(c)).toEqual([THREE.AdditiveBlending, THREE.AdditiveBlending]);
  });

  it('setIsobar(true) forces NormalBlending regardless of mono state', () => {
    const c = new MolecularClouds(makeCatalog());
    c.setIsobar(true, u1);
    expect(blendings(c)).toEqual([THREE.NormalBlending, THREE.NormalBlending]);

    const c2 = new MolecularClouds(makeCatalog());
    c2.setMonochrome(true);
    c2.setIsobar(true, u1);
    expect(blendings(c2)).toEqual([THREE.NormalBlending, THREE.NormalBlending]);
  });

  it('setIsobar(false) restores per-mode default (Additive in colour, Normal in mono)', () => {
    const c = new MolecularClouds(makeCatalog());
    c.setIsobar(true, u1);
    c.setIsobar(false, u1);
    expect(blendings(c)).toEqual([THREE.AdditiveBlending, THREE.AdditiveBlending]);

    const c2 = new MolecularClouds(makeCatalog());
    c2.setMonochrome(true);
    c2.setIsobar(true, u1);
    c2.setIsobar(false, u1);
    expect(blendings(c2)).toEqual([THREE.NormalBlending, THREE.NormalBlending]);
  });

  it('setMonochrome while isobar is live does not clobber the isobar blending', () => {
    // Regression for 9mm.33: pre-fix, setMonochrome(true) would
    // unconditionally write NormalBlending and setMonochrome(false)
    // would write AdditiveBlending — the latter would clobber a live
    // isobar. The applyBlending helper now derives from both flags.
    const c = new MolecularClouds(makeCatalog());
    c.setIsobar(true, u1);
    c.setMonochrome(true);
    expect(blendings(c)).toEqual([THREE.NormalBlending, THREE.NormalBlending]);
    c.setMonochrome(false);
    expect(blendings(c)).toEqual([THREE.NormalBlending, THREE.NormalBlending]);
  });

  it('setIsobar binds the magnitude-uniform reference (mu9 regression)', () => {
    const c = new MolecularClouds(makeCatalog());
    c.setIsobar(true, u1);
    for (const child of c.group.children) {
      const mat = (child as THREE.Mesh).material as THREE.ShaderMaterial;
      expect(mat.uniforms.uMaxAppMag).toBe(u1);
    }
  });

  it('setIsobar with the same magnitude uniform repeated does not silently rebind', () => {
    // The cached boundMagUniform short-circuits the rebind when the
    // wrapper hasn't changed. Verify no-op-ness by re-asserting
    // identity after a no-change call.
    const c = new MolecularClouds(makeCatalog());
    c.setIsobar(true, u1);
    c.setIsobar(true, u1);
    for (const child of c.group.children) {
      const mat = (child as THREE.Mesh).material as THREE.ShaderMaterial;
      expect(mat.uniforms.uMaxAppMag).toBe(u1);
    }
  });
});

describe('renderedCloudSizePx', () => {
  it('picks the largest semi-axis regardless of which slot it lives in', () => {
    const angularToPx = 1000; // arbitrary; cancels out across the comparison
    const dCam = 100;
    const xMax = renderedCloudSizePx(makeCloud([10, 1, 1]), dCam, angularToPx);
    const yMax = renderedCloudSizePx(makeCloud([1, 10, 1]), dCam, angularToPx);
    const zMax = renderedCloudSizePx(makeCloud([1, 1, 10]), dCam, angularToPx);
    expect(xMax).toBeCloseTo(yMax, 9);
    expect(yMax).toBeCloseTo(zMax, 9);
    // …and is strictly larger than a uniformly small cloud at the same distance.
    const small = renderedCloudSizePx(makeCloud([1, 1, 1]), dCam, angularToPx);
    expect(xMax).toBeGreaterThan(small);
  });

  it('matches the angular-diameter formula 2·atan(R/d)·angularToPx', () => {
    const angularToPx = 600 / Math.PI; // viewport_y / fovYRad with H=600, fov=180°
    const dCam = 50;
    const cloud = makeCloud([5, 2, 2]); // largest axis = 5
    const expected = 2 * Math.atan(5 / dCam) * angularToPx;
    expect(renderedCloudSizePx(cloud, dCam, angularToPx)).toBeCloseTo(expected, 12);
  });

  it('stays finite as the camera approaches the centroid', () => {
    // 1e-30 floor on dCam keeps atan well-defined without artificially capping
    // the silhouette diameter; very-close camera produces near-π·angularToPx.
    const angularToPx = 1000;
    const out = renderedCloudSizePx(makeCloud([5, 5, 5]), 0, angularToPx);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThan(0);
  });

  it('uses the perpendicular axes when a viewDir is supplied (prolate end-on)', () => {
    // Cloud of axes [10, 1, 1] viewed end-on along the long axis: the
    // silhouette is a circle of radius 1, NOT 10. With viewDir omitted
    // the helper falls back to max axis (= 10) — that's the legacy
    // conservative answer. With viewDir = [1,0,0] the helper should
    // tighten the bound to 1.
    const angularToPx = 1000;
    const dCam = 100;
    const cloud = makeCloud([10, 1, 1]);
    const endOn = new THREE.Vector3(1, 0, 0); // along long axis (cloud-local x)
    const sideOn = new THREE.Vector3(0, 1, 0); // perpendicular to long axis

    const noDir = renderedCloudSizePx(cloud, dCam, angularToPx);
    const endOnPx = renderedCloudSizePx(cloud, dCam, angularToPx, endOn);
    const sideOnPx = renderedCloudSizePx(cloud, dCam, angularToPx, sideOn);

    // Side-on still sees the full long axis (silhouette radius = 10).
    expect(sideOnPx).toBeCloseTo(noDir, 6);
    // End-on should be ~10× tighter — silhouette radius drops from 10 to 1.
    expect(endOnPx).toBeLessThan(noDir / 5);
    // ...specifically matching 2·atan(1/100)·angularToPx.
    const expectedEndOn = 2 * Math.atan(1 / dCam) * angularToPx;
    expect(endOnPx).toBeCloseTo(expectedEndOn, 9);
  });

  it('reduces to the legacy max-axis when the cloud is a sphere', () => {
    const angularToPx = 1000;
    const dCam = 100;
    const cloud = makeCloud([5, 5, 5]);
    const someDir = new THREE.Vector3(0.6, 0.5, 0.4).normalize();
    const noDir = renderedCloudSizePx(cloud, dCam, angularToPx);
    const withDir = renderedCloudSizePx(cloud, dCam, angularToPx, someDir);
    expect(withDir).toBeCloseTo(noDir, 9);
  });
});

describe('cloudViewingDistancePc', () => {
  it('keys off the largest semi-axis with a 5 pc floor', () => {
    expect(cloudViewingDistancePc(makeCloud([10, 1, 1]))).toBeCloseTo(24, 6);
    expect(cloudViewingDistancePc(makeCloud([0.5, 0.5, 0.5]))).toBeCloseTo(5.0, 6);
  });
});
