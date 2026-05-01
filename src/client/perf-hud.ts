import type { Stellata } from './stellata';

// Lightweight always-callable instrumentation API. `mark`/`measure`/`frame`
// are no-ops until `installPerfHud()` runs, so call sites can stay
// unconditional. The visible HUD is opt-in via `debug.perf()` from the
// dev console — deliberately not on a URL param or keyboard shortcut so
// end users can't enable it by accident. Updates the DOM at ~5Hz so
// style invalidation from the panel itself doesn't dominate measurements.

const RING_SIZE = 60;
const DOM_UPDATE_MS = 200;
const MS_PER_FRAME_60 = 1000 / 60;

interface SectionStats {
  ring: Float32Array;
  idx: number;
  count: number;
  // Last frame index where this section was written. Sections that go
  // dormant (e.g. chart.* after exiting chart mode) get garbage-collected
  // once they've been silent for RING_SIZE frames so the HUD doesn't keep
  // averaging stale ring data.
  lastFrame: number;
}

const sections = new Map<string, SectionStats>();
const starts = new Map<string, number>();
let frameCounter = 0;

let installed = false;
let visible = false;
let panelEl: HTMLDivElement | null = null;
let lastDomUpdateMs = 0;

function ensureSection(label: string): SectionStats {
  let s = sections.get(label);
  if (!s) {
    s = { ring: new Float32Array(RING_SIZE), idx: 0, count: 0, lastFrame: frameCounter };
    sections.set(label, s);
  }
  return s;
}

function realMark(label: string): void {
  starts.set(label, performance.now());
}

function realMeasure(label: string): void {
  const start = starts.get(label);
  if (start === undefined) return;
  const dt = performance.now() - start;
  const s = ensureSection(label);
  s.ring[s.idx] = dt;
  s.idx = (s.idx + 1) % RING_SIZE;
  if (s.count < RING_SIZE) s.count++;
  s.lastFrame = frameCounter;
}

function realFrame(): void {
  frameCounter++;
  // Drop sections that haven't reported in a full ring-window. Without
  // this, the HUD averages stale data forever (chart.* entries persisted
  // in navigate mode after exiting chart mode).
  for (const [label, s] of sections) {
    if (frameCounter - s.lastFrame > RING_SIZE) sections.delete(label);
  }
  if (!visible || !panelEl) return;
  const now = performance.now();
  if (now - lastDomUpdateMs < DOM_UPDATE_MS) return;
  lastDomUpdateMs = now;
  renderPanel();
}

let _mark: (l: string) => void = () => {};
let _measure: (l: string) => void = () => {};
let _frame: () => void = () => {};

export function mark(label: string): void { _mark(label); }
export function measure(label: string): void { _measure(label); }
export function frame(): void { _frame(); }

export function installPerfHud(_stellata: Stellata): void {
  if (installed) return;
  installed = true;
  _mark = realMark;
  _measure = realMeasure;
  _frame = realFrame;
  ensurePanel();
  setVisible(true);
}

export function togglePerfHud(): void {
  if (!installed) return;
  setVisible(!visible);
}

function setVisible(v: boolean): void {
  visible = v;
  if (panelEl) panelEl.style.display = v ? 'block' : 'none';
}

function ensurePanel(): void {
  if (panelEl) return;
  const div = document.createElement('div');
  div.id = 'perf-hud';
  Object.assign(div.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '9999',
    padding: '8px 10px',
    background: 'rgba(0, 0, 0, 0.72)',
    color: '#cfe',
    font: "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: '1.35',
    borderRadius: '6px',
    pointerEvents: 'none',
    minWidth: '240px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  } as CSSStyleDeclaration);
  document.body.appendChild(div);
  panelEl = div;
}

function summarize(s: SectionStats): { avg: number; max: number } {
  if (s.count === 0) return { avg: 0, max: 0 };
  let sum = 0;
  let max = 0;
  for (let i = 0; i < s.count; i++) {
    const v = s.ring[i];
    sum += v;
    if (v > max) max = v;
  }
  return { avg: sum / s.count, max };
}

function renderPanel(): void {
  if (!panelEl) return;

  const total = sections.get('frame.total');
  const totalStats = total ? summarize(total) : { avg: 0, max: 0 };
  const fpsAvg = totalStats.avg > 0 ? 1000 / totalStats.avg : 0;
  const fpsLow = totalStats.max > 0 ? 1000 / totalStats.max : 0;

  const gpu = sections.get('gpu.render');
  const gpuAvg = gpu ? summarize(gpu).avg : 0;

  const labels = Array.from(sections.keys()).filter((l) => l !== 'frame.total');
  const rows = labels.map((l) => {
    const stats = summarize(sections.get(l)!);
    return { label: l, avg: stats.avg, max: stats.max };
  });
  rows.sort((a, b) => b.avg - a.avg);
  const top = rows.slice(0, 8);

  const fmt = (v: number): string => v.toFixed(v >= 10 ? 1 : 2);
  const headline =
    `<div style="font-weight:600;color:#fff">FPS ${fpsAvg.toFixed(0)} ` +
    `<span style="color:#fc8">low ${fpsLow.toFixed(0)}</span> ` +
    `<span style="color:#8cf">gpu ${fmt(gpuAvg)}ms</span></div>`;

  const tableRows = top
    .map((r) => {
      const colour = r.avg > MS_PER_FRAME_60 ? '#f88' : r.avg > 4 ? '#fc8' : '#cfe';
      return (
        `<div style="display:flex;justify-content:space-between;color:${colour}">` +
        `<span>${r.label}</span>` +
        `<span>${fmt(r.avg)} / ${fmt(r.max)}</span>` +
        `</div>`
      );
    })
    .join('');
  const table =
    `<div style="margin-top:6px;display:flex;justify-content:space-between;` +
    `color:#888;border-bottom:1px solid #333;padding-bottom:2px;margin-bottom:2px">` +
    `<span>section</span><span>avg / max ms</span></div>` +
    tableRows;

  const histo = total ? renderHistogram(total) : '';

  panelEl.innerHTML = headline + table + histo;
}

function renderHistogram(s: SectionStats): string {
  // Walk the ring in chronological order so the latest frame is rightmost.
  const N = s.count;
  if (N === 0) return '';
  const start = (s.idx - N + RING_SIZE) % RING_SIZE;
  const bars: string[] = [];
  // Cap visible bar height at 2× target frame budget so spikes don't
  // squash the rest of the trace beyond legibility.
  const cap = MS_PER_FRAME_60 * 2;
  for (let i = 0; i < N; i++) {
    const v = s.ring[(start + i) % RING_SIZE];
    const h = Math.min(1, v / cap);
    const colour = v > MS_PER_FRAME_60 ? '#f88' : v > MS_PER_FRAME_60 * 0.7 ? '#fc8' : '#8df';
    bars.push(
      `<span style="display:inline-block;width:3px;height:${(h * 24).toFixed(1)}px;` +
      `background:${colour};margin-right:1px;vertical-align:bottom"></span>`,
    );
  }
  return (
    `<div style="margin-top:6px;height:24px;line-height:0;` +
    `border-bottom:1px solid #444">${bars.join('')}</div>` +
    `<div style="color:#888;font-size:10px">frame.total · last ${N}f · 16.7ms ref</div>`
  );
}
