import { describe, it, expect } from 'vitest';
import {
  evaluateOrbitSkyAU,
  evaluateBinaryOffset,
  projectSkyToICRS,
} from './binary-orbit-pure';
import { AU_PC, J2000_JD } from './astronomy-constants';
import type { OrbitalElements } from '../../scripts/catalog-pure';

// Convenience builder so tests stay readable.
function elt(over: Partial<OrbitalElements>): OrbitalElements {
  return {
    P: 365.25, T: J2000_JD, e: 0, a: 1, q: 0.5,
    i: 0, omega: 0, Omega: 0, dist: 10,
    ...over,
  };
}

describe('evaluateOrbitSkyAU — face-on circular orbit', () => {
  // i=0 (face-on), e=0, omega=0, Omega=0, a=1 AU. The orbit traces a
  // unit circle in the sky plane. Tests the Thiele-Innes constants are
  // wired correctly when both rotation angles are trivial.
  const elements = elt({ a: 1, e: 0, i: 0, omega: 0, Omega: 0, P: 365.25 });

  it('separation magnitude equals a at every phase', () => {
    for (let k = 0; k < 8; k++) {
      const t = J2000_JD + (k / 8) * elements.P;
      const { northAU, eastAU } = evaluateOrbitSkyAU(elements, t);
      const r = Math.hypot(northAU, eastAU);
      expect(r).toBeCloseTo(1.0, 10);
    }
  });

  it('returns to the same position after one full period', () => {
    const t = J2000_JD + 0.137 * elements.P;
    const a0 = evaluateOrbitSkyAU(elements, t);
    const a1 = evaluateOrbitSkyAU(elements, t + elements.P);
    expect(a1.northAU).toBeCloseTo(a0.northAU, 9);
    expect(a1.eastAU).toBeCloseTo(a0.eastAU, 9);
  });

  it('sweeps all four sky-plane quadrants over one period', () => {
    const quadrants = new Set<number>();
    for (let k = 0; k < 16; k++) {
      const t = J2000_JD + (k / 16) * elements.P;
      const { northAU, eastAU } = evaluateOrbitSkyAU(elements, t);
      const q = (northAU >= 0 ? 0 : 2) + (eastAU >= 0 ? 0 : 1);
      quadrants.add(q);
    }
    expect(quadrants.size).toBe(4);
  });
});

describe('evaluateOrbitSkyAU — edge-on orbit', () => {
  // i=π/2 (edge-on), e=0, omega=0, Omega=0 → the orbit collapses to a
  // line on the sky. With our Thiele-Innes constants
  //   A = cos(ω)cos(Ω) − sin(ω)sin(Ω)cos(i) = 1
  //   B = cos(ω)sin(Ω) + sin(ω)cos(Ω)cos(i) = 0
  //   F = −sin(ω)cos(Ω) − cos(ω)sin(Ω)cos(i) = 0
  //   G = −sin(ω)sin(Ω) + cos(ω)cos(Ω)cos(i) = 0
  // so x = a·X (north only) and y = 0 (no east motion).
  const elements = elt({ e: 0, i: Math.PI / 2, omega: 0, Omega: 0 });

  it('east component is zero at all phases', () => {
    for (let k = 0; k < 12; k++) {
      const t = J2000_JD + (k / 12) * elements.P;
      const { eastAU } = evaluateOrbitSkyAU(elements, t);
      expect(Math.abs(eastAU)).toBeLessThan(1e-12);
    }
  });

  it('north component spans ±a over one period', () => {
    let nMin = Infinity, nMax = -Infinity;
    for (let k = 0; k < 64; k++) {
      const t = J2000_JD + (k / 64) * elements.P;
      const { northAU } = evaluateOrbitSkyAU(elements, t);
      nMin = Math.min(nMin, northAU);
      nMax = Math.max(nMax, northAU);
    }
    expect(nMax).toBeCloseTo(1, 6);
    expect(nMin).toBeCloseTo(-1, 6);
  });
});

