import * as THREE from 'three';
import type { Starfield } from './starfield';

const RADIUS_PX = 24;

export function createFocusRingOverlay(starfield: Starfield) {
  const ring = document.getElementById('focus-ring') as unknown as SVGCircleElement;
  const v = new THREE.Vector3();

  const hide = () => { ring.style.display = 'none'; };
  const show = () => { ring.style.display = ''; };

  const syncVisibility = () => {
    if (starfield.getFocusedStar() === null) hide();
    else show();
  };
  starfield.onFocusChange(syncVisibility);
  syncVisibility();

  starfield.onFrame(() => {
    const idx = starfield.getFocusedStar();
    if (idx === null) return;
    const positions = starfield.localPositions;
    const camera = starfield.camera;
    v.set(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
    v.applyMatrix4(camera.matrixWorldInverse);
    if (v.z > -camera.near) {
      hide();
      return;
    }
    // When the focused star's rendered disc exceeds the ring diameter,
    // the ring becomes redundant chrome on top of the star — hide it.
    // Keeps the zoomed-in view of a resolved disc clean. Hysteresis via
    // the diameter comparison (not diameter + some margin) is acceptable
    // because zoom steps rarely land exactly on the threshold.
    if (starfield.renderedSizePx(idx) > RADIUS_PX * 2) {
      hide();
      return;
    }
    v.applyMatrix4(camera.projectionMatrix);
    if (ring.style.display === 'none') show();
    const sx = (v.x + 1) * 0.5 * window.innerWidth;
    const sy = (1 - v.y) * 0.5 * window.innerHeight;
    ring.setAttribute('cx', sx.toFixed(1));
    ring.setAttribute('cy', sy.toFixed(1));
    ring.setAttribute('r', String(RADIUS_PX));
  });
}
