// Per-planet phase functions φ(α) for reflected-light apparent
// magnitude — Lambertian default + Mallama 2018 empirical polynomials
// for the planets with published fits. See SCIENCE.md § Planet phase
// functions. The vertex shader (planet.vert.glsl) mirrors this
// exactly via two per-instance vec4 attributes; tests pin the TS path
// against published values.

/** Mallama 2018 ΔV(α°) = c0 + c1·α + … + c6·α⁶. c0 = 0 for every
 *  planet except Saturn, which absorbs a static ring-tilt brightness
 *  boost via c0 < 0. */
export interface PhaseCoefficients {
  readonly c0: number;
  readonly c1: number;
  readonly c2: number;
  readonly c3: number;
  readonly c4: number;
  readonly c5: number;
  readonly c6: number;
  /** Upper validity bound in degrees. Beyond this α, callers fall
   *  back to anchor-scaled Lambert. Sentinel `0` disables the
   *  polynomial entirely (pure Lambert). */
  readonly alphaMaxDeg: number;
}

const LOG10 = Math.log(10);
const RAD_TO_DEG = 180 / Math.PI;

/** Lambertian (perfectly diffuse sphere) phase factor — the default
 *  fallback when no empirical curve is published for a body. Clamps α
 *  to [0, π] defensively. */
export function lambertianPhaseFactor(alphaRad: number): number {
  const a = Math.max(0, Math.min(Math.PI, alphaRad));
  return (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
}

/** Horner-evaluated Mallama 2018 ΔV polynomial in α-degrees. Helper
 *  exists so the in-validity-bound and at-boundary-anchor paths share
 *  one definition — keeps the truncation rule (degree-6) localised. */
function mallamaDV(coefs: PhaseCoefficients, aDeg: number): number {
  return (
    coefs.c0 +
    aDeg *
      (coefs.c1 +
        aDeg *
          (coefs.c2 +
            aDeg *
              (coefs.c3 +
                aDeg * (coefs.c4 + aDeg * (coefs.c5 + aDeg * coefs.c6)))))
  );
}

/** Mallama 2018 empirical phase factor. Inside [0, αmax°] uses the
 *  polynomial; beyond αmax falls back to anchor-scaled Lambert
 *  (continuous at the boundary). α clamped to [0, π] — Horner
 *  diverges wildly past its fitted domain, so the αmax fallback is
 *  load-bearing against accidental degrees/radians swaps. */
export function mallamaPhaseFactor(
  coefs: PhaseCoefficients,
  alphaRad: number,
): number {
  if (coefs.alphaMaxDeg <= 0) return lambertianPhaseFactor(alphaRad);
  const a = Math.max(0, Math.min(Math.PI, alphaRad));
  const aDeg = a * RAD_TO_DEG;
  if (aDeg <= coefs.alphaMaxDeg) {
    return Math.exp(-mallamaDV(coefs, aDeg) * 0.4 * LOG10);
  }
  // Past αmax: anchor-scaled Lambert. k folds the empirical-vs-Lambert
  // ratio at the boundary into a single multiplier.
  const boundaryFlux = Math.exp(-mallamaDV(coefs, coefs.alphaMaxDeg) * 0.4 * LOG10);
  const boundaryLambert = lambertianPhaseFactor(coefs.alphaMaxDeg / RAD_TO_DEG);
  return lambertianPhaseFactor(a) * (boundaryFlux / boundaryLambert);
}

/** Phase-factor flux multiplier at α = 0 — i.e. `10^(−c0/2.5)`. Drives
 *  the per-host visibility cull (see `cullDistancePc` in
 *  `planet-body-field.ts`): for almost every planet this is 1, but
 *  Saturn's ring term raises it materially and the cull distance has
 *  to widen to match. */
export function peakPhaseFactor(coefs: PhaseCoefficients | undefined): number {
  if (!coefs || coefs.alphaMaxDeg <= 0) return 1;
  return Math.exp(-coefs.c0 * 0.4 * LOG10);
}

// Per-planet coefficients from Mallama 2018 (Icarus 282). Each
// alphaMaxDeg is the upper bound observed in the cited data; outside
// that range the renderer falls back to anchor-scaled Lambert.

/** Mercury — Mallama 2018 Table A-1.2 7th-order fit, truncated to
 *  degree 6 to fit two vec4 attributes (the c7 term is dropped).
 *  alphaMaxDeg = 87° because past that the truncated polynomial
 *  diverges from the published 7th-order curve; Lambert anchored at
 *  87° takes over. Truncation budget pinned by phase-function.test.ts. */
export const MERCURY_PHASE: PhaseCoefficients = {
  c0: 0,
  c1: 6.617e-2,
  c2: -1.867e-3,
  c3: 4.103e-5,
  c4: -4.583e-7,
  c5: 2.643e-9,
  c6: -7.012e-12,
  alphaMaxDeg: 87,
};

/** Venus — Mallama 2018 Table A-2.2 4th-order fit, valid to 165°.
 *  The α = 170° forward-scattering peak isn't captured by the
 *  polynomial — Lambert takes over there. */
export const VENUS_PHASE: PhaseCoefficients = {
  c0: 0,
  c1: -1.044e-3,
  c2: 3.687e-4,
  c3: -2.814e-6,
  c4: 8.938e-9,
  c5: 0,
  c6: 0,
  alphaMaxDeg: 165,
};

/** Earth — closed-form cubic fit through the four discrete values
 *  in Mallama 2018 Table A-3.1 (the paper publishes a table, not a
 *  polynomial). alphaMaxDeg = 135°, the table's last datum. */
export const EARTH_PHASE: PhaseCoefficients = {
  c0: 0,
  c1: 3.406e-2,
  c2: -2.817e-4,
  c3: 1.762e-6,
  c4: 0,
  c5: 0,
  c6: 0,
  alphaMaxDeg: 135,
};

/** Mars — Mallama 2018 Table A-4.2 2nd-order fit, valid to ~50°.
 *  The published rotation + orbital-longitude phase terms (L₁, L₂)
 *  aren't modelled. */
export const MARS_PHASE: PhaseCoefficients = {
  c0: 0,
  c1: 2.267e-2,
  c2: -1.302e-4,
  c3: 0,
  c4: 0,
  c5: 0,
  c6: 0,
  alphaMaxDeg: 50,
};

/** Jupiter — Mallama 2018 Table A-5.2 2nd-order fit, observed range
 *  α = 0–12°. */
export const JUPITER_PHASE: PhaseCoefficients = {
  c0: 0,
  c1: -3.7e-4,
  c2: 6.16e-4,
  c3: 0,
  c4: 0,
  c5: 0,
  c6: 0,
  alphaMaxDeg: 12,
};

/** Saturn — static-β = 16° (long-run mean) approximation of the
 *  Mallama 2018 Table A-6.2 joint α/ring-tilt formula. c0 absorbs
 *  the ring contribution + opposition-surge exp-term-at-α=0 bias;
 *  c1 carries the linear α modulation. */
export const SATURN_PHASE: PhaseCoefficients = {
  c0: -0.55,
  c1: 0.026,
  c2: 0,
  c3: 0,
  c4: 0,
  c5: 0,
  c6: 0,
  alphaMaxDeg: 6.5,
};

// Uranus and Neptune fall through to Lambert by design — Mallama
// 2018 Tables A-7.2 / A-8.2 model sub-latitude (Uranus) and temporal
// (Neptune) effects, not α, because Earth-bound max α is negligible
// for both. Pluto and every exoplanet share the Lambert fallback.
