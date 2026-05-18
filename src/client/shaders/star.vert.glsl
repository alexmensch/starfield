precision highp float;

#include <common>
#include <logdepthbuf_pars_vertex>
// Shared apparent-magnitude → disc-pixel-size mapping. Same physics
// for any point of light (stars, planets, ...). See the chunk header
// for what perceptualDmEff / perceptualAppSizePx do.
#include <stellata_perceptual_disc>

uniform vec3 uCameraPos;
uniform float uMaxAppMag;
uniform float uMinDistSol;
uniform float uMaxDistSol;
uniform uint uSpectMask;
// Index of a star to suppress entirely (all three passes — disc, glow, core
// mask — share this vertex shader). Set to the focused-star index in
// OBSERVE mode so the star the camera is parked on doesn't render. -1 in
// every other mode disables the suppression by construction (gl_InstanceID
// is non-negative).
uniform int uHideFocusIdx;
// Force-center the focused star at NDC (0,0). At extreme close approach
// (~5×10⁻⁸ pc for Sol-class stars), float32 cancellation in the matrix
// chain can drift the projected centre by visible pixels even though
// `controls.target = focused star + lookAt` puts it mathematically at
// view-origin. JS-side stellata sets this to the focused-star index
// when the camera-target alignment holds; -1 means use the default
// projection path.
uniform int uPinFocusToCenter;
uniform float uPixelRatio;
uniform float uSizeMin;
uniform float uSizeMax;
uniform float uSizeSpan;
// Soft-knee saturation extent (magnitudes). 0 = hard-clamp at sizeSpan
// (legacy); larger values let bright stars keep growing past the
// linear ceiling. See the perceptual-disc chunk for the formula and
// the rationale (Sol-vs-Barnard ratio at close approach).
uniform float uSizeKnee;
// Chart-mode disc sizing. Stars render as flat hard-edged discs whose
// pixel diameter spreads linearly between [Min, Max] across the visible
// magnitude range [Bright, MaxAppMag]. Linear in mag = log10 in flux,
// matching naked-eye perception (defined that way). Uniforms read only
// when uMonochrome > 0.5; outside chart mode the existing physical-size
// + apparent-magnitude blend formula runs unchanged.
uniform float uChartDiscMaxPx;   // brightest end (e.g. 16 px)
uniform float uChartDiscMinPx;   // faintest end (e.g. 1.5 px)
uniform float uChartMagBright;   // magnitude that maps to MAX (e.g. -2.0)
uniform float uMonochrome;       // 0 = colour mode, 1 = chart mode (shared with frag)

// Physical-size rendering term. A star's rendered pixel diameter equals
// its true angular diameter through the camera's projection:
//   pxSize = 2·atan(R · radiusFactor / d) · viewport.y / fov_y_rad
// R is the per-star physical radius in pc — iLogRadius is in solar
// radii (matching catalog.physicalRadius), so we multiply through by
// uRSunPc (≈ 2.2543e-8 pc/R_sun) to land in pc-relative-to-d.
// radiusFactor is the variability modulation. Falls off as 1/d in the
// small-angle regime and saturates as d → R (disc fills the frame).
uniform float uFovYRad;   // camera vertical FOV in radians
uniform float uRSunPc;    // 1 R_sun in parsecs; canonical R_SUN_PC in astronomy-constants.ts
uniform vec2 uViewport;   // viewport size in CSS pixels (for quad expansion)
// Variability headroom drivers, mirroring the TS-side ZOOM_FLOOR_FRACTION
// and VAR_TROUGH_FLOOR_FRACTION. Driven from a single source in stellata.ts.
uniform float uMaxPhysFrac;     // peak disc fraction of min(viewport) (= ZOOM_FLOOR_FRACTION)
uniform float uVarTroughFrac;   // trough floor fraction relative to baseSize

