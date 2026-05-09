// Generic dev tuning/diagnostics panel — chrome (drag-to-move host with
// title bar) plus collapsible-section, slider, and colour-picker helpers
// that every section reuses. Each domain (Star disc, Milky Way, Perf,
// Pin) builds a labelled section and appends it to the shared panel root.
//
// State persisted in sessionStorage (not localStorage — calibration state
// should reset on reload):
//   stellata.debug.position           "{x,y}"
//   stellata.debug.collapsed.<key>    "1" | "0"
//
// Intentionally unstyled beyond inline CSS — this exists for calibration
// iteration, not production polish. The slider thumb/track styling does
// require pseudo-elements, so it lives in a one-shot <style> block
// injected on first panel build.

const POS_KEY = 'stellata.debug.position';
const collapsedKey = (key: string) => 'stellata.debug.collapsed.' + key;

const PANEL_WIDTH = 300;

interface Pos { x: number; y: number; }

function loadPosition(): Pos | null {
  try {
    const raw = sessionStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
  } catch { /* swallow — sessionStorage unavailable / corrupt */ }
  return null;
}

function savePosition(p: Pos): void {
  try { sessionStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

function loadCollapsed(key: string): boolean {
  try { return sessionStorage.getItem(collapsedKey(key)) === '1'; } catch { return false; }
}

function saveCollapsed(key: string, collapsed: boolean): void {
  try { sessionStorage.setItem(collapsedKey(key), collapsed ? '1' : '0'); } catch { /* ignore */ }
}

function clampToViewport(x: number, y: number): Pos {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - PANEL_WIDTH - margin);
  const maxY = Math.max(margin, window.innerHeight - 80);
  return {
    x: Math.max(margin, Math.min(maxX, x)),
    y: Math.max(margin, Math.min(maxY, y)),
  };
}

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  // Bigger slider — taller track and thumb so fine adjustments are easy
  // to grab. -webkit / -moz pseudo-elements are required to override the
  // native control; keep them in sync with the dimensions in
  // makeSlider's row layout (track height drives the row's apparent
  // height, thumb dims drive the click target).
  style.textContent = `
#debug-panel input[type="range"].debug-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 24px;
  background: transparent;
  margin: 0;
  cursor: pointer;
}
#debug-panel input[type="range"].debug-slider::-webkit-slider-runnable-track {
  height: 6px;
  background: #d0d0d0;
  border-radius: 3px;
  border: 1px solid #aaa;
}
#debug-panel input[type="range"].debug-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #555;
  border: 2px solid #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.3);
  margin-top: -7px;
  cursor: pointer;
}
#debug-panel input[type="range"].debug-slider::-moz-range-track {
  height: 6px;
  background: #d0d0d0;
  border-radius: 3px;
  border: 1px solid #aaa;
}
#debug-panel input[type="range"].debug-slider::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #555;
  border: 2px solid #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.3);
  cursor: pointer;
}
`;
  document.head.appendChild(style);
}

export interface DebugPanel {
  element: HTMLDivElement;
  body: HTMLDivElement;
}

