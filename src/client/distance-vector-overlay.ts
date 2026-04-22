import * as THREE from 'three';
import type { Starfield } from './starfield';
import { fmtDist } from './distance-util';

const CHEVRON_SPACING_PX = 22;
const CHEVRON_HALF_WIDTH = 4;
const CHEVRON_DEPTH = 5;
const START_OFFSET_PX = 28;
const END_OFFSET_PX = 14;
// Cap how far past the viewport the clipped "off-screen" endpoint can extend,
// so the generated SVG path doesn't contain absurd coordinates.
const MAX_OFFSCREEN_FACTOR = 1.5;
// Label must stay inside the viewport even when the vector points off-screen.
const LABEL_PADDING_PX = 50;

export function createDistanceVectorOverlay(starfield: Starfield) {
  const line = document.getElementById('dist-line') as unknown as SVGPathElement;
  const label = document.getElementById('dist-label') as unknown as SVGTextElement;
  const distUi = document.getElementById('dist-ui') as unknown as SVGGElement;
  const warpText = document.getElementById('dist-warp-text') as unknown as SVGTextElement;
  const WARP_GAP_PX = 10;

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  const hide = () => {
    line.setAttribute('d', '');
    // Hide the whole UI group so both label and warp suffix disappear at
    // once. Using display rather than clearing textContent keeps the static
    // warp element in the DOM so its :hover styling keeps working on show.
    distUi.style.display = 'none';
  };

  starfield.onVectorChange(() => {
    if (starfield.getVectorTo() === null) hide();
  });

  starfield.onFrame(() => {
    const fromIdx = starfield.getFocusedStar();
    const toIdx = starfield.getVectorTo();
    if (fromIdx === null || toIdx === null) { hide(); return; }

    const camera = starfield.camera;
    const positions = starfield.catalog.positions;
    const w = window.innerWidth;
    const h = window.innerHeight;

    tmpA.set(positions[fromIdx * 3], positions[fromIdx * 3 + 1], positions[fromIdx * 3 + 2]);
    tmpB.set(positions[toIdx * 3], positions[toIdx * 3 + 1], positions[toIdx * 3 + 2]);

    const projected = projectWithNearClip(tmpA, tmpB, camera, w, h);
    if (!projected) { hide(); return; }
    const { pA, pB } = projected;

    const d = buildChevronPath(pA[0], pA[1], pB[0], pB[1]);
    line.setAttribute('d', d);

    // True 3D distance, always shown regardless of clipping.
    const dx = tmpB.x - tmpA.x;
    const dy = tmpB.y - tmpA.y;
    const dz = tmpB.z - tmpA.z;
    const distPc = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const rawMx = (pA[0] + pB[0]) / 2;
    const rawMy = (pA[1] + pB[1]) / 2 - 10;
    const mx = Math.max(LABEL_PADDING_PX, Math.min(w - LABEL_PADDING_PX, rawMx));
    const my = Math.max(LABEL_PADDING_PX, Math.min(h - LABEL_PADDING_PX, rawMy));
    distUi.style.display = '';
    label.setAttribute('x', mx.toFixed(1));
    label.setAttribute('y', my.toFixed(1));
    label.textContent = fmtDist(distPc);

    // Position the warp affordance to the right of the distance label. The
    // label is anchor-middle so its right edge sits at (mx + width/2); the
    // warp text is anchor-start so its left edge is placed there plus a gap.
    const halfWidth = label.getComputedTextLength() / 2;
    warpText.setAttribute('x', (mx + halfWidth + WARP_GAP_PX).toFixed(1));
    warpText.setAttribute('y', my.toFixed(1));
  });
}

function projectWithNearClip(
  worldA: THREE.Vector3,
  worldB: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): { pA: [number, number]; pB: [number, number] } | null {
  const vA = worldA.clone().applyMatrix4(camera.matrixWorldInverse);
  const vB = worldB.clone().applyMatrix4(camera.matrixWorldInverse);
  const threshold = -camera.near;

  // If the focus star itself is behind the camera, we can't draw a
  // meaningful origin — bail out.
  if (vA.z >= threshold) return null;

  let endView = vB;
  if (vB.z >= threshold) {
    // Destination is behind the camera; clip the segment at the near plane
    // so the chevrons still extend toward where it would be.
    const denom = vB.z - vA.z;
    if (Math.abs(denom) < 1e-9) return null;
    const t = (threshold - vA.z) / denom;
    if (!(t > 0 && t <= 1)) return null;
    endView = vA.clone().lerp(vB, t);
    endView.z = threshold - 1e-4;
  }

  const ndcA = vA.applyMatrix4(camera.projectionMatrix);
  const ndcB = endView.applyMatrix4(camera.projectionMatrix);

  const pA: [number, number] = [
    (ndcA.x + 1) * 0.5 * w,
    (1 - ndcA.y) * 0.5 * h,
  ];
  const pB: [number, number] = [
    (ndcB.x + 1) * 0.5 * w,
    (1 - ndcB.y) * 0.5 * h,
  ];

  // Clip point can project to millions of pixels off-screen; rein it in so the
  // SVG path data stays reasonable while preserving the direction of travel.
  const maxOffset = Math.hypot(w, h) * MAX_OFFSCREEN_FACTOR;
  const dx = pB[0] - pA[0];
  const dy = pB[1] - pA[1];
  const len = Math.hypot(dx, dy);
  if (len > maxOffset && len > 0) {
    const scale = maxOffset / len;
    pB[0] = pA[0] + dx * scale;
    pB[1] = pA[1] + dy * scale;
  }

  return { pA, pB };
}

function buildChevronPath(ax: number, ay: number, bx: number, by: number): string {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len <= START_OFFSET_PX + END_OFFSET_PX + 4) return '';

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  const startT = START_OFFSET_PX / len;
  const endT = 1 - END_OFFSET_PX / len;
  const usablePx = (endT - startT) * len;
  const n = Math.max(1, Math.floor(usablePx / CHEVRON_SPACING_PX));

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = startT + ((i + 0.5) / n) * (endT - startT);
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const apexX = cx + ux * (CHEVRON_DEPTH * 0.5);
    const apexY = cy + uy * (CHEVRON_DEPTH * 0.5);
    const backX = cx - ux * (CHEVRON_DEPTH * 0.5);
    const backY = cy - uy * (CHEVRON_DEPTH * 0.5);
    const wingAX = backX + px * CHEVRON_HALF_WIDTH;
    const wingAY = backY + py * CHEVRON_HALF_WIDTH;
    const wingBX = backX - px * CHEVRON_HALF_WIDTH;
    const wingBY = backY - py * CHEVRON_HALF_WIDTH;
    parts.push(
      `M ${wingAX.toFixed(1)} ${wingAY.toFixed(1)} ` +
      `L ${apexX.toFixed(1)} ${apexY.toFixed(1)} ` +
      `L ${wingBX.toFixed(1)} ${wingBY.toFixed(1)}`,
    );
  }
  return parts.join(' ');
}
