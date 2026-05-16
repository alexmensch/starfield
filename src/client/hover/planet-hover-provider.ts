// Planet hover provider (stellata-lo5.4). Sibling of star-hover-provider
// for Sol's planet layer, ready to extend to any future exoplanet host
// without touching the engine.
//
// Both pick and format paths self-gate on Stellata's focused planet
// system — when no host has planets attached, pick returns null and
// format returns an empty payload (defensive; the engine won't call
// format on a null hit). v1 only attaches Sol, so the gate effectively
// means "the focused star is Sol"; bk5 will widen it to whichever
// stellar host has a PlanetSystem.

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
    pick: (x, y, pxThreshold) => stellata.pickPlanetHit(x, y, pxThreshold),
    format: (idx) => {
      const ps = stellata.getFocusedPlanetSystem();
      if (!ps) return { name: '', lines: [] };
      // The PlanetSystem snapshot is the source of truth for `planets`;
      // live distance and apparent V mag come from the renderer's
      // PlanetBodyField via Stellata accessors so they track the
      // current camera + ephemeris.
      const ctx: PlanetHoverFormatContext = {
        planets: ps.planets,
        distanceFromHostPc: (i) => stellata.planetHostDistancePc(i),
        appMagFor: (i) => stellata.planetApparentMag(i),
      };
      return formatPlanetHover(idx, ctx);
    },
  };
}
