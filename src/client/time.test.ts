import { describe, it, expect, vi, afterEach } from 'vitest';
import { tToJDE, isLive } from './time';

describe('tToJDE', () => {
  it('maps the Unix epoch to JD 2440587.5', () => {
    expect(tToJDE(0)).toBe(2440587.5);
  });

  it('maps J2000.0 (2000-01-01T12:00:00 TT) to JD 2451545.0 within sub-second tolerance', () => {
    // J2000 in Unix-seconds is 946728000 (2000-01-01T12:00:00Z).
    // TT-UTC offset (~64.184s in 2000) is intentionally ignored — VSOP87D
    // is a TDB-scale theory and the helper documents the approximation.
    const jd = tToJDE(946728000);
    expect(Math.abs(jd - 2451545.0)).toBeLessThan(1 / 86400);
  });

  it('round-trips a JD back to seconds within sub-millisecond float64 noise for typical scrubber values', () => {
    // JD at present-epoch Unix-seconds is ~2.46e6, leaving ~9 decimal digits
    // for the fractional day after the integer Float64 chews. Multiplied by
    // 86400 that lands round-trip noise around 1e-4 sec — well below VSOP87
    // sensitivity, but coarser than toBeCloseTo's machine-precision threshold.
    const tIn = 1.78e9; // ~2026
    const jd = tToJDE(tIn);
    const back = (jd - 2440587.5) * 86400;
    expect(Math.abs(back - tIn)).toBeLessThan(1e-3);
  });

  it('advances by exactly one day for a 86400-second delta', () => {
    expect(tToJDE(86400) - tToJDE(0)).toBe(1);
  });
});

describe('isLive', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true for t === now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
    const now = Date.now() / 1000;
    expect(isLive(now)).toBe(true);
  });

  it('returns true within the default 1s tolerance', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
    const now = Date.now() / 1000;
    expect(isLive(now - 0.5)).toBe(true);
    expect(isLive(now + 0.5)).toBe(true);
  });

  it('returns false beyond the default 1s tolerance', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
    const now = Date.now() / 1000;
    expect(isLive(now - 2)).toBe(false);
    expect(isLive(now + 2)).toBe(false);
  });

  it('honours a custom tolerance', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
    const now = Date.now() / 1000;
    expect(isLive(now - 30, 60)).toBe(true);
    expect(isLive(now - 30, 10)).toBe(false);
  });
});
