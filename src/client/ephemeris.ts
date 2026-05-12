// Heliocentric ecliptic positions for the eight planets at any wall-clock
// `t` (Unix-seconds). Implements the JPL Keplerian-elements approximation
// (Standish 1992) with the cubic Jupiter–Neptune correction terms valid
// 3000 BC – 3000 AD to ~arcminute accuracy. Source table:
// https://ssd.jpl.nasa.gov/planets/approx_pos.html
//
// Why JPL Standish over the full VSOP87 series: VSOP87 gives sub-arcsec
// accuracy ±4000 years, but planets in stellata render as billboarded
// discs at a pixel-size floor — sub-arcminute precision is invisible at
// any zoom we afford. Standish gives us the same visual fidelity at zero
// dependency cost (~50 lines + an 8-row element table) over a slightly
// narrower validity window. Deep-time follow-up: stellata-1gh.
//
// Returned positions are heliocentric **ecliptic** parsecs, NOT ICRS —
// the rotation onto ICRS happens in the caller (planet-body-field.ts) via the
// per-host orbital-plane orientation quaternion, so Sol naturally lands
// in the ecliptic and other hosts (stellata-bk5 exoplanets) land in the
// galactic plane per stellata-3re.8.

import { AU_PC } from './astronomy-constants';
import { tToJDE } from './time';

// JD at J2000.0 (2000-01-01T12:00 TT).
const J2000_JD = 2451545.0;

// Cache granularity for per-`t` recompute. Sub-minute planet motion at the
// billboarded-disc pixel scale is invisible (Mercury moves ~3e-5 rad as
// seen from Earth in 60s — ~8 arcsec, well below pixel resolution at any
// zoom). Future animated time scrubbers (stellata-nmu) that want smoother
// motion can reduce this; the caller checks the bucket before uploading
// to the GPU.
const CACHE_GRANULARITY_SEC = 60;

const DEG = Math.PI / 180;

// JPL Table 2a — J2000 mean elements + Julian-century rates. Angles in
// degrees / deg-per-century; semi-major axis in AU. EM Bary stands in
// for Earth at this approximation level (sub-arcsec offset between Earth
// and EM-Bary is irrelevant at pixel scale).
interface ElementSet {
  a: number;  aDot: number;  // semi-major axis (AU)
  e: number;  eDot: number;  // eccentricity
  I: number;  IDot: number;  // inclination (deg)
  L: number;  LDot: number;  // mean longitude (deg)
  // longitude of perihelion ϖ = ω + Ω (deg)
  longperi: number;  longperiDot: number;
  // longitude of ascending node Ω (deg)
  longnode: number;  longnodeDot: number;
  // Cubic Jupiter–Neptune perturbation terms for the mean anomaly. Zero
  // for inner planets — the (b·T² + c·cos(fT) + s·sin(fT)) correction is
  // a numerical patch for the linear-elements model's blind spots near
  // mean-motion resonances (Jupiter–Saturn, Uranus–Neptune).
  b: number; c: number; s: number; f: number;
}

