import type { Stellata } from '../stellata';

// Live diagnostic readouts for the focused-star pin (uPinFocusToCenter)
// and the camera/target state that drives its engagement guard. Mounted
// as a section inside the unified debug panel (see debug.ts).
//
// What it shows:
//   - Current focus / camera mode / warp+aim flags / pin engaged state.
//   - controls.target now and its latched min/max range per axis (signed —
//     so a tiny accidental pan in a single direction shows up as a non-zero
//     extreme on that axis even if it self-cancels later).
//   - camera.position the same way.
//   - distCam now and latched range; controls.minDistance for context.
//   - Pin flip count and total off-frames, so brief disengagements during
//     a long interaction are visible after the fact.
//
// Why latched extremes: the pin guard threshold is target.lengthSq() < 1e-12
// (target.length < 1e-6 pc). Trackpad / accidental input can pan target by
// orders of magnitude more than that on a sub-second timescale and self-
// dampen back toward zero. Watching only the "now" value misses these
// transient excursions; the latched extremes capture them.
//
// Click the [click to reset latches] label at the bottom to reset extremes
// without dismissing the panel. The body of the section is selectable text
// (drag-select to copy).

interface Latch {
  tgtMaxX: number; tgtMinX: number;
  tgtMaxY: number; tgtMinY: number;
  tgtMaxZ: number; tgtMinZ: number;
  tgtLenMax: number;
  camMaxX: number; camMinX: number;
  camMaxY: number; camMinY: number;
  camMaxZ: number; camMinZ: number;
  distCamMin: number; distCamMax: number;
  pinFlips: number;
  lastPinState: boolean;
  pinOffFrames: number;
}

function emptyLatch(): Latch {
  return {
    tgtMaxX: 0, tgtMinX: 0, tgtMaxY: 0, tgtMinY: 0, tgtMaxZ: 0, tgtMinZ: 0,
    tgtLenMax: 0,
    camMaxX: 0, camMinX: 0, camMaxY: 0, camMinY: 0, camMaxZ: 0, camMinZ: 0,
    distCamMin: Infinity, distCamMax: 0,
    pinFlips: 0, lastPinState: false, pinOffFrames: 0,
  };
}

export interface PinSection {
  element: HTMLDivElement;
  dispose: () => void;
  setVisible: (v: boolean) => void;
}

export function buildPinSection(stellata: Stellata): PinSection {
  const latch = emptyLatch();
  let visible = true;

  const root = document.createElement('div');
  root.style.cssText =
    'font:11px/1.3 ui-monospace,monospace;background:rgba(0,0,0,.85);' +
    'color:#0f0;padding:6px 8px;border-radius:4px;' +
    'white-space:pre;overflow-x:auto;user-select:text;';

  // Body: live readouts. Selectable text so the user can drag-copy values.
  const body = document.createElement('div');
  body.style.cssText = 'user-select:text;cursor:text;';
  root.appendChild(body);

  // Reset link: only THIS element is clickable (so dragging across the body
  // to copy values doesn't reset the latches).
  const reset = document.createElement('div');
  reset.textContent = '[click to reset latches]';
  reset.style.cssText = 'margin-top:6px;cursor:pointer;color:#999;user-select:none;';
  reset.title = 'reset latched extremes';
  reset.addEventListener('click', () => {
    Object.assign(latch, emptyLatch());
  });
  root.appendChild(reset);

  const fmt = (n: number) => {
    if (n === 0) return '0';
    if (!Number.isFinite(n)) return String(n);
    return n.toExponential(2);
  };

  const onFrame = () => {
    const t = stellata.controls.target;
    const c = stellata.camera.position;
    const distCam = Math.hypot(c.x - t.x, c.y - t.y, c.z - t.z);
    const tLen = Math.hypot(t.x, t.y, t.z);
    const pinNow = stellata.isPinEngaged();

    // Latches keep updating regardless of visibility — the user's
    // interaction may have spanned a collapse and we still want the
    // latched extremes to reflect the whole observation window.
    if (t.x > latch.tgtMaxX) latch.tgtMaxX = t.x;
    if (t.x < latch.tgtMinX) latch.tgtMinX = t.x;
    if (t.y > latch.tgtMaxY) latch.tgtMaxY = t.y;
    if (t.y < latch.tgtMinY) latch.tgtMinY = t.y;
    if (t.z > latch.tgtMaxZ) latch.tgtMaxZ = t.z;
    if (t.z < latch.tgtMinZ) latch.tgtMinZ = t.z;
    if (tLen > latch.tgtLenMax) latch.tgtLenMax = tLen;

    if (c.x > latch.camMaxX) latch.camMaxX = c.x;
    if (c.x < latch.camMinX) latch.camMinX = c.x;
    if (c.y > latch.camMaxY) latch.camMaxY = c.y;
    if (c.y < latch.camMinY) latch.camMinY = c.y;
    if (c.z > latch.camMaxZ) latch.camMaxZ = c.z;
    if (c.z < latch.camMinZ) latch.camMinZ = c.z;

    if (distCam < latch.distCamMin) latch.distCamMin = distCam;
    if (distCam > latch.distCamMax) latch.distCamMax = distCam;

    if (pinNow !== latch.lastPinState) { latch.pinFlips++; latch.lastPinState = pinNow; }
    if (!pinNow) latch.pinOffFrames++;

    if (!visible) return;

    body.textContent =
      `focus: ${stellata.getFocusedStar()}  mode: ${stellata.getCameraMode()}\n` +
      `warp:${stellata.getWarpActive()}  aim:${stellata.isAimActive()}\n` +
      `pin: ${pinNow ? 'YES' : 'NO'}  flips:${latch.pinFlips}  off-frames:${latch.pinOffFrames}\n` +
      `\n` +
      `target.lengthSq: ${fmt(t.lengthSq())} (engage <${stellata.getPinEngageThresholdSq()})\n` +
      `target.len now: ${fmt(tLen)}  max: ${fmt(latch.tgtLenMax)}\n` +
      `target.x now: ${fmt(t.x)}  range: [${fmt(latch.tgtMinX)}, ${fmt(latch.tgtMaxX)}]\n` +
      `target.y now: ${fmt(t.y)}  range: [${fmt(latch.tgtMinY)}, ${fmt(latch.tgtMaxY)}]\n` +
      `target.z now: ${fmt(t.z)}  range: [${fmt(latch.tgtMinZ)}, ${fmt(latch.tgtMaxZ)}]\n` +
      `\n` +
      `camera.x now: ${fmt(c.x)}  range: [${fmt(latch.camMinX)}, ${fmt(latch.camMaxX)}]\n` +
      `camera.y now: ${fmt(c.y)}  range: [${fmt(latch.camMinY)}, ${fmt(latch.camMaxY)}]\n` +
      `camera.z now: ${fmt(c.z)}  range: [${fmt(latch.camMinZ)}, ${fmt(latch.camMaxZ)}]\n` +
      `\n` +
      `distCam now: ${fmt(distCam)} pc\n` +
      `distCam range: [${fmt(latch.distCamMin)}, ${fmt(latch.distCamMax)}] pc\n` +
      `controls.minDistance: ${fmt(stellata.controls.minDistance)} pc`;

    root.style.color = pinNow ? '#0f0' : '#f33';
  };

  const unsubscribe = stellata.on('frame', onFrame);

  return {
    element: root,
    dispose: () => { unsubscribe(); },
    setVisible: (v: boolean) => { visible = v; },
  };
}
