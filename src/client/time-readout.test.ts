import { describe, it, expect } from 'vitest';
import { createTimeReadout, formatTimeReadout } from './time-readout';
import type { Stellata } from './stellata';

describe('formatTimeReadout', () => {
  it('formats a known Unix-seconds value as plain-English UTC', () => {
    // 2026-05-07T18:23:45Z = Unix-seconds 1778264625.
    const t = Date.UTC(2026, 4, 7, 18, 23, 45) / 1000;
    expect(formatTimeReadout(t)).toBe('7 May 2026, 18:23:45 UTC');
  });

  it('zero-pads single-digit hours / minutes / seconds', () => {
    const t = Date.UTC(2026, 0, 1, 3, 4, 5) / 1000;
    expect(formatTimeReadout(t)).toBe('1 Jan 2026, 03:04:05 UTC');
  });

  it('does NOT zero-pad the day-of-month (matches the chosen plain-English style)', () => {
    const t = Date.UTC(2026, 0, 9, 12, 0, 0) / 1000;
    expect(formatTimeReadout(t)).toBe('9 Jan 2026, 12:00:00 UTC');
  });

  it('handles year boundaries in UTC (no off-by-one from local timezone)', () => {
    const t = Date.UTC(2025, 11, 31, 23, 59, 59) / 1000;
    expect(formatTimeReadout(t)).toBe('31 Dec 2025, 23:59:59 UTC');
  });

  it('renders all 12 month abbreviations correctly', () => {
    const expected = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    for (let m = 0; m < 12; m++) {
      const t = Date.UTC(2026, m, 15, 0, 0, 0) / 1000;
      expect(formatTimeReadout(t)).toBe(`15 ${expected[m]} 2026, 00:00:00 UTC`);
    }
  });

  it('handles fractional Unix-seconds (truncates to integer second)', () => {
    const t = Date.UTC(2026, 4, 7, 18, 23, 45) / 1000 + 0.7;
    // The fractional .7s rounds down in Date because Date(ms) takes ms;
    // 0.7s = 700ms, which is still within the same UTC second.
    expect(formatTimeReadout(t)).toBe('7 May 2026, 18:23:45 UTC');
  });

  it('locale-independent — same output regardless of the browser timezone', () => {
    // J2000 epoch: 2000-01-01T12:00:00 UTC. Has been a common gotcha
    // for naive local-timezone formatters in the past.
    const j2000Unix = 946728000;
    expect(formatTimeReadout(j2000Unix)).toBe('1 Jan 2000, 12:00:00 UTC');
  });
});

describe('createTimeReadout teardown', () => {
  function makeMockStellata() {
    const counts = { planetSystem: 0, filter: 0, warp: 0 };
    const stellata = {
      on(name: 'planetSystem' | 'filter' | 'warp') {
        counts[name]++;
        return () => {
          counts[name]--;
        };
      },
      getT: () => 0,
      getFocusedPlanetSystem: () => null,
      getFilter: () => ({ chart: false }),
      getWarpActive: () => false,
    } as unknown as Stellata;
    return { stellata, counts };
  }

  it('unsubscribes its three bus listeners on teardown', () => {
    // Vitest runs in Node — no DOM. createTimeReadout only touches
    // `el.textContent` and `el.hidden`, so a plain object satisfies it.
    const el = { textContent: '', hidden: true } as unknown as HTMLElement;
    const { stellata, counts } = makeMockStellata();
    const teardown = createTimeReadout({ el, stellata });
    expect(counts).toEqual({ planetSystem: 1, filter: 1, warp: 1 });
    teardown();
    expect(counts).toEqual({ planetSystem: 0, filter: 0, warp: 0 });
  });
});
