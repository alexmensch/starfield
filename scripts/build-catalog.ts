import { createReadStream, statSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';
import {
  parseSpectral,
  physicalRadius,
  normalizeGcvsName,
  parseGcvsNumber,
  inferBinaries,
  applyDoublesFlag as applyDoublesFlagPure,
  applyMultipleOverridesPure,
  FLAG_HAS_NAME,
  FLAG_IS_SOL,
  FLAG_HAS_BAYER,
  HEADER_LAYOUT,
  RECORD_LAYOUT,
  HEADER_SIZE,
  RECORD_SIZE,
  BINARY_VERSION,
  MAGIC,
  NO_COMPANION,
  NAME_TABLE_PADDING,
  NAME_LENGTH_PREFIX_BYTES,
  type SearchEntry,
  type MultipleOverrideRow,
} from './catalog-pure';
import {
  compareBuildCounts,
  formatCountDiff,
  type BuildCounts,
} from './build-counts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const SRC_CSV = resolve(ROOT, 'data/athyg_33_classic_ids.csv');
const SRC_STELLARIUM = resolve(ROOT, 'data/stellarium-modern-skyculture.json');
const SRC_GCVS = resolve(ROOT, 'data/gcvs5.txt');
const SRC_GCVS_XREF = resolve(ROOT, 'data/crossid.txt');
const SRC_HIP_CCDM = resolve(ROOT, 'data/hip_ccdm.tsv');
const SRC_MULTIPLES = resolve(ROOT, 'data/multiples.tsv');
const OUT_BIN = resolve(ROOT, 'public/catalog.bin');
const OUT_CON = resolve(ROOT, 'public/constellations.json');
const OUT_SEARCH = resolve(ROOT, 'public/search-index.json');
const EXPECTED_COUNTS = resolve(__dirname, 'build-catalog-expected.json');

const MAX_DIST_PC = 50_000;
const DEFAULT_CI = 0.65;

const CONSTELLATIONS: { code: string; name: string }[] = [
  { code: 'And', name: 'Andromeda' },
  { code: 'Ant', name: 'Antlia' },
  { code: 'Aps', name: 'Apus' },
  { code: 'Aql', name: 'Aquila' },
  { code: 'Aqr', name: 'Aquarius' },
  { code: 'Ara', name: 'Ara' },
  { code: 'Ari', name: 'Aries' },
  { code: 'Aur', name: 'Auriga' },
  { code: 'Boo', name: 'Boötes' },
  { code: 'Cae', name: 'Caelum' },
  { code: 'Cam', name: 'Camelopardalis' },
  { code: 'Cap', name: 'Capricornus' },
  { code: 'Car', name: 'Carina' },
  { code: 'Cas', name: 'Cassiopeia' },
  { code: 'Cen', name: 'Centaurus' },
  { code: 'Cep', name: 'Cepheus' },
  { code: 'Cet', name: 'Cetus' },
  { code: 'Cha', name: 'Chamaeleon' },
  { code: 'Cir', name: 'Circinus' },
  { code: 'CMa', name: 'Canis Major' },
  { code: 'CMi', name: 'Canis Minor' },
  { code: 'Cnc', name: 'Cancer' },
  { code: 'Col', name: 'Columba' },
  { code: 'Com', name: 'Coma Berenices' },
  { code: 'CrA', name: 'Corona Australis' },
  { code: 'CrB', name: 'Corona Borealis' },
  { code: 'Crt', name: 'Crater' },
  { code: 'Cru', name: 'Crux' },
  { code: 'Crv', name: 'Corvus' },
  { code: 'CVn', name: 'Canes Venatici' },
  { code: 'Cyg', name: 'Cygnus' },
  { code: 'Del', name: 'Delphinus' },
  { code: 'Dor', name: 'Dorado' },
  { code: 'Dra', name: 'Draco' },
  { code: 'Equ', name: 'Equuleus' },
  { code: 'Eri', name: 'Eridanus' },
  { code: 'For', name: 'Fornax' },
  { code: 'Gem', name: 'Gemini' },
  { code: 'Gru', name: 'Grus' },
  { code: 'Her', name: 'Hercules' },
  { code: 'Hor', name: 'Horologium' },
  { code: 'Hya', name: 'Hydra' },
  { code: 'Hyi', name: 'Hydrus' },
  { code: 'Ind', name: 'Indus' },
  { code: 'Lac', name: 'Lacerta' },
  { code: 'Leo', name: 'Leo' },
  { code: 'Lep', name: 'Lepus' },
  { code: 'Lib', name: 'Libra' },
  { code: 'LMi', name: 'Leo Minor' },
  { code: 'Lup', name: 'Lupus' },
  { code: 'Lyn', name: 'Lynx' },
  { code: 'Lyr', name: 'Lyra' },
  { code: 'Men', name: 'Mensa' },
  { code: 'Mic', name: 'Microscopium' },
  { code: 'Mon', name: 'Monoceros' },
  { code: 'Mus', name: 'Musca' },
  { code: 'Nor', name: 'Norma' },
  { code: 'Oct', name: 'Octans' },
  { code: 'Oph', name: 'Ophiuchus' },
  { code: 'Ori', name: 'Orion' },
  { code: 'Pav', name: 'Pavo' },
  { code: 'Peg', name: 'Pegasus' },
  { code: 'Per', name: 'Perseus' },
  { code: 'Phe', name: 'Phoenix' },
  { code: 'Pic', name: 'Pictor' },
  { code: 'PsA', name: 'Piscis Austrinus' },
  { code: 'Psc', name: 'Pisces' },
  { code: 'Pup', name: 'Puppis' },
  { code: 'Pyx', name: 'Pyxis' },
  { code: 'Ret', name: 'Reticulum' },
  { code: 'Scl', name: 'Sculptor' },
  { code: 'Sco', name: 'Scorpius' },
  { code: 'Sct', name: 'Scutum' },
  { code: 'Ser', name: 'Serpens' },
  { code: 'Sex', name: 'Sextans' },
  { code: 'Sge', name: 'Sagitta' },
  { code: 'Sgr', name: 'Sagittarius' },
  { code: 'Tau', name: 'Taurus' },
  { code: 'Tel', name: 'Telescopium' },
  { code: 'TrA', name: 'Triangulum Australe' },
  { code: 'Tri', name: 'Triangulum' },
  { code: 'Tuc', name: 'Tucana' },
  { code: 'UMa', name: 'Ursa Major' },
  { code: 'UMi', name: 'Ursa Minor' },
  { code: 'Vel', name: 'Vela' },
  { code: 'Vir', name: 'Virgo' },
  { code: 'Vol', name: 'Volans' },
  { code: 'Vul', name: 'Vulpecula' },
];

if (CONSTELLATIONS.length !== 88) {
  throw new Error(`Expected 88 constellations, got ${CONSTELLATIONS.length}`);
}

const CON_INDEX: Map<string, number> = new Map(
  CONSTELLATIONS.map((c, i) => [c.code.toLowerCase(), i])
);

// HIPs that Stellarium's modern sky culture references but the underlying
// catalog does not carry 3D positions for. Every entry must include a
// human-readable reason so a future audit can decide whether upstream data
// has been fixed. `buildFigureLines` silently skips these; any other
// unmatched HIP is a hard build error.
const KNOWN_MISSING_HIPS: Map<number, string> = new Map([
  [5165, 'α Phoenicis (Ankaa) — HYG lacks parallax for this multiple-star system; upstream data gap'],
  [89341, 'μ Sagittarii (Polis) — HYG lacks parallax; upstream data gap'],
]);

// Curated visual-double systems that the CCDM+MultFlag filter (see
// parseHipCcdm) drops because Hipparcos's main catalogue modelled
// them as single stars (`MultFlag` blank, `Ncomp=1`). Each entry is a
// system: a list of HIPs (one or more components found in this
// catalog) plus a justification. parseHipCcdm groups these as
// synthetic CCDM systems so the primary-only flagging in
// applyDoublesFlag picks exactly one component per system.
//
// Visual review of new chart-mode renders may surface more — extend
// conservatively, only for systems where the pair is canonical enough
// to expect wings on the chart.
interface VisualDoubleSystem {
  components: number[]; // HIPs of components present in our catalog
  reason: string;
}
const KNOWN_VISUAL_DOUBLES: VisualDoubleSystem[] = [
  {
    components: [11767],
    reason: 'Polaris (α UMi) — Polaris B at sep ≈ 18″ is a real companion; Hipparcos modelled as Ncomp=1',
  },
  {
    components: [91971],
    reason: 'ε¹ Lyr — inner pair Aa+Ab at sep ≈ 2.4″; ε² Lyr (HIP 91926) carries MultFlag=C as the analogue',
  },
  {
    components: [104214, 104217],
    reason: '61 Cyg A/B — famous nearby K-dwarf pair at sep ≈ 30″ between HIP 104214 (A) and HIP 104217 (B)',
  },
];

// HIPs that appear anywhere in KNOWN_VISUAL_DOUBLES; pre-built once
// for fast membership checks during the CCDM file scan.
const KNOWN_VISUAL_DOUBLE_HIPS: Set<number> = new Set(
  KNOWN_VISUAL_DOUBLES.flatMap((s) => s.components),
);

function isUpToDate(): boolean {
  if (!existsSync(OUT_BIN) || !existsSync(OUT_CON) || !existsSync(OUT_SEARCH)) return false;
  const binMtime = statSync(OUT_BIN).mtimeMs;
  const srcMtime = statSync(SRC_CSV).mtimeMs;
  const stellariumMtime = existsSync(SRC_STELLARIUM)
    ? statSync(SRC_STELLARIUM).mtimeMs
    : 0;
  const gcvsMtime = existsSync(SRC_GCVS) ? statSync(SRC_GCVS).mtimeMs : 0;
  const xrefMtime = existsSync(SRC_GCVS_XREF) ? statSync(SRC_GCVS_XREF).mtimeMs : 0;
  const hipCcdmMtime = existsSync(SRC_HIP_CCDM) ? statSync(SRC_HIP_CCDM).mtimeMs : 0;
  const multiplesMtime = existsSync(SRC_MULTIPLES) ? statSync(SRC_MULTIPLES).mtimeMs : 0;
  const scriptMtime = statSync(__filename).mtimeMs;
  return (
    binMtime > srcMtime &&
    binMtime > scriptMtime &&
    binMtime > stellariumMtime &&
    binMtime > gcvsMtime &&
    binMtime > xrefMtime &&
    binMtime > hipCcdmMtime &&
    binMtime > multiplesMtime
  );
}

// GCVS variable-star catalogue parsing. We load two files:
//   - gcvs5.txt    : the main catalogue with period, max/min magnitudes,
//                    and variability type for each variable star (keyed by
//                    GCVS designation like "R And", "V0640 Cas").
//   - crossid.txt  : the cross-identification file that maps foreign
//                    catalogue IDs (Hip/HD/Tyc/SAO/etc.) to those GCVS
//                    designations.
// Together they let us cross-match most AT-HYG stars with HIP or HD to a
// GCVS entry and carry its period + amplitude into the binary.

interface VarStarData {
  periodDays: number;
  amplitudeMag: number;
}

// Both GCVS files (gcvs5.txt and crossid.txt) are pipe-delimited with
// trailing whitespace inside each cell. Yields per-line trimmed-field
// arrays. Callers are expected to gate on file existence before calling.
function* readPipeDelimited(path: string): Iterable<string[]> {
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    yield line.split('|').map((f) => f.trim());
  }
}

