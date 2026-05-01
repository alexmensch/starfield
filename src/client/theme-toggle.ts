import type { Stellata } from './stellata';

// Theme is locked to 'dark' in the live UI as of the brand-rework. The
// 'mono' (chart) palette is intentionally retained as a programmatic API
// for future repurposing — the per-layer `setMonochrome` calls and the
// `body.monochrome` CSS still work; only the user-facing toggle was
// removed. Call `applyTheme('mono')` from the console or future feature
// code to flip the palette.

export type ThemeMode = 'dark' | 'mono';

let currentMode: ThemeMode = 'dark';
let stellataRef: Stellata | null = null;

export function registerThemeStellata(stellata: Stellata) {
  stellataRef = stellata;
}

export function applyTheme(mode: ThemeMode) {
  currentMode = mode;
  document.body.classList.toggle('monochrome', mode === 'mono');
  stellataRef?.setMonochrome(mode === 'mono');
}

export function getTheme(): ThemeMode { return currentMode; }
