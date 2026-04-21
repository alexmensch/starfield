import type { Starfield } from './starfield';

export type ThemeMode = 'dark' | 'mono';

let currentMode: ThemeMode = 'dark';
let buttons: NodeListOf<HTMLButtonElement> | null = null;
let starfieldRef: Starfield | null = null;

export function bindThemeToggle(starfield: Starfield) {
  starfieldRef = starfield;
  const host = document.getElementById('theme-toggle')!;
  buttons = host.querySelectorAll<HTMLButtonElement>('button[data-theme]');
  for (const btn of Array.from(buttons)) {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme as ThemeMode));
  }
}

export function applyTheme(mode: ThemeMode) {
  currentMode = mode;
  document.body.classList.toggle('monochrome', mode === 'mono');
  starfieldRef?.setMonochrome(mode === 'mono');
  buttons?.forEach((btn) => btn.classList.toggle('on', btn.dataset.theme === mode));
}

export function getTheme(): ThemeMode { return currentMode; }
