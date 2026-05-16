import { describe, it, expect } from 'vitest';
import {
  basisToQuaternion,
  buildLvdbDefault,
  buildOrientationQuat,
  buildStandaloneOverride,
  displayName,
  filterForRendering,
  isCatalogDesignation,
  mergeRowAndOverride,
  parseOrient,
  raDecDistanceToIcrs,
  skyBasis,
  slugify,
  DISPLAY_NAME_OVERRIDES,
  MAX_DISTANCE_PC,
  type LvdbRow,
  type OverrideRow,
} from './build-local-group-pure';

const SOL_AXIS_X: [number, number, number] = [1, 0, 0];

function unitNorm(q: [number, number, number, number]): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

function dot3(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function makeRow(o: Partial<LvdbRow>): LvdbRow {
  return {
    key: o.key ?? 'test',
    name: o.name ?? 'Test',
    ra: o.ra ?? 0,
    dec: o.dec ?? 0,
    distanceKpc: o.distanceKpc ?? 100,
    confirmedReal: o.confirmedReal ?? 1,
    confirmedGalaxy: o.confirmedGalaxy ?? 1,
    rhalfPhysicalPc: o.rhalfPhysicalPc ?? null,
    ellipticity: o.ellipticity ?? null,
    positionAngle: o.positionAngle ?? null,
  };
}

describe('raDecDistanceToIcrs', () => {
  it('(RA=0, Dec=0, d=1) → ICRS +X', () => {
    const [x, y, z] = raDecDistanceToIcrs(0, 0, 1);
    expect(x).toBeCloseTo(1, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(0, 12);
  });
  it('(RA=90, Dec=0, d=1) → ICRS +Y', () => {
    const [x, y, z] = raDecDistanceToIcrs(90, 0, 1);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(1, 12);
    expect(z).toBeCloseTo(0, 12);
  });
  it('(RA=*, Dec=90, d=1) → ICRS +Z', () => {
    const [x, y, z] = raDecDistanceToIcrs(45, 90, 1);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(1, 12);
  });
});

describe('skyBasis', () => {
  it('returns mutually-orthonormal vectors at a generic sky position', () => {
    const { los, east, north } = skyBasis(45, 30);
    expect(Math.hypot(...los)).toBeCloseTo(1, 12);
    expect(Math.hypot(...east)).toBeCloseTo(1, 12);
    expect(Math.hypot(...north)).toBeCloseTo(1, 12);
    expect(dot3(los, east)).toBeCloseTo(0, 12);
    expect(dot3(los, north)).toBeCloseTo(0, 12);
    expect(dot3(east, north)).toBeCloseTo(0, 12);
  });
  it('forms a right-handed triple: east × north = los', () => {
    const { los, east, north } = skyBasis(45, 30);
    const c = cross3(east, north);
    expect(c[0]).toBeCloseTo(los[0], 12);
    expect(c[1]).toBeCloseTo(los[1], 12);
    expect(c[2]).toBeCloseTo(los[2], 12);
  });
});

describe('basisToQuaternion', () => {
  it('identity basis → identity quaternion (w=1)', () => {
    const q = basisToQuaternion([1, 0, 0], [0, 1, 0], [0, 0, 1]);
    expect(q[0]).toBeCloseTo(0, 12);
    expect(q[1]).toBeCloseTo(0, 12);
    expect(q[2]).toBeCloseTo(0, 12);
    expect(q[3]).toBeCloseTo(1, 12);
  });
  it('produces unit quaternions for arbitrary orthonormal right-handed bases', () => {
    const { los, east, north } = skyBasis(123, -45);
    const q = basisToQuaternion(east, north, los);
    expect(unitNorm(q)).toBeCloseTo(1, 10);
  });
});

describe('parseOrient', () => {
  it('parses each variant verbatim', () => {
    expect(parseOrient('los')).toEqual({ kind: 'los' });
    expect(parseOrient('pa:135')).toEqual({ kind: 'pa', pa: 135 });
    expect(parseOrient('pa:-90')).toEqual({ kind: 'pa', pa: -90 });
    expect(parseOrient('disc:i=32,pa=135')).toEqual({
      kind: 'disc', inclination: 32, pa: 135,
    });
  });
  it('throws on an unrecognised orient string (loud build-time failure)', () => {
    expect(() => parseOrient('triaxial')).toThrow();
    expect(() => parseOrient('pa=135')).toThrow();
    expect(() => parseOrient('')).toThrow();
  });
});

describe('buildOrientationQuat — unit-norm invariant across all orient kinds', () => {
  it('pa orient', () => {
    const q = buildOrientationQuat(78.76, -69.19, { kind: 'pa', pa: 135 });
    expect(unitNorm(q)).toBeCloseTo(1, 10);
  });
  it('los orient', () => {
    const q = buildOrientationQuat(13.16, -72.8, { kind: 'los' });
    expect(unitNorm(q)).toBeCloseTo(1, 10);
  });
  it('disc orient', () => {
    const q = buildOrientationQuat(78.76, -69.19, { kind: 'disc', inclination: 32, pa: 135 });
    expect(unitNorm(q)).toBeCloseTo(1, 10);
  });
});

describe('buildOrientationQuat — geometric correctness', () => {
  // Helper: rotate a local 3-vector by quaternion q to world space.
  function rotateByQuat(
    q: [number, number, number, number],
    v: [number, number, number],
  ): [number, number, number] {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    // v' = q · v · q* using the standard expansion.
    const ix = qw * vx + qy * vz - qz * vy;
    const iy = qw * vy + qz * vx - qx * vz;
    const iz = qw * vz + qx * vy - qy * vx;
    const iw = -qx * vx - qy * vy - qz * vz;
    return [
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ];
  }
  it('los orient: local +Z (=c-axis) rotates onto line-of-sight from Sol', () => {
    const ra = 13.16, dec = -72.8;
    const q = buildOrientationQuat(ra, dec, { kind: 'los' });
    const cWorld = rotateByQuat(q, [0, 0, 1]);
    const { los } = skyBasis(ra, dec);
    expect(cWorld[0]).toBeCloseTo(los[0], 10);
    expect(cWorld[1]).toBeCloseTo(los[1], 10);
    expect(cWorld[2]).toBeCloseTo(los[2], 10);
  });
  it('pa orient: local +X (=long axis) lies in the sky plane (⊥ to LOS)', () => {
    const ra = 100, dec = 20, pa = 47;
    const q = buildOrientationQuat(ra, dec, { kind: 'pa', pa });
    const aWorld = rotateByQuat(q, [1, 0, 0]);
    const { los } = skyBasis(ra, dec);
    expect(dot3(aWorld, los)).toBeCloseTo(0, 10);
  });
  it('disc orient at i=0: disc normal (+Z) = line of sight', () => {
    const ra = 78.76, dec = -69.19;
    const q = buildOrientationQuat(ra, dec, { kind: 'disc', inclination: 0, pa: 135 });
    const zWorld = rotateByQuat(q, [0, 0, 1]);
    const { los } = skyBasis(ra, dec);
    expect(zWorld[0]).toBeCloseTo(los[0], 10);
    expect(zWorld[1]).toBeCloseTo(los[1], 10);
    expect(zWorld[2]).toBeCloseTo(los[2], 10);
  });
  it('disc orient: line of nodes (+X) lies in the sky plane regardless of inclination', () => {
    const ra = 78.76, dec = -69.19;
    const q = buildOrientationQuat(ra, dec, { kind: 'disc', inclination: 32, pa: 135 });
    const xWorld = rotateByQuat(q, [1, 0, 0]);
    const { los } = skyBasis(ra, dec);
    expect(dot3(xWorld, los)).toBeCloseTo(0, 10);
  });
});

describe('filterForRendering', () => {
  it('drops candidate (confirmed_real=0) rows', () => {
    const rows = [makeRow({ confirmedReal: 0 }), makeRow({ confirmedReal: 1 })];
    expect(filterForRendering(rows)).toHaveLength(1);
  });
  it('drops globular-cluster-shaped rows (confirmed_galaxy=0)', () => {
    const rows = [makeRow({ confirmedGalaxy: 0 }), makeRow({ confirmedGalaxy: 1 })];
    expect(filterForRendering(rows)).toHaveLength(1);
  });
  it('drops rows with missing or non-positive distance', () => {
    const rows = [
      makeRow({ distanceKpc: NaN }),
      makeRow({ distanceKpc: 0 }),
      makeRow({ distanceKpc: 50 }),
    ];
    expect(filterForRendering(rows)).toHaveLength(1);
  });
  it('drops rows past MAX_DISTANCE_PC (= 2 Mpc)', () => {
    expect(MAX_DISTANCE_PC).toBe(2_000_000);
    const rows = [
      makeRow({ distanceKpc: 200, key: 'inner' }),
      makeRow({ distanceKpc: 780, key: 'm31-band' }),
      makeRow({ distanceKpc: 2000, key: 'edge-in' }),
      makeRow({ distanceKpc: 2000.001, key: 'edge-out' }),
      makeRow({ distanceKpc: 5000, key: 'far' }),
    ];
    const kept = filterForRendering(rows).map((r) => r.key);
    expect(kept).toEqual(['inner', 'm31-band', 'edge-in']);
  });
  it('drops rows with missing RA/Dec', () => {
    const rows = [makeRow({ ra: NaN }), makeRow({ dec: NaN }), makeRow({})];
    expect(filterForRendering(rows)).toHaveLength(1);
  });
});

describe('buildLvdbDefault', () => {
  it('returns null when rhalf_physical is missing — nothing to render', () => {
    expect(buildLvdbDefault(makeRow({ rhalfPhysicalPc: null }))).toBeNull();
    expect(buildLvdbDefault(makeRow({ rhalfPhysicalPc: 0 }))).toBeNull();
  });
  it('builds sky-plane oblate axes from rhalf + ellipticity', () => {
    const out = buildLvdbDefault(makeRow({
      rhalfPhysicalPc: 1000, ellipticity: 0.4, positionAngle: 45,
    }))!;
    expect(out.kind).toBe('ellipsoid');
    expect(out.axes[0]).toBe(1000);          // a = rhalf
    expect(out.axes[1]).toBeCloseTo(600, 6); // b = a · (1 - e)
    expect(out.axes[2]).toBeCloseTo(600, 6); // c = b (axially symmetric)
    expect(out.orient).toEqual({ kind: 'pa', pa: 45 });
  });
  it('clamps e≈1 so the minor axis does not collapse to a line', () => {
    const out = buildLvdbDefault(makeRow({
      rhalfPhysicalPc: 1000, ellipticity: 1.0,
    }))!;
    // With e=1 the raw formula gives b=0; clamp keeps it at 5% of a.
    expect(out.axes[1]).toBeGreaterThan(0);
    expect(out.axes[1]).toBeCloseTo(50, 6);
  });
});

describe('mergeRowAndOverride — override-vs-LVDB precedence', () => {
  const override: OverrideRow = {
    name: 'Test',
    axes: [100, 200, 300],
    orient: 'los',
    refDoi: '10.1234/test',
  };
  it('override replaces axes + orient; LVDB position survives', () => {
    const row = makeRow({
      name: 'Test',
      ra: 78.76, dec: -69.19, distanceKpc: 50,
      rhalfPhysicalPc: 999, ellipticity: 0.5, positionAngle: 60, // would be picked if no override
    });
    const out = mergeRowAndOverride(row, override)!;
    expect(out.source).toBe('OVERRIDE');
    expect(out.kind).toBe('ellipsoid');         // los → ellipsoid
    expect(out.axes).toEqual([100, 200, 300]);
    expect(out.distance).toBe(50_000);          // 50 kpc → 50_000 pc
    // Position derived from RA/Dec/d:
    expect(Math.hypot(...out.center)).toBeCloseTo(50_000, 4);
  });
  it('no override + valid LVDB rhalf → LVDB-default rendering', () => {
    const row = makeRow({
      rhalfPhysicalPc: 500, ellipticity: 0.2, positionAngle: 30,
    });
    const out = mergeRowAndOverride(row, undefined)!;
    expect(out.source).toBe('LVDB');
    expect(out.kind).toBe('ellipsoid');
    expect(out.axes[0]).toBe(500);
  });
  it('no override + no LVDB rhalf → null (nothing to render)', () => {
    const row = makeRow({ rhalfPhysicalPc: null });
    expect(mergeRowAndOverride(row, undefined)).toBeNull();
  });
  it('disc-orient override yields kind=disc', () => {
    const row = makeRow({ name: 'LMC' });
    const lmcOverride: OverrideRow = {
      name: 'LMC',
      axes: [4500, 4500, 1000],
      orient: 'disc:i=32,pa=135',
      refDoi: '10.1088/0004-637X/781/2/121',
    };
    const out = mergeRowAndOverride(row, lmcOverride)!;
    expect(out.kind).toBe('disc');
  });
});

describe('displayName overrides + default type suffix', () => {
  it('expands the Magellanic acronyms (full names; we have the room)', () => {
    expect(displayName('LMC')).toBe('Large Magellanic Cloud');
    expect(displayName('SMC')).toBe('Small Magellanic Cloud');
  });
  it('appends "Dwarf Spheroidal" by default — astronomers disambiguate from the constellation name', () => {
    expect(displayName('Sagittarius')).toBe('Sagittarius Dwarf Spheroidal');
    expect(displayName('Sculptor')).toBe('Sculptor Dwarf Spheroidal');
    expect(displayName('Bootes II')).toBe('Bootes II Dwarf Spheroidal');
    expect(displayName('Andromeda I')).toBe('Andromeda I Dwarf Spheroidal');
  });
  it('catalog designations bypass the suffix — they self-identify', () => {
    expect(displayName('NGC 205')).toBe('NGC 205');
    expect(displayName('NGC 6822')).toBe('NGC 6822');
    expect(displayName('IC 10')).toBe('IC 10');
    expect(displayName('IC 1613')).toBe('IC 1613');
    expect(displayName('M 32')).toBe('M 32');
    expect(displayName('M31')).toBe('M31');
    expect(displayName('M33')).toBe('M33');
    expect(displayName('UGC 4879')).toBe('UGC 4879');
    expect(displayName('DDO 82')).toBe('DDO 82');
  });
  it('explicitly overrides the named non-dSph dwarfs that the regex misses', () => {
    expect(displayName('Leo A')).toBe('Leo A');
    expect(displayName('WLM')).toBe('WLM');
    expect(displayName('Phoenix')).toBe('Phoenix Dwarf');
    expect(displayName('Pegasus dIrr')).toBe('Pegasus Dwarf Irregular');
    expect(displayName('Sextans A')).toBe('Sextans A');
    expect(displayName('Sextans B')).toBe('Sextans B');
    expect(displayName('Sagittarius dIrr')).toBe('Sagittarius Dwarf Irregular');
  });
  it('exports the override map for callers that need to enumerate it', () => {
    expect(Object.keys(DISPLAY_NAME_OVERRIDES).sort()).toEqual([
      'LGS 3',
      'LMC',
      'Leo A',
      'Pegasus W',
      'Pegasus dIrr',
      'Phoenix',
      'SMC',
      'Sagittarius dIrr',
      'Sextans A',
      'Sextans B',
      'WLM',
    ]);
  });
  it('mergeRowAndOverride emits the display name on the LgObject (override path)', () => {
    const row: LvdbRow = {
      key: 'lmc',
      name: 'LMC',
      ra: 78.76, dec: -69.19, distanceKpc: 49.59,
      confirmedReal: 1, confirmedGalaxy: 1,
      rhalfPhysicalPc: null, ellipticity: null, positionAngle: null,
    };
    const override: OverrideRow = {
      name: 'LMC',
      axes: [4500, 4500, 1000],
      orient: 'disc:i=32,pa=135',
      refDoi: '10.1088/0004-637X/781/2/121',
    };
    const out = mergeRowAndOverride(row, override)!;
    expect(out.name).toBe('Large Magellanic Cloud');
  });
  it('mergeRowAndOverride emits the suffixed display name on the LgObject (LVDB-default path)', () => {
    const row: LvdbRow = {
      key: 'sculptor_1',
      name: 'Sculptor',
      ra: 15, dec: -33, distanceKpc: 84,
      confirmedReal: 1, confirmedGalaxy: 1,
      rhalfPhysicalPc: 270, ellipticity: 0.3, positionAngle: 99,
    };
    const out = mergeRowAndOverride(row, undefined)!;
    expect(out.name).toBe('Sculptor Dwarf Spheroidal');
  });
});

describe('isCatalogDesignation', () => {
  it('matches recognised catalog prefixes followed by digits', () => {
    expect(isCatalogDesignation('NGC 205')).toBe(true);
    expect(isCatalogDesignation('IC 10')).toBe(true);
    expect(isCatalogDesignation('M 32')).toBe(true);
    expect(isCatalogDesignation('M31')).toBe(true);     // no space
    expect(isCatalogDesignation('UGC 4879')).toBe(true);
    expect(isCatalogDesignation('UGCA 292')).toBe(true);
    expect(isCatalogDesignation('DDO 82')).toBe(true);
    expect(isCatalogDesignation('KKH 37')).toBe(true);
    expect(isCatalogDesignation('PGC 41210')).toBe(true);
  });
  it('rejects proper names and bare constellation names', () => {
    expect(isCatalogDesignation('Sculptor')).toBe(false);
    expect(isCatalogDesignation('Andromeda I')).toBe(false);
    expect(isCatalogDesignation('Phoenix')).toBe(false);
    expect(isCatalogDesignation('Pegasus dIrr')).toBe(false);
    expect(isCatalogDesignation('WLM')).toBe(false);
    expect(isCatalogDesignation('Leo A')).toBe(false);
    expect(isCatalogDesignation('LGS 3')).toBe(false); // LGS not in the prefix list
  });
  it('requires a digit after the prefix — bare letters don\'t pass', () => {
    expect(isCatalogDesignation('NGC')).toBe(false);
    expect(isCatalogDesignation('IC')).toBe(false);
    expect(isCatalogDesignation('M')).toBe(false);
  });
});

describe('buildStandaloneOverride', () => {
  const m31: OverrideRow = {
    name: 'M31',
    axes: [15000, 15000, 500],
    orient: 'disc:i=77,pa=37',
    refDoi: '10.3847/1538-4357/aae8e7',
    raDeg: 10.6847,
    decDeg: 41.2687,
    distanceKpc: 776,
  };
  it('synthesises a full LgObject from override-only fields', () => {
    const out = buildStandaloneOverride(m31)!;
    expect(out).not.toBeNull();
    expect(out.id).toBe('m31');
    expect(out.name).toBe('M31');                      // catalog-designation, no suffix
    expect(out.kind).toBe('disc');
    expect(out.axes).toEqual([15000, 15000, 500]);
    expect(out.source).toBe('OVERRIDE');
    expect(out.distance).toBe(776_000);
    expect(Math.hypot(...out.center)).toBeCloseTo(776_000, 0);
  });
  it('returns null when distance exceeds MAX_DISTANCE_PC', () => {
    const farFlung: OverrideRow = {
      ...m31,
      distanceKpc: MAX_DISTANCE_PC / 1000 + 1,         // 2001 kpc
    };
    expect(buildStandaloneOverride(farFlung)).toBeNull();
  });
  it('returns null when distance is non-positive or non-finite', () => {
    expect(buildStandaloneOverride({ ...m31, distanceKpc: 0 })).toBeNull();
    expect(buildStandaloneOverride({ ...m31, distanceKpc: -100 })).toBeNull();
    expect(buildStandaloneOverride({ ...m31, distanceKpc: NaN })).toBeNull();
  });
  it('throws when ra/dec/distance are missing — config error, surface loudly', () => {
    const noPos: OverrideRow = {
      name: 'NoPos',
      axes: [1, 1, 1],
      orient: 'los',
      refDoi: 'x',
    };
    expect(() => buildStandaloneOverride(noPos)).toThrow(/no LVDB match/);
  });
});

describe('slugify', () => {
  it('preserves a clean lower-case key', () => {
    expect(slugify('lmc')).toBe('lmc');
  });
  it('strips punctuation and collapses whitespace', () => {
    expect(slugify('Bootes II')).toBe('bootes-ii');
    expect(slugify('NGC 6822')).toBe('ngc-6822');
  });
  it('falls back to "object" when input has nothing kebab-able', () => {
    expect(slugify('…')).toBe('object');
  });
});

void SOL_AXIS_X; // suppress unused-export-test export
