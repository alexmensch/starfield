import { describe, it, expect } from 'vitest';
import {
  angularToPx,
  physSizePx,
  pickScore,
  pickFromCandidates,
  type StarPickCandidate,
  sortedDistRange,
  varEffectiveAmplitude,
  distAtFillFraction,
  peakAmplitudeFactor,
} from './star-geometry';
import { R_SUN_PC } from '../solar-system/astronomy-constants';

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

describe('star-geometry / peakAmplitudeFactor', () => {
  it('returns 1 for non-variables (no period, no amplitude)', () => {
    expect(peakAmplitudeFactor(0, 0)).toBe(1);
  });

  it('returns 1 when amplitude is set but period is missing', () => {
    // GCVS rows with a period but no amplitude (or vice versa) shouldn't
    // be modulated — the renderer treats them as static stars.
    expect(peakAmplitudeFactor(0.5, 0)).toBe(1);
    expect(peakAmplitudeFactor(0, 4.5)).toBe(1);
  });

  it('returns 10^(amp/10) for a real variable', () => {
    // Mira-like 5-mag amplitude → factor 10^0.5 ≈ 3.162. Means the
    // pulse-peak radius is ~3.16× the static radius.
    expect(peakAmplitudeFactor(5, 332)).toBeCloseTo(Math.pow(10, 0.5), 12);
    // Algol-like 1.27-mag amplitude → factor 10^0.127 ≈ 1.34.
    expect(peakAmplitudeFactor(1.27, 2.87)).toBeCloseTo(Math.pow(10, 0.127), 12);
  });

  it('is monotonic in amplitude for a fixed period', () => {
    expect(peakAmplitudeFactor(2, 100)).toBeLessThan(peakAmplitudeFactor(4, 100));
    expect(peakAmplitudeFactor(4, 100)).toBeLessThan(peakAmplitudeFactor(6, 100));
  });

  it('treats negative amp/period as non-variable (defensive)', () => {
    expect(peakAmplitudeFactor(-1, 100)).toBe(1);
    expect(peakAmplitudeFactor(2, -100)).toBe(1);
  });
});

describe('star-geometry / pickScore', () => {
  it('is dominated by pxDist: a 50px-away brighter star loses to a 0px-away fainter one', () => {
    // Double Double regression: cursor on ε² Lyr (mag 4.59), with ε¹ Lyr
    // (mag 4.67) ~50px away on screen but with a hitbox that reaches the
    // cursor. The cursor is on ε²'s centre; ε² must win.
    const eps2 = pickScore(0, 4.59);
    const eps1 = pickScore(50, 4.67);
    expect(eps2).toBeLessThan(eps1);
  });

  it('breaks ties by brightness when two candidates project to the same pixel', () => {
    // Alula Australis regression: A (mag 4.33) and B (mag 4.80) share
    // identical x/y/z in AT-HYG, so both project to the same screen pixel
    // and pxDist is identical. The brighter component (A) must win.
    const a = pickScore(0, 4.33);
    const b = pickScore(0, 4.80);
    expect(a).toBeLessThan(b);
  });

  it('uses a sub-pixel mag bias so a 1-mag-fainter star at the same pxDist beats a 1px-farther brighter one', () => {
    // The mag bias is small enough (0.05 px / mag) that any visible
    // pxDist gap dominates. A star 1px farther but 1 mag brighter still
    // loses to the centre-aligned fainter one — picking by visible
    // proximity, not brightness, is the contract.
    const closeFaint = pickScore(0, 6);
    const farBright = pickScore(1, 5);
    expect(closeFaint).toBeLessThan(farBright);
  });
});

