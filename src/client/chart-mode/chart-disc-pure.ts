// Pure helpers for the chart-mode magnitude-driven disc renderer
// (mirrors of the GLSL math in `star.vert.glsl`'s chart-mode branch).
// Kept JS-side so callers that need the same threshold the GPU uses
// — overlay sizing, click hit-radii, warp pacing — can read it
// without duplicating the formula.

/**
 * Distance (parsecs) at which the chart-mode rendered disc reaches its
 * `uChartDiscMaxPx` plateau for a star of absolute magnitude `absMag`,
 * given the current `uChartMagBright` threshold (the magnitude that
 * maps to max disc size).
 *
 * Chart mode renders stars with disc size linear-in-magnitude:
 * `chartT = clamp((appMag - magBright) / (maxAppMag - magBright), 0, 1)`,
 * `pxSize = mix(maxPx, minPx, chartT)`. The disc plateaus at
 * `chartT = 0`, i.e. when `appMag ≤ magBright`. With the standard
 * distance modulus `appMag = absMag + 5·log10(d) − 5` (pc), solving
 * `appMag = magBright` for `d` gives `d = 10^((magBright − absMag + 5)/5)`.
 *
 * For Sol (absMag = 4.83) at the default `magBright = −2.0`:
 *   d = 10^((−2 − 4.83 + 5)/5) = 10^(−0.366) ≈ 0.43 pc.
 *
 * For Betelgeuse (absMag = −5.85) at the same threshold:
 *   d = 10^((−2 + 5.85 + 5)/5) = 10^(1.77) ≈ 58.9 pc.
 *
 * Returns +Infinity when the star is intrinsically too dim to ever
 * plateau (`absMag > magBright + 5` — distance would have to be
 * negative). Callers that gate behaviour on the plateau will see no
 * trigger in that case, which is the right outcome.
 */
export function chartPlateauDistancePc(absMag: number, magBright: number): number {
  return Math.pow(10, (magBright - absMag + 5) / 5);
}
