// Generic dev tuning panel — provides the panel chrome (positioning,
// styling, header) and the slider / colour-picker / section helpers that
// every tool reuses. Each domain (Milky Way, Stellata, future tools)
// builds a labelled section and appends it to the shared panel root.
//
// Intentionally unstyled beyond inline CSS — this exists for calibration
// iteration, not production polish.

export function makeDebugPanel(): HTMLDivElement {
  const root = document.createElement('div');
  root.id = 'debug-panel';
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
    'max-height:calc(100vh - 80px)',
    'overflow-y:auto',
    'z-index:1000',
    'pointer-events:auto',
    'border:1px solid #888',
    'border-radius:4px',
  ].join(';');
  return root;
}

export function makeSection(title: string): HTMLDivElement {
  const section = document.createElement('div');
  section.style.cssText = 'margin-bottom:10px;';
  const header = document.createElement('div');
  header.textContent = title;
  header.style.cssText =
    'font-weight:bold; margin-bottom:6px; padding-bottom:3px;' +
    'border-bottom:1px solid #ccc;';
  section.appendChild(header);
  return section;
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

export function makeSlider(opts: SliderOpts): HTMLDivElement {
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

export interface ColorOpts {
  label: string;
  initial: { r: number; g: number; b: number };
  onChange: (rgb: { r: number; g: number; b: number }) => void;
}

export function makeColor(opts: ColorOpts): HTMLDivElement {
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
