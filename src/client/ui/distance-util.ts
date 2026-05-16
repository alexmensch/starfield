import { AU_PER_PC } from '../solar-system/astronomy-constants';

export type DistanceUnit = 'pc' | 'ly';

export const LY_PER_PC = 3.2615638;
// Below this distance, the pc/ly readout becomes uncomfortably small
// ("0.005 pc") and AU is the more graspable unit — Voyager-class /
// outer-Oort scale. The switch is one-way: pc-or-ly above, AU below.
export const AU_SWITCH_PC = 0.01;

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
  if (v < 1_000_000) {
    const kStr = (v / 1000).toFixed(1).replace(/\.0$/, '');
    return `${kStr}k ${unit}`;
  }
  // Millions: kicks in at 1 Mpc / ~3.26 Mly. Without this tier, M31 at
  // 776 kpc in ly mode renders as "2531k ly" — correct but harder to
  // parse than "2.53M ly". Two decimals so 1.5 Mpc shows as "1.5M pc"
  // (trailing zeros stripped) rather than "2M pc" (lossy round).
  const mStr = (v / 1_000_000).toFixed(2).replace(/\.?0+$/, '');
  return `${mStr}M ${unit}`;
}

// Pc/ly above AU_SWITCH_PC (~0.01 pc ≈ 2063 AU); AU below. The toggle
// only governs the upper regime — close-approach always reads in AU
// regardless of the user's pc/ly preference.
export function fmtDistAuto(pc: number): string {
  if (pc < AU_SWITCH_PC) {
    const au = pc * AU_PER_PC;
    // Tier breakpoints mirror fmtDist's 3 / 1 / integer pattern so the
    // transition across the AU switch reads consistently.
    if (au < 1) return `${au.toFixed(3)} AU`;
    if (au < 100) return `${au.toFixed(1)} AU`;
    return `${Math.round(au)} AU`;
  }
  return fmtDist(pc);
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
