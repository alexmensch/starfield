import { describe, expect, it } from 'vitest';
import {
  disambiguateHits,
  type HoverProviderHit,
} from './hover-pick-disambiguator';
import type { HoverHit, HoverProvider, HoverKind } from './hover-types';

// Stub provider whose `format` is never called by the disambiguator —
// the comparator only reads `hit`, not the provider. The fake exists so
// the returned winner carries a stable identity we can assert against.
const stubProvider = (kind: HoverKind): HoverProvider => ({
  kind,
  pick: () => null,
  format: () => ({ name: '', lines: [] }),
});

const hit = (
  idx: number,
  cameraDistancePc: number,
  tier: 'prime' | 'fallback',
): HoverHit => ({ idx, cameraDistancePc, tier });

const star = stubProvider('star');
const planet = stubProvider('planet');
const lg = stubProvider('local-group');

describe('hover-pick-disambiguator / disambiguateHits', () => {
  it('returns null for empty input', () => {
    expect(disambiguateHits([])).toBeNull();
  });

  it('returns the sole hit when only one provider hits', () => {
    const only: HoverProviderHit = { provider: star, hit: hit(7, 100, 'prime') };
    expect(disambiguateHits([only])).toBe(only);
  });

  it('prime always beats fallback regardless of camera distance', () => {
    // Fallback hit is much closer to camera (1 pc) but the prime hit is
    // far (1000 pc). Prime still wins — cursor is literally inside the
    // rendered shape.
    const primeFar: HoverProviderHit = { provider: lg, hit: hit(1, 1000, 'prime') };
    const fbNear: HoverProviderHit = { provider: planet, hit: hit(2, 1, 'fallback') };
    expect(disambiguateHits([fbNear, primeFar])).toBe(primeFar);
  });

  it('within prime tier, smallest cameraDistancePc wins', () => {
    // Planet at 30 AU (~1.5e-4 pc) sits in front of a star prime hit at
    // 8 pc — planet wins because it's nearer to camera.
    const starFar: HoverProviderHit = { provider: star, hit: hit(10, 8, 'prime') };
    const planetNear: HoverProviderHit = {
      provider: planet,
      hit: hit(3, 1.5e-4, 'prime'),
    };
    expect(disambiguateHits([starFar, planetNear])).toBe(planetNear);
  });

  it('within fallback tier, smallest cameraDistancePc wins', () => {
    const a: HoverProviderHit = { provider: star, hit: hit(20, 50, 'fallback') };
    const b: HoverProviderHit = { provider: lg, hit: hit(0, 25, 'fallback') };
    const c: HoverProviderHit = { provider: planet, hit: hit(5, 0.01, 'fallback') };
    expect(disambiguateHits([a, b, c])).toBe(c);
  });

  it('three-way mixed: prime LG behind prime star and fallback planet — star wins by distance', () => {
    const primeStar: HoverProviderHit = { provider: star, hit: hit(1, 10, 'prime') };
    const primeLg: HoverProviderHit = { provider: lg, hit: hit(2, 800_000, 'prime') };
    const fbPlanet: HoverProviderHit = { provider: planet, hit: hit(3, 1e-4, 'fallback') };
    expect(disambiguateHits([primeLg, primeStar, fbPlanet])).toBe(primeStar);
  });

  it('two prime hits at identical camera distance — first encountered wins (registration order)', () => {
    // Tie-break by registration order (stable: caller controls the
    // input array order). The first provider whose hit lands at the
    // best distance is kept; later hits at equal distance lose the
    // strict-less-than comparison.
    const a: HoverProviderHit = { provider: star, hit: hit(1, 5, 'prime') };
    const b: HoverProviderHit = { provider: planet, hit: hit(2, 5, 'prime') };
    expect(disambiguateHits([a, b])).toBe(a);
    expect(disambiguateHits([b, a])).toBe(b);
  });
});
