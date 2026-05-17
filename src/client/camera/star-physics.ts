// Per-star camera/screen-geometry helpers. Extracted from stellata.ts
// in 9mm.194.9 — these were a cluster of methods (renderedSizePx,
// parkDistForStar, ...) that read `this.camera` / `this.catalog` /
// `this.material.uniforms` / `this.filter`. Lifted here as pure
// functions parameterised on those inputs so the integration shell
// stops holding camera/screen math, and so the formulae are
// unit-testable without a Three.js scene.
//
// Composes the lower-level primitives in `star-geometry.ts`
// (`physSizePx`, `varEffectiveAmplitude`, `distAtFillFraction`,
// `peakAmplitudeFactor`) and `focus-transition.ts` (`parkDistance`).
// Layer responsibilities:
//   star-geometry.ts — pure formulae (no catalog, no uniforms).
//   star-physics.ts  — catalog-indexed wrappers (this file).
//   stellata.ts      — wires the per-frame uniforms and dispatches.

import * as THREE from 'three';
import type { Catalog } from '../loaders/catalog-loader';
import type { FilterState } from '../stellata';
import {
  physSizePx,
  varEffectiveAmplitude,
  distAtFillFraction,
  peakAmplitudeFactor as peakAmplitudeFactorPrim,
} from './star-geometry';
import { parkDistance } from './focus-transition';
import { R_SUN_PC } from '../solar-system/astronomy-constants';
import { DCAM_LOG_FLOOR_PC } from './timing';

// Target screen-fill fraction of the viewport minor axis at the manual-
// zoom orbit floor. The shader reads this as `uMaxPhysFrac` and clamps
// the per-star disc to it; the auto-park calibration uses the same value
// so a star's pulse peak lands at exactly this fraction at closest
// approach. Hoisted here so stellata.ts seeds the uniform from the same
// constant the orbit-floor + park-distance math reads.
export const ZOOM_FLOOR_FRACTION = 0.9;

// Trough floor for variable-star disc compression — the disc is allowed
// to shrink to this fraction of its un-modulated `baseSize` at the
// variability minimum. The shader reads this as `uVarTroughFrac`; the
// renderedSizePx path applies the same `varEffectiveAmplitude` rule to
// keep the SVG focus ring and disc mask aligned with the rendered disc.
export const VAR_TROUGH_FLOOR_FRACTION = 0.2;

// Half-angle of the cone we keep a known binary companion inside when
// the camera parks on the primary. 25° was chosen so the companion is
// comfortably in frame at typical FOVs without dictating the park
// distance for wide separations.
export const BINARY_VIEWPORT_HALF_ANGLE_RAD = (25 * Math.PI) / 180;

// Distance-per-separation factor for the binary-companion floor:
// d = separation × BINARY_MIN_DIST_FACTOR keeps the companion at the
// half-angle above.
export const BINARY_MIN_DIST_FACTOR = 1 / Math.tan(BINARY_VIEWPORT_HALF_ANGLE_RAD);

// Subset of the star-shader uniforms read by renderedSizePx /
// renderedDiscPxAtPeak. The fields shape-match `THREE.IUniform<T>` so
// callers pass `material.uniforms` directly under a typed assertion.
export interface StarPhysicsUniforms {
  uFovYRad: { value: number };
  uViewport: { value: THREE.Vector2 };
  uTime: { value: number };
  uSecondsPerDay: { value: number };
  uMinPeriodSec: { value: number };
}

// Subset consumed by getChartDiscParams.
export interface ChartDiscUniforms {
  uChartDiscMaxPx: { value: number };
  uChartDiscMinPx: { value: number };
  uChartMagBright: { value: number };
}

// Smaller of the camera's vertical and horizontal FOV in radians. The
// disc-fill geometry uses the minor axis so the target fraction reads
// consistently in both portrait and landscape viewports.
export function fovMinorRad(camera: THREE.PerspectiveCamera): number {
  const fovY = (camera.fov * Math.PI) / 180;
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect);
  return Math.min(fovX, fovY);
}

