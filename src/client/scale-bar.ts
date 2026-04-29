import type { Starfield } from './starfield';
import { fmtDist, niceRound, getUnit, LY_PER_PC } from './distance-util';

const TARGET_BAR_PX = 140;

export function createScaleBar(starfield: Starfield) {
  const line = document.getElementById('scale-bar-line')!;
  const labelEl = document.getElementById('scale-bar-label')!;
  const host = document.getElementById('scale-bar')!;
  host.hidden = false;

  let lastBarPx = -1;
  let lastLabel = '';

  starfield.onFrame(() => {
    const camera = starfield.camera;

    let barPx: number;
    let label: string;

    if (starfield.getCameraMode() === 'observe') {
      // No canonical focal depth in OBSERVE — the camera is fixed at the
      // focal star and the user is looking out into open space. Distance at
      // a depth would be misleading, so the bar represents angular extent of
      // sky instead, which varies meaningfully with FOV.
      const pxPerDeg = window.innerHeight / camera.fov;
      const idealDeg = TARGET_BAR_PX / pxPerDeg;
      const niceDeg = niceRound(idealDeg);
      barPx = niceDeg * pxPerDeg;
      label = formatDegrees(niceDeg);
    } else {
      const target = starfield.controls.target;
      const dist = Math.max(camera.position.distanceTo(target), 1e-4);
      const fovRad = (camera.fov * Math.PI) / 180;
      const pxPerPc = window.innerHeight / (2 * dist * Math.tan(fovRad / 2));

      const isLY = getUnit() === 'ly';
      const idealPc = TARGET_BAR_PX / pxPerPc;
      const idealDisplay = isLY ? idealPc * LY_PER_PC : idealPc;
      const niceDisplay = niceRound(idealDisplay);
      const nicePc = isLY ? niceDisplay / LY_PER_PC : niceDisplay;
      barPx = nicePc * pxPerPc;
      label = fmtDist(nicePc);
    }

    if (Math.abs(barPx - lastBarPx) < 0.5 && label === lastLabel) return;
    lastBarPx = barPx;
    lastLabel = label;

    line.style.width = `${barPx.toFixed(1)}px`;
    labelEl.textContent = label;
  });
}

function formatDegrees(deg: number): string {
  if (deg >= 1) return `${deg.toFixed(0)}°`;
  if (deg >= 0.1) return `${deg.toFixed(1)}°`;
  return `${deg.toFixed(2)}°`;
}
