import type { Stellata } from './stellata';
import { type ArrivalCurveId, resolveArrivalCurve } from './arrival-curves';

// Warp-curve tuning section for the unified debug panel (mounted from
// debug.ts). Exposes two surfaces:
//
//   1. Module-level mutable knobs read by `startWarp` / `tryMidFlyRecentre`
//      / the chart-mode plateau-trigger at warp start. Defaults match the
//      shipped constants exported from `stellata.ts` — until the user
//      drags a slider, behaviour is identical to a build without this
//      module loaded.
//
//   2. Live readouts (current phase, elapsed, u, distances, recentre /
//      plateau flags, last-warp summary) gated by section visibility.
//      The per-frame `'frame'` subscription early-returns when the
//      section is collapsed, so the cost when hidden is one boolean
//      check per frame — no latch updates, no DOM writes, no allocations.
//      Disposing the section unsubscribes from `'frame'` entirely; closing
//      the panel is fully dark for this section.
//
// Workflow: open the panel via `debug.panel()` in the dev console, expand
// the "Warp" section, drag sliders / pick a curve, run a warp. Knob reads
// happen at `startWarp` time, so changes take effect on the next warp
// (not retroactively on the in-flight one — captured behaviour stays
// frame-coherent). When a knob set feels right, copy the displayed values
// at the bottom of the section into the shipped constants in
// `stellata.ts`.
//
// Audit note: deliberately avoids the "session-wide install" pattern in
// `perf-hud.ts` (which keeps real `mark/measure/frame` running after
// dispose) — see `stellata-9mm.190.1`. The dispose path here fully
// detaches the per-frame subscription; the knobs retain their last set
// values so reopening the panel resumes tuning, but no compute survives
// dispose.

import {
  WARP_REORIENT_MS,
  WARP_T_MIN_MS,
  WARP_T_MAX_MS,
  WARP_T_K_MS,
  OBSERVE_TRANSITION_MS,
} from './stellata';

/** Linear |camera−B| / |A−B| threshold at which the mid-Fly recentre
 *  fires (0.5 = midpoint, matching the shipped `0.25` squared-form in
 *  `tryMidFlyRecentre`). The squaring happens at the comparison site so
 *  the knob reads as the natural "fraction of the way along the
 *  trajectory" the user expects. */
export const DEFAULT_MID_FLY_RECENTRE_FRAC = 0.5;
export const DEFAULT_CHART_PLATEAU_MARGIN = 1.0;
export const DEFAULT_CHART_PHASE3_SCALING_ENABLED = false;
export const DEFAULT_CHART_PHASE3_ALPHA = 0.5;
export const DEFAULT_ARRIVAL_POWER_P = 2;

interface Knobs {
  reorientMs: number;
  flyTMinMs: number;
  flyTMaxMs: number;
  flyTKMs: number;
  observeTransitionMs: number;
  arrivalCurve: ArrivalCurveId;
  arrivalPowerP: number;
  midFlyRecentreFrac: number;
  chartPlateauMargin: number;
  chartPhase3ScalingEnabled: boolean;
  chartPhase3Alpha: number;
}

const knobs: Knobs = {
  reorientMs: WARP_REORIENT_MS,
  flyTMinMs: WARP_T_MIN_MS,
  flyTMaxMs: WARP_T_MAX_MS,
  flyTKMs: WARP_T_K_MS,
  observeTransitionMs: OBSERVE_TRANSITION_MS,
  arrivalCurve: 'cubic-hermite',
  arrivalPowerP: DEFAULT_ARRIVAL_POWER_P,
  midFlyRecentreFrac: DEFAULT_MID_FLY_RECENTRE_FRAC,
  chartPlateauMargin: DEFAULT_CHART_PLATEAU_MARGIN,
  chartPhase3ScalingEnabled: DEFAULT_CHART_PHASE3_SCALING_ENABLED,
  chartPhase3Alpha: DEFAULT_CHART_PHASE3_ALPHA,
};

