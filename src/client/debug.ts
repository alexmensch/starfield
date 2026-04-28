import type { Starfield } from './starfield';
import { attachMilkywayTuning } from './milkyway-tuning';

// Optional dev tooling exposed via `window.debug`. Each entry is a
// toggle: first call attaches the tool, second call detaches. Tools
// stay out of the DOM entirely until opened, so production users never
// see them — but they're a single console keystroke away when needed
// for visual calibration or behaviour debugging.
//
// Add new tools here when they earn their keep.

export interface DebugTools {
  /** Toggle the Milky Way volumetric layer tuning panel — sliders for
   *  brightness / glow magnitude offset / disc + bulge density / dust
   *  extinction strength, plus colour pickers for disc + bulge palette
   *  and reddening RGB. */
  milkyway(): void;
}

export function setupDebug(starfield: Starfield): DebugTools {
  let mwPanel: HTMLDivElement | null = null;

  const tools: DebugTools = {
    milkyway() {
      if (mwPanel) {
        mwPanel.remove();
        mwPanel = null;
      } else {
        mwPanel = attachMilkywayTuning(starfield.milkywayLayer);
      }
    },
  };

  (window as unknown as { debug: DebugTools }).debug = tools;
  console.info('Debug tools: debug.milkyway()');
  return tools;
}
