import { type Starfield, type MagPresetName, MAG_PRESETS, DEFAULT_FOV } from './starfield';
import { sliderToDist, distToSlider, SLIDER_STEPS } from './controls';
import { applyUnit } from './unit-toggle';
import { getUnit, onUnitChange } from './distance-util';

// URL state lives in a single opaque param: `?v=<base64url>`. The blob
// is `[1 byte version] [3 bytes LE presence mask] [variable payload]`
// in the current schema. Only fields that diverge from canonical
// defaults occupy bytes — a fully-default state has no `?v=` at all
// and a typical share lands at ~30–40 chars.
//
// Two wire formats coexist. v2 (current) has a 24-bit presence mask,
// 1-byte quantised scalars for fov/mag/smin/smax/span, and 3-byte
// star/POI ids. v1 (legacy: 32-bit mask, float32 scalars, uint32 ids)
// is still decoded — old shared URLs auto-upgrade to v2 on load via
// `applyFromUrl`'s post-debounce rewrite.
//
// Adding a field: claim the next free presence bit, append a FieldSpec
// to FIELDS_V2, and add encoder/decoder logic in `currentStateOf` /
// `applyDecodedView`. Old URLs still decode fine — unknown bits are
// zero in the presence mask, so the decoder takes the default. Don't
// repurpose retired bits for ~6 months of deploy overlap. Breaking-
// shape changes (resizing existing fields, semantic shifts) need a
// new SCHEMA_VERSION and a parallel FIELDS_V<n> table; freeze the old
// one verbatim so its decoder stays correct.
//
// Buffer order (FIELDS bit-index order) is independent of the dispatch
// order in applyDecodedView. Both are load-bearing — see the comments
// at each apply step.

const DEBOUNCE_MS = 300;
const ALL_SPECT_MASK = 0b111111111;
const SCHEMA_VERSION_V1 = 1;
const SCHEMA_VERSION = 2;
const PARAM_NAME = 'v';
const EPS = 1e-3;

// Default values that the encoder uses to decide whether to omit a field.
const DEFAULT_CAM: [number, number, number] = [0, 0, 30];
const DEFAULT_TGT: [number, number, number] = [0, 0, 0];
const DEFAULT_UP: [number, number, number] = [0, 1, 0];

// Focus-tag-bit semantics: high bit set = HIP-resolved ID, clear = raw
// row index. The 0xFFFFFFFF sentinel is reserved (won't naturally appear
// since "explicitly unfocused" uses a separate presence bit, not a magic
// id value).
const FOCUS_HIP_TAG = 0x80000000;
const FOCUS_ID_MASK = 0x7fffffff;
// v2 packs the same tag + id space into 3 bytes: 1 tag bit + 23-bit id
// (covers row indices ≤ 313k and HIP ≤ ~120k with headroom).
const FOCUS_HIP_TAG_V2 = 0x800000;
const FOCUS_ID_MASK_V2 = 0x7fffff;

const PRESET_TO_INDEX: Record<MagPresetName, number> = {
  'naked-eye': 0,
  'binoculars': 1,
  'all': 2,
};
const INDEX_TO_PRESET: MagPresetName[] = ['naked-eye', 'binoculars', 'all'];

// Flags byte — packed booleans + small enums. Each bit is "non-default":
//   0 = grid on, 1 = HUD on, 2 = MC disabled, 3 = MW disabled,
//   4 = unit ly, 5 = mode observe, 6 = chart on (only set when also
//   mode=observe — chart is observe-gated), 7 = constellations disabled.
const FLAG_GRID         = 1 << 0;
const FLAG_HUD          = 1 << 1;
// bit 2 reserved (formerly FLAG_MC_DISABLED — molecular clouds shelved for v1.0)
const FLAG_MW_DISABLED  = 1 << 3;
const FLAG_UNIT_LY      = 1 << 4;
const FLAG_MODE_OBSERVE = 1 << 5;
const FLAG_CHART        = 1 << 6;
const FLAG_CON_DISABLED = 1 << 7;

export interface IdMaps {
  /** HIP → row-index lookup. Built once at boot from `catalog.hip`. */
  hipToIndex: Map<number, number>;
  /** Row → HIP lookup; `indexToHip[i] === 0` when the star has no HIP. */
  indexToHip: Uint32Array;
  /** Total row count for bounds checks. */
  starCount: number;
  /** Sol's row index, or -1 if missing. */
  solIndex: number;
}

