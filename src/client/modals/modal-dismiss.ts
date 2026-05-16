// Shared open/close machinery for `.modal` elements (welcome, about,
// credits, help). Each modal hides via `hidden` attribute, dismisses on
// ESC, on click of any `[data-modal-dismiss]` descendant, and runs an
// optional `beforeClose` hook (used by the welcome modal to persist its
// "don't show again" choice).
//
// Returns `open` / `close` so callers can wire them onto buttons and
// keyboard shortcuts. The keydown listener is added on open and removed
// on close so an inactive modal isn't intercepting keystrokes.

export interface ModalHandle {
  open: () => void;
  close: () => void;
}

export interface ModalOptions {
  /** Run just before `modal.hidden = true`. Returning anything is
   *  ignored — used for side-effects like writing localStorage. */
  beforeClose?: () => void;
}

export function bindModalDismissal(modal: HTMLElement, opts: ModalOptions = {}): ModalHandle {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  };
  const open = () => {
    modal.hidden = false;
    document.addEventListener('keydown', onKey);
  };
  const close = () => {
    if (modal.hidden) return;
    opts.beforeClose?.();
    modal.hidden = true;
    document.removeEventListener('keydown', onKey);
  };
  modal.querySelectorAll<HTMLElement>('[data-modal-dismiss]').forEach((el) => {
    el.addEventListener('click', close);
  });
  return { open, close };
}
