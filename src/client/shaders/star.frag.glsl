precision highp float;

#include <common>
#include <logdepthbuf_pars_fragment>
// Shared radial intensity profile (perceptualDiscProfile). Same I(r)
// for any point of light — see the chunk header for the super-Gaussian
// formula and the brightness-PSF-saturation rationale.
#include <stellata_perceptual_disc>

uniform float uMonochrome; // 0 = colour, 1 = ink-on-paper (multiply)
// Render mode:
//   0 = glow pass (additive, distant unresolved points)
//   1 = disc pass (per-channel max, close-range resolved stars; see
//       applyDiscBlendDefaults in stellata.ts for the blend rationale)
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
in float vAaWidth;   // chart-mode disc edge width in vUv units (1 CSS px)

out vec4 outColor;

const float PHYS_RATIO_THRESHOLD = 0.5;

void main() {
    float r = length(vUv);
    if (r > 0.5) discard;

    // Defensive default — the halo branch below conditionally writes
    // gl_FragDepth = 1.0, and once any path in the shader writes it,
    // unwritten paths leave the value undefined per GLSL spec. The
    // logdepthbuf_fragment chunk overwrites this with the log-encoded
    // depth when USE_LOGDEPTHBUF is defined (the renderer's current
    // config), but keeping the unconditional write means the shader
    // stays correct if logarithmicDepthBuffer is ever toggled off.
    gl_FragDepth = gl_FragCoord.z;
    #include <logdepthbuf_fragment>

    // Chart mode: flatten everything. Stars render as solid hard-edged
    // discs filling the inscribed circle of the calibrated quad, against
    // the paper background under MultiplyBlending. No glow profile, no
    // halo, no luminosity-class softening — the brightness-driven quad
    // size is the only encoding of magnitude. The vertex shader passes
    // vAaWidth as 1 CSS pixel in vUv space so the edge is always one
    // pixel wide regardless of quad size. (Earlier `fwidth(r)` was
    // unstable near the quad centre — `length(vUv)` has an undefined
    // screen-space derivative at vUv = 0 and tiny quads ended up with
    // disc≈0.5 in the middle, rendering as a faint grey rather than
    // solid black.)
    if (uMonochrome > 0.5) {
        if (uRenderMode == 0 && vPhysRatio >= PHYS_RATIO_THRESHOLD) discard;
        if (uRenderMode == 1 && vPhysRatio <  PHYS_RATIO_THRESHOLD) discard;
        if (uRenderMode == 2 && vPhysRatio <  PHYS_RATIO_THRESHOLD) discard;
        if (vAppMag > uMaxAppMag) discard;
        float aa = max(vAaWidth, 1e-3);
        float disc = 1.0 - smoothstep(0.5 - aa, 0.5, r);
        if (disc <= 0.0) discard;
        if (uRenderMode == 2) {
            outColor = vec4(0.0); // material has colorWrite = false on the mask
            return;
        }
        // MultiplyBlending: rgb = 1.0 leaves dst unchanged, rgb = 0.0
        // multiplies dst toward black. mix(1, 0, disc) paints solid
        // black ink with an antialiased outer pixel.
        outColor = vec4(vec3(1.0 - disc), 1.0);
        return;
    }

    float glow = perceptualDiscProfile(
        r, vSoftness, vPhysRatio,
        uVisibleThreshold, uVisibleK,
        uDistNMin, uDistNMax,
        uLumBiasMin, uLumBiasMax);

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
        outColor = vec4(vColor * glow, glow);
    } else {
        // Disc pass — only disc-dominated stars. Per-channel MaxEquation
        // blending (see applyDiscBlendDefaults); depth handling below
        // decides whether each fragment occludes the background.
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
        outColor = vec4(vColor * glow, glow);
    }
}
