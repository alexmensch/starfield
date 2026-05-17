// Local Group hover formatter. Layout: display name, distance, kind
// ("Disc" | "Ellipsoid"), major × minor size pair.
//
// Apparent V mag is out of scope — the local-group JSON schema has
// no M_V plumbed yet. Pure: tests pin the unit via setUnit('pc').

import { fmtDistAuto } from '../../ui/distance-util';
import {
  maxSemiAxisPc,
  minSemiAxisPc,
  type LgObject,
} from '../../local-group/local-group-loader';
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