function parseGcvsMain(): Map<string, VarStarData> {
  const out = new Map<string, VarStarData>();
  for (const fields of readPipeDelimited(SRC_GCVS)) {
    // Expect ~22 fields; headers / malformed rows are shorter.
    if (fields.length < 12) continue;
    const name = normalizeGcvsName(fields[1] ?? '');
    if (!name) continue;
    const maxMag = parseGcvsNumber(fields[4] ?? '');
    const minMag = parseGcvsNumber(fields[5] ?? '');
    const periodDays = parseGcvsNumber(fields[10] ?? '');
    if (periodDays === null || periodDays <= 0) continue;
    if (maxMag === null || minMag === null) continue;
    const amp = minMag - maxMag; // min is dimmer (higher number) than max
    if (amp <= 0) continue;
    out.set(name, { periodDays, amplitudeMag: amp });
  }
  return out;
}

interface VarStarXref {
  byHip: Map<number, string>;
  byHd: Map<number, string>;
}

function parseGcvsCrossref(): VarStarXref {
  const byHip = new Map<number, string>();
  const byHd = new Map<number, string>();
  for (const fields of readPipeDelimited(SRC_GCVS_XREF)) {
    // Each line: "<CATALOG> <NUM>          | = <GCVS_NAME>  | | |"
    // We only care about Hip and HD since those are what AT-HYG carries.
    const leftRaw = fields[0] ?? '';
    const rightRaw = fields[1] ?? '';
    if (!leftRaw || !rightRaw) continue;

    // Left side examples: "Hip  000008", "HD   000015"
    const leftMatch = leftRaw.match(/^(\w+)\s+(\d+)/);
    if (!leftMatch) continue;
    const prefix = leftMatch[1].toLowerCase();
    if (prefix !== 'hip' && prefix !== 'hd') continue;
    const num = parseInt(leftMatch[2], 10);
    if (!Number.isFinite(num) || num <= 0) continue;

    // Right side: "=<GCVS_NAME>", strip the leading "=" and normalize.
    const rightMatch = rightRaw.match(/^=\s*(.+?)\s*$/);
    if (!rightMatch) continue;
    const gcvsName = normalizeGcvsName(rightMatch[1]);
    if (!gcvsName) continue;

    if (prefix === 'hip') byHip.set(num, gcvsName);
    else byHd.set(num, gcvsName);
  }
  return { byHip, byHd };
}

