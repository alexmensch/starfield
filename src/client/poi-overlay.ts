import * as THREE from 'three';
import type { Stellata } from './stellata';
import type { Catalog } from './catalog-loader';
import { fmtDist } from './distance-util';
import {
  buildArrowSvgPath,
  screenDirToTarget,
  ARROW_HEAD_DEPTH_PX,
  ARROW_LABEL_OFFSET_PX,
  ARROW_LABEL_PADDING_PX,
} from './arrow-path';
import { projectToScreen } from './overlay-project';
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
// Half a .toFixed(1) step. Mirrors chart-labels.ts.
const ATTR_DIRTY_PX = 0.05;

interface Entry {
  idx: number;
  arrowPath: SVGPathElement;
  arrowLabel: SVGTextElement;
  ring: SVGCircleElement;
  onScreenLabel: SVGTextElement;
  // Dirty-tracked attribute / style state — POI entries persist for the
  // lifetime of the pin, so storing the last-written value lets the per-
  // frame handler skip identical writes during stationary observe
  // sessions. Sentinels guarantee the first write always happens.
  lastArrowD: string;
  lastArrowLabelDisplay: string;
  lastArrowLabelText: string;
  lastArrowLabelX: number;
  lastArrowLabelY: number;
  lastRingDisplay: string;
  lastRingCx: number;
  lastRingCy: number;
  lastOnScreenLabelDisplay: string;
  lastOnScreenLabelText: string;
  lastOnScreenLabelX: number;
  lastOnScreenLabelY: number;
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

    return {
      idx, arrowPath, arrowLabel, ring, onScreenLabel,
      lastArrowD: '',
      lastArrowLabelDisplay: '',
      lastArrowLabelText: '',
      lastArrowLabelX: -Infinity,
      lastArrowLabelY: -Infinity,
      lastRingDisplay: '',
      lastRingCx: -Infinity,
      lastRingCy: -Infinity,
      lastOnScreenLabelDisplay: '',
      lastOnScreenLabelText: '',
      lastOnScreenLabelX: -Infinity,
      lastOnScreenLabelY: -Infinity,
    };
  }

  function setArrowD(e: Entry, d: string) {
    if (d === e.lastArrowD) return;
    e.arrowPath.setAttribute('d', d);
    e.lastArrowD = d;
  }
  function setArrowLabelDisplay(e: Entry, v: string) {
    if (v === e.lastArrowLabelDisplay) return;
    e.arrowLabel.style.display = v;
    e.lastArrowLabelDisplay = v;
  }
  function setRingDisplay(e: Entry, v: string) {
    if (v === e.lastRingDisplay) return;
    e.ring.style.display = v;
    e.lastRingDisplay = v;
  }
  function setOnScreenLabelDisplay(e: Entry, v: string) {
    if (v === e.lastOnScreenLabelDisplay) return;
    e.onScreenLabel.style.display = v;
    e.lastOnScreenLabelDisplay = v;
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
    setArrowD(e, '');
    setArrowLabelDisplay(e, 'none');
    setRingDisplay(e, 'none');
    setOnScreenLabelDisplay(e, 'none');
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

  stellata.on('pois', syncPool);
  syncPool();

  stellata.on('frame', () => {
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
    const camPos = camera.position;

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
        setArrowD(e, '');
        setArrowLabelDisplay(e, 'none');

        // Ring at the projected star.
        setRingDisplay(e, '');
        if (Math.abs(projected[0] - e.lastRingCx) >= ATTR_DIRTY_PX) {
          e.ring.setAttribute('cx', projected[0].toFixed(1));
          e.lastRingCx = projected[0];
        }
        if (Math.abs(projected[1] - e.lastRingCy) >= ATTR_DIRTY_PX) {
          e.ring.setAttribute('cy', projected[1].toFixed(1));
          e.lastRingCy = projected[1];
        }

        // On-screen label anchored just outside the ring rim along a 45°
        // diagonal. Fixed-pixel offset → label-to-star distance is
        // FOV-invariant; the rendered disc may grow or shrink with FOV
        // but the label stays clear of the ring at all zoom levels.
        const fullText = conCode
          ? `${name} · ${conCode} · ${fmtDist(distPc)}`
          : `${name} · ${fmtDist(distPc)}`;
        setOnScreenLabelDisplay(e, '');
        if (fullText !== e.lastOnScreenLabelText) {
          e.onScreenLabel.textContent = fullText;
          e.lastOnScreenLabelText = fullText;
        }
        const lx = projected[0] + LABEL_DIAG;
        const ly = projected[1] + LABEL_DIAG;
        if (Math.abs(lx - e.lastOnScreenLabelX) >= ATTR_DIRTY_PX) {
          e.onScreenLabel.setAttribute('x', lx.toFixed(1));
          e.lastOnScreenLabelX = lx;
        }
        if (Math.abs(ly - e.lastOnScreenLabelY) >= ATTR_DIRTY_PX) {
          e.onScreenLabel.setAttribute('y', ly.toFixed(1));
          e.lastOnScreenLabelY = ly;
        }
        continue;
      }

      // Off screen — draw arrow on the HUD ring rim. Screen-direction
      // derivation via the shared cascade (target's projection if
      // available, view-space xy fallback otherwise).
      setRingDisplay(e, 'none');
      setOnScreenLabelDisplay(e, 'none');

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

      const sdir = screenDirToTarget(cx, cy, projected, tmpDir, camera);
      if (!sdir) {
        hideEntry(e);
        continue;
      }
      const sux = sdir[0];
      const suy = sdir[1];

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
      setArrowD(e, d);

      // Name-only label clamped to viewport with the same padding the
      // Sol/GC arrows use.
      const labelAnchorX = tipX + ARROW_LABEL_OFFSET_PX + ARROW_HEAD_DEPTH_PX;
      const labelAnchorY = tipY - ARROW_LABEL_OFFSET_PX;
      const sx = clamp(labelAnchorX, ARROW_LABEL_PADDING_PX, w - ARROW_LABEL_PADDING_PX);
      const sy = clamp(labelAnchorY, ARROW_LABEL_PADDING_PX, h - ARROW_LABEL_PADDING_PX);
      setArrowLabelDisplay(e, '');
      if (name !== e.lastArrowLabelText) {
        e.arrowLabel.textContent = name;
        e.lastArrowLabelText = name;
      }
      if (Math.abs(sx - e.lastArrowLabelX) >= ATTR_DIRTY_PX) {
        e.arrowLabel.setAttribute('x', sx.toFixed(1));
        e.lastArrowLabelX = sx;
      }
      if (Math.abs(sy - e.lastArrowLabelY) >= ATTR_DIRTY_PX) {
        e.arrowLabel.setAttribute('y', sy.toFixed(1));
        e.lastArrowLabelY = sy;
      }
    }
  });
}

function labelFor(
  idx: number,
  starLabels: Map<number, string>,
  catalog: Catalog,
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
