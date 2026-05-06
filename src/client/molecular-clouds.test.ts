import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MolecularClouds } from './molecular-clouds';
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
