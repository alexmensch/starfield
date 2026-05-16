import { describe, expect, it } from 'vitest';
import { formatHeliopauseHover } from './heliopause-hover-format';

describe('formatHeliopauseHover', () => {
  it('emits the static apex card', () => {
    // Golden output. The apex distance is the upwind termination
    // crossed by Voyager 1 in 2012; the geometry is asymmetric — the
    // 115-161 AU range covers the full ellipsoid's semi-axes (115 AU
    // equatorial flanks per Voyager 2, 161 AU semi-major along the
    // antiapex). Em-dash separator inside the parens for typographic
    // consistency with the rest of stellata's prose.
    const out = formatHeliopauseHover();
    expect(out.name).toBe('Heliopause apex');
    expect(out.lines).toEqual([
      'Distance from Sol 122 AU',
      'Upwind termination region (asymmetric ~115–161 AU)',
    ]);
  });
});
