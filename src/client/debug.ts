import type { Starfield } from './starfield';
import { makeDebugPanel } from './debug-panel';
import { buildMilkywaySection } from './milkyway-tuning';
import { buildStarfieldSection } from './starfield-tuning';

// Optional dev tooling exposed via `window.debug`. The panel hosts every
// section side-by-side (Milky Way, Starfield, future tools) — there's no
// per-section toggling because the panel is already lightweight enough
// that opening the whole thing at once is the fast path during
// calibration.
//
// Add a new section: build it in its own *-tuning.ts module and append
// it inside `togglePanel` below.

export interface DebugTools {
  /** Toggle the dev tuning panel (Milky Way + Starfield sections). */
  panel(): void;
  /** Legacy alias for panel(). Kept so old console muscle memory still works. */
  milkyway(): void;
}

export function setupDebug(starfield: Starfield): DebugTools {
  let panel: HTMLDivElement | null = null;

  const togglePanel = () => {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    panel = makeDebugPanel();
    panel.appendChild(buildStarfieldSection(starfield));
    panel.appendChild(buildMilkywaySection(starfield.milkywayLayer));
    document.body.appendChild(panel);
  };

  const tools: DebugTools = {
    panel: togglePanel,
    milkyway: togglePanel,
  };

  (window as unknown as { debug: DebugTools }).debug = tools;
  console.info('Debug tools: debug.panel()');
  return tools;
}
