// Tests for the I/O-adjacent helpers in build-local-group.ts.
// The pure geometry / orientation / merge helpers are covered in
// build-local-group-pure.test.ts; this file exercises the override
// TSV parser, including the optional standalone-position columns the
// 2 Mpc expansion (stellata-1ui) added.

import { describe, expect, it } from 'vitest';
import { parseOverrides } from './build-local-group';

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
