// Wall-clock time variable `t` and conversion helpers for the solar-
// system layer (stellata-3re.1).
//
// `t` is a Unix-seconds double. Anything driven by ephemerides
// (planet positions in 3re.3, eventual deep-space probes in ywn) reads
// the live value via `Stellata.getT()`. The value is pinned to "now" in
// v1; the time-scrubber epic (stellata-nmu) plugs in by calling
// `Stellata.setT()` to override.
//
// Variable-star pulsation has its own cosmetic `uTime` clock — it
// keeps ticking regardless of `t` and is not affected by these helpers.

// Julian Date of the Unix epoch (1970-01-01T00:00:00Z). Subtracting
// from any JD gives Unix-seconds × 86400.
const UNIX_EPOCH_JD = 2440587.5;

// Tolerance (seconds) under which a value of `t` is considered "live"
// — i.e. tracking wall-clock now rather than a scrubber-pinned point.
// Driven by the readout (stellata-3re.11) to label "Live" vs an
// explicit timestamp; small enough that the per-second tick still
// reads as live, large enough to absorb scheduler jitter.
const LIVE_TOLERANCE_SEC = 1;

/** Unix-seconds → Julian Date (TDB scale, accurate enough for VSOP87D). */
export function tToJDE(t: number): number {
  return t / 86400 + UNIX_EPOCH_JD;
}

/** True when `t` is within `toleranceSec` of the current wall-clock. */
export function isLive(t: number, toleranceSec: number = LIVE_TOLERANCE_SEC): boolean {
  return Math.abs(t - Date.now() / 1000) < toleranceSec;
}
