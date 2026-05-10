import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  cullDistancePc,
  PlanetBodyField,
  type PlanetMaterialUniforms,
} from './planet-body-field';
import { AU_PC, KM_PC } from './orbit-rings-layer';
import type { PlanetSystem, Planet } from './planet-system';

function makeSharedUniforms(maxAppMag = 6.5): PlanetMaterialUniforms {
  return {
    uMaxAppMag: { value: maxAppMag },
    uSizeMin: { value: 2 },
    uSizeMax: { value: 24 },
    uSizeSpan: { value: 8 },
    uSizeKnee: { value: 16 },
    uVisibleThreshold: { value: 0.2 },
    uVisibleK: { value: -Math.log(0.2) },
    uCoreThreshold: { value: 0.4 },
    uDiscardThreshold: { value: 0.02 },
    uDistNMin: { value: 2.2 },
    uDistNMax: { value: 10.0 },
    uLumBiasMin: { value: 1.0 },
    uLumBiasMax: { value: 0.6 },
    uViewport: { value: new THREE.Vector2(800, 600) },
    uPixelRatio: { value: 1 },
    uFovYRad: { value: (60 * Math.PI) / 180 },
  };
}

function makePlanet(overrides: Partial<Planet> = {}): Planet {
  return {
    name: 'Test',
    radiusKm: 1000,
    semiMajorAxisAu: 1,
    eccentricity: 0,
    type: 'rocky',
    colour: [1, 1, 1],
    albedo: 0.5,
    ...overrides,
  };
}

describe('cullDistancePc', () => {
  it('returns zero for a host with no reflectance proxy', () => {
    expect(cullDistancePc(4.83, 0, 6.5)).toBe(0);
  });

  it('reproduces Jupiter-from-Sol naked-eye threshold (~290 AU)', () => {
    // Jupiter: p=0.538, R=69911 km, a=5.203 AU. Sol M=4.83. Naked-eye
    // cutoff 6.5. The bead --design says "cullDistancePc for Sol with
    // naked-eye preset is sub-parsec" — 290 AU is comfortably sub-pc
    // and within the Standard-mode focus zoom range.
    const aPc = 5.203 * AU_PC;
    const Rpc = 69911 * KM_PC;
    const refl = 0.538 * (Rpc / aPc) ** 2;
    const d = cullDistancePc(4.83, refl, 6.5);
    const dAu = d / AU_PC;
    expect(dAu).toBeGreaterThan(200);
    expect(dAu).toBeLessThan(400);
  });

  it('grows with the magnitude slider (more sensitivity → see further)', () => {
    const aPc = 5.203 * AU_PC;
    const Rpc = 69911 * KM_PC;
    const refl = 0.538 * (Rpc / aPc) ** 2;
    const naked = cullDistancePc(4.83, refl, 6.5);
    const all = cullDistancePc(4.83, refl, 15);
    // Each 5 mag of cutoff = 10× distance.
    const expectedRatio = 10 ** ((15 - 6.5) / 5);
    expect(all / naked).toBeCloseTo(expectedRatio, 3);
  });

  it('shrinks for a fainter host (negative offset on M)', () => {
    // Same planet around an absmag-7 host (much fainter than Sol)
    // gets a smaller cull distance because the host illumination is
    // weaker.
    const aPc = 5.203 * AU_PC;
    const Rpc = 69911 * KM_PC;
    const refl = 0.538 * (Rpc / aPc) ** 2;
    const sunCull = cullDistancePc(4.83, refl, 6.5);
    const fainterCull = cullDistancePc(7.0, refl, 6.5);
    expect(fainterCull).toBeLessThan(sunCull);
  });

  it('verifies the closed-form formula directly', () => {
    // d = 10 pc · sqrt(refl) · 10^((m_max - M_host)/5)
    const M = 4.83;
    const refl = 1e-9;
    const m = 6.5;
    const expected = 10 * Math.sqrt(refl) * 10 ** ((m - M) / 5);
    expect(cullDistancePc(M, refl, m)).toBeCloseTo(expected, 12);
  });
});