export type StarRef = { kind: 'hip' | 'index'; id: number };

export interface DecodedView {
  cam?: [number, number, number];
  tgt?: [number, number, number];
  up?: [number, number, number];
  fov?: number;
  mag?: number;
  dmin?: number;
  dmax?: number;
  spect?: number;
  preset?: MagPresetName;
  con?: number;
  smin?: number;
  smax?: number;
  span?: number;
  showGalacticGrid?: boolean;
  showHud?: boolean;
  showConstellation?: boolean;
  showMilkyway?: boolean;
  unit?: 'pc' | 'ly';
  mode?: 'navigate' | 'observe';
  /** Star focus. Undefined = default (Sol). 'cleared' = explicitly unfocused. */
  focus?: 'cleared' | StarRef;
  /** Vector-to star (the chevron measurement line). */
  to?: StarRef;
  /** Cloud focus (mutually exclusive with star focus in Starfield). */
  cloud?: number;
  /** Vector-to cloud (mutually exclusive with `to`). */
  toc?: number;
  /** Chart mode (observe-only). Only encoded when `mode === 'observe'`. */
  chart?: boolean;
  /** Pinned points-of-interest as HIP IDs. Observe-only — encoded only
   *  when `mode === 'observe'`, since POIs clear on observe→navigate
   *  exit anyway. HIP-only (no catalog-index fallback) so URLs survive
   *  catalog rebuilds. Hard-capped at POI_MAX_COUNT to bound the blob. */
  pois?: number[];
}

const POI_MAX_COUNT = 16;

interface FieldSpec {
  bit: number;
  key: string;
  /** Bytes the field consumes when encoding `v`. Most fields are
   *  fixed-size and ignore the argument. The `pois` field reads it to
   *  size the variable-length payload. */
  encodeBytes(v: DecodedView): number;
  /** Bytes the field consumes when decoding from `dv` starting at `off`.
   *  Same shape as encodeBytes — fixed-size fields ignore arguments;
   *  variable-length fields read a length-prefix byte. */
  decodeBytes(dv: DataView, off: number): number;
  isPresent(v: DecodedView): boolean;
  encode(v: DecodedView, dv: DataView, off: number): void;
  decode(v: DecodedView, dv: DataView, off: number): void;
}

function fixed(n: number) {
  return { encodeBytes: (_v: DecodedView) => n, decodeBytes: (_dv: DataView, _o: number) => n };
}

function vec3Field(bit: number, key: 'cam' | 'tgt' | 'up'): FieldSpec {
  return {
    bit, key, ...fixed(12),
    isPresent: v => v[key] !== undefined,
    encode: (v, dv, o) => {
      const t = v[key]!;
      dv.setFloat32(o + 0, t[0], true);
      dv.setFloat32(o + 4, t[1], true);
      dv.setFloat32(o + 8, t[2], true);
    },
    decode: (v, dv, o) => {
      v[key] = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
    },
  };
}

function f32Field(bit: number, key: 'fov' | 'mag' | 'smin' | 'smax' | 'span'): FieldSpec {
  return {
    bit, key, ...fixed(4),
    isPresent: v => v[key] !== undefined,
    encode: (v, dv, o) => { dv.setFloat32(o, v[key]!, true); },
    decode: (v, dv, o) => { v[key] = dv.getFloat32(o, true); },
  };
}

function u16Field(bit: number, key: 'dmin' | 'dmax' | 'spect' | 'cloud' | 'toc'): FieldSpec {
  return {
    bit, key, ...fixed(2),
    isPresent: v => v[key] !== undefined,
    encode: (v, dv, o) => { dv.setUint16(o, v[key]!, true); },
    decode: (v, dv, o) => { v[key] = dv.getUint16(o, true); },
  };
}

function starRefField(bit: number, key: 'focus' | 'to'): FieldSpec {
  return {
    bit, key, ...fixed(4),
    isPresent: v => typeof v[key] === 'object' && v[key] !== null,
    encode: (v, dv, o) => {
      const ref = v[key] as StarRef;
      const tagged = ref.kind === 'hip' ? (ref.id | FOCUS_HIP_TAG) : (ref.id & FOCUS_ID_MASK);
      dv.setUint32(o, tagged >>> 0, true);
    },
    decode: (v, dv, o) => {
      const raw = dv.getUint32(o, true);
      v[key] = (raw & FOCUS_HIP_TAG)
        ? { kind: 'hip', id: raw & FOCUS_ID_MASK }
        : { kind: 'index', id: raw & FOCUS_ID_MASK };
    },
  };
}

