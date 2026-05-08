// Keyboard-shortcut help modal (the `?` key target). Same dismissal
// pattern as the about/credits modals in brand-modal.ts: ESC, backdrop
// click, or × button.

import { bindModalDismissal, type ModalHandle } from './modal-dismiss';

export function bindHelpModal(): ModalHandle {
  const modal = document.getElementById('help-modal')!;
  return bindModalDismissal(modal);
}
