// Brand-box About / Credits modals. Reuses the `.modal` markup and styling
// from the welcome modal — only difference is dismissal isn't sticky
// (these are user-initiated, so no localStorage opt-out).

import { bindModalDismissal } from './modal-dismiss';

export function bindBrandModals() {
  const aboutBtn = document.getElementById('brand-about')!;
  const creditsBtn = document.getElementById('brand-credits')!;
  const aboutModal = document.getElementById('about-modal')!;
  const creditsModal = document.getElementById('credits-modal')!;
  const versionEl = document.getElementById('about-version');
  if (versionEl) versionEl.textContent = `v${import.meta.env.VITE_APP_VERSION}`;

  const aboutHandle = bindModalDismissal(aboutModal);
  const creditsHandle = bindModalDismissal(creditsModal);

  aboutBtn.addEventListener('click', aboutHandle.open);
  creditsBtn.addEventListener('click', creditsHandle.open);
}
