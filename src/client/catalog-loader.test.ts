import { describe, it, expect } from 'vitest';
import { parseBinary, type Constellation } from './catalog-loader';
import {
  FLAG_HAS_NAME,
  FLAG_IS_SOL,
  FLAG_HAS_BAYER,
  FLAG_BINARY_PRIMARY,
  HEADER_LAYOUT,
  RECORD_LAYOUT,
  HEADER_SIZE,
  RECORD_SIZE,
  MAGIC,
  BINARY_VERSION,
  NO_ORBIT,
} from '../../scripts/catalog-pure';

interface StarRecord {
  pos: [number, number, number];
  absmag: number;
  ci: number;
  physicalRadius: number;
  companion: number;       // 0xffffffff = none
  nameOffset: number;      // 0 = none (sentinel)
  spectClass: number;      // 0..255
  luminosityClass: number; // 0..255 (255 = unknown)
  constellation: number;   // 0..87
  flags: number;           // bit 0 has_name, 1 is_sol, 2 has_bayer, 4 binary primary, 5 binary secondary
  amplitudeRaw: number;    // uint8 (×0.05 to get magnitudes)
  periodRaw: number;       // uint16 (×0.1 to get days)
  hip: number;             // 0 = none
  orbitIdx: number;        // 0xFFFFFFFF = NO_ORBIT
}

// Build a synthetic catalog buffer matching the v5 format. Tests construct
// the smallest reasonable catalogs (a few stars + optional name table) so
// the parser sees realistic input without needing the real ~13 MB
// catalog.bin on disk. The orbital-elements section is left empty;
// `elementsOffset` points just past the name table.
function buildCatalog(
  records: StarRecord[],
  names: { offset: number; name: string }[] = [],
): ArrayBuffer {
  // Name table layout: 2 bytes of zero padding (offset-0 sentinel),
  // then for each name: uint16 length, then UTF-8 bytes.
  const enc = new TextEncoder();
  const encodedNames = names.map(n => ({ ...n, bytes: enc.encode(n.name) }));
  let nameTableLength = 2;
  for (const n of encodedNames) nameTableLength += 2 + n.bytes.length;

  const total = HEADER_SIZE + records.length * RECORD_SIZE
    + (encodedNames.length > 0 ? nameTableLength : 0);
  const ab = new ArrayBuffer(total);
  const dv = new DataView(ab);
  const u8 = new Uint8Array(ab);

  // Header
  for (let i = 0; i < 4; i++) u8[HEADER_LAYOUT.magic + i] = MAGIC.charCodeAt(i);
  dv.setUint32(HEADER_LAYOUT.version, BINARY_VERSION, true);
  dv.setUint32(HEADER_LAYOUT.count, records.length, true);
  const nameTableOffset = encodedNames.length > 0
    ? HEADER_SIZE + records.length * RECORD_SIZE
    : 0;
  dv.setUint32(HEADER_LAYOUT.nameTableOffset, nameTableOffset, true);
  dv.setUint32(HEADER_LAYOUT.nameTableLength, encodedNames.length > 0 ? nameTableLength : 0, true);
  const elementsOffset = HEADER_SIZE + records.length * RECORD_SIZE
    + (encodedNames.length > 0 ? nameTableLength : 0);
  dv.setUint32(HEADER_LAYOUT.elementsOffset, elementsOffset, true);
  dv.setUint32(HEADER_LAYOUT.elementsCount, 0, true);

  // Records
  records.forEach((r, i) => {
    const off = HEADER_SIZE + i * RECORD_SIZE;
    dv.setFloat32(off + RECORD_LAYOUT.x, r.pos[0], true);
    dv.setFloat32(off + RECORD_LAYOUT.y, r.pos[1], true);
    dv.setFloat32(off + RECORD_LAYOUT.z, r.pos[2], true);
    dv.setFloat32(off + RECORD_LAYOUT.absmag, r.absmag, true);
    dv.setFloat32(off + RECORD_LAYOUT.ci, r.ci, true);
    dv.setFloat32(off + RECORD_LAYOUT.physRadius, r.physicalRadius, true);
    dv.setUint32(off + RECORD_LAYOUT.companion, r.companion >>> 0, true);
    dv.setUint32(off + RECORD_LAYOUT.nameOffset, r.nameOffset >>> 0, true);
    dv.setUint8(off + RECORD_LAYOUT.spectClass, r.spectClass);
    dv.setUint8(off + RECORD_LAYOUT.lumClass, r.luminosityClass);
    dv.setUint8(off + RECORD_LAYOUT.conIndex, r.constellation);
    dv.setUint8(off + RECORD_LAYOUT.flags, r.flags);
    dv.setUint8(off + RECORD_LAYOUT.ampUnits, r.amplitudeRaw);
    dv.setUint16(off + RECORD_LAYOUT.period, r.periodRaw, true);
    dv.setUint32(off + RECORD_LAYOUT.hip, r.hip, true);
    dv.setUint32(off + RECORD_LAYOUT.orbitIdx, r.orbitIdx >>> 0, true);
  });

  // Name table (after records)
  if (encodedNames.length > 0) {
    let p = nameTableOffset + 2; // skip 2-byte zero-sentinel padding
    for (const n of encodedNames) {
      // The record's nameOffset must equal `p` (the offset of the length
      // prefix relative to the name-table start, which is what parseBinary
      // expects since it indexes into ntView)
      // Wait — re-read parseBinary: it stores p (nameOffset) before
      // advancing past the length prefix. Tests pass that same value
      // through StarRecord.nameOffset.
      dv.setUint16(p, n.bytes.length, true);
      u8.set(n.bytes, p + 2);
      p += 2 + n.bytes.length;
    }
  }

  return ab;
}

