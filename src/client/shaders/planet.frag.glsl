precision highp float;

#include <common>
#include <logdepthbuf_pars_fragment>
// Shared radial-intensity profile. Planet bodies render with the
// same super-Gaussian I(r) the star pipeline uses; "softness" comes
// from solidity rather than luminosity class but feeds the same
// shaping function.
#include <stellata_perceptual_disc>

uniform int uRenderMode;
uniform float uMaxAppMag;
uniform float uVisibleThreshold;
uniform float uVisibleK;
uniform float uCoreThreshold;
uniform float uDiscardThreshold;
uniform float uDistNMin;
uniform float uDistNMax;
uniform float uLumBiasMin;
uniform float uLumBiasMax;

in vec3 vColor;
in vec2 vUv;
in float vAppMag;
in float vPhysRatio;
in float vSoftness;

out vec4 outColor;

// Same disc/glow split as star.frag. physRatio ≥ threshold = disc
// pass (close-range resolved disc); below threshold = glow pass
// (distant unresolved point of light).
const float PHYS_RATIO_THRESHOLD = 0.5;

void main() {
  float r = length(vUv);
  if (r > 0.5) discard;

  // Defensive default — see star.frag rationale; the halo path below
  // conditionally writes gl_FragDepth so unwritten paths must have a
  // sensible default.
  gl_FragDepth = gl_FragCoord.z;
  #include <logdepthbuf_fragment>

  float glow = perceptualDiscProfile(
      r, vSoftness, vPhysRatio,
      uVisibleThreshold, uVisibleK,
      uDistNMin, uDistNMax,
      uLumBiasMin, uLumBiasMax);

  if (uRenderMode == 2) {
    // Core depth-mask. Same gates as the disc pass; halo fragments
    // pass through so background layers can paint behind the dim
    // outer halo. Material has colorWrite = false.
    if (vPhysRatio < PHYS_RATIO_THRESHOLD) discard;
    if (vAppMag > uMaxAppMag) discard;
    if (glow < uCoreThreshold) discard;
    outColor = vec4(0.0);
    return;
  }

  if (uRenderMode == 0) {
    // Glow pass — additive, distant point-glow planets only.
    if (vPhysRatio >= PHYS_RATIO_THRESHOLD) discard;
    float tap = 1.0 - smoothstep(uMaxAppMag, uMaxAppMag + 0.5, vAppMag);
    glow *= tap;
    outColor = vec4(vColor * glow, glow);
    return;
  }

  // Disc pass — per-channel-max, close-range resolved discs only.
  if (vPhysRatio < PHYS_RATIO_THRESHOLD) discard;
  if (vAppMag > uMaxAppMag) discard;
  if (glow < uDiscardThreshold) discard;
  // Halo fragments push depth to far so the later glow pass's
  // background sources still depth-test through them. Mirrors
  // star.frag exactly.
  if (glow < uCoreThreshold) gl_FragDepth = 1.0;
  outColor = vec4(vColor * glow, glow);
}
