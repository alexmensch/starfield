import { describe, it, expect } from 'vitest';
import { selectMaskCandidates, type ConstellationLike } from './disc-mask-pure';

const cons = (lines: number[][]): ConstellationLike => ({ lines });

describe('selectMaskCandidates', () => {
  it('returns empty when no focus and no constellation highlighted', () => {
    expect(selectMaskCandidates(null, -1, -1, [])).toEqual([]);
  });

  it('returns just the focus when no companion and no highlight', () => {
    expect(selectMaskCandidates(5, -1, -1, [])).toEqual([5]);
  });

  it('emits focus then companion', () => {
    expect(selectMaskCandidates(5, 6, -1, [])).toEqual([5, 6]);
  });

  it('ignores companion = -1 sentinel', () => {
    expect(selectMaskCandidates(5, -1, -1, [])).toEqual([5]);
  });

  it('walks every vertex of the highlighted constellation', () => {
    const c = [cons([[1, 2, 3]])];
    expect(selectMaskCandidates(null, -1, 0, c)).toEqual([1, 2, 3]);
  });

  it('dedups when focus is itself a vertex of the highlighted constellation', () => {
    const c = [cons([[5, 6, 7]])];
    expect(selectMaskCandidates(5, -1, 0, c)).toEqual([5, 6, 7]);
  });

  it('dedups when companion is also a vertex', () => {
    const c = [cons([[6, 7, 8]])];
    expect(selectMaskCandidates(5, 6, 0, c)).toEqual([5, 6, 7, 8]);
  });

  it('dedups across polylines that share an endpoint', () => {
    // 4 is the shared endpoint of two polylines; should appear once.
    const c = [cons([[1, 2, 4], [4, 5, 6]])];
    expect(selectMaskCandidates(null, -1, 0, c)).toEqual([1, 2, 4, 5, 6]);
  });

  it('ignores conIdx out of bounds', () => {
    const c = [cons([[1, 2, 3]])];
    expect(selectMaskCandidates(null, -1, 99, c)).toEqual([]);
    expect(selectMaskCandidates(null, -1, -5, c)).toEqual([]);
  });

  it('handles a constellation with no lines field', () => {
    const c: ConstellationLike[] = [{}];
    expect(selectMaskCandidates(null, -1, 0, c)).toEqual([]);
  });

  it('emits focus and companion even when conIdx is out of bounds', () => {
    expect(selectMaskCandidates(5, 6, 99, [])).toEqual([5, 6]);
  });

  it('preserves focus-first, companion-second ordering ahead of vertices', () => {
    // Even if a vertex comes earlier numerically, focus/companion win priority.
    const c = [cons([[1, 2, 3]])];
    expect(selectMaskCandidates(9, 8, 0, c)).toEqual([9, 8, 1, 2, 3]);
  });
});
