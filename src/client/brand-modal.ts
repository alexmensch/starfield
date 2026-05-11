// Brand-box About / Credits modals plus the Share affordance. Reuses the
// `.modal` markup and styling from the welcome modal — only difference is
// dismissal isn't sticky (these are user-initiated, so no localStorage opt-out).
// Share copies window.location.href to the clipboard and flashes the trailing
// glyph; the URL already encodes the full view via url-state.ts.

import { bindModalDismissal } from './modal-dismiss';

const SHARE_REST = '⧉';
const SHARE_OK = '✓';
const SHARE_FAIL = '⨯';
const SHARE_FLASH_MS = 1500;

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

  const shareBtn = document.getElementById('brand-share');
  const glyphEl = shareBtn?.querySelector<HTMLElement>('.share-glyph') ?? null;
  if (shareBtn && glyphEl) {
    let revertTimer: number | undefined;
    const flash = (g: string) => {
      glyphEl.textContent = g;
      if (revertTimer !== undefined) window.clearTimeout(revertTimer);
      revertTimer = window.setTimeout(() => {
        glyphEl.textContent = SHARE_REST;
        revertTimer = undefined;
      }, SHARE_FLASH_MS);
    };
    shareBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        flash(SHARE_OK);
      } catch {
        flash(SHARE_FAIL);
      }
    });
  }
}
