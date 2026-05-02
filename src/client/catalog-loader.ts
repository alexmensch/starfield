export interface Constellation {
  code: string;
  name: string;
  // Classical stick-figure polylines, each a list of star indices into the
  // catalog record array. Populated by the build step from Stellarium's
  // modern sky culture; absent for constellations with no asterism lines.
  lines?: number[][];
}

export interface Catalog {
  count: number;
  positions: Float32Array;       // length = count * 3
  absmag: Float32Array;          // length = count
  ci: Float32Array;              // length = count
  spectClass: Float32Array;      // length = count (as float for vertex attrib)
  luminosityClass: Uint8Array;   // length = count, 255 = unknown
  physicalRadius: Float32Array;  // length = count, in solar radii
  constellation: Float32Array;   // length = count (as float for vertex attrib)
  flags: Uint8Array;             // length = count (bit 0 has_name, 1 is_sol, 2 has_bayer, 4 is_binary_primary)
  companion: Int32Array;         // length = count, -1 = no companion
  periodDays: Float32Array;      // length = count, 0 = not variable
  amplitudeMag: Float32Array;    // length = count, 0 = not variable
  hip: Uint32Array;              // length = count, 0 = no HIP
  names: Map<number, string>;    // star index -> proper name (named stars only)
  solIndex: number;              // -1 if not found
  constellations: Constellation[];
}

const HEADER_SIZE = 32;
const RECORD_SIZE = 44;
const EXPECTED_VERSION = 4;
const EXPECTED_MAGIC = 'HYG4';
const NO_COMPANION = 0xffffffff;

export interface LoadProgress {
  bytes: number;
  total: number | null;
}

export async function loadCatalog(
  binUrl: string,
  conUrl: string,
  onProgress?: (p: LoadProgress) => void,
): Promise<Catalog> {
  const [binBuf, constellations] = await Promise.all([
    fetchBinary(binUrl, onProgress),
    fetch(conUrl).then((r) => r.json() as Promise<Constellation[]>),
  ]);

  return parseBinary(binBuf, constellations);
}

async function fetchBinary(
  url: string,
  onProgress?: (p: LoadProgress) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);

  const totalHeader = res.headers.get('Content-Length');
  const total = totalHeader ? Number(totalHeader) : null;

  if (!res.body || !onProgress) {
    return res.arrayBuffer();
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.byteLength;
    onProgress({ bytes, total });
  }
  const out = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

export function parseBinary(ab: ArrayBuffer, constellations: Constellation[]): Catalog {
  const view = new DataView(ab);
  const magic = new TextDecoder().decode(new Uint8Array(ab, 0, 4));
  if (magic !== EXPECTED_MAGIC) throw new Error(`Bad magic: ${magic}`);
  const version = view.getUint32(4, true);
  if (version !== EXPECTED_VERSION) {
    throw new Error(`Unsupported catalog version: ${version} (expected ${EXPECTED_VERSION})`);
  }
  const count = view.getUint32(8, true);
  const nameTableOffset = view.getUint32(12, true);
  const nameTableLength = view.getUint32(16, true);

  const positions = new Float32Array(count * 3);
  const absmag = new Float32Array(count);
  const ci = new Float32Array(count);
  const physicalRadius = new Float32Array(count);
  const spectClass = new Float32Array(count);
  const luminosityClass = new Uint8Array(count);
  const constellation = new Float32Array(count);
  const flags = new Uint8Array(count);
  const companion = new Int32Array(count);
  const periodDays = new Float32Array(count);
  const amplitudeMag = new Float32Array(count);
  const hip = new Uint32Array(count);
  const nameOffsetArr = new Uint32Array(count);

  let solIndex = -1;
  for (let i = 0; i < count; i++) {
    const off = HEADER_SIZE + i * RECORD_SIZE;
    positions[i * 3 + 0] = view.getFloat32(off + 0, true);
    positions[i * 3 + 1] = view.getFloat32(off + 4, true);
    positions[i * 3 + 2] = view.getFloat32(off + 8, true);
    absmag[i] = view.getFloat32(off + 12, true);
    ci[i] = view.getFloat32(off + 16, true);
    physicalRadius[i] = view.getFloat32(off + 20, true);
    const comp = view.getUint32(off + 24, true);
    companion[i] = comp === NO_COMPANION ? -1 : comp;
    nameOffsetArr[i] = view.getUint32(off + 28, true);
    spectClass[i] = view.getUint8(off + 32);
    luminosityClass[i] = view.getUint8(off + 33);
    constellation[i] = view.getUint8(off + 34);
    flags[i] = view.getUint8(off + 35);
    // Variability (v3): amplitude in 0.05 mag units, period in 0.1 days.
    // Zero period = not a known variable.
    amplitudeMag[i] = view.getUint8(off + 36) * 0.05;
    periodDays[i] = view.getUint16(off + 38, true) * 0.1;
    hip[i] = view.getUint32(off + 40, true);
    if (flags[i] & 0x02) solIndex = i;
  }

  const names = new Map<number, string>();
  if (nameTableLength > 0) {
    const td = new TextDecoder('utf-8');
    const nameData = new Uint8Array(ab, nameTableOffset, nameTableLength);
    const ntView = new DataView(ab, nameTableOffset, nameTableLength);
    const offsetToName = new Map<number, string>();
    // Offset 0 is reserved as the "no name" sentinel and contains two zero
    // bytes of padding — skip past it.
    let p = 2;
    while (p < nameTableLength) {
      const len = ntView.getUint16(p, true);
      const nameOffset = p;
      p += 2;
      const name = td.decode(nameData.subarray(p, p + len));
      offsetToName.set(nameOffset, name);
      p += len;
    }
    for (let i = 0; i < count; i++) {
      if (flags[i] & 0x01) {
        const name = offsetToName.get(nameOffsetArr[i]);
        if (name) names.set(i, name);
      }
    }
  }

  return {
    count,
    positions,
    absmag,
    ci,
    spectClass,
    luminosityClass,
    physicalRadius,
    constellation,
    flags,
    companion,
    periodDays,
    amplitudeMag,
    hip,
    names,
    solIndex,
    constellations,
  };
}
