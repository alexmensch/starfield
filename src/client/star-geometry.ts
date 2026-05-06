// Pure-math star-geometry helpers extracted from Stellata.ts so the
// angular-diameter pipeline (a7d.2) is unit-testable and so the disc
// formula isn't typed three times across the renderer's TypeScript path
// (renderedSizePx, renderedDiscPxAtPeak) and the GLSL vertex shader.
//
// The vertex shader has its own copy of `physSizePx` (intentionally — a
// build-time GLSL include is more complexity than a paired comment) but
// the variability-headroom rule lives only here on the TS side; the
// shader replicates it inline keyed off the same uniforms.

// Pixel-per-radian conversion. Mirrors the shader's
// `viewport.y / max(fovYRad, 1e-9)`. Floor on fovYRad keeps the divide
// finite in the singular case where the camera FOV is briefly written
// as zero during a transition.
export function angularToPx(viewport_y: number, fovYRad: number): number {
  return viewport_y / Math.max(fovYRad, 1e-9);
}

// Star disc pixel diameter under the angular-diameter formula
// `θ = 2·atan(R / d)`. `radiusFactor` modulates `R` for variable-star
// pulsation (1 for non-variables; 10^(amp/10) at peak; 10^(-amp/10) at
// trough). The shader's physSize calc must produce the same value for
// the same inputs — keep them in sync.
export function physSizePx(
  R_pc: number,
  dCam_pc: number,
  viewport_y: number,
  fovYRad: number,
  radiusFactor = 1,
): number {
  return 2 * Math.atan((R_pc * radiusFactor) / dCam_pc) * angularToPx(viewport_y, fovYRad);
}

// Effective amplitude for a variable star, clamped so the disc neither
// grows past `maxPhysFrac` of the viewport's minor axis at peak nor
// shrinks below `varTroughFrac` of `baseSize` at trough. Returns 0 for
// non-variables.
//
// Inputs:
//   amp           — catalog amplitudeMag (peak-to-trough magnitudes)
//   baseSize      — un-modulated disc size in px (radiusFactor = 1)
//   maxPhysSize   — viewport-derived peak ceiling in px
//                   (= maxPhysFrac × min(viewport.x, viewport.y))
//   varTroughFrac — trough floor fraction (= VAR_TROUGH_FLOOR_FRACTION)
//
// Same compression rule the shader applies to `uMaxPhysFrac` /
// `uVarTroughFrac`. Headroom is computed in log-flux space because the
// disc-radius modulation is `R · 10^(-Δm/5)` (constant-T assumption).
export function varEffectiveAmplitude(
  amp: number,
  baseSize: number,
  maxPhysSize: number,
  varTroughFrac: number,
): number {
  if (amp <= 0) return 0;
  const maxUpLog10 = Math.log10(Math.max(maxPhysSize / Math.max(baseSize, 1), 1));
  const maxDownLog10 = -Math.log10(varTroughFrac);
  const ampLimitMag = 10 * Math.min(maxUpLog10, maxDownLog10);
  return Math.min(amp, Math.max(0, ampLimitMag));
}

// Solve for camera distance `d` such that a star of radius `R_pc`
// (physical, in pc) fills `targetFrac` of `min(viewport.x, viewport.y)`
// at the current FOV. Symbolically:
//   targetFrac · fovMinor = 2·atan(R / d)
//   d = R / tan(targetFrac · fovMinor / 2)
// Used both for the manual-zoom orbit floor (targetFrac = 0.9) and the
// auto-park distance (targetFrac = 0.10).
export function distAtFillFraction(
  R_pc: number,
  fovMinorRad: number,
  targetFrac: number,
): number {
  return R_pc / Math.tan((targetFrac * fovMinorRad) / 2);
}
