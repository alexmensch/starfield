import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyDiscBlendDefaults } from './stellata';

// Pin the disc-pass blend equation across the helper's lifecycle.
// PR #25 had to update two parallel sites for the AddEquation →
// MaxEquation switch (constructor + chart-mode swap-back). The helper
// now owns both; this test guards against future drift between the
// constructor's intent and what ends up on the material after a
// chart-mode toggle. See stellata-9mm.1 + 9mm.11.
describe('applyDiscBlendDefaults', () => {
  function makeMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({});
  }

  it('writes the four CustomBlending fields + depth flags', () => {
    const m = makeMaterial();
    applyDiscBlendDefaults(m);
    expect(m.blending).toBe(THREE.CustomBlending);
    expect(m.blendSrc).toBe(THREE.OneFactor);
    expect(m.blendDst).toBe(THREE.OneFactor);
    expect(m.blendEquation).toBe(THREE.MaxEquation);
    expect(m.depthWrite).toBe(true);
    expect(m.depthTest).toBe(true);
  });

  it('overwrites whatever was on the material before', () => {
    const m = makeMaterial();
    // Simulate the chart-mode swap-out that puts the disc material into
    // MultiplyBlending with depth off — the toggle-back must restore the
    // colour-mode defaults.
    m.blending = THREE.MultiplyBlending;
    m.depthWrite = false;
    m.depthTest = false;
    applyDiscBlendDefaults(m);
    expect(m.blending).toBe(THREE.CustomBlending);
    expect(m.depthWrite).toBe(true);
    expect(m.depthTest).toBe(true);
  });

  it('is idempotent: re-applying yields the same field values', () => {
    const m = makeMaterial();
    applyDiscBlendDefaults(m);
    const snap1 = {
      b: m.blending, s: m.blendSrc, d: m.blendDst, e: m.blendEquation,
      dw: m.depthWrite, dt: m.depthTest,
    };
    applyDiscBlendDefaults(m);
    const snap2 = {
      b: m.blending, s: m.blendSrc, d: m.blendDst, e: m.blendEquation,
      dw: m.depthWrite, dt: m.depthTest,
    };
    expect(snap2).toEqual(snap1);
  });
});
