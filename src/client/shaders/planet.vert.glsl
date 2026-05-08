precision highp float;

#include <common>
#include <logdepthbuf_pars_vertex>
// Shared apparent-magnitude → disc-pixel-size mapping. Stars and
// planets use the same chunk; see its header for the rationale.
#include <stellata_perceptual_disc>

// Per-vertex (quad corner): xy in [-0.5, 0.5].
in vec2 aCorner;

// Per-instance:
//   iHostLocalPos — host position in the renderer's local frame. In
//     commit 2 (single-host StarSystem layer with group.position =
//     hostLocalPos) this is always (0,0,0); commit 3 populates it
//     for real when planet bodies become a global PlanetBodyField.
//   iLocalRel     — planet position relative to host, in the host's
//     local plane frame, post-orientation. Sum (iHostLocalPos +
//     iLocalRel) gives the planet's renderer-local position.
//   iRadiusPc     — planet equatorial radius in pc (for true angular
//     diameter and the reflected-light apparent-mag formula).
//   iColour       — representative single-colour RGB.
//   iSolidity     — 1 = rocky (crisp edge), 0 = gas-giant (fuzzy).
//   iAlbedoP      — geometric albedo p, V-band.
//   iHostAbsmag   — host star's absolute magnitude.
in vec3 iHostLocalPos;
in vec3 iLocalRel;
in float iRadiusPc;
in vec3 iColour;
in float iSolidity;
in float iAlbedoP;
in float iHostAbsmag;

uniform vec2 uViewport;       // CSS pixels
uniform float uPixelRatio;
uniform float uFovYRad;

// Render mode — same convention as the star pipeline:
//   0 = glow (additive halo for distant point-glow planets)
//   1 = disc (per-channel-max, close-range resolved planets)
//   2 = core mask (depth-only for disc cores, occludes background)
uniform int uRenderMode;

// Visibility cutoff (mag slider); shared with stars.
uniform float uMaxAppMag;

// Perceptual-disc shaping. All shared with the star pipeline.
uniform float uSizeMin;
uniform float uSizeMax;
uniform float uSizeSpan;
uniform float uSizeKnee;

out vec3 vColor;
out vec2 vUv;
out float vAppMag;
out float vPhysRatio;
out float vSoftness;

const float LOG10 = 2.302585093;
const float PI_CONST = 3.14159265358979323846;

void main() {
  // View-space positions (frame-independent — host and planet both
  // move through the same modelViewMatrix). Distances are in pc
  // because there is no scale baked into modelMatrix.
  vec3 planetLocal = iHostLocalPos + iLocalRel;
  vec4 planetView = modelViewMatrix * vec4(planetLocal, 1.0);
  vec4 hostView   = modelViewMatrix * vec4(iHostLocalPos, 1.0);

  // Defensive — both planet and host behind near plane (camera past
  // the system) → kill the quad. The disc/glow gates below will
  // catch most other off-screen cases via the magnitude cutoff.
  float d_vp = length(planetView.xyz);
  float d_vh = length(hostView.xyz);
  float d_hp = length(planetView.xyz - hostView.xyz);
  if (d_vp <= 0.0 || d_vh <= 0.0 || d_hp <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAppMag = 0.0;
    vColor = vec3(0.0);
    vUv = aCorner;
    vPhysRatio = 0.0;
    vSoftness = 0.0;
    return;
  }

  // Phase angle α = ∠(viewer → planet → host). vph = planet → viewer,
  // hph = planet → host. Lambertian phase function below.
  vec3 vphHat = normalize(-planetView.xyz);
  vec3 hphHat = normalize(hostView.xyz - planetView.xyz);
  float cosA = clamp(dot(vphHat, hphHat), -1.0, 1.0);
  float alpha = acos(cosA);
  float phi = (sin(alpha) + (PI_CONST - alpha) * cos(alpha)) / PI_CONST;

  // Reflected-light apparent magnitude (Lambertian sphere, full or
  // partial illumination via φ(α)):
  //
  //   m_host_at_viewer = M_host + 5·log10(d_vh / 10pc)
  //   m_planet         = m_host_at_viewer
  //                    − 2.5·log10( p · (R/d_vp)² · (d_vh/d_hp)² · φ(α) )
  //
  // Verified against Jupiter (R=69,911 km, p=0.538):
  //   • Earth at opposition (d_vh=1 AU, d_hp=5.2 AU, d_vp=4.2 AU): −2.7 ✓
  //   • Outside heliopause (d_vh=150 AU): +5.2 ✓
  //   • α Cen (1.34 pc): +21 ✓
  float m_host_at_viewer = iHostAbsmag + 5.0 * (log(d_vh) / LOG10 - 1.0);
  float radRatio = iRadiusPc / d_vp;
  float legRatio = d_vh / d_hp;
  float reflFactor = iAlbedoP * radRatio * radRatio
                   * legRatio * legRatio
                   * max(phi, 0.0);
  float appMag = m_host_at_viewer - 2.5 * log(max(reflFactor, 1e-30)) / LOG10;

  // Soft taper: pass a 0.5-mag overshoot so the glow pass can fade
  // intensity to zero across the threshold band — same hysteresis
  // the star pipeline uses to avoid pop-in/out as the slider moves.
  if (appMag > uMaxAppMag + 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAppMag = appMag;
    vColor = vec3(0.0);
    vUv = aCorner;
    vPhysRatio = 0.0;
    vSoftness = 1.0 - iSolidity;
    return;
  }

  // Physical disc size in CSS pixels. θ = 2·atan(R/d_vp).
  float angularToPx = uViewport.y / max(uFovYRad, 1e-9);
  float physSize = 2.0 * atan(iRadiusPc / d_vp) * angularToPx;

  // Apparent-magnitude size via the perceptual-disc chunk. No
  // unconditional pixel floor — sub-pixel planets fade naturally
  // when their reflected-light flux drops below the slider cutoff.
  float dMEff = perceptualDmEff(appMag, uMaxAppMag, uSizeSpan, uSizeKnee);
  float appSize = perceptualAppSizePx(dMEff, uSizeMin, uSizeMax, uSizeSpan);

  float pxSize = max(appSize, physSize);
  vPhysRatio = clamp(physSize / max(pxSize, 0.001), 0.0, 1.0);
  vAppMag = appMag;
  vColor = iColour;
  vUv = aCorner;
  // Solidity → softness: rocky (1) reads crisp like a white dwarf
  // (softness 0); gas-giant (0) reads fuzzy like a hypergiant
  // (softness 1). Same shaping the star pipeline uses for lumClass.
  vSoftness = clamp(1.0 - iSolidity, 0.0, 1.0);

  // Project the planet centre, then offset each corner in screen
  // space by aCorner × pxSize. Mirrors the star vertex shader's
  // perspective-correct pixel-stable quad expansion.
  vec4 centreClip = projectionMatrix * vec4(planetView.xyz, 1.0);
  vec2 pixelOffset = aCorner * pxSize * uPixelRatio;
  vec2 ndcOffset = pixelOffset / (uViewport * uPixelRatio) * 2.0;
  gl_Position = centreClip + vec4(ndcOffset * centreClip.w, 0.0, 0.0);

  #include <logdepthbuf_vertex>
}
