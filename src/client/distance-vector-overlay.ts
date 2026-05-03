import * as THREE from 'three';
import type { Stellata } from './stellata';
import { fmtDist } from './distance-util';
import {
  buildArrowSvgPath,
  ARROW_HEAD_DEPTH_PX,
  ARROW_LABEL_OFFSET_PX,
  ARROW_LABEL_PADDING_PX,
} from './arrow-path';

// Source-end offset — shaft starts past the focus ring (radius 24 px) so it
// doesn't crowd the focused star's disc. Matches the Sol/GC arrow start
// offset for visual consistency across all reference arrows.
const SOURCE_OFFSET_PX = 28;
// Cap how far past the viewport the clipped "off-screen" endpoint can extend,
// so the generated SVG path doesn't contain absurd coordinates.
const MAX_OFFSCREEN_FACTOR = 1.5;

export function createDistanceVectorOverlay(
  stellata: Stellata,
  starLabels: Map<number, string>,
) {
  const line = document.getElementById('dist-line') as unknown as SVGPathElement;
  const lineBg = document.getElementById('dist-line-bg') as unknown as SVGPathElement;
  const label = document.getElementById('dist-label') as unknown as SVGTextElement;
  const distUi = document.getElementById('dist-ui') as unknown as SVGGElement;
  const warpText = document.getElementById('dist-warp-text') as unknown as SVGTextElement;
  const WARP_GAP_PX = 10;

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  // Idempotent hide: skip the SVG attribute writes and style mutation when
  // the vector is already hidden. The per-frame handler short-circuits to
  // hide() through several bail paths, so an unguarded hide ran 60×/sec
  // any time no vector was set.
  let visible = false;
  const hide = () => {
    if (!visible) return;
    line.setAttribute('d', '');
    lineBg.setAttribute('d', '');
    // Hide the whole UI group so both label and warp suffix disappear at
    // once. Using display rather than clearing textContent keeps the static
    // warp element in the DOM so its :hover styling keeps working on show.
    distUi.style.display = 'none';
    visible = false;
  };

  stellata.onVectorChange(() => {
    if (stellata.getVectorTo() === null && stellata.getVectorToCloud() === null) hide();
  });
  stellata.onVectorCloudChange(() => {
    if (stellata.getVectorTo() === null && stellata.getVectorToCloud() === null) hide();
  });

  stellata.onFrame(() => {
    // Source: whichever is focused. Star wins when both are set (which
    // shouldn't happen — they're mutually exclusive — but be defensive).
    const fromStar = stellata.getFocusedStar();
    const fromCloud = stellata.getFocusedCloud();
    const toStar = stellata.getVectorTo();
    const toCloud = stellata.getVectorToCloud();
    if ((fromStar === null && fromCloud === null) ||
        (toStar === null && toCloud === null)) { hide(); return; }

    const camera = stellata.camera;
    // Local-frame positions — the camera and projection math operate in
    // whatever frame the floating origin has set (see stellata.ts).
    const positions = stellata.localPositions;
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (fromStar !== null) {
      tmpA.set(positions[fromStar * 3], positions[fromStar * 3 + 1], positions[fromStar * 3 + 2]);
    } else if (fromCloud !== null) {
      const p = stellata.cloudLocalPosition(fromCloud);
      if (!p) { hide(); return; }
      tmpA.copy(p);
    }
    let destLabel = '';
    if (toStar !== null) {
      tmpB.set(positions[toStar * 3], positions[toStar * 3 + 1], positions[toStar * 3 + 2]);
      destLabel = starLabels.get(toStar) ?? `Unnamed #${toStar}`;
    } else if (toCloud !== null) {
      const p = stellata.cloudLocalPosition(toCloud);
      if (!p) { hide(); return; }
      tmpB.copy(p);
      const cat = stellata.getCloudCatalog();
      destLabel = cat ? cat.clouds[toCloud].name : 'Cloud';
    }

    const projected = projectWithNearClip(tmpA, tmpB, camera, w, h);
    if (!projected) { hide(); return; }
    const { pA, pB } = projected;

    // Source inset stays at the focus-ring offset; destination inset is
    // the destination star's actual rendered disc diameter so the tip
    // lands on the disc edge regardless of star size (a supergiant's
    // disc can fill a large fraction of the viewport, while a dwarf is
    // a few pixels). For cloud destinations there's no per-cloud
    // analogue, so fall back to the user's sizeMax slider value.
    const destOffsetPx = toStar !== null
      ? Math.max(stellata.renderedSizePx(toStar), 0)
      : Math.max(stellata.getFilter().sizeMax, 0);
    const dxPx = pB[0] - pA[0];
    const dyPx = pB[1] - pA[1];
    const lenPx = Math.hypot(dxPx, dyPx);
    if (lenPx <= SOURCE_OFFSET_PX + destOffsetPx + 4) { hide(); return; }
    const uxPx = dxPx / lenPx;
    const uyPx = dyPx / lenPx;
    const shaftStartX = pA[0] + uxPx * SOURCE_OFFSET_PX;
    const shaftStartY = pA[1] + uyPx * SOURCE_OFFSET_PX;
    const tipX = pB[0] - uxPx * destOffsetPx;
    const tipY = pB[1] - uyPx * destOffsetPx;

    const d = buildArrowSvgPath(shaftStartX, shaftStartY, tipX, tipY);
    if (!d) { hide(); return; }
    line.setAttribute('d', d);
    lineBg.setAttribute('d', d);

    // True 3D distance, always shown regardless of clipping.
    const dx = tmpB.x - tmpA.x;
    const dy = tmpB.y - tmpA.y;
    const dz = tmpB.z - tmpA.z;
    const distPc = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Place the label just past the chevron tip — same offsets as the
    // Sol/GC arrows so the three reference arrows have identical label
    // geometry. When the tip is off-screen, anchor instead to where the
    // shaft visibly exits the viewport so the label stays attached to
    // the line rather than drifting to a clamped corner.
    const exit = viewportSegmentExit(pA[0], pA[1], tipX, tipY, w, h);
    const anchorX = exit ? exit[0] : tipX;
    const anchorY = exit ? exit[1] : tipY;
    if (!visible) {
      distUi.style.display = '';
      visible = true;
    }
    label.textContent = `${destLabel} · ${fmtDist(distPc)}`;
    // The label is anchor-start so `x` is its left edge; subtract its width
    // from the right-side clamp so the visible text stays inside the
    // viewport when the line exits near the right edge.
    const labelWidth = label.getComputedTextLength();
    const labelAnchorX = anchorX + ARROW_LABEL_OFFSET_PX + ARROW_HEAD_DEPTH_PX;
    const labelAnchorY = anchorY - ARROW_LABEL_OFFSET_PX;
    const mxMax = Math.max(ARROW_LABEL_PADDING_PX, w - ARROW_LABEL_PADDING_PX - labelWidth);
    const mx = Math.max(ARROW_LABEL_PADDING_PX, Math.min(mxMax, labelAnchorX));
    const my = Math.max(ARROW_LABEL_PADDING_PX, Math.min(h - ARROW_LABEL_PADDING_PX, labelAnchorY));
    label.setAttribute('x', mx.toFixed(1));
    label.setAttribute('y', my.toFixed(1));

    // Position the warp affordance to the right of the distance label.
    warpText.setAttribute('x', (mx + labelWidth + WARP_GAP_PX).toFixed(1));
    warpText.setAttribute('y', my.toFixed(1));
  });
}

