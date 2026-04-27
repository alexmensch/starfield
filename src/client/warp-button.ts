import type { Starfield } from './starfield';

// Warp UI wiring. When a distance vector is drawn, the SVG distance label
// itself doubles as the warp affordance — hovering reveals a "→ Warp"
// suffix. The floating top-center pill only shows up during an in-flight
// warp to offer "Skip", and it uses a muted ghost style so it doesn't fight
// the rest of the chrome. Also toggles a body class while a warp is in
// flight so overlays can hide themselves via CSS.
export function bindWarpButton(starfield: Starfield) {
  const btn = document.getElementById('warp-btn') as HTMLButtonElement;
  const distUi = document.getElementById('dist-ui') as unknown as SVGGElement;

  const render = () => {
    if (starfield.getWarpActive()) {
      btn.hidden = false;
      btn.textContent = 'Skip';
    } else {
      btn.hidden = true;
    }
  };

  btn.addEventListener('click', () => {
    if (starfield.getWarpActive()) starfield.skipWarp();
    btn.blur();
  });

  // Trigger the appropriate warp variant based on which vector slot is
  // active — at most one of (vectorTo, vectorToCloud) is set, so the
  // dispatch is unambiguous.
  const triggerWarp = () => {
    const star = starfield.getVectorTo();
    if (star !== null) { starfield.warpTo(star); return; }
    const cloud = starfield.getVectorToCloud();
    if (cloud !== null) starfield.warpToCloud(cloud);
  };

  distUi.addEventListener('click', () => {
    if (starfield.getWarpActive()) return;
    triggerWarp();
  });

  window.addEventListener('keydown', (e) => {
    // Ignore keys typed in search inputs so "w" doesn't trigger warp while
    // the user is typing a star name.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (starfield.getWarpActive()) {
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        starfield.skipWarp();
      }
    } else if (e.key === 'w' || e.key === 'W') {
      if (starfield.getVectorTo() !== null || starfield.getVectorToCloud() !== null) {
        e.preventDefault();
        triggerWarp();
      }
    }
  });

  starfield.onWarpChange((active) => {
    document.body.classList.toggle('warping', active);
    render();
  });
  render();
}
