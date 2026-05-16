// Heliopause hover formatter (stellata-lo5.6). Sibling of the star /
// planet / Local Group formatters for Sol's heliospheric boundary —
// the surface where the outward solar-wind pressure balances the
// inward pressure of the local interstellar medium.
//
// Layout (per stellata-lo5-hover-conventions Rule 1 + 1a):
//   Line 1 — "Heliopause" (name; not "Heliopause apex" because the
//            hover surface covers the whole shell, not just the apex
//            marker)
//   Line 2 — upwind + lateral extents, both observer-relative
//            (heliocentric distances along the two short axes of the
//            ellipsoid). Apex is the Voyager 1 termination crossing
//            2012-08-25; lateral is the Voyager 2 crossing 2018-11-05
//            idealised as a true equatorial flank for the ellipsoid
//            fit.
//   Line 3 — downwind tail extent on its own line. The tail is the
//            dominant asymmetry of the heliosphere (stretched by the
//            ISM flow past Sol) and reads more clearly separated from
//            the two short-axis distances. 200 AU is the IBEX/Cassini
//            ENA estimate — conservative vs more recent "croissant"
//            models (Opher et al. 2020) that extend further.
//
// Static payload — no live inputs. Geometry is a fixed ellipsoid; the
// shell never deforms on human timescales. Pure — no camera, no
// Stellata, no THREE — so the test is a plain golden-string assertion.

import { HELIOPAUSE_UPWIND_APEX_AU } from '../../heliopause';
import type { HoverPayload } from '../hover-types';

// Lateral and downwind extents alongside the upwind constant. Kept
// inline here rather than re-exported from heliopause.ts because they
// aren't independent inputs to the renderer — they're derived from the
// ellipsoid semi-axes + centre offset (lateral = SEMI_EQUATORIAL_AU;
// downwind = SEMI_MAJOR_AU + CENTRE_OFFSET_AU). If the geometry knobs
// in heliopause.ts ever move, update these two lines in lockstep.
const HELIOPAUSE_LATERAL_AU = 115;
const HELIOPAUSE_DOWNWIND_TAIL_AU = 200;

export function formatHeliopauseHover(): HoverPayload {
  return {
    name: 'Heliopause',
    lines: [
      `${HELIOPAUSE_UPWIND_APEX_AU} AU upwind · ${HELIOPAUSE_LATERAL_AU} AU laterally`,
      `${HELIOPAUSE_DOWNWIND_TAIL_AU} AU downwind tail`,
    ],
  };
}
