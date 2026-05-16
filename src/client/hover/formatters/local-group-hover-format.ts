// Local Group hover formatter (stellata-lo5.5). Sibling of the star /
// planet formatters for the Local Group wireframe layer.
//
// Layout (per stellata-lo5-hover-conventions Rule 1a):
//   Line 1 — display name (LVDB-derived, with displayName() rules baked
//             in at build time so the formatter just reads obj.name)
//   Line 2 — distance from Sol (auto Mpc / kpc / pc — fmtDistAuto's
//             upper-regime is fmtDist which carries the "k" / "M"
//             suffix at decade boundaries; the lower AU regime is
//             unreachable here because LG distances are ≥ 50 kpc)
//   Line 3 — kind label ("Disc" | "Ellipsoid"), the geometric shape the
//             wireframe renders (disc plane + thickness markers vs
//             three orthogonal meridians).
//   Line 4 — Size <major> × <minor>, the longest and shortest of the
//             three local-frame semi-axes in the same unit suffix.
//
// Apparent V mag is out of scope per the lo5.5 bead — the local-group
// JSON schema has no M_V plumbed yet (blocked by stellata-7de). Once
// 7de lands, an apparent V mag joins the distance line per Rule 1a.
//
// Pure: takes only its inputs as a context bundle. fmtDist / fmtDistAuto
// read the module-level pc/ly unit toggle from distance-util, so tests
// pin the unit explicitly via setUnit('pc') for stable golden strings.

import { fmtDistAuto } from '../../distance-util';
import {
  maxSemiAxisPc,
  minSemiAxisPc,
  type LgObject,
} from '../../local-group-loader';
import type { HoverPayload } from '../hover-types';
import { formatAxisPair } from './format-util';

export interface LocalGroupHoverFormatContext {
  objects: readonly LgObject[];
}

export function formatLocalGroupHover(
  idx: number,
  ctx: LocalGroupHoverFormatContext,
): HoverPayload {
  const obj = ctx.objects[idx];
  if (!obj) return { name: '', lines: [] };
  const lines: string[] = [
    fmtDistAuto(obj.distanceFromSol),
    obj.kind === 'disc' ? 'Disc' : 'Ellipsoid',
    `Size ${formatAxisPair(maxSemiAxisPc(obj), minSemiAxisPc(obj))}`,
  ];
  return { name: obj.name, lines };
}

