// Keyboard-shortcut help modal (the `?` key target). Same dismissal
// pattern as the about/credits modals in brand-modal.ts: ESC, backdrop
// click, or × button.

export function bindHelpModal(): { open: () => void; close: () => void } {
  const modal = document.getElementById('help-modal')!;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  };

  const open = () => {
    modal.hidden = false;
    document.addEventListener('keydown', onKey);
  };
  const close = () => {
    modal.hidden = true;
    document.removeEventListener('keydown', onKey);
  };

  modal.querySelectorAll<HTMLElement>('[data-modal-dismiss]').forEach((el) => {
    el.addEventListener('click', close);
  });

  return { open, close };
}