// Variability. uTime is real elapsed seconds. Per-star period is in days
// (0 = not a variable), per-star amplitude is in magnitudes. uSecondsPerDay
// scales simulated time (how many real seconds pass per catalog day); lower
// values = faster-appearing cycles. uMinPeriodSec clamps the effective
// cycle period so even short-period variables (RR Lyrae, ~half a day) don't
// strobe faster than that threshold.
uniform float uTime;
uniform float uSecondsPerDay;
uniform float uMinPeriodSec;

// Interstellar-dust extinction. uDustTexture is a 3D scalar field of
// log-encoded density in heliocentric ICRS Cartesian parsecs, spanning
// [-uDustBoundsPc, +uDustBoundsPc] on each axis. uDustEnabled is a binary
// "is the texture bound?" flag; uExtinctionStrength is a user-facing
// multiplier (0 = off, 1 = realism, >1 = amplified for visibility).
//
// Raymarch runs in absolute space (iPosition + uWorldOffset, uCameraPos +
// uWorldOffset) so the floating-origin recentering is transparent here.
// Output is a V-band extinction magnitude added to appMag, with a matching
// colour-index shift (E(B-V) = A_V / R_V) to redden the star's colour.
uniform highp sampler3D uDustTexture;
uniform float uDustBoundsPc;
// Log-window decode: density = uDustDensityMin * exp(sample * uDustLogRatio),
// where uDustLogRatio = ln(densityMax / densityMin). Inverts the Python
// encoder's pure-log scaling over [densityMin, densityMax].
uniform float uDustDensityMin;
uniform float uDustLogRatio;
uniform float uDustAvPerDensityPc;  // ZGR23 density × pc → A_V magnitude
uniform float uDustEnabled;         // 0 = no texture bound, 1 = bound
uniform float uExtinctionStrength;  // user knob; multiplied onto uDustEnabled
uniform vec3 uWorldOffset;          // absolute coord of renderer's local origin

const int DUST_STEPS = 48;
const float R_V = 3.1; // canonical interstellar reddening ratio: A_V / E(B-V)

// Per-vertex: unit-square corner in [-0.5, +0.5] × [-0.5, +0.5], used to
// expand each instanced quad around its projected star centre.
in vec2 aCorner;

// Per-instance: attributes that vary from star to star.
// iPosition is in the renderer's local frame — which may be offset from
// absolute catalog space via the CPU-side floating-origin mechanism (see
// Stellata.recenterOrigin). Do NOT use length(iPosition) for any
// distance-from-Sol computation; use iDistSol instead.
in vec3 iPosition;
in float iAbsmag;
in float iCi;
in float iSpectClass;
in float iLogRadius;
in float iPeriodDays;   // 0 = not a variable
in float iAmplitudeMag; // 0 = not a variable
in float iLumClass;     // 0=WD, 2=V, 4=III, 6-9=supergiant/hypergiant, 255=?
in float iDistSol;      // |absolute position| — precomputed at load

out float vAppMag;
out vec3 vColor;
out vec2 vUv;          // (-0.5..+0.5) passed to frag for the disk mask
out float vPhysRatio;  // physSize / pxSize, in [0,1] — 1 means the physical
                       // term is driving the size (close range, resolve as a
                       // disc); 0 means the apparent-mag term is driving
                       // (distant, render as a soft glow)
out float vSoftness;   // 0 = crisp (white dwarf), 1 = fuzzy (hypergiant) —
                       // drives halo falloff and disc-edge AA width
// Chart-mode anti-aliasing. Width of the disc edge in vUv units, computed
// per quad in the vertex shader as `1.0 / pxSize`. Stable across quad
// sizes — the alternative `fwidth(r)` blows up near the quad centre where
// the screen-space derivative of `length(vUv)` is undefined, leaving the
// inner disc faint or invisible.
out float vAaWidth;

const float LOG10 = 2.302585093;

// Blackbody → sRGB lookup table indexed by B-V. 256×1 texture; the
// Ballesteros 2012 B-V→Teff conversion and Planck + CIE 1931 + sRGB
// D65 transform are baked in at LUT build time (see scripts/blackbody-lut.ts).
// BV_MIN / BV_MAX must match src/client/shaders/blackbody-lut.ts.
uniform sampler2D uColorLut;
const float BV_MIN = -0.4;
const float BV_MAX = 2.0;

