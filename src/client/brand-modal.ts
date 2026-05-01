// Brand-box About / Credits modals. Reuses the `.modal` markup and styling
// from the welcome modal — only difference is dismissal isn't sticky
// (these are user-initiated, so no localStorage opt-out).

export function bindBrandModals() {
  const aboutBtn = document.getElementById('brand-about')!;
  const creditsBtn = document.getElementById('brand-credits')!;
  const aboutModal = document.getElementById('about-modal')!;
  const creditsModal = document.getElementById('credits-modal')!;
  const versionEl = document.getElementById('about-version');
  if (versionEl) versionEl.textContent = `v${import.meta.env.VITE_APP_VERSION}`;

  const open = (modal: HTMLElement) => {
    modal.hidden = false;
    document.addEventListener('keydown', onKey);
  };
  const close = (modal: HTMLElement) => {
    modal.hidden = true;
    if (aboutModal.hidden && creditsModal.hidden) {
      document.removeEventListener('keydown', onKey);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (!aboutModal.hidden) close(aboutModal);
    if (!creditsModal.hidden) close(creditsModal);
  };

  for (const modal of [aboutModal, creditsModal]) {
    modal.querySelectorAll<HTMLElement>('[data-modal-dismiss]').forEach((el) => {
      el.addEventListener('click', () => close(modal));
    });
  }

  aboutBtn.addEventListener('click', () => open(aboutModal));
  creditsBtn.addEventListener('click', () => open(creditsModal));
}
