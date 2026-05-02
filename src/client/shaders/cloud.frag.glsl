precision highp float;

#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uColor;
uniform vec3 uMonoColor;
uniform float uOpacity;
uniform float uMonochrome;
// Chart-mode isobar pass. When > 0.5, the fragment renders as a thin
// outline at a density iso-line whose threshold is driven by uMaxAppMag —
// at naked-eye limits (6.5) only thick "cores" of each cloud show; at the
// all-stars limit (15) the outline migrates outward toward the silhouette.
// Reads as a topographic-style contour map of the dust silhouette.
uniform float uChartIsobar;
uniform float uMaxAppMag;

in vec3 vNormalView;

out vec4 outColor;

void main() {
  #include <logdepthbuf_fragment>

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

  if (uChartIsobar > 0.5) {
    // Single solid contour line. Map maxAppMag ∈ [6.5, 15] to a density
    // threshold ∈ [~0.55, 0.05] — lower mag limit → higher threshold
    // → tighter line around the cloud's dense core; higher limit →
    // lower threshold → line migrates outward to the silhouette.
    float t = clamp((15.0 - uMaxAppMag) / 8.5, 0.05, 0.95) * 0.5 + 0.05;
    // Use the per-pixel rate of change of `density` to pick a constant
    // 1-px-wide solid line regardless of how steep the local gradient
    // is. fwidth = |dFdx| + |dFdy|; smoothstep across [0.5, 1.5]·fw
    // gives an antialiased single-pixel ink line.
    float fw = max(fwidth(density), 1e-5);
    float line = 1.0 - smoothstep(fw * 0.5, fw * 1.5, abs(density - t));
    if (line <= 0.0) discard;
    // Solid ink: alpha tracks line coverage but rgb stays at full
    // mono colour so the line reads as uniform black-ink against the
    // chart background. Premultiplied output for NormalBlending.
    outColor = vec4(uMonoColor * line, line);
    return;
  }

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
