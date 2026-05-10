import type { Stellata } from './stellata';
import { makeCollapsibleSection, makeDebugPanel } from './debug-panel';
import { buildMilkywaySection } from './milkyway-tuning';
import { buildStarSection } from './star-tuning';
import { buildPerfSection } from './perf-hud';
import { buildPinSection } from './pin-debug-hud';
import { buildArrowSection } from './arrow-fade-debug-hud';
import {
  type DecodedView,
  type IdMaps,
  currentStateOf,
  decodeBlob,
  encodeBlob,
} from './url-state';

// Optional dev tooling exposed via `window.debug`. The unified panel
// surfaces every collapsible-section side-by-side: star/milkyway tuning
// sliders plus perf, pin, and arrow-fade diagnostic readouts.
// `debug.panel()` is the sole entry point (also revealed by the hidden
// triple-tap-D keyboard affordance). State (drag position, per-section
// collapse) lives in sessionStorage and resets on reload.
//
// Add a new section: build it in its own *-tuning.ts / *-hud.ts module
// (returning either a raw section element or a LiveSection — see
// mountLiveSection below for the latter shape) and wire it into
// `togglePanel`.

export interface DebugTools {
  /** Toggle the unified dev panel. */
  panel(): void;
  /** Decode a `?v=` blob (with or without the `v=` prefix) into a DecodedView. */
  decodeView(blob: string): DecodedView;
  /** Encode the current Stellata state into a `?v=` blob string. */
  encodeView(): string;
}

/** Shape every live (per-frame-updating) debug section returns. The
 *  module owns its own per-frame subscription; the panel host owns
 *  collapse + visibility-gating + lifecycle. */
interface LiveSection {
  element: HTMLElement;
  dispose: () => void;
  setVisible: (v: boolean) => void;
}

/** Wrap a LiveSection in a collapsible-section, mount it on the panel,
 *  and return its disposer for the closePanel cleanup pass. The
 *  visibility gate is wired both ways: collapse → setVisible(false),
 *  initial-from-storage → setVisible(!collapsed). */
function mountLiveSection(
  body: HTMLDivElement,
  title: string,
  storageKey: string,
  module: LiveSection,
): () => void {
  const section = makeCollapsibleSection({
    title,
    storageKey,
    onCollapseChange: (collapsed) => module.setVisible(!collapsed),
  });
  section.body.appendChild(module.element);
  module.setVisible(!section.isCollapsed());
  body.appendChild(section.section);
  return module.dispose;
}

export function setupDebug(stellata: Stellata, idMaps: IdMaps): DebugTools {
  let panel: HTMLDivElement | null = null;
  let liveDisposers: Array<() => void> = [];

  const closePanel = () => {
    if (!panel) return;
    panel.remove();
    panel = null;
    for (const dispose of liveDisposers) dispose();
    liveDisposers = [];
  };

  const togglePanel = () => {
    if (panel) { closePanel(); return; }

    const built = makeDebugPanel({ onClose: closePanel });
    panel = built.element;

    built.body.appendChild(buildStarSection(stellata));
    built.body.appendChild(buildMilkywaySection(stellata.milkywayLayer));

    // Live sections — each owns its per-frame subscription via
    // stellata.on('frame', ...) and exposes setVisible to gate DOM writes
    // when collapsed. Latches inside each module keep updating
    // independent of visibility.
    liveDisposers.push(
      mountLiveSection(built.body, 'Perf', 'perf', buildPerfSection()),
      mountLiveSection(built.body, 'Pin', 'pin', buildPinSection(stellata)),
      mountLiveSection(built.body, 'Arrows', 'arrows', buildArrowSection(stellata)),
    );

    document.body.appendChild(panel);
  };

  const tools: DebugTools = {
    panel: togglePanel,
    decodeView: (blob) => {
      // Tolerate full URLs and `v=...` prefixes for paste-in convenience.
      const stripped = blob.includes('v=') ? blob.split('v=').pop()! : blob;
      const { view } = decodeBlob(stripped);
      console.table(view);
      return view;
    },
    encodeView: () => encodeBlob(currentStateOf(stellata, idMaps)),
  };

  (window as unknown as { debug: DebugTools }).debug = tools;
  return tools;
}
