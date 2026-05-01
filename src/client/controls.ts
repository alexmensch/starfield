import { Stellata, ALL_SPECT_MASK, DEFAULT_FOV, MAG_PRESETS, type MagPresetName } from './stellata';
import { fmtDist, onUnitChange, getUnit } from './distance-util';
import { bindConstellationTypeahead } from './constellation-typeahead';

const SPECT_LABELS: { key: string; label: string; bit: number }[] = [
  { key: 'O', label: 'O', bit: 0 },
  { key: 'B', label: 'B', bit: 1 },
  { key: 'A', label: 'A', bit: 2 },
  { key: 'F', label: 'F', bit: 3 },
  { key: 'G', label: 'G', bit: 4 },
  { key: 'K', label: 'K', bit: 5 },
  { key: 'M', label: 'M', bit: 6 },
  { key: 'C', label: 'C/S/W', bit: 7 },
  { key: '?', label: '?', bit: 8 },
];

export const DIST_MIN_PC = 0.01;
export const DIST_MAX_PC = 50_000;
const DIST_LOG_MIN = Math.log10(DIST_MIN_PC);
const DIST_LOG_MAX = Math.log10(DIST_MAX_PC);
const DIST_RANGE = DIST_LOG_MAX - DIST_LOG_MIN;
export const SLIDER_STEPS = 1000;

export function sliderToDist(v: number, isMin: boolean): number {
  if (isMin && v === 0) return 0;
  return 10 ** (DIST_LOG_MIN + (v / SLIDER_STEPS) * DIST_RANGE);
}

export function distToSlider(pc: number, isMin: boolean): number {
  if (isMin && pc <= 0) return 0;
  if (pc <= 0) return 0;
  const v = ((Math.log10(pc) - DIST_LOG_MIN) / DIST_RANGE) * SLIDER_STEPS;
  return Math.max(0, Math.min(SLIDER_STEPS, Math.round(v)));
}

