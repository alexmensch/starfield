// Pure-math star-geometry helpers extracted from Stellata.ts so the
// angular-diameter pipeline (a7d.2) is unit-testable and so the disc
// formula isn't typed three times across the renderer's TypeScript path
// (renderedSizePx, renderedDiscPxAtPeak) and the GLSL vertex shader.
//
// The vertex shader has its own copy of `physSizePx` (intentionally — a
// build-time GLSL include is more complexity than a paired comment) but
// the variability-headroom rule lives only here on the TS side; the
// shader replicates it inline keyed off the same uniforms.

// Pixel-per-radian conversion. Mirrors the shader's
// `viewport.y / max(fovYRad, 1e-9)`. Floor on fovYRad keeps the divide
// finite in the singular case where the camera FOV is briefly written
// as zero during a transition.
export function angularToPx(viewport_y: number, fovYRad: number): number {
  return viewport_y / Math.max(fovYRad, 1e-9);
}

// Star disc pixel diameter under the angular-diameter formula
// `θ = 2·atan(R / d)`. `radiusFactor` modulates `R` for variable-star
// pulsation (1 for non-variables; 10^(amp/10) at peak; 10^(-amp/10) at
// trough). The shader's physSize calc must produce the same value for
// the same inputs — keep them in sync.
export function physSizePx(
  R_pc: number,
  dCam_pc: number,
  viewport_y: number,
  fovYRad: number,
  radiusFactor = 1,
): number {
  return 2 * Math.atan((R_pc * radiusFactor) / dCam_pc) * angularToPx(viewport_y, fovYRad);
}

// Effective amplitude for a variable star, clamped so the disc neither
// grows past `maxPhysFrac` of the viewport's minor axis at peak nor
// shrinks below `varTroughFrac` of `baseSize` at trough. Returns 0 for
// non-variables.
//
// Inputs:
//   amp           — catalog amplitudeMag (peak-to-trough magnitudes)
//   baseSize      — un-modulated disc size in px (radiusFactor = 1)
//   maxPhysSize   — viewport-derived peak ceiling in px
//                   (= maxPhysFrac × min(viewport.x, viewport.y))
//   varTroughFrac — trough floor fraction (= VAR_TROUGH_FLOOR_FRACTION)
//
// Same compression rule the shader applies to `uMaxPhysFrac` /
// `uVarTroughFrac`. Headroom is computed in log-flux space because the
// disc-radius modulation is `R · 10^(-Δm/5)` (constant-T assumption).
export function varEffectiveAmplitude(
  amp: number,
  baseSize: number,
  maxPhysSize: number,
  varTroughFrac: number,
): number {
  if (amp <= 0) return 0;
  const maxUpLog10 = Math.log10(Math.max(maxPhysSize / Math.max(baseSize, 1), 1));
  const maxDownLog10 = -Math.log10(varTroughFrac);
  const ampLimitMag = 10 * Math.min(maxUpLog10, maxDownLog10);
  return Math.min(amp, Math.max(0, ampLimitMag));
}

// Per-star variability factor on physical radius. A non-variable returns
// 1. A variable returns 10^(amp/10) — the peak-to-mean radius ratio under
// the constant-temperature assumption (`R ∝ √L`, `L ∝ 10^(-Δm/2.5)`),
// driving the orbit floor and parking-distance calibration so the pulse
// peak hits the same screen-fill fraction every star does. Returns 1 for
// rows the GCVS pass couldn't model (no period, irregular type) so the
// renderer treats them as static.
export function peakAmplitudeFactor(amplitudeMag: number, periodDays: number): number {
  return periodDays > 0 && amplitudeMag > 0 ? Math.pow(10, amplitudeMag / 10) : 1;
}

// Sub-pixel magnitude bias in `pickScore`. A 1-mag-fainter candidate is
// treated as `PICK_MAG_BIAS_PX_PER_MAG` pixels farther from the cursor;
// a 4-mag-fainter candidate is 0.2 px farther. Sized so any visible
// `pxDist` gap (≥ 1 px) dominates while two coincident catalog rows
// (Alula Australis A/B at the same x/y/z) still tiebreak by brightness.
export const PICK_MAG_BIAS_PX_PER_MAG = 0.05;