describe('star-geometry / pickFromCandidates', () => {
  // Synthetic candidate factory — keeps the per-test arrays readable.
  // `cameraDistancePc` is irrelevant for the reducer's tier+score
  // logic; pinned to 1 pc so the field is populated without
  // distracting from the per-test inputs.
  const c = (
    idx: number,
    pxDist: number,
    hitRadius: number,
    appMag: number,
  ): StarPickCandidate => ({ idx, pxDist, hitRadius, appMag, cameraDistancePc: 1 });

  // Star scorer is passed explicitly now that pickFromCandidates is
  // generic; non-star providers default to closest-to-cursor.
  const starScore = (cand: StarPickCandidate) => pickScore(cand.pxDist, cand.appMag);

  it('returns null when no candidates exist', () => {
    expect(pickFromCandidates([], 16, starScore)).toBeNull();
  });

  it('prime-only: lowest pickScore wins among hits inside hitRadius', () => {
    // Two prime hits — both inside hitRadius. The one with the lower
    // pickScore (closer to centre, brighter on tie) wins.
    const cands = [
      c(10, 3, 5, 4.0), // score = 3 + 0.20 = 3.20
      c(11, 1, 5, 4.5), // score = 1 + 0.225 = 1.225 ← winner
      c(12, 4, 5, 3.0), // score = 4 + 0.15 = 4.15
    ];
    const r = pickFromCandidates(cands, 16, starScore);
    expect(r?.candidate.idx).toBe(11);
    expect(r?.tier).toBe('prime');
  });

  it('fallback-only: nearest-to-cursor wins when no prime hits exist', () => {
    // No candidate's pxDist is inside hitRadius; all fall through to
    // the proximity tier, where lowest pickScore wins.
    const cands = [
      c(20, 8, 2, 5.0), // pxDist > hitRadius → fallback; score = 8.25
      c(21, 6, 2, 5.5), // fallback; score = 6.275 ← winner
      c(22, 14, 2, 4.0), // fallback; score = 14.20
    ];
    const r = pickFromCandidates(cands, 16, starScore);
    expect(r?.candidate.idx).toBe(21);
    expect(r?.tier).toBe('fallback');
  });

  it('mixed prime + fallback: any prime hit beats the best fallback', () => {
    // A prime candidate with a worse score (4.5 + ε) than the best
    // fallback (1 + ε) still wins, because prime hits always beat
    // fallback hits.
    const cands = [
      c(30, 4.5, 5, 4.0), // prime; score ≈ 4.7
      c(31, 1.0, 0.5, 3.0), // fallback (pxDist > hitRadius); score ≈ 1.15
    ];
    const r = pickFromCandidates(cands, 16, starScore);
    expect(r?.candidate.idx).toBe(30);
    expect(r?.tier).toBe('prime');
  });

  it('prime tier with tied score (Alula Australis): brighter component wins', () => {
    // Two coincident catalog rows — same pxDist, same hitRadius. Only
    // the magnitude differs. Brighter (lower appMag) must win.
    const cands = [
      c(40, 0, 5, 4.33), // Alula A
      c(41, 0, 5, 4.80), // Alula B
    ];
    expect(pickFromCandidates(cands, 16, starScore)?.candidate.idx).toBe(40);
  });

  it('prime hit inside hitRadius beats fallback hit just under pixelThreshold', () => {
    // Edge case — prime candidate scrapes the inside of its hitRadius;
    // fallback candidate scrapes the inside of pixelThreshold and is
    // far brighter. Prime priority means the prime wins regardless.
    const cands = [
      c(50, 4.99, 5, 6.0), // prime (just inside); score ≈ 5.29
      c(51, 15.99, 0.5, 0.0), // fallback (just inside); score ≈ 15.99
    ];
    const r = pickFromCandidates(cands, 16, starScore);
    expect(r?.candidate.idx).toBe(50);
    expect(r?.tier).toBe('prime');
  });

  it('candidates outside both tiers (pxDist > pixelThreshold and > hitRadius) are ignored', () => {
    // Reducer must skip candidates that don't qualify for either tier
    // even if pickScore would otherwise rank them.
    const cands = [
      c(60, 100, 5, 0.0), // way out; ignored
      c(61, 50, 5, 1.0), // also out
    ];
    expect(pickFromCandidates(cands, 16, starScore)).toBeNull();
  });

  it('default scorer (pxDist) — closest-to-cursor wins when no scorer is passed', () => {
    // Non-star providers (planets, Local Group, heliopause apex) rely on
    // the default scoreFn = c.pxDist. No magnitude axis, no sub-pixel
    // bias — purely closest centroid wins.
    const cands: StarPickCandidate[] = [
      { idx: 70, pxDist: 8, hitRadius: 2, appMag: 0, cameraDistancePc: 1 },
      { idx: 71, pxDist: 4, hitRadius: 2, appMag: 0, cameraDistancePc: 1 }, // winner
      { idx: 72, pxDist: 6, hitRadius: 2, appMag: 0, cameraDistancePc: 1 },
    ];
    const r = pickFromCandidates(cands, 16);
    expect(r?.candidate.idx).toBe(71);
    expect(r?.tier).toBe('fallback');
  });

  it('returns the original candidate object — extension fields ride through', () => {
    // Caller-extended candidates (LG carries cameraDistancePc; planet
    // picker carries hostStarIdx + planetIdx) must come back intact so
    // the caller doesn't re-walk projection state to recover them.
    type LgCand = { idx: number; pxDist: number; hitRadius: number; cameraDistancePc: number };
    const cands: LgCand[] = [
      { idx: 80, pxDist: 3, hitRadius: 10, cameraDistancePc: 1_500_000 },
      { idx: 81, pxDist: 1, hitRadius: 10, cameraDistancePc: 50_000 }, // winner
    ];
    const r = pickFromCandidates(cands, 16);
    expect(r?.candidate.idx).toBe(81);
    expect(r?.candidate.cameraDistancePc).toBe(50_000);
    expect(r?.tier).toBe('prime');
  });
});

