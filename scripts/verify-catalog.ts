import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BIN = resolve(ROOT, 'public/catalog.bin');
const CON = resolve(ROOT, 'public/constellations.json');

const HEADER_SIZE = 32;
const RECORD_SIZE = 32;

const buf = await readFile(BIN);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const view = new DataView(ab);

const magic = new TextDecoder().decode(new Uint8Array(ab, 0, 4));
const version = view.getUint32(4, true);
const count = view.getUint32(8, true);
const nameTableOffset = view.getUint32(12, true);
const nameTableLength = view.getUint32(16, true);

console.log(`magic=${magic} version=${version} count=${count}`);
console.log(`nameTableOffset=${nameTableOffset} nameTableLength=${nameTableLength}`);
console.log(`file size=${ab.byteLength}, expected=${HEADER_SIZE + count * RECORD_SIZE + nameTableLength}`);

const constellations = JSON.parse(await readFile(CON, 'utf-8'));

// Walk name table to build offset -> name map.
const nameAt = new Map<number, string>();
{
  const td = new TextDecoder('utf-8');
  let p = nameTableOffset;
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
  const flags = view.getUint8(off + 22);
  const nameOffset = view.getUint32(off + 24, true);
  const name = flags & 0x01 ? nameAt.get(nameOffset) : null;
  return {
    i,
    x: view.getFloat32(off + 0, true),
    y: view.getFloat32(off + 4, true),
    z: view.getFloat32(off + 8, true),
    absmag: view.getFloat32(off + 12, true),
    ci: view.getFloat32(off + 16, true),
    spectClass: view.getUint8(off + 20),
    conIndex: view.getUint8(off + 21),
    flags,
    name,
    con: view.getUint8(off + 21) === 255 ? null : constellations[view.getUint8(off + 21)],
  };
}

console.log('\nBrightest 5 records (by absmag):');
for (let i = 0; i < 5; i++) console.log(readRecord(i));

console.log('\nDimmest 3 records:');
for (let i = count - 3; i < count; i++) console.log(readRecord(i));

console.log('\nSearch for Sirius / Sol / Betelgeuse:');
let founds = 0;
for (let i = 0; i < count && founds < 3; i++) {
  const r = readRecord(i);
  if (r.name === 'Sirius' || r.name === 'Sol' || r.name === 'Betelgeuse') {
    const dist = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
    console.log({ ...r, dist_pc: dist.toFixed(3) });
    founds++;
  }
}
