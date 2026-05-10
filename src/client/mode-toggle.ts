import type { Stellata } from './stellata';

// Two-button pill in the top-right card. Switches the camera between
// NAVIGATE (default orbit) and OBSERVE (parked at the focused star, custom
// look-around). OBSERVE is disabled until a star is focused — the
// handler-side `setCameraMode('observe')` no-ops without an anchor, but
// disabling the button advertises the affordance up-front.
export function bindModeToggle(stellata: Stellata) {
  const host = document.getElementById('mode-toggle');
  if (!host) return;
  const buttons = Array.from(
    host.querySelectorAll<HTMLButtonElement>('button[data-mode]'),
  );

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const mode = btn.dataset.mode;
      if (mode === 'navigate' || mode === 'observe') {
        stellata.setCameraMode(mode);
      }
    });
  }

  const sync = () => {
    const mode = stellata.getCameraMode();
    const hasFocus = stellata.getFocusedStar() !== null;
    for (const btn of buttons) {
      const btnMode = btn.dataset.mode;
      btn.classList.toggle('on', btnMode === mode);
      if (btnMode === 'observe') {
        // Stay enabled while OBSERVE is the active mode even if focus
        // somehow becomes null mid-flight — clicking it would re-enter
        // navigate, which is the wanted exit. Otherwise: gated on focus.
        const enable = hasFocus || mode === 'observe';
        btn.disabled = !enable;
        btn.title = enable ? '' : 'Focus a star to observe from it';
      }
    }
  };

  stellata.on('cameraMode', sync);
  stellata.on('focus', sync);
  sync();
}
