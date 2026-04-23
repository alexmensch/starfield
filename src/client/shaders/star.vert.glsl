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

// Variability. uTime is real elapsed seconds. Per-star period is in days
// (0 = not a variable), per-star amplitude is in magnitudes. uSecondsPerDay
// scales simulated time (how many real seconds pass per catalog day); lower
// values = faster-appearing cycles. uMinPeriodSec clamps the effective
// cycle period so even short-period variables (RR Lyrae, ~half a day) don't
// strobe faster than that threshold.
uniform float uTime;
uniform float uSecondsPerDay;
uniform float uMinPeriodSec;

// Per-vertex: unit-square corner in [-0.5, +0.5] × [-0.5, +0.5], used to
// expand each instanced quad around its projected star centre.
in vec2 aCorner;

// Per-instance: attributes that vary from star to star.
in vec3 iPosition;
in float iAbsmag;
in float iCi;
in float iSpectClass;
in float iLogRadius;
in float iPeriodDays;   // 0 = not a variable
in float iAmplitudeMag; // 0 = not a variable
in float iLumClass;     // 0=WD, 2=V, 4=III, 6-9=supergiant/hypergiant, 255=?

out float vAppMag;
out vec3 vColor;
out vec2 vUv;          // (-0.5..+0.5) passed to frag for the disk mask
out float vPhysRatio;  // physSize / pxSize, in [0,1] — 1 means the physical
                       // term is driving the size (close range, resolve as a
                       // disc); 0 means the apparent-mag term is driving
                       // (distant, render as a soft glow)
out float vSoftness;   // 0 = crisp (white dwarf), 1 = fuzzy (hypergiant) —
                       // drives halo falloff and disc-edge AA width

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

    // Variability. The same magnitude modulation drives two visual effects:
    //   (1) appMag shifts — changes the point-glow size at ranges where the
    //       star isn't already at max brightness. Handles distant variables.
    //   (2) physical-radius scaling — at close range the point-glow is
    //       saturated so appMag clipping hides the modulation; scaling the
    //       resolved disc radius makes the pulse visible instead. Stefan-
    //       Boltzmann-style: radius scales as sqrt(linear brightness), i.e.
    //       10^(-magMod / 5). Physically motivated for Miras and Cepheids.
    //
    // The effective amplitude is compressed per-frame so that at the star's
    // current baseSize the pulse stays within a sensible display range —
    // peak ≤ uPhysMaxPx, trough ≥ VAR_TROUGH_FLOOR_FRACTION × baseSize.
    // Keeps the sine smooth (no plateau at peak, no disappearing at trough)
    // even for extreme-amplitude variables like Mira.
    float radiusFactor = 1.0;
    float magMod = 0.0;
    if (iPeriodDays > 0.0 && iAmplitudeMag > 0.0) {
        float periodSec = max(iPeriodDays * uSecondsPerDay, uMinPeriodSec);
        float phase = uTime / periodSec;

        // Precompute base (un-modulated) physSize to know how much headroom
        // we have in each direction.
        float logSpan0 = max(uLogRMax - uLogRMin, 0.001);
        float logRatio0 = clamp((iLogRadius - uLogRMin) / logSpan0, 0.0, 1.0);
        float sizeAtRef0 = mix(uPhysMinPx, uPhysMaxPx, logRatio0);
        float baseSize0 = sizeAtRef0 * (uRefDistPc / dPc);

        const float VAR_TROUGH_FLOOR_FRACTION = 0.2;
        float maxUpLog10 = log(max(uPhysMaxPx / max(baseSize0, 1.0), 1.0)) / LOG10;
        float maxDownLog10 = -log(VAR_TROUGH_FLOOR_FRACTION) / LOG10; // ≈ 0.699
        float ampLimitMag = 10.0 * min(maxUpLog10, maxDownLog10);
        float ampEff = min(iAmplitudeMag, max(0.0, ampLimitMag));

        magMod = 0.5 * ampEff * sin(6.2831853 * phase);
        appMag += magMod;
        radiusFactor = pow(10.0, -magMod / 5.0);
    }

    bool spectOk = (uSpectMask & (1u << uint(iSpectClass))) != 0u;
    bool distOk = distSol >= uMinDistSol && distSol <= uMaxDistSol;
    bool magOk = appMag <= uMaxAppMag;
    bool visible = spectOk && distOk && magOk;

    // Luminosity-class softness: linear from white dwarf (0) → hypergiant
    // (9). Unknown (iLumClass = 255) falls back to main-sequence-dwarf
    // softness. Feeds the fragment shader's glow falloff and disc-edge AA
    // width so supergiants look "fluffier" than dwarfs at the same radius.
    float lumClass = iLumClass < 100.0 ? iLumClass : 2.0;
    float softness = clamp(lumClass / 9.0, 0.0, 1.0);

    if (!visible) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vAppMag = appMag;
        vColor = vec3(0.0);
        vUv = aCorner;
        vPhysRatio = 0.0;
        vSoftness = softness;
        return;
    }

    vAppMag = appMag;
    vColor = ciToColor(iCi);
    vUv = aCorner;
    vSoftness = softness;

    // Apparent-magnitude size term (CSS pixels).
    float brightness = clamp((uMaxAppMag - appMag) / max(uSizeSpan, 0.001), 0.0, 1.0);
    float appSize = mix(uSizeMin, uSizeMax, brightness);

    // Physical-size term. Log-map the star's radius into the size range,
    // then scale by ref/distance so the curve falls off with distance.
    // radiusFactor is the already-compressed variability modulation above.
    float logSpan = max(uLogRMax - uLogRMin, 0.001);
    float logRatio = clamp((iLogRadius - uLogRMin) / logSpan, 0.0, 1.0);
    float sizeAtRef = mix(uPhysMinPx, uPhysMaxPx, logRatio);
    float physSize = sizeAtRef * (uRefDistPc / dPc) * radiusFactor;

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
