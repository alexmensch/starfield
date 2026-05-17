// Heliopause apex hover provider. Sibling of the
// star / planet / Local Group providers for the heliopause apex
// marker.
//
// Visibility ⇒ hoverable per hover Rule 2:
// the provider does NOT gate on focused-host / mode state directly.
// `Picker.pickHeliopauseHit` mirrors the renderer's "is the apex
// label drawn?" predicate via the shared `isHeliopauseApexVisible`
// export — single source of truth so the hover surface can't drift
// from the SVG label.
//
// Fallback-only tier — the apex is a labelled point, no rendered
// disc. The pick path returns `tier: 'fallback'` unconditionally; the
// cross-provider disambiguator gives prime hits on other layers
// priority, which is the expected UX (a star or planet visually atop
// the apex marker wins the hover).

import type { Stellata } from '../stellata';
import { formatHeliopauseHover } from './formatters/heliopause-hover-format';
import type { HoverProvider } from './hover-types';

export interface HeliopauseHoverProviderConfig {
  stellata: Stellata;
}

export function createHeliopauseHoverProvider(
  config: HeliopauseHoverProviderConfig,
): HoverProvider<'heliopause'> {
  const { stellata } = config;
  return {
    kind: 'heliopause',
    pick: (x, y, pxThreshold) => stellata.picker.pickHeliopauseHit(x, y, pxThreshold),
    // The apex is the lone object on this layer — no idx decoding,
    // no sub-layer identity. Format is keyed off the constant payload.
    format: () => formatHeliopauseHover(),
  };
}
