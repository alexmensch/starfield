// Build the Local Group catalog consumed by the client wireframe layer.
//
// Reads two committed source files under data/local-group/:
//   - lvdb-snapshot.csv  (Pace et al. 2024 LVDB dwarf_all table — CC0)
//   - overrides.tsv      (hand-curated structural detail for LMC, SMC,
//                         Sagittarius dSph)
//
// Emits public/local-group.json with one entry per renderable object
// within MAX_DISTANCE_PC of Sol. Output schema is documented at the
// LgObject type in build-local-group-pure.ts; the client loader at
// src/client/local-group-loader.ts mirrors it 1:1.
//
// Idempotent — exits early if public/local-group.json is newer than
// this script and both source files. Run via `npm run build:local-group`.
//
// Per stellata-bd-operations + frozen-external-data: no live fetches at
// build time; refresh of the LVDB snapshot is an explicit manual step
// (curl raw.githubusercontent.com/apace7/local_volume_database/main/
// data/dwarf_all.csv → data/local-group/lvdb-snapshot.csv).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import {
  buildOrientationQuat,
  filterForRendering,
  mergeRowAndOverride,
  roundN,
  type LgObject,
  type LvdbRow,
  type OverrideRow,
} from './build-local-group-pure';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const SRC_CSV = resolve(ROOT, 'data/local-group/lvdb-snapshot.csv');
const SRC_OVERRIDES = resolve(ROOT, 'data/local-group/overrides.tsv');
const OUT = resolve(ROOT, 'public/local-group.json');

/** Parse the LVDB CSV into a flat array of rows. Coerces strings to
 *  numbers / null per LVDB convention ("" = missing for numeric cols). */
export function parseLvdb(csv: string): LvdbRow[] {
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  const num = (s: string | undefined): number | null => {
    if (s === undefined || s === '') return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  };
  const int = (s: string | undefined): number => {
    const v = num(s);
    return v === null ? 0 : v;
  };

  return records.map((r) => ({
    key: r.key,
    name: r.name || r.key,
    ra: num(r.ra) ?? NaN,
    dec: num(r.dec) ?? NaN,
    distanceKpc: num(r.distance) ?? NaN,
    confirmedReal: int(r.confirmed_real),
    confirmedGalaxy: int(r.confirmed_galaxy),
    rhalfPhysicalPc: num(r.rhalf_physical),
    ellipticity: num(r.ellipticity),
    positionAngle: num(r.position_angle),
    mVAbs: num(r.M_V),
  }));
}

/** Parse overrides.tsv (header line + tab-separated rows; lines starting
 *  with # are comments).
 *
 *  Schema: name<TAB>a_pc<TAB>b_pc<TAB>c_pc<TAB>orient<TAB>label_threshold_pc<TAB>ref_doi
 *  Empty label_threshold_pc → null (no label). */
export function parseOverrides(tsv: string): OverrideRow[] {
  const out: OverrideRow[] = [];
  const lines = tsv.split(/\r?\n/);
  let headerSeen = false;
  for (const raw of lines) {
    if (!raw || raw.startsWith('#')) continue;
    const fields = raw.split('\t');
    if (!headerSeen) {
      // First non-comment line is the header. Sanity-check the shape so a
      // schema drift surfaces loudly at build time.
      const expected = ['name', 'a_pc', 'b_pc', 'c_pc', 'orient', 'label_threshold_pc', 'ref_doi'];
      if (fields.length < expected.length || fields[0] !== 'name') {
        throw new Error(`overrides.tsv: malformed header (got ${fields.length} fields, expected ${expected.length})`);
      }
      headerSeen = true;
      continue;
    }
    if (fields.length < 7) continue;
    const labelThresholdStr = fields[5].trim();
    out.push({
      name: fields[0].trim(),
      axes: [parseFloat(fields[1]), parseFloat(fields[2]), parseFloat(fields[3])],
      orient: fields[4].trim(),
      labelThresholdPc: labelThresholdStr === '' ? null : parseFloat(labelThresholdStr),
      refDoi: fields[6].trim(),
    });
  }
  return out;
}

/** Convert merged LgObject(s) to the on-disk JSON shape. Trims numeric
 *  precision so repeat builds produce stable diffs. */
function toJsonObject(o: LgObject) {
  return {
    name: o.name,
    id: o.id,
    center: o.center.map((v) => roundN(v, 2)),
    kind: o.kind,
    axes: o.axes.map((v) => roundN(v, 2)),
    quat: o.quat.map((v) => roundN(v, 6)),
    labelThresholdPc: o.labelThresholdPc,
    source: o.source,
    distance: roundN(o.distance, 1),
  };
}

function isUpToDate(): boolean {
  if (!existsSync(OUT)) return false;
  const outMtime = statSync(OUT).mtimeMs;
  for (const src of [SRC_CSV, SRC_OVERRIDES, __filename, resolve(__dirname, 'build-local-group-pure.ts')]) {
    if (!existsSync(src)) return false;
    if (statSync(src).mtimeMs > outMtime) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  if (!force && isUpToDate()) {
    console.log('local-group.json up to date — skipping (use --force to rebuild)');
    return;
  }

  if (!existsSync(SRC_CSV)) {
    console.error(`error: missing ${SRC_CSV}`);
    process.exit(1);
  }
  if (!existsSync(SRC_OVERRIDES)) {
    console.error(`error: missing ${SRC_OVERRIDES}`);
    process.exit(1);
  }

  const lvdb = parseLvdb(readFileSync(SRC_CSV, 'utf8'));
  const overrides = parseOverrides(readFileSync(SRC_OVERRIDES, 'utf8'));
  const overrideByName = new Map(overrides.map((o) => [o.name, o]));

  const renderable = filterForRendering(lvdb);
  const objects: LgObject[] = [];
  let overrideHits = 0;
  let lvdbDefaultHits = 0;
  let skippedNoStructure = 0;
  for (const row of renderable) {
    const merged = mergeRowAndOverride(row, overrideByName.get(row.name));
    if (!merged) {
      skippedNoStructure += 1;
      continue;
    }
    if (merged.source === 'OVERRIDE') overrideHits += 1;
    else lvdbDefaultHits += 1;
    objects.push(merged);
  }

  // Stable order — by name, case-insensitive — so repeat builds emit
  // byte-identical artifacts.
  objects.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  await mkdir(dirname(OUT), { recursive: true });
  const payload = {
    version: 1,
    count: objects.length,
    objects: objects.map(toJsonObject),
  };
  await writeFile(OUT, JSON.stringify(payload, null, 0) + '\n');

  console.log(
    `wrote ${OUT.replace(ROOT + '/', '')} ` +
    `(${objects.length} objects: ${overrideHits} from overrides, ` +
    `${lvdbDefaultHits} from LVDB; ${skippedNoStructure} LVDB rows skipped — ` +
    `no structural data)`,
  );
  // Reference the unused symbol so the import survives tree-shaking
  // analysis in the test path that imports this file for the parsers.
  void buildOrientationQuat;
}

// Run as a script. ESM doesn't have require.main; gate on the entry-point
// path being our own filename instead.
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
