import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Catalog } from '../loaders/catalog-loader';
import type { FilterState } from '../stellata';
import {
  fovMinorRad,
  peakAmplitudeFactor,
  binaryCompanionFloorPc,
  minOrbitDistForStar,
  parkDistForStar,
  renderedSizePx,
  renderedDiscPxAtPeak,
  getChartDiscParams,
  ZOOM_FLOOR_FRACTION,
  VAR_TROUGH_FLOOR_FRACTION,
  BINARY_VIEWPORT_HALF_ANGLE_RAD,
  BINARY_MIN_DIST_FACTOR,
} from './star-physics';
import { R_SUN_PC, AU_PC } from '../solar-system/astronomy-constants';

// Build a minimal Catalog with `n` rows; per-row fields default to the
// non-variable / no-companion case. Tests pass per-row overrides via
// `populate` so each scenario sets exactly the fields it asserts on.
function makeCatalog(
  n: number,
  populate: (cat: Catalog) => void = () => undefined,
): Catalog {
  const cat: Catalog = {
    count: n,
    positions: new Float32Array(n * 3),
    absmag: new Float32Array(n),
    ci: new Float32Array(n),
    spectClass: new Float32Array(n),
    luminosityClass: new Uint8Array(n).fill(255),
    physicalRadius: new Float32Array(n).fill(1), // 1 Rsol
    constellation: new Float32Array(n),
    flags: new Uint8Array(n),
    companion: new Int32Array(n).fill(-1),
    periodDays: new Float32Array(n),
    amplitudeMag: new Float32Array(n),
    hip: new Uint32Array(n),
    names: new Map(),
    solIndex: -1,
    constellations: [],
  };
  populate(cat);
  return cat;
}

function makeFilter(overrides: Partial<FilterState> = {}): FilterState {
  return {
    minDistSol: 0,
    maxDistSol: 1e9,
    maxAppMag: 6,
    spectMask: 0xff,
    highlightCon: -1,
    sizeMin: 1,
    sizeMax: 8,
    sizeSpan: 8,
    activePreset: 'naked-eye',
    sizeMinOverridden: false,
    sizeMaxOverridden: false,
    sizeSpanOverridden: false,
    showConstellation: true,
    showGalacticGrid: true,
    showHud: true,
    showMilkyway: true,
    chart: false,
    ...overrides,
  };
}

function makeUniforms(overrides: Partial<{
  uFovYRad: number;
  uViewportX: number;
  uViewportY: number;
  uTime: number;
  uSecondsPerDay: number;
  uMinPeriodSec: number;
}> = {}) {
  return {
    uFovYRad: { value: overrides.uFovYRad ?? Math.PI / 3 },           // 60°
    uViewport: { value: new THREE.Vector2(overrides.uViewportX ?? 1920, overrides.uViewportY ?? 1080) },
    uTime: { value: overrides.uTime ?? 0 },
    uSecondsPerDay: { value: overrides.uSecondsPerDay ?? 86400 },
    uMinPeriodSec: { value: overrides.uMinPeriodSec ?? 60 },
  };
}

describe('star-physics / constants', () => {
  it('exports the canonical viewport-fraction values', () => {
    expect(ZOOM_FLOOR_FRACTION).toBe(0.9);
    expect(VAR_TROUGH_FLOOR_FRACTION).toBe(0.2);
  });

  it('derives BINARY_MIN_DIST_FACTOR from the 25° half-angle', () => {
    expect(BINARY_VIEWPORT_HALF_ANGLE_RAD).toBe((25 * Math.PI) / 180);
    expect(BINARY_MIN_DIST_FACTOR).toBe(1 / Math.tan(BINARY_VIEWPORT_HALF_ANGLE_RAD));
  });
});

