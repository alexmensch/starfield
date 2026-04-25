precision highp float;

// Soft additive sprite — radial falloff centred on the quad. Many of these
// overlapping in dense regions accumulate via the additive blend mode to
// produce a visually smooth dust glow; in diffuse regions they appear as
// individual faint specks, which feels closer to "ground truth" for those
// regions than a smoothed volumetric pass would.

in vec2 vUv;
in float vBrightness;
out vec4 outColor;

const vec3 DUST_TINT = vec3(0.70, 0.55, 0.38);

void main() {
    float r = length(vUv);
    if (r > 0.5) discard;
    // Quadratic radial falloff so particle edges fade smoothly into the
    // background — sharper than linear, softer than exp.
    float falloff = 1.0 - r * 2.0;
    falloff = falloff * falloff;
    outColor = vec4(DUST_TINT * falloff * vBrightness, 1.0);
}