describe('evaluateOrbitSkyAU — eccentric orbit', () => {
  // Eccentric, face-on. At t = T (periapsis), separation = a(1−e).
  // Half-period later (apoapsis), separation = a(1+e).
  const elements = elt({ e: 0.591, a: 19.77, P: 50.13 * 365.25 });

  it('separation at periapsis equals a(1−e)', () => {
    const { northAU, eastAU } = evaluateOrbitSkyAU(elements, J2000_JD);
    const r = Math.hypot(northAU, eastAU);
    expect(r).toBeCloseTo(elements.a * (1 - elements.e), 6);
  });

  it('separation at apoapsis equals a(1+e)', () => {
    const t = J2000_JD + elements.P / 2;
    const { northAU, eastAU } = evaluateOrbitSkyAU(elements, t);
    const r = Math.hypot(northAU, eastAU);
    expect(r).toBeCloseTo(elements.a * (1 + elements.e), 6);
  });

  it('separation stays within [a(1−e), a(1+e)] at every phase', () => {
    const rMin = elements.a * (1 - elements.e);
    const rMax = elements.a * (1 + elements.e);
    for (let k = 0; k < 32; k++) {
      const t = J2000_JD + (k / 32) * elements.P;
      const { northAU, eastAU } = evaluateOrbitSkyAU(elements, t);
      const r = Math.hypot(northAU, eastAU);
      expect(r).toBeGreaterThanOrEqual(rMin - 1e-6);
      expect(r).toBeLessThanOrEqual(rMax + 1e-6);
    }
  });
});

describe('projectSkyToICRS', () => {
  it('returns zero when the input separation is zero', () => {
    const out = projectSkyToICRS({ x: 1, y: 2, z: 3 }, 0, 0);
    expect(out.x === 0 && out.y === 0 && out.z === 0).toBe(true);
  });

  it('returns zero when the system is at the origin (degenerate)', () => {
    const out = projectSkyToICRS({ x: 0, y: 0, z: 0 }, 1, 1);
    expect(out.x === 0 && out.y === 0 && out.z === 0).toBe(true);
  });

  it('preserves separation magnitude (perpendicular to LOS)', () => {
    // System at (10, 0, 0) — RA=0, Dec=0. Sky basis: east=(0,1,0),
    // north=(0,0,1). Input (north=2, east=3) → output (0, 3, 2).
    const out = projectSkyToICRS({ x: 10, y: 0, z: 0 }, 2, 3);
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.y).toBeCloseTo(3, 12);
    expect(out.z).toBeCloseTo(2, 12);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(Math.hypot(2, 3), 12);
  });

  it('output is perpendicular to the system line-of-sight', () => {
    const sys = { x: 5, y: 7, z: -3 };
    const out = projectSkyToICRS(sys, 1.5, -0.8);
    const dot = out.x * sys.x + out.y * sys.y + out.z * sys.z;
    expect(Math.abs(dot)).toBeLessThan(1e-10);
  });

  it('east and north components are orthogonal', () => {
    const sys = { x: 5, y: 7, z: -3 };
    const east = projectSkyToICRS(sys, 0, 1);
    const north = projectSkyToICRS(sys, 1, 0);
    const dot = east.x * north.x + east.y * north.y + east.z * north.z;
    expect(Math.abs(dot)).toBeLessThan(1e-12);
  });
});

describe('evaluateBinaryOffset — J2000 baseline', () => {
  // At t = J2000_JD, the now-vs-J2000 difference is zero — the stored
  // J2000 component xyz already encodes the right position. This is the
  // core invariant of the ΔR(t) − R(J2000) baseline contract.
  const elements = elt({ e: 0.591, a: 19.77, P: 50.13 * 365.25, q: 0.33 });
  const systemXyz = { x: 2, y: -1, z: 0.5 };

  it('A-side offset is zero at t = J2000', () => {
    const out = evaluateBinaryOffset(elements, J2000_JD, false, systemXyz);
    expect(Math.hypot(out.x, out.y, out.z)).toBeLessThan(1e-15);
  });

  it('B-side offset is zero at t = J2000', () => {
    const out = evaluateBinaryOffset(elements, J2000_JD, true, systemXyz);
    expect(Math.hypot(out.x, out.y, out.z)).toBeLessThan(1e-15);
  });

  it('returns to zero after one full orbital period', () => {
    const t = J2000_JD + elements.P;
    const a = evaluateBinaryOffset(elements, t, false, systemXyz);
    const b = evaluateBinaryOffset(elements, t, true, systemXyz);
    expect(Math.hypot(a.x, a.y, a.z)).toBeLessThan(1e-9);
    expect(Math.hypot(b.x, b.y, b.z)).toBeLessThan(1e-9);
  });
});

