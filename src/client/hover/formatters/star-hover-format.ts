// Star hover formatter (stellata-lo5.3). Port of the prior inline
// `describeStarDetailed` in main.ts.
//
// Line 1 is the star name (falling back through proper name → Bayer →
// Flamsteed → HIP/HD/HR/Gl → "Unnamed #idx"). Subsequent lines
// progressively disclose: constellation + distance, full spectral
// classification (preserving composite/peculiar markers), and
// variability info if any.
//
// Pure: takes only its inputs as a context bundle, calls no DOM or
// scene APIs. The unit-bound `fmtDist` it calls reads module-level
// state from distance-util — set the unit explicitly in tests via
// `setUnit('pc')` to keep golden output stable.

import { fmtDist } from '../../distance-util';
import type { HoverPayload } from '../hover-types';

export interface StarHoverFormatContext {
  starLabels: Map<number, string>;
  spectralMap: Map<number, string>;
  positions: Float32Array;
  // `constellation` is a Float32Array in the catalog (carried as a
  // vertex attribute); 255 marks "no constellation".
  constellation: Float32Array;
  constellations: ReadonlyArray<{ name: string }>;
  periodDays: Float32Array;
  amplitudeMag: Float32Array;
}

export function formatStarHover(
  idx: number,
  ctx: StarHoverFormatContext,
): HoverPayload {
  const {
    starLabels,
    spectralMap,
    positions,
    constellation,
    constellations,
    periodDays,
    amplitudeMag,
  } = ctx;

  const name = starLabels.get(idx) ?? `Unnamed #${idx}`;
  const conIdx = constellation[idx];
  const con = conIdx !== 255 ? constellations[conIdx].name : '';
  const dist = Math.sqrt(
    positions[idx * 3] ** 2 +
      positions[idx * 3 + 1] ** 2 +
      positions[idx * 3 + 2] ** 2,
  );
  const lines: string[] = [];
  const ctxLine = [con, fmtDist(dist)].filter(Boolean).join(' · ');
  if (ctxLine) lines.push(ctxLine);
  const spect = spectralMap.get(idx);
  if (spect) lines.push(spect);
  const period = periodDays[idx];
  const amp = amplitudeMag[idx];
  if (period > 0 && amp > 0) {
    const periodStr =
      period >= 10 ? `${period.toFixed(0)}d` : `${period.toFixed(2)}d`;
    lines.push(`Variable · Period ${periodStr} · Δmag ${amp.toFixed(1)}`);
  }
  return { name, lines };
}
