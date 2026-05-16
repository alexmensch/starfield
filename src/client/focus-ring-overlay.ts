import * as THREE from 'three';
import type { Stellata } from './stellata';
import { projectToScreen } from './overlay-project';

const RADIUS_PX = 24;
// Half a .toFixed(1) step — below this the attribute string round-trips to
// the same value, so the browser would treat the write as a no-op anyway
// (after re-parsing the attribute). Mirrors chart-labels.ts.
const ATTR_DIRTY_PX = 0.05;

export function createFocusRingOverlay(stellata: Stellata) {
  const ring = document.getElementById('focus-ring') as unknown as SVGCircleElement;
  const v = new THREE.Vector3();

  // Sentinel-init: NaN for numeric attrs (any real write differs by > 0.05)
  // and a poison string for display (any 'none' / '' write differs from the
  // poison). Without poison, the first show() after init would skip the
  // write because the steady-state display is '' and the DOM default is '',
  // but a parent stylesheet could resolve `pointer-events` / `visibility`
  // differently — keep the first-frame write explicit.
  let lastCx = NaN;
  let lastCy = NaN;
  let lastR = NaN;
  let lastDisplay = '\0';

  const setDisplay = (value: string) => {
    if (value === lastDisplay) return;
    ring.style.display = value;
    lastDisplay = value;
  };
  const hide = () => setDisplay('none');
  const show = () => setDisplay('');

  const setCx = (value: number) => {
    if (Math.abs(value - lastCx) < ATTR_DIRTY_PX) return;
    ring.setAttribute('cx', value.toFixed(1));
    lastCx = value;
  };
  const setCy = (value: number) => {
    if (Math.abs(value - lastCy) < ATTR_DIRTY_PX) return;
    ring.setAttribute('cy', value.toFixed(1));
    lastCy = value;
  };
  const setR = (value: number) => {
    if (Math.abs(value - lastR) < ATTR_DIRTY_PX) return;
    ring.setAttribute('r', value.toFixed(1));
    lastR = value;
  };

  const syncVisibility = () => {
    if (stellata.getFocusedStar() === null) hide();
    else show();
  };
  stellata.on('focus', syncVisibility);
  syncVisibility();

  stellata.on('frame', () => {
    const idx = stellata.getFocusedStar();
    if (idx === null) return;

    // During the navigate↔observe transition the ring smoothly shrinks to
    // 0 (enter) or grows back to RADIUS_PX (exit) so it visually morphs
    // into the HUD ring instead of popping out. In steady-state observe
    // the ring stays hidden — the HUD ring takes over the "you are here"
    // role.
    const transition = stellata.getObserveTransitionProgress();
    if (stellata.getCameraMode() === 'observe' && !transition) {
      hide();
      return;
    }

    const camera = stellata.camera;
    let r = RADIUS_PX;
    if (transition) {
      r = transition.kind === 'enter'
        ? RADIUS_PX * (1 - transition.f)
        : RADIUS_PX * transition.f;
      if (r <= 0.5) {
        hide();
        return;
      }
    } else {
      // Steady-state navigate: skip the ring when the focal star's rendered
      // disc exceeds the ring diameter — the ring becomes redundant chrome
      // on top of the star. Skipped during transitions because the disc is
      // about to be hidden / has just appeared anyway.
      if (stellata.renderedSizePx(idx) > RADIUS_PX * 2) {
        hide();
        return;
      }
      // Same redundancy logic for orbit rings: when the focused host has
      // visible orbit rings centred on it (3re.7), the rings already
      // identify the star and the focus ring just adds visual noise that
      // can be confused for an inner orbital. When all rings are
      // suppressed by the pixel-gap heuristic (camera far from host or
      // the host has no planets at all), the focus ring stays as the
      // primary "you are here" cue.
      if (stellata.anyOrbitRingVisible()) {
        hide();
        return;
      }
    }

    // Project the focal star to screen. During the enter transition the
    // projection naturally slides toward screen-centre as the camera
    // approaches; during the exit transition it starts degenerate (camera
    // sits at the star) and becomes well-defined as the camera pulls away.
    // Either way, fall back to screen-centre when the projection fails so
    // the shrinking/growing ring still has a sensible centre.
    const positions = stellata.localPositions;
    v.set(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
    const projected = projectToScreen(v, camera, window.innerWidth, window.innerHeight);
    let sx: number, sy: number;
    if (!projected) {
      if (!transition) { hide(); return; }
      sx = window.innerWidth * 0.5;
      sy = window.innerHeight * 0.5;
    } else {
      sx = projected[0];
      sy = projected[1];
    }

    show();
    setCx(sx);
    setCy(sy);
    setR(r);
  });
}
