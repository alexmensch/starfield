import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLAG_HAS_NAME,
  HEADER_LAYOUT,
  RECORD_LAYOUT,
  HEADER_SIZE,
  RECORD_SIZE,
  NO_COMPANION,
  NO_ORBIT,
} from './catalog-pure';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BIN = resolve(ROOT, 'public/catalog.bin');
const CON = resolve(ROOT, 'public/constellations.json');

const buf = await readFile(BIN);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const view = new DataView(ab);

const magic = new TextDecoder().decode(new Uint8Array(ab, HEADER_LAYOUT.magic, 4));
const version = view.getUint32(HEADER_LAYOUT.version, true);
const count = view.getUint32(HEADER_LAYOUT.count, true);
const nameTableOffset = view.getUint32(HEADER_LAYOUT.nameTableOffset, true);
const nameTableLength = view.getUint32(HEADER_LAYOUT.nameTableLength, true);
const elementsOffset = view.getUint32(HEADER_LAYOUT.elementsOffset, true);
const elementsCount = view.getUint32(HEADER_LAYOUT.elementsCount, true);

console.log(`magic=${magic} version=${version} count=${count} RECORD_SIZE=${RECORD_SIZE}`);
console.log(`nameTableOffset=${nameTableOffset} nameTableLength=${nameTableLength}`);
console.log(`elementsOffset=${elementsOffset} elementsCount=${elementsCount}`);
console.log(`file size=${ab.byteLength}, expected=${HEADER_SIZE + count * RECORD_SIZE + nameTableLength}`);

const constellations = JSON.parse(await readFile(CON, 'utf-8'));

// Walk name table. First 2 bytes are reserved as the "no name" sentinel.
const nameAt = new Map<number, string>();
{
  const td = new TextDecoder('utf-8');
  let p = nameTableOffset + 2;
  const end = nameTableOffset + nameTableLength;
  while (p < end) {
    const relOff = p - nameTableOffset;
    const len = view.getUint16(p, true);
    p += 2;
    const name = td.decode(new Uint8Array(ab, p, len));
    nameAt.set(relOff, name);
    p += len;
  }
}

function readRecord(i: number) {
  const off = HEADER_SIZE + i * RECORD_SIZE;
  const flags = view.getUint8(off + RECORD_LAYOUT.flags);
  const nameOffset = view.getUint32(off + RECORD_LAYOUT.nameOffset, true);
  const name = flags & FLAG_HAS_NAME ? nameAt.get(nameOffset) : null;
  const comp = view.getUint32(off + RECORD_LAYOUT.companion, true);
  const conIdx = view.getUint8(off + RECORD_LAYOUT.conIndex);
  const hip = view.getUint32(off + RECORD_LAYOUT.hip, true);
  const orb = view.getUint32(off + RECORD_LAYOUT.orbitIdx, true);
  return {
    i,
    x: view.getFloat32(off + RECORD_LAYOUT.x, true),
    y: view.getFloat32(off + RECORD_LAYOUT.y, true),
    z: view.getFloat32(off + RECORD_LAYOUT.z, true),
    absmag: view.getFloat32(off + RECORD_LAYOUT.absmag, true),
    ci: view.getFloat32(off + RECORD_LAYOUT.ci, true),
    physicalRadius: view.getFloat32(off + RECORD_LAYOUT.physRadius, true),
    companion: comp === NO_COMPANION ? null : comp,
    spectClass: view.getUint8(off + RECORD_LAYOUT.spectClass),
    lumClass: view.getUint8(off + RECORD_LAYOUT.lumClass),
    conIndex: conIdx,
    flags: flags.toString(2).padStart(8, '0'),
    amplitudeMag: view.getUint8(off + RECORD_LAYOUT.ampUnits) * 0.05,
    periodDays: view.getUint16(off + RECORD_LAYOUT.period, true) * 0.1,
    hip: hip === 0 ? null : hip,
    orbitIdx: orb === NO_ORBIT ? null : orb,
    name,
    con: conIdx === 255 ? null : constellations[conIdx]?.code,
  };
}

console.log('\nBrightest 5 records (by absmag):');
for (let i = 0; i < 5; i++) console.log(readRecord(i));

console.log('\nDimmest 3 records:');
for (let i = count - 3; i < count; i++) console.log(readRecord(i));

console.log('\nSearch for Sirius / Sol / Betelgeuse / Rigil Kentaurus / Toliman:');
const targets = new Set(['Sirius', 'Sol', 'Betelgeuse', 'Rigil Kentaurus', 'Toliman']);
let founds = 0;
for (let i = 0; i < count && founds < targets.size; i++) {
  const r = readRecord(i);
  if (r.name && targets.has(r.name)) {
    const dist = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    console.log({ ...r, dist_pc: dist.toFixed(3) });
    founds++;
  }
}

console.log('\nVariable star count and 5 examples:');
let varCount = 0;
const varSamples: ReturnType<typeof readRecord>[] = [];
for (let i = 0; i < count; i++) {
  const r = readRecord(i);
  if (r.periodDays > 0) {
    varCount++;
    if (r.name && varSamples.length < 5) varSamples.push(r);
  }
}
console.log(`  ${varCount} variable stars`);
for (const r of varSamples) console.log(`    ${r.name}: P=${r.periodDays.toFixed(2)}d, A=${r.amplitudeMag.toFixed(2)}mag (${r.con})`);
