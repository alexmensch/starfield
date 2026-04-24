const STORAGE_KEY = 'starfield.info-dismissed';

export function maybeShowInfoModal(starCount: number) {
  if (localStorage.getItem(STORAGE_KEY) === '1') return;

  const modal = document.getElementById('info-modal')!;
  const closeBtn = document.getElementById('info-close')!;
  const backdrop = document.getElementById('info-backdrop')!;
  const dontShow = document.getElementById('info-dontshow') as HTMLInputElement;
  const countEl = document.getElementById('info-star-count')!;
  countEl.textContent = starCount.toLocaleString();

  const dismiss = () => {
    if (dontShow.checked) localStorage.setItem(STORAGE_KEY, '1');
    modal.hidden = true;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };

  closeBtn.addEventListener('click', dismiss);
  backdrop.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);

  modal.hidden = false;
}
