precision highp float;

#include <common>
#include <logdepthbuf_pars_fragment>

in vec3 vColour;
in float vSolidity;
in float vAtmosphere;
in vec2 vQuadUv;

out vec4 outColor;

void main() {
  #include <logdepthbuf_fragment>

  float r = length(vQuadUv);
  // Outside the halo: kill the fragment. Bodies without atmosphere
  // discard at r ≥ 1.0 implicitly because vAtmosphere=0 zeroes the halo
  // contribution, and bodyAlpha drops to 0 by r=1.0 too.
  if (r >= 1.5) discard;

  // Body falloff. Solidity drives the inner-edge sharpness:
  //  - rocky bodies (solidity ≈ 1) → fade window 0.95→1.0 → near-flat
  //    top with a sharp 1-px edge;
  //  - gas giants (solidity ≈ 0) → fade window 0.5→1.0 → broad
  //    super-Gaussian-ish gradient with no hard rim.
  // smoothstep keeps it cheap; the same shader handles both regimes
  // without branches.
  float fadeStart = mix(0.5, 0.95, vSolidity);
  float bodyAlpha = 1.0 - smoothstep(fadeStart, 1.0, r);

  // Atmosphere halo. A faint contribution that peaks just outside the
  // body rim and fades to 0 at r = 1.5. Visually adds Earth/Venus-like
  // limb glow and softens the giants' silhouettes against starfields
  // without competing with the star-disc light story (the body itself
  // is alpha-blended, not additive, so the halo doesn't bloom on top
  // of bright backgrounds).
  float haloFalloff = 1.0 - smoothstep(1.0, 1.5, r);
  float haloAlpha = vAtmosphere * 0.35 * haloFalloff;

  // Combined coverage. Inside the body, the body alpha dominates; the
  // halo also lifts the rim slightly so atmospheric planets don't show
  // a hard transition at r = 1.0.
  float alpha;
  if (r < 1.0) {
    alpha = max(bodyAlpha, haloAlpha * 0.4);
  } else {
    alpha = haloAlpha;
  }
  if (alpha < 0.001) discard;

  outColor = vec4(vColour, alpha);
}
