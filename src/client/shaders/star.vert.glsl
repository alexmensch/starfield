precision highp float;

uniform vec3 uCameraPos;
uniform float uMaxAppMag;
uniform float uMinDistSol;
uniform float uMaxDistSol;
uniform uint uSpectMask;
uniform float uPixelRatio;
uniform float uSizeMin;
uniform float uSizeMax;
uniform float uSizeSpan;

// Physical-size rendering term. At the reference camera distance uRefDistPc
// (= the default controls.minDistance), a star's rendered pixel size is a
// linear mapping of log10(radius) into [uPhysMinPx, uPhysMaxPx]. The
// effective size scales as uRefDistPc/dPc so the term falls off with 1/d
// and is effectively invisible beyond a few pc — at that range the
// brightness-based apparent-magnitude term dominates, which is what
// `max(appSize, physSize)` at the end of main() preserves.
uniform float uLogRMin;   // log10 of smallest physicalRadius in catalog
uniform float uLogRMax;   // log10 of largest  physicalRadius in catalog
uniform float uPhysMinPx; // pixel size floor at ref distance (e.g. 2 px)
uniform float uPhysMaxPx; // pixel size ceiling at ref distance — typically
                          // 50% of min viewport axis, updated on resize
uniform float uRefDistPc; // the distance at which uPhysMaxPx applies
uniform vec2 uViewport;   // viewport size in CSS pixels (for quad expansion)

// Per-vertex: unit-square corner in [-0.5, +0.5] × [-0.5, +0.5], used to
// expand each instanced quad around its projected star centre.
in vec2 aCorner;

// Per-instance: attributes that vary from star to star.
in vec3 iPosition;
in float iAbsmag;
in float iCi;
in float iSpectClass;
in float iLogRadius;

out float vAppMag;
out vec3 vColor;
out vec2 vUv;          // (-0.5..+0.5) passed to frag for the disk mask
out float vPhysRatio;  // physSize / pxSize, in [0,1] — 1 means the physical
                       // term is driving the size (close range, resolve as a
                       // disc); 0 means the apparent-mag term is driving
                       // (distant, render as a soft glow)

const float LOG10 = 2.302585093;

vec3 ciToColor(float ciVal) {
    float t = clamp((ciVal + 0.4) / 2.4, 0.0, 1.0);
    vec3 hot  = vec3(0.65, 0.78, 1.00);
    vec3 mid  = vec3(1.00, 0.98, 0.92);
    vec3 cool = vec3(1.00, 0.55, 0.35);
    return t < 0.5 ? mix(hot, mid, t * 2.0) : mix(mid, cool, (t - 0.5) * 2.0);
}

void main() {
    vec3 worldPos = iPosition;
    float distSol = length(worldPos);
    float distCam = distance(worldPos, uCameraPos);

    float dPc = max(distCam, 0.001);
    float appMag = iAbsmag + 5.0 * (log(dPc) / LOG10 - 1.0);

    bool spectOk = (uSpectMask & (1u << uint(iSpectClass))) != 0u;
    bool distOk = distSol >= uMinDistSol && distSol <= uMaxDistSol;
    bool magOk = appMag <= uMaxAppMag;
    bool visible = spectOk && distOk && magOk;

    if (!visible) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vAppMag = appMag;
        vColor = vec3(0.0);
        vUv = aCorner;
        vPhysRatio = 0.0;
        return;
    }

    vAppMag = appMag;
    vColor = ciToColor(iCi);
    vUv = aCorner;

    // Apparent-magnitude size term (CSS pixels).
    float brightness = clamp((uMaxAppMag - appMag) / max(uSizeSpan, 0.001), 0.0, 1.0);
    float appSize = mix(uSizeMin, uSizeMax, brightness);

    // Physical-size term. Log-map the star's radius into the size range,
    // then scale by ref/distance so the curve falls off with distance.
    float logSpan = max(uLogRMax - uLogRMin, 0.001);
    float logRatio = clamp((iLogRadius - uLogRMin) / logSpan, 0.0, 1.0);
    float sizeAtRef = mix(uPhysMinPx, uPhysMaxPx, logRatio);
    float physSize = sizeAtRef * (uRefDistPc / dPc);

    float pxSize = max(appSize, physSize);
    vPhysRatio = clamp(physSize / max(pxSize, 0.001), 0.0, 1.0);

    // Project the star centre to clip space, then offset each corner in
    // screen space by aCorner × pxSize. Multiplying the clip-space offset
    // by centreClip.w makes it perspective-correct (so the quad stays the
    // same pixel size regardless of depth).
    vec4 centreClip = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    vec2 pixelOffset = aCorner * pxSize * uPixelRatio;
    vec2 ndcOffset = pixelOffset / (uViewport * uPixelRatio) * 2.0;
    gl_Position = centreClip + vec4(ndcOffset * centreClip.w, 0.0, 0.0);
}
