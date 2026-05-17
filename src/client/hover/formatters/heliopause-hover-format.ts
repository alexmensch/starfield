// Heliopause hover formatter. Static payload (geometry is fixed,
// shell doesn't deform on human timescales). See SCIENCE.md §
// Heliopause for the dimensions / apex orientation.
//
// Layout: name; upwind + lateral extents on one line; downwind tail
// on its own line.

import { HELIOPAUSE_UPWIND_APEX_AU } from '../../solar-system/heliopause';
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
