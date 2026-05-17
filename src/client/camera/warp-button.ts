import type { Stellata } from '../stellata';

// Warp UI wiring. When a distance vector is drawn, the SVG distance label
// itself doubles as the warp affordance — hovering reveals a "→ Warp"
// suffix. The floating top-center pill only shows up during an in-flight
// warp to offer "Skip", and it uses a muted ghost style so it doesn't fight
// the rest of the chrome. Also toggles a body class while a warp is in
// flight so overlays can hide themselves via CSS.
export function bindWarpButton(stellata: Stellata) {
  const btn = document.getElementById('warp-btn') as HTMLButtonElement;
  // Element is enough: only addEventListener is called on it. The earlier
  // `as unknown as SVGGElement` cast was a type lie — the SVG group is
  // typed by the DOM as Element, and addEventListener lives on Element.
  const distUi = document.getElementById('dist-ui')!;

  const render = () => {
    if (stellata.getWarpActive()) {
      btn.hidden = false;
      btn.textContent = 'Skip';
    } else {
      btn.hidden = true;
    }
  };

  btn.addEventListener('click', () => {
    if (stellata.getWarpActive()) stellata.skipWarp();
    btn.blur();
  });

  // Trigger the appropriate warp variant based on which vector slot is
  // active — at most one of (vectorTo, vectorToCloud) is set, so the
  // dispatch is unambiguous.
  const triggerWarp = () => {
    const star = stellata.getVectorTo();
    if (star !== null) { stellata.warpTo(star); return; }
    const cloud = stellata.getVectorToCloud();
    if (cloud !== null) stellata.warpToCloud(cloud);
  };

  distUi.addEventListener('click', () => {
    if (stellata.getWarpActive()) return;
    triggerWarp();
  });

  window.addEventListener('keydown', (e) => {
    // Ignore keys typed in search inputs so "w" doesn't trigger warp while
    // the user is typing a star name.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (stellata.getWarpActive()) {
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        stellata.skipWarp();
      }
    } else if (e.key === 'w' || e.key === 'W') {
      if (stellata.getVectorTo() !== null || stellata.getVectorToCloud() !== null) {
        e.preventDefault();
        triggerWarp();
      }
    }
  });

  stellata.on('warp', (active) => {
    document.body.classList.toggle('warping', active);
    render();
  });
  render();
}
