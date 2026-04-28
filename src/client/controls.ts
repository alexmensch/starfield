import { Starfield, ALL_SPECT_MASK, DEFAULT_FOV, type MagPresetName } from './starfield';
import { fmtDist, onUnitChange, getUnit } from './distance-util';
import { bindConstellationTypeahead } from './constellation-typeahead';

// Matches the runtime initial value in starfield.ts (`starExaggerationK = 16`).
// The slider's display range is 1=Realistic … 20=Extreme; the default sits
// near the upper end because pure physical sizing leaves most stars
// sub-pixel.
const DEFAULT_EXAG_K = 16;

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

export function bindControls(starfield: Starfield) {
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
  const galOverlays = document.getElementById('gal-overlays') as HTMLInputElement;
  const showClouds = document.getElementById('show-clouds') as HTMLInputElement;
  const showMilkyway = document.getElementById('show-milkyway') as HTMLInputElement;
  const fov = document.getElementById('fov') as HTMLInputElement;
  const fovReadout = document.getElementById('fov-readout')!;
  const exag = document.getElementById('exag') as HTMLInputElement;

  distMin.max = String(SLIDER_STEPS);
  distMax.max = String(SLIDER_STEPS);

  bindConstellationTypeahead(starfield);

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
      const mask = starfield.getFilter().spectMask ^ (1 << bit);
      starfield.setFilter({ spectMask: mask });
    });
    chipEls.push(btn);
    chipsHost.appendChild(btn);
  }
  spectAllBtn.addEventListener('click', (e) => {
    e.preventDefault();
    starfield.setFilter({ spectMask: ALL_SPECT_MASK });
  });
  spectNoneBtn.addEventListener('click', (e) => {
    e.preventDefault();
    starfield.setFilter({ spectMask: 0 });
  });

  // Slider → filter.
  distMin.addEventListener('input', () => {
    let vMin = Number(distMin.value);
    let vMax = Number(distMax.value);
    if (vMin > vMax) { vMin = vMax; distMin.value = String(vMin); }
    starfield.setFilter({
      minDistSol: sliderToDist(vMin, true),
      maxDistSol: sliderToDist(vMax, false),
    });
  });
  distMax.addEventListener('input', () => {
    let vMin = Number(distMin.value);
    let vMax = Number(distMax.value);
    if (vMax < vMin) { vMax = vMin; distMax.value = String(vMax); }
    starfield.setFilter({
      minDistSol: sliderToDist(vMin, true),
      maxDistSol: sliderToDist(vMax, false),
    });
  });
  appMag.addEventListener('input', () => {
    starfield.setFilter({ maxAppMag: Number(appMag.value) });
  });
  for (const btn of Array.from(magPresets)) {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset as MagPresetName | undefined;
      if (preset === 'naked-eye' || preset === 'binoculars' || preset === 'all') {
        starfield.applyMagnitudePreset(preset);
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
    starfield.setFilter({
      sizeMin: vMin, sizeMinOverridden: true,
      ...(pushedMax ? { sizeMax: vMax, sizeMaxOverridden: true } : {}),
    });
  });
  sizeMax.addEventListener('input', () => {
    let vMin = Number(sizeMin.value);
    let vMax = Number(sizeMax.value);
    const pushedMin = vMax < vMin;
    if (pushedMin) { vMin = vMax; sizeMin.value = String(vMin); }
    starfield.setFilter({
      sizeMax: vMax, sizeMaxOverridden: true,
      ...(pushedMin ? { sizeMin: vMin, sizeMinOverridden: true } : {}),
    });
  });
  sizeSpan.addEventListener('input', () => {
    starfield.setFilter({ sizeSpan: Number(sizeSpan.value), sizeSpanOverridden: true });
  });
  galOverlays.addEventListener('change', () => {
    starfield.setFilter({ showGalacticOverlays: galOverlays.checked });
  });
  showClouds.addEventListener('change', () => {
    starfield.setFilter({ showMolecularClouds: showClouds.checked });
  });
  showMilkyway.addEventListener('change', () => {
    starfield.setFilter({ showMilkyway: showMilkyway.checked });
  });

  document.getElementById('size-reset')!.addEventListener('click', () => {
    starfield.clearSizeOverrides(['sizeMin', 'sizeMax']);
  });
  document.getElementById('span-reset')!.addEventListener('click', () => {
    starfield.clearSizeOverrides(['sizeSpan']);
  });
  fov.addEventListener('input', () => {
    starfield.setCameraFov(Number(fov.value));
  });
  document.getElementById('fov-reset')!.addEventListener('click', () => {
    starfield.setCameraFov(DEFAULT_FOV);
  });
  exag.addEventListener('input', () => {
    starfield.setStarExaggerationK(Number(exag.value));
  });
  document.getElementById('exag-reset')!.addEventListener('click', () => {
    starfield.setStarExaggerationK(DEFAULT_EXAG_K);
  });

  // Reverse sync: any filter change (user input, URL restore, presets) updates
  // DOM to match. Writing to .value does not re-dispatch 'input', so no loop.
  const syncFromFilter = () => {
    const f = starfield.getFilter();
    const sMin = distToSlider(f.minDistSol, true);
    const sMax = distToSlider(f.maxDistSol, false);
    if (distMin.value !== String(sMin)) distMin.value = String(sMin);
    if (distMax.value !== String(sMax)) distMax.value = String(sMax);
    distReadout.textContent = `${fmtDist(f.minDistSol)} – ${fmtDist(f.maxDistSol)}`;

    const magStr = f.maxAppMag.toString();
    if (appMag.value !== magStr) appMag.value = magStr;
    appMagReadout.textContent = `≤ ${f.maxAppMag.toFixed(1)}`;

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

    if (galOverlays.checked !== f.showGalacticOverlays) {
      galOverlays.checked = f.showGalacticOverlays;
    }
    if (showClouds.checked !== f.showMolecularClouds) {
      showClouds.checked = f.showMolecularClouds;
    }
    if (showMilkyway.checked !== f.showMilkyway) {
      showMilkyway.checked = f.showMilkyway;
    }
    const fovVal = starfield.getCameraFov();
    const fovStr = String(Math.round(fovVal));
    if (fov.value !== fovStr) fov.value = fovStr;
    fovReadout.textContent = `${Math.round(fovVal)}°`;

    const kStr = starfield.getStarExaggerationK().toString();
    if (exag.value !== kStr) exag.value = kStr;
  };

  starfield.onFilterChange(syncFromFilter);
  onUnitChange(() => {
    if (distUnitLabel) distUnitLabel.textContent = getUnit();
    syncFromFilter();
  });
  if (distUnitLabel) distUnitLabel.textContent = getUnit();
  syncFromFilter();
}
