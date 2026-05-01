import type { Starfield } from './starfield';
import { makeDebugPanel } from './debug-panel';
import { buildMilkywaySection } from './milkyway-tuning';
import { buildStarSection } from './star-tuning';
import { installPerfHud, togglePerfHud } from './perf-hud';
import {
  type DecodedView,
  type IdMaps,
  currentStateOf,
  decodeBlob,
  encodeBlob,
} from './url-state';

// Optional dev tooling exposed via `window.debug`. The panel hosts every
// section side-by-side — there's no per-section toggling because the
// panel is already lightweight enough that opening the whole thing at
// once is the fast path during calibration.
//
// Add a new section: build it in its own *-tuning.ts module and append
// it inside `togglePanel` below. (The Starfield section was retired
// once camera FOV and star-exaggeration K became user-facing controls
// in the settings panel.)

export interface DebugTools {
  /** Toggle the dev tuning panel (Milky Way section). */
  panel(): void;
  /** Legacy alias for panel(). Kept so old console muscle memory still works. */
  milkyway(): void;
  /** Decode a `?v=` blob (with or without the `v=` prefix) into a DecodedView. */
  decodeView(blob: string): DecodedView;
  /** Encode the current Starfield state into a `?v=` blob string. */
  encodeView(): string;
  /** Toggle the perf HUD (FPS + per-section frame timing). */
  perf(): void;
}

export function setupDebug(starfield: Starfield, idMaps: IdMaps): DebugTools {
  let panel: HTMLDivElement | null = null;

  const togglePanel = () => {
    if (panel) {
      panel.remove();
      panel = null;
      return;
    }
    panel = makeDebugPanel();
    panel.appendChild(buildStarSection(starfield));
    panel.appendChild(buildMilkywaySection(starfield.milkywayLayer));
    document.body.appendChild(panel);
  };

  const tools: DebugTools = {
    panel: togglePanel,
    milkyway: togglePanel,
    decodeView: (blob) => {
      // Tolerate full URLs and `v=...` prefixes for paste-in convenience.
      const stripped = blob.includes('v=') ? blob.split('v=').pop()! : blob;
      const { view } = decodeBlob(stripped);
      console.table(view);
      return view;
    },
    encodeView: () => encodeBlob(currentStateOf(starfield, idMaps)),
    perf: () => {
      installPerfHud(starfield);
      togglePerfHud();
    },
  };

  (window as unknown as { debug: DebugTools }).debug = tools;
  console.info('Debug tools: debug.panel(), debug.decodeView(blob), debug.encodeView(), debug.perf()');
  return tools;
}
