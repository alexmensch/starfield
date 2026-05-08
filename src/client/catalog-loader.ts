import {
  FLAG_HAS_NAME,
  FLAG_IS_SOL,
  HEADER_LAYOUT,
  RECORD_LAYOUT,
  HEADER_SIZE,
  RECORD_SIZE,
  BINARY_VERSION,
  MAGIC,
  NO_COMPANION,
} from '../../scripts/catalog-pure';

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
  // bit 0 has_name, 1 is_sol, 2 has_bayer, 4 is_binary_primary.
  // is_binary_primary is set on at most one component per system —
  // the brighter member of a mutual geometric pair, or the brightest
  // catalog component of a CCDM-grouped Hipparcos double — so each
  // binary system gets exactly one chart-mode wings glyph.
  flags: Uint8Array;             // length = count
  companion: Int32Array;         // length = count, -1 = no companion
  periodDays: Float32Array;      // length = count, 0 = not variable
  amplitudeMag: Float32Array;    // length = count, 0 = not variable
  hip: Uint32Array;              // length = count, 0 = no HIP
  names: Map<number, string>;    // star index -> proper name (named stars only)
  solIndex: number;              // -1 if not found
  constellations: Constellation[];
}

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
  const magic = new TextDecoder().decode(new Uint8Array(ab, HEADER_LAYOUT.magic, 4));
  if (magic !== MAGIC) throw new Error(`Bad magic: ${magic}`);
  const version = view.getUint32(HEADER_LAYOUT.version, true);
  if (version !== BINARY_VERSION) {
    throw new Error(`Unsupported catalog version: ${version} (expected ${BINARY_VERSION})`);
  }
  const count = view.getUint32(HEADER_LAYOUT.count, true);
  const nameTableOffset = view.getUint32(HEADER_LAYOUT.nameTableOffset, true);
  const nameTableLength = view.getUint32(HEADER_LAYOUT.nameTableLength, true);

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
    positions[i * 3 + 0] = view.getFloat32(off + RECORD_LAYOUT.x, true);
    positions[i * 3 + 1] = view.getFloat32(off + RECORD_LAYOUT.y, true);
    positions[i * 3 + 2] = view.getFloat32(off + RECORD_LAYOUT.z, true);
    absmag[i] = view.getFloat32(off + RECORD_LAYOUT.absmag, true);
    ci[i] = view.getFloat32(off + RECORD_LAYOUT.ci, true);
    physicalRadius[i] = view.getFloat32(off + RECORD_LAYOUT.physRadius, true);
    const comp = view.getUint32(off + RECORD_LAYOUT.companion, true);
    companion[i] = comp === NO_COMPANION ? -1 : comp;
    nameOffsetArr[i] = view.getUint32(off + RECORD_LAYOUT.nameOffset, true);
    spectClass[i] = view.getUint8(off + RECORD_LAYOUT.spectClass);
    luminosityClass[i] = view.getUint8(off + RECORD_LAYOUT.lumClass);
    constellation[i] = view.getUint8(off + RECORD_LAYOUT.conIndex);
    flags[i] = view.getUint8(off + RECORD_LAYOUT.flags);
    amplitudeMag[i] = view.getUint8(off + RECORD_LAYOUT.ampUnits) * 0.05;
    periodDays[i] = view.getUint16(off + RECORD_LAYOUT.period, true) * 0.1;
    hip[i] = view.getUint32(off + RECORD_LAYOUT.hip, true);
    if (flags[i] & FLAG_IS_SOL) solIndex = i;
  }

  const names = new Map<number, string>();
  if (nameTableLength > 0) {
    const td = new TextDecoder('utf-8');
    const nameData = new Uint8Array(ab, nameTableOffset, nameTableLength);
    const ntView = new DataView(ab, nameTableOffset, nameTableLength);
    const offsetToName = new Map<number, string>();
    // Offset 0 is reserved as the "no name" sentinel and contains two zero
    // bytes of padding — skip past it. (Allows nameOffset=0 to mean "no
    // name" without colliding with a real entry stored at byte 0.)
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
      if (flags[i] & FLAG_HAS_NAME) {
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
