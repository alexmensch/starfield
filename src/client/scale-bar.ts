import type { Starfield } from './starfield';
import { fmtDist, niceRound, getUnit, LY_PER_PC } from './distance-util';

const TARGET_BAR_PX = 140;

export function createScaleBar(starfield: Starfield) {
  const line = document.getElementById('scale-bar-line')!;
  const labelEl = document.getElementById('scale-bar-label')!;
  const host = document.getElementById('scale-bar')!;
  host.hidden = false;

  let lastBarPx = -1;

  starfield.onFrame(() => {
    const camera = starfield.camera;
    const target = starfield.controls.target;
    const dist = Math.max(camera.position.distanceTo(target), 1e-4);
    const fovRad = (camera.fov * Math.PI) / 180;
    const pxPerPc = window.innerHeight / (2 * dist * Math.tan(fovRad / 2));

    const isLY = getUnit() === 'ly';
    const idealPc = TARGET_BAR_PX / pxPerPc;
    const idealDisplay = isLY ? idealPc * LY_PER_PC : idealPc;
    const niceDisplay = niceRound(idealDisplay);
    const nicePc = isLY ? niceDisplay / LY_PER_PC : niceDisplay;
    const barPx = nicePc * pxPerPc;

    if (Math.abs(barPx - lastBarPx) < 0.5) return;
    lastBarPx = barPx;

    line.style.width = `${barPx.toFixed(1)}px`;
    labelEl.textContent = fmtDist(nicePc);
  });
}
