// Star hover provider (stellata-lo5.3). The first concrete `HoverProvider`
// against the engine — extracted verbatim from the inline provider that
// previously lived in main.ts.
//
// The pick path delegates to `Picker.pickStarHit`, which wraps the
// canonical pickStar reducer and lifts its winning idx into a `HoverHit`
// (tier + camera distance). The formatter is the pure `formatStarHover`
// against a bound context bundle.

import type { Stellata } from '../stellata';
import { formatStarHover, type StarHoverFormatContext } from './formatters/star-hover-format';
import type { HoverProvider } from './hover-types';

export interface StarHoverProviderConfig {
  stellata: Stellata;
  context: StarHoverFormatContext;
}

export function createStarHoverProvider(
  config: StarHoverProviderConfig,
): HoverProvider<'star'> {
  const { stellata, context } = config;
  return {
    kind: 'star',
    pick: (x, y, pxThreshold) => stellata.picker.pickStarHit(x, y, pxThreshold),
    // Stars are identified by catalog idx alone — sub-layer host
    // identity (hit.hostStarIdx) is unused for this layer.
    format: (hit) => formatStarHover(hit.idx, context),
  };
}