// Peak-amplitude radius factor for a catalog row. At brightest phase
// `magMod = -0.5·amp`, so `radiusFactor = 10^(amp/10)`. Returns 1 for
// non-variables (period = 0 or amplitude = 0). Feeds the orbit floor
// and parking distance so the pulse peak (not the static R) hits
// ZOOM_FLOOR_FRACTION at closest approach and the navigate-mode arrow
// fade reads a phase-stable disc envelope.
export function peakAmplitudeFactor(catalog: Catalog, idx: number): number {
  return peakAmplitudeFactorPrim(
    catalog.amplitudeMag[idx],
    catalog.periodDays[idx],
  );
}

// Floor on the focused-star camera distance imposed by a binary
// companion: keeps the partner inside the BINARY_VIEWPORT_HALF_ANGLE
// cone. Returns 0 for stars without a flagged companion.
export function binaryCompanionFloorPc(catalog: Catalog, idx: number): number {
  const comp = catalog.companion[idx];
  if (comp < 0) return 0;
  const p = catalog.positions;
  const dx = p[comp * 3] - p[idx * 3];
  const dy = p[comp * 3 + 1] - p[idx * 3 + 1];
  const dz = p[comp * 3 + 2] - p[idx * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * BINARY_MIN_DIST_FACTOR;
}

export interface ParkArgs {
  catalog: Catalog;
  idx: number;
  /** Pre-computed via `fovMinorRad(camera)` so callers can amortise the
   *  conversion across multiple stars in the same frame. */
  fovMinorRad: number;
}

// Manual-zoom floor for TrackballControls when a star is focused. The
// camera can orbit down to where the focused star's true angular disc
// fills ZOOM_FLOOR_FRACTION of the viewport's minor axis — same on-
// screen coverage for any star, regardless of physical radius. For
// variables, R is bumped to peak-amplitude so the pulse peak hits
// ZOOM_FLOOR_FRACTION and the trough is correspondingly smaller, rather
// than the static R hitting the floor and the peak overshooting the
// viewport. Binary companions still get the half-angle bump so the
// partner stays in frame.
export function minOrbitDistForStar(args: ParkArgs): number {
  const R = Math.max(args.catalog.physicalRadius[args.idx], 1e-9) * R_SUN_PC;
  const Reff = R * peakAmplitudeFactor(args.catalog, args.idx);
  const base = distAtFillFraction(Reff, args.fovMinorRad, ZOOM_FLOOR_FRACTION);
  return Math.max(base, binaryCompanionFloorPc(args.catalog, args.idx));
}

// Auto-park target — composed from the generic `parkDistance` primitive
// with star-specific inputs: Reff = R · peakAmplitudeFactor (variables
// park clear of their pulse peak), the 90 %-fill manual-zoom floor as
// dMinFloor, and the binary-companion bump as the optional extraFloor.
// Result is "1 AU outside the surface, but never closer than dMin or
// the companion floor."
export function parkDistForStar(args: ParkArgs): number {
  const R = Math.max(args.catalog.physicalRadius[args.idx], 1e-9) * R_SUN_PC;
  const Reff = R * peakAmplitudeFactor(args.catalog, args.idx);
  const dMinFloor = distAtFillFraction(Reff, args.fovMinorRad, ZOOM_FLOOR_FRACTION);
  return parkDistance({
    R_pc: Reff,
    dMinFloor,
    extraFloor: binaryCompanionFloorPc(args.catalog, args.idx),
  });
}

export interface RenderedSizeArgs {
  catalog: Catalog;
  idx: number;
  camPos: Readonly<THREE.Vector3>;
  localPositions: Float32Array;
  uniforms: StarPhysicsUniforms;
  filter: Readonly<FilterState>;
}

// Approximate the GPU-rendered pixel size of a star's quad so SVG /
// overlay code (focus ring, disc mask, distance-vector tip) can align
// to the rendered disc edge. Mirrors the vertex-shader angular-diameter
// formula and the variability-compression rule in star.vert.glsl; if
// the shader's size computation changes, this must change in lockstep.
export function renderedSizePx(args: RenderedSizeArgs): number {
  const { catalog, idx, camPos, localPositions, uniforms: u, filter } = args;
  const { physicalRadius, absmag, periodDays, amplitudeMag } = catalog;

  const dx = localPositions[idx * 3] - camPos.x;
  const dy = localPositions[idx * 3 + 1] - camPos.y;
  const dz = localPositions[idx * 3 + 2] - camPos.z;
  const dCam = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), DCAM_LOG_FLOOR_PC);
  let appMag = absmag[idx] + 5 * (Math.log10(dCam) - 1);

  const fovYRad = u.uFovYRad.value;
  const viewport = u.uViewport.value;
  const R = Math.max(physicalRadius[idx], 1e-6) * R_SUN_PC;
  const baseSize = physSizePx(R, dCam, viewport.y, fovYRad);
  const maxPhysSize = ZOOM_FLOOR_FRACTION * Math.min(viewport.x, viewport.y);

  let radiusFactor = 1;
  const period = periodDays[idx];
  const amp = amplitudeMag[idx];
  if (period > 0 && amp > 0) {
    const periodSec = Math.max(
      period * u.uSecondsPerDay.value,
      u.uMinPeriodSec.value,
    );
    const phase = u.uTime.value / periodSec;
    const ampEff = varEffectiveAmplitude(amp, baseSize, maxPhysSize, VAR_TROUGH_FLOOR_FRACTION);

    const magMod = 0.5 * ampEff * Math.sin(2 * Math.PI * phase);
    appMag += magMod;
    radiusFactor = Math.pow(10, -magMod / 5);
  }

  // √Δm curve — must match star.vert.glsl line "appSize = mix(...sqrt(brightness))"
  // exactly, otherwise the SVG focus ring + disc mask drift from the
  // rendered star edges.
  const brightness = Math.max(
    0,
    Math.min(1, (filter.maxAppMag - appMag) / Math.max(filter.sizeSpan, 0.001)),
  );
  const appSize = filter.sizeMin + Math.sqrt(brightness) * (filter.sizeMax - filter.sizeMin);

  return Math.max(appSize, physSizePx(R, dCam, viewport.y, fovYRad, radiusFactor));
}

