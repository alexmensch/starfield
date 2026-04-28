precision highp float;

uniform float uMonochrome; // 0 = colour, 1 = ink-on-paper (multiply)
// Render mode: 0 = glow pass (additive, distant unresolved points),
// 1 = disc pass (opaque, close-range resolved stars). Each pass handles
// stars on one side of the vPhysRatio = 0.5 threshold.
uniform int uRenderMode;
// Magnitude limit, shared with the vertex shader. The vertex shader
// passes stars within +0.5 mag of the limit through (soft taper); this
// shader fades their glow-pass intensity to zero across that 0.5-mag band
// and discards them entirely from the disc pass.
uniform float uMaxAppMag;

in float vAppMag;
in vec3 vColor;
in vec2 vUv;
in float vPhysRatio; // 1 = physical-size-driven (render as solid disc),
                     // 0 = apparent-mag-driven (render as soft point glow)
in float vSoftness;  // 0 = crisp (WD) … 1 = fuzzy (hypergiant)

out vec4 outColor;

const float PHYS_RATIO_THRESHOLD = 0.5;

void main() {
    float r = length(vUv);
    if (r > 0.5) discard;

    if (uRenderMode == 0) {
        // Glow pass — only point-dominated stars. Additive blending so
        // overlapping distant stars accumulate brightness. The falloff
        // exponent varies with luminosity class: dwarfs have tight cores
        // (higher power), supergiants have softer wider haloes (lower
        // power). Variation is subtle to avoid cartoony differences.
        if (vPhysRatio >= PHYS_RATIO_THRESHOLD) discard;

        float core = smoothstep(0.5, 0.0, r);
        float pointGlow = pow(core, mix(3.0, 1.8, vSoftness));
        float flatDisc = 1.0 - smoothstep(0.46, 0.50, r);
        float flatness = clamp(vPhysRatio * 2.0, 0.0, 1.0);
        float glow = max(pointGlow, flatDisc * flatness);
        // Soft taper: fade intensity to zero across the 0.5-mag band past
        // the magnitude limit so stars don't pop in/out at the threshold.
        float tap = 1.0 - smoothstep(uMaxAppMag, uMaxAppMag + 0.5, vAppMag);
        glow *= tap;
        if (uMonochrome > 0.5) {
            outColor = vec4(vec3(1.0 - glow), 1.0);
        } else {
            outColor = vec4(vColor * glow, glow);
        }
    } else {
        // Disc pass — only disc-dominated stars. Premultiplied-alpha
        // blending + depth write so close stars occlude anything behind.
        // Edge AA band widens with luminosity class so supergiants look
        // fuzzier at the limb while white dwarfs stay crisp.
        if (vPhysRatio < PHYS_RATIO_THRESHOLD) discard;
        // The taper region (m_lim, m_lim + 0.5] is glow-only — resolved
        // discs at threshold would render as a sub-pixel speck and read as
        // a hard cutoff anyway, so keep the disc pass crisp.
        if (vAppMag > uMaxAppMag) discard;

        // Edge AA: transition from fully-lit to transparent happens over
        // a band that's 2% of radius for WDs, ~12% for hypergiants.
        float edgeOuter = 0.5;
        float edgeInner = mix(0.48, 0.38, vSoftness);
        float glow = 1.0 - smoothstep(edgeInner, edgeOuter, r);

        if (uMonochrome > 0.5) {
            outColor = vec4(vec3(1.0 - glow), 1.0);
        } else {
            outColor = vec4(vColor * glow, glow);
        }
    }
}