vec3 ciToColor(float ciVal) {
    float t = clamp((ciVal - BV_MIN) / (BV_MAX - BV_MIN), 0.0, 1.0);
    return texture(uColorLut, vec2(t, 0.5)).rgb;
}

// Raymarch from the camera to the star through the dust texture and
// integrate V-band extinction. Returns A_V in magnitudes — how much the
// star should be dimmed. Early-exits to zero when no dust is bound or the
// user has turned extinction off.
//
// DUST_STEPS fixed samples over the ray is a pragmatic trapezoidal
// integration: step size adapts to ray length automatically (short for
// nearby stars, coarser for far ones). 48 samples is a good middle ground
// — at 1.25 kpc that's 26 pc per step, about 5 voxels, which is fine
// given the texture's native ~5 pc resolution. Bumping to 64 costs ~33%
// more vertex-shader texture reads with marginal quality gain.
float dustExtinctionAV(vec3 absStar, vec3 absCamera) {
    float effective = uDustEnabled * uExtinctionStrength;
    if (effective <= 0.0) return 0.0;

    vec3 delta = absStar - absCamera;
    float lenPc = length(delta);
    if (lenPc < 0.001) return 0.0;
    float stepPc = lenPc / float(DUST_STEPS);

    float invRange = 0.5 / uDustBoundsPc; // maps [-bounds, +bounds] → [0, 1]
    float accumDensity = 0.0;
    for (int i = 0; i < DUST_STEPS; i++) {
        float t = (float(i) + 0.5) / float(DUST_STEPS);
        vec3 pAbs = absCamera + delta * t;
        vec3 uvw = pAbs * invRange + 0.5;
        // Cheap bbox test — sampling outside just clamps to the edge which
        // is zero-padded at the volume boundary, so skipping is an
        // optimisation not a correctness requirement.
        if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) continue;
        float encoded = texture(uDustTexture, uvw).r;
        // Inverse of the Python side's pure-log encoding over
        // [densityMin, densityMax]: decoded = densityMin * exp(sample * logRatio).
        float density = uDustDensityMin * exp(encoded * uDustLogRatio);
        accumDensity += density;
    }
    return accumDensity * stepPc * uDustAvPerDensityPc * effective;
}