// Read-at-warp-start getters consumed by stellata.ts. Each returns the
// live knob value, so the next warp picks up the latest slider state.
// Importers should read inside `startWarp` / `tryMidFlyRecentre` /
// `chartPlateauTrigger`, NEVER cache the value module-side — the whole
// point of the tuning surface is that the next warp reflects the latest
// edit.
export function warpReorientMs(): number { return knobs.reorientMs; }
export function warpFlyTMinMs(): number { return knobs.flyTMinMs; }
export function warpFlyTMaxMs(): number { return knobs.flyTMaxMs; }
export function warpFlyTKMs(): number { return knobs.flyTKMs; }
export function warpObserveTransitionMs(): number { return knobs.observeTransitionMs; }
export function warpArrivalEaseFn(): (u: number) => number {
  return resolveArrivalCurve(knobs.arrivalCurve, knobs.arrivalPowerP);
}
export function warpMidFlyRecentreFrac(): number { return knobs.midFlyRecentreFrac; }
export function warpChartPlateauMargin(): number { return knobs.chartPlateauMargin; }
export function warpChartPhase3ScalingEnabled(): boolean {
  return knobs.chartPhase3ScalingEnabled;
}
export function warpChartPhase3Alpha(): number { return knobs.chartPhase3Alpha; }

// Last-warp summary surface, populated from stellata.ts at finishWarp
// time. Kept inside this module so the readout DOM is the only consumer;
// nothing in the shipped warp path reads from here.
interface LastWarpSummary {
  sourceKind: string;
  sourceIdx: number;
  destKind: string;
  destIdx: number;
  totalMs: number;
  plateauFired: boolean;
  plateauScaledPhase3: boolean;
  plateauDistPc: number | null;
}
let lastWarp: LastWarpSummary | null = null;

export function recordLastWarp(summary: LastWarpSummary): void {
  lastWarp = summary;
}

// LiveSection contract — matches the shape `debug.ts:mountLiveSection`
// expects.
export interface WarpTuningSection {
  element: HTMLElement;
  dispose: () => void;
  setVisible: (v: boolean) => void;
}

