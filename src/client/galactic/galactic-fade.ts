// Shared zoom-based fade curve for far-field reference geometry that
// should be invisible during local browsing and reveal itself as the
// camera pulls away from Sol. The MW disc was the first consumer; the
// Local Group wireframe layer adopts the same curve so the two layers
// fade in lockstep, presenting as a single "context overlay" rather
// than two layers with disjoint visibility thresholds.
//
// `distFromSolPc` is interpreted as ||camera.position + worldOffset||,
// i.e. the absolute distance from Sol in ICRS parsecs (Edenhofer's
// voxel grid reaches 1.25 kpc, so by 500 pc the disc is no longer
// visually noisy). Below FADE_INNER_PC the geometry is invisible;
// above FADE_OUTER_PC it's at its full base opacity.

/** Inner edge of the fade-in band (distance from Sol, parsecs). */
export const FADE_INNER_PC = 500;

/** Outer edge of the fade-in band (distance from Sol, parsecs). */
export const FADE_OUTER_PC = 5000;

/** Standard Hermite smoothstep — t² · (3 − 2t) with clamped edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
