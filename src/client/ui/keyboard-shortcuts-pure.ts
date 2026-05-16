// Pure-math helpers for keyboard-shortcuts.ts. Co-located with the
// constants they read so the production binding and the vitest suite
// share a single source of truth (per stellata-named-constants-and-dry).

/** Window inside which three D presses count as a triple-tap. */
export const D_TRIPLE_TAP_MS = 500;
/** Number of D taps that fire the hidden debug-panel affordance. */
export const D_TRIPLE_TAP_COUNT = 3;

/**
 * Push a tap timestamp into a mutable rolling window, drop expired
 * entries, and report whether the window now contains enough taps to
 * fire. When it does, the window is cleared so the next tap starts a
 * fresh count rather than chaining (4th tap doesn't refire — the next
 * triple-tap needs three fresh presses).
 *
 * Pulled out for testability — the production caller in
 * `keyboard-shortcuts.ts` passes `performance.now()`; tests pass a
 * controlled clock.
 */
export function pushTapAndCheckTriple(
  taps: number[],
  now: number,
  windowMs: number = D_TRIPLE_TAP_MS,
  count: number = D_TRIPLE_TAP_COUNT,
): boolean {
  while (taps.length > 0 && now - taps[0] > windowMs) {
    taps.shift();
  }
  taps.push(now);
  if (taps.length >= count) {
    taps.length = 0;
    return true;
  }
  return false;
}