describe('star-physics / fovMinorRad', () => {
  it('returns fovY for landscape (aspect > 1)', () => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.001, 1e9);
    expect(fovMinorRad(cam)).toBeCloseTo(Math.PI / 3, 12);
  });

  it('returns fovX for portrait (aspect < 1)', () => {
    const cam = new THREE.PerspectiveCamera(60, 9 / 16, 0.001, 1e9);
    const fovY = Math.PI / 3;
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * (9 / 16));
    expect(fovMinorRad(cam)).toBeCloseTo(fovX, 12);
    expect(fovMinorRad(cam)).toBeLessThan(fovY);
  });

  it('returns fovY for a square viewport (degenerate aspect = 1)', () => {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.001, 1e9);
    expect(fovMinorRad(cam)).toBeCloseTo(Math.PI / 3, 12);
  });
});

describe('star-physics / peakAmplitudeFactor (catalog-indexed)', () => {
  it('returns 1 for non-variables (period=0, amp=0)', () => {
    const cat = makeCatalog(1);
    expect(peakAmplitudeFactor(cat, 0)).toBe(1);
  });

  it('returns 1 for amp>0 but period=0 (irregular — no model)', () => {
    const cat = makeCatalog(1, c => { c.amplitudeMag[0] = 1.5; });
    expect(peakAmplitudeFactor(cat, 0)).toBe(1);
  });

  it('returns 1 for period>0 but amp=0', () => {
    const cat = makeCatalog(1, c => { c.periodDays[0] = 100; });
    expect(peakAmplitudeFactor(cat, 0)).toBe(1);
  });

  it('matches 10^(amp/10) when both period and amp are positive', () => {
    const cat = makeCatalog(1, c => { c.amplitudeMag[0] = 5; c.periodDays[0] = 332; });
    expect(peakAmplitudeFactor(cat, 0)).toBeCloseTo(Math.pow(10, 0.5), 12);
  });
});

describe('star-physics / binaryCompanionFloorPc', () => {
  it('returns 0 for stars without a companion', () => {
    const cat = makeCatalog(1);
    expect(binaryCompanionFloorPc(cat, 0)).toBe(0);
  });

  it('returns separation × BINARY_MIN_DIST_FACTOR when companion is set', () => {
    const cat = makeCatalog(2, c => {
      c.positions[0 * 3] = 0;
      c.positions[1 * 3] = 0.001;
      c.companion[0] = 1;
    });
    // Float32 round-trip; reconstruct expected from cat values for a bit-exact pin.
    const dx = cat.positions[1 * 3] - cat.positions[0 * 3];
    const expected = Math.sqrt(dx * dx) * BINARY_MIN_DIST_FACTOR;
    expect(binaryCompanionFloorPc(cat, 0)).toBe(expected);
  });

  it('uses 3D Euclidean separation across all three axes', () => {
    const cat = makeCatalog(2, c => {
      c.positions[0 * 3 + 0] = 0;
      c.positions[0 * 3 + 1] = 0;
      c.positions[0 * 3 + 2] = 0;
      c.positions[1 * 3 + 0] = 0.003;
      c.positions[1 * 3 + 1] = 0.004;
      c.positions[1 * 3 + 2] = 0;
      c.companion[0] = 1;
    });
    const dx = cat.positions[1 * 3] - cat.positions[0];
    const dy = cat.positions[1 * 3 + 1] - cat.positions[1];
    const dz = cat.positions[1 * 3 + 2] - cat.positions[2];
    const expected = Math.sqrt(dx * dx + dy * dy + dz * dz) * BINARY_MIN_DIST_FACTOR;
    expect(binaryCompanionFloorPc(cat, 0)).toBe(expected);
  });
});

