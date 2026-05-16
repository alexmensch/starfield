// Heliopause apex hover formatter (stellata-lo5.6). Sibling of the
// star / planet / Local Group formatters for the heliopause apex
// marker — Sol's upwind termination point at 122 AU (Voyager 1 crossing
// 2012-08-25).
//
// Layout (per stellata-lo5-hover-conventions Rule 1 + 1a):
//   Line 1 — "Heliopause apex" (name)
//   Line 2 — "Distance from Sol 122 AU" (observer-relative, spelled-out
//            quantity prefix per Rule 1)
//   Line 3 — short boundary descriptor: "Upwind termination region
//            (asymmetric ~115-161 AU)". The ~115-161 AU range captures
//            the full ellipsoid's semi-axes — equatorial flanks at
//            115 AU (Voyager 2 crossing 2018-11-05), semi-major axis
//            161 AU along the antiapex direction.
//
// Static payload — no live inputs. Apex distance is a fixed geometric
// constant (the shell never deforms on human timescales). Pure — no
// camera, no Stellata, no THREE — so the test is a plain golden-string
// assertion.

import { HELIOPAUSE_UPWIND_APEX_AU } from '../../heliopause';
import type { HoverPayload } from '../hover-types';

export function formatHeliopauseHover(): HoverPayload {
  return {
    name: 'Heliopause apex',
    lines: [
      `Distance from Sol ${HELIOPAUSE_UPWIND_APEX_AU} AU`,
      'Upwind termination region (asymmetric ~115–161 AU)',
    ],
  };
}