// Hipparcos main catalogue carries a CCDM cross-reference per star: the
// `CCDM` column is non-blank when the star is a component of a system in
// the Catalog of the Components of Double and Multiple stars (Dommanget &
// Nys 1994), the curated pre-WDS reference for visual doubles. CCDM alone
// is too permissive — it lumps physical doubles together with wide
// line-of-sight optical pairs (so Vega and Pollux end up tagged) — so we
// gate it with Hipparcos's own `MultFlag` column (H59):
//
//   C = component star in a Hipparcos-resolved system
//   G = double resolved within the Hipparcos field
//   O = orbit known (spectroscopic / astrometric)
//   blank, V, X = unconfirmed by Hipparcos's own astrometry
//
// Keeping `{C, G, O}` removes the bulk of CCDM optical pairs while
// preserving real binaries Hipparcos modelled. A handful of canonical
// visual doubles are still dropped this way (Polaris, ε¹ Lyr, 61 Cyg —
// wide pairs Hipparcos treated as single stars); KNOWN_VISUAL_DOUBLES
// recovers them.
//
// Expected file: VizieR TSV from
// `asu-tsv?-source=I/239/hip_main&-out=HIP,CCDM,MultFlag&-out.max=unlimited`.
// The parser tolerates VizieR's preamble (`#` comments, header row,
// dash-separator row, then data).

// Returns a map from CCDM_ID → list of component HIPs. Curated visual
// doubles are NOT included here — they live in KNOWN_VISUAL_DOUBLES and
// applyDoublesFlag unions both sources at flag time. Keeping them
// separate avoids minting synthetic CCDM keys that share a type with
// real CCDM IDs.
// Components in the same group are siblings of one system —
// applyDoublesFlag picks the brightest as the primary.
function parseHipCcdm(): Map<string, number[]> {
  const groups = new Map<string, number[]>();

  if (!existsSync(SRC_HIP_CCDM)) return groups;

  const text = readFileSync(SRC_HIP_CCDM, 'utf8');
  const rawLines = text.split(/\r?\n/);

  let header: string[] | null = null;
  let hipIdx = -1, ccdmIdx = -1, mfIdx = -1;
  let scanned = 0, kept = 0, viaOverride = 0;
  let droppedNoHip = 0, droppedNoCcdm = 0, droppedMultFlag = 0;

  for (const line of rawLines) {
    if (!line || !line.trim()) continue;
    if (line.startsWith('#')) continue;

    const cols = line.split('\t');
    // VizieR TSVs include a dash-separator row right after the header.
    if (cols.every((c) => /^[-\s]+$/.test(c) && c.includes('-'))) continue;

    if (!header) {
      header = cols.map((c) => c.trim());
      hipIdx = header.indexOf('HIP');
      ccdmIdx = header.indexOf('CCDM');
      mfIdx = header.indexOf('MultFlag');
      const missing: string[] = [];
      if (hipIdx < 0) missing.push('HIP');
      if (ccdmIdx < 0) missing.push('CCDM');
      if (mfIdx < 0) missing.push('MultFlag');
      if (missing.length) {
        throw new Error(
          `Hipparcos CCDM TSV is missing required columns: ${missing.join(', ')}.\n` +
            `  Header was: ${header.map((h) => JSON.stringify(h)).join(', ')}\n` +
            `  Re-fetch from VizieR with -out=HIP,CCDM,MultFlag.`,
        );
      }
      continue;
    }

    scanned++;
    const hipStr = (cols[hipIdx] ?? '').trim();
    if (!hipStr) { droppedNoHip++; continue; }
    const hip = parseInt(hipStr, 10);
    if (!Number.isFinite(hip) || hip <= 0) { droppedNoHip++; continue; }

    if (KNOWN_VISUAL_DOUBLE_HIPS.has(hip)) {
      viaOverride++;
      continue; // already in an OVERRIDE-* group
    }

    const ccdm = (cols[ccdmIdx] ?? '').trim();
    if (!ccdm) { droppedNoCcdm++; continue; }

    const mf = (cols[mfIdx] ?? '').trim();
    if (mf !== 'C' && mf !== 'G' && mf !== 'O') {
      droppedMultFlag++;
      continue;
    }

    const list = groups.get(ccdm);
    if (list) list.push(hip);
    else groups.set(ccdm, [hip]);
    kept++;
  }

  console.log(
    `  ${kept} HIPs via CCDM+MultFlag(C/G/O); ` +
      `${groups.size} systems total; ` +
      `${scanned} scanned, dropped ${droppedNoHip} no-HIP, ${droppedNoCcdm} blank CCDM, ${droppedMultFlag} unconfirmed MultFlag, ${viaOverride} skipped(in-override)`,
  );
  return groups;
}

