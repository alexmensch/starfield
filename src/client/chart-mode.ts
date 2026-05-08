import type { Stellata } from './stellata';
import type { BayerInfo } from './search';
import { applyTheme } from './theme-toggle';
import { startChartLabels, stopChartLabels } from './chart-labels';

// Star chart mode orchestrator.
//
// Activation predicate:  cameraMode === 'observe'  &&  filter.chart
//
// Chart mode is gated on observe so the camera is anchored at a focal star
// — the chart's "you are here" — and the user has a stable, FPS-style
// look-around to read labels by. Toggling out of observe (ESC, mode
// button) auto-deactivates chart so the next navigate-mode session starts
// clean. The user's chart preference persists in `filter.chart` so a
// subsequent observe entry restores chart mode automatically.
//
// Side-effects when chart engages:
//   - body.chart class on document.body (selectors in styles.css can
//     branch on this independently of the existing body.monochrome).
//   - Paper-aesthetic palette via the existing setMonochrome plumbing
//     (stars, clouds, hud, galactic disc/grid, blend modes, clear color).
//   - Isobar passes on cloud + milky-way layers (driven by uMaxAppMag).
//   - Constellation-overlay flips to "all constellations" mode (handled
//     directly inside constellation-overlay.ts via the same predicate).
//   - Label engine spins up to render proper-name + Bayer + constellation
//     + cloud labels each frame.

export interface ChartModeContext {
  bayerMap: Map<number, BayerInfo>;
  starLabels: Map<number, string>;
}

export function bindChartMode(stellata: Stellata, ctx: ChartModeContext): void {
  // Track the active state separately from filter.chart so we can run
  // teardown only on real transitions (avoid flapping if filter changes
  // arrive in quick succession). The active state is derived from the
  // gate predicate; filter.chart is the user's intent.
  let active = false;

  const sync = () => {
    const f = stellata.getFilter();
    const observed = stellata.getCameraMode() === 'observe';
    const next = f.chart && observed;
    if (next === active) return;
    active = next;
    if (active) {
      document.body.classList.add('chart');
      applyTheme('mono');
      stellata.setCloudsIsobar(true);
      stellata.setMilkywayIsobar(true);
      startChartLabels(stellata, ctx);
    } else {
      document.body.classList.remove('chart');
      applyTheme('dark');
      stellata.setCloudsIsobar(false);
      stellata.setMilkywayIsobar(false);
      stopChartLabels();
    }
  };

  stellata.onCameraModeChange(() => {
    // Leaving observe always deactivates chart — the camera state required
    // to interpret the chart goes away. Clear the user's `chart` flag so
    // the next observe session starts clean unless they re-enable it.
    if (stellata.getCameraMode() !== 'observe' && stellata.getFilter().chart) {
      stellata.setFilter({ chart: false });
      return; // setFilter triggers sync via onFilterChange
    }
    sync();
  });
  stellata.onFilterChange(sync);

  // Initial reconciliation in case URL state restored chart=on before the
  // orchestrator was bound.
  sync();
}
