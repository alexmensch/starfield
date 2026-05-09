// Perceptual disc abstraction (stellata-3re.16 prep).
//
// The "how a point of light reads on the retina + on the screen" math,
// shared between the star pipeline and any future point-source layer
// (planets in stellata-3re.16, exoplanet bodies in stellata-bk5,
// asteroids/moons later). Three pieces:
//
//   perceptualDmEff     — soft-knee dM saturation (vert)
//   perceptualAppSizePx — √Δm disc-radius-from-magnitude (vert)
//   perceptualDiscProfile — radial intensity I(r) (frag)
//
// # Why this is the same math for stars and planets
//
// A star and a sufficiently bright planet are the same thing to the
// eye and to a non-HDR display: an unresolved point of light whose
// retinal/screen footprint is dominated by ocular PSF blur and
// luminance-saturation spread, not by the source's true angular
// diameter. Venus at -4 paints a perceptible halo for the same reason
// Sirius at -1.5 does — diffraction at the pupil + display-saturation
// spread + small-amplitude scatter. NOT atmospheric scintillation
// (twinkle); that's a separate effect we don't model.
//
// So the chunk encapsulates the shared mapping. The star pipeline
// supplies the source's apparent magnitude from catalog absmag +
// distance + dust extinction; the planet pipeline (3re.16) supplies
// it from the host's apparent magnitude minus reflected-light terms.
// Same downstream math from there.
//
// # The dM curve
//
// dM is "magnitudes brighter than the visibility cutoff." Below the
// cutoff dM ≤ 0 and the source contributes no perceptual disc.
// Above the cutoff, the disc grows as a Gaussian-PSF model: perceived
// radius ∝ √(dM) because the visible footprint is "where intensity
// > detection threshold" and that grows as the square root of
// brightness above threshold. Linear-in-mag would compress bright
// sources too far; √Δm keeps Sirius (or Venus) distinctively larger
// than the field.
//
// # The soft knee
//
// The √Δm curve is unbounded in dM, so above the visible-population
// window (dM > sizeSpan) we used to hard-clamp to a fixed ceiling,
// making every super-bright source render at sizeMax. That broke
// brightness ratios in the close-approach regime — Sol and Barnard's
// at 5e-3 pc both pinned to the cap despite a 2300× flux ratio. The
// knee replaces the clamp with a Michaelis-Menten asymptote: identity
// below sizeSpan, smoothly bending to a ceiling of (sizeSpan +
// sizeKnee) above. sizeKnee = 0 recovers the old hard-clamp; larger
// values let bright sources keep growing before saturation locks in
// — perceptually honest (the eye and display do saturate, just not
// abruptly).
//
// # The intensity profile
//
// `perceptualDiscProfile` is the super-Gaussian I(r) = exp(-K·(2r)^n)
// the frag shader paints into the disc + glow passes. K is chosen so
// I(0.5) = visibleThreshold; the result is then renormalised so
// I(0.5) = 0 exactly. n morphs from "Gaussian / fuzzy" at distant
// (point-glow-dominated) ranges to "plateau / disc-like" at close
// (resolved-disc-dominated) ranges, with a per-source softness bias
// (lumBias) so hypergiants stay fuzzier than dwarfs at equivalent
// physRatio.

float perceptualDmEff(float appMag, float maxAppMag, float sizeSpan, float sizeKnee) {
  float dM = maxAppMag - appMag;
  if (dM <= sizeSpan) {
    return max(dM, 0.0);
  }
  float over = dM - sizeSpan;
  return sizeSpan + sizeKnee * over / max(sizeKnee + over, 1e-6);
}

float perceptualAppSizePx(float dMEff, float sizeMin, float sizeMax, float sizeSpan) {
  return mix(sizeMin, sizeMax, sqrt(dMEff / max(sizeSpan, 0.001)));
}

// Frag-side intensity. `physRatio` is in [0, 1] — 1 = physical-size
// dominates (resolved disc), 0 = apparent-magnitude dominates (point
// glow). `softness` is in [0, 1] — 0 = white-dwarf-crisp, 1 =
// hypergiant-fuzzy. Caller supplies the four shaping uniforms
// directly so the chunk doesn't depend on a particular uniform-naming
// convention.
float perceptualDiscProfile(
  float r,
  float softness,
  float physRatio,
  float visibleThreshold,
  float visibleK,
  float distNMin,
  float distNMax,
  float lumBiasMin,
  float lumBiasMax
) {
  float distN = mix(distNMin, distNMax, smoothstep(0.0, 0.5, physRatio));
  float lumBias = mix(lumBiasMin, lumBiasMax, softness);
  float n = distN * lumBias;
  float raw = exp(-visibleK * pow(2.0 * r, n));
  return max(0.0, (raw - visibleThreshold) / (1.0 - visibleThreshold));
}
