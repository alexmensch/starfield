import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { StellataEventMap } from './stellata';

// Structural pin for the twelve-event surface declared by
// StellataEventMap. The unit-tested `EventBus` core covers
// delivery/unsubscribe in isolation; the integration surface — every
// event in the map is actually emitted from stellata.ts — has no other
// automated check, so a future regression that deletes an emit while
// leaving the type in place would land silently.
//
// The exhaustiveness is enforced at compile time via the typed record
// below: adding an entry to `StellataEventMap` without listing it here
// fails `tsc`. At runtime we then scan stellata.ts for the matching
// `this.bus.emit('<name>'` sites.

const EVENT_NAMES_MAP: Record<keyof StellataEventMap, true> = {
  focus: true,
  cloudFocus: true,
  planetSystem: true,
  filter: true,
  vector: true,
  vectorCloud: true,
  cameraMode: true,
  warp: true,
  focusLerp: true,
  pois: true,
  state: true,
  frame: true,
};
const EVENT_NAMES = Object.keys(EVENT_NAMES_MAP) as (keyof StellataEventMap)[];

describe('StellataEventMap × stellata.ts emit sites', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const stellataSrc = readFileSync(join(here, 'stellata.ts'), 'utf8');
  const emittedNames = new Set(
    [...stellataSrc.matchAll(/this\.bus\.emit\(\s*'([a-zA-Z]+)'/g)].map(
      (m) => m[1],
    ),
  );

  it('pins the surface size — twelve events, no more, no fewer', () => {
    expect(EVENT_NAMES.length).toBe(12);
  });

  it.each(EVENT_NAMES)(
    'event %s has at least one this.bus.emit call site in stellata.ts',
    (name) => {
      expect(emittedNames.has(name)).toBe(true);
    },
  );

  it('every emitted name in stellata.ts is declared in StellataEventMap', () => {
    const declared = new Set<string>(EVENT_NAMES);
    const stray = [...emittedNames].filter((n) => !declared.has(n));
    expect(stray).toEqual([]);
  });
});
