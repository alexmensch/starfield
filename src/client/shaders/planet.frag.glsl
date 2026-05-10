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
    // Outer-disc CORRUPT pass (stellata-3re.19). Writes near-plane
    // depth (gl_FragDepth = 0.0) across the planet's core region so
    // the orbit ring at renderOrder 2 depth-fails regardless of its
    // 3D position — including near-side ring segments physically in
    // front of the planet. The conceptual rule the user wants is "the
    // planet looks solid; the orbit ring is hidden wherever it would
    // overlap the body, from any angle." Pure depth occlusion can't
    // express that (near-side rings legitimately have smaller depth
    // than the planet centre), so we corrupt the framebuffer depth to
    // a value the ring is guaranteed to exceed.
    //
    // Gated on `glow >= uCoreThreshold` (NOT `>= uDiscardThreshold` as
    // before) so the ring discontinuity matches the bright body, not
    // the dim perceptual halo — tighter break, more readable.
    //
    // The corrupted depth is restored to gl_FragCoord.z at
    // renderOrder 2.5 (uRenderMode == 4) before disc/glow at 3/4 run,
    // so multi-planet/star depth occlusion downstream still works.
    if (vAppMag > uMaxAppMag) discard;
    if (glow < uCoreThreshold) discard;
    // Override the chunk's log-depth write — we want screen-space 0.0,
    // which is the near plane in any depth encoding.
    gl_FragDepth = 0.0;
    outColor = vec4(0.0);
    return;
  }

  if (uRenderMode == 4) {
    // Outer-disc RESTORE pass (stellata-3re.19). Runs at renderOrder
    // 2.5 after the orbit rings have depth-failed against the corrupt
    // pass's 0.0, and writes the planet's actual depth back so disc /
    // glow at renderOrder 3 / 4 depth-test and write correctly. The
    // material has `depthFunc: AlwaysDepth` so it can overwrite the
    // 0.0 (default LessEqual would reject `planet_z > 0.0`).
    //
    // Same gate as the corrupt pass — same screen region.
    // gl_FragDepth is left as the chunk's log-depth-correct value.
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