describe('star-physics / parkDistForStar', () => {
  // fovMinor used across the parking tests — fovY = 60° at 16:9 aspect.
  const fovMinor = Math.PI / 3;

  it('parks Sol (R=1 Rsol, no variability) at AU_PC + R', () => {
    const cat = makeCatalog(1); // R defaults to 1 Rsol
    // Float32 round-trip rebuilds Reff from cat.physicalRadius[0] (not the
    // float64 literal); use the round-tripped value so the toBe match is
    // bit-exact.
    const Reff = cat.physicalRadius[0] * R_SUN_PC;
    const expected = Math.max(
      AU_PC + Reff,
      Reff / Math.tan((ZOOM_FLOOR_FRACTION * fovMinor) / 2),
    );
    expect(parkDistForStar({ catalog: cat, idx: 0, fovMinorRad: fovMinor })).toBe(expected);
    expect(parkDistForStar({ catalog: cat, idx: 0, fovMinorRad: fovMinor })).toBe(AU_PC + Reff);
  });

  it('parks a supergiant (R=1000 Rsol) on the manual-zoom floor — Reff overwhelms 1 AU', () => {
    const cat = makeCatalog(1, c => { c.physicalRadius[0] = 1000; });
    const Reff = cat.physicalRadius[0] * R_SUN_PC;
    const dMinFloor = Reff / Math.tan((ZOOM_FLOOR_FRACTION * fovMinor) / 2);
    expect(dMinFloor).toBeGreaterThan(AU_PC + Reff); // sanity: floor wins
    expect(parkDistForStar({ catalog: cat, idx: 0, fovMinorRad: fovMinor })).toBe(dMinFloor);
  });

  it('respects peak-amplitude radius for variables (Mira-like: amp=5, period=332)', () => {
    const cat = makeCatalog(1, c => {
      c.physicalRadius[0] = 332;
      c.amplitudeMag[0] = 5;
      c.periodDays[0] = 332;
    });
    const Reff = cat.physicalRadius[0] * R_SUN_PC * Math.pow(10, cat.amplitudeMag[0] / 10);
    const dMinFloor = Reff / Math.tan((ZOOM_FLOOR_FRACTION * fovMinor) / 2);
    expect(parkDistForStar({ catalog: cat, idx: 0, fovMinorRad: fovMinor })).toBe(dMinFloor);
  });

  it('bumps to binary-companion floor when companion is wide-separated', () => {
    const cat = makeCatalog(2, c => {
      c.physicalRadius[0] = 1;
      // 0.01 pc separation — orders of magnitude beyond AU.
      c.positions[1 * 3] = 0.01;
      c.companion[0] = 1;
    });
    // Reconstruct via float32 round-trip so the expectation is bit-exact.
    const sepFloor = cat.positions[1 * 3] * BINARY_MIN_DIST_FACTOR;
    expect(parkDistForStar({ catalog: cat, idx: 0, fovMinorRad: fovMinor })).toBe(sepFloor);
  });
});

describe('star-physics / minOrbitDistForStar', () => {
  const fovMinor = Math.PI / 3;

  it('returns the ZOOM_FLOOR_FRACTION-fill distance for a non-variable single star', () => {
    const cat = makeCatalog(1, c => { c.physicalRadius[0] = 10; });
    const Reff = cat.physicalRadius[0] * R_SUN_PC;
    const expected = Reff / Math.tan((ZOOM_FLOOR_FRACTION * fovMinor) / 2);
    expect(minOrbitDistForStar({ catalog: cat, idx: 0, fovMinorRad: fovMinor })).toBe(expected);
  });

  it('uses peak-amplitude radius for variables so the orbit floor matches the peak disc', () => {
    const cat = makeCatalog(1, c => {
      c.physicalRadius[0] = 100;
      c.amplitudeMag[0] = 2;
      c.periodDays[0] = 50;
    });
    const Reff = cat.physicalRadius[0] * R_SUN_PC * Math.pow(10, cat.amplitudeMag[0] / 10);
    const expected = Reff / Math.tan((ZOOM_FLOOR_FRACTION * fovMinor) / 2);
    expect(minOrbitDistForStar({ catalog: cat, idx: 0, fovMinorRad: fovMinor })).toBe(expected);
  });

  it('bumps to binary-companion floor when the companion sets a tighter requirement than disc-fill', () => {
    const cat = makeCatalog(2, c => {
      c.physicalRadius[0] = 1;
      c.positions[1 * 3] = 0.005;
      c.companion[0] = 1;
    });
    const sep = cat.positions[1 * 3] * BINARY_MIN_DIST_FACTOR;
    const Reff = cat.physicalRadius[0] * R_SUN_PC;
    const fill = Reff / Math.tan((ZOOM_FLOOR_FRACTION * fovMinor) / 2);
    expect(sep).toBeGreaterThan(fill);
    expect(minOrbitDistForStar({ catalog: cat, idx: 0, fovMinorRad: fovMinor })).toBe(sep);
  });
});