// Parse data/multiples.tsv (emitted by scripts/build-binaries.py) into
// `MultipleOverrideRow[]`. Header row + tab-delimited body; the script
// guarantees the column order documented in OUTPUT_COLUMNS.
function parseMultiplesTsv(path: string): MultipleOverrideRow[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const out: MultipleOverrideRow[] = [];
  let header: string[] | null = null;
  let idxSys = -1, idxComp = -1, idxHip = -1, idxX = -1, idxY = -1, idxZ = -1;
  let idxAbs = -1, idxCi = -1, idxSpect = -1, idxName = -1, idxSrc = -1, idxReg = -1;

  for (const raw of lines) {
    if (!raw) continue;
    const cols = raw.split('\t');
    if (!header) {
      header = cols.map((c) => c.trim());
      idxSys = header.indexOf('system_id');
      idxComp = header.indexOf('comp');
      idxHip = header.indexOf('hip');
      idxX = header.indexOf('x_pc');
      idxY = header.indexOf('y_pc');
      idxZ = header.indexOf('z_pc');
      idxAbs = header.indexOf('absmag');
      idxCi = header.indexOf('ci');
      idxSpect = header.indexOf('spect');
      idxName = header.indexOf('name');
      idxSrc = header.indexOf('source');
      idxReg = header.indexOf('regime');
      const missing: string[] = [];
      for (const [i, n] of [
        [idxSys, 'system_id'], [idxComp, 'comp'], [idxHip, 'hip'],
        [idxX, 'x_pc'], [idxY, 'y_pc'], [idxZ, 'z_pc'],
        [idxAbs, 'absmag'], [idxCi, 'ci'], [idxSpect, 'spect'],
        [idxName, 'name'], [idxSrc, 'source'], [idxReg, 'regime'],
      ] as [number, string][]) {
        if (i < 0) missing.push(n);
      }
      if (missing.length) {
        throw new Error(
          `data/multiples.tsv missing required columns: ${missing.join(', ')}.\n` +
            `Re-run scripts/build-binaries.py to regenerate.`,
        );
      }
      continue;
    }
    if (cols.length < header.length) continue;
    const x = Number(cols[idxX]);
    const y = Number(cols[idxY]);
    const z = Number(cols[idxZ]);
    const absmag = Number(cols[idxAbs]);
    const ci = Number(cols[idxCi]);
    const regime = parseInt(cols[idxReg], 10);
    if (
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) ||
      !Number.isFinite(absmag) || !Number.isFinite(ci) || !Number.isFinite(regime)
    ) {
      continue;
    }
    out.push({
      systemId: cols[idxSys].trim(),
      comp: cols[idxComp].trim(),
      hipOrSyn: cols[idxHip].trim(),
      x, y, z, absmag, ci,
      spect: cols[idxSpect].trim(),
      name: cols[idxName].trim(),
      source: cols[idxSrc].trim(),
      regime,
    });
  }
  return out;
}

// Factory for SYN-NNN secondary rows: build a complete Star with no HIP,
// no GCVS lookup, no constellation membership. Matches the
// `applyMultipleOverridesPure` contract — the pure helper sets
// `fromOverride = true` after the factory returns.
function makeStarFromSynRow(row: MultipleOverrideRow): Star {
  const spectInfo = parseSpectral(row.spect);
  const physRadius = physicalRadius(row.absmag, spectInfo);
  const spectDisplay = row.spect
    ? row.spect.replace(/\*+$/, '').trim().replace(/\s+/g, ' ')
    : null;
  return {
    x: row.x, y: row.y, z: row.z,
    absmag: row.absmag, ci: row.ci,
    spectClass: spectInfo.classIdx,
    lumClass: spectInfo.lumClass,
    physicalRadius: physRadius,
    conIndex: 255,
    flags: row.name ? FLAG_HAS_NAME : 0,
    proper: row.name || null,
    bayer: null, hip: null, hd: null, hr: null, flam: null, gl: null,
    spectDisplay,
    companionIdx: -1,
    periodDays: 0,
    amplitudeMag: 0,
    fromOverride: false,
  };
}

// Format a per-regime tally (e.g. `{1: 28645, 2: 911}`) into a stable
// log-string like `r1=28645 r2=911 r3=0`. Empty buckets are shown so the
// log-line shape is stable across catalog drifts (zero is meaningful —
// "ORB6 fell off" is a regression-worthy signal).
function formatRegimeBreakdown(byRegime: Record<number, number>): string {
  return [1, 2, 3].map((r) => `r${r}=${byRegime[r] ?? 0}`).join(' ');
}

// Build the union of CCDM groups (parsed from Hipparcos) and the curated
// KNOWN_VISUAL_DOUBLES overrides, then delegate to the pure
// `applyDoublesFlag` helper. The pure helper handles the per-group
// "brightest in-catalog component, idempotent with existing flags" logic
// — see catalog-pure.ts for the contract.
function applyDoublesFlag(
  stars: Star[],
  ccdmGroups: Map<string, number[]>,
): { systems: number; flagged: number } {
  const allGroups: Iterable<Iterable<number>> = (function* () {
    yield* ccdmGroups.values();
    for (const sys of KNOWN_VISUAL_DOUBLES) yield sys.components;
  })();
  return applyDoublesFlagPure(stars, allGroups);
}

