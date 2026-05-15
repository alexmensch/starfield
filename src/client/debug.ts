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
// (returning either a section element or a {element, dispose, setVisible}
// triple) and wire it into `togglePanel` below.

export interface DebugTools {
  /** Toggle the unified dev panel. */
  panel(): void;
  /** Decode a `?v=` blob (with or without the `v=` prefix) into a DecodedView. */
  decodeView(blob: string): DecodedView;
  /** Encode the current Stellata state into a `?v=` blob string. */
  encodeView(): string;
}

export function setupDebug(stellata: Stellata, idMaps: IdMaps): DebugTools {
  let panel: HTMLDivElement | null = null;
  let perfDispose: (() => void) | null = null;
  let pinDispose: (() => void) | null = null;
  let arrowDispose: (() => void) | null = null;

  const closePanel = () => {
    if (!panel) return;
    panel.remove();
    panel = null;
    perfDispose?.(); perfDispose = null;
    pinDispose?.(); pinDispose = null;
    arrowDispose?.(); arrowDispose = null;
  };

  const togglePanel = () => {
    if (panel) { closePanel(); return; }

    const built = makeDebugPanel({ onClose: closePanel });
    panel = built.element;

    built.body.appendChild(buildStarSection(stellata));
    built.body.appendChild(buildMilkywaySection(stellata.milkywayLayer));

    // Perf section — the perf-hud module exposes per-tick mark/measure/
    // frame that are no-ops until buildPerfSection() runs. The collapse
    // hook gates the section's per-frame DOM writes so a hidden section
    // costs only its ring-buffer fills.
    const perf = buildPerfSection();
    perfDispose = perf.dispose;
    const perfSection = makeCollapsibleSection({
      title: 'Perf',
      storageKey: 'perf',
      onCollapseChange: (collapsed) => perf.setVisible(!collapsed),
    });
    perfSection.body.appendChild(perf.element);
    perf.setVisible(!perfSection.isCollapsed());
    built.body.appendChild(perfSection.section);

    // Pin section — subscribes to stellata.onFrame inside dispose's
    // cleanup. setVisible gates the body.textContent write; latches keep
    // updating either way so reopening shows accurate extremes.
    const pin = buildPinSection(stellata);
    pinDispose = pin.dispose;
    const pinSection = makeCollapsibleSection({
      title: 'Pin',
      storageKey: 'pin',
      onCollapseChange: (collapsed) => pin.setVisible(!collapsed),
    });
    pinSection.body.appendChild(pin.element);
    pin.setVisible(!pinSection.isCollapsed());
    built.body.appendChild(pinSection.section);

    // Arrows section — Sol/GC navigate-arrow fade diagnostics. Same
    // visibility-gated readout shape as the pin section.
    const arrows = buildArrowSection(stellata);
    arrowDispose = arrows.dispose;
    const arrowSection = makeCollapsibleSection({
      title: 'Arrows',
      storageKey: 'arrows',
      onCollapseChange: (collapsed) => arrows.setVisible(!collapsed),
    });
    arrowSection.body.appendChild(arrows.element);
    arrows.setVisible(!arrowSection.isCollapsed());
    built.body.appendChild(arrowSection.section);

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
