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
  ORBITAL_LAYOUT,
  ORBITAL_RECORD_SIZE,
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
const expectedSize = HEADER_SIZE + count * RECORD_SIZE + nameTableLength + elementsCount * ORBITAL_RECORD_SIZE;
console.log(`file size=${ab.byteLength}, expected=${expectedSize}`);

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

// Orbital-elements section dump: count + first 5 rows decoded, plus
// famous-system spot-checks (Sirius A+B, α Cen A+B, Algol) so a build
// regression in the WDS+ORB6 cross-match is visible at a glance.
function readOrbit(rowIdx: number) {
  const off = elementsOffset + rowIdx * ORBITAL_RECORD_SIZE;
  return {
    rowIdx,
    P_days: view.getFloat32(off + ORBITAL_LAYOUT.P, true),
    T_jde: view.getFloat32(off + ORBITAL_LAYOUT.T, true),
    e: view.getFloat32(off + ORBITAL_LAYOUT.e, true),
    a_AU: view.getFloat32(off + ORBITAL_LAYOUT.a, true),
    q: view.getFloat32(off + ORBITAL_LAYOUT.q, true),
    i_rad: view.getFloat32(off + ORBITAL_LAYOUT.i, true),
    omega_rad: view.getFloat32(off + ORBITAL_LAYOUT.omega, true),
    Omega_rad: view.getFloat32(off + ORBITAL_LAYOUT.Omega, true),
    dist_pc: view.getFloat32(off + ORBITAL_LAYOUT.dist, true),
  };
}

console.log(`\nOrbital-elements section: ${elementsCount} rows`);
console.log('First 3 rows:');
for (let i = 0; i < Math.min(3, elementsCount); i++) console.log(readOrbit(i));

console.log('\nFamous-system orbital fits (matched by name + orbitIdx):');
const orbitNamed = new Set(['Sirius', 'Sirius B', 'Rigil Kentaurus', 'Toliman', 'Algol']);
for (let i = 0; i < count; i++) {
  const r = readRecord(i);
  if (r.name && orbitNamed.has(r.name) && r.orbitIdx !== null) {
    const o = readOrbit(r.orbitIdx);
    const P_yr = o.P_days / 365.25;
    console.log(`  ${r.name.padEnd(10)} orbit row=${r.orbitIdx} P=${o.P_days.toFixed(2)}d (${P_yr.toFixed(3)}yr) e=${o.e.toFixed(3)} a=${o.a_AU.toFixed(2)}AU q=${o.q.toFixed(3)}  flags=${r.flags}`);
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
