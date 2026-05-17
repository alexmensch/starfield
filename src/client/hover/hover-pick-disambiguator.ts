// Cross-provider pick disambiguator for the hover engine.
//
// Each `HoverProvider` runs its own pick path and reduces to a single
// best `HoverHit` (or null) using the existing two-tier shape from
// `star-geometry.ts` (prime = cursor inside the rendered disc /
// wireframe envelope; fallback = cursor near the centroid). This
// module then picks the winner across providers under the rule the
// user already validated for stars-vs-clouds in chart-mode:
//
//   1. Prime always beats fallback. A prime hit on any layer wins over
//      a fallback hit on any other layer, regardless of camera
//      distance — the cursor is literally inside the rendered shape.
//   2. Within a tier, smallest `cameraDistancePc` wins. This matches
//      front-to-back z-order on screen: a planet visually in front of
//      a star wins; a Local Group wireframe visually behind a planet
//      loses to the planet.
//
// Within-star sub-pixel magnitude tiebreaking stays inside the star
// provider's own pick path (see `pickScore` in `star-geometry.ts`).
// The cross-layer rule above never touches it.

import type { HoverHit, HoverProvider } from './hover-types';

// One provider's hit, paired with the provider that produced it.
// The engine collects these by calling each registered provider's
// `pick()` and keeping the non-null results. Used as both the input
// and output type so callers can route the winner straight back to
// `winner.provider.format(winner.hit.idx)`.
export type HoverProviderHit = {
  provider: HoverProvider;
  hit: HoverHit;
};

export function disambiguateHits(
  hits: readonly HoverProviderHit[],
): HoverProviderHit | null {
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];

  let primeBest: HoverProviderHit | null = null;
  let fbBest: HoverProviderHit | null = null;
  for (const h of hits) {
    if (h.hit.tier === 'prime') {
      if (
        primeBest === null ||
        h.hit.cameraDistancePc < primeBest.hit.cameraDistancePc
      ) {
        primeBest = h;
      }
    } else {
      if (
        fbBest === null ||
        h.hit.cameraDistancePc < fbBest.hit.cameraDistancePc
      ) {
        fbBest = h;
      }
    }
  }
  return primeBest ?? fbBest;
}
