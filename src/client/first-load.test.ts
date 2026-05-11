import { describe, it, expect } from 'vitest';
import { FIRST_LOAD_VIEW } from './first-load';
import { encodeBlob, decodeBlob } from './url-state';
import { AU_PC } from './ephemeris';

describe('first-load', () => {
  describe('FIRST_LOAD_VIEW', () => {
    it('parks the camera at exactly 5 AU from Sol', () => {
      const cam = FIRST_LOAD_VIEW.cam!;
      const r = Math.hypot(cam[0], cam[1], cam[2]);
      expect(r).toBeCloseTo(5 * AU_PC, 14);
    });

    it('preserves the hand-tuned direction toward the galactic centre', () => {
      // The share URL the user picked encoded these (unnormalised) cam
      // components. Renormalising to 5 AU must not change their
      // direction beyond float precision.
      const RAW = [-1.5599102880514693e-6, 1.9162944226991385e-5, 1.4444859516515862e-5];
      const rawLen = Math.hypot(...RAW);
      const cam = FIRST_LOAD_VIEW.cam!;
      const camLen = Math.hypot(cam[0], cam[1], cam[2]);
      for (let i = 0; i < 3; i++) {
        expect(cam[i] / camLen).toBeCloseTo(RAW[i] / rawLen, 12);
      }
    });

    it('does not highlight any constellation', () => {
      // Was Orion in an earlier draft; user dropped the highlight to
      // keep the first-paint screen quieter.
      expect(FIRST_LOAD_VIEW.con).toBeUndefined();
    });

    it('turns on the HUD', () => {
      expect(FIRST_LOAD_VIEW.showHud).toBe(true);
    });

    it('leaves focus implicit so receiver defaults to Sol', () => {
      // The encoder treats `focus === undefined` as the canonical Sol
      // default; emitting a Sol focus would bloat the blob and break
      // the "default state has no `?v=`" contract for unrelated state.
      expect(FIRST_LOAD_VIEW.focus).toBeUndefined();
    });

    it('round-trips through the wire format', () => {
      // Belt-and-suspenders: the constant must decode to itself when
      // pushed through the same encoder/decoder applyFromUrl uses.
      const blob = encodeBlob(FIRST_LOAD_VIEW);
      const { view } = decodeBlob(blob);
      expect(view.con).toBe(FIRST_LOAD_VIEW.con);
      expect(view.showHud).toBe(true);
      const cam = view.cam!;
      // cam encodes as 3 × Float32; ULP at this magnitude (~2e-5 pc) is
      // ~1e-12, so a sub-pc round-trip diff is the float32 floor, not a
      // semantic mismatch. 11 decimals matches the encoder precision.
      expect(Math.hypot(cam[0], cam[1], cam[2])).toBeCloseTo(5 * AU_PC, 11);
    });
  });
});