void main() {
    // Off-screen-sentinel early-returns below skip <logdepthbuf_vertex>,
    // leaving vFragDepth undefined for that vertex. Safe because the
    // suppression conditions read only per-instance attributes — all 4
    // verts of the quad share the path and land at the same off-screen
    // NDC, so the primitive is fully NDC-clipped before rasterization
    // and the fragment shader never executes for it. A future change
    // that makes the off-screen position per-vertex would break this
    // invariant and need to write vFragDepth before returning.
    if (gl_InstanceID == uHideFocusIdx) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vAppMag = 0.0;
        vColor = vec3(0.0);
        vUv = aCorner;
        vPhysRatio = 0.0;
        vSoftness = 0.0;
        vAaWidth = 0.0;
        return;
    }

    vec3 worldPos = iPosition;
    float distCam = distance(worldPos, uCameraPos);

    // Floor at 1e-30 only to keep log(dPc) finite in the appMag calc;
    // small enough that the per-star physical orbit floor (down to ~5e-8
    // pc for Sol-class) never hits it, so physSize = 2·atan(R/d) can
    // grow all the way to fill the viewport at the manual-zoom limit.
    float dPc = max(distCam, 1e-30);
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
    // peak ≤ MAX_PHYS_PX, trough ≥ VAR_TROUGH_FLOOR_FRACTION × baseSize.
    // Keeps the sine smooth (no plateau at peak, no disappearing at trough)
    // even for extreme-amplitude variables like Mira.
    float R_pc = pow(10.0, iLogRadius) * uRSunPc;
    float angularToPx = uViewport.y / max(uFovYRad, 1e-9);
    float radiusFactor = 1.0;
    float magMod = 0.0;
    if (iPeriodDays > 0.0 && iAmplitudeMag > 0.0) {
        float periodSec = max(iPeriodDays * uSecondsPerDay, uMinPeriodSec);
        float phase = uTime / periodSec;

        // Precompute base (un-modulated) physSize to size the headroom.
        float baseSize0 = 2.0 * atan(R_pc / dPc) * angularToPx;
        // Cap the peak at uMaxPhysFrac of the viewport's minor axis —
        // matches the TS-side ZOOM_FLOOR_FRACTION used by the orbit
        // floor — and the trough at uVarTroughFrac of baseSize so the
        // pulse never goes sub-baseSize × varTroughFrac.
        float maxPhysSize = uMaxPhysFrac * min(uViewport.x, uViewport.y);

        float maxUpLog10 = log(max(maxPhysSize / max(baseSize0, 1.0), 1.0)) / LOG10;
        float maxDownLog10 = -log(uVarTroughFrac) / LOG10;
        float ampLimitMag = 10.0 * min(maxUpLog10, maxDownLog10);
        float ampEff = min(iAmplitudeMag, max(0.0, ampLimitMag));

        magMod = 0.5 * ampEff * sin(6.2831853 * phase);
        appMag += magMod;
        radiusFactor = pow(10.0, -magMod / 5.0);
    }

    // Visibility prefilter — dust-independent. Spectral mask and distance
    // band are absolute filters (not affected by extinction). The magnitude
    // band is monotonic in dust: A_V ≥ 0, so a star whose unextincted
    // appMag already sits above (uMaxAppMag + 0.5) cannot become visible
    // after extinction. Skip the 48-tap dust raymarch for those stars —
    // for the bulk of the catalog at typical magnitude limits this is the
    // dominant per-frame vertex-shader saving (313k stars).
    //
    // DUST_AV_HEADROOM is the worst-case A_V we keep in the raymarch
    // population on top of the +0.5 soft-taper window. 1.5 mag covers
    // typical molecular cloud sightlines (the closer Zucker clouds peak
    // at A_V ~ 1–2 mag through their cores; sparser ISM is well under
    // 1 mag). A star whose unextincted appMag falls inside
    // [uMaxAppMag + 0.5, uMaxAppMag + 0.5 + DUST_AV_HEADROOM] still
    // gets the raymarch so the post-extinction magnitude can land in or
    // out of the soft taper without popping as the slider moves.
    const float DUST_AV_HEADROOM = 1.5;
    bool spectOk = (uSpectMask & (1u << uint(iSpectClass))) != 0u;
    bool distOk = iDistSol >= uMinDistSol && iDistSol <= uMaxDistSol;
    bool magOkPrelim = appMag <= uMaxAppMag + 0.5 + DUST_AV_HEADROOM;

    // Luminosity-class softness: linear from white dwarf (0) → hypergiant
    // (9). Unknown (iLumClass = 255) falls back to main-sequence-dwarf
    // softness. Feeds the fragment shader's glow falloff and disc-edge AA
    // width so supergiants look "fluffier" than dwarfs at the same radius.
    float lumClass = iLumClass < 100.0 ? iLumClass : 2.0;
    float softness = clamp(lumClass / 9.0, 0.0, 1.0);

    if (!(spectOk && distOk && magOkPrelim)) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vAppMag = appMag;
        vColor = vec3(0.0);
        vUv = aCorner;
        vPhysRatio = 0.0;
        vSoftness = softness;
        vAaWidth = 0.0;
        return;
    }

    // Survivors only: integrate dust extinction along the camera→star
    // sightline. Local-frame positions → absolute for texture sampling
    // (the dust grid is anchored to Sol, not the floating local origin).
    // A_V is added to appMag so the brightness filter sees the dimmed
    // value, and the colour is reddened by E(B-V) = A_V / R_V.
    float absorbAV = dustExtinctionAV(worldPos + uWorldOffset, uCameraPos + uWorldOffset);
    appMag += absorbAV;
    float effectiveCi = iCi + absorbAV / R_V;

    // Final magnitude check with the extincted value. Soft taper: stars
    // within +0.5 mag of the limit still pass through and render in the
    // glow pass at fading intensity (frag shader handles the smoothstep),
    // so the limit doesn't pop in/out as the slider moves.
    if (appMag > uMaxAppMag + 0.5) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vAppMag = appMag;
        vColor = vec3(0.0);
        vUv = aCorner;
        vPhysRatio = 0.0;
        vSoftness = softness;
        vAaWidth = 0.0;
        return;
    }

    vAppMag = appMag;
    vColor = ciToColor(effectiveCi);
    vUv = aCorner;
    vSoftness = softness;

    float pxSize;
    if (uMonochrome > 0.5) {
        // Chart-mode flat-disc sizing. appMag is already the post-magMod
        // value, so variables breathe between (appMag - amp/2) and
        // (appMag + amp/2) in pixel space exactly the way Sky Atlas's
        // glyph implies. Stars brighter than the bright reference get
        // clamped to MAX; everything from there to the slider limit
        // spreads linearly into [MAX..MIN].
        float chartT = clamp(
            (appMag - uChartMagBright)
                / max(uMaxAppMag - uChartMagBright, 0.001),
            0.0, 1.0);
        pxSize = mix(uChartDiscMaxPx, uChartDiscMinPx, chartT);
        // Force the frag shader's chart-mode disc path. (Outside chart
        // mode this is computed below from physSize/appSize.)
        vPhysRatio = 1.0;
    } else {
        // Apparent-magnitude size term — the perceptual-disc abstraction.
        // Same √Δm + soft-knee mapping a planet would use (3re.16); the
        // chunk owns the math + rationale.
        float dMEff = perceptualDmEff(appMag, uMaxAppMag, uSizeSpan, uSizeKnee);
        float appSize = perceptualAppSizePx(dMEff, uSizeMin, uSizeMax, uSizeSpan);

        // Physical-size term. True angular diameter projected to pixels:
        // 2·atan(R/d) is the angle the disc subtends at the camera,
        // multiplied by viewport.y/fov_y to convert radians to pixels.
        // radiusFactor is the already-compressed variability modulation.
        float physSize = 2.0 * atan(R_pc * radiusFactor / dPc) * angularToPx;

        pxSize = max(appSize, physSize);
        vPhysRatio = clamp(physSize / max(pxSize, 0.001), 0.0, 1.0);
    }

    // Edge AA in vUv units. The quad spans pxSize CSS pixels; vUv ranges
    // [-0.5, +0.5] across that span, so 1 CSS pixel ≈ 1/pxSize in vUv
    // space. The chart-mode frag shader uses this directly to keep the
    // disc's antialiased edge at exactly one pixel wide regardless of
    // size. Outside chart mode the frag uses a different profile and
    // ignores this varying.
    vAaWidth = 1.0 / max(pxSize, 0.5);

    // Project the star centre to clip space, then offset each corner in
    // screen space by aCorner × pxSize. Multiplying the clip-space offset
    // by centreClip.w makes it perspective-correct (so the quad stays the
    // same pixel size regardless of depth).
    vec4 centreClip = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
    if (gl_InstanceID == uPinFocusToCenter) {
        // Bypass float32 cancellation in the matrix chain at extreme
        // close approach. The focused star is mathematically at view
        // (0, 0, -distCam) since controls.target = star and lookAt()
        // aligns -Z with target; substitute the canonical projection.
        centreClip = projectionMatrix * vec4(0.0, 0.0, -dPc, 1.0);
    }
    vec2 pixelOffset = aCorner * pxSize * uPixelRatio;
    vec2 ndcOffset = pixelOffset / (uViewport * uPixelRatio) * 2.0;
    gl_Position = centreClip + vec4(ndcOffset * centreClip.w, 0.0, 0.0);

    #include <logdepthbuf_vertex>
}
