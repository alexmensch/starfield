import { bindModalDismissal } from './modal-dismiss';

const STORAGE_KEY = 'stellata.info-dismissed';

export function maybeShowInfoModal(starCount: number) {
  if (localStorage.getItem(STORAGE_KEY) === '1') return;

  const modal = document.getElementById('info-modal')!;
  const dontShow = document.getElementById('info-dontshow') as HTMLInputElement;
  const countEl = document.getElementById('info-star-count')!;
  countEl.textContent = starCount.toLocaleString();

  const handle = bindModalDismissal(modal, {
    beforeClose: () => {
      if (dontShow.checked) localStorage.setItem(STORAGE_KEY, '1');
    },
  });
  handle.open();
}
