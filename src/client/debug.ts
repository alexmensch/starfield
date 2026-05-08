import type { Stellata } from './stellata';
import { makeCollapsibleSection, makeDebugPanel } from './debug-panel';
import { buildMilkywaySection } from './milkyway-tuning';
import { buildStarSection } from './star-tuning';
import { buildPerfSection } from './perf-hud';
import { buildPinSection } from './pin-debug-hud';
import { toggleArrowFadeHud } from './arrow-fade-debug-hud';
import {
  type DecodedView,
  type IdMaps,
  currentStateOf,
  decodeBlob,
  encodeBlob,
} from './url-state';

// Optional dev tooling exposed via `window.debug`. The unified panel
// surfaces every collapsible-section side-by-side: star/milkyway tuning
// sliders plus perf and pin diagnostic readouts. `debug.panel()` is the
// canonical entry; `debug.perf()` and `debug.pin()` are kept as aliases
// for muscle memory. State (drag position, per-section collapse) lives
// in sessionStorage and resets on reload.
//
// Add a new section: build it in its own *-tuning.ts / *-hud.ts module
// (returning either a section element or a {element, dispose, setVisible}
// triple) and wire it into `togglePanel` below alongside the existing
// four. The arrow-fade HUD is intentionally still its own floating panel
// — debug.arrows() — because it's narrow-purpose enough that bundling it
// in adds clutter.

export interface DebugTools {
  /** Toggle the unified dev panel. */
  panel(): void;
  /** Legacy alias for panel(). Kept so old console muscle memory still works. */
  milkyway(): void;
  /** Decode a `?v=` blob (with or without the `v=` prefix) into a DecodedView. */
  decodeView(blob: string): DecodedView;
  /** Encode the current Stellata state into a `?v=` blob string. */
  encodeView(): string;
  /** Alias for panel(): the perf readouts are now a section in the unified panel. */
  perf(): void;
  /** Alias for panel(): the pin readouts are now a section in the unified panel. */
  pin(): void;
  /** Toggle the navigate-mode arrow-fade diagnostic HUD: live drawn shaft
   *  lengths for Sol/GC, behind-camera flag, direction-derivation path,
   *  disc radius, refLen, coverage, and the resulting alpha. */
  arrows(): void;
}

export function setupDebug(stellata: Stellata, idMaps: IdMaps): DebugTools {
  let panel: HTMLDivElement | null = null;
  let perfDispose: (() => void) | null = null;
  let pinDispose: (() => void) | null = null;

  const closePanel = () => {
    if (!panel) return;
    panel.remove();
    panel = null;
    perfDispose?.(); perfDispose = null;
    pinDispose?.(); pinDispose = null;
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

    document.body.appendChild(panel);
  };

  const tools: DebugTools = {
    panel: togglePanel,
    milkyway: togglePanel,
    perf: togglePanel,
    pin: togglePanel,
    decodeView: (blob) => {
      // Tolerate full URLs and `v=...` prefixes for paste-in convenience.
      const stripped = blob.includes('v=') ? blob.split('v=').pop()! : blob;
      const { view } = decodeBlob(stripped);
      console.table(view);
      return view;
    },
    encodeView: () => encodeBlob(currentStateOf(stellata, idMaps)),
    arrows: () => toggleArrowFadeHud(stellata),
  };

  (window as unknown as { debug: DebugTools }).debug = tools;
  console.info('Debug tools: debug.panel(), debug.decodeView(blob), debug.encodeView(), debug.perf(), debug.pin(), debug.arrows()');
  return tools;
}