export interface PeakDiscArgs {
  catalog: Catalog;
  idx: number;
  camPos: Readonly<THREE.Vector3>;
  localPositions: Float32Array;
  uniforms: Pick<StarPhysicsUniforms, 'uFovYRad' | 'uViewport'>;
}

// Peak-amplitude rendered disc diameter in pixels. Mirrors the physSize
// branch of `renderedSizePx` but with the variable held at its peak
// radius (no time-phase oscillation), so the navigate-mode arrow fade
// reads a stable disc envelope across the variability cycle. Used only
// for fade gating — visible disc rendering and other overlays still
// call `renderedSizePx` so they track the actual rendered disc edge.
export function renderedDiscPxAtPeak(args: PeakDiscArgs): number {
  const { catalog, idx, camPos, localPositions, uniforms: u } = args;
  const dx = localPositions[idx * 3] - camPos.x;
  const dy = localPositions[idx * 3 + 1] - camPos.y;
  const dz = localPositions[idx * 3 + 2] - camPos.z;
  const dCam = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), DCAM_LOG_FLOOR_PC);

  const R = Math.max(catalog.physicalRadius[idx], 1e-6) * R_SUN_PC;
  const viewport = u.uViewport.value;
  return physSizePx(R, dCam, viewport.y, u.uFovYRad.value, peakAmplitudeFactor(catalog, idx));
}

// Chart-mode disc-tuning bag pulled from the shader uniforms. Surfaced
// for chart-labels.ts so the per-frame label engine reads the same
// values the chart-mode shader does.
export function getChartDiscParams(
  uniforms: ChartDiscUniforms,
): { maxPx: number; minPx: number; magBright: number } {
  return {
    maxPx: uniforms.uChartDiscMaxPx.value,
    minPx: uniforms.uChartDiscMinPx.value,
    magBright: uniforms.uChartMagBright.value,
  };
}
