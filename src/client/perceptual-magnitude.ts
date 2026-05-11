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

/**
 * Reflected-light apparent magnitude of a planet seen by a viewer. CPU
 * mirror of the integrated formula in shaders/planet.vert.glsl:146-162.
 *
 *   m_host_at_viewer = M_host + 5·log10(d_vh / 10pc)
 *   m_planet         = m_host_at_viewer
 *                    − 2.5·log10( p · (R/d_vp)² · (d_vh/d_hp)² · φ(α) )
 *
 * - `hostAbsmag` is the host star's absolute V-band magnitude.
 * - `dVhPc` is viewer→host distance in parsecs.
 * - `dVpPc` is viewer→planet distance in parsecs.
 * - `dHpPc` is host→planet distance in parsecs.
 * - `albedo` is the planet's geometric albedo p (dimensionless).
 * - `radiusPc` is the planet's physical radius in parsecs.
 * - `phaseFactor` is φ(α) — pass 1 for full-phase, or use
 *   `lambertianPhaseFactor` / `mallamaPhaseFactor` from `phase-function.ts`.
 *
 * Distances and the reflectance product floor at 1e-30 to match the
 * shader's defensive clamps at the singular zero-distance point.
 */
export function planetApparentMagnitude(
  hostAbsmag: number,
  dVhPc: number,
  dVpPc: number,
  dHpPc: number,
  albedo: number,
  radiusPc: number,
  phaseFactor: number,
): number {
  const dVh = Math.max(dVhPc, 1e-30);
  const dVp = Math.max(dVpPc, 1e-30);
  const dHp = Math.max(dHpPc, 1e-30);
  const mHostAtViewer = hostAbsmag + 5 * (Math.log10(dVh) - 1);
  const radRatio = radiusPc / dVp;
  const legRatio = dVh / dHp;
  const reflFactor =
    albedo * radRatio * radRatio * legRatio * legRatio * Math.max(phaseFactor, 0);
  return mHostAtViewer - 2.5 * Math.log10(Math.max(reflFactor, 1e-30));
}
