import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { StarPipeline } from './star-pipeline';
import type { Catalog } from './loaders/catalog-loader';

function makeCatalog(count: number): Catalog {
  return {
    count,
    positions: new Float32Array(count * 3),
    absmag: new Float32Array(count),
    ci: new Float32Array(count),
    spectClass: new Float32Array(count),
    luminosityClass: new Uint8Array(count),
    physicalRadius: new Float32Array(count).fill(1),
    constellation: new Float32Array(count),
    flags: new Uint8Array(count),
    companion: new Int32Array(count).fill(-1),
    periodDays: new Float32Array(count),
    amplitudeMag: new Float32Array(count),
    hip: new Uint32Array(count),
    names: new Map(),
    solIndex: -1,
    constellations: [],
  };
}

function makeOpts(count = 4) {
  const catalog = makeCatalog(count);
  const sharedUniforms = {
    uCameraPos: { value: new THREE.Vector3() },
    uTime: { value: 0 },
  };
  return {
    scene: new THREE.Scene(),
    catalog,
    logRadii: new Float32Array(count),
    lumClassF32: new Float32Array(count),
    distSol: new Float32Array(count),
    localPositions: new Float32Array(count * 3),
    vertexShader: 'void main(){ gl_Position = vec4(0.0); }',
    fragmentShader: 'void main(){}',
    sharedUniforms,
    boundingSphereRadiusPc: 60_000,
  };
}

