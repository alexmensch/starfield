precision highp float;

uniform float uMonochrome; // 0 = colour, 1 = ink-on-paper (multiply)
// Render mode: 0 = glow pass (additive, distant unresolved points),
// 1 = disc pass (opaque, close-range resolved stars). Each pass handles
// stars on one side of the vPhysRatio = 0.5 threshold.
uniform int uRenderMode;

in float vAppMag;
in vec3 vColor;
in vec2 vUv;
in float vPhysRatio; // 1 = physical-size-driven (render as solid disc),
                     // 0 = apparent-mag-driven (render as soft point glow)

out vec4 outColor;

const float PHYS_RATIO_THRESHOLD = 0.5;

void main() {
    float r = length(vUv);
    if (r > 0.5) discard;

    if (uRenderMode == 0) {
        // Glow pass. Handles stars where physical size is small relative
        // to apparent-brightness size (distant / moderate). Additive blend
        // lets overlapping distant stars accumulate brightness.
        if (vPhysRatio >= PHYS_RATIO_THRESHOLD) discard;

        // Smoothly morph the glow profile from "tight point glow" (far, when
        // physRatio → 0) into "flat disc" (as physRatio → 0.5) so that by
        // the time the disc pass takes over the shape already matches. The
        // max() picks whichever of the two shapes is brighter at each pixel,
        // blended by a flatness weight that grows with physRatio.
        float core = smoothstep(0.5, 0.0, r);
        float pointGlow = pow(core, 2.5);
        float flatDisc = 1.0 - smoothstep(0.46, 0.50, r);
        float flatness = clamp(vPhysRatio * 2.0, 0.0, 1.0);
        float glow = max(pointGlow, flatDisc * flatness);

        if (uMonochrome > 0.5) {
            outColor = vec4(vec3(1.0 - glow), 1.0);
        } else {
            outColor = vec4(vColor * glow, glow);
        }
    } else {
        // Disc pass. Handles physically-resolved close-range stars. Opaque
        // premultiplied-alpha + depth write so the disc properly occludes
        // anything behind it.
        if (vPhysRatio < PHYS_RATIO_THRESHOLD) discard;

        float glow = 1.0 - smoothstep(0.46, 0.50, r);

        if (uMonochrome > 0.5) {
            outColor = vec4(vec3(1.0 - glow), 1.0);
        } else {
            outColor = vec4(vColor * glow, glow);
        }
    }
}