// Score for a star pick candidate. Lower is better. Used by pickStar
// for both the prime tier (cursor inside a rendered disc) and the
// proximity-fallback tier (no disc hit, nearest centre within a
// pixel threshold). The score is dominated by `pxDist` — the cursor's
// screen-pixel distance from the disc centre — so the star whose
// centre the cursor is closest to wins. The sub-pixel `appMag` bias
// (`PICK_MAG_BIAS_PX_PER_MAG`) only matters for near-coincident
// candidates: it picks the brighter component when two catalog rows
// share the same x/y/z (e.g. Alula Australis A/B in AT-HYG, both at
// HIP-less Gl 423A/B with identical galactocentric coordinates).
//
// The prime tier deliberately does NOT tiebreak by camera distance —
// depth-occlusion is intentionally ignored in the picker. The Double
// Double (ε¹ / ε² Lyr) sits ~3.5 arcmin apart with hitboxes that
// overlap each other's centres at typical zoom; a "closest to camera"
// rule consistently picked one component for every click, leaving the
// other un-clickable. The trade-off: a faint background star whose
// projected centre lands ≥ 1 px closer to the cursor than a bright
// foreground star wins, even if the foreground disc fully contains
// the cursor. The au3 / xec failure mode (overlapping disc hitboxes
// leaving one component unclickable) was deemed worse than the rare
// inverse case where the visually obvious foreground disc loses by a
// pixel.
export function pickScore(pxDist: number, appMag: number): number {
  return pxDist + appMag * PICK_MAG_BIAS_PX_PER_MAG;
}

// One projected pick candidate, after the prime/fallback filter has
// already accepted it. `hitRadius` is the prime-tier disc radius
// (`max(pxSize/2, MIN_DISC_HIT_RADIUS_PX)`) — caller-computed because
// it depends on rendered disc size. Pure-data shape so the reducer
// below stays unit-testable without a Three.js scene.
export type PickCandidate = {
  idx: number;
  pxDist: number;
  hitRadius: number;
  appMag: number;
};

// Reduce a candidate list to the winning idx (or -1) under the two-tier
// pickStar contract:
//   prime  — `pxDist <= hitRadius` (cursor inside the rendered disc)
//   fallback — `pxDist <= pixelThreshold` (cursor near the centre, no
//              disc hit). Only consulted when no prime hit exists.
// Within each tier, lowest `pickScore` wins. Prime hits ALWAYS beat
// fallback hits — a prime candidate just inside its hit radius beats
// a fallback candidate one pixel from the cursor, regardless of score.
export function pickFromCandidates(
  candidates: Iterable<PickCandidate>,
  pixelThreshold: number,
): number {
  let primeIdx = -1;
  let primeBest = Infinity;
  let fbIdx = -1;
  let fbBest = Infinity;
  for (const c of candidates) {
    const score = pickScore(c.pxDist, c.appMag);
    if (c.pxDist <= c.hitRadius) {
      if (score < primeBest) {
        primeBest = score;
        primeIdx = c.idx;
      }
    } else if (c.pxDist <= pixelThreshold) {
      if (score < fbBest) {
        fbBest = score;
        fbIdx = c.idx;
      }
    }
  }
  return primeIdx !== -1 ? primeIdx : fbIdx;
}

// Solve for camera distance `d` such that a star of radius `R_pc`
// (physical, in pc) fills `targetFrac` of `min(viewport.x, viewport.y)`
// at the current FOV. Symbolically:
//   targetFrac · fovMinor = 2·atan(R / d)
//   d = R / tan(targetFrac · fovMinor / 2)
// Used both for the manual-zoom orbit floor (targetFrac = 0.9) and the
// auto-park distance (targetFrac = 0.10).
export function distAtFillFraction(
  R_pc: number,
  fovMinorRad: number,
  targetFrac: number,
): number {
  return R_pc / Math.tan((targetFrac * fovMinorRad) / 2);
}
