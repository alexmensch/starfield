// Shared types for the hover-label engine (stellata-lo5).
//
// One engine, many providers. Each renderable layer (stars, Sol planets,
// Local Group wireframes, heliopause apex, …) implements `HoverProvider`
// and registers with the engine; the engine handles the pointermove
// listener, the 280 ms delay, cross-provider disambiguation, and the
// #tooltip render. The contract lets future object classes wire in by
// supplying a pick path + a per-class schema, without touching the
// engine.

// One pick result from a single layer's pick path. `tier` mirrors the
// star picker's two-tier shape (prime = cursor inside the rendered
// disc / wireframe envelope; fallback = cursor near the centroid).
// `cameraDistancePc` breaks ties across providers — closer to camera
// wins, matching what a human user expects when one object visually
// sits in front of another.
//
// `hostStarIdx` is an optional sub-layer identity slot used by providers
// whose `idx` alone doesn't pin a unique object — currently the planet
// provider (a planet is identified by `(hostStarIdx, planetIdx)`,
// future-ready for stellata-bk5 multi-host). Layers whose `idx` is
// already a unique catalog row (stars, Local Group, clouds, the lone
// heliopause apex) leave it `undefined`; the engine doesn't read it,
// only the originating provider's `format` does.
export type HoverHit = {
  idx: number;
  cameraDistancePc: number;
  tier: 'prime' | 'fallback';
  hostStarIdx?: number;
};

// What the engine renders into the tooltip. Same shape star hover has
// today (name + sub-lines); every class formats to this contract.
// Keep lines short (≤ 5 entries per stellata-lo5 design gate).
export type HoverPayload = {
  name: string;
  lines: string[];
};

// One renderable layer's hover surface. The engine walks every
// registered provider on each hover tick, collects non-null hits,
// hands them to the disambiguator, then formats the winner.
//
// `kind` identifies the layer for chart-mode styling and debug. Stays
// a string literal union — adding a new class extends the union here.
export interface HoverProvider<TKind extends HoverKind = HoverKind> {
  readonly kind: TKind;
  pick(clientX: number, clientY: number, pxThreshold: number): HoverHit | null;
  // Format receives the full `HoverHit` so a provider whose layer needs
  // sub-layer identity (e.g. the planet provider reading `hostStarIdx`)
  // can decode the winning pick without re-querying state. Star /
  // Local Group / cloud / heliopause providers ignore everything but
  // `hit.idx`.
  format(hit: HoverHit): HoverPayload;
}

export type HoverKind =
  | 'star'
  | 'planet'
  | 'local-group'
  | 'heliopause'
  | 'cloud';