describe('star-physics / renderedSizePx', () => {
  // Sirius-like row at 2.64 pc (AT-HYG roughly): absmag = 1.4, R = 1.7 Rsol,
  // sized so the camera sits some practical distance away. The numeric
  // pins below derive from the formula directly so the test fails on any
  // shader-formula drift, not just rounding.
  function sirius() {
    const cat = makeCatalog(1, c => {
      c.physicalRadius[0] = 1.7;
      c.absmag[0] = 1.4;
    });
    // Camera 5 pc away along +x.
    const camPos = new THREE.Vector3(5, 0, 0);
    // Star at origin (localPositions = 0,0,0 by default).
    return { catalog: cat, camPos, localPositions: cat.positions };
  }

  it('returns the `appSize` floor for a far-away, non-variable, bright-enough row', () => {
    const { catalog, camPos, localPositions } = sirius();
    const uniforms = makeUniforms();
    const filter = makeFilter({ sizeMin: 1.5, sizeMax: 6, sizeSpan: 8, maxAppMag: 6 });
    // dCam = 5; appMag = catalog.absmag[0] + 5*(log10(5) - 1).
    // brightness = clamp01((maxAppMag - appMag) / sizeSpan).
    // appSize = sizeMin + sqrt(brightness) * (sizeMax - sizeMin).
    // Float32 round-trip on absmag is the precision-leaking step; compute
    // expected via the rounded value so the toBe is bit-exact.
    const got = renderedSizePx({ catalog, idx: 0, camPos, localPositions, uniforms, filter });
    const appMag = catalog.absmag[0] + 5 * (Math.log10(5) - 1);
    const brightness = Math.max(0, Math.min(1, (6 - appMag) / 8));
    const appSize = 1.5 + Math.sqrt(brightness) * (6 - 1.5);
    expect(got).toBe(appSize);
  });

  it('returns the physSize when the camera is close enough that R/d dominates', () => {
    const { catalog, localPositions } = sirius();
    const uniforms = makeUniforms();
    const filter = makeFilter();
    // Camera 0.01 AU away → R/d is huge → physSize wins.
    const camPos = new THREE.Vector3(0.01 * AU_PC, 0, 0);
    const got = renderedSizePx({ catalog, idx: 0, camPos, localPositions, uniforms, filter });
    // Reconstruct via the float32-rounded catalog value so the pin is exact.
    const dCam = Math.abs(catalog.positions[0] - camPos.x); // 0.01 AU_PC
    const R = catalog.physicalRadius[0] * R_SUN_PC;
    const fovY = Math.PI / 3;
    const viewportY = 1080;
    const expectedPhys = 2 * Math.atan(R / dCam) * (viewportY / fovY);
    expect(got).toBe(expectedPhys);
  });

  it('respects variable-star modulation at phase = ¼ (peak)', () => {
    // Algol-ish: 2.87 d, 1.27 mag amp. At time = period/4 the sin term hits 1.
    const cat = makeCatalog(1, c => {
      c.physicalRadius[0] = 2.9;
      c.absmag[0] = -0.15;
      c.amplitudeMag[0] = 1.27;
      c.periodDays[0] = 2.87;
    });
    const camPos = new THREE.Vector3(28, 0, 0);
    const localPositions = cat.positions;
    const periodSec = 2.87 * 86400;
    // Phase = 1/4 → sin(2π·¼) = 1 → magMod = +0.5*ampEff (dimmer at trough
    // here — the sign convention is that positive sin makes magMod positive,
    // which raises appMag = dimmer).
    const uniforms = makeUniforms({ uTime: periodSec / 4 });
    const filter = makeFilter({ sizeMin: 1, sizeMax: 8, sizeSpan: 8, maxAppMag: 6 });
    const got = renderedSizePx({ catalog: cat, idx: 0, camPos, localPositions, uniforms, filter });
    // The expectation isn't a single number — at this phase the rendered
    // size is the brightness-curve `appSize` modulated downward by 0.635
    // mag (half-amplitude at peak phase). Pinning the qualitative behaviour
    // — at phase ¼ the value is LESS than at phase 0 — guards the sign
    // convention without re-deriving the full formula in the test body.
    const stillUniforms = makeUniforms({ uTime: 0 });
    const stillGot = renderedSizePx({
      catalog: cat, idx: 0, camPos, localPositions, uniforms: stillUniforms, filter,
    });
    expect(got).toBeLessThan(stillGot);
  });
});

