import * as THREE from 'three';
import type { Starfield } from './starfield';
import type { Catalog } from './catalog-loader';

// Number of apparent-magnitude-brightest stars per constellation that define
// its visible "figure". Picked empirically to cover the recognisable
// asterism plus a frame of fainter but still significant stars.
const FIGURE_STARS_PER_CON = 12;

export function createConstellationOverlay(starfield: Starfield) {
  const overlay = document.getElementById('overlay') as unknown as SVGSVGElement;
  const polygon = document.getElementById('con-polygon') as unknown as SVGPolygonElement;

  const figures = buildFigures(starfield.catalog);
  const v = new THREE.Vector3();

  let current = -1;

  const update = () => {
    current = starfield.getFilter().highlightCon;
    if (current < 0) {
      polygon.setAttribute('points', '');
      return;
    }
    tick();
  };

  const tick = () => {
    if (current < 0) return;
    const stars = figures.get(current);
    if (!stars || stars.length < 3) {
      polygon.setAttribute('points', '');
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const camera = starfield.camera;
    const positions = starfield.catalog.positions;
    const screen: Array<[number, number]> = [];
    for (const i of stars) {
      v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      // Transform to view space so we can reject points behind the camera
      // before projecting; project() alone can wrap sign and produce
      // misleading NDC coords for behind-camera points.
      v.applyMatrix4(camera.matrixWorldInverse);
      if (v.z > -camera.near) continue;
      v.applyMatrix4(camera.projectionMatrix);
      screen.push([(v.x + 1) * 0.5 * w, (1 - v.y) * 0.5 * h]);
    }

    if (screen.length < 3) {
      polygon.setAttribute('points', '');
      return;
    }

    const hull = convexHull(screen);
    polygon.setAttribute('points', hull.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
  };

  starfield.onFilterChange(update);
  starfield.onFrame(tick);
  update();

  return { overlay };
}

function buildFigures(catalog: Catalog): Map<number, number[]> {
  // For each constellation, pick the N stars with the lowest apparent magnitude
  // from Sol. These are the ones humans traditionally used to draw the
  // asterism — so the hull of their (fixed) 3D positions gives a shape that
  // deforms recognisably as the viewpoint moves.
  const byCon = new Map<number, Array<{ idx: number; appMag: number }>>();
  for (let i = 0; i < catalog.count; i++) {
    const ci = catalog.constellation[i];
    if (ci === 255) continue;
    const x = catalog.positions[i * 3];
    const y = catalog.positions[i * 3 + 1];
    const z = catalog.positions[i * 3 + 2];
    const dSol = Math.max(Math.sqrt(x * x + y * y + z * z), 0.001);
    const appMag = catalog.absmag[i] + 5 * (Math.log10(dSol) - 1);
    const arr = byCon.get(ci);
    if (!arr) byCon.set(ci, [{ idx: i, appMag }]);
    else arr.push({ idx: i, appMag });
  }

  const out = new Map<number, number[]>();
  for (const [ci, list] of byCon) {
    list.sort((a, b) => a.appMag - b.appMag);
    out.set(ci, list.slice(0, FIGURE_STARS_PER_CON).map((e) => e.idx));
  }
  return out;
}

// Andrew's monotone chain convex hull. Returns the hull counter-clockwise.
function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const n = points.length;
  if (n < 4) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function cross(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}
