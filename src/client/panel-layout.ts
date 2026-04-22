// Collapse/expand toggle for the settings panel. Layout itself is pure
// CSS — the panel sits inside `.ui-top`'s flex column, so nothing needs
// to measure the topbar or reposition on resize.

const STORAGE_KEY = 'starfield.panel-collapsed';

export function bindPanelLayout() {
  const panel = document.getElementById('panel')!;
  const header = document.getElementById('panel-header')!;
  const toggleBtn = document.getElementById('panel-toggle') as HTMLButtonElement;

  const applyCollapsed = (c: boolean) => {
    panel.classList.toggle('collapsed', c);
    toggleBtn.textContent = c ? '+' : '−';
    toggleBtn.setAttribute('aria-expanded', c ? 'false' : 'true');
    toggleBtn.setAttribute(
      'aria-label',
      c ? 'Expand settings' : 'Collapse settings',
    );
  };

  const toggle = () => {
    const next = !panel.classList.contains('collapsed');
    applyCollapsed(next);
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  };

  applyCollapsed(localStorage.getItem(STORAGE_KEY) !== '0');
  header.addEventListener('click', toggle);
}