interface Star {
  x: number; y: number; z: number;
  absmag: number;
  ci: number;
  spectClass: number;
  lumClass: number;
  physicalRadius: number;  // solar radii
  conIndex: number;
  flags: number;
  proper: string | null;
  bayer: string | null;
  hip: number | null;
  hd: number | null;
  hr: number | null;
  flam: number | null;
  gl: string | null;
  spectDisplay: string | null; // cleaned-up spectral string for tooltip display
  companionIdx: number;     // assigned later in inferBinaries; -1 = none
  periodDays: number;       // 0 = not a variable known to GCVS
  amplitudeMag: number;     // 0 if not variable
  // Transient build-time marker set by `applyMultipleOverridesPure` on
  // any star this build touched or appended via data/multiples.tsv. After
  // the absmag sort, the caller derives a Set<number> of "protected"
  // indices and hands it to `inferBinaries` so the sub-threshold
  // safety-net drop only fires on AT-HYG-native artefacts.
  fromOverride: boolean;
}

function parseFloatOrNull(s: string | undefined | null): number | null {
  if (s === '' || s === undefined || s === null) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function parseIntOrNull(s: string | undefined | null): number | null {
  const v = parseFloatOrNull(s);
  return v === null ? null : Math.trunc(v);
}

function nonEmpty(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t ? t : null;
}

// Subset of AT-HYG v3.3 columns this build script reads. Every column we
// touch must be declared here; a typo on `row.foo` then becomes a compile
// error rather than a silent `undefined` that corrupts the binary.
// `cast: false` keeps every cell as a string; the parseFloat/parseInt
// helpers below normalise them.
interface AthygRow {
  x0: string; y0: string; z0: string;
  absmag: string;
  dist: string;
  ci: string;
  spect: string;
  con: string;
  proper: string;
  bayer: string;
  flam: string;
  hip: string;
  hd: string;
  hr: string;
  gl: string;
}

async function readStars(): Promise<{
  stars: Star[];
  stats: { total: number; dropped: Record<string, number> };
}> {
  const parser = createReadStream(SRC_CSV).pipe(
    parse({ columns: true, skip_empty_lines: true, cast: false })
  ) as AsyncIterable<AthygRow>;

  const stars: Star[] = [];
  const dropped: Record<string, number> = {
    noCoords: 0,
    noAbsmag: 0,
    tooFar: 0,
    unknownCon: 0,
  };
  let total = 0;

  for await (const row of parser) {
    total++;
    const x = parseFloatOrNull(row.x0);
    const y = parseFloatOrNull(row.y0);
    const z = parseFloatOrNull(row.z0);
    if (x === null || y === null || z === null) {
      dropped.noCoords++;
      continue;
    }
    const absmag = parseFloatOrNull(row.absmag);
    if (absmag === null) {
      dropped.noAbsmag++;
      continue;
    }
    const dist = parseFloatOrNull(row.dist);
    if (dist !== null && dist > MAX_DIST_PC) {
      dropped.tooFar++;
      continue;
    }
    const ci = parseFloatOrNull(row.ci) ?? DEFAULT_CI;

    const spectRaw = (row.spect ?? '').trim();
    const spectInfo = parseSpectral(spectRaw);
    const physRadius = physicalRadius(absmag, spectInfo);

    const conCode: string = (row.con ?? '').trim();
    let conIndex = 255;
    if (conCode) {
      const idx = CON_INDEX.get(conCode.toLowerCase());
      if (idx === undefined) {
        dropped.unknownCon++;
      } else {
        conIndex = idx;
      }
    }

    const proper = nonEmpty(row.proper);
    const bayer = nonEmpty(row.bayer);
    const flam = parseIntOrNull(row.flam);
    const hip = parseIntOrNull(row.hip);
    const hd = parseIntOrNull(row.hd);
    const hr = parseIntOrNull(row.hr);
    const gl = nonEmpty(row.gl);
    const spectDisplay = spectRaw
      ? spectRaw.replace(/\*+$/, '').trim().replace(/\s+/g, ' ')
      : null;

    const isSol = proper === 'Sol';
    let flags = 0;
    if (proper) flags |= FLAG_HAS_NAME;
    if (isSol) flags |= FLAG_IS_SOL;
    if (bayer) flags |= FLAG_HAS_BAYER;

    stars.push({
      x, y, z, absmag, ci,
      spectClass: spectInfo.classIdx,
      lumClass: spectInfo.lumClass,
      physicalRadius: physRadius,
      conIndex, flags,
      proper, bayer, hip, hd, hr, flam, gl,
      spectDisplay,
      companionIdx: -1,
      periodDays: 0,
      amplitudeMag: 0,
      fromOverride: false,
    });
  }

  return { stars, stats: { total, dropped } };
}

// Cross-match each star against GCVS via HIP (first) or HD (fallback). Most
// AT-HYG stars with a Hipparcos or HD designation that appears in GCVS will
// get period + amplitude here; stars without either ID, or whose cross-ref
// GCVS entry lacks a period (irregular variables, SN, etc.), stay at 0/0
// and won't pulse.
function applyVariability(
  stars: Star[],
  gcvsData: Map<string, VarStarData>,
  xref: VarStarXref,
): { matched: number } {
  let matched = 0;
  for (const s of stars) {
    let gcvsName: string | undefined;
    if (s.hip !== null) gcvsName = xref.byHip.get(s.hip);
    if (!gcvsName && s.hd !== null) gcvsName = xref.byHd.get(s.hd);
    if (!gcvsName) continue;
    const data = gcvsData.get(gcvsName);
    if (!data) continue;
    s.periodDays = data.periodDays;
    s.amplitudeMag = data.amplitudeMag;
    matched++;
  }
  return { matched };
}

// Extracts classical stick-figure lines per IAU constellation from
// Stellarium's modern sky culture `index.json`. Each polyline in the source
// is a list of HIP integers; we resolve each HIP to a record index via
// `hipToIndex`. Missing HIPs are a hard error unless in KNOWN_MISSING_HIPS —
// the whole point of using Stellarium data (vs. fuzzy RA/Dec match) is
// deterministic mapping.
function buildFigureLines(
  hipToIndex: Map<number, number>,
): Map<number, number[][]> {
  const raw = JSON.parse(readFileSync(SRC_STELLARIUM, 'utf8'));
  const source: Array<{ id: string; lines?: number[][] }> = raw.constellations ?? [];

  const out = new Map<number, number[][]>();
  const missing: Array<{ code: string; hip: number }> = [];

  for (const entry of source) {
    if (!entry.lines || entry.lines.length === 0) continue;
    const parts = entry.id.split(/\s+/);
    const code = parts[parts.length - 1];
    const conIndex = CON_INDEX.get(code.toLowerCase());
    if (conIndex === undefined) {
      throw new Error(`Stellarium constellation code not in IAU-88 table: ${code}`);
    }

    const resolved: number[][] = [];
    for (const polyline of entry.lines) {
      const starIndices: number[] = [];
      for (const hip of polyline) {
        const idx = hipToIndex.get(hip);
        if (idx === undefined) {
          if (!KNOWN_MISSING_HIPS.has(hip)) missing.push({ code, hip });
          continue;
        }
        starIndices.push(idx);
      }
      if (starIndices.length >= 2) resolved.push(starIndices);
    }
    if (resolved.length) out.set(conIndex, resolved);
  }

  if (missing.length) {
    const sample = missing.slice(0, 10).map((m) => `${m.code}/HIP ${m.hip}`);
    throw new Error(
      `Stellarium figures reference ${missing.length} HIP(s) not found in catalog and not in KNOWN_MISSING_HIPS. ` +
        `First ${sample.length}: ${sample.join(', ')}. ` +
        `If this is expected, add each HIP to KNOWN_MISSING_HIPS with a justification; otherwise investigate the data mismatch.`,
    );
  }

  return out;
}

async function main() {
  if (!existsSync(SRC_CSV)) {
    console.error(`Source CSV not found: ${SRC_CSV}`);
    process.exit(1);
  }
  if (!existsSync(SRC_STELLARIUM)) {
    console.error(`Stellarium sky culture JSON not found: ${SRC_STELLARIUM}`);
    process.exit(1);
  }

  if (isUpToDate()) {
    console.log('catalog.bin is up to date with source CSV; skipping rebuild.');
    return;
  }

  // Accumulator for the headline counts asserted against
  // scripts/build-catalog-expected.json at the end of the build
  // (stellata-9mm.183). Every field has a default so a code path that
  // legitimately skips a section (missing GCVS files, no Sol) doesn't
  // leave the field undefined.
  const counts: BuildCounts = {
    recordCount: 0,
    binaryPairs: 0,
    binaryMutualPairs: 0,
    gcvsEntries: 0,
    gcvsHipXrefs: 0,
    gcvsHdXrefs: 0,
    gcvsMatched: 0,
    ccdmGroups: 0,
    ccdmResolved: 0,
    ccdmFlagged: 0,
    nameTableEntries: 0,
    variableCount: 0,
    searchEntries: 0,
    solIndex: -1,
    figureCount: 0,
    figureConstellations: 0,
    multiplesHipOverrides: 0,
    multiplesSynInjected: 0,
    multiplesSubThresholdDropped: 0,
  };

  console.log(`Reading ${SRC_CSV}...`);
  const t0 = Date.now();
  const { stars, stats } = await readStars();
  console.log(`  parsed ${stats.total} rows in ${Date.now() - t0}ms`);
  console.log(`  kept ${stars.length} stars`);
  console.log(`  dropped:`, stats.dropped);

  // Apply multiple-star overrides emitted by scripts/build-binaries.py.
  // HIP rows relocate existing stars to WDS/ORB6-resolved positions; SYN
  // rows append new BinaryStars (Sirius B, Castor Aa1/Aa2, …). Sets a
  // transient `fromOverride` flag we use after the sort to build the
  // protected-index set passed to `inferBinaries`.
  if (existsSync(SRC_MULTIPLES)) {
    console.log('Applying multiple-star overrides from data/multiples.tsv...');
    const tMult = Date.now();
    const overrides = parseMultiplesTsv(SRC_MULTIPLES);
    const multStats = applyMultipleOverridesPure(stars, overrides, makeStarFromSynRow);
    console.log(
      `  ${multStats.hipOverridden} HIP overrides, ` +
        `${multStats.synInjected} SYN injected, ` +
        `${multStats.hipMissing} HIPs not in catalog; ` +
        `by regime: ${formatRegimeBreakdown(multStats.byRegime)} ` +
        `in ${Date.now() - tMult}ms`,
    );
    counts.multiplesHipOverrides = multStats.hipOverridden;
    counts.multiplesSynInjected = multStats.synInjected;
  } else {
    console.log('data/multiples.tsv not found; skipping multiple-star overrides.');
  }

  // Sort by absolute magnitude ascending (brightest first). Record indices
  // are final after this point (modulo `inferBinaries` sub-threshold
  // drops below).
  stars.sort((a, b) => a.absmag - b.absmag);

  // Build the protected-index set from the post-sort `fromOverride`
  // markers; `inferBinaries` uses this to gate the sub-threshold drop.
  const protectedIndices = new Set<number>();
  for (let i = 0; i < stars.length; i++) {
    if (stars[i].fromOverride) protectedIndices.add(i);
  }

  // Geometric binary inference. May drop sub-threshold AT-HYG-native
  // mutual pairs whose components are not in `protectedIndices` (safety
  // net for collapsed-parallax rows the multiples pipeline missed).
  console.log('Inferring binary/multiple systems...');
  const tBin = Date.now();
  const binStats = inferBinaries(stars, protectedIndices);
  console.log(
    `  ${binStats.pairs} companion assignments, ${binStats.mutualPairs} mutual pairs, ` +
      `${binStats.droppedSubThreshold} sub-threshold drops in ${Date.now() - tBin}ms`,
  );
  counts.binaryPairs = binStats.pairs;
  counts.binaryMutualPairs = binStats.mutualPairs;
  counts.multiplesSubThresholdDropped = binStats.droppedSubThreshold;
  counts.recordCount = stars.length;

  // Build HIP → record index map against the final post-sort, post-drop
  // order. Duplicate HIPs are rare (binary companions sharing an
  // identifier); keep the brightest.
  const hipToIndex = new Map<number, number>();
  for (let i = 0; i < stars.length; i++) {
    const h = stars[i].hip;
    if (h !== null && h > 0 && !hipToIndex.has(h)) hipToIndex.set(h, i);
  }

  // Resolve Stellarium stick-figure lines to star indices. Throws if any
  // referenced HIP is missing from the catalog.
  const figureLines = buildFigureLines(hipToIndex);

  // GCVS variable-star cross-match. Optional — if the files aren't present
  // we just skip, no variability rendered.
  if (existsSync(SRC_GCVS) && existsSync(SRC_GCVS_XREF)) {
    console.log('Parsing GCVS variable-star catalogue...');
    const tGcvs = Date.now();
    const gcvsData = parseGcvsMain();
    const xref = parseGcvsCrossref();
    const { matched } = applyVariability(stars, gcvsData, xref);
    console.log(
      `  ${gcvsData.size} GCVS entries, ${xref.byHip.size} Hip + ${xref.byHd.size} HD xrefs, ${matched} catalog stars matched in ${Date.now() - tGcvs}ms`,
    );
    counts.gcvsEntries = gcvsData.size;
    counts.gcvsHipXrefs = xref.byHip.size;
    counts.gcvsHdXrefs = xref.byHd.size;
    counts.gcvsMatched = matched;
  } else {
    console.log('GCVS files not found; skipping variability cross-match.');
  }

  // Hipparcos CCDM double-star cross-match. Optional. Marks a primary on
  // the same FLAG_BINARY_PRIMARY bit the geometric pass uses, picking
  // exactly one primary per CCDM system so chart-mode wings surface both
  // sources without double-flagging components of the same system.
  if (existsSync(SRC_HIP_CCDM)) {
    console.log('Parsing Hipparcos CCDM double-star cross-reference...');
    const tCcdm = Date.now();
    const ccdmGroups = parseHipCcdm();
    const { systems, flagged } = applyDoublesFlag(stars, ccdmGroups);
    console.log(
      `  ${ccdmGroups.size} CCDM systems → ${systems} resolved in catalog, ${flagged} new primaries flagged in ${Date.now() - tCcdm}ms`,
    );
    counts.ccdmGroups = ccdmGroups.size;
    counts.ccdmResolved = systems;
    counts.ccdmFlagged = flagged;
  } else {
    console.log('Hipparcos CCDM file not found; skipping double-star cross-match.');
  }

  // Build name table — just proper names. Bayer/Flam/HIP/etc. go in
  // search-index.json so the main binary stays compact.
  const encoder = new TextEncoder();
  const nameChunks: Uint8Array[] = [];
  const nameOffsets = new Uint32Array(stars.length);
  // Offset 0 is reserved as the "no name" sentinel. Real names start at
  // offset >= NAME_TABLE_PADDING after the leading zero-bytes.
  let nameTableLength = NAME_TABLE_PADDING;
  nameChunks.push(new Uint8Array(NAME_TABLE_PADDING));
  for (let i = 0; i < stars.length; i++) {
    if (!stars[i].proper) continue;
    const bytes = encoder.encode(stars[i].proper!);
    if (bytes.length > 0xffff) {
      throw new Error(`Name too long: ${stars[i].proper}`);
    }
    nameOffsets[i] = nameTableLength;
    const lenHeader = new Uint8Array(NAME_LENGTH_PREFIX_BYTES);
    new DataView(lenHeader.buffer).setUint16(0, bytes.length, true);
    nameChunks.push(lenHeader);
    nameChunks.push(bytes);
    nameTableLength += NAME_LENGTH_PREFIX_BYTES + bytes.length;
    counts.nameTableEntries++;
  }

  // Allocate output buffer.
  const recordsLength = stars.length * RECORD_SIZE;
  const totalLength = HEADER_SIZE + recordsLength + nameTableLength;
  const out = new ArrayBuffer(totalLength);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  // Header.
  const magicBytes = encoder.encode(MAGIC);
  bytes.set(magicBytes, HEADER_LAYOUT.magic);
  view.setUint32(HEADER_LAYOUT.version, BINARY_VERSION, true);
  view.setUint32(HEADER_LAYOUT.count, stars.length, true);
  view.setUint32(HEADER_LAYOUT.nameTableOffset, HEADER_SIZE + recordsLength, true);
  view.setUint32(HEADER_LAYOUT.nameTableLength, nameTableLength, true);

  // Records.
  let off = HEADER_SIZE;
  let solIndex = -1;
  let variableCount = 0;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    view.setFloat32(off + RECORD_LAYOUT.x, s.x, true);
    view.setFloat32(off + RECORD_LAYOUT.y, s.y, true);
    view.setFloat32(off + RECORD_LAYOUT.z, s.z, true);
    view.setFloat32(off + RECORD_LAYOUT.absmag, s.absmag, true);
    view.setFloat32(off + RECORD_LAYOUT.ci, s.ci, true);
    view.setFloat32(off + RECORD_LAYOUT.physRadius, s.physicalRadius, true);
    view.setUint32(off + RECORD_LAYOUT.companion, s.companionIdx >= 0 ? s.companionIdx : NO_COMPANION, true);
    view.setUint32(off + RECORD_LAYOUT.nameOffset, s.proper ? nameOffsets[i] : 0, true);
    view.setUint8(off + RECORD_LAYOUT.spectClass, s.spectClass);
    view.setUint8(off + RECORD_LAYOUT.lumClass, s.lumClass);
    view.setUint8(off + RECORD_LAYOUT.conIndex, s.conIndex);
    view.setUint8(off + RECORD_LAYOUT.flags, s.flags);
    // Variability: amplitude clamps at 12.75 mag (extreme Miras), period at
    // 6553 days (rare long-period symbiotics). Period = 0 is the shader's
    // "not variable" sentinel.
    if (s.periodDays > 0 && s.amplitudeMag > 0) {
      const ampUnits = Math.min(255, Math.max(0, Math.round(s.amplitudeMag * 20)));
      const periodUnits = Math.min(65535, Math.max(0, Math.round(s.periodDays * 10)));
      view.setUint8(off + RECORD_LAYOUT.ampUnits, ampUnits);
      view.setUint16(off + RECORD_LAYOUT.period, periodUnits, true);
      if (ampUnits > 0 && periodUnits > 0) variableCount++;
    } else {
      view.setUint8(off + RECORD_LAYOUT.ampUnits, 0);
      view.setUint16(off + RECORD_LAYOUT.period, 0, true);
    }
    view.setUint32(off + RECORD_LAYOUT.hip, s.hip ?? 0, true);
    if (s.flags & FLAG_IS_SOL) solIndex = i;
    off += RECORD_SIZE;
  }

  // Name table.
  for (const chunk of nameChunks) {
    bytes.set(chunk, off);
    off += chunk.length;
  }

  if (off !== totalLength) {
    throw new Error(`Size mismatch: wrote ${off}, expected ${totalLength}`);
  }

  await mkdir(dirname(OUT_BIN), { recursive: true });
  await writeFile(OUT_BIN, Buffer.from(out));

  // Constellations JSON (unchanged from v1 format).
  const constellationsOut = CONSTELLATIONS.map((c, idx) => {
    const lines = figureLines.get(idx);
    return lines ? { ...c, lines } : { ...c };
  });
  await writeFile(OUT_CON, JSON.stringify(constellationsOut) + '\n');

  // Search index — one entry per star with at least one identifier the user
  // might type. SearchEntry is the shared writer↔reader contract (see
  // catalog-pure.ts); keep field names there in sync.
  const searchEntries: SearchEntry[] = [];
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    if (!s.proper && !s.bayer && s.hip === null && s.hd === null && s.hr === null && s.flam === null && !s.gl) continue;
    const entry: SearchEntry = { i };
    if (s.proper) entry.p = s.proper;
    if (s.bayer) entry.b = s.bayer;
    if (s.flam !== null) entry.f = s.flam;
    if (s.hip !== null) entry.hip = s.hip;
    if (s.hd !== null) entry.hd = s.hd;
    if (s.hr !== null) entry.hr = s.hr;
    if (s.gl) entry.gl = s.gl;
    if (s.conIndex !== 255) entry.c = s.conIndex;
    if (s.spectDisplay) entry.s = s.spectDisplay;
    searchEntries.push(entry);
  }
  await writeFile(OUT_SEARCH, JSON.stringify(searchEntries) + '\n');

  const figureCount = [...figureLines.values()].reduce(
    (n, arr) => n + arr.length,
    0,
  );
  const mb = (totalLength / 1024 / 1024).toFixed(2);
  console.log(`Wrote ${OUT_BIN} (${mb} MB, ${stars.length} records, v${BINARY_VERSION})`);
  console.log(
    `Wrote ${OUT_CON} (${CONSTELLATIONS.length} constellations, ${figureCount} stick-figure polylines across ${figureLines.size})`,
  );
  const searchMb = (statSync(OUT_SEARCH).size / 1024 / 1024).toFixed(2);
  console.log(`Wrote ${OUT_SEARCH} (${searchEntries.length} searchable entries, ${searchMb} MB)`);
  if (solIndex >= 0) {
    console.log(
      `Sol at record index ${solIndex} (absmag=${stars[solIndex].absmag}, R=${stars[solIndex].physicalRadius.toFixed(3)} R☉)`,
    );
  } else {
    console.warn(`Warning: Sol not found in catalog.`);
  }

  counts.variableCount = variableCount;
  counts.searchEntries = searchEntries.length;
  counts.solIndex = solIndex;
  counts.figureCount = figureCount;
  counts.figureConstellations = figureLines.size;

  await assertOrUpdateBuildCounts(counts);
}

