precision highp float;

// Phase 5 (rev 4) — bounded volumetric raymarch through proxy meshes.
//
// Two proxy meshes (a flattened disc, an oblate bulge) define
// integration volumes centred on the galactic centre. For each
// fragment, we raymarch from front-face entry (or camera position if
// the camera is inside the mesh) to the back-face fragment, evaluating
// the component's density function and accumulating emission with
// running dust extinction. The two meshes' contributions add via the
// material's additive blending.
//
// Why volumetric instead of surface-only emission:
//   - Surface-only evaluates density at one point per fragment, which
//     can't capture the band's defining anisotropy: long edge-on path
//     through the disc → bright band; short out-of-plane path →
//     dim glow; both should be smooth and continuous. Volumetric
//     integration produces this naturally — the silhouette of the
//     proxy mesh fades smoothly to zero as the path through the volume
//     shrinks to nothing.
//   - The earlier surface-only attempt used `pow(|n·v|, k)` to soften
//     hard mesh outlines, but that's a hack: it just dims the
//     silhouette; it doesn't represent the actual integrated emission.
//
// Why analytical-only dust (no voxel sampling):
//   - The Edenhofer voxel grid has ~5 pc native resolution, designed
//     for short per-star sightlines. Sampling it at coarse step
//     intervals along the long camera→fragment ray (8-15 kpc) aliases
//     into visible parallel streaks regardless of step distribution.
//   - The molecular cloud layer (renderOrder = -2) renders named SF
//     clouds as proper 3D ellipsoids and provides the discrete cloud
//     detail in front of the band.
//   - The voxel grid stays in use for per-star extinction
//     (star.vert.glsl), where short rays + dense per-star sampling
//     work cleanly.

in vec3 vMeshLocalPos;
in vec3 vWorldPos;
out vec4 fragColor;

// Auto-injected by ShaderMaterial:
//   uniform vec3 cameraPosition;  // renderer-local

// Floating-origin offset (renderer-local + uWorldOffset = absolute ICRS).
// We don't actually need absolute coords here since both galactic centre
// and the camera are computed in renderer-local frame, but keep it
// available for any future per-step absolute lookups.
uniform vec3 uWorldOffset;

// Galactic-frame transform.
uniform mat3 uIcrsToGal;        // ICRS axes → galactic axes
uniform vec3 uGalCenter;        // GALACTIC_CENTRE_PC - worldOffset (renderer-local)

// Mesh half-extents in pc (galactic-frame X, Y, Z under mesh.scale).
uniform vec3 uMeshScalePc;

// Component flag: false = disc, true = bulge.
uniform bool uIsBulge;

// Stellar (emission) density profile parameters.
uniform float uDiscScaleLengthPc;   // hR
uniform float uDiscScaleHeightPc;   // hz
uniform float uBulgeScaleRadiusPc;  // r_b
uniform float uBulgeAxisRatio;      // q (oblate flattening)
uniform float uDensity0;            // peak density normalisation
uniform vec3  uColor;               // population palette

uniform float uR0Pc;  // Sol galactocentric radius

// Analytical disc dust profile (no voxel sampling — see top comment).
uniform float uAnalyticalDustScaleLengthPc;
uniform float uAnalyticalDustScaleHeightPc;
uniform float uAnalyticalDustNormPerPc;
uniform float uDustAvPerDensityPc;
uniform float uDustEnabled;
uniform float uExtinctionStrength;

// Wavelength-dependent extinction multipliers on τ_V. CCM ratios:
// (0.751, 1.0, 1.32) → red transmits most, blue extincts most → warm
// amber tint emerges from behind heavy dust columns.
uniform vec3 uReddeningRGB;

// Output controls.
uniform float uBrightnessScale;
uniform float uMaxAppMag;     // shared with star pipeline
uniform float uSizeSpan;      // shared with star pipeline
uniform float uGlowMagOffset; // calibration: integrated density → appMag

// Raymarch resolution. 32 log-distributed steps over distance-from-
// camera. Log spacing concentrates samples near the camera (where
// dust + density vary fastest) and spreads the rest over the longer
// far portion of the ray.
const int   STEPS = 32;
const float S_MIN_PC = 1.0;
const float LOG10 = 2.302585093;

// --- Density functions ----------------------------------------------

float discDensityVal(float R, float zVal) {
  return uDensity0
       * exp(-(R - uR0Pc) / uDiscScaleLengthPc)
       * exp(-abs(zVal) / uDiscScaleHeightPc);
}

float bulgeDensityVal(float R, float zVal) {
  float zEff = zVal / uBulgeAxisRatio;
  float rPrime = sqrt(R * R + zEff * zEff);
  return uDensity0 * exp(-rPrime / uBulgeScaleRadiusPc);
}

float analyticalDustDensity(float R, float zVal) {
  return uAnalyticalDustNormPerPc
       * exp(-(R - uR0Pc) / uAnalyticalDustScaleLengthPc)
       * exp(-abs(zVal) / uAnalyticalDustScaleHeightPc);
}

// --- Main -----------------------------------------------------------

