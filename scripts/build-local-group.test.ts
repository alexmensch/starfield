// Tests for the I/O-adjacent helpers in build-local-group.ts.
// The pure geometry / orientation / merge helpers are covered in
// build-local-group-pure.test.ts; this file exercises the override
// TSV parser, including the optional standalone-position columns the
// 2 Mpc expansion (stellata-1ui) added. The second describe block is
// an integration test that reads the committed LVDB CSV and pins the
// display-name routing for every renderable name — so future snapshots
// that introduce an unclassified name surface at test time before they
// render with the wrong morphology suffix.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLvdb, parseOverrides } from './build-local-group';
import {
  DISPLAY_NAME_OVERRIDES,
  filterForRendering,
  isCatalogDesignation,
} from './build-local-group-pure';

describe('parseOverrides', () => {
  const HEADER =
    'name\ta_pc\tb_pc\tc_pc\torient\tref_doi\tra_deg\tdec_deg\tdistance_kpc';

  it('parses an LVDB-merge row (6 columns) with empty trailing position fields', () => {
    const tsv = `${HEADER}\nLMC\t4500\t4500\t1000\tdisc:i=32,pa=135\t10.1088/0004-637X/781/2/121\n`;
    const rows = parseOverrides(tsv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      name: 'LMC',
      axes: [4500, 4500, 1000],
      orient: 'disc:i=32,pa=135',
      refDoi: '10.1088/0004-637X/781/2/121',
    });
  });

  it('parses a standalone row (9 columns) with full ra/dec/distance', () => {
    const tsv = `${HEADER}\nM31\t15000\t15000\t500\tdisc:i=77,pa=37\t10.3847/1538-4357/aae8e7\t10.6847\t41.2687\t776\n`;
    const rows = parseOverrides(tsv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      name: 'M31',
      axes: [15000, 15000, 500],
      orient: 'disc:i=77,pa=37',
      refDoi: '10.3847/1538-4357/aae8e7',
      raDeg: 10.6847,
      decDeg: 41.2687,
      distanceKpc: 776,
    });
  });

  it('accepts a 9-column row with all three optional fields empty (still an LVDB-merge row)', () => {
    const tsv = `${HEADER}\nSMC\t3730\t4960\t6000\tlos\t10.1088/0004-637X/744/2/128\t\t\t\n`;
    const rows = parseOverrides(tsv);
    expect(rows).toHaveLength(1);
    expect(rows[0].raDeg).toBeUndefined();
    expect(rows[0].decDeg).toBeUndefined();
    expect(rows[0].distanceKpc).toBeUndefined();
  });

  it('throws when the standalone position is partially populated', () => {
    // ra + dec set but distance empty — half-set is a config error.
    const tsv = `${HEADER}\nM31\t15000\t15000\t500\tdisc:i=77,pa=37\tx\t10.6847\t41.2687\t\n`;
    expect(() => parseOverrides(tsv)).toThrow(/partially populates/);
  });

  it('skips comment lines and blank lines', () => {
    const tsv = `# comment\n# another\n\n${HEADER}\n# inline comment\nLMC\t4500\t4500\t1000\tlos\tx\n`;
    expect(parseOverrides(tsv)).toHaveLength(1);
  });

  it('throws on a malformed header (wrong column order or missing required columns)', () => {
    expect(() => parseOverrides('name\tfoo\tbar\n')).toThrow(/malformed header/);
    expect(() =>
      parseOverrides('name\ta_pc\tb_pc\tc_pc\torient\twrong\n'),
    ).toThrow(/header column/);
  });
});