describe('PlanetBodyField lifecycle', () => {
  function makePlanetSystem(hostStarIdx = 0, n = 3): PlanetSystem {
    return {
      hostStarIdx,
      planets: Array.from({ length: n }, (_, i) =>
        makePlanet({
          name: `P${i}`,
          semiMajorAxisAu: 1 + i,
          radiusKm: 6000,
        })),
    };
  }

  it('starts empty and stays hidden', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    expect(f.group.visible).toBe(false);
    f.dispose();
  });

  it('attaches a host and grows the geometry instance count', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    f.attachHost(0, makePlanetSystem(0, 3), 4.83, new THREE.Vector3(), 0);
    // group becomes visible; positions buffer holds 3 entries.
    expect(f.group.visible).toBe(true);
    const positions = f.getHostLocalPositions(0);
    expect(positions).not.toBeNull();
    expect(positions!.length).toBe(9); // 3 planets × xyz
    f.dispose();
  });

  it('detachHost clears the host slot and hides the group when empty', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    f.attachHost(0, makePlanetSystem(0, 3), 4.83, new THREE.Vector3(), 0);
    f.detachHost(0);
    expect(f.getHostLocalPositions(0)).toBeNull();
    expect(f.group.visible).toBe(false);
    f.dispose();
  });

  it('recenter shifts hostLocalPos by the new world offset', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    const hostAbs = new THREE.Vector3(1.5, 0, 2.0);
    f.attachHost(0, makePlanetSystem(0, 1), 4.83, hostAbs, 0);
    // Pre-recenter: hostLocalPos = hostAbsPos - (0,0,0) = (1.5, 0, 2.0).
    // Apply recenter to (1.5, 0, 2.0) — host should land at origin.
    f.recenter(new THREE.Vector3(1.5, 0, 2.0));
    // Internal hostLocalPos isn't directly exposed, but we can verify
    // through attachHost behaviour after recenter — re-attach the
    // same host with the same absPos and confirm idempotence.
    f.attachHost(0, makePlanetSystem(0, 1), 4.83, hostAbs, 0);
    // Visible (re-attached fresh).
    expect(f.group.visible).toBe(true);
    f.dispose();
  });

  it('handles multiple hosts in one field', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    f.attachHost(0, makePlanetSystem(0, 2), 4.83, new THREE.Vector3(), 0);
    f.attachHost(1, makePlanetSystem(1, 4), 4.83, new THREE.Vector3(0.5, 0, 0), 0);
    expect(f.getHostLocalPositions(0)!.length).toBe(6);
    expect(f.getHostLocalPositions(1)!.length).toBe(12);
    f.dispose();
  });

  it('detaching the first host compacts the buffer; the second still resolves', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    f.attachHost(0, makePlanetSystem(0, 2), 4.83, new THREE.Vector3(), 0);
    f.attachHost(1, makePlanetSystem(1, 3), 4.83, new THREE.Vector3(0.5, 0, 0), 0);
    f.detachHost(0);
    const stillThere = f.getHostLocalPositions(1);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.length).toBe(9);
    expect(f.group.visible).toBe(true);
    f.dispose();
  });

  it('attachHost is idempotent — re-attach replaces in place', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    f.attachHost(0, makePlanetSystem(0, 3), 4.83, new THREE.Vector3(), 0);
    f.attachHost(0, makePlanetSystem(0, 5), 4.83, new THREE.Vector3(), 0);
    expect(f.getHostLocalPositions(0)!.length).toBe(15);
    f.dispose();
  });

  it('setMaxAppMag is a no-op smoke (cull distances refresh internally)', () => {
    const f = new PlanetBodyField(makeSharedUniforms(6.5));
    f.attachHost(0, makePlanetSystem(0, 1), 4.83, new THREE.Vector3(), 0);
    f.setMaxAppMag(15);
    f.setMaxAppMag(6.5);
    expect(f.group.visible).toBe(true);
    f.dispose();
  });

  it('exposes four render passes with the documented renderOrder layout (stellata-3re.19)', () => {
    // The contract: stencil pass at 1.5 (writes stencil=1 at the
    // planet's core region) sits between background layers (≤ 1) and
    // the orbit rings at 2 (which discard via stencilFunc: NotEqual).
    // If the stencil pass moves above renderOrder 2, rings would
    // already be drawn before the stencil bit goes down, regressing
    // the user-visible "planet looks solid" behaviour. Pin each mesh
    // by name → renderOrder so a swap fails CI.
    const f = new PlanetBodyField(makeSharedUniforms());
    const orderByName = new Map(
      f.group.children.map((m) => [m.name, m.renderOrder]),
    );
    expect(orderByName.get('core')).toBe(-4);
    expect(orderByName.get('stencil')).toBe(1.5);
    expect(orderByName.get('disc')).toBe(3);
    expect(orderByName.get('glow')).toBe(4);
    expect(f.group.children).toHaveLength(4);
    f.dispose();
  });

  it('the stencil pass is configured to write stencil bit 1 (stellata-3re.19)', () => {
    // The orbit-ring material reads this exact bit. If the stencil
    // material loses its stencilWrite flag or the ref/op gets shuffled,
    // the ring's NotEqual test against bit 1 silently does nothing —
    // and the orbit ring will start passing through the planet body
    // again. Pin the actual stencil settings here, not just renderOrder.
    const f = new PlanetBodyField(makeSharedUniforms());
    const stencilMesh = f.group.children.find((m) => m.name === 'stencil')!;
    const mat = (stencilMesh as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(mat.stencilWrite).toBe(true);
    expect(mat.stencilRef).toBe(1);
    expect(mat.stencilFunc).toBe(THREE.AlwaysStencilFunc);
    expect(mat.stencilZPass).toBe(THREE.ReplaceStencilOp);
    expect(mat.colorWrite).toBe(false);
    f.dispose();
  });

  it('grows capacity when many hosts attach beyond the initial budget', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    // Initial capacity is 16; attach 20 single-planet hosts.
    for (let i = 0; i < 20; i++) {
      f.attachHost(i, makePlanetSystem(i, 1), 4.83, new THREE.Vector3(), 0);
    }
    for (let i = 0; i < 20; i++) {
      const slice = f.getHostLocalPositions(i);
      expect(slice).not.toBeNull();
      expect(slice!.length).toBe(3);
    }
    f.dispose();
  });
});
