import { describe, expect, it } from 'vitest';
import { formatHeliopauseHover } from './heliopause-hover-format';

describe('formatHeliopauseHover', () => {
  it('emits the static heliopause card', () => {
    // Golden output. Three asymmetry axes from the Voyager + IBEX/Cassini
    // anchors: 122 AU upwind (V1 termination 2012-08-25), 115 AU lateral
    // (V2 crossing 2018-11-05, idealised as a flat equatorial flank for
    // the ellipsoid fit), 200 AU downwind tail (IBEX/Cassini ENA, kept
    // conservative vs more recent croissant-style models).
    const out = formatHeliopauseHover();
    expect(out.name).toBe('Heliopause');
    expect(out.lines).toEqual([
      '122 AU upwind · 115 AU laterally',
      '200 AU downwind tail',
    ]);
  });
});
