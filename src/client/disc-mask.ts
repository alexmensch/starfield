import * as THREE from 'three';
import type { Stellata } from './stellata';
import { projectToScreen } from './overlay-project';
import { selectMaskCandidates } from './disc-mask-pure';

// Per-frame SVG mask updater. Overlays that should appear BEHIND any close
// rendered-disc star apply `mask="url(#disc-occlude-mask)"`. This module
// keeps the mask's cutout circles aligned with the currently visible discs.
//
// Cutouts are placed for:
//   1. The focused star + its binary companion — common single + binary case.
//   2. Every vertex star in the highlighted constellation whose disc still
//      exceeds the threshold. Without (2), unfocusing a constellation member
//      whose disc remains rendered (camera hasn't moved) leaves the lines
//      painted on top of its disc — the bug stellata-rmo reports. Iterating
//      the highlighted constellation (rather than scanning the full catalog)
//      bounds work to the dozens of vertex stars per constellation, since
//      only a star at a line endpoint can intersect the painted segments.
//
// Not covered: a close star that is neither focal, focal's companion, nor a
// vertex of the highlighted constellation. In practice the user has to
// deliberately park near a non-vertex, non-companion bright star while a
// constellation is highlighted, so this residual gap is a deliberate scope
// (see stellata-9mm.147). The index-selection contract is unit-tested in
// disc-mask-pure.test.ts.
const DISC_THRESHOLD_PX = 48;
// Soft cap on the cutout pool. Today's ceiling is the largest Stellarium
// asterism (~40 vertices) + 2 for focal + companion; 64 leaves headroom
// without ever firing in practice. Exceeding it warns once (dev signal
// that the iteration source changed); growth itself is not blocked.
const MAX_MASK_CIRCLES = 64;

export function createDiscMask(stellata: Stellata) {
  const mask = document.getElementById('disc-occlude-mask') as unknown as SVGMaskElement;
  // Remove any placeholder cutout from the static HTML first; we manage the
  // mask children fully from here.
  const original = document.getElementById('disc-mask-cutout');
  if (original) original.remove();

  // Pool of <circle>s, grown on demand and never shrunk. Allocations are
  // rare (bounded by max constellation member count + 2 for focal+companion).
  const circles: SVGCircleElement[] = [];
  let capExceededWarned = false;
  const ensureCircles = (n: number) => {
    if (n > MAX_MASK_CIRCLES && !capExceededWarned) {
      console.warn(
        `disc-mask: pool grew to ${n}, exceeds expected ceiling ${MAX_MASK_CIRCLES} — check whether the iteration source changed.`,
      );
      capExceededWarned = true;
    }
    while (circles.length < n) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '-100');
      c.setAttribute('cy', '-100');
      c.setAttribute('r', '0');
      c.setAttribute('fill', 'black');
      mask.appendChild(c);
      circles.push(c);
    }
  };

  const v = new THREE.Vector3();

  const clearCircle = (c: SVGCircleElement) => {
    c.setAttribute('r', '0');
    c.setAttribute('cx', '-100');
    c.setAttribute('cy', '-100');
  };

  // Project a star's world position to screen + set a mask circle. Returns
  // whether a circle was placed (false = off-screen / too small).
  const placeCircle = (c: SVGCircleElement, idx: number): boolean => {
    const size = stellata.renderedSizePx(idx);
    if (size <= DISC_THRESHOLD_PX) return false;
    const positions = stellata.localPositions;
    const camera = stellata.camera;
    v.set(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
    const projected = projectToScreen(v, camera, window.innerWidth, window.innerHeight);
    if (!projected) return false;
    c.setAttribute('cx', projected[0].toFixed(1));
    c.setAttribute('cy', projected[1].toFixed(1));
    c.setAttribute('r', (size * 0.5).toFixed(1));
    return true;
  };

  // Cache the highlighted-constellation index so the per-frame tick doesn't
  // re-read getFilter() each frame. Mirrors constellation-overlay.ts (which
  // consumes the same field via onFilterChange) so the two overlays react
  // to filter mutations through the same mechanism.
  let highlightCon = stellata.getFilter().highlightCon;
  stellata.onFilterChange((f) => {
    highlightCon = f.highlightCon;
  });

  // Track how many circles were active last frame so we only clear the
  // tail end of the pool that is no longer used.
  let lastUsed = 0;

  stellata.onFrame(() => {
    // In OBSERVE mode the focal star (and its companion if any) are hidden
    // by the vertex shader, so a mask cutout for them would just be a black
    // hole carved out of overlays for nothing. Other stars are always far
    // away from a camera parked at a focal star (camera position is set to
    // the focal star's local origin in setFocus when observe is engaged),
    // so they don't reach the disc threshold either. Skip mask updates
    // entirely.
    const observe =
      stellata.getCameraMode() === 'observe' || stellata.isObserveTransitionActive();
    if (observe) {
      if (lastUsed > 0) {
        for (let i = 0; i < lastUsed; i++) clearCircle(circles[i]);
        lastUsed = 0;
      }
      return;
    }

    const focus = stellata.getFocusedStar();
    const companion = focus !== null ? stellata.catalog.companion[focus] : -1;
    const candidates = selectMaskCandidates(
      focus,
      companion,
      highlightCon,
      stellata.catalog.constellations,
    );

    let used = 0;
    for (const idx of candidates) {
      ensureCircles(used + 1);
      if (placeCircle(circles[used], idx)) used++;
    }
    for (let i = used; i < lastUsed; i++) clearCircle(circles[i]);
    lastUsed = used;
  });
}
