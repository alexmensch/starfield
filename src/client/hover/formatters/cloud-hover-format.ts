// Molecular cloud hover formatter. Layout: name; distance; major ×
// minor size pair. Z2020 sphere clouds emit equal semi-axes (collapse
// to "<r> × <r>"); Z2021T1 ellipsoids show genuine major/minor span.
//
// Pure: tests pin the unit via setUnit('pc') for stable golden strings.

import type { Cloud } from '../../molecular-clouds/cloud-loader';
import { fmtDistAuto } from '../../ui/distance-util';
import type { HoverPayload } from '../hover-types';
import { formatAxisPair } from './format-util';

export interface CloudHoverFormatContext {
  clouds: readonly Cloud[];
}

export function formatCloudHover(
  idx: number,
  ctx: CloudHoverFormatContext,
): HoverPayload {
  const cloud = ctx.clouds[idx];
  if (!cloud) return { name: '', lines: [] };
  const [ax, ay, az] = cloud.axes;
  const major = Math.max(ax, ay, az);
  const minor = Math.min(ax, ay, az);
  const lines: string[] = [
    fmtDistAuto(cloud.distanceFromSol),
    `Size ${formatAxisPair(major, minor)}`,
  ];
  return { name: cloud.name, lines };
}