void main() {
  // --- Camera in mesh-local (unit sphere) frame -----------------------
  // Renderer-local → galactocentric ICRS → galactocentric galactic →
  // mesh-local (component-wise divide by half-axes).
  vec3 camGalCentric = uIcrsToGal * (cameraPosition - uGalCenter);
  vec3 camLocal = camGalCentric / uMeshScalePc;

  // --- Ray entry/exit in mesh-local frame -----------------------------
  // Ray runs camLocal → vMeshLocalPos. Don't normalise; under non-
  // uniform mesh scale, the local-frame "length" is direction-dependent
  // (meaningless), so we keep dirLocal in its natural mesh-local units.
  // t=0 at camera, t=1 at the back-face fragment (which is on the unit
  // sphere by construction).
  vec3 dirLocal = vMeshLocalPos - camLocal;
  float a = dot(dirLocal, dirLocal);
  float b = dot(camLocal, dirLocal);
  float c = dot(camLocal, camLocal) - 1.0;
  float disc = b * b - a * c;
  if (disc < 0.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float sqrtDisc = sqrt(disc);
  // Front-face entry (smaller root). Camera inside ⇒ tEnter < 0 ⇒ clamp.
  float tEnter = max((-b - sqrtDisc) / a, 0.0);
  // Back-face exit IS the fragment by construction — t = 1.
  float tExit = 1.0;
  if (tEnter >= tExit) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  // --- Distances in world parsecs -------------------------------------
  // dirLocal spans [0, 1] across camera→fragment. The world-space
  // length of one t-unit is |vWorldPos - cameraPosition|, which we use
  // to convert mesh-local t-units into physical pc step size for the
  // raymarch. Both operands are renderer-local with small magnitudes
  // (floating-origin keeps them near zero), so this subtraction is
  // float-stable.
  float worldPerT = length(vWorldPos - cameraPosition);
  float sStart = max(tEnter * worldPerT, S_MIN_PC);
  float sEnd = worldPerT;
  if (sStart >= sEnd) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float logMin = log(sStart);
  float logMax = log(sEnd);
  float logStep = (logMax - logMin) / float(STEPS);

  // --- Volumetric raymarch --------------------------------------------
  // Per step:
  //   - Evaluate component density (emission per pc).
  //   - Evaluate analytical dust density → per-channel τ via CCM
  //     reddening.
  //   - Beer-Lambert: emission × dsPc × transmission(camera→step), with
  //     a half-step self-shielding term so a uniform slab integrates
  //     correctly.
  //   - Accumulate τ for next step.
  vec3 colorAccum = vec3(0.0);
  vec3 tauAccum = vec3(0.0);
  float prevS = sStart;

  float dustEffective = uDustEnabled * uExtinctionStrength;

  for (int i = 0; i < STEPS; i++) {
    float sBoundary = exp(logMin + float(i + 1) * logStep);
    float sMid = exp(logMin + (float(i) + 0.5) * logStep);
    float dsPc = sBoundary - prevS;
    prevS = sBoundary;

    float t = sMid / worldPerT;
    vec3 pLocal = camLocal + t * dirLocal;
    // Outside the unit sphere → outside the mesh's integration volume.
    // Stop integrating (boundary samples can drift slightly past 1.0
    // due to log-stepping rounding).
    if (dot(pLocal, pLocal) > 1.001) break;

    vec3 posGalCentric = pLocal * uMeshScalePc;
    float R = length(posGalCentric.xy);
    float zVal = posGalCentric.z;

    float densityVal = uIsBulge
      ? bulgeDensityVal(R, zVal)
      : discDensityVal(R, zVal);

    // Per-channel optical depth for this step (CCM reddening).
    vec3 dTauRGB = vec3(0.0);
    if (dustEffective > 0.0) {
      float kappaPerPcV = analyticalDustDensity(R, zVal)
                        * uDustAvPerDensityPc * dustEffective / 1.0857;
      dTauRGB = kappaPerPcV * uReddeningRGB * dsPc;
    }

    // Beer-Lambert with half-step self-shielding for the slab approx.
    vec3 transmittance = exp(-tauAccum) * exp(-0.5 * dTauRGB);
    colorAccum += densityVal * uColor * transmittance * dsPc;
    tauAccum += dTauRGB;
  }

  // --- Tone mapping ---------------------------------------------------
  // Beer-Lambert-style: bright integrated columns saturate toward 1,
  // dim ones stay close to linear.
  vec3 scaled = colorAccum * uBrightnessScale;
  vec3 result = vec3(1.0) - exp(-scaled);

  // --- Magnitude gate -------------------------------------------------
  // Convert integrated raw colour magnitude (pre-tone-map) to an
  // effective apparent magnitude and gate through the same
  // brightnessClamp curve `star.vert.glsl` uses, so the user's
  // max-mag slider attenuates stars + glow + (future) nebulae together.
  // Multiplier applied AFTER the tone map; folding it into the exponent
  // saturates for bright sightlines and the slider has no effect.
  float intensity = max(colorAccum.r + colorAccum.g + colorAccum.b, 1e-12);
  float appMag = uGlowMagOffset - 2.5 * log(intensity) / LOG10;
  float brightnessClamp = clamp(
    (uMaxAppMag - appMag) / max(uSizeSpan, 0.001),
    0.0, 1.0
  );
  result *= brightnessClamp;

  fragColor = vec4(result, 1.0);
}
