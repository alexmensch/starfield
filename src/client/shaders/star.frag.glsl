precision highp float;

uniform float uMonochrome; // 0 = colour (additive), 1 = ink-on-paper (multiply)

in float vAppMag;
in vec3 vColor;

out vec4 outColor;

void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv);
    if (r > 0.5) discard;

    float core = smoothstep(0.5, 0.0, r);
    float glow = pow(core, 2.5);

    if (uMonochrome > 0.5) {
        // Multiply-blend against a light canvas: emit (1 - glow) so each
        // star darkens the background in proportion to its intensity.
        outColor = vec4(vec3(1.0 - glow), 1.0);
    } else {
        outColor = vec4(vColor * glow, glow);
    }
}
