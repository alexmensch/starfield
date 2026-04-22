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

  distUi.addEventListener('click', () => {
    if (starfield.getWarpActive()) return;
    const dest = starfield.getVectorTo();
    if (dest !== null) starfield.warpTo(dest);
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
      const dest = starfield.getVectorTo();
      if (dest !== null) {
        e.preventDefault();
        starfield.warpTo(dest);
      }
    }
  });

  starfield.onWarpChange((active) => {
    document.body.classList.toggle('warping', active);
    render();
  });
  render();
}
