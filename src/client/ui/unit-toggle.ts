import { setUnit, getUnit, onUnitChange, type DistanceUnit } from './distance-util';

export function bindUnitToggle() {
  const host = document.getElementById('unit-toggle')!;
  const buttons = host.querySelectorAll<HTMLButtonElement>('button[data-unit]');
  const sync = () => {
    const u = getUnit();
    buttons.forEach((btn) => btn.classList.toggle('on', btn.dataset.unit === u));
  };
  for (const btn of Array.from(buttons)) {
    btn.addEventListener('click', () => setUnit(btn.dataset.unit as DistanceUnit));
  }
  onUnitChange(sync);
  sync();
}
