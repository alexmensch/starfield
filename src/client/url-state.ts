import {
  type FilterState,
  type Stellata,
  type MagPresetName,
  MAG_PRESETS,
  DEFAULT_FOV,
  ALL_SPECT_MASK,
} from './stellata';
import { sliderToDist, distToSlider, SLIDER_STEPS } from './controls';
import { setUnit, getUnit, onUnitChange } from './distance-util';
import { isLive } from './time';

// URL state lives in a single opaque param: `?v=<base64url>`. The blob
// is `[1 byte version] [LEB128 presence mask, 1–4 bytes] [variable
// payload]` in v3. Only fields that diverge from canonical defaults
// occupy bytes — a fully-default state has no `?v=` at all and a
// typical share lands at ~10–25 chars.
//
// Three wire formats coexist. v3 (current) has an LEB128 presence mask
// + per-component vec3 sub-masks (cam/tgt/up/worldOffset emit only the
// components that diverge from their per-key default). v2 has a flat
// 24-bit presence mask, 1-byte quantised scalars for fov/mag/smin/
// smax/span, and 3-byte star/POI ids — every present vec3 always costs
// 12 bytes. v1 (legacy: 32-bit mask, float32 scalars, uint32 ids) is
// the original. Old shared URLs auto-upgrade to v3 on load via
// `applyFromUrl`'s post-debounce rewrite.
//
// Adding a field: claim the next free presence bit, append a FieldSpec
// to the buildFields() body, and add encoder/decoder logic in
// `currentStateOf` / `applyDecodedView`. Old URLs still decode fine —
// unknown bits are zero in the presence mask, so the decoder takes the
// default. Don't repurpose retired bits for ~6 months of deploy
// overlap. Breaking-shape changes (resizing existing fields, semantic
// shifts) need a new SCHEMA_VERSION and a parallel FIELDS_V<n> table;
// freeze the old one verbatim so its decoder stays correct.
//
// Buffer order (FIELDS bit-index order) is independent of the dispatch
// order in applyDecodedView. Both are load-bearing — see the comments
// at each apply step.

const DEBOUNCE_MS = 300;
const SCHEMA_VERSION_V1 = 1;
const SCHEMA_VERSION_V2 = 2;
const SCHEMA_VERSION = 3;
const PARAM_NAME = 'v';
const EPS = 1e-3;

// Default values that the encoder uses to decide whether to omit a field.
const DEFAULT_CAM: [number, number, number] = [0, 0, 30];
const DEFAULT_TGT: [number, number, number] = [0, 0, 0];
const DEFAULT_UP: [number, number, number] = [0, 1, 0];
// In observe mode the camera is parked AT the focal star (origin in the
// local frame), so the canonical default is [0,0,0] rather than DEFAULT_CAM.
// Encoder elides cam against this; decoder snaps to it when restoring an
// observe pose with cam absent. Single name shared by both halves so the
// invariant is enforced in code, not just prose.
const OBSERVE_CAM_LOCAL: [number, number, number] = [0, 0, 0];

// Mode-aware default for cam, used by both encoder (omit-if-equal) and
// decoder (snap-when-absent). The cam-omission invariant says: a default
// observe pose has cam=[0,0,0], a default navigate pose has cam=DEFAULT_CAM.
// Both sites must use the same predicate or round-trips diverge.
function defaultCamForMode(mode: 'navigate' | 'observe' | undefined): [number, number, number] {
  return mode === 'observe' ? OBSERVE_CAM_LOCAL : DEFAULT_CAM;
}

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
  /** Cloud focus (mutually exclusive with star focus in Stellata). */
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
  /** Absolute-space position anchoring the floating origin. Emitted
   *  only when no focus is active and the anchor isn't Sol — i.e.
   *  after a close-orbit unfocus left the origin parked at the former
   *  focal object. The loader applies this *before* cam/tgt so cam/tgt
   *  (kept as small local-frame coordinates) land in the right frame.
   *
   *  Why a free vec3 rather than a catalog ref: the anchor concept
   *  generalises beyond stars to clouds, planets, probes, and other
   *  future objects. Encoding the world-space position directly keeps
   *  the URL agnostic to anchor type and decouples it from catalog
   *  identifiers that may not exist (planets) or may shift under
   *  catalog rebuilds. Float32 ULP at megaparsec absolute scale is
   *  ~10⁻² pc — invisible in any view because the user-visible pose
   *  is the cam/tgt offset *within* the local frame, and that's
   *  encoded at full Float32 precision relative to the anchor. */
  worldOffset?: [number, number, number];
  /** Wall-clock `t` (Unix-seconds, double precision) for the solar-
   *  system layer. Emitted only when the user has scrubbed away from
   *  "now"; absence ⇒ receiver resolves to their local wall-clock at
   *  load time. v1 (stellata-3re.1) wires the path but never emits —
   *  the time-scrubber epic (stellata-nmu) flips on emission by
   *  introducing pinned-`t` state. */
  t?: number;
}

const POI_MAX_COUNT = 16;

