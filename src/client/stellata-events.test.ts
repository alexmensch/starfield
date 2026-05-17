import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { StellataEventMap } from './stellata';

// Structural pin for the twelve-event surface declared by
// StellataEventMap. The unit-tested `EventBus` core covers
// delivery/unsubscribe in isolation; the integration surface — every
// event in the map is actually emitted somewhere under src/client/ —
// has no other automated check, so a future regression that deletes an
// emit while leaving the type in place would land silently.
//
// The exhaustiveness is enforced at compile time via the typed record
// below: adding an entry to `StellataEventMap` without listing it here
// fails `tsc`. At runtime we then walk every `.ts` (excluding tests) in
// src/client and scan for `bus.emit('<name>'` — emitters now live in
// stellata.ts AND the controllers extracted under stellata-9mm.194
// (WarpController is the first; AimController doesn't emit today but
// future controllers will).
//
// The regex matches both `this.bus.emit('foo',` (stellata.ts) and
// `this.deps.bus.emit('foo',` (controllers wiring the bus through deps).

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

function walkSrc(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walkSrc(p, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('StellataEventMap × bus.emit call sites under src/client', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = walkSrc(here, []);
  const emittedNames = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/bus\.emit\(\s*'([a-zA-Z]+)'/g)) {
      emittedNames.add(m[1]);
    }
  }

  it('pins the surface size — twelve events, no more, no fewer', () => {
    expect(EVENT_NAMES.length).toBe(12);
  });

  it.each(EVENT_NAMES)(
    'event %s has at least one bus.emit call site under src/client',
    (name) => {
      expect(emittedNames.has(name)).toBe(true);
    },
  );

  it('every emitted name under src/client is declared in StellataEventMap', () => {
    const declared = new Set<string>(EVENT_NAMES);
    const stray = [...emittedNames].filter((n) => !declared.has(n));
    expect(stray).toEqual([]);
  });
});
