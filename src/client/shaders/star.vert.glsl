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

in float aAbsmag;
in float aCi;
in float aSpectClass;

out float vAppMag;
out vec3 vColor;

const float LOG10 = 2.302585093;

vec3 ciToColor(float ciVal) {
    float t = clamp((ciVal + 0.4) / 2.4, 0.0, 1.0);
    vec3 hot  = vec3(0.65, 0.78, 1.00);
    vec3 mid  = vec3(1.00, 0.98, 0.92);
    vec3 cool = vec3(1.00, 0.55, 0.35);
    return t < 0.5 ? mix(hot, mid, t * 2.0) : mix(mid, cool, (t - 0.5) * 2.0);
}

void main() {
    vec3 worldPos = position;
    float distSol = length(worldPos);
    float distCam = distance(worldPos, uCameraPos);

    float dPc = max(distCam, 0.001);
    float appMag = aAbsmag + 5.0 * (log(dPc) / LOG10 - 1.0);

    bool spectOk = (uSpectMask & (1u << uint(aSpectClass))) != 0u;
    bool distOk = distSol >= uMinDistSol && distSol <= uMaxDistSol;
    bool magOk = appMag <= uMaxAppMag;
    bool visible = spectOk && distOk && magOk;

    if (!visible) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        vAppMag = appMag;
        vColor = vec3(0.0);
        return;
    }

    vAppMag = appMag;
    vColor = ciToColor(aCi);

    vec4 mvPos = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPos;

    float brightness = clamp((uMaxAppMag - appMag) / max(uSizeSpan, 0.001), 0.0, 1.0);
    float size = mix(uSizeMin, uSizeMax, brightness) * uPixelRatio;
    gl_PointSize = size;
}
