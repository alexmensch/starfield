// Pure helpers for scripts/build-local-group.ts — kept off the I/O
// path so vitest can exercise the distance filter, override-merge,
// orientation quaternion construction, and label-threshold defaulting
// without touching the filesystem.

/** Max heliocentric distance (parsecs) we render. Mirrors the camera
 *  envelope set in stellata-5gq: 250 kpc maxDistance. */
export const MAX_DISTANCE_PC = 250_000;

export type LgKind = 'disc' | 'ellipsoid';

export interface OverrideRow {
  name: string;
  axes: [number, number, number];
  /** Raw orient string from the TSV (e.g. "disc:i=32,pa=135", "los",
   *  "pa:102"). Parsed by `buildOrientation` against the object's
   *  sky direction. */
  orient: string;
  refDoi: string;
}

export interface LvdbRow {
  /** Slug key (e.g. "lmc", "sagittarius_1"). */
  key: string;
  /** Display name (e.g. "LMC"). */
  name: string;
  /** Right ascension, degrees (ICRS). */
  ra: number;
  /** Declination, degrees (ICRS). */
  dec: number;
  /** Heliocentric distance, kiloparsecs (LVDB native unit). */
  distanceKpc: number;
  /** Confirmed real (1) / candidate (0). */
  confirmedReal: number;
  /** Confirmed galaxy (1) / candidate (0). */
  confirmedGalaxy: number;
  /** Half-light radius in parsecs (LVDB rhalf_physical), or null. */
  rhalfPhysicalPc: number | null;
  /** Ellipticity e = 1 − b/a on the sky plane, or null. */
  ellipticity: number | null;
  /** Position angle of the projected major axis, degrees east of north
   *  on the sky plane, or null. */
  positionAngle: number | null;
}

export interface LgObject {
  name: string;
  id: string;
  /** Heliocentric ICRS position, parsecs. */
  center: [number, number, number];
  kind: LgKind;
  /** Local-frame semi-axes, parsecs. */
  axes: [number, number, number];
  /** Rotation from local frame to ICRS as a unit quaternion [x, y, z, w]. */
  quat: [number, number, number, number];
  source: 'LVDB' | 'OVERRIDE';
  /** Heliocentric distance to the centroid in parsecs — precomputed for
   *  ready-to-display readouts on the runtime side. */
  distance: number;
}

/** Convert (RA, Dec, d) → ICRS heliocentric Cartesian [x, y, z]. RA/Dec
 *  in degrees; distance unit matches output unit. */
export function raDecDistanceToIcrs(
  raDeg: number,
  decDeg: number,
  distance: number,
): [number, number, number] {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  const cosDec = Math.cos(dec);
  return [
    distance * cosDec * Math.cos(ra),
    distance * cosDec * Math.sin(ra),
    distance * Math.sin(dec),
  ];
}

/** Build the sky-local orthonormal triple (ê_los, ê_east, ê_north)
 *  at the given RA/Dec in degrees. Returns vectors in ICRS.
 *
 *  Conventions:
 *  - ê_los = unit vector from Sol toward the object.
 *  - ê_east = perpendicular to ê_los in the equatorial plane, eastward.
 *    Degenerate at the celestial poles (cos Dec ≈ 0); we fall back to
 *    a fixed (0, 1, 0) basis seed there to keep the rotation well-defined.
 *  - ê_north = ê_los × ê_east (right-hand rule); points toward higher Dec
 *    everywhere except the poles, where the fallback gives a consistent
 *    orientation tied to ICRS +Y. */