export function makeDebugPanel(opts: { onClose: () => void }): DebugPanel {
  ensureStyles();

  const root = document.createElement('div');
  root.id = 'debug-panel';

  const initial = loadPosition() ?? { x: 8, y: 60 };
  const clamped = clampToViewport(initial.x, initial.y);

  root.style.cssText = [
    'position:fixed',
    `top:${clamped.y}px`,
    `left:${clamped.x}px`,
    'background:rgba(255,255,255,0.94)',
    'color:#000',
    'padding:0',
    'font-family:sans-serif',
    'font-size:11px',
    'line-height:1.3',
    `width:${PANEL_WIDTH}px`,
    'max-height:calc(100vh - 80px)',
    'display:flex',
    'flex-direction:column',
    'z-index:1000',
    'pointer-events:auto',
    'border:1px solid #888',
    'border-radius:4px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.2)',
  ].join(';');

  // Header bar — the drag handle. The close button is excluded from the
  // drag region by skipping pointerdown when target is a BUTTON.
  const header = document.createElement('div');
  header.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'padding:6px 10px',
    'background:#e8e8e8',
    'border-bottom:1px solid #ccc',
    'border-radius:4px 4px 0 0',
    'cursor:move',
    'user-select:none',
    'font-weight:bold',
    'flex:0 0 auto',
    'touch-action:none',
  ].join(';');

  const title = document.createElement('span');
  title.textContent = 'Debug';
  header.appendChild(title);

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '✕';
  close.title = 'close panel';
  close.style.cssText = [
    'background:transparent',
    'border:none',
    'cursor:pointer',
    'font-size:14px',
    'line-height:1',
    'padding:2px 6px',
    'color:#555',
  ].join(';');
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onClose();
  });
  header.appendChild(close);

  // Body — scrollable, fills the remaining height. Sections are appended
  // here. Pin/perf section bodies don't need user-select:none, so the
  // selectable readouts inside the pin section keep working — only the
  // header strip suppresses selection during drag.
  const body = document.createElement('div');
  body.style.cssText = [
    'padding:8px 10px',
    'overflow-y:auto',
    'flex:1 1 auto',
  ].join(';');

  root.appendChild(header);
  root.appendChild(body);

  // Drag-to-move via pointer events on header. setPointerCapture lets the
  // pointer briefly leave the header without dropping the drag.
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragging = false;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
    const rect = root.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    dragging = true;
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const c = clampToViewport(e.clientX - dragOffsetX, e.clientY - dragOffsetY);
    root.style.left = `${c.x}px`;
    root.style.top = `${c.y}px`;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId);
    const rect = root.getBoundingClientRect();
    savePosition({ x: rect.left, y: rect.top });
  };
  header.addEventListener('pointerdown', onPointerDown);
  header.addEventListener('pointermove', onPointerMove);
  header.addEventListener('pointerup', onPointerUp);
  header.addEventListener('pointercancel', onPointerUp);

  return { element: root, body };
}

export interface CollapsibleSection {
  section: HTMLDivElement;
  body: HTMLDivElement;
  isCollapsed: () => boolean;
}

export function makeCollapsibleSection(opts: {
  title: string;
  storageKey: string;
  onCollapseChange?: (collapsed: boolean) => void;
}): CollapsibleSection {
  const section = document.createElement('div');
  section.style.cssText = 'margin-bottom:10px;';

  const header = document.createElement('div');
  header.style.cssText = [
    'font-weight:bold',
    'cursor:pointer',
    'padding:3px 0',
    'border-bottom:1px solid #ccc',
    'margin-bottom:6px',
    'user-select:none',
    'display:flex',
    'align-items:center',
    'gap:6px',
  ].join(';');

  const caret = document.createElement('span');
  caret.style.cssText = 'font-size:9px; width:9px; display:inline-block;';

  const titleSpan = document.createElement('span');
  titleSpan.textContent = opts.title;

  header.appendChild(caret);
  header.appendChild(titleSpan);

  const body = document.createElement('div');

  let collapsed = loadCollapsed(opts.storageKey);

  const apply = (notify: boolean) => {
    body.style.display = collapsed ? 'none' : 'block';
    caret.textContent = collapsed ? '▶' : '▼';
    if (notify) opts.onCollapseChange?.(collapsed);
  };

  apply(false);

  header.addEventListener('click', () => {
    collapsed = !collapsed;
    saveCollapsed(opts.storageKey, collapsed);
    apply(true);
  });

  section.appendChild(header);
  section.appendChild(body);

  return {
    section,
    body,
    isCollapsed: () => collapsed,
  };
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
  row.style.cssText = 'margin-bottom:10px;';
  const label = document.createElement('label');
  label.style.cssText = 'display:block;';
  const labelLine = document.createElement('div');
  labelLine.style.cssText = 'display:flex; justify-content:space-between; align-items:baseline; margin-bottom:2px;';
  const labelText = document.createElement('span');
  labelText.textContent = opts.label;
  const valSpan = document.createElement('span');
  valSpan.style.cssText = 'font-family:monospace; color:#444;';
  const fmt = opts.format ?? ((v: number) => v.toFixed(3));
  valSpan.textContent = fmt(opts.initial);
  labelLine.appendChild(labelText);
  labelLine.appendChild(valSpan);

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'debug-slider';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.initial);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    valSpan.textContent = fmt(v);
    opts.onChange(v);
  });
  label.appendChild(labelLine);
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
  row.style.cssText = 'margin-bottom:8px;';
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
