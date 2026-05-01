// Collapse/expand toggles for the settings panel. The panel itself
// collapses as a single unit (top-level), and each `.group[data-group]`
// inside the panel collapses independently with its own persisted state.
// Layout itself is pure CSS — the panel sits inside `.ui-top`'s flex
// column, so nothing needs to measure the topbar or reposition on
// resize.

const PANEL_KEY = 'stellata.panel-collapsed';
const GROUP_KEY_PREFIX = 'stellata.group-collapsed.';

export function bindPanelLayout() {
  bindTopLevel();
  bindGroups();
}

function bindTopLevel() {
  const panel = document.getElementById('panel')!;
  const header = document.getElementById('panel-header')!;
  const toggleBtn = document.getElementById('panel-toggle') as HTMLButtonElement;

  const apply = (c: boolean) => {
    panel.classList.toggle('collapsed', c);
    toggleBtn.textContent = c ? '+' : '−';
    toggleBtn.setAttribute('aria-expanded', c ? 'false' : 'true');
    toggleBtn.setAttribute(
      'aria-label',
      c ? 'Expand settings' : 'Collapse settings',
    );
  };

  apply(localStorage.getItem(PANEL_KEY) === '1');
  header.addEventListener('click', () => {
    const next = !panel.classList.contains('collapsed');
    apply(next);
    localStorage.setItem(PANEL_KEY, next ? '1' : '0');
  });
}

function bindGroups() {
  const groups = document.querySelectorAll<HTMLElement>('.group[data-group]');
  for (const group of Array.from(groups)) {
    const name = group.dataset.group!;
    const header = group.querySelector<HTMLElement>('.group-header');
    const toggle = group.querySelector<HTMLButtonElement>('.group-toggle');
    if (!header || !toggle) continue;

    const apply = (c: boolean) => {
      group.classList.toggle('collapsed', c);
      toggle.textContent = c ? '+' : '−';
      toggle.setAttribute('aria-expanded', c ? 'false' : 'true');
    };

    apply(localStorage.getItem(GROUP_KEY_PREFIX + name) === '1');

    header.addEventListener('click', () => {
      const next = !group.classList.contains('collapsed');
      apply(next);
      localStorage.setItem(GROUP_KEY_PREFIX + name, next ? '1' : '0');
    });
  }
}