export function skyBasis(raDeg: number, decDeg: number): {
  los: [number, number, number];
  east: [number, number, number];
  north: [number, number, number];
} {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  const cosDec = Math.cos(dec);
  const losX = cosDec * Math.cos(ra);
  const losY = cosDec * Math.sin(ra);
  const losZ = Math.sin(dec);

  let eastX: number, eastY: number, eastZ: number;
  if (Math.abs(cosDec) < 1e-9) {
    // Within ~0.2 arcsec of the pole — sky-east is degenerate. Use a
    // fallback basis seed; nothing in Local Group sits at the pole, but
    // the fallback keeps the basis defined for any future caller.
    eastX = 0; eastY = 1; eastZ = 0;
  } else {
    eastX = -Math.sin(ra);
    eastY = Math.cos(ra);
    eastZ = 0;
  }
  // north = los × east  (right-hand rule).
  const northX = losY * eastZ - losZ * eastY;
  const northY = losZ * eastX - losX * eastZ;
  const northZ = losX * eastY - losY * eastX;
  return {
    los: [losX, losY, losZ],
    east: [eastX, eastY, eastZ],
    north: [northX, northY, northZ],
  };
}

/** Build a unit quaternion [x, y, z, w] from an orthonormal basis matrix
 *  whose columns are the world-space directions of the local +X, +Y, +Z
 *  axes. Standard Shepperd's method (matches build-clouds.py). */