describe('star-physics / renderedDiscPxAtPeak', () => {
  it('matches the un-modulated physSize for a non-variable star', () => {
    const cat = makeCatalog(1, c => { c.physicalRadius[0] = 1; });
    const camPos = new THREE.Vector3(AU_PC * 100, 0, 0);
    const uniforms = makeUniforms();
    const got = renderedDiscPxAtPeak({ catalog: cat, idx: 0, camPos, localPositions: cat.positions, uniforms });
    const dCam = camPos.x; // star at origin
    const R = cat.physicalRadius[0] * R_SUN_PC;
    const fovY = Math.PI / 3;
    const expected = 2 * Math.atan(R / dCam) * (1080 / fovY);
    expect(got).toBe(expected);
  });

  it('uses peak-amplitude radius for variables (Mira: amp=5)', () => {
    const cat = makeCatalog(1, c => {
      c.physicalRadius[0] = 1;
      c.amplitudeMag[0] = 5;
      c.periodDays[0] = 332;
    });
    const camPos = new THREE.Vector3(AU_PC * 100, 0, 0);
    const uniforms = makeUniforms();
    const got = renderedDiscPxAtPeak({ catalog: cat, idx: 0, camPos, localPositions: cat.positions, uniforms });
    const dCam = camPos.x;
    const R = cat.physicalRadius[0] * R_SUN_PC;
    const peak = Math.pow(10, cat.amplitudeMag[0] / 10);
    const fovY = Math.PI / 3;
    const expected = 2 * Math.atan((R * peak) / dCam) * (1080 / fovY);
    expect(got).toBe(expected);
  });

  it('floors dCam at DCAM_LOG_FLOOR_PC so a camera at the star centre does not blow up', () => {
    const cat = makeCatalog(1, c => { c.physicalRadius[0] = 1; });
    const camPos = new THREE.Vector3(0, 0, 0); // identical to star pos
    const uniforms = makeUniforms();
    const got = renderedDiscPxAtPeak({ catalog: cat, idx: 0, camPos, localPositions: cat.positions, uniforms });
    expect(Number.isFinite(got)).toBe(true);
  });
});

describe('star-physics / getChartDiscParams', () => {
  it('reads the three uniform values verbatim', () => {
    const u = {
      uChartDiscMaxPx: { value: 12 },
      uChartDiscMinPx: { value: 1.5 },
      uChartMagBright: { value: 4 },
    };
    expect(getChartDiscParams(u)).toEqual({ maxPx: 12, minPx: 1.5, magBright: 4 });
  });
});
