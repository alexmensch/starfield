import * as THREE from 'three';
import type { Stellata } from './stellata';

const RADIUS_PX = 24;

export function createFocusRingOverlay(stellata: Stellata) {
  const ring = document.getElementById('focus-ring') as unknown as SVGCircleElement;
  const v = new THREE.Vector3();

  const hide = () => { ring.style.display = 'none'; };
  const show = () => { ring.style.display = ''; };

  const syncVisibility = () => {
    if (stellata.getFocusedStar() === null) hide();
    else show();
  };
  stellata.onFocusChange(syncVisibility);
  syncVisibility();

  stellata.onFrame(() => {
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
    v.applyMatrix4(camera.matrixWorldInverse);
    let sx: number, sy: number;
    if (v.z > -camera.near) {
      if (!transition) { hide(); return; }
      sx = window.innerWidth * 0.5;
      sy = window.innerHeight * 0.5;
    } else {
      v.applyMatrix4(camera.projectionMatrix);
      sx = (v.x + 1) * 0.5 * window.innerWidth;
      sy = (1 - v.y) * 0.5 * window.innerHeight;
    }

    if (ring.style.display === 'none') show();
    ring.setAttribute('cx', sx.toFixed(1));
    ring.setAttribute('cy', sy.toFixed(1));
    ring.setAttribute('r', r.toFixed(1));
  });
}
