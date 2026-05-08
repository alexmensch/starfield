precision highp float;

#include <common>
#include <logdepthbuf_pars_fragment>

in vec3 vNormalView;
in vec3 vPositionView;

uniform vec3 uColour;
// Alpha at the silhouette (limb). Face-on alpha is `uAlphaLimb · uFaceOnFloor`.
uniform float uAlphaLimb;
// Floor multiplier applied face-on (where Fresnel → 0). Keeps the
// upwind apex region from disappearing entirely; tune toward 0 for
// pure rim, toward 1 for the original flat shell.
uniform float uFaceOnFloor;
// Fresnel exponent. Larger = tighter rim. ~2 reads as a soft halo,
// ~5 reads as a thin glowing edge.
uniform float uFresnelPower;

out vec4 outColor;

void main() {
  #include <logdepthbuf_fragment>

  // View direction: camera at view-space origin, so −position / |position|.
  vec3 viewDir = normalize(-vPositionView);
  float ndotv = max(dot(normalize(vNormalView), viewDir), 0.0);
  // Fresnel = 1 at the silhouette (ndotv → 0), 0 face-on (ndotv → 1).
  float fresnel = pow(1.0 - ndotv, uFresnelPower);
  float alpha = uAlphaLimb * mix(uFaceOnFloor, 1.0, fresnel);

  outColor = vec4(uColour, alpha);
}
