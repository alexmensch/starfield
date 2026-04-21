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
  const kunit = currentUnit === 'ly' ? 'kly' : 'kpc';
  if (v < 0.01) return v.toFixed(4) + ' ' + unit;
  if (v < 1) return v.toFixed(3) + ' ' + unit;
  if (v < 100) return v.toFixed(1) + ' ' + unit;
  if (v < 10_000) return Math.round(v).toString() + ' ' + unit;
  return (v / 1000).toFixed(1) + ' ' + kunit;
}

// Round a positive value up to the nearest 1, 2, or 5 × 10^N.
export function niceRound(value: number): number {
  if (value <= 0) return 0;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const norm = value / base;
  let nice: number;
  if (norm < 1.5) nice = 1;
  else if (norm < 3.5) nice = 2;
  else if (norm < 7.5) nice = 5;
  else nice = 10;
  return nice * base;
}