export function basisToQuaternion(
  bx: [number, number, number],
  by: [number, number, number],
  bz: [number, number, number],
): [number, number, number, number] {
  const m00 = bx[0], m10 = bx[1], m20 = bx[2];
  const m01 = by[0], m11 = by[1], m21 = by[2];
  const m02 = bz[0], m12 = bz[1], m22 = bz[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

/** Parsed orient spec. Internal representation; the TSV string form is
 *  flattened by `parseOrient`. */
export type Orientation =
  | { kind: 'pa'; pa: number }
  | { kind: 'disc'; inclination: number; pa: number }
  | { kind: 'los' };

/** Parse the orient column of overrides.tsv. Throws on unrecognised
 *  shape — the override file is hand-curated, so a typo should fail
 *  loud at build time, not silently degrade to default rendering. */
export function parseOrient(s: string): Orientation {
  const trimmed = s.trim();
  if (trimmed === 'los') return { kind: 'los' };
  const paMatch = trimmed.match(/^pa:(-?\d+(?:\.\d+)?)$/);
  if (paMatch) return { kind: 'pa', pa: parseFloat(paMatch[1]) };
  const discMatch = trimmed.match(
    /^disc:i=(-?\d+(?:\.\d+)?),pa=(-?\d+(?:\.\d+)?)$/,
  );
  if (discMatch) {
    return {
      kind: 'disc',
      inclination: parseFloat(discMatch[1]),
      pa: parseFloat(discMatch[2]),
    };
  }
  throw new Error(`overrides.tsv: unrecognised orient '${s}'`);
}

/** Build the ICRS rotation quaternion for an object at (RA, Dec) with
 *  the given orientation spec. The local-frame convention used by the
 *  client renderer is:
 *
 *  - pa:    local a (+X) = sky-plane vector at PA east of north;
 *           local b (+Y) = sky-plane perpendicular;
 *           local c (+Z) = line of sight (away from Sol).
 *  - disc:  local x = line of nodes (sky-plane vector at PA);
 *           local z = disc normal (tilted by inclination from line of
 *           sight toward the side perpendicular to the line of nodes);
 *           local y = z × x (in the disc plane, completing right-handed).
 *  - los:   local c (+Z) = line of sight (away from Sol);
 *           local a (+X) = sky-east;  local b (+Y) = sky-north.
 *           (Pure radial orientation — used for SMC's line-of-sight
 *           elongation.) */
export function buildOrientationQuat(
  raDeg: number,
  decDeg: number,
  orient: Orientation,
): [number, number, number, number] {
  const { los, east, north } = skyBasis(raDeg, decDeg);
  if (orient.kind === 'los') {
    return basisToQuaternion(east, north, los);
  }
  if (orient.kind === 'pa') {
    const pa = (orient.pa * Math.PI) / 180;
    const cosPa = Math.cos(pa);
    const sinPa = Math.sin(pa);
    // a = sin(PA) · east + cos(PA) · north   (PA measured east of north)
    const aWorld: [number, number, number] = [
      sinPa * east[0] + cosPa * north[0],
      sinPa * east[1] + cosPa * north[1],
      sinPa * east[2] + cosPa * north[2],
    ];
    // b = ê_los × a — guarantees right-handed (a, b, c=los) basis so
    // Shepperd's method below produces a proper rotation quaternion.
    // Equivalent closed form: b = sin(PA)·ê_north − cos(PA)·ê_east, but
    // computing it as a cross product keeps the right-handedness
    // invariant explicit in the code.
    const bWorld: [number, number, number] = [
      los[1] * aWorld[2] - los[2] * aWorld[1],
      los[2] * aWorld[0] - los[0] * aWorld[2],
      los[0] * aWorld[1] - los[1] * aWorld[0],
    ];
    return basisToQuaternion(aWorld, bWorld, los);
  }
  // disc: i = inclination of disc plane from sky plane; pa = line of nodes.
  const i = (orient.inclination * Math.PI) / 180;
  const paAng = (orient.pa * Math.PI) / 180;
  const cosPa = Math.cos(paAng);
  const sinPa = Math.sin(paAng);
  // Line of nodes (local +X) — sky-plane vector at PA east of north.
  const xWorld: [number, number, number] = [
    sinPa * east[0] + cosPa * north[0],
    sinPa * east[1] + cosPa * north[1],
    sinPa * east[2] + cosPa * north[2],
  ];
  // Perpendicular to the nodes in the sky plane (tilt-axis seed).
  // At i=0 the disc normal = ê_los; at i=90° the disc normal = perp.
  // perp = sky-plane vector at (PA+90°): cos(PA)·east − sin(PA)·north.
  const perpX = cosPa * east[0] - sinPa * north[0];
  const perpY = cosPa * east[1] - sinPa * north[1];
  const perpZ = cosPa * east[2] - sinPa * north[2];
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);
  // Disc normal (local +Z) = cos(i)·ê_los + sin(i)·perp.
  const zWorld: [number, number, number] = [
    cosI * los[0] + sinI * perpX,
    cosI * los[1] + sinI * perpY,
    cosI * los[2] + sinI * perpZ,
  ];
  // y = z × x (in the disc plane, completing the right-handed basis).
  const yWorld: [number, number, number] = [
    zWorld[1] * xWorld[2] - zWorld[2] * xWorld[1],
    zWorld[2] * xWorld[0] - zWorld[0] * xWorld[2],
    zWorld[0] * xWorld[1] - zWorld[1] * xWorld[0],
  ];
  return basisToQuaternion(xWorld, yWorld, zWorld);
}

/** Build a slug from a display name (lower-case, kebab-case, ASCII only). */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'object'
  );
}

/** Filter LVDB rows to those that pass the rendering predicate:
 *  confirmed real, confirmed galaxy, valid ra/dec/distance, and within
 *  the MAX_DISTANCE_PC heliocentric envelope. */
export function filterForRendering(rows: LvdbRow[]): LvdbRow[] {
  return rows.filter((r) => {
    if (!Number.isFinite(r.ra) || !Number.isFinite(r.dec)) return false;
    if (!Number.isFinite(r.distanceKpc) || r.distanceKpc <= 0) return false;
    if (r.confirmedReal !== 1 || r.confirmedGalaxy !== 1) return false;
    return r.distanceKpc * 1000 <= MAX_DISTANCE_PC;
  });
}

/** Display-name overrides applied at output. LVDB's `name` column drives
 *  override-merge (overrides.tsv → LVDB row) and per-row identity, but
 *  the on-disk + on-screen display string is rewritten through this
 *  map for objects whose canonical name diverges from the LVDB
 *  shortform OR whose type-suffix differs from the default. */