describe('StarPipeline', () => {
  it('adds three meshes to the scene with the expected renderOrders', () => {
    const opts = makeOpts();
    const pipe = new StarPipeline(opts);

    const meshes = opts.scene.children.filter(
      (c): c is THREE.Mesh => (c as THREE.Mesh).isMesh,
    );
    expect(meshes).toHaveLength(3);
    expect(meshes).toContain(pipe.coreMaskMesh);
    expect(meshes).toContain(pipe.discMesh);
    expect(meshes).toContain(pipe.glowMesh);
    expect(pipe.coreMaskMesh.renderOrder).toBe(-4);
    expect(pipe.discMesh.renderOrder).toBe(0);
    expect(pipe.glowMesh.renderOrder).toBe(1);
    expect(pipe.coreMaskMesh.visible).toBe(false);
    expect(pipe.discMesh.frustumCulled).toBe(false);
    expect(pipe.glowMesh.frustumCulled).toBe(false);
    expect(pipe.coreMaskMesh.frustumCulled).toBe(false);
  });

  it('shares one geometry across all three meshes', () => {
    const pipe = new StarPipeline(makeOpts());
    expect(pipe.coreMaskMesh.geometry).toBe(pipe.geometry);
    expect(pipe.discMesh.geometry).toBe(pipe.geometry);
    expect(pipe.glowMesh.geometry).toBe(pipe.geometry);
  });

  it('shares uniform value-objects by reference across the three passes', () => {
    const opts = makeOpts();
    const pipe = new StarPipeline(opts);
    // Shared keys map to the same value-objects on every pass; only
    // uRenderMode is per-material.
    expect(pipe.discMaterial.uniforms.uCameraPos).toBe(opts.sharedUniforms.uCameraPos);
    expect(pipe.glowMaterial.uniforms.uCameraPos).toBe(opts.sharedUniforms.uCameraPos);
    expect(pipe.coreMaskMaterial.uniforms.uCameraPos).toBe(opts.sharedUniforms.uCameraPos);
    expect(pipe.discMaterial.uniforms.uTime).toBe(pipe.glowMaterial.uniforms.uTime);
    // uRenderMode differs per pass.
    expect(pipe.discMaterial.uniforms.uRenderMode.value).toBe(1);
    expect(pipe.glowMaterial.uniforms.uRenderMode.value).toBe(0);
    expect(pipe.coreMaskMaterial.uniforms.uRenderMode.value).toBe(2);
  });

  it('binds the caller-owned localPositions buffer to iPosition', () => {
    const opts = makeOpts(2);
    opts.localPositions.set([1, 2, 3, 4, 5, 6]);
    const pipe = new StarPipeline(opts);
    const attr = pipe.geometry.getAttribute('iPosition') as THREE.InstancedBufferAttribute;
    expect(attr).toBe(pipe.iPositionAttr);
    // Buffer identity preserved — recenterOrigin rewrites this same
    // Float32Array in place and bumps needsUpdate.
    expect(attr.array).toBe(opts.localPositions);
    expect(attr.usage).toBe(THREE.DynamicDrawUsage);
  });

  it('configures disc material with calibrated blend defaults', () => {
    const pipe = new StarPipeline(makeOpts());
    expect(pipe.discMaterial.blending).toBe(THREE.CustomBlending);
    expect(pipe.discMaterial.blendSrc).toBe(THREE.OneFactor);
    expect(pipe.discMaterial.blendDst).toBe(THREE.OneFactor);
    expect(pipe.discMaterial.blendEquation).toBe(THREE.MaxEquation);
    expect(pipe.discMaterial.depthWrite).toBe(true);
    expect(pipe.discMaterial.depthTest).toBe(true);
    expect(pipe.discMaterial.transparent).toBe(true);
  });

  it('configures glow material as additive with depth-test only', () => {
    const pipe = new StarPipeline(makeOpts());
    expect(pipe.glowMaterial.blending).toBe(THREE.AdditiveBlending);
    expect(pipe.glowMaterial.depthWrite).toBe(false);
    expect(pipe.glowMaterial.depthTest).toBe(true);
    expect(pipe.glowMaterial.transparent).toBe(true);
  });

  it('configures core-mask material as depth-only (colorWrite off)', () => {
    const pipe = new StarPipeline(makeOpts());
    expect(pipe.coreMaskMaterial.depthWrite).toBe(true);
    expect(pipe.coreMaskMaterial.depthTest).toBe(true);
    expect(pipe.coreMaskMaterial.colorWrite).toBe(false);
  });

  it('setMonochromeBlend(true) swaps disc + glow into multiply', () => {
    const pipe = new StarPipeline(makeOpts());
    pipe.setMonochromeBlend(true);
    expect(pipe.discMaterial.blending).toBe(THREE.MultiplyBlending);
    expect(pipe.discMaterial.depthWrite).toBe(false);
    expect(pipe.discMaterial.depthTest).toBe(false);
    expect(pipe.glowMaterial.blending).toBe(THREE.MultiplyBlending);
    expect(pipe.glowMaterial.depthTest).toBe(false);
  });

  it('setMonochromeBlend(false) restores the calibrated defaults', () => {
    const pipe = new StarPipeline(makeOpts());
    pipe.setMonochromeBlend(true);
    pipe.setMonochromeBlend(false);
    expect(pipe.discMaterial.blending).toBe(THREE.CustomBlending);
    expect(pipe.discMaterial.blendEquation).toBe(THREE.MaxEquation);
    expect(pipe.discMaterial.depthWrite).toBe(true);
    expect(pipe.discMaterial.depthTest).toBe(true);
    expect(pipe.glowMaterial.blending).toBe(THREE.AdditiveBlending);
    expect(pipe.glowMaterial.depthTest).toBe(true);
  });

  it('dispose() releases geometry + all three materials and detaches meshes', () => {
    const opts = makeOpts();
    const pipe = new StarPipeline(opts);
    const geomSpy = vi.spyOn(pipe.geometry, 'dispose');
    const discSpy = vi.spyOn(pipe.discMaterial, 'dispose');
    const glowSpy = vi.spyOn(pipe.glowMaterial, 'dispose');
    const maskSpy = vi.spyOn(pipe.coreMaskMaterial, 'dispose');

    pipe.dispose();

    expect(geomSpy).toHaveBeenCalledOnce();
    expect(discSpy).toHaveBeenCalledOnce();
    expect(glowSpy).toHaveBeenCalledOnce();
    expect(maskSpy).toHaveBeenCalledOnce();
    expect(opts.scene.children).toHaveLength(0);
  });
});
