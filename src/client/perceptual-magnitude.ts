// Perceptual disc abstraction — TS mirror of shaders/perceptual-disc.glsl.
//
// CPU-side helpers for the same brightness → disc-radius mapping the
// star and planet vertex shaders use. Pure functions; vitest-covered
// (see perceptual-magnitude.test.ts). Future consumers: search ranking
// (rank by appMag), label gating (hide labels when source falls below
// the slider cutoff), debug-panel readouts.
//
// The shader is the production source of truth; this mirror exists so
// downstream TS code can ask "would this source render?" without
// reaching into GPU state, and so the math is pinned by tests.

/**
 * Standard apparent-magnitude formula for an unobscured emitter.
 *
 * `M + 5·(log10(d/pc) − 1) = M + 5·log10(d / 10pc)`.
 *
 * Floors `dPc` at 1e-30 so callers don't need to guard against zero
 * distances at the singular focal-star point — matches the GLSL
 * shader's behaviour exactly.
 */
export function apparentMagnitude(absmag: number, dPc: number): number {
  const d = Math.max(dPc, 1e-30);
  return absmag + 5 * (Math.log10(d) - 1);
}

/**
 * Soft-knee `dM_eff` curve. `dM = maxAppMag − appMag` is "magnitudes
 * brighter than the visibility cutoff."
 *
 * - For `dM ≤ sizeSpan`, returns `max(dM, 0)` — the linear region.
 * - For `dM > sizeSpan`, bends through a Michaelis-Menten asymptote
 *   that approaches `sizeSpan + sizeKnee` as `dM → ∞`. Lets very
 *   bright sources keep growing past the linear ceiling instead of
 *   hard-clamping there.
 *
 * Identical arithmetic to `perceptualDmEff` in
 * shaders/perceptual-disc.glsl.
 */
export function perceptualDmEff(
  appMag: number,
  maxAppMag: number,
  sizeSpan: number,
  sizeKnee: number,
): number {
  const dM = maxAppMag - appMag;
  if (dM <= sizeSpan) return Math.max(dM, 0);
  const over = dM - sizeSpan;
  return sizeSpan + (sizeKnee * over) / Math.max(sizeKnee + over, 1e-6);
}

/**
 * Apparent-magnitude → disc pixel diameter. `√(dMEff / sizeSpan)`
 * blended through `[sizeMin, sizeMax]`. Identical arithmetic to
 * `perceptualAppSizePx` in shaders/perceptual-disc.glsl.
 */
export function perceptualAppSizePx(
  dMEff: number,
  sizeMin: number,
  sizeMax: number,
  sizeSpan: number,
): number {
  const t = Math.sqrt(dMEff / Math.max(sizeSpan, 0.001));
  return sizeMin + t * (sizeMax - sizeMin);
}