// Order matches PlanetName below — getPlanetPositions returns a same-
// order tuple so the renderer (planet-body-field.ts) can iterate without a
// per-frame name lookup.
const ELEMENTS: ElementSet[] = [
  // Mercury
  {
    a: 0.38709843,    aDot:  0.00000000,
    e: 0.20563661,    eDot:  0.00002123,
    I: 7.00559432,    IDot: -0.00590158,
    L: 252.25166724,  LDot:  149472.67486623,
    longperi: 77.45771895,    longperiDot: 0.15940013,
    longnode: 48.33961819,    longnodeDot: -0.12214182,
    b: 0, c: 0, s: 0, f: 0,
  },
  // Venus
  {
    a: 0.72332102,    aDot: -0.00000026,
    e: 0.00676399,    eDot: -0.00005107,
    I: 3.39777545,    IDot:  0.00043494,
    L: 181.97970850,  LDot:  58517.81560260,
    longperi: 131.76755713,   longperiDot: 0.05679648,
    longnode: 76.67261496,    longnodeDot: -0.27274174,
    b: 0, c: 0, s: 0, f: 0,
  },
  // Earth (EM Bary)
  {
    a: 1.00000018,    aDot: -0.00000003,
    e: 0.01673163,    eDot: -0.00003661,
    I: -0.00054346,   IDot: -0.01337178,
    L: 100.46691572,  LDot:  35999.37306329,
    longperi: 102.93005885,   longperiDot: 0.31795260,
    longnode: -5.11260389,    longnodeDot: -0.24123856,
    b: 0, c: 0, s: 0, f: 0,
  },
  // Mars
  {
    a: 1.52371243,    aDot:  0.00000097,
    e: 0.09336511,    eDot:  0.00009149,
    I: 1.85181869,    IDot: -0.00724757,
    L: -4.56813164,   LDot:  19140.29934243,
    longperi: -23.91744784,   longperiDot: 0.45223625,
    longnode: 49.71320984,    longnodeDot: -0.26852431,
    b: 0, c: 0, s: 0, f: 0,
  },
  // Jupiter
  {
    a: 5.20248019,    aDot: -0.00002864,
    e: 0.04853590,    eDot:  0.00018026,
    I: 1.29861416,    IDot: -0.00322699,
    L: 34.33479152,   LDot:  3034.90371757,
    longperi: 14.27495244,    longperiDot: 0.18199196,
    longnode: 100.29282654,   longnodeDot: 0.13024619,
    b: -0.00012452, c: 0.06064060, s: -0.35635438, f: 38.35125000,
  },
  // Saturn
  {
    a: 9.54149883,    aDot: -0.00003065,
    e: 0.05550825,    eDot: -0.00032044,
    I: 2.49424102,    IDot:  0.00451969,
    L: 50.07571329,   LDot:  1222.11494724,
    longperi: 92.86136063,    longperiDot: 0.54179478,
    longnode: 113.63998702,   longnodeDot: -0.25015002,
    b: 0.00025899, c: -0.13434469, s: 0.87320147, f: 38.35125000,
  },
  // Uranus
  {
    a: 19.18797948,   aDot: -0.00020455,
    e: 0.04685740,    eDot: -0.00001550,
    I: 0.77298127,    IDot: -0.00180155,
    L: 314.20276625,  LDot:  428.49512595,
    longperi: 172.43404441,   longperiDot: 0.09266985,
    longnode: 73.96250215,    longnodeDot: 0.05739699,
    b: 0.00058331, c: -0.97731848, s: 0.17689245, f: 7.67025000,
  },
  // Neptune
  {
    a: 30.06952752,   aDot:  0.00006447,
    e: 0.00895439,    eDot:  0.00000818,
    I: 1.77005520,    IDot:  0.00022400,
    L: 304.22289287,  LDot:  218.46515314,
    longperi: 46.68158724,    longperiDot: 0.01009938,
    longnode: 131.78635853,   longnodeDot: -0.00606302,
    b: -0.00041348, c: 0.68346318, s: -0.10162547, f: 7.67025000,
  },
  // Pluto. Standish & Williams 2010 J2000 mean elements + linear rates.
  // JPL removed Pluto from its approx_pos.html table when the IAU
  // reclassified it; values below are the canonical pre-removal row,
  // also reproduced in NASA's planetary fact sheet derivation. We
  // accept linear-element validity (~few centuries of arcsec accuracy)
  // and skip the Standish 1992 cubic 3:2-resonance correction — at
  // billboarded-disc render scale the residual is invisible.
  {
    a: 39.48211675,   aDot: -0.00031596,
    e: 0.24882730,    eDot:  0.00005170,
    I: 17.14001206,   IDot:  0.00004818,
    L: 238.92903833,  LDot:  145.20780515,
    longperi: 224.06891629,   longperiDot: -0.04062942,
    longnode: 110.30393684,   longnodeDot: -0.01183482,
    b: 0, c: 0, s: 0, f: 0,
  },
];

export type PlanetName =
  | 'mercury' | 'venus' | 'earth' | 'mars'
  | 'jupiter' | 'saturn' | 'uranus' | 'neptune'
  | 'pluto';

export const PLANET_ORDER: readonly PlanetName[] = [
  'mercury', 'venus', 'earth', 'mars',
  'jupiter', 'saturn', 'uranus', 'neptune',
  'pluto',
];

export interface Vec3 { x: number; y: number; z: number; }

export type PlanetPositions = Record<PlanetName, Vec3>;

// Cache: keyed by t-bucketed-to-CACHE_GRANULARITY_SEC, holds the same
// PlanetPositions object reference across frames in the bucket. Single-
// slot — planet positions are only ever queried for one `t` per frame.
let cachedBucket: number | null = null;
let cachedPositions: PlanetPositions | null = null;

/** Solve Kepler's equation `M = E − e·sin(E)` for the eccentric
 *  anomaly E, in radians. Newton iteration; 5 steps converges to
 *  ~1e-15 for any e in [0, 0.3] (well above any planet eccentricity). */
