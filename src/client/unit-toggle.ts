import { setUnit, getUnit, onUnitChange, type DistanceUnit } from './distance-util';

let buttons: NodeListOf<HTMLButtonElement> | null = null;

export function bindUnitToggle() {
  const host = document.getElementById('unit-toggle')!;
  buttons = host.querySelectorAll<HTMLButtonElement>('button[data-unit]');
  for (const btn of Array.from(buttons)) {
    btn.addEventListener('click', () => applyUnit(btn.dataset.unit as DistanceUnit));
  }
  onUnitChange(syncButtons);
  syncButtons();
}

export function applyUnit(u: DistanceUnit) { setUnit(u); }

function syncButtons() {
  const u = getUnit();
  buttons?.forEach((btn) => btn.classList.toggle('on', btn.dataset.unit === u));
}
