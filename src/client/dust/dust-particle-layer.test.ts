import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  DustParticleLayer,
  type DustParticleSharedUniforms,
} from './dust-particle-layer';
import type { DustParticleData } from '../loaders/dust-loader';

function makeSharedUniforms(): DustParticleSharedUniforms {
  return {
    uPixelRatio: { value: 1 },
    uViewport: { value: new THREE.Vector2(1024, 768) },
    uWorldOffset: { value: new THREE.Vector3() },
    uDustEnabled: { value: 1 },
    uDustDensityMin: { value: 0 },
    uDustLogRatio: { value: 1 },
  };
}

function makeData(count: number): DustParticleData {
  return {
    count,
    positions: new Float32Array(count * 3),
    densities: new Float32Array(count),
  };
}

describe('DustParticleLayer', () => {
  it('attach() adds a hidden mesh with renderOrder 2 to the scene', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    layer.attach(makeData(3));

    const mesh = scene.children.find(
      (c): c is THREE.Mesh => (c as THREE.Mesh).isMesh,
    );
    expect(mesh).toBeDefined();
    expect(mesh!.visible).toBe(false);
    expect(mesh!.renderOrder).toBe(2);
    expect(mesh!.frustumCulled).toBe(false);
  });

  it('shares uniform objects by reference with the star material', () => {
    const scene = new THREE.Scene();
    const shared = makeSharedUniforms();
    const layer = new DustParticleLayer(scene, shared);
    layer.attach(makeData(1));

    const mesh = scene.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.uWorldOffset).toBe(shared.uWorldOffset);
    expect(mat.uniforms.uViewport).toBe(shared.uViewport);
    expect(mat.uniforms.uDustEnabled).toBe(shared.uDustEnabled);
  });

  it('uParticleStrength is layer-local (not shared)', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    layer.attach(makeData(1));

    const mat = (scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(mat.uniforms.uParticleStrength.value).toBe(0);
  });

  it('setStrength updates uniform and toggles mesh visibility', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    layer.attach(makeData(1));
    const mesh = scene.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.ShaderMaterial;

    layer.setStrength(0.5);
    expect(mat.uniforms.uParticleStrength.value).toBe(0.5);
    expect(mesh.visible).toBe(true);

    layer.setStrength(0);
    expect(mat.uniforms.uParticleStrength.value).toBe(0);
    expect(mesh.visible).toBe(false);
  });

  it('setStrength clamps negative inputs to 0', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    layer.attach(makeData(1));
    const mat = (scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;

    layer.setStrength(-1);
    expect(mat.uniforms.uParticleStrength.value).toBe(0);
  });

  it('setStrength before attach is a no-op', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    expect(() => layer.setStrength(1)).not.toThrow();
  });

  it('attach() replaces an existing mesh and disposes the old resources', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    layer.attach(makeData(2));
    const oldMesh = scene.children[0] as THREE.Mesh;
    const oldGeom = oldMesh.geometry;
    const oldMat = oldMesh.material as THREE.ShaderMaterial;
    const geomSpy = vi.spyOn(oldGeom, 'dispose');
    const matSpy = vi.spyOn(oldMat, 'dispose');

    layer.attach(makeData(5));

    expect(geomSpy).toHaveBeenCalledOnce();
    expect(matSpy).toHaveBeenCalledOnce();
    expect(scene.children.length).toBe(1);
    expect(scene.children[0]).not.toBe(oldMesh);
  });

  it('dispose() releases geometry + material and clears refs', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    layer.attach(makeData(1));
    const mesh = scene.children[0] as THREE.Mesh;
    const geomSpy = vi.spyOn(mesh.geometry, 'dispose');
    const matSpy = vi.spyOn(mesh.material as THREE.ShaderMaterial, 'dispose');

    layer.dispose();

    expect(geomSpy).toHaveBeenCalledOnce();
    expect(matSpy).toHaveBeenCalledOnce();
  });

  it('dispose({ removeFromScene: true }) pulls the mesh out of the scene', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    layer.attach(makeData(1));
    expect(scene.children.length).toBe(1);

    layer.dispose({ removeFromScene: true });
    expect(scene.children.length).toBe(0);
  });

  it('dispose() (default removeFromScene: false) leaves the mesh in the scene', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    layer.attach(makeData(1));

    layer.dispose();
    expect(scene.children.length).toBe(1);
  });

  it('dispose() before attach is a no-op', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    expect(() => layer.dispose()).not.toThrow();
  });

  it('dispose() then attach() rebuilds cleanly', () => {
    const scene = new THREE.Scene();
    const layer = new DustParticleLayer(scene, makeSharedUniforms());
    layer.attach(makeData(2));
    layer.dispose({ removeFromScene: true });
    layer.attach(makeData(3));

    expect(scene.children.length).toBe(1);
    const mesh = scene.children[0] as THREE.Mesh;
    expect(mesh.visible).toBe(false);
  });
});
