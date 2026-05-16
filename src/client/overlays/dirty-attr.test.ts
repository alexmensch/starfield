import { describe, expect, it, vi } from 'vitest';
import { ATTR_DIRTY_PX, setNumAttr, setStrAttr, setStyle, setText } from './dirty-attr';

function makeEl() {
  return {
    setAttribute: vi.fn(),
    textContent: null as string | null,
    style: {} as unknown as CSSStyleDeclaration,
  };
}

describe('dirty-attr', () => {
  describe('setNumAttr', () => {
    it('writes through and returns new last when delta ≥ ATTR_DIRTY_PX', () => {
      const el = makeEl();
      const next = setNumAttr(el as unknown as Element, 'cx', 12.5, NaN);
      expect(el.setAttribute).toHaveBeenCalledWith('cx', '12.5');
      expect(next).toBe(12.5);
    });

    it('skips write and returns existing last when delta < ATTR_DIRTY_PX', () => {
      const el = makeEl();
      const next = setNumAttr(el as unknown as Element, 'cx', 12.52, 12.5);
      expect(el.setAttribute).not.toHaveBeenCalled();
      expect(next).toBe(12.5);
    });

    it('treats NaN sentinel as forcing the first write', () => {
      const el = makeEl();
      setNumAttr(el as unknown as Element, 'cx', -100, NaN);
      expect(el.setAttribute).toHaveBeenCalledWith('cx', '-100.0');
    });

    it('formats with custom decimals', () => {
      const el = makeEl();
      setNumAttr(el as unknown as Element, 'opacity', 0.123456, NaN, 3);
      expect(el.setAttribute).toHaveBeenCalledWith('opacity', '0.123');
    });

    it('default decimals=1 → threshold ATTR_DIRTY_PX (0.05)', () => {
      const el = makeEl();
      // Just below — skip.
      setNumAttr(el as unknown as Element, 'cx', 10.049, 10);
      expect(el.setAttribute).not.toHaveBeenCalled();
      // At threshold — write.
      setNumAttr(el as unknown as Element, 'cx', 10 + ATTR_DIRTY_PX, 10);
      expect(el.setAttribute).toHaveBeenCalledTimes(1);
    });

    it('decimals=2 derives threshold 0.005 (half a .toFixed(2) step)', () => {
      const el = makeEl();
      // Just below 0.005 — skip.
      setNumAttr(el as unknown as Element, 'r', 1.0049, 1, 2);
      expect(el.setAttribute).not.toHaveBeenCalled();
      // Above 0.005 — write.
      setNumAttr(el as unknown as Element, 'r', 1.006, 1, 2);
      expect(el.setAttribute).toHaveBeenCalledWith('r', '1.01');
    });

    it('decimals=3 derives threshold 0.0005 (half a .toFixed(3) step)', () => {
      const el = makeEl();
      setNumAttr(el as unknown as Element, 'opacity', 0.5004, 0.5, 3);
      expect(el.setAttribute).not.toHaveBeenCalled();
      setNumAttr(el as unknown as Element, 'opacity', 0.501, 0.5, 3);
      expect(el.setAttribute).toHaveBeenCalledWith('opacity', '0.501');
    });
  });

  describe('setStrAttr', () => {
    it('writes through when value differs', () => {
      const el = makeEl();
      const next = setStrAttr(el as unknown as Element, 'd', 'M0,0L1,1', '');
      expect(el.setAttribute).toHaveBeenCalledWith('d', 'M0,0L1,1');
      expect(next).toBe('M0,0L1,1');
    });

    it('skips write when value matches', () => {
      const el = makeEl();
      const next = setStrAttr(el as unknown as Element, 'd', 'X', 'X');
      expect(el.setAttribute).not.toHaveBeenCalled();
      expect(next).toBe('X');
    });
  });

  describe('setText', () => {
    it('writes textContent when value differs', () => {
      const el = makeEl();
      const next = setText(el, 'Sirius · 2.6 pc', '');
      expect(el.textContent).toBe('Sirius · 2.6 pc');
      expect(next).toBe('Sirius · 2.6 pc');
    });

    it('skips write when value matches', () => {
      const el = makeEl();
      el.textContent = 'X';
      setText(el, 'X', 'X');
      expect(el.textContent).toBe('X');
    });
  });

  describe('setStyle', () => {
    it('writes style[prop] when value differs', () => {
      const el = makeEl();
      const next = setStyle(el, 'display', 'none', '\0');
      expect((el.style as unknown as Record<string, string>).display).toBe('none');
      expect(next).toBe('none');
    });

    it('skips write when value matches', () => {
      const el = makeEl();
      setStyle(el, 'display', 'none', 'none');
      expect((el.style as unknown as Record<string, string>).display).toBeUndefined();
    });

    it("poison sentinel '\\0' forces first write through for steady-state ''", () => {
      const el = makeEl();
      const next = setStyle(el, 'pointerEvents', '', '\0');
      expect((el.style as unknown as Record<string, string>).pointerEvents).toBe('');
      expect(next).toBe('');
    });
  });
});
