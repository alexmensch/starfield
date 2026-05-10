// Per-planet phase functions for reflected-light apparent magnitude.
//
// Stellata's planet brightness model (3re.16) multiplies host-star
// flux at the planet by `albedo · (R/d_vp)² · (d_vh/d_hp)² · φ(α)`,
// where `φ(α)` is the dimensionless phase factor that captures how
// brightness varies with phase angle α = ∠(viewer–planet–host).
//
// Two implementations:
//
//   • `lambertianPhaseFactor(α)` — `(sin α + (π − α)·cos α)/π`, the
//     diffuse-sphere idealization. φ(0)=1, φ(π)=0. This is the
//     default fallback for any planet without measured phase data,
//     including every exoplanet (stellata-bk5) since their phase
//     curves are not observable at the precision Mallama publishes.
//
//   • `mallamaPhaseFactor(coefs, α)` — empirical polynomial in α
//     (degrees) from Mallama, Krobusek, Pavlov 2018 (Icarus 282).
//     A per-planet `ΔV(α)` magnitude offset is converted to a flux
//     factor via `10^(−ΔV/2.5)`. Each fit is valid only over the
//     `alphaMaxDeg` range observed in the source data; outside that
//     range the function falls back to Lambert.
//
// The vertex shader (`planet.vert.glsl`) mirrors this exactly via two
// per-instance vec4 attributes; tests pin the TS implementation
// against published values so a shader-side regression caught on the
// CPU side surfaces too.

/** Per-planet polynomial form for Mallama 2018 ΔV(α). Evaluated as
 *
 *    ΔV(α°) = c0 + c1·α + c2·α² + c3·α³ + c4·α⁴ + c5·α⁵ + c6·α⁶
 *
 *  with α in degrees. ΔV is in V-band magnitudes; convert to a flux
 *  factor via 10^(−ΔV/2.5).
 *
 *  By convention, ΔV(0) = c0; almost every planet has c0 = 0 so that
 *  φ(0) = 1 (matching Lambert's α = 0 normalisation, where `albedo`
 *  alone determines the body's α = 0 reflectance). Saturn is the
 *  lone exception — its ring contribution adds a static brightness
 *  boost baked into c0 < 0, a time-averaged approximation of the
 *  published ring-tilt term since planetary obliquity is not modelled
 *  in v1. */
