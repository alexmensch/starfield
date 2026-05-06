import * as THREE from 'three';
import type { Stellata } from './stellata';
import { fmtDist } from './distance-util';
import {
  buildArrowSvgPath,
  projectToScreen,
  screenDirFromCascade,
  ARROW_HEAD_DEPTH_PX,
  ARROW_LABEL_OFFSET_PX,
  ARROW_LABEL_PADDING_PX,
} from './arrow-path';
import { ringRadiusPx } from './hud-overlay';

// Point-of-interest overlay. Single-click on a star in OBSERVE pins it
// (Stellata.togglePoi). The pin renders two ways:
//   - **On screen** (POI projects inside the viewport, with a small
//     pull-in margin so labels don't clip at the edge): a thin ring
//     around the star + a text label `name · ConCode · distance`
//     anchored at a fixed pixel offset from the ring rim. The fixed-px
//     anchor keeps the label-to-star distance constant as FOV changes.
//     Clicking either the ring's label or the star itself toggles the
//     POI off (Stellata.togglePoi).
//   - **Off screen**: a chevron arrow on the HUD ring rim points toward
//     the POI direction, with a name-only label by the chevron tip.
//     Clicking that label slerps the camera so the POI lands at view
//     centre (Stellata.aimAt) — same affordance the Sol/GC labels
//     give in the HUD.
// Visibility is gated as a HUD widget — hidden when cameraMode !=
// observe, when the HUD checkbox is off, during warp (CSS rule), and
// during the navigate↔observe transition.

const ARROW_PIXEL_LENGTH = 110;
const RING_HALO_GAP_PX = 4;
const MIN_SHAFT_PIXEL_LENGTH = 8;
// Detection margin: a star within ~40 px of the viewport edge still counts
// as on-screen so its label survives small look-around drifts without
// flipping to arrow mode every couple of frames.
const ON_SCREEN_PULL_IN_PX = 40;
// Per-POI ring around the pinned star. Same radius as the focus ring so
// the two read as the same kind of indicator. The on-screen label rides
// just outside this rim along a 45° diagonal, which is what makes the
// label-to-star distance FOV-invariant: ring radius is fixed in screen
// pixels regardless of how FOV scales the rendered disc.
const POI_RING_RADIUS_PX = 24;
const LABEL_RIM_GAP_PX = 6;
const LABEL_DIAG = (POI_RING_RADIUS_PX + LABEL_RIM_GAP_PX) / Math.SQRT2;

interface Entry {
  idx: number;
  arrowPath: SVGPathElement;
  arrowLabel: SVGTextElement;
  ring: SVGCircleElement;
  onScreenLabel: SVGTextElement;
}

