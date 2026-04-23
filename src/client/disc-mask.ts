import * as THREE from 'three';
import type { Starfield } from './starfield';

// Per-frame SVG mask updater. Overlays that should appear BEHIND any close
// rendered-disc star apply `mask="url(#disc-occlude-mask)"`. This module
// keeps the mask's cutout circles aligned with the currently visible discs.
//
// Which stars to check? In practice, only the few stars the camera is close
// to render as discs. We check the focused star + its binary companion —
// covers the common single and binary-system cases without scanning the
// full catalog. If a star is rendering as a disc without being focused
// (unusual — camera parked close without re-focusing), it won't be masked.
// Can be extended if that edge case starts to matter.
const MAX_MASK_CIRCLES = 4;
const DISC_THRESHOLD_PX = 48;

export function createDiscMask(starfield: Starfield) {
  const mask = document.getElementById('disc-occlude-mask') as unknown as SVGMaskElement;
  // Remove any placeholder cutout from the static HTML first; we manage the
  // mask children fully from here.
  const original = document.getElementById('disc-mask-cutout');
  if (original) original.remove();
  // Preallocate MAX_MASK_CIRCLES child <circle>s and keep them in a local
  // array — we only touch attributes per frame, never add/remove nodes.
  const circles: SVGCircleElement[] = [];
  for (let i = 0; i < MAX_MASK_CIRCLES; i++) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', '-100');
    c.setAttribute('cy', '-100');
    c.setAttribute('r', '0');
    c.setAttribute('fill', 'black');
    mask.appendChild(c);
    circles.push(c);
  }

  const v = new THREE.Vector3();

  const clearCircle = (c: SVGCircleElement) => {
    c.setAttribute('r', '0');
    c.setAttribute('cx', '-100');
    c.setAttribute('cy', '-100');
  };

  // Project a star's world position to screen + set a mask circle. Returns
  // whether a circle was placed (false = off-screen / too small).
  const placeCircle = (c: SVGCircleElement, idx: number): boolean => {
    const size = starfield.renderedSizePx(idx);
    if (size <= DISC_THRESHOLD_PX) return false;
    const positions = starfield.catalog.positions;
    const camera = starfield.camera;
    v.set(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
    v.applyMatrix4(camera.matrixWorldInverse);
    if (v.z > -camera.near) return false;
    v.applyMatrix4(camera.projectionMatrix);
    const cx = (v.x + 1) * 0.5 * window.innerWidth;
    const cy = (1 - v.y) * 0.5 * window.innerHeight;
    c.setAttribute('cx', cx.toFixed(1));
    c.setAttribute('cy', cy.toFixed(1));
    c.setAttribute('r', (size * 0.5).toFixed(1));
    return true;
  };

  starfield.onFrame(() => {
    const candidates: number[] = [];
    const focus = starfield.getFocusedStar();
    if (focus !== null) {
      candidates.push(focus);
      const comp = starfield.catalog.companion[focus];
      if (comp >= 0) candidates.push(comp);
    }
    let used = 0;
    for (const idx of candidates) {
      if (used >= circles.length) break;
      if (placeCircle(circles[used], idx)) used++;
    }
    for (let i = used; i < circles.length; i++) clearCircle(circles[i]);
  });
}
