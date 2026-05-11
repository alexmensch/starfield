import { describe, it, expect } from 'vitest';
import {
  compareBuildCounts,
  formatCountDiff,
  type BuildCounts,
} from './build-counts';

function baseCounts(): BuildCounts {
  return {
    recordCount: 313242,
    binaryPairs: 100,
    binaryMutualPairs: 50,
    gcvsEntries: 60000,
    gcvsHipXrefs: 11316,
    gcvsHdXrefs: 13926,
    gcvsMatched: 3677,
    ccdmGroups: 4000,
    ccdmResolved: 3500,
    ccdmFlagged: 200,
    nameTableEntries: 350,
    variableCount: 3677,
    searchEntries: 290000,
    solIndex: 100000,
    figureCount: 500,
    figureConstellations: 88,
  };
}

describe('compareBuildCounts', () => {
  it('reports every key as match when expected === actual', () => {
    const counts = baseCounts();
    const diff = compareBuildCounts(counts, counts);
    expect(diff).toHaveLength(Object.keys(counts).length);
    expect(diff.every((d) => d.status === 'match')).toBe(true);
  });

  it('flags only the keys that differ', () => {
    const expected = baseCounts();
    const actual = baseCounts();
    actual.recordCount = 313243;
    actual.gcvsMatched = 3678;
    const diff = compareBuildCounts(expected, actual);
    const mismatches = diff.filter((d) => d.status === 'mismatch');
    expect(mismatches.map((m) => m.key).sort()).toEqual(
      ['gcvsMatched', 'recordCount'].sort(),
    );
    for (const m of mismatches) {
      if (m.status === 'mismatch') {
        expect(m.expected).toBe(expected[m.key]);
        expect(m.actual).toBe(actual[m.key]);
      }
    }
  });

  it('preserves the key order of the actual object', () => {
    const expected = baseCounts();
    const actual = baseCounts();
    const diff = compareBuildCounts(expected, actual);
    expect(diff.map((d) => d.key)).toEqual(Object.keys(actual));
  });
});

describe('formatCountDiff', () => {
  it('produces a single match line when nothing differs', () => {
    const counts = baseCounts();
    const out = formatCountDiff(compareBuildCounts(counts, counts));
    expect(out).toMatch(/all \d+ counts match/);
    expect(out.split('\n')).toHaveLength(1);
  });

  it('lists each mismatch with signed delta', () => {
    const expected = baseCounts();
    const actual = baseCounts();
    actual.recordCount = 313_240; // -2
    actual.gcvsMatched = 3_680;   // +3
    const out = formatCountDiff(compareBuildCounts(expected, actual));
    expect(out).toMatch(/2 of \d+ counts differ/);
    expect(out).toMatch(/recordCount\s+expected 313242, got 313240 \(-2\)/);
    expect(out).toMatch(/gcvsMatched\s+expected 3677, got 3680 \(\+3\)/);
  });

  it('header reports the mismatched count, not the matched count', () => {
    const expected = baseCounts();
    const actual = baseCounts();
    actual.solIndex = 99999;
    const out = formatCountDiff(compareBuildCounts(expected, actual));
    expect(out).toMatch(/1 of \d+ counts differ/);
  });
});
