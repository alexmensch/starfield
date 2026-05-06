precision highp float;

#include <common>
#include <logdepthbuf_pars_vertex>

// Dust-particle vertex shader. Each particle is one instance of a unit
// quad expanded into a screen-space billboard sized by the particle's
// density (denser cores → larger sprites, so dense cloud regions show up
// as both more particles AND brighter individual ones). Positions are in
// absolute ICRS pc; we shift by the renderer's floating-origin offset
// before applying the modelview matrix.

uniform float uPixelRatio;
uniform vec2 uViewport;
uniform float uParticleStrength;
uniform float uDustEnabled;
uniform vec3 uWorldOffset;

// Density log-window for size/brightness mapping. Matches the dust
// texture's log encoding range so a particle's density value lands
// somewhere meaningful in the scale.
uniform float uDustDensityMin;
uniform float uDustLogRatio;

in vec2 aCorner;
in vec3 iPosition;   // absolute ICRS parsec coords
in float iDensity;

out vec2 vUv;
out float vBrightness;

// Particles render as wide, dim splats rather than visible point sprites.
// At these sizes a single particle is barely above the perceptual floor;
// dense cloud regions become visible only because dozens or hundreds of
// particles overlap and additively accumulate. This reads as diffuse fog
// rather than as a star-like point cloud — the visual cue we want.
const float MIN_PX = 30.0;
const float MAX_PX = 80.0;
const float LOG10 = 2.302585093;

void main() {
    if (uDustEnabled < 0.5 || uParticleStrength <= 0.0) {
        // Skipping <logdepthbuf_vertex> here is safe because the
        // suppression keys on uniforms — every vert of every primitive
        // takes this path together, so the whole primitive lands at
        // the same off-screen NDC and is clipped before rasterization.
        // See star.vert.glsl for the matching invariant note.
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off-screen
        return;
    }

    // Density → normalised [0, 1] using the same log window the dust
    // texture decode uses, so this scale matches the visible range of
    // real Edenhofer values rather than being calibrated against
    // synthetic peaks.
    float logD = log(max(iDensity, uDustDensityMin)) / LOG10;
    float logMin = log(uDustDensityMin) / LOG10;
    float logSpan = uDustLogRatio / LOG10;
    float normD = clamp((logD - logMin) / max(logSpan, 0.001), 0.0, 1.0);

    vBrightness = mix(0.15, 1.0, normD) * uParticleStrength;
    float pxSize = mix(MIN_PX, MAX_PX, normD);

    // Local-frame position so the floating-origin shift cancels and the
    // GPU never sees kpc-scale translations in the modelview.
    vec3 localPos = iPosition - uWorldOffset;

    vec4 centerClip = projectionMatrix * modelViewMatrix * vec4(localPos, 1.0);
    vec2 pixelOffset = aCorner * pxSize * uPixelRatio;
    vec2 ndcOffset = pixelOffset / (uViewport * uPixelRatio) * 2.0;
    gl_Position = centerClip + vec4(ndcOffset * centerClip.w, 0.0, 0.0);
    vUv = aCorner;

    #include <logdepthbuf_vertex>
}