// 24-bit little-endian helpers for the v2 presence mask, 3-byte star
// refs, and 3-byte POI HIP entries. DataView has no native u24, so we
// compose from three byte ops.
function readU24LE(dv: DataView, off: number): number {
  return dv.getUint8(off) | (dv.getUint8(off + 1) << 8) | (dv.getUint8(off + 2) << 16);
}
function writeU24LE(dv: DataView, off: number, val: number): void {
  dv.setUint8(off,     val         & 0xff);
  dv.setUint8(off + 1, (val >>> 8)  & 0xff);
  dv.setUint8(off + 2, (val >>> 16) & 0xff);
}

// Quantised uint8 field — replaces f32Field for fov/mag/smin/smax/span
// in v2. The quant grid matches each slider's native (min, max, step) so
// round-trips are exact at slider resolution. Encoder clamps to [0, max
// byte] so a programmatic out-of-range setter saturates instead of
// wrapping.
function u8Field(
  bit: number,
  key: 'fov' | 'mag' | 'smin' | 'smax' | 'span',
  q: { min: number; max: number; step: number },
): FieldSpec {
  const maxByte = Math.round((q.max - q.min) / q.step);
  return {
    bit, key, ...fixed(1),
    isPresent: v => v[key] !== undefined,
    encode: (v, dv, o) => {
      const raw = Math.round((v[key]! - q.min) / q.step);
      const u = Math.max(0, Math.min(maxByte, raw));
      dv.setUint8(o, u);
    },
    decode: (v, dv, o) => {
      v[key] = q.min + dv.getUint8(o) * q.step;
    },
  };
}

// 3-byte star ref — same tag-bit + id semantics as v1 but in 24 bits.
function starRefFieldU24(bit: number, key: 'focus' | 'to'): FieldSpec {
  return {
    bit, key, ...fixed(3),
    isPresent: v => typeof v[key] === 'object' && v[key] !== null,
    encode: (v, dv, o) => {
      const ref = v[key] as StarRef;
      const tagged = ref.kind === 'hip'
        ? ((ref.id & FOCUS_ID_MASK_V2) | FOCUS_HIP_TAG_V2)
        : (ref.id & FOCUS_ID_MASK_V2);
      writeU24LE(dv, o, tagged >>> 0);
    },
    decode: (v, dv, o) => {
      const raw = readU24LE(dv, o);
      v[key] = (raw & FOCUS_HIP_TAG_V2)
        ? { kind: 'hip', id: raw & FOCUS_ID_MASK_V2 }
        : { kind: 'index', id: raw & FOCUS_ID_MASK_V2 };
    },
  };
}

// 1-byte cloud index — the cloud catalog has < 256 entries.
function u8CloudField(bit: number, key: 'cloud' | 'toc'): FieldSpec {
  return {
    bit, key, ...fixed(1),
    isPresent: v => v[key] !== undefined,
    encode: (v, dv, o) => { dv.setUint8(o, v[key]! & 0xff); },
    decode: (v, dv, o) => { v[key] = dv.getUint8(o); },
  };
}

