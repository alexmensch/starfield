import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { Cloud } from './cloud-loader';
import { renderedCloudSizePx, cloudViewingDistancePc } from './molecular-clouds';

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
});

describe('cloudViewingDistancePc', () => {
  it('keys off the largest semi-axis with a 5 pc floor', () => {
    expect(cloudViewingDistancePc(makeCloud([10, 1, 1]))).toBeCloseTo(24, 6);
    expect(cloudViewingDistancePc(makeCloud([0.5, 0.5, 0.5]))).toBeCloseTo(5.0, 6);
  });
});