export function bindControls(stellata: Stellata) {
  const distMin = document.getElementById('dist-min') as HTMLInputElement;
  const distMax = document.getElementById('dist-max') as HTMLInputElement;
  const distReadout = document.getElementById('dist-readout')!;
  const appMag = document.getElementById('app-mag') as HTMLInputElement;
  const appMagReadout = document.getElementById('app-mag-readout')!;
  const magPresets = document.querySelectorAll<HTMLButtonElement>('.mag-preset');
  const chipsHost = document.getElementById('spect-chips')!;
  const spectAllBtn = document.getElementById('spect-all')!;
  const spectNoneBtn = document.getElementById('spect-none')!;
  const sizeMin = document.getElementById('size-min') as HTMLInputElement;
  const sizeMax = document.getElementById('size-max') as HTMLInputElement;
  const sizeSpan = document.getElementById('size-span') as HTMLInputElement;
  const sizeReadout = document.getElementById('size-readout')!;
  const distUnitLabel = document.getElementById('dist-unit-label');
  const showHud = document.getElementById('show-hud') as HTMLInputElement;
  const showConstellation = document.getElementById('show-constellation') as HTMLInputElement;
  const conInput = document.getElementById('con-input') as HTMLInputElement | null;
  const conPicker = document.getElementById('con-picker');
  const showMilkyway = document.getElementById('show-milkyway') as HTMLInputElement;
  const showGalacticGrid = document.getElementById('show-galactic-grid') as HTMLInputElement;
  const showChart = document.getElementById('show-chart') as HTMLInputElement;
  const fov = document.getElementById('fov') as HTMLInputElement;
  const fovReadout = document.getElementById('fov-readout')!;
  const exag = document.getElementById('exag') as HTMLInputElement;

  distMin.max = String(SLIDER_STEPS);
  distMax.max = String(SLIDER_STEPS);

  bindConstellationTypeahead(stellata);

  // Spectral chips (static).
  const chipEls: HTMLButtonElement[] = [];
  for (const { key, label, bit } of SPECT_LABELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.class = key;
    btn.dataset.bit = String(bit);
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const mask = stellata.getFilter().spectMask ^ (1 << bit);
      stellata.setFilter({ spectMask: mask });
    });
    chipEls.push(btn);
    chipsHost.appendChild(btn);
  }
  spectAllBtn.addEventListener('click', (e) => {
    e.preventDefault();
    stellata.setFilter({ spectMask: ALL_SPECT_MASK });
  });
  spectNoneBtn.addEventListener('click', (e) => {
    e.preventDefault();
    stellata.setFilter({ spectMask: 0 });
  });

  // Slider → filter.
  distMin.addEventListener('input', () => {
    let vMin = Number(distMin.value);
    let vMax = Number(distMax.value);
    if (vMin > vMax) { vMin = vMax; distMin.value = String(vMin); }
    stellata.setFilter({
      minDistSol: sliderToDist(vMin, true),
      maxDistSol: sliderToDist(vMax, false),
    });
  });
  distMax.addEventListener('input', () => {
    let vMin = Number(distMin.value);
    let vMax = Number(distMax.value);
    if (vMax < vMin) { vMax = vMin; distMax.value = String(vMax); }
    stellata.setFilter({
      minDistSol: sliderToDist(vMin, true),
      maxDistSol: sliderToDist(vMax, false),
    });
  });
  appMag.addEventListener('input', () => {
    stellata.setFilter({ maxAppMag: Number(appMag.value) });
  });
  for (const btn of Array.from(magPresets)) {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset as MagPresetName | undefined;
      if (preset === 'naked-eye' || preset === 'binoculars' || preset === 'all') {
        stellata.applyMagnitudePreset(preset);
      }
    });
  }
  // Size sliders set their override flag so the value sticks across
  // preset changes and viewport resizes until the reset button clears it.
  // Min/Max are coupled — dragging one past the other pushes the other
  // along and marks both overridden.
  sizeMin.addEventListener('input', () => {
    let vMin = Number(sizeMin.value);
    let vMax = Number(sizeMax.value);
    const pushedMax = vMin > vMax;
    if (pushedMax) { vMax = vMin; sizeMax.value = String(vMax); }
    stellata.setFilter({
      sizeMin: vMin, sizeMinOverridden: true,
      ...(pushedMax ? { sizeMax: vMax, sizeMaxOverridden: true } : {}),
    });
  });
  sizeMax.addEventListener('input', () => {
    let vMin = Number(sizeMin.value);
    let vMax = Number(sizeMax.value);
    const pushedMin = vMax < vMin;
    if (pushedMin) { vMin = vMax; sizeMin.value = String(vMin); }
    stellata.setFilter({
      sizeMax: vMax, sizeMaxOverridden: true,
      ...(pushedMin ? { sizeMin: vMin, sizeMinOverridden: true } : {}),
    });
  });
  sizeSpan.addEventListener('input', () => {
    stellata.setFilter({ sizeSpan: Number(sizeSpan.value), sizeSpanOverridden: true });
  });
  showHud.addEventListener('change', () => {
    stellata.setFilter({ showHud: showHud.checked });
  });
  showConstellation.addEventListener('change', () => {
    stellata.setFilter({ showConstellation: showConstellation.checked });
  });
  showMilkyway.addEventListener('change', () => {
    stellata.setFilter({ showMilkyway: showMilkyway.checked });
  });
  showGalacticGrid.addEventListener('change', () => {
    stellata.setFilter({ showGalacticGrid: showGalacticGrid.checked });
  });
  showChart.addEventListener('change', () => {
    stellata.setFilter({ chart: showChart.checked });
  });

  document.getElementById('size-reset')!.addEventListener('click', () => {
    stellata.clearSizeOverrides(['sizeMin', 'sizeMax']);
  });
  document.getElementById('span-reset')!.addEventListener('click', () => {
    stellata.clearSizeOverrides(['sizeSpan']);
  });
  fov.addEventListener('input', () => {
    stellata.setCameraFov(Number(fov.value));
  });
  document.getElementById('fov-reset')!.addEventListener('click', () => {
    stellata.setCameraFov(DEFAULT_FOV);
  });
  exag.addEventListener('input', () => {
    stellata.setStarExaggerationK(Number(exag.value));
  });
  document.getElementById('exag-reset')!.addEventListener('click', () => {
    stellata.setStarExaggerationK(stellata.getStarExaggerationKDefault());
  });

  // Reverse sync: any filter change (user input, URL restore, presets) updates
  // DOM to match. Writing to .value does not re-dispatch 'input', so no loop.
  const syncFromFilter = () => {
    const f = stellata.getFilter();
    const sMin = distToSlider(f.minDistSol, true);
    const sMax = distToSlider(f.maxDistSol, false);
    if (distMin.value !== String(sMin)) distMin.value = String(sMin);
    if (distMax.value !== String(sMax)) distMax.value = String(sMax);
    distReadout.textContent = `${fmtDist(f.minDistSol)} – ${fmtDist(f.maxDistSol)}`;

    const magStr = f.maxAppMag.toString();
    if (appMag.value !== magStr) appMag.value = magStr;
    appMagReadout.textContent = `≤ ${f.maxAppMag.toFixed(1)}`;

    // Highlight whichever preset button matches the current slider value.
    // Value-driven (not click-driven) so dragging the slider to 6.5 still
    // lights up "naked eye".
    for (const btn of Array.from(magPresets)) {
      const preset = btn.dataset.preset as MagPresetName | undefined;
      const matches =
        preset === 'naked-eye' || preset === 'binoculars' || preset === 'all'
          ? Math.abs(f.maxAppMag - MAG_PRESETS[preset].maxAppMag) < 0.05
          : false;
      btn.classList.toggle('on', matches);
    }

    for (const el of chipEls) {
      const bit = Number(el.dataset.bit);
      el.classList.toggle('on', (f.spectMask & (1 << bit)) !== 0);
    }

    const sMinStr = f.sizeMin.toString();
    const sMaxStr = f.sizeMax.toString();
    const spanStr = f.sizeSpan.toString();
    if (sizeMin.value !== sMinStr) sizeMin.value = sMinStr;
    if (sizeMax.value !== sMaxStr) sizeMax.value = sMaxStr;
    if (sizeSpan.value !== spanStr) sizeSpan.value = spanStr;
    sizeReadout.textContent = `${f.sizeMin.toFixed(1)} – ${f.sizeMax.toFixed(1)}px · span ${f.sizeSpan.toFixed(0)}mag`;

    if (showHud.checked !== f.showHud) {
      showHud.checked = f.showHud;
    }
    if (showConstellation.checked !== f.showConstellation) {
      showConstellation.checked = f.showConstellation;
    }
    // Picker mirrors the master toggle: disabled when constellations are
    // hidden, so the user can't change `highlightCon` from a state they
    // can't see. The picked value persists on the filter, so re-enabling
    // restores whatever was last chosen. The `.disabled` class on the
    // wrapper drives the muted styling on the "Constellation" sub-label
    // alongside the input itself.
    if (conInput) conInput.disabled = !f.showConstellation;
    if (conPicker) conPicker.classList.toggle('disabled', !f.showConstellation);
    if (showMilkyway.checked !== f.showMilkyway) {
      showMilkyway.checked = f.showMilkyway;
    }
    if (showGalacticGrid.checked !== f.showGalacticGrid) {
      showGalacticGrid.checked = f.showGalacticGrid;
    }
    // Chart toggle is observe-gated. Disable when not in observe so the
    // user sees why it can't be enabled (the title attribute on the row
    // explains it).
    const observeMode = stellata.getCameraMode() === 'observe';
    showChart.disabled = !observeMode;
    if (showChart.checked !== f.chart) showChart.checked = f.chart;
    // Galactic-glow checkbox is meaningless in chart mode (the volumetric
    // layer is hidden), so freeze it visually while preserving the
    // underlying filter value for restoration on chart-off.
    const chartActive = f.chart && observeMode;
    showMilkyway.disabled = chartActive;
    const fovVal = stellata.getCameraFov();
    const fovStr = String(Math.round(fovVal));
    if (fov.value !== fovStr) fov.value = fovStr;
    fovReadout.textContent = `${Math.round(fovVal)}°`;

    const kStr = stellata.getStarExaggerationK().toString();
    if (exag.value !== kStr) exag.value = kStr;
  };

  stellata.onFilterChange(syncFromFilter);
  stellata.onCameraModeChange(syncFromFilter);
  onUnitChange(() => {
    if (distUnitLabel) distUnitLabel.textContent = getUnit();
    syncFromFilter();
  });
  if (distUnitLabel) distUnitLabel.textContent = getUnit();
  syncFromFilter();
}