/** Compare actual build counts against the committed expected manifest
 *  (or refresh the manifest when run with UPDATE_BUILD_COUNTS=1).
 *  stellata-9mm.183 — replaces the per-PR eyeball smoke step on the
 *  build-catalog log lines with a programmatic assertion. */
async function assertOrUpdateBuildCounts(actual: BuildCounts): Promise<void> {
  const shouldUpdate = process.env.UPDATE_BUILD_COUNTS === '1';
  const expectedExists = existsSync(EXPECTED_COUNTS);

  if (shouldUpdate || !expectedExists) {
    await writeFile(EXPECTED_COUNTS, JSON.stringify(actual, null, 2) + '\n');
    console.log(
      `${shouldUpdate ? 'Updated' : 'Wrote initial'} ${EXPECTED_COUNTS}`,
    );
    return;
  }

  const expected = JSON.parse(readFileSync(EXPECTED_COUNTS, 'utf8')) as BuildCounts;
  const diff = compareBuildCounts(expected, actual);
  const report = formatCountDiff(diff);
  console.log(report);
  if (diff.some((d) => d.status === 'mismatch')) {
    console.error(
      `\nbuild-catalog count assertion failed. If the change is intentional,\n` +
      `refresh the snapshot with: UPDATE_BUILD_COUNTS=1 npm run build:catalog`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
