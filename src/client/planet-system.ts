// Per-star planet data model for the solar-system layer (stellata-3re).
//
// This module is intentionally generic: any focusable star *may* carry a
// planet system, even though Sol is the only one populated in v1. The
// future exoplanet epic (stellata-bk5) plugs additional hosts in by
// extending the resolver below, without changing the shape consumed by
// renderers (`PlanetSystem`, `Planet`, the `hasPlanets`/`getPlanetSystem`
// pair).
//
// Rendering layers (3re.4 planet bodies, 3re.7 orbit rings, 3re.5
// heliopause, etc.) gate themselves on `Stellata.getFocusedPlanetSystem()`
// rather than checking "is this star Sol?" directly.

import type { Catalog } from './catalog-loader';
import { getPlanetPositions, PLANET_ORDER } from './ephemeris';

export type PlanetType = 'rocky' | 'gas_giant' | 'ice_giant';

export interface Planet {
  readonly name: string;
  // Equatorial radius in km. Conversion to parsecs (for `θ = 2·atan(R/d)`
  // disc sizing) is the renderer's responsibility — keep the canonical
  // unit human-readable here.
  readonly radiusKm: number;
  // Semi-major axis in AU. Real orbital phase is deferred to stellata-3re.3
  // (VSOP87 ephemerides); placeholder positions in 3re.4 use this alone.
  readonly semiMajorAxisAu: number;
  // Orbital eccentricity. The orbit-rings layer (stellata-3re.7) draws
  // each ring as an ellipse with the host star at one focus, using
  // `b = a·√(1−e²)` and a focal offset of `c = a·e`. v1 places the
  // perihelion along the local +x axis as a placeholder; longitude of
  // perihelion lands later (alongside VSOP87 in stellata-3re.3).
  readonly eccentricity: number;
  readonly type: PlanetType;
  // Representative single-colour RGB in linear-ish [0,1]. Average tones
  // only — atmospheric scattering, banding, and surface texturing all
  // depend on a future planet-selection / close-zoom affordance that
  // doesn't exist yet, so per-planet appearance refinements are
  // deferred until that lands.
  readonly colour: readonly [number, number, number];
}

export interface PlanetSystem {
  // Catalog index of the host star. Stable for as long as the loaded
  // catalog instance is alive.
  readonly hostStarIdx: number;
  readonly planets: readonly Planet[];
  /** Optional time-evolved position resolver. When present, the
   *  renderer (`star-system.ts`) calls it each frame to refresh body
   *  positions; when absent, the renderer falls back to the static
   *  placeholder eccentric-anomaly layout from `placeholderEccentricAnomaly`.
   *
   *  Writes 3 floats per planet (xyz triples in the host's local
   *  orbital-plane frame: x/y in-plane, z perpendicular) into `out`,
   *  in `planets` array order. Units: parsecs. The renderer applies
   *  the per-host orbital-plane orientation quaternion downstream to
   *  rotate into ICRS — Sol's ecliptic frame becomes ICRS via the
   *  same quaternion that orients its orbit rings (3re.8). */
  positionsAt?: (t: number, out: Float32Array) => void;
}

/** Sol's positionsAt — JPL Standish ecliptic positions in parsecs,
 *  written in the SOL_PLANETS / PLANET_ORDER ordering (Mercury through
 *  Neptune). Pure dispatch into ephemeris.getPlanetPositions, which
 *  caches per-`t`-bucket internally. */
function solPositionsAt(t: number, out: Float32Array): void {
  const positions = getPlanetPositions(t);
  for (let i = 0; i < PLANET_ORDER.length; i++) {
    const p = positions[PLANET_ORDER[i]];
    out[i * 3 + 0] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
  }
}

// Sol's eight planets. Radii from NASA planetary fact sheets (equatorial).
// Semi-major axes and eccentricities from JPL DE440 mean elements at
// J2000. Colours are observation-derived representative tones — pixel-
// accurate texturing depends on the future planet-as-object epic
// (stellata-2f6) clearing its design gate; for now bodies are flat-
// coloured discs.
export const SOL_PLANETS: readonly Planet[] = [
  {
    name: 'Mercury',
    radiusKm: 2440,
    semiMajorAxisAu: 0.387,
    eccentricity: 0.2056,
    type: 'rocky',
    colour: [0.55, 0.47, 0.32],
  },
  {
    name: 'Venus',
    radiusKm: 6052,
    semiMajorAxisAu: 0.723,
    eccentricity: 0.0068,
    type: 'rocky',
    colour: [0.91, 0.82, 0.60],
  },
  {
    name: 'Earth',
    radiusKm: 6371,
    semiMajorAxisAu: 1.000,
    eccentricity: 0.0167,
    type: 'rocky',
    colour: [0.31, 0.49, 0.67],
  },
  {
    name: 'Mars',
    radiusKm: 3390,
    semiMajorAxisAu: 1.524,
    eccentricity: 0.0934,
    type: 'rocky',
    colour: [0.76, 0.27, 0.05],
  },
  {
    name: 'Jupiter',
    radiusKm: 69911,
    semiMajorAxisAu: 5.203,
    eccentricity: 0.0485,
    type: 'gas_giant',
    colour: [0.85, 0.72, 0.51],
  },
  {
    name: 'Saturn',
    radiusKm: 58232,
    semiMajorAxisAu: 9.537,
    eccentricity: 0.0555,
    type: 'gas_giant',
    colour: [0.90, 0.79, 0.62],
  },
  {
    name: 'Uranus',
    radiusKm: 25362,
    semiMajorAxisAu: 19.191,
    eccentricity: 0.0464,
    type: 'ice_giant',
    colour: [0.64, 0.85, 0.90],
  },
  {
    name: 'Neptune',
    radiusKm: 24622,
    semiMajorAxisAu: 30.069,
    eccentricity: 0.0095,
    type: 'ice_giant',
    colour: [0.25, 0.37, 0.75],
  },
] as const;

// Sync probe — does this star have a planet system at all?
//
// v1 hardwires "planets ⇔ Sol". When stellata-bk5 lands an exoplanet
// flag bit on the catalog record, this becomes a flag check; callers
// stay unchanged.
export function hasPlanets(catalog: Catalog, starIdx: number | null): boolean {
  if (starIdx === null || starIdx < 0) return false;
  return starIdx === catalog.solIndex;
}

// Async resolver — supplies the `PlanetSystem` for `starIdx`, or null if
// the star has no planets. Sol resolves with already-in-memory data;
// stellata-bk5 is expected to extend this to fetch a per-star JSON
// shard lazily, caching by index. The Promise wrapper keeps the API
// stable across that transition.
export async function getPlanetSystem(
  catalog: Catalog,
  starIdx: number | null,
): Promise<PlanetSystem | null> {
  if (!hasPlanets(catalog, starIdx)) return null;
  return {
    hostStarIdx: starIdx as number,
    planets: SOL_PLANETS,
    positionsAt: solPositionsAt,
  };
}
