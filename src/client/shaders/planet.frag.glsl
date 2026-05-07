precision highp float;

#include <common>
#include <logdepthbuf_pars_fragment>

in vec3 vColour;
in float vSolidity;
in vec2 vQuadUv;

out vec4 outColor;

void main() {
  #include <logdepthbuf_fragment>

  float r = length(vQuadUv);
  // Outside the body: kill the fragment. Atmospheric haloes, banding,
  // and surface textures all depend on a future close-zoom affordance
  // and are deferred — until then the disc is the entire planet.
  if (r >= 1.0) discard;

  // Body falloff. Solidity drives the inner-edge sharpness:
  //  - rocky bodies (solidity ≈ 1) → fade window 0.95→1.0 → near-flat
  //    top with a sharp 1-px edge;
  //  - gas giants (solidity ≈ 0) → fade window 0.5→1.0 → broad
  //    super-Gaussian-ish gradient with no hard rim.
  // smoothstep keeps it cheap; the same shader handles both regimes
  // without branches.
  float fadeStart = mix(0.5, 0.95, vSolidity);
  float alpha = 1.0 - smoothstep(fadeStart, 1.0, r);
  if (alpha < 0.001) discard;

  outColor = vec4(vColour, alpha);
}