describe('evaluateBinaryOffset — barycenter symmetry', () => {
  // Per the dch.10 design contract:
  //   A_offset = −q · ΔR
  //   B_offset = +(1−q) · ΔR
  // → A and B move in opposite directions, magnitudes split q : (1−q).
  const elements = elt({
    e: 0.591, a: 19.77, P: 50.13 * 365.25, q: 0.33,
    i: 1.1, omega: 0.7, Omega: 1.5,
  });
  const systemXyz = { x: 2, y: -1, z: 0.5 };

  it('A and B offsets are anti-parallel at every sampled phase', () => {
    for (let k = 1; k < 16; k++) {
      const t = J2000_JD + (k / 16) * elements.P;
      const a = evaluateBinaryOffset(elements, t, false, systemXyz);
      const b = evaluateBinaryOffset(elements, t, true, systemXyz);
      const aMag = Math.hypot(a.x, a.y, a.z);
      const bMag = Math.hypot(b.x, b.y, b.z);
      // Dot of the unit vectors should be exactly -1.
      const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (aMag * bMag);
      expect(dot).toBeCloseTo(-1, 10);
    }
  });

  it('magnitude ratio |A| : |B| equals q : (1−q)', () => {
    const expected = elements.q / (1 - elements.q);
    for (let k = 1; k < 16; k++) {
      const t = J2000_JD + (k / 16) * elements.P;
      const a = evaluateBinaryOffset(elements, t, false, systemXyz);
      const b = evaluateBinaryOffset(elements, t, true, systemXyz);
      const ratio = Math.hypot(a.x, a.y, a.z) / Math.hypot(b.x, b.y, b.z);
      expect(ratio).toBeCloseTo(expected, 10);
    }
  });

  it('barycenter (1−q)·A_offset + q·B_offset is zero', () => {
    for (let k = 1; k < 16; k++) {
      const t = J2000_JD + (k / 16) * elements.P;
      const a = evaluateBinaryOffset(elements, t, false, systemXyz);
      const b = evaluateBinaryOffset(elements, t, true, systemXyz);
      const cx = (1 - elements.q) * a.x + elements.q * b.x;
      const cy = (1 - elements.q) * a.y + elements.q * b.y;
      const cz = (1 - elements.q) * a.z + elements.q * b.z;
      expect(Math.abs(cx)).toBeLessThan(1e-15);
      expect(Math.abs(cy)).toBeLessThan(1e-15);
      expect(Math.abs(cz)).toBeLessThan(1e-15);
    }
  });
});

describe('evaluateBinaryOffset — Sirius-shaped orbit', () => {
  // Realistic-scale eccentric orbit modelled on Sirius A-B
  // (P = 50.13 yr, e = 0.591, a = 19.77 AU). System distance 2.64 pc;
  // mass-ratio q = 0.33 (true Sirius A-B).
  const elements = elt({
    P: 50.13 * 365.25, T: J2000_JD - 10 * 365.25,
    e: 0.591, a: 19.77, q: 0.33,
    i: 2.5, omega: 0.7, Omega: 0.8, dist: 2.64,
  });
  // System at (2.64, 0, 0) pc → easy sky-basis arithmetic.
  const systemXyz = { x: 2.64, y: 0, z: 0 };

  it('B-side offset has the expected order of magnitude (~10 AU in parsecs)', () => {
    // Apoapsis sweep: maximum offset is ~a·(1+e) AU on the B side scaled
    // by (1−q). For Sirius, ~21 AU → ~1.0e-4 pc.
    let maxOffset = 0;
    for (let k = 0; k < 32; k++) {
      const t = J2000_JD + (k / 32) * elements.P;
      const b = evaluateBinaryOffset(elements, t, true, systemXyz);
      maxOffset = Math.max(maxOffset, Math.hypot(b.x, b.y, b.z));
    }
    const expectedScale = elements.a * (1 + elements.e) * (1 - elements.q) * AU_PC;
    // Realised peak depends on inclination; allow factor-2 envelope.
    expect(maxOffset).toBeGreaterThan(expectedScale * 0.4);
    expect(maxOffset).toBeLessThan(expectedScale * 1.2);
  });
});