const FIELDS_V1: FieldSpec[] = [
  vec3Field(0, 'cam'),
  vec3Field(1, 'tgt'),
  vec3Field(2, 'up'),
  f32Field(3, 'fov'),
  f32Field(4, 'mag'),
  u16Field(5, 'dmin'),
  u16Field(6, 'dmax'),
  u16Field(7, 'spect'),
  {
    bit: 8, key: 'preset', ...fixed(1),
    isPresent: v => v.preset !== undefined,
    encode: (v, dv, o) => { dv.setUint8(o, PRESET_TO_INDEX[v.preset!]); },
    decode: (v, dv, o) => {
      const idx = dv.getUint8(o);
      v.preset = INDEX_TO_PRESET[idx] ?? 'naked-eye';
    },
  },
  {
    bit: 9, key: 'con', ...fixed(1),
    isPresent: v => v.con !== undefined,
    encode: (v, dv, o) => { dv.setInt8(o, v.con!); },
    decode: (v, dv, o) => { v.con = dv.getInt8(o); },
  },
  f32Field(10, 'smin'),
  f32Field(11, 'smax'),
  f32Field(12, 'span'),
  {
    bit: 13, key: 'flags', ...fixed(1),
    isPresent: v => packFlags(v) !== 0,
    encode: (v, dv, o) => { dv.setUint8(o, packFlags(v)); },
    decode: (v, dv, o) => { unpackFlags(v, dv.getUint8(o)); },
  },
  starRefField(14, 'focus'),
  starRefField(15, 'to'),
  u16Field(16, 'cloud'),
  u16Field(17, 'toc'),
  {
    // Zero-byte sentinel — presence bit IS the value. Distinct from "focus
    // bit absent" (= default Sol) and from "focus bit present" (= some
    // specific star). When this bit is set, the receiver explicitly clears
    // focus regardless of starting state.
    bit: 18, key: 'focusCleared', ...fixed(0),
    isPresent: v => v.focus === 'cleared',
    encode: () => {},
    decode: v => { v.focus = 'cleared'; },
  },
  {
    // Variable-length: 1-byte count + count × 4-byte HIP IDs. Hard-capped
    // at POI_MAX_COUNT both at encode time (defensive cap on `currentStateOf`
    // emission) and at decode time (defensive cap on hand-edited URLs).
    bit: 19, key: 'pois',
    encodeBytes: v => 1 + 4 * Math.min(v.pois?.length ?? 0, POI_MAX_COUNT),
    decodeBytes: (dv, off) => 1 + 4 * Math.min(dv.getUint8(off), POI_MAX_COUNT),
    isPresent: v => Array.isArray(v.pois) && v.pois.length > 0,
    encode: (v, dv, o) => {
      const list = (v.pois ?? []).slice(0, POI_MAX_COUNT);
      dv.setUint8(o, list.length);
      for (let i = 0; i < list.length; i++) {
        dv.setUint32(o + 1 + i * 4, list[i] >>> 0, true);
      }
    },
    decode: (v, dv, o) => {
      const n = Math.min(dv.getUint8(o), POI_MAX_COUNT);
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        out.push(dv.getUint32(o + 1 + i * 4, true));
      }
      v.pois = out;
    },
  },
];

// v2 schema: same 20 bits / 20 fields as v1, but with quantised 1-byte
// scalars (fov/mag/smin/smax/span), 3-byte star refs (focus/to), 1-byte
// cloud refs, 3-byte POI HIP entries, and a 24-bit presence mask in the
// frame. Each field's bit number is identical to v1 so the FIELDS_V1
// table stays a frozen reference for legacy decode.
const FIELDS_V2: FieldSpec[] = [
  vec3Field(0, 'cam'),
  vec3Field(1, 'tgt'),
  vec3Field(2, 'up'),
  u8Field(3,  'fov',  { min: 10, max: 120, step: 1   }),
  u8Field(4,  'mag',  { min: -2, max: 15,  step: 0.1 }),
  u16Field(5, 'dmin'),
  u16Field(6, 'dmax'),
  u16Field(7, 'spect'),
  {
    bit: 8, key: 'preset', ...fixed(1),
    isPresent: v => v.preset !== undefined,
    encode: (v, dv, o) => { dv.setUint8(o, PRESET_TO_INDEX[v.preset!]); },
    decode: (v, dv, o) => {
      const idx = dv.getUint8(o);
      v.preset = INDEX_TO_PRESET[idx] ?? 'naked-eye';
    },
  },
  {
    bit: 9, key: 'con', ...fixed(1),
    isPresent: v => v.con !== undefined,
    encode: (v, dv, o) => { dv.setInt8(o, v.con!); },
    decode: (v, dv, o) => { v.con = dv.getInt8(o); },
  },
  u8Field(10, 'smin', { min: 1, max: 6,  step: 0.1 }),
  u8Field(11, 'smax', { min: 2, max: 32, step: 0.5 }),
  u8Field(12, 'span', { min: 2, max: 20, step: 0.5 }),
  {
    bit: 13, key: 'flags', ...fixed(1),
    isPresent: v => packFlags(v) !== 0,
    encode: (v, dv, o) => { dv.setUint8(o, packFlags(v)); },
    decode: (v, dv, o) => { unpackFlags(v, dv.getUint8(o)); },
  },
  starRefFieldU24(14, 'focus'),
  starRefFieldU24(15, 'to'),
  u8CloudField(16, 'cloud'),
  u8CloudField(17, 'toc'),
  {
    bit: 18, key: 'focusCleared', ...fixed(0),
    isPresent: v => v.focus === 'cleared',
    encode: () => {},
    decode: v => { v.focus = 'cleared'; },
  },
  {
    // Variable-length: 1-byte count + count × 3-byte HIP IDs (HIP space
    // is < 2^17 so 24 bits is plenty). Hard-capped at POI_MAX_COUNT both
    // at encode time and at decode time to bound the blob.
    bit: 19, key: 'pois',
    encodeBytes: v => 1 + 3 * Math.min(v.pois?.length ?? 0, POI_MAX_COUNT),
    decodeBytes: (dv, off) => 1 + 3 * Math.min(dv.getUint8(off), POI_MAX_COUNT),
    isPresent: v => Array.isArray(v.pois) && v.pois.length > 0,
    encode: (v, dv, o) => {
      const list = (v.pois ?? []).slice(0, POI_MAX_COUNT);
      dv.setUint8(o, list.length);
      for (let i = 0; i < list.length; i++) {
        writeU24LE(dv, o + 1 + i * 3, list[i] >>> 0);
      }
    },
    decode: (v, dv, o) => {
      const n = Math.min(dv.getUint8(o), POI_MAX_COUNT);
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        out.push(readU24LE(dv, o + 1 + i * 3));
      }
      v.pois = out;
    },
  },
];