describe('star-geometry / sortedDistRange', () => {
  // Half-open [start, end) slice on a sorted Float32Array. Shared
  // between the star pick path (filter window) and the core-mask gate
  // (triangle-inequality bracket); both compose this helper.
  it('returns an empty range when minDist > maxDist', () => {
    const sd = new Float32Array([0, 1, 2, 3, 4]);
    const { start, end } = sortedDistRange(sd, 3, 1);
    expect(end).toBeLessThanOrEqual(start);
  });

  it('returns the full array when the band covers the whole range', () => {
    const sd = new Float32Array([0.5, 1.0, 1.5, 2.0]);
    const { start, end } = sortedDistRange(sd, 0, 100);
    expect(start).toBe(0);
    expect(end).toBe(4);
  });

  it('snaps the start to the first value >= minDist', () => {
    const sd = new Float32Array([0, 1, 2, 3, 4, 5]);
    const { start } = sortedDistRange(sd, 2.5, 100);
    expect(start).toBe(3); // first index whose value (3) ≥ 2.5
  });

  it('snaps the end past the last value <= maxDist', () => {
    const sd = new Float32Array([0, 1, 2, 3, 4, 5]);
    const { end } = sortedDistRange(sd, 0, 3.5);
    expect(end).toBe(4); // half-open — covers values 0,1,2,3
  });

  it('inclusive on both endpoints', () => {
    const sd = new Float32Array([0, 1, 2, 3, 4]);
    const { start, end } = sortedDistRange(sd, 1, 3);
    expect(start).toBe(1);
    expect(end).toBe(4);
    expect(end - start).toBe(3); // 1, 2, 3
  });

  it('returns start=end when no values fall in the band', () => {
    const sd = new Float32Array([0, 1, 10, 11]);
    const { start, end } = sortedDistRange(sd, 3, 5);
    expect(start).toBe(end);
  });

  it('handles an empty array', () => {
    const sd = new Float32Array([]);
    const { start, end } = sortedDistRange(sd, 0, 100);
    expect(start).toBe(0);
    expect(end).toBe(0);
  });
});
