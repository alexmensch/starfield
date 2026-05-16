// Planet hover formatter (stellata-lo5.4). Sibling of star-hover-format
// for the Sol planet layer (and, once stellata-bk5 lands, any future
// exoplanet host).
//
// Layout (4 lines max):
//   Line 1 — planet name
//   Line 2 — current host→planet distance · apparent V-band magnitude
//   Line 3 — Period <years>
//   Line 4 — Radius <kilometres>
//
// "Vmag" is the spelled-out shorthand for apparent V-band magnitude;
// "Radius" / "Period" are the spelled-out quantity labels (Rule 1 of
// stellata-lo5-hover-conventions — single-letter prefixes are too
// compressed for the user to parse at a 280 ms hover delay).
//
// Pure: takes only its inputs as a context bundle. The host→planet
// distance and the apparent magnitude come in as functions so the
// formatter doesn't need a Three.js camera or a live PlanetBodyField —
// tests stub them with constants. `fmtDistAuto` (which switches to AU
// below 0.01 pc) is the canonical formatter for sub-Oort scales.

import { fmtDistAuto } from '../../distance-util';
import type { Planet } from '../../planet-system';
import type { HoverPayload } from '../hover-types';

export interface PlanetHoverFormatContext {
  // Planet roster for the focused host. `planetIdx` indexes into this
  // array. Read-only — the formatter never mutates.
  planets: readonly Planet[];
  // Live host→planet distance in pc, or null when the planet system
  // isn't attached at format time (degenerate; shouldn't happen because
  // the provider gates on `getFocusedPlanetSystem`).
  distanceFromHostPc(planetIdx: number): number | null;
  // Live apparent V mag at the viewer's current position, or null in
  // the same degenerate case as above.
  appMagFor(planetIdx: number): number | null;
}

export function formatPlanetHover(
  planetIdx: number,
  ctx: PlanetHoverFormatContext,
): HoverPayload {
  const planet = ctx.planets[planetIdx];
  if (!planet) return { name: '', lines: [] };

  const lines: string[] = [];
  const dist = ctx.distanceFromHostPc(planetIdx);
  const appMag = ctx.appMagFor(planetIdx);
  const distStr = dist !== null ? fmtDistAuto(dist) : '';
  const magStr = appMag !== null ? `Vmag ${formatAppMag(appMag)}` : '';
  const headLine = [distStr, magStr].filter(Boolean).join(' · ');
  if (headLine) lines.push(headLine);

  // Period above Radius — orbital period is the user's first "is this
  // a fast inner planet or a slow outer one?" tell, and the AU
  // distance on line 2 pairs naturally with the period rather than
  // with the body's physical size. Kepler's third law in the Sun-mass
  // system: T(years) = a(AU)^1.5. For exoplanets (bk5) the host-mass
  // term reappears as T = a^1.5/√M; until then every attached host
  // is Sol-mass so the simple form is exact.
  const yearsPeriod = Math.pow(planet.semiMajorAxisAu, 1.5);
  lines.push(`Period ${formatPeriodYears(yearsPeriod)} yr`);
  lines.push(`Radius ${formatKm(planet.radiusKm)} km`);

  return { name: planet.name, lines };
}

// Apparent magnitude with explicit sign so users can see at a glance
// whether the planet would be naked-eye-bright (negative) or near the
// telescope-only edge (positive). One decimal matches the precision of
// the published Mallama 2018 fits; finer is noise.
function formatAppMag(m: number): string {
  if (m >= 0) return `+${m.toFixed(1)}`;
  // toFixed(1) already prints the leading minus.
  return m.toFixed(1);
}

// Thousands-separated integer kilometres. Deterministic across locales
// (the locale-aware `Number.prototype.toLocaleString()` varies between
// environments and breaks golden tests on a German vitest runner that
// would render Jupiter as "69.911 km"). One-shot regex insert.
function formatKm(km: number): string {
  return Math.round(km).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Orbital period readout. Sub-decade values keep two decimals (Mercury
// 0.24 yr, Earth 1.00 yr, Mars 1.88 yr); double-digit-plus values drop
// to whole years (Jupiter 12 yr, Pluto 248 yr) where the fractional
// part is noise next to the planet-class hover's overall purpose.
function formatPeriodYears(yr: number): string {
  return yr >= 10 ? yr.toFixed(0) : yr.toFixed(2);
}