type Vec3Key = 'cam' | 'tgt' | 'up' | 'worldOffset';
type ComponentDefaults = (v: DecodedView) => readonly [number, number, number];
/** Mode-dependent post-decode fix-up for vec3FieldV3 fields whose
 *  default depends on view state populated by a *later* field in the
 *  decode loop (currently just cam, whose z-default depends on mode
 *  set by flags at bit 13). `sub` is the sub-mask byte the field
 *  decoded; the hook uses it to distinguish "value on the wire" from
 *  "value filled from the static default". */
type ApplyMode = (v: DecodedView, sub: number) => void;
type Vec3Builder = (bit: number, key: Vec3Key) => FieldSpec;

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
  /** Encode the field at `off`. Returns the number of bytes written so
   *  the caller can advance `off` without a second `encodeBytes` call —
   *  matters for vec3FieldV3 / pois where the byte count requires
   *  recomputing the sub-mask or list length. */
  encode(v: DecodedView, dv: DataView, off: number): number;
  decode(v: DecodedView, dv: DataView, off: number): void;
  /** Optional post-pass invoked after the full field-decode loop, only
   *  when the field's mask bit is set this round. Used by vec3FieldV3
   *  to apply mode-dependent default fix-up that can't run during
   *  decode itself because the relevant view field decodes later. */
  postDecode?(v: DecodedView): void;
}

function fixed(n: number) {
  return { encodeBytes: (_v: DecodedView) => n, decodeBytes: (_dv: DataView, _o: number) => n };
}

function vec3Field(bit: number, key: Vec3Key): FieldSpec {
  return {
    bit, key, ...fixed(12),
    isPresent: v => v[key] !== undefined,
    encode: (v, dv, o) => {
      const t = v[key]!;
      dv.setFloat32(o + 0, t[0], true);
      dv.setFloat32(o + 4, t[1], true);
      dv.setFloat32(o + 8, t[2], true);
      return 12;
    },
    decode: (v, dv, o) => {
      v[key] = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
    },
  };
}

// Per-key static defaults for the v3 vec3 sub-mask elision. cam's
// "real" default is mode-dependent (DEFAULT_CAM in navigate, [0,0,0]
// in observe) but the decoder uses the static navigate value here and
// fixes up missing components in cam's postDecode hook once view.mode
// is known — flags decodes after cam in FIELDS_V3 bit order.
const VEC3_DEFAULTS: Record<Vec3Key, readonly [number, number, number]> = {
  cam: DEFAULT_CAM,
  tgt: DEFAULT_TGT,
  up: DEFAULT_UP,
  worldOffset: [0, 0, 0],
};

// v3 vec3 — 1-byte sub-mask (low 3 bits = which components diverge
// from default) + per-set-bit float32 LE. A vec3 matching its default
// in all three components has isPresent=false and is omitted from the
// outer presence mask entirely.
//
// `getDefault` resolves the per-component default for the current view.
// Static-default keys (tgt, up, worldOffset) pass `() => def`; cam's
// default depends on mode and passes `v => defaultCamForMode(v.mode)`.
// Localising the rule on the field spec means the encoder never branches
// on the key string.
//
// `postDecode` (optional) runs after the full field-decode loop, only
// when this field's mask bit was present this round. Used by cam to
// swap z=0 in observe mode when the sub-mask leaves z unset (cam
// decodes before flags-which-sets-mode, so the fix-up can't run during
// cam.decode itself).
//
// Strict equality (===), not approx — under floating-origin the local-
// frame cam can land at sub-µpc magnitudes (~1e-6 pc) that are well
// inside the URL-write debouncer's 1e-3 epsilon. Eliding those as
// "approximately default" would round the camera silently to the
// frame origin on round-trip and break stellata-a7d.2.11.
function vec3FieldV3(
  bit: number,
  key: Vec3Key,
  getDefault: ComponentDefaults,
  postDecode?: ApplyMode,
): FieldSpec {
  const def = VEC3_DEFAULTS[key];
  // Captured during decode so the optional postDecode hook can
  // distinguish "z was on the wire" from "z came from the static def".
  // Module-singleton FieldSpec is safe under synchronous decode; the
  // value is freshly written by decode() in the same round before the
  // post-decode loop reads it.
  let lastSub = 0;
  return {
    bit, key,
    encodeBytes: v => {
      const t = v[key]!;
      const d = getDefault(v);
      let n = 1;
      if (t[0] !== d[0]) n += 4;
      if (t[1] !== d[1]) n += 4;
      if (t[2] !== d[2]) n += 4;
      return n;
    },
    decodeBytes: (dv, off) => {
      const sub = dv.getUint8(off);
      let n = 1;
      if (sub & 1) n += 4;
      if (sub & 2) n += 4;
      if (sub & 4) n += 4;
      return n;
    },
    isPresent: v => {
      const t = v[key];
      if (!t) return false;
      const d = getDefault(v);
      return t[0] !== d[0] || t[1] !== d[1] || t[2] !== d[2];
    },
    encode: (v, dv, o) => {
      const t = v[key]!;
      const d = getDefault(v);
      let sub = 0;
      if (t[0] !== d[0]) sub |= 1;
      if (t[1] !== d[1]) sub |= 2;
      if (t[2] !== d[2]) sub |= 4;
      dv.setUint8(o, sub);
      let p = o + 1;
      if (sub & 1) { dv.setFloat32(p, t[0], true); p += 4; }
      if (sub & 2) { dv.setFloat32(p, t[1], true); p += 4; }
      if (sub & 4) { dv.setFloat32(p, t[2], true); p += 4; }
      return p - o;
    },
    decode: (v, dv, o) => {
      // Sub-mask bit budget: low 3 bits = which components diverge
      // from default; high 5 bits (bits 3-7) are reserved and
      // silently ignored on decode. A future encoder can repurpose
      // them (e.g. a per-component f64 escape) without bumping
      // SCHEMA_VERSION — older clients will keep decoding the low 3
      // bits correctly.
      const sub = dv.getUint8(o);
      lastSub = sub;
      const out: [number, number, number] = [def[0], def[1], def[2]];
      let p = o + 1;
      if (sub & 1) { out[0] = dv.getFloat32(p, true); p += 4; }
      if (sub & 2) { out[1] = dv.getFloat32(p, true); p += 4; }
      if (sub & 4) { out[2] = dv.getFloat32(p, true); p += 4; }
      v[key] = out;
    },
    postDecode: postDecode ? v => postDecode(v, lastSub) : undefined,
  };
}