// Convenience for building name-table entries with computed offsets.
// Returns the offset (relative to the name-table start, which is what
// parseBinary stores) that should go in StarRecord.nameOffset.
function nameTableOffsets(names: string[]): number[] {
  const enc = new TextEncoder();
  const offsets: number[] = [];
  let p = 2; // skip the 2-byte zero-sentinel padding at table start
  for (const n of names) {
    offsets.push(p);
    p += 2 + enc.encode(n).length;
  }
  return offsets;
}

const blankConstellations: Constellation[] = [];

const baseStar: StarRecord = {
  pos: [0, 0, 0],
  absmag: 0,
  ci: 0,
  physicalRadius: 1,
  companion: 0xffffffff,
  nameOffset: 0,
  spectClass: 0,
  luminosityClass: 255,
  constellation: 0,
  flags: 0,
  amplitudeRaw: 0,
  periodRaw: 0,
  hip: 0,
  orbitIdx: NO_ORBIT,
};

describe('catalog-loader / parseBinary', () => {
  describe('header validation', () => {
    it('rejects buffer with bad magic', () => {
      const ab = new ArrayBuffer(HEADER_SIZE);
      const u8 = new Uint8Array(ab);
      u8[0] = 'B'.charCodeAt(0);
      u8[1] = 'A'.charCodeAt(0);
      u8[2] = 'D'.charCodeAt(0);
      u8[3] = '!'.charCodeAt(0);
      expect(() => parseBinary(ab, blankConstellations)).toThrow(/Bad magic/);
    });

    it('rejects unsupported version', () => {
      const buf = buildCatalog([]);
      new DataView(buf).setUint32(HEADER_LAYOUT.version, 99, true);
      expect(() => parseBinary(buf, blankConstellations)).toThrow(/version: 99/);
    });

    it('parses empty catalog (count=0)', () => {
      const buf = buildCatalog([]);
      const cat = parseBinary(buf, blankConstellations);
      expect(cat.count).toBe(0);
      expect(cat.positions.length).toBe(0);
      expect(cat.solIndex).toBe(-1);
      expect(cat.names.size).toBe(0);
    });
  });

  describe('record fields', () => {
    it('parses positions, absmag, ci, physicalRadius', () => {
      const star: StarRecord = {
        ...baseStar,
        pos: [1.5, -2.5, 3.5],
        absmag: 4.83,
        ci: 0.65,
        physicalRadius: 1.0,
      };
      const cat = parseBinary(buildCatalog([star]), blankConstellations);
      expect(cat.count).toBe(1);
      expect(cat.positions[0]).toBeCloseTo(1.5, 5);
      expect(cat.positions[1]).toBeCloseTo(-2.5, 5);
      expect(cat.positions[2]).toBeCloseTo(3.5, 5);
      expect(cat.absmag[0]).toBeCloseTo(4.83, 5);
      expect(cat.ci[0]).toBeCloseTo(0.65, 5);
      expect(cat.physicalRadius[0]).toBeCloseTo(1.0, 5);
    });

    it('parses spectClass / luminosityClass / constellation as small ints', () => {
      const star: StarRecord = {
        ...baseStar,
        spectClass: 5,
        luminosityClass: 3,
        constellation: 42,
      };
      const cat = parseBinary(buildCatalog([star]), blankConstellations);
      expect(cat.spectClass[0]).toBe(5);
      expect(cat.luminosityClass[0]).toBe(3);
      expect(cat.constellation[0]).toBe(42);
    });

    it('parses HIP id', () => {
      const star: StarRecord = { ...baseStar, hip: 32349 };
      const cat = parseBinary(buildCatalog([star]), blankConstellations);
      expect(cat.hip[0]).toBe(32349);
    });

    it('parses HIP=0 as no-HIP star', () => {
      const cat = parseBinary(buildCatalog([{ ...baseStar, hip: 0 }]), blankConstellations);
      expect(cat.hip[0]).toBe(0);
    });

    it('decodes NO_ORBIT (0xFFFFFFFF) as -1 and preserves a real orbitIdx', () => {
      const cat = parseBinary(
        buildCatalog([
          { ...baseStar, orbitIdx: NO_ORBIT },
          { ...baseStar, orbitIdx: 7 },
        ]),
        blankConstellations,
      );
      expect(cat.orbitIdx[0]).toBe(-1);
      expect(cat.orbitIdx[1]).toBe(7);
    });
  });

  describe('companion sentinel', () => {
    it('decodes 0xffffffff companion as -1', () => {
      const cat = parseBinary(
        buildCatalog([{ ...baseStar, companion: 0xffffffff }]),
        blankConstellations,
      );
      expect(cat.companion[0]).toBe(-1);
    });

    it('preserves a real companion index', () => {
      const cat = parseBinary(
        buildCatalog([
          { ...baseStar },
          { ...baseStar, companion: 0 },
        ]),
        blankConstellations,
      );
      expect(cat.companion[0]).toBe(-1);
      expect(cat.companion[1]).toBe(0);
    });
  });

  describe('flags and solIndex', () => {
    it('sets solIndex when FLAG_IS_SOL is present', () => {
      const cat = parseBinary(
        buildCatalog([
          { ...baseStar },
          { ...baseStar, flags: FLAG_IS_SOL },
          { ...baseStar },
        ]),
        blankConstellations,
      );
      expect(cat.solIndex).toBe(1);
      expect(cat.flags[1] & FLAG_IS_SOL).toBeTruthy();
    });

    it('solIndex stays -1 when no star carries the bit', () => {
      const cat = parseBinary(
        buildCatalog([{ ...baseStar }, { ...baseStar }]),
        blankConstellations,
      );
      expect(cat.solIndex).toBe(-1);
    });

    it('preserves combined flag bits (has_name | is_sol | has_bayer | binary_primary)', () => {
      const allFlags = FLAG_HAS_NAME | FLAG_IS_SOL | FLAG_HAS_BAYER | FLAG_BINARY_PRIMARY;
      const cat = parseBinary(
        buildCatalog([{ ...baseStar, flags: allFlags }]),
        blankConstellations,
      );
      expect(cat.flags[0]).toBe(allFlags);
    });
  });

  describe('variability (amplitude / period)', () => {
    it('decodes amplitude at 0.05 mag units', () => {
      // amplitudeRaw=20 → 1.0 mag
      const cat = parseBinary(
        buildCatalog([{ ...baseStar, amplitudeRaw: 20 }]),
        blankConstellations,
      );
      expect(cat.amplitudeMag[0]).toBeCloseTo(1.0, 5);
    });

    it('decodes period at 0.1 day units', () => {
      // periodRaw=3320 → 332.0 days
      const cat = parseBinary(
        buildCatalog([{ ...baseStar, periodRaw: 3320 }]),
        blankConstellations,
      );
      expect(cat.periodDays[0]).toBeCloseTo(332.0, 5);
    });

    it('non-variable star has 0 amplitude and 0 period', () => {
      const cat = parseBinary(buildCatalog([{ ...baseStar }]), blankConstellations);
      expect(cat.amplitudeMag[0]).toBe(0);
      expect(cat.periodDays[0]).toBe(0);
    });

    it('decodes max-range amplitude (255 → 12.75 mag) and period (65535 → 6553.5 days)', () => {
      const cat = parseBinary(
        buildCatalog([{ ...baseStar, amplitudeRaw: 255, periodRaw: 65535 }]),
        blankConstellations,
      );
      expect(cat.amplitudeMag[0]).toBeCloseTo(12.75, 4);
      expect(cat.periodDays[0]).toBeCloseTo(6553.5, 4);
    });
  });

  describe('name table', () => {
    it('decodes a single named star', () => {
      const names = ['Sirius'];
      const offsets = nameTableOffsets(names);
      const star: StarRecord = {
        ...baseStar,
        flags: FLAG_HAS_NAME, // has_name
        nameOffset: offsets[0],
      };
      const cat = parseBinary(
        buildCatalog([star], names.map((n, i) => ({ offset: offsets[i], name: n }))),
        blankConstellations,
      );
      expect(cat.names.size).toBe(1);
      expect(cat.names.get(0)).toBe('Sirius');
    });

    it('decodes multiple named stars with shared name table', () => {
      const names = ['Sirius', 'Vega', 'Betelgeuse'];
      const offsets = nameTableOffsets(names);
      const records = names.map((_, i) => ({
        ...baseStar,
        flags: FLAG_HAS_NAME,
        nameOffset: offsets[i],
      }));
      const cat = parseBinary(
        buildCatalog(records, names.map((n, i) => ({ offset: offsets[i], name: n }))),
        blankConstellations,
      );
      expect(cat.names.get(0)).toBe('Sirius');
      expect(cat.names.get(1)).toBe('Vega');
      expect(cat.names.get(2)).toBe('Betelgeuse');
    });

    it('skips stars without the has_name flag even when nameOffset is set', () => {
      const names = ['Polaris'];
      const offsets = nameTableOffsets(names);
      const star: StarRecord = {
        ...baseStar,
        flags: 0, // intentionally NOT FLAG_HAS_NAME
        nameOffset: offsets[0],
      };
      const cat = parseBinary(
        buildCatalog([star], names.map((n, i) => ({ offset: offsets[i], name: n }))),
        blankConstellations,
      );
      expect(cat.names.size).toBe(0);
    });

    it('decodes UTF-8 names correctly', () => {
      const names = ['Étoile', 'βCen']; // Latin-1 + Greek
      const offsets = nameTableOffsets(names);
      const records = names.map((_, i) => ({
        ...baseStar,
        flags: FLAG_HAS_NAME,
        nameOffset: offsets[i],
      }));
      const cat = parseBinary(
        buildCatalog(records, names.map((n, i) => ({ offset: offsets[i], name: n }))),
        blankConstellations,
      );
      expect(cat.names.get(0)).toBe('Étoile');
      expect(cat.names.get(1)).toBe('βCen');
    });
  });

  describe('constellation passthrough', () => {
    it('attaches the supplied constellation array to the result', () => {
      const cons: Constellation[] = [{ code: 'ori', name: 'Orion', lines: [[0, 1]] }];
      const cat = parseBinary(buildCatalog([]), cons);
      expect(cat.constellations).toBe(cons);
    });
  });

  describe('typed-array sizing invariants', () => {
    it('positions array length is count*3', () => {
      const records = Array.from({ length: 7 }, () => ({ ...baseStar }));
      const cat = parseBinary(buildCatalog(records), blankConstellations);
      expect(cat.positions.length).toBe(7 * 3);
      expect(cat.absmag.length).toBe(7);
      expect(cat.ci.length).toBe(7);
      expect(cat.physicalRadius.length).toBe(7);
      expect(cat.spectClass.length).toBe(7);
      expect(cat.luminosityClass.length).toBe(7);
      expect(cat.constellation.length).toBe(7);
      expect(cat.flags.length).toBe(7);
      expect(cat.companion.length).toBe(7);
      expect(cat.periodDays.length).toBe(7);
      expect(cat.amplitudeMag.length).toBe(7);
      expect(cat.hip.length).toBe(7);
      expect(cat.orbitIdx.length).toBe(7);
    });
  });

  describe('orbital-elements section header', () => {
    it('exposes elementsCount from the v5 header (0 when empty)', () => {
      const cat = parseBinary(buildCatalog([{ ...baseStar }]), blankConstellations);
      expect(cat.elementsCount).toBe(0);
    });
  });
});
