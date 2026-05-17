// Molecular cloud hover formatter (stellata-lo5.7). Sibling of the
// star / planet / Local Group / heliopause formatters for the
// molecular-cloud ellipsoid layer.
//
// Layout (per stellata-lo5-hover-conventions Rule 1a):
//   Line 1 — display name (catalog-given, e.g. "Taurus", "Orion A")
//   Line 2 — distance from Sol (auto Mpc / kpc / pc — fmtDistAuto's
//             upper regime is fmtDist; the lower AU regime is
//             unreachable here because cloud distances are ≥ 100 pc)
//   Line 3 — Size <major> × <minor>, the longest and shortest of the
//             three local-frame semi-axes in the same unit suffix.
//             Sphere clouds (Z2020 source) emit equal semi-axes so the
//             pair collapses to "<r> × <r>"; ellipsoid clouds (Z2021T1
//             source) show the genuine major/minor span.
//
// Pure: takes only its inputs as a context bundle. fmtDist / fmtDistAuto
// read the module-level pc/ly unit toggle from distance-util, so tests
// pin the unit explicitly via setUnit('pc') for stable golden strings.
//
// Matches the Local Group formatter's major × minor pattern — both
// surface "the long axis and the short axis" as the size summary,
// reading the same way regardless of whether the renderer treats the
// shape as a disc or an ellipsoid.

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

