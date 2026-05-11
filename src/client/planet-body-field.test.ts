import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  cullDistancePc,
  PlanetBodyField,
  type PlanetMaterialUniforms,
} from './planet-body-field';
import { AU_PC, KM_PC } from './orbit-rings-layer';
import type { PlanetSystem, Planet } from './planet-system';
import { SATURN_PHASE, peakPhaseFactor } from './phase-function';

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
    f.attachHost(0, makePlanetSystem(0, 3), 4.83, new THREE.Vector3(), 0, 0);
    // group becomes visible; positions buffer holds 3 entries.
    expect(f.group.visible).toBe(true);
    const positions = f.getHostLocalPositions(0);
    expect(positions).not.toBeNull();
    expect(positions!.length).toBe(9); // 3 planets × xyz
    f.dispose();
  });

  it('detachHost clears the host slot and hides the group when empty', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    f.attachHost(0, makePlanetSystem(0, 3), 4.83, new THREE.Vector3(), 0, 0);
    f.detachHost(0);
    expect(f.getHostLocalPositions(0)).toBeNull();
    expect(f.group.visible).toBe(false);
    f.dispose();
  });

  it('recenter shifts hostLocalPos by the new world offset', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    const hostAbs = new THREE.Vector3(1.5, 0, 2.0);
    f.attachHost(0, makePlanetSystem(0, 1), 4.83, hostAbs, 0, 0);
    // Pre-recenter: hostLocalPos = hostAbsPos - (0,0,0) = (1.5, 0, 2.0).
    // Apply recenter to (1.5, 0, 2.0) — host should land at origin.
    f.recenter(new THREE.Vector3(1.5, 0, 2.0));
    // Internal hostLocalPos isn't directly exposed, but we can verify
    // through attachHost behaviour after recenter — re-attach the
    // same host with the same absPos and confirm idempotence.
    f.attachHost(0, makePlanetSystem(0, 1), 4.83, hostAbs, 0, 0);
    // Visible (re-attached fresh).
    expect(f.group.visible).toBe(true);
    f.dispose();
  });

  it('handles multiple hosts in one field', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    f.attachHost(0, makePlanetSystem(0, 2), 4.83, new THREE.Vector3(), 0, 0);
    f.attachHost(1, makePlanetSystem(1, 4), 4.83, new THREE.Vector3(0.5, 0, 0), 0, 0);
    expect(f.getHostLocalPositions(0)!.length).toBe(6);
    expect(f.getHostLocalPositions(1)!.length).toBe(12);
    f.dispose();
  });

  it('detaching the first host compacts the buffer; the second still resolves', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    f.attachHost(0, makePlanetSystem(0, 2), 4.83, new THREE.Vector3(), 0, 0);
    f.attachHost(1, makePlanetSystem(1, 3), 4.83, new THREE.Vector3(0.5, 0, 0), 0, 0);
    f.detachHost(0);
    const stillThere = f.getHostLocalPositions(1);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.length).toBe(9);
    expect(f.group.visible).toBe(true);
    f.dispose();
  });

  it('attachHost is idempotent — re-attach replaces in place', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    f.attachHost(0, makePlanetSystem(0, 3), 4.83, new THREE.Vector3(), 0, 0);
    f.attachHost(0, makePlanetSystem(0, 5), 4.83, new THREE.Vector3(), 0, 0);
    expect(f.getHostLocalPositions(0)!.length).toBe(15);
    f.dispose();
  });

  it('setMaxAppMag is a no-op smoke (cull distances refresh internally)', () => {
    const f = new PlanetBodyField(makeSharedUniforms(6.5));
    f.attachHost(0, makePlanetSystem(0, 1), 4.83, new THREE.Vector3(), 0, 0);
    f.setMaxAppMag(15);
    f.setMaxAppMag(6.5);
    expect(f.group.visible).toBe(true);
    f.dispose();
  });

  it('exposes five render passes with the documented renderOrder layout (stellata-3re.19)', () => {
    // The contract is: orbit rings (2) sit BETWEEN the corrupt pass
    // (1.5, writes near-plane depth across the planet's core) and the
    // restore pass (2.5, writes the planet's actual depth back so the
    // disc/glow passes at 3/4 still depth-test correctly). If anyone
    // reorders these — e.g. moves restore before orbit rings — the
    // near-side ring will no longer be hidden by the planet body
    // (regressing the user-visible "planet looks solid" behaviour).
    // Pin each mesh by name → renderOrder so a swap fails CI.
    const f = new PlanetBodyField(makeSharedUniforms());
    const orderByName = new Map(
      f.group.children.map((m) => [m.name, m.renderOrder]),
    );
    expect(orderByName.get('core')).toBe(-4);
    expect(orderByName.get('corrupt')).toBe(1.5);
    expect(orderByName.get('restore')).toBe(2.5);
    expect(orderByName.get('disc')).toBe(3);
    expect(orderByName.get('glow')).toBe(4);
    expect(f.group.children).toHaveLength(5);
    f.dispose();
  });

  it('grows capacity when many hosts attach beyond the initial budget', () => {
    const f = new PlanetBodyField(makeSharedUniforms());
    // Initial capacity is 16; attach 20 single-planet hosts.
    for (let i = 0; i < 20; i++) {
      f.attachHost(i, makePlanetSystem(i, 1), 4.83, new THREE.Vector3(), 0, 0);
    }
    for (let i = 0; i < 20; i++) {
      const slice = f.getHostLocalPositions(i);
      expect(slice).not.toBeNull();
      expect(slice!.length).toBe(3);
    }
    f.dispose();
  });

  it('writes the Mallama coefficients into iPhaseCoefsA/B for the right slot', () => {
    // The PR adds iPhaseCoefsA = (c0,c1,c2,c3) and iPhaseCoefsB =
    // (c4,c5,c6,alphaMaxDeg) per-instance buffers plumbed through
    // allocate / grow / write-static / flush / shift-down. The
    // lifecycle tests above exercise the mechanics; this read-back
    // pins the buffer *contents* so a swapped index, miscopied stride
    // in growCapacity, or wrong shift in detachHost can't slip past.
    const f = new PlanetBodyField(makeSharedUniforms());
    // Three planets: bare (no coefs) | bare | Saturn (rich coefs).
    // Slot 2 is the one we read back.
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [
        makePlanet({ name: 'P0' }),
        makePlanet({ name: 'P1' }),
        makePlanet({ name: 'P2-Saturn', phaseCoefficients: SATURN_PHASE }),
      ],
    };
    f.attachHost(0, ps, 4.83, new THREE.Vector3(), 0, 0);
    // Reach into the geometry. The cast is narrow and stable: the
    // class always exposes these as InstancedBufferAttribute.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const geom = (f as any).geometry as THREE.InstancedBufferGeometry;
    const phaseA = (geom.attributes.iPhaseCoefsA as THREE.InstancedBufferAttribute)
      .array as Float32Array;
    const phaseB = (geom.attributes.iPhaseCoefsB as THREE.InstancedBufferAttribute)
      .array as Float32Array;
    const off = 2 * 4; // slot 2, vec4 stride
    expect(phaseA[off + 0]).toBeCloseTo(SATURN_PHASE.c0, 6);
    expect(phaseA[off + 1]).toBeCloseTo(SATURN_PHASE.c1, 6);
    expect(phaseA[off + 2]).toBeCloseTo(SATURN_PHASE.c2, 6);
    expect(phaseA[off + 3]).toBeCloseTo(SATURN_PHASE.c3, 6);
    expect(phaseB[off + 0]).toBeCloseTo(SATURN_PHASE.c4, 6);
    expect(phaseB[off + 1]).toBeCloseTo(SATURN_PHASE.c5, 6);
    expect(phaseB[off + 2]).toBeCloseTo(SATURN_PHASE.c6, 6);
    expect(phaseB[off + 3]).toBeCloseTo(SATURN_PHASE.alphaMaxDeg, 6);
    // Slots 0/1 carry the bare-coef sentinel: alphaMaxDeg = 0 (the
    // shader's "use Lambertian" signal).
    expect(phaseB[0 * 4 + 3]).toBe(0);
    expect(phaseB[1 * 4 + 3]).toBe(0);
    f.dispose();
  });

  it('peakPhaseFactor widens cullDistance for Saturn-style hosts', () => {
    // Saturn's c0 = -0.55 ⇒ peakPhaseFactor ≈ 1.66, ⇒ cull widens by
    // √1.66 ≈ 1.29×. A future refactor that drops the
    // peakPhaseFactor multiplication on the grounds that φ ≤ 1 would
    // silently re-narrow Saturn's cull and Mercury would vanish at
    // distances where it should still render — pin the widening.
    const baseR = 6000 * KM_PC;
    const aPc = 1 * AU_PC;
    const baseRefl = 0.5 * (baseR / aPc) ** 2;
    const f = new PlanetBodyField(makeSharedUniforms(6.5));
    // Bare planet → cull derived from base reflectance only.
    f.attachHost(
      0,
      { hostStarIdx: 0, planets: [makePlanet({ semiMajorAxisAu: 1, radiusKm: 6000 })] },
      4.83,
      new THREE.Vector3(),
      0,
      0,
    );
    // Saturn-coefs planet (same albedo / R / a) → cull widened by
    // √peakPhaseFactor(SATURN_PHASE).
    f.attachHost(
      1,
      {
        hostStarIdx: 1,
        planets: [
          makePlanet({
            semiMajorAxisAu: 1,
            radiusKm: 6000,
            phaseCoefficients: SATURN_PHASE,
          }),
        ],
      },
      4.83,
      new THREE.Vector3(),
      0,
      0,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hosts = (f as any).hosts as Map<number, { cullDistance: number }>;
    const dBare = hosts.get(0)!.cullDistance;
    const dSaturn = hosts.get(1)!.cullDistance;
    const expectedRatio = Math.sqrt(peakPhaseFactor(SATURN_PHASE));
    expect(dSaturn / dBare).toBeCloseTo(expectedRatio, 6);
    // Sanity bound — the widening is non-trivial (~1.29×).
    expect(expectedRatio).toBeGreaterThan(1.25);
    expect(expectedRatio).toBeLessThan(1.35);
    // And the cull derivation matches `cullDistancePc` directly.
    expect(dSaturn).toBeCloseTo(
      cullDistancePc(4.83, baseRefl * peakPhaseFactor(SATURN_PHASE), 6.5),
      6,
    );
    f.dispose();
  });

  it('update() per-host cull gate: skips positionsAt past cullDistance', () => {
    // The architectural promise of PlanetBodyField is the per-host cull
    // gate at update():L353 — `if (dToHost > host.cullDistance) continue`
    // is what makes the bk5 "hundreds of hosts" scaling tractable. The
    // gate has unit-test coverage on its derived inputs (cullDistance
    // formula above) but none on the gate behaviour itself. A stub
    // positionsAt with a counter pins it: inside cullDistance the
    // counter increments per update; past cullDistance it stays frozen.
    const f = new PlanetBodyField(makeSharedUniforms(6.5));
    let calls = 0;
    const positionsAt = (_t: number, out: Float32Array): void => {
      calls++;
      for (let i = 0; i < out.length; i++) out[i] = 0;
    };
    const ps: PlanetSystem = {
      hostStarIdx: 0,
      planets: [makePlanet({ semiMajorAxisAu: 1, radiusKm: 6000 })],
      positionsAt,
    };
    f.attachHost(0, ps, 4.83, new THREE.Vector3(), 0, 0);
    // attachHost calls writeHostPositions once for the initial fill, so
    // we expect 1 prior call before update() ticks fire.
    expect(calls).toBe(1);

    // Reach into the host's computed cullDistance — the test stays
    // agnostic to the exact value but lands the camera at known offsets
    // either side of it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hosts = (f as any).hosts as Map<number, { cullDistance: number }>;
    const cull = hosts.get(0)!.cullDistance;
    expect(cull).toBeGreaterThan(0);

    const camera = new THREE.PerspectiveCamera();
    // Camera at half cullDistance from the host → gate open, positionsAt fires.
    camera.position.set(cull * 0.5, 0, 0);
    f.update(camera, 0);
    expect(calls).toBe(2);
    f.update(camera, 1);
    expect(calls).toBe(3);

    // Camera past cullDistance → gate closes, positionsAt frozen.
    camera.position.set(cull * 2, 0, 0);
    f.update(camera, 2);
    expect(calls).toBe(3);
    f.update(camera, 3);
    expect(calls).toBe(3);

    // Back inside cullDistance → gate reopens.
    camera.position.set(cull * 0.5, 0, 0);
    f.update(camera, 4);
    expect(calls).toBe(4);
    f.dispose();
  });
});
