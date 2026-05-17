// Molecular cloud hover provider (stellata-lo5.7). Sibling of star /
// planet / Local Group / heliopause providers for the molecular-cloud
// ellipsoid layer.
//
// Visibility ⇒ hoverable per stellata-lo5-hover-conventions Rule 2:
// the provider does NOT gate on focused-host / mode / warp state.
// `Picker.pickCloudHit` mirrors the renderer's "is this drawn?"
// predicate — the cloud layer is attached AND its group is visible —
// so any cloud the user can see surfaces a hover card. The provider
// is registered in main.ts only when `stellata.cloudLayer` is non-null,
// which is itself gated on the un-shelve toggle (currently the
// commented-out `attachClouds(cloudCatalog)` call in main.ts).
//
// Rule 3 — whole-object hit surface for an extended visible object.
// Three.js raycast against the cloud meshes naturally hits the full
// ellipsoid silhouette (front face), so the fallback-tier hit covers
// "anywhere on the cloud you see" without needing a separate label
// rect. Tier is fallback so any star or planet visually atop the
// cloud still wins its own prime hover via the cross-layer
// disambiguator — the cloud never blocks see-through picks.

import type { Stellata } from '../stellata';
import {
  formatCloudHover,
  type CloudHoverFormatContext,
} from './formatters/cloud-hover-format';
import type { HoverProvider } from './hover-types';

export interface CloudHoverProviderConfig {
  stellata: Stellata;
  context: CloudHoverFormatContext;
}

export function createCloudHoverProvider(
  config: CloudHoverProviderConfig,
): HoverProvider<'cloud'> {
  const { stellata, context } = config;
  return {
    kind: 'cloud',
    pick: (x, y, pxThreshold) => stellata.picker.pickCloudHit(x, y, pxThreshold),
    // Cloud objects are identified by catalog idx alone — sub-layer
    // host identity (hit.hostStarIdx) is unused for this layer.
    format: (hit) => formatCloudHover(hit.idx, context),
  };
}
