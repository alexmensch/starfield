import type { Starfield } from './starfield';

// Theme is locked to 'dark' in the live UI as of the brand-rework. The
// 'mono' (chart) palette is intentionally retained as a programmatic API
// for future repurposing — the per-layer `setMonochrome` calls and the
// `body.monochrome` CSS still work; only the user-facing toggle was
// removed. Call `applyTheme('mono')` from the console or future feature
// code to flip the palette.

export type ThemeMode = 'dark' | 'mono';

let currentMode: ThemeMode = 'dark';
let starfieldRef: Starfield | null = null;

export function registerThemeStarfield(starfield: Starfield) {
  starfieldRef = starfield;
}

export function applyTheme(mode: ThemeMode) {
  currentMode = mode;
  document.body.classList.toggle('monochrome', mode === 'mono');
  starfieldRef?.setMonochrome(mode === 'mono');
}

export function getTheme(): ThemeMode { return currentMode; }
