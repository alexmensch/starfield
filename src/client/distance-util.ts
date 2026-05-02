export type DistanceUnit = 'pc' | 'ly';

export const LY_PER_PC = 3.2615638;

let currentUnit: DistanceUnit = 'pc';
const handlers: Array<(u: DistanceUnit) => void> = [];

export function getUnit(): DistanceUnit { return currentUnit; }

export function setUnit(u: DistanceUnit) {
  if (currentUnit === u) return;
  currentUnit = u;
  for (const h of handlers) h(u);
}

export function onUnitChange(h: (u: DistanceUnit) => void) { handlers.push(h); }

export function fmtDist(pc: number): string {
  const v = currentUnit === 'ly' ? pc * LY_PER_PC : pc;
  const unit = currentUnit === 'ly' ? 'ly' : 'pc';
  if (v < 0.01) return `${v.toFixed(4)} ${unit}`;
  if (v < 1) return `${v.toFixed(3)} ${unit}`;
  if (v < 100) return `${v.toFixed(1)} ${unit}`;
  if (v < 10_000) return `${Math.round(v)} ${unit}`;
  // Thousands: "k" stays glued to the number ("10k pc"); strip trailing
  // ".0" so round values read cleanly.
  const kStr = (v / 1000).toFixed(1).replace(/\.0$/, '');
  return `${kStr}k ${unit}`;
}

// Round a positive value to the nearest 1, 2, 5, or 10 × 10^N. Used by
// the scale bar to pick a clean tick value close to a target pixel width.
export function niceRound(value: number): number {
  if (value <= 0) return 0;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const norm = value / base;
  // Thresholds offset by a tiny epsilon so values that are mathematically
  // *at* the boundary (e.g. 0.15 / 0.1 = 1.4999999999999998 in IEEE-754)
  // snap to the upper side. Without this, decade-scale symmetry breaks:
  // niceRound(1.5) → 2 but niceRound(0.15) → 0.1.
  const eps = 1e-9;
  let nice: number;
  if (norm < 1.5 - eps) nice = 1;
  else if (norm < 3.5 - eps) nice = 2;
  else if (norm < 7.5 - eps) nice = 5;
  else nice = 10;
  return nice * base;
}
