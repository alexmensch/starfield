precision highp float;

uniform vec3 uColor;
uniform vec3 uMonoColor;
uniform float uOpacity;
uniform float uMonochrome;

in vec3 vNormalView;

out vec4 outColor;

void main() {
  // Approximate "thickness through the ellipsoid" along the view ray. A
  // surface point whose normal aligns with the view axis (|n·v| ≈ 1) sits
  // in the middle of the projected disc — the ray traverses the most
  // material — so density should be highest there. At the silhouette
  // (n·v ≈ 0) the ray grazes the surface and traverses almost nothing.
  // We render double-sided so |·| picks up both the near and far face,
  // which roughly sums to "thickness through the sphere" along the ray.
  // Raising to a power softens the falloff so the edge fades smoothly
  // rather than terminating in a hard line.
  float ndv = abs(dot(normalize(vNormalView), vec3(0.0, 0.0, 1.0)));
  float density = pow(ndv, 1.5);

  // Output **premultiplied alpha**. The material sets
  // `premultipliedAlpha: true`, so:
  //  - dark mode (AdditiveBlending) → blend func (ONE, ONE) → dst gets
  //    pure additive of `color × intensity`, no double-alpha attenuation
  //    (which is what was making clouds look invisible: src.a was being
  //    multiplied into rgb a second time, dropping peak brightness ~30×).
  //  - chart mode (NormalBlending) → blend func (ONE, ONE_MINUS_SRC_ALPHA)
  //    → standard premultiplied alpha-over: dst × (1-α) + color × α.
  vec3 col = (uMonochrome > 0.5) ? uMonoColor : uColor;
  float intensity = density * uOpacity;
  outColor = vec4(col * intensity, intensity);
}
