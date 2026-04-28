precision highp float;

uniform float uMonochrome; // 0 = colour, 1 = ink-on-paper (multiply)
// Render mode:
//   0 = glow pass (additive, distant unresolved points)
//   1 = disc pass (premul-alpha, close-range resolved stars)
//   2 = core depth-mask (depth-only, only the bright core of disc-pass
//       stars). Renders before any background layer so the Milky Way,
//       molecular clouds, and galactic grid depth-fail behind disc cores.
//       The mesh is gated on (focused star || warping) CPU-side to skip
//       the draw call entirely when no star can be in the disc pass.
uniform int uRenderMode;
// Magnitude limit, shared with the vertex shader. The vertex shader
// passes stars within +0.5 mag of the limit through (soft taper); this
// shader fades their glow-pass intensity to zero across that 0.5-mag band
// and discards them entirely from the disc pass.
uniform float uMaxAppMag;

// Star profile tuning (debug panel knobs).
//   uVisibleThreshold — curve fullness. Higher = visible disc fills more
//     of the calibrated quad; lower = longer dim outer tail.
//   uVisibleK         — derived: -log(uVisibleThreshold). Provided as a
//     uniform to avoid recomputing log() per fragment.
//   uCoreThreshold    — glow value above which the disc pass writes near
//     depth (occludes background). Below this, depth is pushed to the far
//     plane so background stars peek through the soft halo via the later
//     glow pass.
//   uDiscardThreshold — glow value below which the fragment is dropped
//     entirely (no color, no depth). Set just above 0 so the very-zero
//     edge doesn't cost a write.
//   uDistNMin / uDistNMax — super-Gaussian exponent at the distant /
//     close-range ends of vPhysRatio. Low n = Gaussian (fuzzy), high n =
//     plateau-with-edge (disc-like).
//   uLumBiasMin / uLumBiasMax — multiplied onto n by luminosity-class
//     softness (dwarf → hypergiant). Hypergiants stay fuzzier than
//     dwarfs at equivalent distance.
uniform float uVisibleThreshold;
uniform float uVisibleK;
uniform float uCoreThreshold;
uniform float uDiscardThreshold;
uniform float uDistNMin;
uniform float uDistNMax;
uniform float uLumBiasMin;
uniform float uLumBiasMax;

in float vAppMag;
in vec3 vColor;
in vec2 vUv;
in float vPhysRatio; // 1 = physical-size-driven (render as solid disc),
                     // 0 = apparent-mag-driven (render as soft point glow)
in float vSoftness;  // 0 = crisp (WD) … 1 = fuzzy (hypergiant)

out vec4 outColor;

const float PHYS_RATIO_THRESHOLD = 0.5;

// Super-Gaussian intensity profile, shared by both passes. Shape is
// I(r) = exp(-K · (2r)^n), with K chosen so the unnormalised curve hits
// uVisibleThreshold at r = 0.5; we then subtract that threshold and
// renormalise so I(0.5) = 0 exactly.
float starProfile(float r, float softness, float physRatio) {
    float distN = mix(uDistNMin, uDistNMax, smoothstep(0.0, 0.5, physRatio));
    float lumBias = mix(uLumBiasMin, uLumBiasMax, softness);
    float n = distN * lumBias;
    float raw = exp(-uVisibleK * pow(2.0 * r, n));
    return max(0.0, (raw - uVisibleThreshold) / (1.0 - uVisibleThreshold));
}

void main() {
    float r = length(vUv);
    if (r > 0.5) discard;
    float glow = starProfile(r, vSoftness, vPhysRatio);

    // Default: write our actual depth. The disc pass overrides this for
    // halo fragments so they don't occlude background stars drawn later.
    gl_FragDepth = gl_FragCoord.z;

    if (uRenderMode == 2) {
        // Core depth-mask — write near depth only for disc-pass cores.
        // Same disc-pass gates so we don't write depth for stars that
        // wouldn't render colour. Halo is discarded so background layers
        // can paint through it (the disc pass handles the halo's own
        // depth via gl_FragDepth = 1.0 below).
        if (vPhysRatio < PHYS_RATIO_THRESHOLD) discard;
        if (vAppMag > uMaxAppMag) discard;
        if (glow < uCoreThreshold) discard;
        outColor = vec4(0.0); // ignored — material has colorWrite = false
        return;
    }

    if (uRenderMode == 0) {
        // Glow pass — only point-dominated stars. Additive blending so
        // overlapping distant stars accumulate brightness.
        if (vPhysRatio >= PHYS_RATIO_THRESHOLD) discard;
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
        // blending; depth handling below decides whether each fragment
        // occludes the background.
        if (vPhysRatio < PHYS_RATIO_THRESHOLD) discard;
        // The taper region (m_lim, m_lim + 0.5] is glow-only — resolved
        // discs at threshold would render as a sub-pixel speck and read as
        // a hard cutoff anyway, so keep the disc pass crisp.
        if (vAppMag > uMaxAppMag) discard;
        // Drop the imperceptible outer fringe entirely so it doesn't cost
        // a depth write or a no-op blend.
        if (glow < uDiscardThreshold) discard;
        // Halo fragments (glow below the core threshold) paint their dim
        // colour with low alpha but push depth to the far plane, so the
        // later glow pass's background stars pass the depth test and
        // accumulate additively — the haze stays visible while distant
        // stars peek through it.
        if (glow < uCoreThreshold) gl_FragDepth = 1.0;
        if (uMonochrome > 0.5) {
            outColor = vec4(vec3(1.0 - glow), 1.0);
        } else {
            outColor = vec4(vColor * glow, glow);
        }
    }
}