export function buildWarpSection(stellata: Stellata): WarpTuningSection {
  let visible = true;

  const root = document.createElement('div');
  root.style.cssText =
    'font:11px/1.3 ui-monospace,monospace;background:rgba(0,0,0,.85);' +
    'color:#cfe;padding:6px 8px;border-radius:4px;min-width:280px;';

  // --- Sliders -----------------------------------------------------------
  const slidersBox = document.createElement('div');
  root.appendChild(slidersBox);

  function addSlider(opts: {
    label: string;
    min: number;
    max: number;
    step: number;
    initial: number;
    onChange: (v: number) => void;
    fmt?: (v: number) => string;
  }) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;';
    const label = document.createElement('span');
    label.style.cssText = 'flex:0 0 90px;color:#aaa;';
    label.textContent = opts.label;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(opts.min);
    slider.max = String(opts.max);
    slider.step = String(opts.step);
    slider.value = String(opts.initial);
    slider.className = 'debug-slider';
    slider.style.cssText = 'flex:1;';
    const value = document.createElement('span');
    value.style.cssText = 'flex:0 0 60px;text-align:right;color:#fff;';
    const fmt = opts.fmt ?? ((v: number) => String(v));
    value.textContent = fmt(opts.initial);
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      opts.onChange(v);
      value.textContent = fmt(v);
    });
    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(value);
    slidersBox.appendChild(row);
  }

  const fmtMs = (v: number) => `${v.toFixed(0)} ms`;
  const fmtFrac = (v: number) => v.toFixed(2);

  addSlider({
    label: 'reorient',
    min: 200, max: 2000, step: 50,
    initial: knobs.reorientMs,
    onChange: (v) => { knobs.reorientMs = v; },
    fmt: fmtMs,
  });
  addSlider({
    label: 'fly t-min',
    min: 200, max: 8000, step: 100,
    initial: knobs.flyTMinMs,
    onChange: (v) => { knobs.flyTMinMs = v; },
    fmt: fmtMs,
  });
  addSlider({
    label: 'fly t-max',
    min: 1000, max: 20000, step: 200,
    initial: knobs.flyTMaxMs,
    onChange: (v) => { knobs.flyTMaxMs = v; },
    fmt: fmtMs,
  });
  addSlider({
    label: 'fly k',
    min: 0, max: 6000, step: 100,
    initial: knobs.flyTKMs,
    onChange: (v) => { knobs.flyTKMs = v; },
    fmt: fmtMs,
  });
  addSlider({
    label: 'phase 3',
    min: 200, max: 3000, step: 50,
    initial: knobs.observeTransitionMs,
    onChange: (v) => { knobs.observeTransitionMs = v; },
    fmt: fmtMs,
  });

  // Arrival curve selector.
  {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;';
    const label = document.createElement('span');
    label.style.cssText = 'flex:0 0 90px;color:#aaa;';
    label.textContent = 'curve';
    const sel = document.createElement('select');
    sel.style.cssText = 'flex:1;background:#222;color:#fff;border:1px solid #444;';
    for (const id of ['cubic-hermite', 'quintic-hermite', 'power'] as const) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      if (id === knobs.arrivalCurve) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      knobs.arrivalCurve = sel.value as ArrivalCurveId;
    });
    row.appendChild(label);
    row.appendChild(sel);
    slidersBox.appendChild(row);
  }

  addSlider({
    label: 'power p',
    min: 0.25, max: 4, step: 0.05,
    initial: knobs.arrivalPowerP,
    onChange: (v) => { knobs.arrivalPowerP = v; },
    fmt: fmtFrac,
  });

  addSlider({
    label: 'recentre',
    min: 0.1, max: 0.9, step: 0.01,
    initial: knobs.midFlyRecentreFrac,
    onChange: (v) => { knobs.midFlyRecentreFrac = v; },
    fmt: fmtFrac,
  });
  addSlider({
    label: 'plateau ×',
    min: 0.25, max: 3.0, step: 0.05,
    initial: knobs.chartPlateauMargin,
    onChange: (v) => { knobs.chartPlateauMargin = v; },
    fmt: fmtFrac,
  });

  // Phase-3 scaling toggle + alpha.
  {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;';
    const label = document.createElement('span');
    label.style.cssText = 'flex:0 0 90px;color:#aaa;';
    label.textContent = 'p3 scale';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = knobs.chartPhase3ScalingEnabled;
    cb.addEventListener('change', () => {
      knobs.chartPhase3ScalingEnabled = cb.checked;
    });
    row.appendChild(label);
    row.appendChild(cb);
    slidersBox.appendChild(row);
  }
  addSlider({
    label: 'p3 α',
    min: 0, max: 1, step: 0.05,
    initial: knobs.chartPhase3Alpha,
    onChange: (v) => { knobs.chartPhase3Alpha = v; },
    fmt: fmtFrac,
  });

  // --- Live readout ------------------------------------------------------
  const readoutHeader = document.createElement('div');
  readoutHeader.style.cssText = 'margin-top:6px;color:#888;border-top:1px solid #333;padding-top:4px;';
  readoutHeader.textContent = 'live';
  root.appendChild(readoutHeader);

  const readout = document.createElement('div');
  readout.style.cssText = 'white-space:pre;color:#cfe;';
  readout.textContent = '(idle)';
  root.appendChild(readout);

  // Per-readout dirty cache — skips DOM writes when the text is unchanged
  // (mirrors the perf-hud pattern). Cheap to maintain, and matters when
  // the section is expanded for many seconds across idle warps.
  let lastReadoutText = '';

  // Copy-pastable knob summary at the bottom. Updated when any knob
  // changes; click the value block to copy it. Lets Alex paste exact
  // constants back without retyping.
  const summaryBox = document.createElement('div');
  summaryBox.style.cssText =
    'margin-top:6px;padding-top:4px;border-top:1px solid #333;cursor:pointer;color:#9c9;';
  summaryBox.title = 'click to copy';
  summaryBox.addEventListener('click', () => {
    navigator.clipboard?.writeText(summaryBox.textContent ?? '').catch(() => {});
  });
  root.appendChild(summaryBox);

  function renderSummary() {
    summaryBox.textContent =
      `WARP_REORIENT_MS = ${knobs.reorientMs}\n` +
      `WARP_T_MIN_MS = ${knobs.flyTMinMs}\n` +
      `WARP_T_MAX_MS = ${knobs.flyTMaxMs}\n` +
      `WARP_T_K_MS = ${knobs.flyTKMs}\n` +
      `OBSERVE_TRANSITION_MS = ${knobs.observeTransitionMs}\n` +
      `arrivalCurve = '${knobs.arrivalCurve}'${
        knobs.arrivalCurve === 'power' ? ` (p=${knobs.arrivalPowerP.toFixed(2)})` : ''
      }\n` +
      `midFlyRecentreFrac = ${knobs.midFlyRecentreFrac.toFixed(2)}\n` +
      `chartPlateauMargin = ${knobs.chartPlateauMargin.toFixed(2)}\n` +
      `chartPhase3Scaling = ${knobs.chartPhase3ScalingEnabled}` +
      (knobs.chartPhase3ScalingEnabled ? ` (α=${knobs.chartPhase3Alpha.toFixed(2)})` : '');
  }
  renderSummary();
  // Re-render summary on any slider change. Cheaper than per-tick
  // because slider input is event-driven; debounce-free is fine.
  slidersBox.addEventListener('input', renderSummary);
  slidersBox.addEventListener('change', renderSummary);

  // --- Per-frame subscription -------------------------------------------
  // Dark-when-collapsed contract: early-return BEFORE any work when the
  // section isn't visible. No latches, no allocations.
  const onFrame = () => {
    if (!visible) return;
    const w = stellata.getWarpInfo();
    if (!w) {
      const lastBlock = lastWarp
        ? `\n\nlast warp: ${lastWarp.sourceKind}#${lastWarp.sourceIdx} → ` +
          `${lastWarp.destKind}#${lastWarp.destIdx}\n` +
          `  total ${lastWarp.totalMs.toFixed(0)} ms · ` +
          `plateau ${lastWarp.plateauFired ? 'Y' : 'N'}` +
          (lastWarp.plateauFired
            ? ` (d=${(lastWarp.plateauDistPc ?? 0).toFixed(3)} pc)`
            : '') +
          (lastWarp.plateauScaledPhase3 ? ' · p3 scaled' : '')
        : '';
      const text = '(idle)' + lastBlock;
      if (text !== lastReadoutText) {
        readout.textContent = text;
        lastReadoutText = text;
      }
      return;
    }
    // Active warp — assemble a single text block so we do one DOM write.
    const phase = stellata.getWarpPhase();
    if (!phase) return;
    const distCam = stellata.camera.position.distanceTo(w.B);
    const text =
      `phase: ${phase.kind}  ${phase.elapsedMs.toFixed(0)} / ${phase.totalMs.toFixed(0)} ms\n` +
      `u: ${phase.u.toFixed(3)}\n` +
      `cam → dest: ${distCam.toFixed(distCam < 1 ? 4 : 2)} pc\n` +
      `recentred: ${phase.recenteredToDest ? 'Y' : 'N'}  plateau: ${
        phase.chartPlateauDist != null ? phase.chartPlateauDist.toFixed(3) + ' pc' : '—'
      }  fired: ${phase.chartPlateauTriggered ? 'Y' : 'N'}`;
    if (text !== lastReadoutText) {
      readout.textContent = text;
      lastReadoutText = text;
    }
  };

  const unsubscribe = stellata.on('frame', onFrame);

  return {
    element: root,
    dispose: () => {
      unsubscribe();
    },
    setVisible: (v: boolean) => {
      visible = v;
    },
  };
}
