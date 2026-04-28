import type { MilkyWay } from './milkyway';

// Dev-only tuning panel for the volumetric Milky Way layer. Builds a
// fixed-position div with sliders + colour pickers wired directly to
// the layer's setters. Intentionally unstyled (just enough inline CSS
// to be readable on either dark or chart backgrounds) — this exists to
// make calibration iteration fast, not to ship.
//
// Brightness uses a log-scale slider because the useful range spans
// ~7 orders of magnitude (1e-7 to ~10). Reddening uses linear sliders
// since the CCM default has channels above 1.0 (1.32 in blue), which
// rules out an HTML colour picker. Disc/bulge palette colours use
// `<input type="color">` since their channels are bounded to [0,1].

const BRIGHTNESS_LOG_MIN = -7; // 10^-7
const BRIGHTNESS_LOG_MAX = 1;  // 10^1
const BRIGHTNESS_LOG_RANGE = BRIGHTNESS_LOG_MAX - BRIGHTNESS_LOG_MIN;

function brightnessToSlider(v: number): number {
  if (v <= 0) return 0;
  return (Math.log10(v) - BRIGHTNESS_LOG_MIN) / BRIGHTNESS_LOG_RANGE;
}
function sliderToBrightness(s: number): number {
  return Math.pow(10, BRIGHTNESS_LOG_MIN + s * BRIGHTNESS_LOG_RANGE);
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

function makeSlider(opts: SliderOpts): HTMLDivElement {
  const row = document.createElement('div');
  row.style.cssText = 'margin-bottom:6px;';
  const label = document.createElement('label');
  label.style.cssText = 'display:block;';
  const labelText = document.createElement('span');
  labelText.textContent = opts.label + ': ';
  const valSpan = document.createElement('span');
  valSpan.style.cssText = 'font-family:monospace;';
  const fmt = opts.format ?? ((v: number) => v.toFixed(3));
  valSpan.textContent = fmt(opts.initial);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.initial);
  input.style.cssText = 'width:100%; display:block;';
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    valSpan.textContent = fmt(v);
    opts.onChange(v);
  });
  label.appendChild(labelText);
  label.appendChild(valSpan);
  label.appendChild(input);
  row.appendChild(label);
  return row;
}

interface ColorOpts {
  label: string;
  initial: { r: number; g: number; b: number };
  onChange: (rgb: { r: number; g: number; b: number }) => void;
}

function makeColor(opts: ColorOpts): HTMLDivElement {
  const row = document.createElement('div');
  row.style.cssText = 'margin-bottom:6px;';
  const label = document.createElement('label');
  label.style.cssText = 'display:flex; align-items:center; gap:6px;';
  const labelText = document.createElement('span');
  labelText.textContent = opts.label + ':';
  const input = document.createElement('input');
  input.type = 'color';
  input.value = rgbToHex(opts.initial.r, opts.initial.g, opts.initial.b);
  input.addEventListener('input', () => {
    opts.onChange(hexToRgb(input.value));
  });
  label.appendChild(labelText);
  label.appendChild(input);
  row.appendChild(label);
  return row;
}

export function attachMilkywayTuning(layer: MilkyWay): HTMLDivElement {
  const root = document.createElement('div');
  root.id = 'mw-tune';
  root.style.cssText = [
    'position:fixed',
    'top:60px',
    'left:8px',
    'background:rgba(255,255,255,0.92)',
    'color:#000',
    'padding:8px 10px',
    'font-family:sans-serif',
    'font-size:11px',
    'line-height:1.3',
    'width:240px',
    'z-index:1000',
    'pointer-events:auto',
    'border:1px solid #888',
    'border-radius:4px',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'Milky Way tuning';
  title.style.cssText = 'font-weight:bold; margin-bottom:6px;';
  root.appendChild(title);

  const v = layer.getValues();

  // Brightness — log-scale slider over [1e-7, 1e1]
  root.appendChild(makeSlider({
    label: 'brightness',
    min: 0,
    max: 1,
    step: 0.001,
    initial: brightnessToSlider(v.brightness),
    format: (s) => sliderToBrightness(s).toExponential(2),
    onChange: (s) => layer.setBrightness(sliderToBrightness(s)),
  }));

  root.appendChild(makeSlider({
    label: 'glowMagOffset',
    min: 5,
    max: 25,
    step: 0.1,
    initial: v.glowMagOffset,
    format: (x) => x.toFixed(1),
    onChange: (x) => layer.setGlowMagOffset(x),
  }));

  root.appendChild(makeSlider({
    label: 'discDensity',
    min: 0,
    max: 10,
    step: 0.05,
    initial: v.discDensity,
    format: (x) => x.toFixed(2),
    onChange: (x) => layer.setDiscDensity(x),
  }));

  root.appendChild(makeSlider({
    label: 'bulgeDensity',
    min: 0,
    max: 30,
    step: 0.1,
    initial: v.bulgeDensity,
    format: (x) => x.toFixed(2),
    onChange: (x) => layer.setBulgeDensity(x),
  }));

  root.appendChild(makeSlider({
    label: 'extinctionStrength',
    min: 0,
    max: 3,
    step: 0.05,
    initial: v.extinctionStrength,
    format: (x) => x.toFixed(2),
    onChange: (x) => layer.setExtinctionStrength(x),
  }));

  root.appendChild(makeColor({
    label: 'discColor',
    initial: v.discColor,
    onChange: ({ r, g, b }) => layer.setDiscColor(r, g, b),
  }));

  root.appendChild(makeColor({
    label: 'bulgeColor',
    initial: v.bulgeColor,
    onChange: ({ r, g, b }) => layer.setBulgeColor(r, g, b),
  }));

  // Reddening RGB — linear sliders since channels can exceed 1.0
  // (CCM default has 1.32 in blue). Updated together via a small
  // closure so any slider write applies all three current values.
  const reddening = { ...v.reddening };
  const updateReddening = () => layer.setReddeningRGB(reddening.r, reddening.g, reddening.b);
  for (const channel of ['r', 'g', 'b'] as const) {
    root.appendChild(makeSlider({
      label: 'reddening.' + channel,
      min: 0,
      max: 2,
      step: 0.01,
      initial: reddening[channel],
      format: (x) => x.toFixed(2),
      onChange: (x) => {
        reddening[channel] = x;
        updateReddening();
      },
    }));
  }

  document.body.appendChild(root);
  return root;
}
