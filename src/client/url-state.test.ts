import { describe, it, expect } from 'vitest';
import {
  encodeBlob,
  decodeBlob,
  currentStateOf,
  type DecodedView,
  type StarRef,
  type IdMaps,
} from './url-state';
import { DEFAULT_FILTER, DEFAULT_FOV, type Stellata } from './stellata';

// Round-trips the view through the wire format and returns the decoded
// view + version. Anything the encoder omits (e.g. default values) reads
// back as undefined, which is the contract callers downstream rely on.
function roundtrip(view: DecodedView) {
  const blob = encodeBlob(view);
  return decodeBlob(blob);
}

describe('url-state', () => {
  describe('empty view', () => {
    it('encodes to a 4-byte (version+presence) blob', () => {
      const blob = encodeBlob({});
      // 4 bytes → 6 base64url chars (no padding)
      expect(blob.length).toBe(6);
    });

    it('decodes empty blob to empty view at current version', () => {
      const { view, version } = roundtrip({});
      expect(view).toEqual({});
      expect(version).toBe(3);
    });
  });

  describe('vec3 fields (cam, tgt, up)', () => {
    it('round-trips cam exactly', () => {
      const cam: [number, number, number] = [1.5, -2.25, 30];
      const { view } = roundtrip({ cam });
      expect(view.cam).toEqual(cam);
    });

    it('round-trips tgt exactly', () => {
      const tgt: [number, number, number] = [10, 20, 30];
      const { view } = roundtrip({ tgt });
      expect(view.tgt).toEqual(tgt);
    });

    it('round-trips a non-default up exactly', () => {
      // [0, 1, 0] would elide to default in v3 — see the v3 default-
      // elision test below. Use a tilted up to force the encoder to
      // actually carry components on the wire.
      const up: [number, number, number] = [0.7071, 0.7071, 0];
      const { view } = roundtrip({ up });
      expect(view.up![0]).toBeCloseTo(0.7071, 4);
      expect(view.up![1]).toBeCloseTo(0.7071, 4);
      expect(view.up![2]).toBe(0);
    });

    it('round-trips all three vec3 fields independently', () => {
      const view: DecodedView = {
        cam: [1, 2, 3],
        tgt: [4, 5, 6],
        up: [0.7071, 0, 0.7071],
      };
      const { view: out } = roundtrip(view);
      expect(out.cam).toEqual([1, 2, 3]);
      expect(out.tgt).toEqual([4, 5, 6]);
      expect(out.up![0]).toBeCloseTo(0.7071, 4);
      expect(out.up![2]).toBeCloseTo(0.7071, 4);
    });

    it('round-trips worldOffset alongside small local-frame cam/tgt', () => {
      // The close-orbit unfocus case (stellata-a7d.2.11): worldOffset
      // sits at a far-from-Sol focal star, cam/tgt are sub-µpc local
      // values. Float32 preserves both magnitudes cleanly when stored
      // in their natural frames (worldOffset absolute, cam/tgt local),
      // whereas combining them into Sol-absolute floats would round
      // the µpc separation to zero.
      const view: DecodedView = {
        worldOffset: [51.6, 257, -37.7],
        cam: [1.85e-6, -2.61e-6, 3.95e-5],
        tgt: [0, 0, 0],
      };
      const { view: out } = roundtrip(view);
      expect(out.worldOffset![0]).toBeCloseTo(51.6, 3);
      expect(out.worldOffset![1]).toBeCloseTo(257, 3);
      expect(out.worldOffset![2]).toBeCloseTo(-37.7, 3);
      // Local-frame cam preserved at sub-µpc precision because float32
      // ULP at these magnitudes is ~1e-13.
      expect(out.cam![0]).toBeCloseTo(1.85e-6, 9);
      expect(out.cam![2]).toBeCloseTo(3.95e-5, 9);
    });

    // 9mm.61: guards the architectural claim from the encoder design
    // comment that "Float32 ULP at megaparsec absolute scale is ~10⁻²
    // pc — invisible in any view because the user-visible pose is the
    // cam/tgt offset within the local frame, and that's encoded at full
    // Float32 precision relative to the anchor."
    it('preserves sub-pc cam precision at kpc-scale worldOffset (galactic-centre frame)', () => {
      // 8.5 kpc ≈ Sol-to-GC distance. Float32 has ~24 bits of mantissa,
      // so absolute resolution at 8500 pc is ~5e-4 pc — much coarser than
      // the µpc cam offset, which is exactly why the encoder splits the
      // anchor and the local-frame pose.
      const view: DecodedView = {
        worldOffset: [8500, 0, 0],
        cam: [1.85e-6, -2.61e-6, 3.95e-5],
        tgt: [0, 0, 0],
      };
      const { view: out } = roundtrip(view);
      // Anchor round-trips at the float32 precision available at 8.5 kpc.
      // 5e-4 pc absolute → roughly 4 decimals.
      expect(out.worldOffset![0]).toBeCloseTo(8500, 3);
      // ...and the local cam offset stays at sub-µpc precision because
      // it's encoded in the local frame, not added to the anchor first.
      expect(out.cam![0]).toBeCloseTo(1.85e-6, 9);
      expect(out.cam![1]).toBeCloseTo(-2.61e-6, 9);
      expect(out.cam![2]).toBeCloseTo(3.95e-5, 9);
    });

    it('elides up when it matches the default [0, 1, 0]', () => {
      // v3 sub-mask: components matching the per-key default are
      // omitted, and a vec3 with all components default has isPresent=
      // false → the field doesn't even claim its outer presence bit.
      const { view } = roundtrip({ up: [0, 1, 0] });
      expect(view.up).toBeUndefined();
    });

    it('elides tgt when it matches the default [0, 0, 0]', () => {
      const { view } = roundtrip({ tgt: [0, 0, 0] });
      expect(view.tgt).toBeUndefined();
    });

    it('emits only the diverging z-component for cam=[0,0,3.7]', () => {
      // The bead's headline scenario: a near-Sol orbit on the z-axis.
      // v2 would burn 12 bytes on cam (3 × f32 incl. two zero floats);
      // v3 emits 1 sub-mask byte + 4 bytes for z = 5 bytes for the cam
      // payload, plus 1 version + 3 outer mask = 9 bytes total → 12
      // base64url chars. Down from v2's 22.
      const blob = encodeBlob({ cam: [0, 0, 3.7] });
      expect(blob.length).toBeLessThanOrEqual(12);
      const { view } = decodeBlob(blob);
      expect(view.cam![0]).toBe(0);
      expect(view.cam![1]).toBe(0);
      expect(view.cam![2]).toBeCloseTo(3.7, 5);
    });

    it('emits only the diverging x-component for cam=[5,0,30]', () => {
      // navigate-mode default is [0,0,30]; only x diverges. sub=1, 5
      // bytes payload.
      const { view } = roundtrip({ cam: [5, 0, 30] });
      expect(view.cam).toEqual([5, 0, 30]);
    });

    it('uses observe default ([0,0,0]) for cam when mode=observe', () => {
      // mode=observe shifts cam's z-default from 30 to 0. cam=[0,0,30]
      // is *off-default* in observe → sub=4 (z bit), z=30 on the wire.
      const { view, version } = roundtrip({ cam: [0, 0, 30], mode: 'observe' });
      expect(version).toBe(3);
      expect(view.cam).toEqual([0, 0, 30]);
      expect(view.mode).toBe('observe');
    });

    it('elides cam in observe mode when it matches the observe default', () => {
      // cam=[0,0,0] matches the observe default — fully elided.
      const { view } = roundtrip({ cam: [0, 0, 0], mode: 'observe' });
      expect(view.cam).toBeUndefined();
      expect(view.mode).toBe('observe');
    });

    it('decoder fills observe-mode cam z-default when sub-mask omits z', () => {
      // Encode cam=[5,0,0] in observe mode: only x diverges from
      // observe default [0,0,0]. sub=1, payload = x. Decoder must fill
      // z=0 (not z=30, the static-table default) once flags reveals
      // mode=observe — that's the post-pass in decodeV3.
      const { view } = roundtrip({ cam: [5, 0, 0], mode: 'observe' });
      expect(view.cam).toEqual([5, 0, 0]);
    });

    it('elides worldOffset when it matches [0, 0, 0]', () => {
      const { view } = roundtrip({ worldOffset: [0, 0, 0] });
      expect(view.worldOffset).toBeUndefined();
    });

    it('preserves cam precision at Mpc-scale worldOffset (extragalactic anchor)', () => {
      // 1 Mpc ≈ Andromeda-distance scale. Float32 ULP here is ~10⁻² pc —
      // the encoder design comment's claim. Anchor precision degrades but
      // local-frame cam is unaffected because of the split storage.
      const view: DecodedView = {
        worldOffset: [1e6, 0, 0],
        cam: [1.85e-6, -2.61e-6, 3.95e-5],
        tgt: [1e-3, 0, 0],
      };
      const { view: out } = roundtrip(view);
      // 1 Mpc anchor: float32 ULP ≈ 0.06 pc absolute → relative precision ~1e-7.
      expect(Math.abs(out.worldOffset![0] - 1e6) / 1e6).toBeLessThan(1e-6);
      // Local cam values are stored as float32s relative to the anchor —
      // i.e. as their raw small magnitudes, NOT as anchor + offset. So
      // their precision is set by the cam magnitudes themselves
      // (~1e-13 ULP at 1e-6 pc), not by the worldOffset's ULP.
      expect(out.cam![0]).toBeCloseTo(1.85e-6, 9);
      expect(out.cam![1]).toBeCloseTo(-2.61e-6, 9);
      expect(out.cam![2]).toBeCloseTo(3.95e-5, 9);
      expect(out.tgt![0]).toBeCloseTo(1e-3, 9);
    });
  });

  describe('quantised u8 fields (v2)', () => {
    it('round-trips fov at slider step boundaries', () => {
      // fov: min=10, max=120, step=1 — integer values round-trip exactly
      for (const fov of [10, 30, 60, 90, 120]) {
        const { view } = roundtrip({ fov });
        expect(view.fov).toBe(fov);
      }
    });

    it('clamps fov to encoder range without wrapping', () => {
      // 200 is past max (120). It should saturate at 120, not wrap to a
      // wraparound value. Encoder clamp guards this.
      const { view } = roundtrip({ fov: 200 });
      expect(view.fov).toBe(120);
    });

    it('clamps fov below min to min', () => {
      const { view } = roundtrip({ fov: 5 });
      expect(view.fov).toBe(10);
    });

    it('round-trips mag at 0.1 step boundaries', () => {
      // mag: min=-2, max=15, step=0.1
      for (const mag of [-2, 0, 5.5, 12.3, 15]) {
        const { view } = roundtrip({ mag });
        expect(view.mag).toBeCloseTo(mag, 1);
      }
    });

    it('round-trips smin at 0.1 step boundaries', () => {
      for (const smin of [1, 1.5, 3.7, 6]) {
        const { view } = roundtrip({ smin });
        expect(view.smin).toBeCloseTo(smin, 1);
      }
    });

    it('round-trips smax at 0.5 step boundaries', () => {
      for (const smax of [2, 8, 16.5, 32]) {
        const { view } = roundtrip({ smax });
        expect(view.smax).toBeCloseTo(smax, 1);
      }
    });

    it('round-trips span at 0.5 step boundaries', () => {
      for (const span of [2, 5, 12.5, 20]) {
        const { view } = roundtrip({ span });
        expect(view.span).toBeCloseTo(span, 1);
      }
    });

    it('rounds to nearest step, not floor', () => {
      // 60.4 → 60 (round); 60.6 → 61 (round)
      expect(roundtrip({ fov: 60.4 }).view.fov).toBe(60);
      expect(roundtrip({ fov: 60.6 }).view.fov).toBe(61);
    });
  });

  describe('u16 fields (dmin, dmax, spect)', () => {
    it('round-trips dmin and dmax', () => {
      const { view } = roundtrip({ dmin: 100, dmax: 800 });
      expect(view.dmin).toBe(100);
      expect(view.dmax).toBe(800);
    });

    it('round-trips spectral mask at full 9-bit range', () => {
      const { view } = roundtrip({ spect: 0b111111111 });
      expect(view.spect).toBe(0b111111111);
    });

    it('round-trips zero spectral mask', () => {
      const { view } = roundtrip({ spect: 0 });
      expect(view.spect).toBe(0);
    });

    it('round-trips u16 boundary value', () => {
      const { view } = roundtrip({ dmax: 65535 });
      expect(view.dmax).toBe(65535);
    });
  });

  describe('preset and constellation', () => {
    it('round-trips each preset', () => {
      for (const preset of ['naked-eye', 'binoculars', 'all'] as const) {
        const { view } = roundtrip({ preset });
        expect(view.preset).toBe(preset);
      }
    });

    it('round-trips constellation index incl. negative values', () => {
      // con is signed int8 — covers full int8 range
      for (const con of [-128, -1, 0, 50, 87, 127]) {
        const { view } = roundtrip({ con });
        expect(view.con).toBe(con);
      }
    });
  });

  describe('flag byte (packFlags/unpackFlags)', () => {
    it('round-trips showGalacticGrid', () => {
      const { view } = roundtrip({ showGalacticGrid: true });
      expect(view.showGalacticGrid).toBe(true);
    });

    it('round-trips showHud', () => {
      const { view } = roundtrip({ showHud: true });
      expect(view.showHud).toBe(true);
    });

    it('round-trips showConstellation=false', () => {
      const { view } = roundtrip({ showConstellation: false });
      expect(view.showConstellation).toBe(false);
    });

    it('round-trips showMilkyway=false', () => {
      const { view } = roundtrip({ showMilkyway: false });
      expect(view.showMilkyway).toBe(false);
    });

    it('round-trips unit=ly', () => {
      const { view } = roundtrip({ unit: 'ly' });
      expect(view.unit).toBe('ly');
    });

    it('round-trips mode=observe', () => {
      const { view } = roundtrip({ mode: 'observe' });
      expect(view.mode).toBe('observe');
    });

    it('round-trips chart only when mode is observe', () => {
      // chart with mode=observe → encoded
      const { view: a } = roundtrip({ chart: true, mode: 'observe' });
      expect(a.chart).toBe(true);
      expect(a.mode).toBe('observe');

      // chart without mode=observe → dropped (chart-mode is observe-gated)
      const { view: b } = roundtrip({ chart: true });
      expect(b.chart).toBeUndefined();
    });

    it('round-trips multiple flags simultaneously', () => {
      const { view } = roundtrip({
        showGalacticGrid: true,
        showHud: true,
        showConstellation: false,
        unit: 'ly',
      });
      expect(view.showGalacticGrid).toBe(true);
      expect(view.showHud).toBe(true);
      expect(view.showConstellation).toBe(false);
      expect(view.unit).toBe('ly');
    });

    it('default flags are not encoded (no flags byte)', () => {
      // No flag bits → flags field is absent → smaller blob than +1 byte
      const empty = encodeBlob({});
      const withFlag = encodeBlob({ showGalacticGrid: true });
      expect(withFlag.length).toBeGreaterThan(empty.length);
    });
  });

  describe('star refs (focus, to)', () => {
    it('round-trips HIP-tagged focus', () => {
      const focus: StarRef = { kind: 'hip', id: 32349 }; // Sirius
      const { view } = roundtrip({ focus });
      expect(view.focus).toEqual(focus);
    });

    it('round-trips index-tagged focus', () => {
      const focus: StarRef = { kind: 'index', id: 12345 };
      const { view } = roundtrip({ focus });
      expect(view.focus).toEqual(focus);
    });

    it('round-trips id=0 with HIP tag', () => {
      // id=0 is unusual but the tag bit must still be honoured
      const focus: StarRef = { kind: 'hip', id: 0 };
      const { view } = roundtrip({ focus });
      expect(view.focus).toEqual(focus);
    });

    it('round-trips id=0 with index tag', () => {
      const focus: StarRef = { kind: 'index', id: 0 };
      const { view } = roundtrip({ focus });
      expect(view.focus).toEqual(focus);
    });

    it('round-trips id at 23-bit boundary in v2', () => {
      const maxId = 0x7fffff; // 8,388,607 — top of v2's 23-bit id space
      const focus: StarRef = { kind: 'index', id: maxId };
      const { view } = roundtrip({ focus });
      expect(view.focus).toEqual(focus);
    });

    it('round-trips HIP id at 23-bit boundary in v2', () => {
      const focus: StarRef = { kind: 'hip', id: 0x7fffff };
      const { view } = roundtrip({ focus });
      expect(view.focus).toEqual(focus);
    });

    it("'cleared' focus uses zero-byte sentinel and round-trips", () => {
      const { view } = roundtrip({ focus: 'cleared' });
      expect(view.focus).toBe('cleared');
    });

    it("'cleared' is mutually exclusive with a star ref in encode", () => {
      // Encoding a star ref takes priority over 'cleared' when both are
      // somehow set — actually they aren't set together because focus is
      // a discriminated union. But the focusCleared bit only fires when
      // focus === 'cleared'.
      const ref: StarRef = { kind: 'hip', id: 100 };
      const { view } = roundtrip({ focus: ref });
      expect(view.focus).toEqual(ref);
    });

    it('round-trips vector-to (to)', () => {
      const to: StarRef = { kind: 'hip', id: 32349 };
      const { view } = roundtrip({ to });
      expect(view.to).toEqual(to);
    });
  });

  describe('cloud refs', () => {
    it('round-trips cloud index', () => {
      const { view } = roundtrip({ cloud: 42 });
      expect(view.cloud).toBe(42);
    });

    it('round-trips toc (vector-to-cloud)', () => {
      const { view } = roundtrip({ toc: 7 });
      expect(view.toc).toBe(7);
    });

    it('round-trips u8 cloud boundary (255)', () => {
      const { view } = roundtrip({ cloud: 255 });
      expect(view.cloud).toBe(255);
    });
  });

  describe('POIs (variable-length)', () => {
    it('round-trips a single POI', () => {
      const { view } = roundtrip({ pois: [32349] });
      expect(view.pois).toEqual([32349]);
    });

    it('round-trips multiple POIs in order', () => {
      const pois = [100, 200, 300, 400, 500];
      const { view } = roundtrip({ pois });
      expect(view.pois).toEqual(pois);
    });

    it('truncates POIs above the 16-entry cap', () => {
      const pois = Array.from({ length: 25 }, (_, i) => 1000 + i);
      const { view } = roundtrip({ pois });
      expect(view.pois).toHaveLength(16);
      expect(view.pois![0]).toBe(1000);
      expect(view.pois![15]).toBe(1015);
    });

    it('round-trips exactly 16 POIs (the cap)', () => {
      const pois = Array.from({ length: 16 }, (_, i) => 2000 + i);
      const { view } = roundtrip({ pois });
      expect(view.pois).toEqual(pois);
    });

    it('round-trips POI with HIP at v2 24-bit boundary', () => {
      const { view } = roundtrip({ pois: [0x7fffff] });
      expect(view.pois).toEqual([0x7fffff]);
    });

    it('empty POI array is not encoded as present', () => {
      // pois: [] → isPresent returns false → not in blob
      const empty = encodeBlob({});
      const emptyPois = encodeBlob({ pois: [] });
      expect(emptyPois.length).toBe(empty.length);
    });
  });

  describe('full-state round-trip', () => {
    it('round-trips a realistic shared-URL state', () => {
      const view: DecodedView = {
        cam: [50, -20, 100],
        tgt: [0, 0, 0],
        fov: 45,
        mag: 6.5,
        dmax: 500,
        spect: 0b111111110, // hide M-class
        preset: 'binoculars',
        smin: 2.5,
        smax: 18,
        span: 8,
        showGalacticGrid: true,
        showConstellation: false,
        unit: 'ly',
        focus: { kind: 'hip', id: 32349 },
        mode: 'observe',
        chart: true,
        pois: [100, 200, 300],
      };
      const { view: out, version } = roundtrip(view);
      expect(version).toBe(3);
      expect(out.cam).toEqual(view.cam);
      // tgt=[0,0,0] matches the per-key default in v3 → elided. Same
      // contract as up=[0,1,0] and worldOffset=[0,0,0]. Receiver
      // recomputes tgt from default.
      expect(out.tgt).toBeUndefined();
      expect(out.fov).toBe(45);
      expect(out.mag).toBeCloseTo(6.5, 1);
      expect(out.dmax).toBe(500);
      expect(out.spect).toBe(view.spect);
      expect(out.preset).toBe('binoculars');
      expect(out.smin).toBeCloseTo(2.5, 1);
      expect(out.smax).toBeCloseTo(18, 1);
      expect(out.span).toBeCloseTo(8, 1);
      expect(out.showGalacticGrid).toBe(true);
      expect(out.showConstellation).toBe(false);
      expect(out.unit).toBe('ly');
      expect(out.focus).toEqual(view.focus);
      expect(out.mode).toBe('observe');
      expect(out.chart).toBe(true);
      expect(out.pois).toEqual(view.pois);
    });
  });

  describe('version dispatch', () => {
    it('rejects unknown version with descriptive error', () => {
      // Construct a blob with version=99 (one byte = base64 'YwAA' → 'Yw')
      const dv = new DataView(new ArrayBuffer(4));
      dv.setUint8(0, 99);
      const bytes = new Uint8Array(dv.buffer);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      const blob = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(() => decodeBlob(blob)).toThrow(/version: 99/);
    });

    it('rejects empty blob', () => {
      expect(() => decodeBlob('')).toThrow();
    });

    it('rejects v2 blob too short to contain a presence mask', () => {
      // Just version byte 0x02, no mask
      const blob = btoa('\x02').replace(/=+$/, '');
      expect(() => decodeBlob(blob)).toThrow(/v2 blob too short/);
    });
  });

  describe('v1 backward compatibility', () => {
    // Manually-constructed v1 blobs verify the legacy decoder still
    // works and reports version=1 so callers can trigger a rewrite.

    function buildV1Blob(mask: number, payload: Uint8Array): string {
      const ab = new ArrayBuffer(5 + payload.length);
      const dv = new DataView(ab);
      dv.setUint8(0, 1); // version
      dv.setUint32(1, mask >>> 0, true); // 32-bit mask in v1
      const bytes = new Uint8Array(ab);
      bytes.set(payload, 5);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    it('decodes v1 empty blob and reports version=1', () => {
      const blob = buildV1Blob(0, new Uint8Array(0));
      const { view, version } = decodeBlob(blob);
      expect(version).toBe(1);
      expect(view).toEqual({});
    });

    it('decodes v1 fov as float32 (not quantised)', () => {
      // v1 bit 3 = fov, 4 bytes f32 LE
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setFloat32(0, 75.5, true);
      const blob = buildV1Blob(1 << 3, payload);
      const { view, version } = decodeBlob(blob);
      expect(version).toBe(1);
      expect(view.fov).toBeCloseTo(75.5, 5);
    });

    it('decodes v1 star ref as 4-byte u32', () => {
      // v1 bit 14 = focus, 4 bytes u32 LE
      const FOCUS_HIP_TAG = 0x80000000;
      const id = 32349;
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, (id | FOCUS_HIP_TAG) >>> 0, true);
      const blob = buildV1Blob(1 << 14, payload);
      const { view, version } = decodeBlob(blob);
      expect(version).toBe(1);
      expect(view.focus).toEqual({ kind: 'hip', id: 32349 });
    });

    it('decodes v1 POI list with 4-byte HIP entries', () => {
      // v1 bit 19 = pois, 1-byte count + 4 bytes per HIP
      const hips = [100, 200, 300];
      const payload = new Uint8Array(1 + hips.length * 4);
      const dv = new DataView(payload.buffer);
      dv.setUint8(0, hips.length);
      for (let i = 0; i < hips.length; i++) {
        dv.setUint32(1 + i * 4, hips[i] >>> 0, true);
      }
      const blob = buildV1Blob(1 << 19, payload);
      const { view, version } = decodeBlob(blob);
      expect(version).toBe(1);
      expect(view.pois).toEqual(hips);
    });

    it('caps v1 POI count at 16 even when blob declares more', () => {
      // count byte = 25, but only 16 should decode
      const count = 25;
      const payload = new Uint8Array(1 + count * 4);
      const dv = new DataView(payload.buffer);
      dv.setUint8(0, count);
      for (let i = 0; i < count; i++) dv.setUint32(1 + i * 4, 1000 + i, true);
      const blob = buildV1Blob(1 << 19, payload);
      const { view } = decodeBlob(blob);
      expect(view.pois).toHaveLength(16);
    });
  });

  describe('v2 backward compatibility', () => {
    // v2 was the prior schema (1-byte version + 24-bit mask + flat
    // 12-byte vec3 fields). Manually construct v2-shaped blobs to
    // verify decodeV2 still works after v3 became the default writer.

    function buildV2Blob(mask: number, payload: Uint8Array): string {
      const ab = new ArrayBuffer(4 + payload.length);
      const dv = new DataView(ab);
      dv.setUint8(0, 2); // version
      // 24-bit LE mask, same writer as production code uses
      dv.setUint8(1, mask & 0xff);
      dv.setUint8(2, (mask >>> 8) & 0xff);
      dv.setUint8(3, (mask >>> 16) & 0xff);
      const bytes = new Uint8Array(ab);
      bytes.set(payload, 4);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    it('decodes v2 empty blob and reports version=2', () => {
      const blob = buildV2Blob(0, new Uint8Array(0));
      const { view, version } = decodeBlob(blob);
      expect(version).toBe(2);
      expect(view).toEqual({});
    });

    it('decodes v2 cam as a flat 12-byte float32 vec3', () => {
      // v2 bit 0 = cam, 12 bytes f32 LE × 3 — no sub-mask.
      const payload = new Uint8Array(12);
      const dv = new DataView(payload.buffer);
      dv.setFloat32(0, 1.5, true);
      dv.setFloat32(4, -2.25, true);
      dv.setFloat32(8, 3.7, true);
      const blob = buildV2Blob(1 << 0, payload);
      const { view, version } = decodeBlob(blob);
      expect(version).toBe(2);
      expect(view.cam![0]).toBeCloseTo(1.5, 5);
      expect(view.cam![1]).toBeCloseTo(-2.25, 5);
      expect(view.cam![2]).toBeCloseTo(3.7, 5);
    });

    it('decodes v2 fov as quantised u8 (already compressed in v2)', () => {
      // v2 bit 3 = fov, 1 byte u8 (raw=50 → fov = 10 + 50*1 = 60)
      const payload = new Uint8Array([50]);
      const blob = buildV2Blob(1 << 3, payload);
      const { view, version } = decodeBlob(blob);
      expect(version).toBe(2);
      expect(view.fov).toBe(60);
    });

    it('decodes v2 star ref as 3-byte u24', () => {
      // v2 bit 14 = focus, 3 bytes u24 LE; HIP tag = 0x800000
      const FOCUS_HIP_TAG_V2 = 0x800000;
      const id = 32349;
      const tagged = (id | FOCUS_HIP_TAG_V2) >>> 0;
      const payload = new Uint8Array(3);
      payload[0] = tagged & 0xff;
      payload[1] = (tagged >>> 8) & 0xff;
      payload[2] = (tagged >>> 16) & 0xff;
      const blob = buildV2Blob(1 << 14, payload);
      const { view, version } = decodeBlob(blob);
      expect(version).toBe(2);
      expect(view.focus).toEqual({ kind: 'hip', id: 32349 });
    });

    it('decodes v2 POI list with 3-byte HIP entries', () => {
      // v2 bit 19 = pois, 1-byte count + 3 bytes per HIP
      const hips = [100, 200, 300];
      const payload = new Uint8Array(1 + hips.length * 3);
      payload[0] = hips.length;
      for (let i = 0; i < hips.length; i++) {
        const off = 1 + i * 3;
        payload[off]     = hips[i]         & 0xff;
        payload[off + 1] = (hips[i] >>> 8)  & 0xff;
        payload[off + 2] = (hips[i] >>> 16) & 0xff;
      }
      const blob = buildV2Blob(1 << 19, payload);
      const { view, version } = decodeBlob(blob);
      expect(version).toBe(2);
      expect(view.pois).toEqual(hips);
    });
  });

  describe('currentStateOf cam-omission', () => {
    // Minimal mock — currentStateOf only reads getters and the camera /
    // controls vec3-shaped fields. Anything not exercised by these tests
    // returns the "default" sentinel so encoder skips that field.
    function makeMockStellata(opts: {
      mode?: 'navigate' | 'observe';
      camPos?: [number, number, number];
      target?: [number, number, number];
      up?: [number, number, number];
      focusedStar?: number | null;
    } = {}): Stellata {
      const mode = opts.mode ?? 'navigate';
      const camPos = opts.camPos ?? [0, 0, 30];
      const tgt = opts.target ?? [0, 0, 0];
      const up = opts.up ?? [0, 1, 0];
      const stub: Partial<Stellata> = {
        getFilter: () => ({ ...DEFAULT_FILTER }),
        getCameraFov: () => DEFAULT_FOV,
        getFocusedStar: () => opts.focusedStar ?? null,
        getFocusedCloud: () => null,
        getVectorTo: () => null,
        getVectorToCloud: () => null,
        getCameraMode: () => mode,
        getPois: () => [],
        // Live `t` — encoder gates emission on isLive(getT()), so returning
        // wall-clock now keeps the existing assertions at "no t in URL".
        getT: () => Date.now() / 1000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getWorldOffset: () => ({ x: 0, y: 0, z: 0 } as any),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        camera: {
          position: { x: camPos[0], y: camPos[1], z: camPos[2] },
          up: { x: up[0], y: up[1], z: up[2] },
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        controls: {
          target: { x: tgt[0], y: tgt[1], z: tgt[2] },
        } as any,
      };
      return stub as Stellata;
    }

    const idMaps: IdMaps = {
      hipToIndex: new Map(),
      indexToHip: new Uint32Array(1),
      starCount: 1,
      solIndex: 0,
    };

    it('omits cam when observe-mode camera is parked at the focal-star origin', () => {
      // PR #1's optimisation: cam=[0,0,0] is the floating-origin local
      // position of the focal star, so it shouldn't roundtrip through the
      // URL. Regression: a future change that points camDefault elsewhere
      // for observe would silently re-introduce the 16 chars.
      const view = currentStateOf(
        makeMockStellata({ mode: 'observe', camPos: [0, 0, 0], focusedStar: 5 }),
        idMaps,
      );
      expect(view.cam).toBeUndefined();
      expect(view.mode).toBe('observe');
    });

    it('emits cam when observe-mode camera is *not* at the focal origin', () => {
      const view = currentStateOf(
        makeMockStellata({ mode: 'observe', camPos: [1, 2, 3], focusedStar: 5 }),
        idMaps,
      );
      expect(view.cam).toEqual([1, 2, 3]);
    });

    it('emits cam when navigate-mode camera is at [0,0,0] (not its default)', () => {
      // Navigate-mode default is [0, 0, 30]; [0, 0, 0] is meaningfully
      // off-default and must round-trip.
      const view = currentStateOf(
        makeMockStellata({ mode: 'navigate', camPos: [0, 0, 0] }),
        idMaps,
      );
      expect(view.cam).toEqual([0, 0, 0]);
    });

    it('omits cam when navigate-mode camera is at the navigate default', () => {
      const view = currentStateOf(
        makeMockStellata({ mode: 'navigate', camPos: [0, 0, 30] }),
        idMaps,
      );
      expect(view.cam).toBeUndefined();
    });
  });

  describe('blob size', () => {
    it('full-default state encodes to ~6 chars (1 version + 3 mask)', () => {
      expect(encodeBlob({}).length).toBe(6);
    });

    it('single-flag state is small', () => {
      // 1 version + 3 mask + 1 flags byte = 5 bytes → 7 chars
      expect(encodeBlob({ showGalacticGrid: true }).length).toBeLessThanOrEqual(8);
    });

    it('encodes shorter than v1 would for the same scalar fields', () => {
      // v2 quantises fov/mag/smin/smax/span to u8, so a state that
      // exercises all five takes 5 bytes of payload vs 20 in v1.
      const blob = encodeBlob({
        fov: 60, mag: 5, smin: 3, smax: 20, span: 10,
      });
      // 1 version + 3 mask + 5 u8 = 9 bytes → 12 base64url chars
      expect(blob.length).toBeLessThanOrEqual(12);
    });
  });
});