export const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  LMC: 'Large Magellanic Cloud',
  SMC: 'Small Magellanic Cloud',
};

/** Default type suffix appended to LVDB names that aren't in the
 *  override map. Every dwarf galaxy at ≤ 250 kpc that we currently
 *  render (52 objects: LMC, SMC, Sagittarius, and ~49 classical /
 *  ultra-faint satellites) is a dSph, with LMC and SMC the only two
 *  exceptions handled via DISPLAY_NAME_OVERRIDES. Without the suffix,
 *  bare names like "Sculptor", "Draco", "Hercules" collide with the
 *  constellation names; "Sagittarius" alone is ambiguous with the
 *  Sagittarius Dwarf Irregular at 1.2 Mpc. Astronomers disambiguate
 *  the same way in papers — we follow the convention. */
export const DEFAULT_TYPE_SUFFIX = 'Dwarf Spheroidal';

export function displayName(lvdbName: string): string {
  if (lvdbName in DISPLAY_NAME_OVERRIDES) return DISPLAY_NAME_OVERRIDES[lvdbName];
  return `${lvdbName} ${DEFAULT_TYPE_SUFFIX}`;
}

/** Default sky-plane oblate ellipsoid for an LVDB row with no override
 *  — uses rhalf_physical as the semi-major axis, ellipticity to derive
 *  the in-plane minor axis, and matches the minor axis along line of
 *  sight (axially symmetric around the projected major axis). Returns
 *  null if LVDB lacks the structural data we need. */
export function buildLvdbDefault(row: LvdbRow): {
  kind: LgKind;
  axes: [number, number, number];
  orient: Orientation;
} | null {
  if (row.rhalfPhysicalPc === null || row.rhalfPhysicalPc <= 0) return null;
  const e = row.ellipticity ?? 0;
  const a = row.rhalfPhysicalPc;
  const b = a * Math.max(0.05, 1 - e); // clamp so e≈1 doesn't collapse to a line
  const c = b; // axially symmetric around the projected major axis
  const pa = row.positionAngle ?? 0;
  return {
    kind: 'ellipsoid',
    axes: [a, b, c],
    orient: { kind: 'pa', pa },
  };
}

/** Merge an LVDB row with an optional override into a fully-shaped
 *  LgObject. Override (when present) replaces axes + orient; LVDB
 *  always provides the position. Returns null when the row has no
 *  override AND no LVDB structural data — i.e. there's nothing to
 *  render. */
export function mergeRowAndOverride(
  row: LvdbRow,
  override: OverrideRow | undefined,
): LgObject | null {
  let kind: LgKind;
  let axes: [number, number, number];
  let orient: Orientation;
  let source: 'LVDB' | 'OVERRIDE';
  if (override) {
    // Override wins on structure. Kind is inferred from orient shape:
    // 'disc' orient → disc; anything else → ellipsoid.
    orient = parseOrient(override.orient);
    kind = orient.kind === 'disc' ? 'disc' : 'ellipsoid';
    axes = override.axes;
    source = 'OVERRIDE';
  } else {
    const lvdb = buildLvdbDefault(row);
    if (!lvdb) return null;
    kind = lvdb.kind;
    axes = lvdb.axes;
    orient = lvdb.orient;
    source = 'LVDB';
  }
  const distancePc = row.distanceKpc * 1000;
  const center = raDecDistanceToIcrs(row.ra, row.dec, distancePc);
  const quat = buildOrientationQuat(row.ra, row.dec, orient);
  return {
    name: displayName(row.name),
    id: slugify(row.key),
    center,
    kind,
    axes,
    quat,
    source,
    distance: distancePc,
  };
}

/** Round a number to N decimal places. Strips JS float noise from
 *  output JSON so committed (gitignored) artifacts diff cleanly when
 *  regenerated. */
export function roundN(x: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(x * f) / f;
}
