import { createReadStream, statSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const SRC_CSV = resolve(ROOT, 'data/hyglike_from_athyg_v33.csv');
const OUT_BIN = resolve(ROOT, 'public/catalog.bin');
const OUT_CON = resolve(ROOT, 'public/constellations.json');

const MAX_DIST_PC = 50_000;
const DEFAULT_CI = 0.65;

const HEADER_SIZE = 32;
const RECORD_SIZE = 32;

// 88 IAU constellations, ordered alphabetically (case-insensitive) by 3-letter code.
// The array index is the uint8 written to each star record.
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

function spectClassIndex(spect: string): number {
  if (!spect) return 8;
  const c = spect.charAt(0).toUpperCase();
  switch (c) {
    case 'O': return 0;
    case 'B': return 1;
    case 'A': return 2;
    case 'F': return 3;
    case 'G': return 4;
    case 'K': return 5;
    case 'M': return 6;
    case 'C': case 'S': case 'W': return 7;
    default: return 8;
  }
}

function isUpToDate(): boolean {
  if (!existsSync(OUT_BIN) || !existsSync(OUT_CON)) return false;
  const binMtime = statSync(OUT_BIN).mtimeMs;
  const srcMtime = statSync(SRC_CSV).mtimeMs;
  const scriptMtime = statSync(__filename).mtimeMs;
  return binMtime > srcMtime && binMtime > scriptMtime;
}

interface Star {
  x: number; y: number; z: number;
  absmag: number;
  ci: number;
  spectClass: number;
  conIndex: number;
  flags: number;
  name: string | null;
}

function parseFloatOrNull(s: string): number | null {
  if (s === '' || s === undefined) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

async function readStars(): Promise<{
  stars: Star[];
  stats: { total: number; dropped: Record<string, number> };
}> {
  const parser = createReadStream(SRC_CSV).pipe(
    parse({ columns: true, skip_empty_lines: true, cast: false })
  );

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
    const x = parseFloatOrNull(row.x);
    const y = parseFloatOrNull(row.y);
    const z = parseFloatOrNull(row.z);
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
    const spectClass = spectClassIndex(row.spect ?? '');
    const conCode: string = (row.con ?? '').trim();
    let conIndex = 255;
    if (conCode) {
      const idx = CON_INDEX.get(conCode.toLowerCase());
      if (idx === undefined) {
        dropped.unknownCon++;
        // keep the star, just record it as "none"
      } else {
        conIndex = idx;
      }
    }
    const proper: string = (row.proper ?? '').trim();
    const name = proper || null;
    const isSol = proper === 'Sol';
    let flags = 0;
    if (name) flags |= 0x01;
    if (isSol) flags |= 0x02;

    stars.push({ x, y, z, absmag, ci, spectClass, conIndex, flags, name });
  }

  return { stars, stats: { total, dropped } };
}

async function main() {
  if (!existsSync(SRC_CSV)) {
    console.error(`Source CSV not found: ${SRC_CSV}`);
    process.exit(1);
  }

  if (isUpToDate()) {
    console.log('catalog.bin is up to date with source CSV; skipping rebuild.');
    return;
  }

  console.log(`Reading ${SRC_CSV}...`);
  const t0 = Date.now();
  const { stars, stats } = await readStars();
  console.log(`  parsed ${stats.total} rows in ${Date.now() - t0}ms`);
  console.log(`  kept ${stars.length} stars`);
  console.log(`  dropped:`, stats.dropped);

  // Sort by absolute magnitude ascending (brightest first).
  stars.sort((a, b) => a.absmag - b.absmag);

  // Build name table.
  const encoder = new TextEncoder();
  const nameChunks: Uint8Array[] = [];
  const nameOffsets = new Uint32Array(stars.length);
  let nameTableLength = 0;
  for (let i = 0; i < stars.length; i++) {
    if (!stars[i].name) continue;
    const bytes = encoder.encode(stars[i].name!);
    if (bytes.length > 0xffff) {
      throw new Error(`Name too long: ${stars[i].name}`);
    }
    nameOffsets[i] = nameTableLength;
    const lenHeader = new Uint8Array(2);
    new DataView(lenHeader.buffer).setUint16(0, bytes.length, true);
    nameChunks.push(lenHeader);
    nameChunks.push(bytes);
    nameTableLength += 2 + bytes.length;
  }

  // Allocate output buffer.
  const recordsLength = stars.length * RECORD_SIZE;
  const totalLength = HEADER_SIZE + recordsLength + nameTableLength;
  const out = new ArrayBuffer(totalLength);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  // Header.
  const magicBytes = encoder.encode('HYG3');
  bytes.set(magicBytes, 0);
  view.setUint32(4, 1, true); // version
  view.setUint32(8, stars.length, true); // count
  view.setUint32(12, HEADER_SIZE + recordsLength, true); // nameTableOffset
  view.setUint32(16, nameTableLength, true); // nameTableLength
  // bytes 20-31: reserved, already zero.

  // Records.
  let off = HEADER_SIZE;
  let solIndex = -1;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    view.setFloat32(off + 0, s.x, true);
    view.setFloat32(off + 4, s.y, true);
    view.setFloat32(off + 8, s.z, true);
    view.setFloat32(off + 12, s.absmag, true);
    view.setFloat32(off + 16, s.ci, true);
    view.setUint8(off + 20, s.spectClass);
    view.setUint8(off + 21, s.conIndex);
    view.setUint8(off + 22, s.flags);
    // off + 23: _pad
    view.setUint32(off + 24, s.name ? nameOffsets[i] : 0, true);
    // off + 28..31: reserved (alignment to 32-byte stride)
    if (s.flags & 0x02) solIndex = i;
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

  await writeFile(OUT_BIN, Buffer.from(out));
  await writeFile(
    OUT_CON,
    JSON.stringify(CONSTELLATIONS, null, 2) + '\n'
  );

  const mb = (totalLength / 1024 / 1024).toFixed(2);
  console.log(`Wrote ${OUT_BIN} (${mb} MB, ${stars.length} records)`);
  console.log(`Wrote ${OUT_CON} (${CONSTELLATIONS.length} constellations)`);
  if (solIndex >= 0) {
    console.log(`Sol at record index ${solIndex} (absmag=${stars[solIndex].absmag})`);
  } else {
    console.warn(`Warning: Sol not found in catalog.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
