// Local Group hover provider (stellata-lo5.5). Sibling of star /
// planet hover providers for the Local Group wireframe layer.
//
// Visibility ⇒ hoverable per stellata-lo5-hover-conventions Rule 2:
// the provider does NOT gate on focused-host / focused-star / mode
// state. `Picker.pickLocalGroupHit` (and `LocalGroupLayer.pick`
// underneath) mirror the renderer's "is this drawn?" predicate — chart
// (mono) mode and the distance-fade smoothstep both encoded by
// `group.visible`. If the wireframe is drawn, the object is hoverable.

import type { Stellata } from '../stellata';
import {
  formatLocalGroupHover,
  type LocalGroupHoverFormatContext,
} from './formatters/local-group-hover-format';
import type { HoverProvider } from './hover-types';

export interface LocalGroupHoverProviderConfig {
  stellata: Stellata;
  context: LocalGroupHoverFormatContext;
}

export function createLocalGroupHoverProvider(
  config: LocalGroupHoverProviderConfig,
): HoverProvider<'local-group'> {
  const { stellata, context } = config;
  return {
    kind: 'local-group',
    pick: (x, y, pxThreshold) => stellata.picker.pickLocalGroupHit(x, y, pxThreshold),
    // LG objects are identified by catalog idx alone — sub-layer host
    // identity (hit.hostStarIdx) is unused for this layer.
    format: (hit) => formatLocalGroupHover(hit.idx, context),
  };
}
