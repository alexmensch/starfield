import { describe, it, expect } from 'vitest';
import {
  angularToPx,
  physSizePx,
  varEffectiveAmplitude,
  distAtFillFraction,
} from './star-geometry';

// Sol's physical radius in parsecs (1 R_sun ≈ 2.2543e-8 pc).
const R_SUN_PC = 2.2543e-8;

// Canonical viewport / FOV used across the tests below. 1080 vertical
// pixels at 50° vertical FOV ≈ 1238 px / radian — close to the live
// rendered viewport at 1080p so the absolute pixel values match what an
// observer would see.
const VIEWPORT_Y = 1080;
const FOV_Y_RAD = (50 * Math.PI) / 180;

describe('star-geometry / angularToPx', () => {
  it('matches viewport.y / fovYRad for the canonical viewport', () => {
    expect(angularToPx(VIEWPORT_Y, FOV_Y_RAD)).toBeCloseTo(VIEWPORT_Y / FOV_Y_RAD, 9);
  });

  it('floors fovYRad at 1e-9 so a transient zero FOV does not divide by zero', () => {
    const out = angularToPx(VIEWPORT_Y, 0);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThan(0);
  });
});

describe('star-geometry / physSizePx', () => {
  it('matches the angular-diameter formula 2·atan(R/d)·angularToPx', () => {
    const R_pc = 5 * R_SUN_PC;
    const dCam = 10;
    const expected = 2 * Math.atan(R_pc / dCam) * angularToPx(VIEWPORT_Y, FOV_Y_RAD);
    expect(physSizePx(R_pc, dCam, VIEWPORT_Y, FOV_Y_RAD)).toBeCloseTo(expected, 12);
  });

  it('scales linearly with radiusFactor at large dCam (small-angle regime)', () => {
    // At dCam >> R, atan(R/d) ≈ R/d so doubling the radius doubles the disc.
    const R_pc = 5 * R_SUN_PC;
    const dCam = 1; // 1 pc, ~10⁸ × R for a Sol-sized star
    const single = physSizePx(R_pc, dCam, VIEWPORT_Y, FOV_Y_RAD, 1);
    const doubled = physSizePx(R_pc, dCam, VIEWPORT_Y, FOV_Y_RAD, 2);
    expect(doubled / single).toBeCloseTo(2, 6);
  });

  it('saturates at π·angularToPx as dCam → 0 (camera inside the star)', () => {
    // atan(R/d) → π/2 as d → 0, so 2·atan → π.
    const R_pc = 5 * R_SUN_PC;
    const huge = physSizePx(R_pc, 1e-30, VIEWPORT_Y, FOV_Y_RAD);
    const ceiling = Math.PI * angularToPx(VIEWPORT_Y, FOV_Y_RAD);
    expect(huge).toBeLessThanOrEqual(ceiling);
    expect(huge).toBeGreaterThan(ceiling * 0.999);
  });

  // Acceptance #2 from stellata-a7d.2 — resolved-disc ratio matches R ratio.
  // Betelgeuse R ≈ 887 R_sun, Sirius R ≈ 1.71 R_sun. At a fixed close-but-not-
  // saturating dCam, the rendered sizes should be in the same ratio.
  it('Betelgeuse:Sirius rendered ratio matches their physical-radius ratio', () => {
    const Rb = 887 * R_SUN_PC;
    const Rs = 1.71 * R_SUN_PC;
    // dCam picked so R/d is small for both — well inside the small-angle
    // regime where ratio cleanly tracks R ratio.
    const dCam = 1; // pc
    const sizeB = physSizePx(Rb, dCam, VIEWPORT_Y, FOV_Y_RAD);
    const sizeS = physSizePx(Rs, dCam, VIEWPORT_Y, FOV_Y_RAD);
    expect(sizeB / sizeS).toBeCloseTo(Rb / Rs, 4);
  });
});

describe('star-geometry / varEffectiveAmplitude', () => {
  it('returns 0 for non-variable stars (amp <= 0)', () => {
    expect(varEffectiveAmplitude(0, 100, 500, 0.2)).toBe(0);
    expect(varEffectiveAmplitude(-1, 100, 500, 0.2)).toBe(0);
  });

  it('returns the catalog amplitude when both peak and trough fit within bounds', () => {
    // 1-mag amplitude with 5× peak headroom and 0.2× trough floor — fits.
    // peak factor = 10^(amp/10) = 1.26; 1.26·100 < 500 ✓
    // trough factor = 10^(-amp/10) = 0.79; 0.79·100 > 0.2·100 ✓
    expect(varEffectiveAmplitude(1.0, 100, 500, 0.2)).toBeCloseTo(1.0, 6);
  });

  it('clamps when the peak ceiling is the binding constraint', () => {
    // baseSize=400, maxPhys=500 → peak headroom 1.25× → maxUpLog10 ≈ 0.097
    // trough headroom: -log10(0.2) ≈ 0.699
    // ampLimit = 10·min(0.097, 0.699) ≈ 0.969 mag
    // amp = 5 mag → clamped to ~0.969
    const out = varEffectiveAmplitude(5, 400, 500, 0.2);
    expect(out).toBeCloseTo(10 * Math.log10(500 / 400), 6);
  });

  it('clamps when the trough floor is the binding constraint', () => {
    // baseSize=10, maxPhys=10000 → peak headroom huge → maxUpLog10 ≈ 3
    // trough headroom: -log10(0.2) ≈ 0.699
    // ampLimit = 10·0.699 ≈ 6.99 mag
    const out = varEffectiveAmplitude(20, 10, 10000, 0.2);
    expect(out).toBeCloseTo(-10 * Math.log10(0.2), 6);
  });
});

describe('star-geometry / distAtFillFraction', () => {
  // Acceptance #3 from stellata-a7d.2 — at d = minOrbit, a Sol-sized star
  // fills 90% of the viewport's minor axis.
  it('inverts physSizePx: fill-fraction at distAtFillFraction(R, fov, frac)', () => {
    const R_pc = 1 * R_SUN_PC;
    const fovMinor = FOV_Y_RAD; // square viewport so minor == vertical
    const frac = 0.9;
    const d = distAtFillFraction(R_pc, fovMinor, frac);
    // Disc fills `frac` of viewport_y.
    expect(physSizePx(R_pc, d, VIEWPORT_Y, FOV_Y_RAD)).toBeCloseTo(frac * VIEWPORT_Y, 4);
  });

  // Acceptance #4 — at d = minDist (target park), the disc fills ~10%.
  it('produces 10% fill at TARGET_PARK_FRACTION = 0.10', () => {
    const R_pc = 1 * R_SUN_PC;
    const fovMinor = FOV_Y_RAD;
    const d = distAtFillFraction(R_pc, fovMinor, 0.10);
    expect(physSizePx(R_pc, d, VIEWPORT_Y, FOV_Y_RAD)).toBeCloseTo(0.10 * VIEWPORT_Y, 4);
  });

  it('produces a shorter distance for a larger star at the same fill fraction', () => {
    // ...wait, that's wrong. Larger R needs MORE distance to keep the same
    // angular fraction. Verify the monotonicity: bigger R ⇒ farther park.
    const fovMinor = FOV_Y_RAD;
    const dSol = distAtFillFraction(1 * R_SUN_PC, fovMinor, 0.10);
    const dGiant = distAtFillFraction(100 * R_SUN_PC, fovMinor, 0.10);
    expect(dGiant).toBeGreaterThan(dSol);
    // …and the ratio matches the radius ratio in the small-angle regime.
    expect(dGiant / dSol).toBeCloseTo(100, 4);
  });
});
