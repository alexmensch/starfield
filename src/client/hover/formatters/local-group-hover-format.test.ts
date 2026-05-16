import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { setUnit } from '../../ui/distance-util';
import type { LgObject } from '../../local-group/local-group-loader';
import {
  formatLocalGroupHover,
  type LocalGroupHoverFormatContext,
} from './local-group-hover-format';

// Build a synthetic LgObject fixture. Only the fields the formatter
// reads (name, kind, axes, distanceFromSol) matter; centerAbs and quat
// are placeholders. The fixture names match the displayName() output
// of build-local-group-pure for each object — that resolution is the
// build script's responsibility, not the formatter's.
function lg(
  name: string,
  kind: 'disc' | 'ellipsoid',
  axes: [number, number, number],
  distancePc: number,
): LgObject {
  return {
    name,
    id: name.toLowerCase().replace(/\s+/g, '-'),
    centerAbs: new THREE.Vector3(0, 0, 0),
    kind,
    axes,
    quat: new THREE.Quaternion(0, 0, 0, 1),
    source: 'LVDB',
    distanceFromSol: distancePc,
  };
}

function buildCtx(objects: LgObject[]): LocalGroupHoverFormatContext {
  return { objects };
}

describe('formatLocalGroupHover', () => {
  beforeEach(() => {
    // fmtDist / fmtDistAuto read the module-level unit toggle. Pin to pc
    // so the golden strings stay stable regardless of test-runner order.
    setUnit('pc');
  });

  it('formats M31 (catalog designation, disc kind, Mpc-tier distance)', () => {
    // M31 ≈ 776 kpc, stellar-disc semi-axes ~ 25 × 8 kpc with thickness.
    // The displayName() rule treats "M31" as a catalog designation and
    // emits it verbatim — no "Galaxy" suffix. The major axis sits in
    // fmtDist's "k" tier (≥ 10,000 pc) while the semi-thickness drops
    // into the integer-pc tier; both formatters carry their natural
    // suffix so the magnitude gap reads clearly.
    const out = formatLocalGroupHover(0, buildCtx([
      lg('M31', 'disc', [25_000, 25_000, 8_000], 776_000),
    ]));
    expect(out.name).toBe('M31');
    expect(out.lines).toEqual([
      '776k pc',
      'Disc',
      'Size 25k × 8000 pc',
    ]);
  });

  it('formats LMC (display-name override, disc kind, kpc-tier distance)', () => {
    // LMC at 50 kpc, inclined disc with ~5 kpc radius and ~1.5 kpc
    // semi-thickness. displayName('LMC') → "Large Magellanic Cloud" via
    // the override map. Both semi-axes sit in fmtDist's integer-pc tier
    // (< 10,000 pc), no "k" suffix.
    const out = formatLocalGroupHover(0, buildCtx([
      lg('Large Magellanic Cloud', 'disc', [5000, 5000, 1500], 50_000),
    ]));
    expect(out.name).toBe('Large Magellanic Cloud');
    expect(out.lines).toEqual([
      '50k pc',
      'Disc',
      'Size 5000 × 1500 pc',
    ]);
  });

  it('formats Sgr dSph (override-driven ellipsoid, kpc-tier distance)', () => {
    // Sagittarius dSph at ~20 kpc, override axes ~1500 × 800 × 800 pc.
    // displayName for the LVDB key "Sagittarius" applies the default
    // "Dwarf Spheroidal" suffix (no override entry for "Sagittarius"
    // alone, and the LVDB key is not a catalog designation).
    const out = formatLocalGroupHover(0, buildCtx([
      lg('Sagittarius Dwarf Spheroidal', 'ellipsoid', [1500, 800, 800], 20_000),
    ]));
    expect(out.name).toBe('Sagittarius Dwarf Spheroidal');
    expect(out.lines).toEqual([
      '20k pc',
      'Ellipsoid',
      'Size 1500 × 800 pc',
    ]);
  });

  it('formats a faint LVDB dwarf (small ellipsoid, sub-100-pc semi-axes)', () => {
    // Reticulum II — typical ultra-faint dwarf: ~30 kpc distance, ~55 pc
    // half-light radius, near-spherical. Default "Dwarf Spheroidal"
    // suffix from the LVDB key. Below 100 pc fmtDist switches to a
    // one-decimal format ("55.0 pc"); the trailing ".0" is canonical
    // across stellata's distance readouts (scale bar, focused-distance
    // HUD), so the hover label inherits it for consistency.
    const out = formatLocalGroupHover(0, buildCtx([
      lg('Reticulum II Dwarf Spheroidal', 'ellipsoid', [55, 45, 45], 30_000),
    ]));
    expect(out.name).toBe('Reticulum II Dwarf Spheroidal');
    expect(out.lines).toEqual([
      '30k pc',
      'Ellipsoid',
      'Size 55.0 × 45.0 pc',
    ]);
  });

  it('returns empty payload for out-of-range index', () => {
    const out = formatLocalGroupHover(99, buildCtx([]));
    expect(out).toEqual({ name: '', lines: [] });
  });
});