function f32Field(bit: number, key: 'fov' | 'mag' | 'smin' | 'smax' | 'span'): FieldSpec {
  return {
    bit, key, ...fixed(4),
    isPresent: v => v[key] !== undefined,
    encode: (v, dv, o) => { dv.setFloat32(o, v[key]!, true); return 4; },
    decode: (v, dv, o) => { v[key] = dv.getFloat32(o, true); },
  };
}

function u16Field(bit: number, key: 'dmin' | 'dmax' | 'spect' | 'cloud' | 'toc'): FieldSpec {
  return {
    bit, key, ...fixed(2),
    isPresent: v => v[key] !== undefined,
    encode: (v, dv, o) => { dv.setUint16(o, v[key]!, true); return 2; },
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
      return 4;
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

// LEB128: 7-bit payload + continuation bit per byte, low-group-first.
// v3 uses this for the outer presence mask, replacing v2's fixed 3-
// byte u24. Empty mask = 1 byte; single low-bit masks (cam = bit 0,
// flags = bit 13 in mask 0x002000) = 1–2 bytes; full-mask high bits
// degrade to 3–4 bytes — bit 21 (t) is the only field that costs an
// extra byte vs u24, and it doesn't emit yet (gated on the time-
// scrubber epic stellata-nmu).
//
// Exported for unit-level tests in url-state.test.ts; the helpers
// otherwise have no consumers outside this module.
export function writeVarint(dv: DataView, off: number, val: number): number {
  let n = 0;
  let x = val >>> 0;
  do {
    let byte = x & 0x7f;
    x >>>= 7;
    if (x !== 0) byte |= 0x80;
    dv.setUint8(off + n, byte);
    n++;
  } while (x !== 0);
  return n;
}

export function readVarint(dv: DataView, off: number, end: number): { val: number; bytes: number } {
  let val = 0;
  let n = 0;
  let shift = 0;
  for (;;) {
    if (off + n >= end) throw new Error('Varint runs past blob end');
    const byte = dv.getUint8(off + n);
    val |= (byte & 0x7f) << shift;
    n++;
    if (!(byte & 0x80)) return { val: val >>> 0, bytes: n };
    shift += 7;
    if (shift >= 32) throw new Error('Varint mask too long');
  }
}

export function varintLen(val: number): number {
  let n = 0;
  let x = val >>> 0;
  do {
    x >>>= 7;
    n++;
  } while (x !== 0);
  return n;
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
      return 1;
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
      return 3;
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
    encode: (v, dv, o) => { dv.setUint8(o, v[key]! & 0xff); return 1; },
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
    encode: (v, dv, o) => { dv.setUint8(o, PRESET_TO_INDEX[v.preset!]); return 1; },
    decode: (v, dv, o) => {
      const idx = dv.getUint8(o);
      v.preset = INDEX_TO_PRESET[idx] ?? 'naked-eye';
    },
  },
  {
    bit: 9, key: 'con', ...fixed(1),
    isPresent: v => v.con !== undefined,
    encode: (v, dv, o) => { dv.setInt8(o, v.con!); return 1; },
    decode: (v, dv, o) => { v.con = dv.getInt8(o); },
  },
  f32Field(10, 'smin'),
  f32Field(11, 'smax'),
  f32Field(12, 'span'),
  {
    bit: 13, key: 'flags', ...fixed(1),
    isPresent: v => packFlags(v) !== 0,
    encode: (v, dv, o) => { dv.setUint8(o, packFlags(v)); return 1; },
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
    encode: () => 0,
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
      return 1 + 4 * list.length;
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

// v2 and v3 share 16 of 20 field specs verbatim — only bits 0/1/2/20
// (the four vec3s) differ. `buildFields` parameterises the vec3 helper
// so the shared bits live in one place: a non-vec3 field-shape change
// (a new flag bit, a different cap on POIs) lands once here and both
// FIELDS_V2 and FIELDS_V3 pick it up. v1 stays separate — its scalar
// shapes (4-byte fov/mag, 4-byte star refs, u16 cloud, 4-byte POI
// HIPs) diverge from v2/v3 in a way that a single helper-swap can't
// express.
//
// The frozen-decoder rule the file's top comment block names ("freeze
// the old one verbatim so its decoder stays correct") is preserved by
// construction: vec3Field is unchanged from when it shipped in v2, so
// FIELDS_V2 = buildFields(vec3Field) reconstructs the v2 layout
// byte-for-byte even as buildFields gains new shared bits over time.
function buildFields(vec3: Vec3Builder): FieldSpec[] {
  return [
    vec3(0, 'cam'),
    vec3(1, 'tgt'),
    vec3(2, 'up'),
    u8Field(3,  'fov',  { min: 10, max: 120, step: 1   }),
    u8Field(4,  'mag',  { min: -2, max: 15,  step: 0.1 }),
    u16Field(5, 'dmin'),
    u16Field(6, 'dmax'),
    u16Field(7, 'spect'),
    {
      bit: 8, key: 'preset', ...fixed(1),
      isPresent: v => v.preset !== undefined,
      encode: (v, dv, o) => { dv.setUint8(o, PRESET_TO_INDEX[v.preset!]); return 1; },
      decode: (v, dv, o) => {
        const idx = dv.getUint8(o);
        v.preset = INDEX_TO_PRESET[idx] ?? 'naked-eye';
      },
    },
    {
      bit: 9, key: 'con', ...fixed(1),
      isPresent: v => v.con !== undefined,
      encode: (v, dv, o) => { dv.setInt8(o, v.con!); return 1; },
      decode: (v, dv, o) => { v.con = dv.getInt8(o); },
    },
    u8Field(10, 'smin', { min: 1, max: 6,  step: 0.1 }),
    u8Field(11, 'smax', { min: 2, max: 32, step: 0.5 }),
    u8Field(12, 'span', { min: 2, max: 20, step: 0.5 }),
    {
      bit: 13, key: 'flags', ...fixed(1),
      isPresent: v => packFlags(v) !== 0,
      encode: (v, dv, o) => { dv.setUint8(o, packFlags(v)); return 1; },
      decode: (v, dv, o) => { unpackFlags(v, dv.getUint8(o)); },
    },
    starRefFieldU24(14, 'focus'),
    starRefFieldU24(15, 'to'),
    u8CloudField(16, 'cloud'),
    u8CloudField(17, 'toc'),
    {
      bit: 18, key: 'focusCleared', ...fixed(0),
      isPresent: v => v.focus === 'cleared',
      encode: () => 0,
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
        return 1 + 3 * list.length;
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
    // Floating-origin anchor. Appended at the *end* (rather than slotted
    // in by bit number) so a stale client reading a newer URL just stops
    // short of these trailing bytes — every preceding field decodes at
    // its expected offset and the missing worldOffset gracefully degrades
    // to "Sol-anchored" (the pre-fix default). Future additions should
    // follow the same append-only pattern.
    vec3(20, 'worldOffset'),
    // Scrubber-pinned `t` (Unix-seconds, float64). Append-only per the
    // worldOffset note above. Stale clients silently ignore it and
    // resolve `t` to local wall-clock now — the same fallback as a URL
    // without the field.
    {
      bit: 21, key: 't', ...fixed(8),
      isPresent: v => v.t !== undefined,
      encode: (v, dv, o) => { dv.setFloat64(o, v.t!, true); return 8; },
      decode: (v, dv, o) => { v.t = dv.getFloat64(o, true); },
    },
  ];
}

// v2 schema: identical to v3 except for the four vec3 fields, which
// pay a flat 12 bytes per present vec3 instead of v3's per-component
// sub-mask. Each field's bit number matches v3 so the shared
// buildFields body stays correct under either vec3 helper.
const FIELDS_V2: FieldSpec[] = buildFields(vec3Field);

// v3 vec3 wiring: per-key default + optional post-decode hook. Cam's
// default depends on mode (set by flags at bit 13, which decodes after
// cam) so cam carries a postDecode that swaps z=0 in observe mode when
// the sub-mask leaves z unset. The other three vec3s have static
// defaults and no post-pass.
const VEC3_V3_CONFIG: Record<Vec3Key, { def: ComponentDefaults; postDecode?: ApplyMode }> = {
  cam: {
    def: v => defaultCamForMode(v.mode),
    postDecode: (v, sub) => {
      if (v.cam && v.mode === 'observe' && !(sub & 4)) v.cam[2] = 0;
    },
  },
  tgt:         { def: () => DEFAULT_TGT },
  up:          { def: () => DEFAULT_UP },
  worldOffset: { def: () => VEC3_DEFAULTS.worldOffset },
};

// v3 schema: same buildFields body as v2, but with vec3FieldV3 carrying
// per-component sub-mask elision. A typical near-Sol pose
// (cam=[0,0,3.7]) drops from v2's 12-byte cam to v3's 5 bytes (1
// sub-mask + 4 z-component) — ~7 bytes saved per share URL.
const FIELDS_V3: FieldSpec[] = buildFields((bit, key) => {
  const cfg = VEC3_V3_CONFIG[key];
  return vec3FieldV3(bit, key, cfg.def, cfg.postDecode);
});

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
  for (const f of FIELDS_V3) {
    if (f.isPresent(view)) mask |= (1 << f.bit);
  }
  return mask;
}

// Encode a view given a pre-computed presence mask. Split out so
// writeUrl can compute the mask once for both the "should we emit
// `?v=`?" gate and the encode itself — the public encodeBlob runs
// computePresence again internally for callers that don't have a
// mask handy.
function encodeBlobWithMask(view: DecodedView, mask: number): string {
  let total = 1 + varintLen(mask); // 1 version + LEB128 presence (1–4 bytes)
  for (const f of FIELDS_V3) {
    if (mask & (1 << f.bit)) total += f.encodeBytes(view);
  }
  const ab = new ArrayBuffer(total);
  const dv = new DataView(ab);
  dv.setUint8(0, SCHEMA_VERSION);
  let off = 1 + writeVarint(dv, 1, mask);
  for (const f of FIELDS_V3) {
    if (mask & (1 << f.bit)) {
      // encode returns its own byte count, so this loop avoids a second
      // encodeBytes call (which would recompute vec3 sub-masks and pois
      // list lengths).
      off += f.encode(view, dv, off);
    }
  }
  return toBase64Url(new Uint8Array(ab));
}

export function encodeBlob(view: DecodedView): string {
  return encodeBlobWithMask(view, computePresence(view));
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
  if (version === SCHEMA_VERSION_V2) return { view: decodeV2(dv), version };
  if (version === SCHEMA_VERSION)    return { view: decodeV3(dv), version };
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

function decodeV3(dv: DataView): DecodedView {
  if (dv.byteLength < 2) throw new Error(`v3 blob too short: ${dv.byteLength} bytes`);
  const { val: mask, bytes: maskBytes } = readVarint(dv, 1, dv.byteLength);
  const view: DecodedView = {};
  let off = 1 + maskBytes;
  for (const f of FIELDS_V3) {
    if (mask & (1 << f.bit)) {
      f.decode(view, dv, off);
      off += f.decodeBytes(dv, off);
    }
  }
  // Post-decode pass: invokes postDecode hooks on fields whose mask
  // bit was present this round. Currently used by cam to swap z=0 in
  // observe mode — cam decodes at bit 0, mode is set by flags at bit
  // 13, so the fix-up has to wait until view.mode is populated.
  for (const f of FIELDS_V3) {
    if ((mask & (1 << f.bit)) && f.postDecode) f.postDecode(view);
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

// Build a DecodedView from current Stellata state. Default-equality is
// computed against canonical defaults (and the active preset for
// preset-relative fields like `mag`) so omitted fields keep the blob
// minimal.
export function currentStateOf(stellata: Stellata, idMaps: IdMaps): DecodedView {
  const f = stellata.getFilter();
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

  const fov = stellata.getCameraFov();
  if (!approx(fov, DEFAULT_FOV)) view.fov = fov;

  if (getUnit() === 'ly') view.unit = 'ly';

  // Star focus and cloud focus are mutually exclusive in Stellata, so at
  // most one is non-null. Sol focus is the default, encoded by *omitting*
  // both — so a fully-default state has no `?v=` at all.
  const star = stellata.getFocusedStar();
  const cloud = stellata.getFocusedCloud();
  if (cloud !== null) {
    view.cloud = cloud;
  } else if (star === null) {
    view.focus = 'cleared';
  } else if (star !== idMaps.solIndex) {
    view.focus = refFromIndex(star, idMaps);
  }

  const to = stellata.getVectorTo();
  const toCloud = stellata.getVectorToCloud();
  if (to !== null) {
    view.to = refFromIndex(to, idMaps);
  } else if (toCloud !== null) {
    view.toc = toCloud;
  }

  const mode = stellata.getCameraMode();
  if (mode !== 'navigate') view.mode = mode;

  // Chart on/off rides FLAG_CHART, gated to observe-only at pack time.
  if (f.chart) view.chart = true;

  // POIs are observe-only and clear on observe→navigate exit, so we only
  // emit them when the camera is in observe mode. Encoded as HIP IDs (not
  // catalog indices) so a future catalog rebuild doesn't break old URLs;
  // stars without HIP can't be pinned in the first place. Capped at
  // POI_MAX_COUNT defensively.
  if (mode === 'observe') {
    const pois = stellata.getPois();
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

  const c = stellata.camera.position;
  const t = stellata.controls.target;
  const u = stellata.camera.up;
  // Skip each independently. Under floating origin, a focused-orbit URL
  // has tgt=[0,0,0] (the focal star's local position) and observe-mode
  // has cam=[0,0,0] (camera is parked *at* the focal star), so omitting
  // them when at default trims ~16 base64url chars from nearly every
  // URL. Cam's default depends on mode — receiver re-snaps cam to
  // origin via setCameraMode('observe', { animate: false }) on apply.
  //
  // Frame: cam/tgt are emitted as raw camera.position / controls.target
  // — i.e. in worldOffset-local frame. With focus, the focal object's
  // setFocus call has already recentred worldOffset to that object's
  // absolute position, so cam/tgt are object-local. Without focus, the
  // origin rides along with whatever object was most recently anchored
  // (the unfocus path no longer recentres to Sol — a7d.2.11). The
  // worldOffset field below carries the absolute anchor position so
  // the loader can re-establish the same frame on page-load. Old-style
  // URLs without worldOffset always had worldOffset=(0,0,0) at save
  // time, so the local frame was Sol — backward-compatible.
  //
  // Emit worldOffset only when no focus is active AND the anchor isn't
  // Sol. With focus, the loader's focusStar call recentres origin
  // automatically. With anchor at Sol, the local frame is implicitly
  // Sol-relative (matches the legacy default), so omitting saves
  // 12 bytes on every default-pose URL.
  const wo = stellata.getWorldOffset();
  const woNonSol = stellata.getFocusedStar() === null
    && (!approx(wo.x, 0) || !approx(wo.y, 0) || !approx(wo.z, 0));
  if (woNonSol) {
    view.worldOffset = [wo.x, wo.y, wo.z];
  }
  // Two-layer elision is intentional: this site populates view.cam/tgt/up
  // when any component is meaningfully off-default at 1e-3 epsilon (so
  // tiny per-frame numerical noise from controls.update doesn't keep
  // re-triggering URL writes), then vec3FieldV3.isPresent re-checks at
  // strict equality to decide whether the field claims its outer
  // presence bit. Both layers are load-bearing — the inner strict
  // equality preserves floating-origin sub-µpc cam values
  // (stellata-a7d.2.11) that would round to default under the outer
  // epsilon if the inner check were also approx. Don't collapse to one
  // predicate without preserving both regimes.
  //
  // When the anchor is non-Sol, always populate cam/tgt explicitly so
  // the decoder doesn't fall back to default-pose reconstruction in a
  // shifted local frame; vec3FieldV3.isPresent will still elide cam/tgt
  // from the wire if they happen to match default (the decoder's
  // worldOffset branch resets them to default anyway, so the net pose
  // is identical), but populating them here keeps the path explicit.
  const camDefault = defaultCamForMode(mode);
  if (woNonSol || !approx(c.x, camDefault[0]) || !approx(c.y, camDefault[1]) || !approx(c.z, camDefault[2])) {
    view.cam = [c.x, c.y, c.z];
  }
  if (woNonSol || !approx(t.x, DEFAULT_TGT[0]) || !approx(t.y, DEFAULT_TGT[1]) || !approx(t.z, DEFAULT_TGT[2])) {
    view.tgt = [t.x, t.y, t.z];
  }
  if (!approx(u.x, DEFAULT_UP[0]) || !approx(u.y, DEFAULT_UP[1]) || !approx(u.z, DEFAULT_UP[2])) {
    view.up = [u.x, u.y, u.z];
  }

  // Scrubber-pinned `t` only — when the user is on live wall-clock,
  // omit so the share link resolves to the receiver's local now (the
  // contract baked into stellata-3re.1). v1 always lands in the live
  // branch; the gate flips on once stellata-nmu introduces pinning.
  const tNow = stellata.getT();
  if (!isLive(tNow)) view.t = tNow;

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

// Single source of truth for "park the camera at the mode's default
// pose" — used by the worldOffset branch (after origin recentre, before
// any explicit cam/tgt overrides) and the observe-enter branch (when no
// explicit cam came on the wire). Both routed through `defaultCamForMode`
// so the cam-omission invariant lives in one place.
function setCameraToDefault(stellata: Stellata, mode: 'navigate' | 'observe' | undefined): void {
  const d = defaultCamForMode(mode);
  stellata.camera.position.set(d[0], d[1], d[2]);
}

// Apply a decoded view to Stellata. **The order here is load-bearing**:
//   - unit is applied first so any DOM sync triggered later reads it
//   - preset before filter, so derived size defaults are populated before
//     explicit overrides layer on top
//   - up before focus/orbit, since focusStar/setOrbitTarget call
//     controls.update() which reads camera.up
//   - cam/tgt overwrite whatever focusStar/setOrbitTarget computed
//   - mode last, because the observe snap reads the camera quaternion
//     just set by controls.update(position, target, up)
export function applyDecodedView(
  stellata: Stellata,
  view: DecodedView,
  idMaps: IdMaps,
): void {
  if (view.unit) setUnit(view.unit);

  if (view.preset) stellata.applyMagnitudePreset(view.preset);

  const patch: Partial<FilterState> = {};
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
  if (Object.keys(patch).length) stellata.setFilter(patch);

  if (view.fov !== undefined && view.fov > 0) stellata.setCameraFov(view.fov);

  // Pinned `t` — only present when the sender's `t` was scrubbed away
  // from live (the encoder gates emission on isLive). Apply before any
  // ephemeris-driven reads downstream.
  if (view.t !== undefined) stellata.setT(view.t);

  // Single dirty flag for everything that requires controls.update() at
  // the end of the camera-touching block. Each branch below that mutates
  // camera.position / controls.target / camera.up sets this so the final
  // update() reads as "if any of those happened, refresh" — replaces
  // a hand-maintained N-way OR that grew with every new branch.
  let controlsDirty = false;

  if (view.up) {
    stellata.camera.up.set(view.up[0], view.up[1], view.up[2]).normalize();
    controlsDirty = true;
  }

  const hasCam = view.cam !== undefined;
  const hasTgt = view.tgt !== undefined;

  if (view.focus !== undefined) {
    if (view.focus === 'cleared') {
      // URL restore — bypass the close-zoom unfocus animation (a7d.2.6).
      // cam/tgt below would overwrite camera.position mid-lerp, leaving
      // the transition state to silently drag the camera away from the
      // restored pose on the next frame.
      stellata.unfocus({ animate: false });
    } else {
      const idx = resolveStarRef(view.focus, idMaps, idMaps.solIndex);
      if (idx >= 0 && idx < idMaps.starCount) {
        if (hasCam || hasTgt) stellata.setOrbitTarget(idx);
        else stellata.focusStar(idx);
      }
    }
  }
  // Cloud focus is mutually exclusive with star focus, but encoder never
  // emits both — apply after `focus` so cloud wins on the off chance both
  // are present in a hand-crafted blob.
  if (view.cloud !== undefined && view.cloud >= 0) {
    if (hasCam || hasTgt) stellata.setFocusedCloud(view.cloud);
    else stellata.flyToCloud(view.cloud);
  }
  if (view.toc !== undefined && view.toc >= 0) stellata.setVectorToCloud(view.toc);
  if (view.to) {
    const idx = resolveStarRef(view.to, idMaps, -1);
    if (idx >= 0 && idx < idMaps.starCount) stellata.setVectorTo(idx);
  }

  // Apply worldOffset *before* cam/tgt so the local frame is established
  // first. With focus, focusStar above already recentred the origin to
  // the focal object, and the encoder elides worldOffset in that case —
  // but apply it anyway when present (no-op when redundant). Without
  // focus, worldOffset carries the close-orbit unfocus origin
  // (a7d.2.11) so cam/tgt can be tiny local-frame values that round-
  // trip cleanly through float32. setWorldOffset also shifts camera
  // and target alongside the origin to preserve the user-visible
  // pose; for URL load we explicitly reset them to defaults here so
  // an absent view.cam / view.tgt produces the conventional default
  // pose in the *new* local frame rather than the recentre-shifted
  // junk position. view.cam / view.tgt below override when present.
  if (view.worldOffset) {
    stellata.setWorldOffset(view.worldOffset[0], view.worldOffset[1], view.worldOffset[2]);
    setCameraToDefault(stellata, view.mode);
    stellata.controls.target.set(DEFAULT_TGT[0], DEFAULT_TGT[1], DEFAULT_TGT[2]);
    controlsDirty = true;
  }

  if (view.cam) {
    stellata.camera.position.set(view.cam[0], view.cam[1], view.cam[2]);
    controlsDirty = true;
  }
  if (view.tgt) {
    stellata.controls.target.set(view.tgt[0], view.tgt[1], view.tgt[2]);
    controlsDirty = true;
  }
  // Mirror the encoder's observe-mode cam omission: pre-snap the camera
  // to the focal-star origin *before* controls.update so that lookAt
  // computes the right quaternion from (0,0,0)→tgt rather than from
  // focusStar's orbit position. setCameraMode('observe', animate:false)
  // below preserves that quaternion when it pins position again.
  // setCameraToDefault routes through defaultCamForMode so the elision
  // invariant lives in one place.
  const willEnterObserve = view.mode === 'observe' && stellata.getFocusedStar() !== null;
  if (willEnterObserve && !hasCam) {
    setCameraToDefault(stellata, 'observe');
    controlsDirty = true;
  }
  if (controlsDirty) stellata.controls.update();

  if (willEnterObserve) {
    stellata.setCameraMode('observe', { animate: false });
  }

  // Chart applies after observe mode is engaged so the chart-mode
  // orchestrator's observe-gate sees the right cameraMode on the
  // resulting filter-change event.
  if (view.chart && stellata.getCameraMode() === 'observe') {
    stellata.setFilter({ chart: true });
  }

  // POIs are observe-only — only restore them when the camera is parked
  // in observe (the encoder also gates emission on this). Resolve each
  // HIP through idMaps; HIPs that don't resolve in the current catalog
  // are silently dropped (graceful partial restore on a catalog rebuild).
  if (Array.isArray(view.pois) && view.pois.length > 0 && stellata.getCameraMode() === 'observe') {
    const resolved: number[] = [];
    for (const hip of view.pois) {
      const idx = idMaps.hipToIndex.get(hip);
      if (idx !== undefined) resolved.push(idx);
    }
    if (resolved.length > 0) stellata.setPois(resolved);
  }
}

function writeUrl(stellata: Stellata, idMaps: IdMaps): void {
  const view = currentStateOf(stellata, idMaps);
  // Single computePresence pass — the mask gates the `?v=` param itself
  // and is also passed to encodeBlobWithMask so the encoder doesn't
  // re-walk FIELDS_V3.
  const mask = computePresence(view);
  const qs = mask === 0 ? '' : `${PARAM_NAME}=${encodeBlobWithMask(view, mask)}`;
  const url = location.pathname + (qs ? '?' + qs : '');
  if (url !== location.pathname + location.search) {
    history.replaceState(null, '', url);
  }
}

// Returns true when a `?v=` blob was present and applied (regardless of
// schema version). The caller uses the false branch to fall back to the
// canonical first-load view (stellata-vjm). A malformed blob also
// returns false so the user lands on the framed default rather than the
// unframed canvas-default pose.
export function applyFromUrl(stellata: Stellata, idMaps: IdMaps): boolean {
  const params = new URLSearchParams(location.search);
  const blob = params.get(PARAM_NAME);
  if (!blob) return false;
  let decoded: DecodedBlob;
  try {
    decoded = decodeBlob(blob);
  } catch (err) {
    console.warn('Failed to decode ?v= URL state:', err);
    return false;
  }
  applyDecodedView(stellata, decoded.view, idMaps);
  // Auto-upgrade legacy URLs: after the same debounce we already use for
  // routine URL writes, re-encode the current state as the latest schema
  // so the address bar ends up with the smaller v3 form. Defers past
  // any state-change events triggered by the apply itself, which would
  // otherwise schedule their own write on top.
  if (decoded.version !== SCHEMA_VERSION) {
    setTimeout(() => writeUrl(stellata, idMaps), DEBOUNCE_MS);
  }
  return true;
}

export function startUrlSync(stellata: Stellata, idMaps: IdMaps): void {
  let timer: number | undefined;
  // Scratch for the per-frame camera/target/up change detector. Layout:
  //   [0..2] camera.position, [3..5] controls.target, [6..8] camera.up
  // Seeded from the live camera state at registration time so the first
  // frame doesn't trigger a write — the URL stays empty (or in sync with
  // whatever applyFromUrl/applyFirstLoadView just applied) until the
  // user actually moves the camera or changes a setting.
  const lastCam = new Float64Array(9);
  const c0 = stellata.camera.position;
  const t0 = stellata.controls.target;
  const u0 = stellata.camera.up;
  lastCam[0] = c0.x; lastCam[1] = c0.y; lastCam[2] = c0.z;
  lastCam[3] = t0.x; lastCam[4] = t0.y; lastCam[5] = t0.z;
  lastCam[6] = u0.x; lastCam[7] = u0.y; lastCam[8] = u0.z;

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(() => writeUrl(stellata, idMaps), DEBOUNCE_MS);
  };

  stellata.onStateChange(schedule);
  onUnitChange(schedule);

  stellata.onFrame(() => {
    // Skip URL writes while any camera-position lerp is in flight (warp,
    // observe enter/exit, or navigate-mode unfocus zoom-out a7d.2.6) —
    // the camera mutates every frame and we don't want intermediate poses
    // in the URL. The end-of-animation events flush the final pose.
    if (stellata.isCameraTransitionActive()) return;
    const c = stellata.camera.position;
    const t = stellata.controls.target;
    const u = stellata.camera.up;
    // Component-wise epsilon comparison on the steady-state path. EPS
    // matches the pre-a0n toFixed(3) precision (1e-3) so the change-
    // detection threshold is unchanged. No allocations on the no-change
    // path — used to be 10+ string allocations per frame from a
    // toFixed(3)×9 hash.
    if (
      Math.abs(c.x - lastCam[0]) < EPS && Math.abs(c.y - lastCam[1]) < EPS && Math.abs(c.z - lastCam[2]) < EPS &&
      Math.abs(t.x - lastCam[3]) < EPS && Math.abs(t.y - lastCam[4]) < EPS && Math.abs(t.z - lastCam[5]) < EPS &&
      Math.abs(u.x - lastCam[6]) < EPS && Math.abs(u.y - lastCam[7]) < EPS && Math.abs(u.z - lastCam[8]) < EPS
    ) {
      return;
    }
    lastCam[0] = c.x; lastCam[1] = c.y; lastCam[2] = c.z;
    lastCam[3] = t.x; lastCam[4] = t.y; lastCam[5] = t.z;
    lastCam[6] = u.x; lastCam[7] = u.y; lastCam[8] = u.z;
    schedule();
  });
}

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}
