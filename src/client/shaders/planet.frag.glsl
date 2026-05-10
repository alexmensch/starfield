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

  if (uRenderMode == 3) {
    // Outer-disc STENCIL pass (stellata-3re.19). Writes a stencil bit
    // (1) at the planet's core region. The orbit-ring material has
    // `stencilFunc: NotEqual` against that bit, so any ring fragment
    // landing on a planet body's screen footprint is discarded outright
    // — regardless of 3D depth. This is what makes the planet read as
    // a solid 2D shape that bisects its own ring (and any other ring
    // that happens to overlap), from any viewing angle.
    //
    // Why stencil instead of depth tricks: at typical Mercury-class
    // viewing distances Mercury's log-depth-encoded depth is on the
    // order of 1e-7, indistinguishable from 0.0 in a 16-bit depth
    // buffer. So `gl_FragDepth = 0.0` to "mask" the ring — what an
    // earlier iteration of this fix tried — failed at the planet's own
    // tangent (the ring segment AT the planet's exact orbital position,
    // where the ring's depth equals the planet's depth and both round
    // to the same buffer value). Stencil is precision-independent —
    // either the bit is set or it isn't.
    //
    // Material settings (planet-body-field.ts): stencilWrite=true,
    // stencilFunc=AlwaysStencilFunc, stencilRef=1, stencilZPass=
    // ReplaceStencilOp. depthTest=true so the bit only goes down where
    // the planet is actually visible (occluded by Sol → no stencil →
    // ring shows through, which is what you want).
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