function packFlags(v: DecodedView): number {
  let f = 0;
  if (v.showGalacticGrid) f |= FLAG_GRID;
  if (v.showHud) f |= FLAG_HUD;
  if (v.showConstellation === false) f |= FLAG_CON_DISABLED;
  if (v.showMilkyway === false) f |= FLAG_MW_DISABLED;
  if (v.unit === 'ly') f |= FLAG_UNIT_LY;
  if (v.mode === 'observe') f |= FLAG_MODE_OBSERVE;
  // Chart only persists when observe is also active — chart-mode is an
  // observe-only feature, so emitting chart=on without mode=observe would
  // round-trip to a state that can't activate.
  if (v.chart && v.mode === 'observe') f |= FLAG_CHART;
  return f;
}

function unpackFlags(v: DecodedView, f: number): void {
  if (f & FLAG_GRID) v.showGalacticGrid = true;
  if (f & FLAG_HUD) v.showHud = true;
  if (f & FLAG_CON_DISABLED) v.showConstellation = false;
  if (f & FLAG_MW_DISABLED) v.showMilkyway = false;
  if (f & FLAG_UNIT_LY) v.unit = 'ly';
  if (f & FLAG_MODE_OBSERVE) v.mode = 'observe';
  if (f & FLAG_CHART) v.chart = true;
}

function computePresence(view: DecodedView): number {
  let mask = 0;
  for (const f of FIELDS_V2) {
    if (f.isPresent(view)) mask |= (1 << f.bit);
  }
  return mask;
}

export function encodeBlob(view: DecodedView): string {
  const mask = computePresence(view);
  let total = 4; // 1 version + 3 presence
  for (const f of FIELDS_V2) {
    if (mask & (1 << f.bit)) total += f.encodeBytes(view);
  }
  const ab = new ArrayBuffer(total);
  const dv = new DataView(ab);
  dv.setUint8(0, SCHEMA_VERSION);
  writeU24LE(dv, 1, mask >>> 0);
  let off = 4;
  for (const f of FIELDS_V2) {
    if (mask & (1 << f.bit)) {
      f.encode(view, dv, off);
      off += f.encodeBytes(view);
    }
  }
  return toBase64Url(new Uint8Array(ab));
}

export interface DecodedBlob {
  view: DecodedView;
  /** Schema version the blob was written in. Lets callers detect legacy
   *  blobs and trigger an upgrade rewrite. */
  version: number;
}