export function createPoiOverlay(
  stellata: Stellata,
  starLabels: Map<number, string>,
): void {
  const arrowsGroup = document.getElementById('poi-arrows') as unknown as SVGGElement | null;
  const ringsGroup = document.getElementById('poi-rings') as unknown as SVGGElement | null;
  const labelsGroup = document.getElementById('poi-labels') as unknown as SVGGElement | null;
  if (!arrowsGroup || !ringsGroup || !labelsGroup) return;

  const catalog = stellata.catalog;
  const pool = new Map<number, Entry>();

  const tmpStarLocal = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  const tmpAim = new THREE.Vector3();

  function createEntry(idx: number): Entry {
    const NS = 'http://www.w3.org/2000/svg';
    const arrowPath = document.createElementNS(NS, 'path') as SVGPathElement;
    arrowPath.setAttribute('class', 'poi-arrow');
    arrowsGroup!.appendChild(arrowPath);

    const arrowLabel = document.createElementNS(NS, 'text') as SVGTextElement;
    arrowLabel.setAttribute('class', 'poi-arrow-label');
    arrowLabel.setAttribute('text-anchor', 'start');
    arrowLabel.setAttribute('dominant-baseline', 'central');
    arrowsGroup!.appendChild(arrowLabel);

    const ring = document.createElementNS(NS, 'circle') as SVGCircleElement;
    ring.setAttribute('class', 'poi-ring');
    ring.setAttribute('r', POI_RING_RADIUS_PX.toFixed(1));
    ringsGroup!.appendChild(ring);

    const onScreenLabel = document.createElementNS(NS, 'text') as SVGTextElement;
    onScreenLabel.setAttribute('class', 'poi-label');
    onScreenLabel.setAttribute('text-anchor', 'start');
    onScreenLabel.setAttribute('dominant-baseline', 'central');
    labelsGroup!.appendChild(onScreenLabel);

    // Click affordances. On-screen label deselects the POI (the ring is
    // visible so "remove this pin" is the natural action). Off-screen
    // arrow label slerps the camera toward the POI (it isn't visible so
    // "show me where it is" is the natural action). The ring itself
    // stays click-through — the star underneath is already a click
    // target for togglePoi via Stellata.observeSingleClick, and putting
    // pointer-events on the ring would shadow that.
    onScreenLabel.addEventListener('click', () => {
      stellata.togglePoi(idx);
    });
    arrowLabel.addEventListener('click', () => {
      const lp = stellata.localPositions;
      tmpAim.set(lp[idx * 3], lp[idx * 3 + 1], lp[idx * 3 + 2]);
      stellata.aimAt(tmpAim);
    });

    return { idx, arrowPath, arrowLabel, ring, onScreenLabel };
  }

  function destroyEntry(e: Entry) {
    e.arrowPath.remove();
    e.arrowLabel.remove();
    e.ring.remove();
    e.onScreenLabel.remove();
  }

  function syncPool() {
    const pois = stellata.getPois();
    const seen = new Set<number>(pois);
    for (const [idx, e] of pool) {
      if (!seen.has(idx)) {
        destroyEntry(e);
        pool.delete(idx);
      }
    }
    for (const idx of pois) {
      if (!pool.has(idx)) pool.set(idx, createEntry(idx));
    }
  }

  function hideEntry(e: Entry) {
    e.arrowPath.setAttribute('d', '');
    e.arrowLabel.style.display = 'none';
    e.ring.style.display = 'none';
    e.onScreenLabel.style.display = 'none';
  }

  // Idempotent show/hide: track visibility so the per-frame handler
  // doesn't re-set the same display values every idle frame in observe
  // mode (POI overlay is observe-only, so the navigate-mode bail path
  // ran 60×/sec under no-POI conditions).
  let groupsVisible = false;
  function hideAll() {
    if (!groupsVisible) return;
    arrowsGroup!.style.display = 'none';
    ringsGroup!.style.display = 'none';
    labelsGroup!.style.display = 'none';
    groupsVisible = false;
  }

  function showAll() {
    if (groupsVisible) return;
    arrowsGroup!.style.display = '';
    ringsGroup!.style.display = '';
    labelsGroup!.style.display = '';
    groupsVisible = true;
  }

  stellata.onPoisChange(syncPool);
  syncPool();

  stellata.onFrame(() => {
    const pois = stellata.getPois();
    if (pois.length === 0) {
      hideAll();
      return;
    }

    const filter = stellata.getFilter();
    const cameraMode = stellata.getCameraMode();
    const transition = stellata.isObserveTransitionActive();
    const anchorIdx = stellata.getFocusedStar();

    if (cameraMode !== 'observe' || !filter.showHud || transition || anchorIdx === null) {
      hideAll();
      return;
    }

    showAll();

    const camera = stellata.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w * 0.5;
    const cy = h * 0.5;

    // HUD ring radius — POI arrows attach to the same ring as Sol/GC.
    const R = ringRadiusPx(camera.fov, filter.sizeMax);
    const shaftStartPx = R + RING_HALO_GAP_PX;
    const targetMarginPx = Math.max(filter.sizeMax, 0);

    // Aux-step world-distance for screen-direction derivation. Mirrors
    // the formula in hud-overlay.ts. In observe steady state the camera
    // sits at the focal star so distToOrigin → 0; the aux-step
    // collapses and the fallback path (direct POI projection) takes
    // over, which is correct because camera == origin means projecting
    // the POI directly already gives the right angular direction.
    const camPos = camera.position;
    const focalPx = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const distToOrigin = camPos.length(); // origin in local frame is camera position relative to anchor; in observe steady state this is ~0
    const auxStepW = (ARROW_PIXEL_LENGTH * Math.max(distToOrigin, 1e-3)) / Math.max(focalPx, 1);

    // Per-POI distance from observer is in absolute frame (the camera
    // is parked at the focal star).
    const absPos = catalog.positions;
    const ax = absPos[anchorIdx * 3];
    const ay = absPos[anchorIdx * 3 + 1];
    const az = absPos[anchorIdx * 3 + 2];

    const localPositions = stellata.localPositions;

    for (const idx of pois) {
      const e = pool.get(idx);
      if (!e) continue;

      tmpStarLocal.set(
        localPositions[idx * 3],
        localPositions[idx * 3 + 1],
        localPositions[idx * 3 + 2],
      );
      const projected = projectToScreen(tmpStarLocal, camera, w, h);

      const onScreen =
        projected !== null &&
        projected[0] >= ON_SCREEN_PULL_IN_PX &&
        projected[0] <= w - ON_SCREEN_PULL_IN_PX &&
        projected[1] >= ON_SCREEN_PULL_IN_PX &&
        projected[1] <= h - ON_SCREEN_PULL_IN_PX;

      const px = absPos[idx * 3];
      const py = absPos[idx * 3 + 1];
      const pz = absPos[idx * 3 + 2];
      const dx = px - ax;
      const dy = py - ay;
      const dz = pz - az;
      const distPc = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const name = labelFor(idx, starLabels, catalog);
      const conIdx = catalog.constellation[idx];
      const conCode = conIdx !== 255 ? catalog.constellations[conIdx].code : '';

      if (onScreen && projected) {
        // Hide arrow chrome.
        e.arrowPath.setAttribute('d', '');
        e.arrowLabel.style.display = 'none';

        // Ring at the projected star.
        e.ring.style.display = '';
        e.ring.setAttribute('cx', projected[0].toFixed(1));
        e.ring.setAttribute('cy', projected[1].toFixed(1));

        // On-screen label anchored just outside the ring rim along a 45°
        // diagonal. Fixed-pixel offset → label-to-star distance is
        // FOV-invariant; the rendered disc may grow or shrink with FOV
        // but the label stays clear of the ring at all zoom levels.
        const fullText = conCode
          ? `${name} · ${conCode} · ${fmtDist(distPc)}`
          : `${name} · ${fmtDist(distPc)}`;
        e.onScreenLabel.style.display = '';
        e.onScreenLabel.textContent = fullText;
        e.onScreenLabel.setAttribute(
          'x',
          (projected[0] + LABEL_DIAG).toFixed(1),
        );
        e.onScreenLabel.setAttribute(
          'y',
          (projected[1] + LABEL_DIAG).toFixed(1),
        );
        continue;
      }

      // Off screen — draw arrow on the HUD ring rim. Same screen-direction
      // derivation as hud-overlay.ts: try aux-step first, then fall back
      // to direct target projection (reliable in observe steady state).
      e.ring.style.display = 'none';
      e.onScreenLabel.style.display = 'none';

      tmpDir.set(
        tmpStarLocal.x - camPos.x,
        tmpStarLocal.y - camPos.y,
        tmpStarLocal.z - camPos.z,
      );
      const dirLenSq = tmpDir.lengthSq();
      if (dirLenSq < 1e-12) {
        hideEntry(e);
        continue;
      }
      tmpDir.multiplyScalar(1 / Math.sqrt(dirLenSq));

      const screenDir = screenDirFromCascade(
        camPos, tmpDir, auxStepW, projected, cx, cy, camera, w, h,
      );
      if (!screenDir) {
        hideEntry(e);
        continue;
      }
      const [sux, suy] = screenDir;

      // Shaft length defaults to ARROW_PIXEL_LENGTH; shrunk so the tip
      // stops `targetMarginPx` short of the projected target when the
      // POI projects inside the nominal shaft length (close to the
      // viewport edge but still slightly inside the pull-in margin).
      let shaftLengthPx = ARROW_PIXEL_LENGTH;
      if (projected) {
        const tdx = projected[0] - cx;
        const tdy = projected[1] - cy;
        const projAlong = tdx * sux + tdy * suy;
        if (projAlong > 0) {
          const allowed = projAlong - shaftStartPx - targetMarginPx;
          if (allowed < shaftLengthPx) shaftLengthPx = allowed;
        }
      }
      if (shaftLengthPx < MIN_SHAFT_PIXEL_LENGTH) {
        hideEntry(e);
        continue;
      }

      const shaftStartX = cx + sux * shaftStartPx;
      const shaftStartY = cy + suy * shaftStartPx;
      const tipX = shaftStartX + sux * shaftLengthPx;
      const tipY = shaftStartY + suy * shaftLengthPx;

      const d = buildArrowSvgPath(shaftStartX, shaftStartY, tipX, tipY);
      if (!d) {
        hideEntry(e);
        continue;
      }
      e.arrowPath.setAttribute('d', d);

      // Name-only label clamped to viewport with the same padding the
      // Sol/GC arrows use.
      const labelAnchorX = tipX + ARROW_LABEL_OFFSET_PX + ARROW_HEAD_DEPTH_PX;
      const labelAnchorY = tipY - ARROW_LABEL_OFFSET_PX;
      const sx = clamp(labelAnchorX, ARROW_LABEL_PADDING_PX, w - ARROW_LABEL_PADDING_PX);
      const sy = clamp(labelAnchorY, ARROW_LABEL_PADDING_PX, h - ARROW_LABEL_PADDING_PX);
      e.arrowLabel.style.display = '';
      e.arrowLabel.textContent = name;
      e.arrowLabel.setAttribute('x', sx.toFixed(1));
      e.arrowLabel.setAttribute('y', sy.toFixed(1));
    }
  });
}

function labelFor(
  idx: number,
  starLabels: Map<number, string>,
  catalog: { hip: Uint32Array },
): string {
  const fromMap = starLabels.get(idx);
  if (fromMap) return fromMap;
  const hip = catalog.hip[idx];
  if (hip > 0) return `HIP ${hip}`;
  return `#${idx}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