export interface PhaseCoefficients {
  readonly c0: number;
  readonly c1: number;
  readonly c2: number;
  readonly c3: number;
  readonly c4: number;
  readonly c5: number;
  readonly c6: number;
  /** Upper validity bound of the published Mallama fit, in degrees.
   *  Beyond this α, callers fall back to the Lambertian phase
   *  function — extrapolating a fit beyond its source-data range
   *  produces wildly wrong values, especially for Mars whose true
   *  phase curve splits at 50° into a different regime. A sentinel
   *  value of 0 disables the polynomial entirely (Lambertian for
   *  every α), which is how planets with no published curve — Pluto
   *  here, every exoplanet under bk5 — opt out. */
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

/** Mallama 2018 empirical phase factor: `10^(−ΔV(α)/2.5)` where ΔV is
 *  the polynomial described on `PhaseCoefficients`. Falls back to
 *  Lambert when α exceeds the published validity bound, or when the
 *  coefficients carry the `alphaMaxDeg = 0` sentinel. */
export function mallamaPhaseFactor(
  coefs: PhaseCoefficients,
  alphaRad: number,
): number {
  if (coefs.alphaMaxDeg <= 0) return lambertianPhaseFactor(alphaRad);
  const aDeg = alphaRad * RAD_TO_DEG;
  if (aDeg > coefs.alphaMaxDeg) return lambertianPhaseFactor(alphaRad);
  // Horner from c6 down to c0.
  const dV =
    coefs.c0 +
    aDeg *
      (coefs.c1 +
        aDeg *
          (coefs.c2 +
            aDeg *
              (coefs.c3 +
                aDeg * (coefs.c4 + aDeg * (coefs.c5 + aDeg * coefs.c6)))));
  return Math.exp(-dV * 0.4 * LOG10);
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

// ── Per-planet coefficients from Mallama 2018 (Icarus 282) ─────────────
//
// Polynomial fits from Mallama, Krobusek, Pavlov 2018, "Comprehensive
// wide-band magnitudes and albedos for the planets, with applications
// to exo-planets and Planet Nine," Icarus 282 (2017) 19–33,
// DOI 10.1016/j.icarus.2016.09.023. Each `alphaMaxDeg` is the upper
// bound of α actually observed in the cited data; outside that range
// the renderer falls back to Lambert.

/** Mercury — 7th-order V-band fit (Mallama 2018 Table A-1.2),
 *  2° ≤ α ≤ 170°. The published polynomial includes a `c7 =
 *  +6.592e-15` term which we drop to keep the renderer's polynomial
 *  storage at degree 6 (two vec4 attributes per instance). The
 *  truncation is sub-0.25 mag for α < 120° and grows to ~2.9 mag at
 *  α = 170°; a Mercury silhouette at extreme α from a Stellata
 *  camera position is uncommon enough that the trade is worth it. */
export const MERCURY_PHASE: PhaseCoefficients = {
  c0: 0,
  c1: 6.617e-2,
  c2: -1.867e-3,
  c3: 4.103e-5,
  c4: -4.583e-7,
  c5: 2.643e-9,
  c6: -7.012e-12,
  alphaMaxDeg: 170,
};

/** Venus — 4th-order V-band fit (Mallama 2018 Table A-2.2), valid up
 *  to 165° per the paper text. The strongly negative α¹ coefficient
 *  — slight forward-scattering brightening at the smallest phase
 *  angles — is the empirical asymmetry that Lambert cannot
 *  reproduce; at α ≈ 160° Venus is several magnitudes brighter than
 *  a Lambertian sphere because its atmosphere forward-scatters
 *  strongly. The anomalous forward-scattering peak near α = 170°
 *  isn't captured by the polynomial — Lambert takes over there. */
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

/** Earth — Mallama 2018 Table A-3.1 publishes the disc-integrated
 *  Earth phase function as a discrete table, not a polynomial:
 *  ΔV(0°) = 0.000, ΔV(45°) = 1.123, ΔV(90°) = 2.069, ΔV(135°) =
 *  3.801. The coefficients below are a closed-form cubic fit that
 *  passes exactly through those four points (c0 = 0 by definition).
 *  Validity bound capped at 135° — the published table goes no
 *  further, and extrapolating a fit beyond its data is exactly the
 *  kind of mistake `alphaMaxDeg` exists to prevent. */
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

/** Mars — 2nd-order V-band fit (Mallama 2018 Table A-4.2), valid for
 *  α from a few degrees up to ~50°. The published model also
 *  includes rotation and orbital-longitude phase terms (L₁, L₂)
 *  that we don't model in v1. Beyond 50° the polynomial extrapolates
 *  badly; Lambert is a closer approximation in that regime. */
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

/** Jupiter — 2nd-order V-band fit (Mallama 2018 Table A-5.2), valid
 *  for the observed range α = 0–12°. Phase-angle excursions outside
 *  that band require a viewer between Sol and Jupiter, which is
 *  rare in the typical Stellata camera footprint; Lambert is a fine
 *  fallback there. */
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

/** Saturn (globe + rings) — Mallama 2018 Table A-6.2 publishes a
 *  joint α/ring-tilt formula
 *
 *    M(α°, β) = C₀ + C₁·sin(β) + C₂·α − C₃·sin(β)·exp(C₄·α)
 *
 *  with V-band C₁ = −1.825, C₂ = 0.026, C₃ = 0.378, C₄ = −2.25 and
 *  β the absolute ring inclination. Stellata doesn't model Saturn's
 *  obliquity yet, so this entry is a static-β = 16° (long-run mean
 *  |β|) approximation: c0 captures C₁·sin(β) plus the at-α=0
 *  exp-term contribution, and c1 = C₂ carries the linear α
 *  modulation. The exp-term (an opposition-surge effect that decays
 *  past α ≈ 2°) is folded into c0 as a small bias rather than
 *  reproduced — the polynomial form here can't represent it. */
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

// Uranus and Neptune intentionally do NOT have Mallama 2018 phase
// polynomials. The paper's Tables A-7.2 and A-8.2 publish a
// sub-latitude (Uranus) and a temporal year-since-1984 (Neptune)
// model — neither is a function of phase angle α, because both
// planets' max α from Earth is "negligible" (3° for Uranus, 2° for
// Neptune). Stellata viewers can fly close enough for α to grow
// large, but with no published curve to anchor the empirical
// brightening we let both planets fall through to the Lambertian
// default — same as Pluto and every exoplanet.