describe('LVDB-band display-name coverage (stellata-1ui)', () => {
  // Read the committed LVDB snapshot at test time so a future refresh
  // that introduces a name the renderer would mis-suffix surfaces here
  // rather than only at build-output review time. Reading committed
  // data follows the pattern in src/client/stellata-events.test.ts.
  const here = dirname(fileURLToPath(import.meta.url));
  const csvPath = join(here, '..', 'data', 'local-group', 'lvdb-snapshot.csv');
  const lvdb = parseLvdb(readFileSync(csvPath, 'utf8'));
  const renderable = filterForRendering(lvdb);

  // Every renderable name that legitimately falls to the default
  // "X Dwarf Spheroidal" branch — i.e. names that are genuinely dSphs
  // in the current snapshot. Names not on this list (and not catalog
  // designations or override-map entries) trip the assertion below so
  // we can decide between (a) adding a DISPLAY_NAME_OVERRIDES entry
  // because the name isn't a dSph, (b) confirming the dSph reading
  // and adding the name here. Refresh this set whenever the LVDB
  // snapshot under data/local-group/ rolls forward (manual; per
  // `frozen-external-data`).
  const KNOWN_DSPH_NAMES = new Set([
    'Andromeda I', 'Andromeda II', 'Andromeda III', 'Andromeda IX',
    'Andromeda V', 'Andromeda VI', 'Andromeda VII', 'Andromeda X',
    'Andromeda XI', 'Andromeda XII', 'Andromeda XIII', 'Andromeda XIV',
    'Andromeda XIX', 'Andromeda XV', 'Andromeda XVI', 'Andromeda XVII',
    'Andromeda XVIII', 'Andromeda XX', 'Andromeda XXI', 'Andromeda XXII',
    'Andromeda XXIII', 'Andromeda XXIV', 'Andromeda XXIX', 'Andromeda XXV',
    'Andromeda XXVI', 'Andromeda XXVII', 'Andromeda XXVIII', 'Andromeda XXXV',
    'Antlia', 'Antlia II', 'Aquarius II', 'Aquarius III',
    'Bootes I', 'Bootes II', 'Bootes III',
    'Canes Venatici I', 'Canes Venatici II',
    'Carina', 'Carina II', 'Carina III', 'Carina IV',
    'Cassiopeia II', 'Cassiopeia III', 'Centaurus I',
    'Cetus', 'Columba I', 'Coma Berenices', 'Crater II',
    'Draco', 'Draco II',
    'Eridanus II', 'Eridanus IV',
    'Fornax', 'Grus I', 'Grus II',
    'Hercules', 'Horologium I', 'Hydra II', 'Hydrus I',
    'Lacerta I',
    'Leo I', 'Leo II', 'Leo IV', 'Leo K', 'Leo M', 'Leo T', 'Leo V', 'Leo VI',
    'Pegasus III', 'Pegasus IV', 'Pegasus V', 'Pegasus VII',
    'Perseus I', 'Phoenix II', 'Pictor II',
    'Pisces II', 'Pisces VII',
    'Reticulum II', 'Reticulum III',
    'Sagittarius', 'Sculptor', 'Segue 1', 'Segue 2', 'Sextans',
    'Triangulum II',
    'Tucana', 'Tucana B', 'Tucana II', 'Tucana IV', 'Tucana V',
    'Ursa Major I', 'Ursa Major II', 'Ursa Minor', 'Willman 1',
  ]);

  it('every renderable name routes through a known display-name branch', () => {
    const unclassified: string[] = [];
    for (const row of renderable) {
      const n = row.name;
      if (n in DISPLAY_NAME_OVERRIDES) continue;
      if (isCatalogDesignation(n)) continue;
      if (!KNOWN_DSPH_NAMES.has(n)) unclassified.push(n);
    }
    // A non-empty list here means LVDB has a new name we haven't
    // classified; review its morphology and either add to
    // DISPLAY_NAME_OVERRIDES (if non-dSph) or to KNOWN_DSPH_NAMES.
    expect(unclassified).toEqual([]);
  });

  it('KNOWN_DSPH_NAMES has no stale entries — every name appears in the current LVDB band', () => {
    const renderableNames = new Set(renderable.map((r) => r.name));
    const stale = [...KNOWN_DSPH_NAMES].filter((n) => !renderableNames.has(n));
    expect(stale).toEqual([]);
  });

  it('override-map entries are all present in the current LVDB band (no orphaned overrides)', () => {
    // DISPLAY_NAME_OVERRIDES is the named-non-dSph map; M31 / M33 ride
    // through the catalog-designation regex, not this map, so every
    // entry here must correspond to an actual LVDB row.
    const renderableNames = new Set(renderable.map((r) => r.name));
    const orphaned = Object.keys(DISPLAY_NAME_OVERRIDES).filter(
      (n) => !renderableNames.has(n),
    );
    expect(orphaned).toEqual([]);
  });
});
