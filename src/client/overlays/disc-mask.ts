import * as THREE from 'three';
import type { Stellata } from '../stellata';
import { renderedSizePx } from '../camera/star-physics';
import { projectToScreen } from './overlay-project';
import { selectMaskCandidates } from './disc-mask-pure';
import { setNumAttr } from './dirty-attr';

// Per-frame SVG mask updater. Overlays using mask="url(#disc-occlude-mask)"
// render BEHIND close rendered-disc stars. Cutouts are placed for the
// most-recently-focused star + its binary companion (lastFocused, not
// current, so Esc-unfocus doesn't drop the mask while the disc is still
// visible — placeSlot self-evicts when the disc shrinks) plus every
// highlighted-constellation vertex whose disc exceeds the threshold.
//
// Selection contract pinned in disc-mask-pure.test.ts.
const DISC_THRESHOLD_PX = 48;
// Soft cap on the cutout pool. Today's ceiling is the largest Stellarium
// asterism (~40 vertices) + 2 for focal + companion; 64 leaves headroom
// without ever firing in practice. Exceeding it warns once (dev signal
// that the iteration source changed); growth itself is not blocked.
const MAX_MASK_CIRCLES = 64;

interface Slot {
  el: SVGCircleElement;
  lastCx: number;
  lastCy: number;
  lastR: number;
}

export function createDiscMask(stellata: Stellata) {
  const mask = document.getElementById('disc-occlude-mask') as unknown as SVGMaskElement;
  // Remove any placeholder cutout from the static HTML first; we manage the
  // mask children fully from here.
  const original = document.getElementById('disc-mask-cutout');
  if (original) original.remove();

  // Pool of Slot wrappers, grown on demand and never shrunk. Allocations are
  // rare (bounded by max constellation member count + 2 for focal+companion).
  // NaN sentinel init forces the first attribute write through the dirty-
  // track gate even when the desired value happens to match the static
  // -100/-100/0 placeholder.
  const slots: Slot[] = [];
  let capExceededWarned = false;
  const ensureSlots = (n: number) => {
    if (n > MAX_MASK_CIRCLES && !capExceededWarned) {
      console.warn(
        `disc-mask: pool grew to ${n}, exceeds expected ceiling ${MAX_MASK_CIRCLES} — check whether the iteration source changed.`,
      );
      capExceededWarned = true;
    }
    while (slots.length < n) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '-100');
      c.setAttribute('cy', '-100');
      c.setAttribute('r', '0');
      c.setAttribute('fill', 'black');
      mask.appendChild(c);
      slots.push({ el: c, lastCx: NaN, lastCy: NaN, lastR: NaN });
    }
  };

  const v = new THREE.Vector3();

  const clearSlot = (s: Slot) => {
    s.lastCx = setNumAttr(s.el, 'cx', -100, s.lastCx);
    s.lastCy = setNumAttr(s.el, 'cy', -100, s.lastCy);
    s.lastR = setNumAttr(s.el, 'r', 0, s.lastR);
  };

  // Project a star's world position to screen + set a mask circle. Returns
  // whether a circle was placed (false = off-screen / too small).
  const placeSlot = (s: Slot, idx: number): boolean => {
    const size = renderedSizePx({
      catalog: stellata.catalog,
      idx,
      camPos: stellata.camera.position,
      localPositions: stellata.localPositions,
      uniforms: stellata.uniforms,
      filter: stellata.getFilter(),
    });
    if (size <= DISC_THRESHOLD_PX) return false;
    const positions = stellata.localPositions;
    const camera = stellata.camera;
    v.set(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
    const projected = projectToScreen(v, camera, window.innerWidth, window.innerHeight);
    if (!projected) return false;
    s.lastCx = setNumAttr(s.el, 'cx', projected[0], s.lastCx);
    s.lastCy = setNumAttr(s.el, 'cy', projected[1], s.lastCy);
    s.lastR = setNumAttr(s.el, 'r', size * 0.5, s.lastR);
    return true;
  };

  // Cache the highlighted-constellation index so the per-frame tick doesn't
  // re-read getFilter() each frame. Mirrors constellation-overlay.ts (which
  // consumes the same field via the 'filter' event) so the two overlays react
  // to filter mutations through the same mechanism.
  let highlightCon = stellata.getFilter().highlightCon;
  stellata.on('filter', (f) => {
    highlightCon = f.highlightCon;
  });

  // Track the most-recently-focused star + its companion. Updated only on
  // focus *acquisition* (idx !== null); never cleared. This is what keeps
  // the focal-pair mask alive after Esc-unfocus until the disc shrinks.
  let recentFocus: number | null = null;
  let recentCompanion = -1;
  stellata.on('focus', (idx) => {
    if (idx !== null) {
      recentFocus = idx;
      recentCompanion = stellata.catalog.companion[idx];
    }
  });

  // Track how many slots were active last frame so we only clear the
  // tail end of the pool that is no longer used.
  let lastUsed = 0;

  stellata.on('frame', () => {
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
        for (let i = 0; i < lastUsed; i++) clearSlot(slots[i]);
        lastUsed = 0;
      }
      return;
    }

    const candidates = selectMaskCandidates(
      recentFocus,
      recentCompanion,
      highlightCon,
      stellata.catalog.constellations,
    );

    let used = 0;
    for (const idx of candidates) {
      ensureSlots(used + 1);
      if (placeSlot(slots[used], idx)) used++;
    }
    for (let i = used; i < lastUsed; i++) clearSlot(slots[i]);
    lastUsed = used;
  });
}
