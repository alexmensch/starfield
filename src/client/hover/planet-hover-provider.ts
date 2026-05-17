// Planet hover provider (stellata-lo5.4). Sibling of star-hover-provider
// for Sol's planet layer, ready to extend to any future exoplanet host
// without touching the engine.
//
// Visibility ⇒ hoverable per stellata-lo5-hover-conventions Rule 2:
// the provider does NOT gate on focus state. The picker walks every
// attached host's planets and the shader's own kill condition
// (appMag > maxAppMag + 0.5) is the only visibility predicate. v1 only
// attaches Sol, so the picker effectively walks Sol's planets; bk5
// adds further hosts without touching this provider.
//
// HoverHit carries an optional `hostStarIdx` so the formatter can
// resolve `(hostStarIdx, planetIdx)` back to a Planet record without
// re-walking the field's hosts map. The star provider leaves the slot
// unset; the disambiguator ignores it.

import type { Stellata } from '../stellata';
import {
  formatPlanetHover,
  type PlanetHoverFormatContext,
} from './formatters/planet-hover-format';
import type { HoverProvider } from './hover-types';

export interface PlanetHoverProviderConfig {
  stellata: Stellata;
}

export function createPlanetHoverProvider(
  config: PlanetHoverProviderConfig,
): HoverProvider<'planet'> {
  const { stellata } = config;
  return {
    kind: 'planet',
    pick: (x, y, pxThreshold) => stellata.picker.pickPlanetHit(x, y, pxThreshold),
    format: (hit) => {
      const hostStarIdx = hit.hostStarIdx;
      if (hostStarIdx === undefined) return { name: '', lines: [] };
      const ps = stellata.getAttachedPlanetSystem(hostStarIdx);
      if (!ps) return { name: '', lines: [] };
      // The cached PlanetSystem is the source of truth for `planets`;
      // live distance and apparent V mag come from the renderer's
      // PlanetBodyField via Stellata accessors so they track the
      // current camera + ephemeris.
      const ctx: PlanetHoverFormatContext = {
        planets: ps.planets,
        distanceFromHostPc: (i) => stellata.planetHostDistancePc(hostStarIdx, i),
        appMagFor: (i) => stellata.planetApparentMag(hostStarIdx, i),
      };
      return formatPlanetHover(hit.idx, ctx);
    },
  };
}