function solveKepler(M: number, e: number): number {
  // Wrap M into [-π, π] so the initial guess and the iteration both
  // stay in the well-conditioned regime.
  const Mw = wrapAngle(M);
  let E = Mw + e * Math.sin(Mw);
  for (let i = 0; i < 5; i++) {
    const dE = (E - e * Math.sin(E) - Mw) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

/** Reduce an angle in radians into the (-π, π] interval. */
function wrapAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = a - Math.floor(a / twoPi) * twoPi;
  if (r > Math.PI) r -= twoPi;
  return r;
}

/** Heliocentric ecliptic position (AU) of a single planet at centuries-
 *  past-J2000 `T`. Pure helper exposed for tests; the public API is
 *  `getPlanetPositions(t)`. */
export function planetEclipticAU(elem: ElementSet, T: number, out: Vec3): void {
  const a = elem.a + elem.aDot * T;
  const e = elem.e + elem.eDot * T;
  const I = (elem.I + elem.IDot * T) * DEG;
  const L = (elem.L + elem.LDot * T) * DEG;
  const longperi = (elem.longperi + elem.longperiDot * T) * DEG;
  const longnode = (elem.longnode + elem.longnodeDot * T) * DEG;

  // Argument of perihelion ω = ϖ − Ω.
  const omega = longperi - longnode;

  // Mean anomaly with the cubic Jupiter–Neptune correction. For inner
  // planets the b/c/s/f terms are zero so this reduces to M = L − ϖ.
  const fT = elem.f * T * DEG;
  const M = L - longperi
    + elem.b * T * T * DEG
    + elem.c * DEG * Math.cos(fT)
    + elem.s * DEG * Math.sin(fT);

  const E = solveKepler(M, e);

  // In-plane heliocentric coordinates with perihelion on +x'.
  const xPrime = a * (Math.cos(E) - e);
  const yPrime = a * Math.sqrt(1 - e * e) * Math.sin(E);

  // Rotate (x', y', 0) by ω in-plane, then by I about x'', then by Ω
  // around the ecliptic z. JPL "approx_pos.html" expansion of
  // R_z(−Ω)·R_x(−I)·R_z(−ω):
  const cosO = Math.cos(omega), sinO = Math.sin(omega);
  const cosN = Math.cos(longnode), sinN = Math.sin(longnode);
  const cosI = Math.cos(I), sinI = Math.sin(I);

  const xEcl =
    (cosO * cosN - sinO * sinN * cosI) * xPrime +
    (-sinO * cosN - cosO * sinN * cosI) * yPrime;
  const yEcl =
    (cosO * sinN + sinO * cosN * cosI) * xPrime +
    (-sinO * sinN + cosO * cosN * cosI) * yPrime;
  const zEcl =
    (sinO * sinI) * xPrime +
    (cosO * sinI) * yPrime;

  out.x = xEcl;
  out.y = yEcl;
  out.z = zEcl;
}

/** Heliocentric ecliptic positions (parsecs) of the eight planets at
 *  Unix-seconds `t`. Returned object is cached per minute-bucket of `t`
 *  — successive frames within the bucket get the same reference. */
export function getPlanetPositions(t: number): PlanetPositions {
  const bucket = Math.round(t / CACHE_GRANULARITY_SEC) * CACHE_GRANULARITY_SEC;
  if (cachedBucket === bucket && cachedPositions !== null) {
    return cachedPositions;
  }
  const T = (tToJDE(bucket) - J2000_JD) / 36525;
  const out = {} as PlanetPositions;
  const tmp: Vec3 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < ELEMENTS.length; i++) {
    planetEclipticAU(ELEMENTS[i], T, tmp);
    out[PLANET_ORDER[i]] = {
      x: tmp.x * AU_PC,
      y: tmp.y * AU_PC,
      z: tmp.z * AU_PC,
    };
  }
  cachedBucket = bucket;
  cachedPositions = out;
  return out;
}

/** Per-planet orbital-frame orientation, expressed as the three Euler
 *  angles that rotate the canonical in-plane ellipse (perihelion at +x,
 *  z=0) into the ecliptic frame. The composition is Rz(Ω)·Rx(I)·Rz(ω)
 *  — same as `planetEclipticAU` applies to the in-plane (x', y'). */
export interface OrbitOrientationRad {
  /** Inclination from the ecliptic (radians). */
  inclination: number;
  /** Longitude of ascending node Ω (radians). */
  longAscNode: number;
  /** Argument of perihelion ω = ϖ − Ω (radians). */
  argPerihelion: number;
}

/** Per-planet orbit orientations at Unix-seconds `t`, in PLANET_ORDER.
 *
 *  The orbit-ring renderer reads this once per attach to align each
 *  ring with its actual orbital plane (inclination + node + perihelion
 *  direction); without it, all rings sit flat on the ecliptic and miss
 *  Mercury's 7° tilt and 77° perihelion offset entirely. Drift across
 *  ±3000 years is bounded (≲5°) and ignored — rings stay frozen at
 *  attach-time orientation for the rest of the session. */
export function getPlanetOrbitOrientations(t: number): OrbitOrientationRad[] {
  const T = (tToJDE(t) - J2000_JD) / 36525;
  const out: OrbitOrientationRad[] = [];
  for (let i = 0; i < ELEMENTS.length; i++) {
    const e = ELEMENTS[i];
    const longnode = (e.longnode + e.longnodeDot * T) * DEG;
    const longperi = (e.longperi + e.longperiDot * T) * DEG;
    out.push({
      inclination: (e.I + e.IDot * T) * DEG,
      longAscNode: longnode,
      argPerihelion: longperi - longnode,
    });
  }
  return out;
}

/** Reset the per-`t` cache. Test-only — production callers never need
 *  this; the cache invalidates naturally as `t` advances. */
export function _resetCacheForTests(): void {
  cachedBucket = null;
  cachedPositions = null;
}

export type { ElementSet };
export { ELEMENTS, J2000_JD, CACHE_GRANULARITY_SEC };
