import * as THREE from 'three';
import type { Starfield } from './starfield';

// Pixel radius left blank around every figure-star so lines don't obscure
// the star glyph.
export const STAR_GAP_PX = 9;

export function createConstellationOverlay(starfield: Starfield) {
  const overlay = document.getElementById('overlay') as unknown as SVGSVGElement;
  const figure = document.getElementById('con-figure') as unknown as SVGPathElement;

  const v = new THREE.Vector3();

  let current = -1;
  let chartActive = false;

  const update = () => {
    const f = starfield.getFilter();
    current = f.highlightCon;
    chartActive = f.chart && starfield.getCameraMode() === 'observe';
    if (current < 0 && !chartActive) {
      figure.setAttribute('d', '');
      return;
    }
    tick();
  };

  const tick = () => {
    if (current < 0 && !chartActive) return;

    const cons = starfield.catalog.constellations;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const camera = starfield.camera;
    const positions = starfield.localPositions;

    const segments: string[] = [];
    // Chart mode draws every constellation; otherwise only the highlighted
    // one. Same projection + near-clip path either way.
    const indices: number[] = [];
    if (chartActive) {
      for (let i = 0; i < cons.length; i++) indices.push(i);
    } else if (current >= 0 && current < cons.length) {
      indices.push(current);
    }

    for (const conIdx of indices) {
      const lines = cons[conIdx].lines;
      if (!lines || lines.length === 0) continue;
      for (const polyline of lines) {
        // Project each vertex; null if behind the near plane.
        const projected: Array<[number, number] | null> = polyline.map((i) => {
          v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
          v.applyMatrix4(camera.matrixWorldInverse);
          if (v.z > -camera.near) return null;
          v.applyMatrix4(camera.projectionMatrix);
          return [(v.x + 1) * 0.5 * w, (1 - v.y) * 0.5 * h];
        });

        for (let j = 0; j < projected.length - 1; j++) {
          const a = projected[j];
          const b = projected[j + 1];
          if (!a || !b) continue;
          const seg = shortenedSegment(a, b);
          if (seg) segments.push(seg);
        }
      }
    }
    figure.setAttribute('d', segments.join(''));
  };

  starfield.onFilterChange(update);
  starfield.onCameraModeChange(update);
  starfield.onFrame(tick);
  update();

  return { overlay };
}

// `M..L..` subpath with both endpoints pulled back by STAR_GAP_PX so the
// vertex stars sit in clean circular gaps (combined with stroke-linecap:
// round on the path).
function shortenedSegment(
  a: [number, number],
  b: [number, number],
): string | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len <= STAR_GAP_PX * 2) return null;
  const ux = dx / len;
  const uy = dy / len;
  const sx = a[0] + ux * STAR_GAP_PX;
  const sy = a[1] + uy * STAR_GAP_PX;
  const ex = b[0] - ux * STAR_GAP_PX;
  const ey = b[1] - uy * STAR_GAP_PX;
  return `M${sx.toFixed(1)},${sy.toFixed(1)}L${ex.toFixed(1)},${ey.toFixed(1)}`;
}
