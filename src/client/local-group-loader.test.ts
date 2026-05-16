import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadLocalGroup } from './local-group-loader';

interface Raw {
  version: number;
  count: number;
  objects: Array<{
    name: string;
    id: string;
    center: [number, number, number];
    kind: 'disc' | 'ellipsoid';
    axes: [number, number, number];
    quat: [number, number, number, number];
    labelThresholdPc: number | null;
    source: 'LVDB' | 'OVERRIDE';
    distance: number;
  }>;
}

const savedFetch = (globalThis as { fetch?: unknown }).fetch;

function mockFetch(impl: (url: string) => { ok: boolean; json: () => unknown } | Promise<never>) {
  (globalThis as { fetch: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> }).fetch =
    async (url: string) => {
      const r = await impl(url);
      // r might be a thrown rejection (transport error) — handled by impl returning Promise.reject.
      return {
        ok: (r as { ok: boolean }).ok,
        json: async () => (r as { json: () => unknown }).json(),
      };
    };
}

describe('loadLocalGroup', () => {
  beforeEach(() => {
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });
  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = savedFetch;
  });

  it('returns null on network error (no fetch throw upstream)', async () => {
    (globalThis as unknown as { fetch: () => Promise<never> }).fetch =
      () => Promise.reject(new Error('offline'));
    const out = await loadLocalGroup('/local-group.json');
    expect(out).toBeNull();
  });

  it('returns null on 404', async () => {
    mockFetch(() => ({ ok: false, json: () => ({}) }));
    const out = await loadLocalGroup('/local-group.json');
    expect(out).toBeNull();
  });

  it('returns null on unsupported version (forward-compat guard)', async () => {
    const raw: Raw = { version: 2, count: 0, objects: [] };
    mockFetch(() => ({ ok: true, json: () => raw }));
    const out = await loadLocalGroup('/local-group.json');
    expect(out).toBeNull();
  });

  it('parses a v1 catalog into typed Vector3 / Quaternion objects', async () => {
    const raw: Raw = {
      version: 1,
      count: 1,
      objects: [{
        name: 'LMC',
        id: 'lmc',
        center: [15000, 5000, -42000],
        kind: 'disc',
        axes: [4500, 4500, 1000],
        // pre-normalised unit quaternion
        quat: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.01 - 0.04 - 0.09)],
        labelThresholdPc: 30000,
        source: 'OVERRIDE',
        distance: 49590,
      }],
    };
    mockFetch(() => ({ ok: true, json: () => raw }));
    const out = await loadLocalGroup('/local-group.json');
    expect(out).not.toBeNull();
    expect(out!.count).toBe(1);
    const o = out!.objects[0];
    expect(o.name).toBe('LMC');
    expect(o.kind).toBe('disc');
    expect(o.centerAbs.x).toBe(15000);
    expect(o.centerAbs.y).toBe(5000);
    expect(o.centerAbs.z).toBe(-42000);
    expect(o.quat.length()).toBeCloseTo(1, 6);
    expect(o.labelThresholdPc).toBe(30000);
    expect(o.distanceFromSol).toBe(49590);
  });

  it('preserves labelThresholdPc=null for unlabelled (ultra-faint) entries', async () => {
    const raw: Raw = {
      version: 1,
      count: 1,
      objects: [{
        name: 'Bootes_II',
        id: 'bootes-ii',
        center: [0, 0, 0],
        kind: 'ellipsoid',
        axes: [50, 30, 30],
        quat: [0, 0, 0, 1],
        labelThresholdPc: null,
        source: 'LVDB',
        distance: 41690,
      }],
    };
    mockFetch(() => ({ ok: true, json: () => raw }));
    const out = await loadLocalGroup('/local-group.json');
    expect(out!.objects[0].labelThresholdPc).toBeNull();
  });
});