export function decodeBlob(blob: string): DecodedBlob {
  const bytes = fromBase64Url(blob);
  if (bytes.length < 1) throw new Error(`Blob too short: ${bytes.length} bytes`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint8(0);
  if (version === SCHEMA_VERSION_V1) return { view: decodeV1(dv), version };
  if (version === SCHEMA_VERSION)    return { view: decodeV2(dv), version };
  throw new Error(`Unsupported view version: ${version}`);
}

function decodeV1(dv: DataView): DecodedView {
  if (dv.byteLength < 5) throw new Error(`v1 blob too short: ${dv.byteLength} bytes`);
  const mask = dv.getUint32(1, true);
  const view: DecodedView = {};
  let off = 5;
  for (const f of FIELDS_V1) {
    if (mask & (1 << f.bit)) {
      f.decode(view, dv, off);
      off += f.decodeBytes(dv, off);
    }
  }
  return view;
}

function decodeV2(dv: DataView): DecodedView {
  if (dv.byteLength < 4) throw new Error(`v2 blob too short: ${dv.byteLength} bytes`);
  const mask = readU24LE(dv, 1);
  const view: DecodedView = {};
  let off = 4;
  for (const f of FIELDS_V2) {
    if (mask & (1 << f.bit)) {
      f.decode(view, dv, off);
      off += f.decodeBytes(dv, off);
    }
  }
  return view;
}

// RFC 4648 §5 base64url, no padding.
function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(blob: string): Uint8Array {
  let s = blob.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Build a DecodedView from current Starfield state. Default-equality is
// computed against canonical defaults (and the active preset for
// preset-relative fields like `mag`) so omitted fields keep the blob
// minimal.
export function currentStateOf(starfield: Starfield, idMaps: IdMaps): DecodedView {
  const f = starfield.getFilter();
  const view: DecodedView = {};

  const sMin = distToSlider(f.minDistSol, true);
  const sMax = distToSlider(f.maxDistSol, false);
  if (sMin !== 0) view.dmin = sMin;
  if (sMax !== SLIDER_STEPS) view.dmax = sMax;
  if (f.activePreset !== 'naked-eye') view.preset = f.activePreset;
  // Magnitude diverges from the active preset only when the user moved the
  // slider — otherwise it should adapt to the receiver's preset.
  if (!approx(f.maxAppMag, MAG_PRESETS[f.activePreset].maxAppMag)) view.mag = f.maxAppMag;
  if (f.spectMask !== ALL_SPECT_MASK) view.spect = f.spectMask;
  if (f.highlightCon !== -1) view.con = f.highlightCon;
  // Size fields only when explicitly overridden — otherwise the receiver
  // recomputes from preset + their own viewport (responsive sharing).
  if (f.sizeMinOverridden) view.smin = f.sizeMin;
  if (f.sizeMaxOverridden) view.smax = f.sizeMax;
  if (f.sizeSpanOverridden) view.span = f.sizeSpan;
  if (f.showGalacticGrid) view.showGalacticGrid = true;
  if (f.showHud) view.showHud = true;
  if (!f.showConstellation) view.showConstellation = false;
  if (!f.showMilkyway) view.showMilkyway = false;

  const fov = starfield.getCameraFov();
  if (!approx(fov, DEFAULT_FOV)) view.fov = fov;

  if (getUnit() === 'ly') view.unit = 'ly';

  // Star focus and cloud focus are mutually exclusive in Starfield, so at
  // most one is non-null. Sol focus is the default, encoded by *omitting*
  // both — so a fully-default state has no `?v=` at all.
  const star = starfield.getFocusedStar();
  const cloud = starfield.getFocusedCloud();
  if (cloud !== null) {
    view.cloud = cloud;
  } else if (star === null) {
    view.focus = 'cleared';
  } else if (star !== idMaps.solIndex) {
    view.focus = refFromIndex(star, idMaps);
  }

  const to = starfield.getVectorTo();
  const toCloud = starfield.getVectorToCloud();
  if (to !== null) {
    view.to = refFromIndex(to, idMaps);
  } else if (toCloud !== null) {
    view.toc = toCloud;
  }

  const mode = starfield.getCameraMode();
  if (mode !== 'navigate') view.mode = mode;

  // Chart on/off rides FLAG_CHART, gated to observe-only at pack time.
  if (f.chart) view.chart = true;

  // POIs are observe-only and clear on observe→navigate exit, so we only
  // emit them when the camera is in observe mode. Encoded as HIP IDs (not
  // catalog indices) so a future catalog rebuild doesn't break old URLs;
  // stars without HIP can't be pinned in the first place. Capped at
  // POI_MAX_COUNT defensively.
  if (mode === 'observe') {
    const pois = starfield.getPois();
    if (pois.length > 0) {
      const hipsOut: number[] = [];
      for (const idx of pois) {
        if (hipsOut.length >= POI_MAX_COUNT) break;
        const hip = idMaps.indexToHip[idx];
        if (hip > 0) hipsOut.push(hip);
      }
      if (hipsOut.length > 0) view.pois = hipsOut;
    }
  }

  const c = starfield.camera.position;
  const t = starfield.controls.target;
  const u = starfield.camera.up;
  const camDefault =
    approx(c.x, DEFAULT_CAM[0]) && approx(c.y, DEFAULT_CAM[1]) && approx(c.z, DEFAULT_CAM[2]) &&
    approx(t.x, DEFAULT_TGT[0]) && approx(t.y, DEFAULT_TGT[1]) && approx(t.z, DEFAULT_TGT[2]);
  if (!camDefault) {
    view.cam = [c.x, c.y, c.z];
    view.tgt = [t.x, t.y, t.z];
  }
  if (!approx(u.x, DEFAULT_UP[0]) || !approx(u.y, DEFAULT_UP[1]) || !approx(u.z, DEFAULT_UP[2])) {
    view.up = [u.x, u.y, u.z];
  }

  return view;
}

function refFromIndex(idx: number, idMaps: IdMaps): StarRef {
  const hip = idMaps.indexToHip[idx];
  return hip > 0 ? { kind: 'hip', id: hip } : { kind: 'index', id: idx };
}

function resolveStarRef(ref: StarRef, idMaps: IdMaps, fallback: number): number {
  if (ref.kind === 'hip') {
    const idx = idMaps.hipToIndex.get(ref.id);
    return idx ?? fallback;
  }
  return ref.id >= 0 && ref.id < idMaps.starCount ? ref.id : fallback;
}

// Apply a decoded view to Starfield. **The order here is load-bearing**:
//   - unit is applied first so any DOM sync triggered later reads it
//   - preset before filter, so derived size defaults are populated before
//     explicit overrides layer on top
//   - up before focus/orbit, since focusStar/setOrbitTarget call
//     controls.update() which reads camera.up
//   - cam/tgt overwrite whatever focusStar/setOrbitTarget computed
//   - mode last, because the observe snap reads the camera quaternion
//     just set by controls.update(position, target, up)
export function applyDecodedView(
  starfield: Starfield,
  view: DecodedView,
  idMaps: IdMaps,
): void {
  if (view.unit) applyUnit(view.unit);

  if (view.preset) starfield.applyMagnitudePreset(view.preset);

  const patch: Record<string, number | boolean> = {};
  if (view.dmin !== undefined || view.dmax !== undefined) {
    patch.minDistSol = sliderToDist(view.dmin ?? 0, true);
    patch.maxDistSol = sliderToDist(view.dmax ?? SLIDER_STEPS, false);
  }
  if (view.mag !== undefined) patch.maxAppMag = view.mag;
  if (view.spect !== undefined) patch.spectMask = view.spect;
  if (view.con !== undefined) patch.highlightCon = view.con;
  if (view.smin !== undefined) { patch.sizeMin = view.smin; patch.sizeMinOverridden = true; }
  if (view.smax !== undefined) { patch.sizeMax = view.smax; patch.sizeMaxOverridden = true; }
  if (view.span !== undefined) { patch.sizeSpan = view.span; patch.sizeSpanOverridden = true; }
  if (view.showGalacticGrid !== undefined) patch.showGalacticGrid = view.showGalacticGrid;
  if (view.showHud !== undefined) patch.showHud = view.showHud;
  if (view.showConstellation !== undefined) patch.showConstellation = view.showConstellation;
  if (view.showMilkyway !== undefined) patch.showMilkyway = view.showMilkyway;
  if (Object.keys(patch).length) starfield.setFilter(patch);

  if (view.fov !== undefined && view.fov > 0) starfield.setCameraFov(view.fov);

  if (view.up) {
    starfield.camera.up.set(view.up[0], view.up[1], view.up[2]).normalize();
  }

  const hasCam = view.cam !== undefined;
  const hasTgt = view.tgt !== undefined;

  if (view.focus !== undefined) {
    if (view.focus === 'cleared') {
      starfield.unfocus();
    } else {
      const idx = resolveStarRef(view.focus, idMaps, idMaps.solIndex);
      if (idx >= 0 && idx < idMaps.starCount) {
        if (hasCam || hasTgt) starfield.setOrbitTarget(idx);
        else starfield.focusStar(idx);
      }
    }
  }
  // Cloud focus is mutually exclusive with star focus, but encoder never
  // emits both — apply after `focus` so cloud wins on the off chance both
  // are present in a hand-crafted blob.
  if (view.cloud !== undefined && view.cloud >= 0) {
    if (hasCam || hasTgt) starfield.setFocusedCloud(view.cloud);
    else starfield.flyToCloud(view.cloud);
  }
  if (view.toc !== undefined && view.toc >= 0) starfield.setVectorToCloud(view.toc);
  if (view.to) {
    const idx = resolveStarRef(view.to, idMaps, -1);
    if (idx >= 0 && idx < idMaps.starCount) starfield.setVectorTo(idx);
  }

  if (view.cam) {
    starfield.camera.position.set(view.cam[0], view.cam[1], view.cam[2]);
  }
  if (view.tgt) {
    starfield.controls.target.set(view.tgt[0], view.tgt[1], view.tgt[2]);
  }
  if (hasCam || hasTgt || view.up) starfield.controls.update();

  if (view.mode === 'observe' && starfield.getFocusedStar() !== null) {
    starfield.setCameraMode('observe', { animate: false });
  }

  // Chart applies after observe mode is engaged so the chart-mode
  // orchestrator's observe-gate sees the right cameraMode on the
  // resulting filter-change event.
  if (view.chart && starfield.getCameraMode() === 'observe') {
    starfield.setFilter({ chart: true });
  }

  // POIs are observe-only — only restore them when the camera is parked
  // in observe (the encoder also gates emission on this). Resolve each
  // HIP through idMaps; HIPs that don't resolve in the current catalog
  // are silently dropped (graceful partial restore on a catalog rebuild).
  if (Array.isArray(view.pois) && view.pois.length > 0 && starfield.getCameraMode() === 'observe') {
    const resolved: number[] = [];
    for (const hip of view.pois) {
      const idx = idMaps.hipToIndex.get(hip);
      if (idx !== undefined) resolved.push(idx);
    }
    if (resolved.length > 0) starfield.setPois(resolved);
  }
}

function writeUrl(starfield: Starfield, idMaps: IdMaps): void {
  const view = currentStateOf(starfield, idMaps);
  const mask = computePresence(view);
  const qs = mask === 0 ? '' : `${PARAM_NAME}=${encodeBlob(view)}`;
  const url = location.pathname + (qs ? '?' + qs : '');
  if (url !== location.pathname + location.search) {
    history.replaceState(null, '', url);
  }
}

export function applyFromUrl(starfield: Starfield, idMaps: IdMaps): void {
  const params = new URLSearchParams(location.search);
  const blob = params.get(PARAM_NAME);
  if (!blob) return;
  let decoded: DecodedBlob;
  try {
    decoded = decodeBlob(blob);
  } catch (err) {
    console.warn('Failed to decode ?v= URL state:', err);
    return;
  }
  applyDecodedView(starfield, decoded.view, idMaps);
  // Auto-upgrade legacy URLs: after the same debounce we already use for
  // routine URL writes, re-encode the current state as the latest schema
  // so the address bar ends up with the smaller v2 form. Defers past
  // any state-change events triggered by the apply itself, which would
  // otherwise schedule their own write on top.
  if (decoded.version !== SCHEMA_VERSION) {
    setTimeout(() => writeUrl(starfield, idMaps), DEBOUNCE_MS);
  }
}

export function startUrlSync(starfield: Starfield, idMaps: IdMaps): void {
  let timer: number | undefined;
  let lastCamHash = '';

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(() => writeUrl(starfield, idMaps), DEBOUNCE_MS);
  };

  starfield.onStateChange(schedule);
  onUnitChange(schedule);

  starfield.onFrame(() => {
    // Skip URL writes while a warp or observe transition is in flight —
    // the camera mutates every frame and we don't want intermediate poses
    // in the URL. The end-of-animation events flush the final pose.
    if (starfield.getWarpActive()) return;
    if (starfield.isObserveTransitionActive()) return;
    const c = starfield.camera.position;
    const t = starfield.controls.target;
    const u = starfield.camera.up;
    const hash = `${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}|${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)}|${u.x.toFixed(3)},${u.y.toFixed(3)},${u.z.toFixed(3)}`;
    if (hash !== lastCamHash) {
      lastCamHash = hash;
      schedule();
    }
  });
}

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}
