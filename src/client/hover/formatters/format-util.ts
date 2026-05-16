// Shared helpers for the hover-card formatters (stellata-lo5).
//
// Lifted here at the second usage (Local Group + cloud both surface
// "Size <major> × <minor>" axis pairs) per the named-constants-and-dry
// rule. Future hover surfaces that summarise extended-object axes
// (nebulae, Radcliffe Wave segments, large DSOs) reach for this rather
// than re-implementing the suffix elision.

import { fmtDist } from '../../distance-util';

/**
 * Render a major × minor axis pair as "<major> × <minor> <unit>". Both
 * values run through `fmtDist` so the user-selected pc/ly unit and the
 * decade-tier prefix (k, M) apply; the major's trailing " pc" / " ly"
 * is stripped so the unit suffix appears once at the end. Local Group
 * semi-axes (~50 pc — ~30 kpc) and cloud semi-axes (~5 pc — ~90 pc)
 * both land in the same `fmtDist` decade tier in practice, so the
 * single suffix reads consistently.
 */
export function formatAxisPair(majorPc: number, minorPc: number): string {
  const minor = fmtDist(minorPc);
  const major = fmtDist(majorPc).replace(/\s+(pc|ly)$/, '');
  return `${major} × ${minor}`;
}