export function projectWithNearClip(
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

// Liang-Barsky exit point: where does segment (ax,ay)→(bx,by) leave the
// viewport rectangle [0,w]×[0,h]? Returns the b-side intersection (largest
// t in [0,1] that touches the rect) when the segment crosses it, else null.
// Returns null when (bx,by) is already inside — caller treats that as
// "use (bx,by) as-is." Handles the case where (ax,ay) is also off-screen
// (extreme camera drag) by intersecting both ends of the segment with the
// rect; the meaningful t for label placement is the one nearest b.
export function viewportSegmentExit(
  ax: number, ay: number, bx: number, by: number,
  w: number, h: number,
): [number, number] | null {
  if (bx >= 0 && bx <= w && by >= 0 && by <= h) return null;
  const dx = bx - ax;
  const dy = by - ay;
  const ps = [-dx, dx, -dy, dy];
  const qs = [ax, w - ax, ay, h - ay];
  let tEnter = 0;
  let tExit = 1;
  for (let i = 0; i < 4; i++) {
    const p = ps[i];
    const q = qs[i];
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > tExit) return null;
      if (t > tEnter) tEnter = t;
    } else {
      if (t < tEnter) return null;
      if (t < tExit) tExit = t;
    }
  }
  if (tEnter > tExit) return null;
  return [ax + dx * tExit, ay + dy * tExit];
}

