import type { Stellata } from '../stellata';

// Theme is locked to 'dark' in the live UI as of the brand-rework. The
// 'mono' (chart) palette is intentionally retained as a programmatic API
// for future repurposing — the per-layer `setMonochrome` calls and the
// `body.monochrome` CSS still work; only the user-facing toggle was
// removed. Call `applyTheme('mono')` from the console or future feature
// code to flip the palette.

export type ThemeMode = 'dark' | 'mono';

let stellataRef: Stellata | null = null;

export function registerThemeStellata(stellata: Stellata): void {
  stellataRef = stellata;
}

export function applyTheme(mode: ThemeMode): void {
  document.body.classList.toggle('monochrome', mode === 'mono');
  stellataRef?.setMonochrome(mode === 'mono');
}
