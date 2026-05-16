// Lightweight always-callable instrumentation API. `mark`/`measure`/`frame`
// are no-ops until `buildPerfSection()` runs once, so call sites can stay
// unconditional. Install and teardown are symmetric: `buildPerfSection()`
// rewires the exported functions to their real implementations; the
// returned `dispose()` restores them to no-ops and clears all session
// state (ring buffers, starts map, frame counter). Re-opening the panel
// is a cold start — the previous session's history is gone. The cost
// of perf instrumentation outside of an active tuning session needs to
// be zero, and an always-on histogram-history mode is not worth the
// per-tick Map ops + section-GC walk it incurs in `realFrame`.
//
// The visible HUD is opt-in via `debug.panel()` from the dev console —
// deliberately not on a URL param or keyboard shortcut so
// end users can't enable it by accident. Updates the DOM at ~5Hz so style
// invalidation from the panel itself doesn't dominate measurements.
//
// DOM strategy: build the chrome (headline, table-header, row pool,
// histogram bars) once at section-build time, then per tick only mutate
// textContent and style on the existing nodes. The earlier
// `panelEl.innerHTML = ...` rebuild reparsed every span (60 histogram
// bars + N rows) every 200 ms even when values were unchanged — the
// instrumentation panel itself was sometimes the most expensive section
// it was measuring.

const RING_SIZE = 60;
const DOM_UPDATE_MS = 200;
const MS_PER_FRAME_60 = 1000 / 60;
const MAX_TABLE_ROWS = 8;

// Row-colour ramp: amber when average ms approaches the 60Hz budget.
// Absolute threshold rather than a fraction so the rows colour amber a
// touch earlier than the histogram, which keeps the at-a-glance summary
// trailing-pessimistic.
const AVG_AMBER_MS = 4;
// Histogram bar ramp: amber threshold expressed as a fraction of the
// 60Hz frame budget (~11.7 ms at MS_PER_FRAME_60 * 0.7).
const HISTO_AMBER_RATIO = 0.7;
// Histogram visible-height cap as a multiple of MS_PER_FRAME_60 — spikes
// above this clip rather than squashing the rest of the trace.
const HISTO_HEIGHT_CAP_MULT = 2;

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

// Persistent DOM handles populated by buildPerfDom() and mutated each tick.
let headlineEl: HTMLDivElement | null = null;
let captionEl: HTMLDivElement | null = null;
let lastCaptionN = -1;
const rowPool: { line: HTMLDivElement; label: HTMLSpanElement; values: HTMLSpanElement }[] = [];
const histoBars: HTMLSpanElement[] = [];
// Per-bar last-written height/colour so per-tick writes skip identical
// values — same dirty-tracking pattern chart-labels.ts uses for SVG.
const histoLastHeight: number[] = [];
const histoLastColour: string[] = [];

// Scratch row data reused across ticks. Index 0..N-1 holds the current
// frame's top sections in descending-avg order; only the first N rows
// in rowPool are visible, the rest are display:none.
interface RowDatum { label: string; avg: number; max: number; }
const rowScratch: RowDatum[] = [];

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

export interface PerfSection {
  element: HTMLDivElement;
  dispose: () => void;
  setVisible: (v: boolean) => void;
}

export function buildPerfSection(): PerfSection {
  if (!installed) {
    installed = true;
    _mark = realMark;
    _measure = realMeasure;
    _frame = realFrame;
  }

  // Reset DOM handles & per-bar caches so a re-open gets a fresh build.
  rowPool.length = 0;
  histoBars.length = 0;
  histoLastHeight.length = 0;
  histoLastColour.length = 0;

  const div = document.createElement('div');
  div.id = 'perf-hud';
  Object.assign(div.style, {
    padding: '8px 10px',
    background: 'rgba(0, 0, 0, 0.85)',
    color: '#cfe',
    font: "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: '1.35',
    borderRadius: '4px',
    minWidth: '240px',
  } as CSSStyleDeclaration);

  // Headline: rebuilt each tick via textContent on three nested spans so
  // we never reparse markup. Layout is "FPS NN low NN gpu N.NNms".
  const headline = document.createElement('div');
  headline.style.fontWeight = '600';
  headline.style.color = '#fff';
  headline.appendChild(document.createTextNode(''));            // "FPS NN "
  const lowSpan = document.createElement('span');
  lowSpan.style.color = '#fc8';
  lowSpan.appendChild(document.createTextNode(''));
  headline.appendChild(lowSpan);
  headline.appendChild(document.createTextNode(' '));
  const gpuSpan = document.createElement('span');
  gpuSpan.style.color = '#8cf';
  gpuSpan.appendChild(document.createTextNode(''));
  headline.appendChild(gpuSpan);
  div.appendChild(headline);
  headlineEl = headline;

  // Static table header row.
  const header = document.createElement('div');
  Object.assign(header.style, {
    marginTop: '6px',
    display: 'flex',
    justifyContent: 'space-between',
    color: '#888',
    borderBottom: '1px solid #333',
    paddingBottom: '2px',
    marginBottom: '2px',
  } as CSSStyleDeclaration);
  const headerLeft = document.createElement('span');
  headerLeft.textContent = 'section';
  const headerRight = document.createElement('span');
  headerRight.textContent = 'avg / max ms';
  header.appendChild(headerLeft);
  header.appendChild(headerRight);
  div.appendChild(header);

  // Row pool: MAX_TABLE_ROWS pre-allocated rows, hidden until populated.
  const rowsParent = document.createElement('div');
  for (let i = 0; i < MAX_TABLE_ROWS; i++) {
    const line = document.createElement('div');
    line.style.display = 'none';
    line.style.justifyContent = 'space-between';
    const label = document.createElement('span');
    const values = document.createElement('span');
    line.appendChild(label);
    line.appendChild(values);
    rowsParent.appendChild(line);
    rowPool.push({ line, label, values });
  }
  div.appendChild(rowsParent);

  // Histogram chrome + cached bars. Per-tick mutates only style.height /
  // style.background on each existing span — no innerHTML, no createElement.
  const histo = document.createElement('div');
  Object.assign(histo.style, {
    marginTop: '6px',
    height: '24px',
    lineHeight: '0',
    borderBottom: '1px solid #444',
  } as CSSStyleDeclaration);
  for (let i = 0; i < RING_SIZE; i++) {
    const bar = document.createElement('span');
    Object.assign(bar.style, {
      display: 'inline-block',
      width: '3px',
      height: '0px',
      background: '#8df',
      marginRight: '1px',
      verticalAlign: 'bottom',
    } as CSSStyleDeclaration);
    histo.appendChild(bar);
    histoBars.push(bar);
    histoLastHeight.push(-1);
    histoLastColour.push('');
  }
  div.appendChild(histo);

  const caption = document.createElement('div');
  caption.style.color = '#888';
  caption.style.fontSize = '10px';
  caption.textContent = `frame.total · last 0f · 16.7ms ref`;
  div.appendChild(caption);
  captionEl = caption;
  lastCaptionN = -1;

  panelEl = div;
  visible = true;
  return {
    element: div,
    dispose: () => {
      // Re-arm the always-callable no-op contract: every perfMark /
      // perfMeasure / perfFrame call site (stellata.ts animate() loop,
      // chart-labels.ts) keeps calling through the module-level
      // _mark/_measure/_frame, so the cheapest way to make those calls
      // free again is to point those bindings back at no-op stubs.
      _mark = () => {};
      _measure = () => {};
      _frame = () => {};
      installed = false;
      sections.clear();
      starts.clear();
      frameCounter = 0;
      lastDomUpdateMs = 0;
      visible = false;
      panelEl = null;
      headlineEl = null;
      captionEl = null;
      lastCaptionN = -1;
    },
    setVisible: (v: boolean) => {
      visible = v && panelEl !== null;
    },
  };
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

function fmtMs(v: number): string { return v.toFixed(v >= 10 ? 1 : 2); }

function colourForAvg(avg: number): string {
  return avg > MS_PER_FRAME_60 ? '#f88' : avg > AVG_AMBER_MS ? '#fc8' : '#cfe';
}

function renderPanel(): void {
  if (!panelEl || !headlineEl) return;

  const total = sections.get('frame.total');
  const totalStats = total ? summarize(total) : { avg: 0, max: 0 };
  const fpsAvg = totalStats.avg > 0 ? 1000 / totalStats.avg : 0;
  const fpsLow = totalStats.max > 0 ? 1000 / totalStats.max : 0;

  const gpu = sections.get('gpu.render');
  const gpuAvg = gpu ? summarize(gpu).avg : 0;

  // Headline text nodes (3 children: textNode, lowSpan, textNode, gpuSpan).
  const headlineNodes = headlineEl.childNodes;
  headlineNodes[0].nodeValue = `FPS ${fpsAvg.toFixed(0)} `;
  headlineEl.children[0].firstChild!.nodeValue = `low ${fpsLow.toFixed(0)}`;
  headlineEl.children[1].firstChild!.nodeValue = `gpu ${fmtMs(gpuAvg)}ms`;

  // Single-pass row build: walk the sections map once, summarise, and
  // insertion-sort into rowScratch (only need the top MAX_TABLE_ROWS so
  // the partial sort is bounded by MAX_TABLE_ROWS × sections-count
  // comparisons regardless of total section count).
  rowScratch.length = 0;
  for (const [label, s] of sections) {
    if (label === 'frame.total') continue;
    const stats = summarize(s);
    insertSorted(rowScratch, { label, avg: stats.avg, max: stats.max });
  }

  // Project rowScratch into the row pool: visible rows update, the rest
  // hide. textContent/colour writes are still cheap, but skip identical
  // text to spare DOM mutations on stable workloads.
  for (let i = 0; i < MAX_TABLE_ROWS; i++) {
    const slot = rowPool[i];
    if (i >= rowScratch.length) {
      if (slot.line.style.display !== 'none') slot.line.style.display = 'none';
      continue;
    }
    const r = rowScratch[i];
    if (slot.line.style.display !== 'flex') slot.line.style.display = 'flex';
    if (slot.label.textContent !== r.label) slot.label.textContent = r.label;
    const valStr = `${fmtMs(r.avg)} / ${fmtMs(r.max)}`;
    if (slot.values.textContent !== valStr) slot.values.textContent = valStr;
    const colour = colourForAvg(r.avg);
    if (slot.line.style.color !== colour) slot.line.style.color = colour;
  }

  // Histogram: write only the bars that changed. Cap at 2× the 60Hz frame
  // budget so spikes don't squash the rest of the trace beyond legibility.
  if (total && total.count > 0) {
    const N = total.count;
    const start = (total.idx - N + RING_SIZE) % RING_SIZE;
    const cap = MS_PER_FRAME_60 * HISTO_HEIGHT_CAP_MULT;
    const amberMs = MS_PER_FRAME_60 * HISTO_AMBER_RATIO;
    if (captionEl && lastCaptionN !== N) {
      captionEl.textContent = `frame.total · last ${N}f · 16.7ms ref`;
      lastCaptionN = N;
    }
    for (let i = 0; i < RING_SIZE; i++) {
      const bar = histoBars[i];
      if (i >= N) {
        if (histoLastHeight[i] !== 0) {
          bar.style.height = '0px';
          histoLastHeight[i] = 0;
        }
        continue;
      }
      const v = total.ring[(start + i) % RING_SIZE];
      const h = Math.min(1, v / cap);
      // 0.1 px quantisation to skip writes that wouldn't visually differ
      // — toFixed(1) below truncates the same way.
      const heightPx = Math.round(h * 240) / 10;
      const colour =
        v > MS_PER_FRAME_60 ? '#f88' :
        v > amberMs ? '#fc8' :
        '#8df';
      if (histoLastHeight[i] !== heightPx) {
        bar.style.height = `${heightPx}px`;
        histoLastHeight[i] = heightPx;
      }
      if (histoLastColour[i] !== colour) {
        bar.style.background = colour;
        histoLastColour[i] = colour;
      }
    }
  } else {
    for (let i = 0; i < RING_SIZE; i++) {
      if (histoLastHeight[i] !== 0) {
        histoBars[i].style.height = '0px';
        histoLastHeight[i] = 0;
      }
    }
  }
}

// Insertion into a fixed-cap descending-by-avg array. Walk the existing
// rows once, find insert position, splice (drops the last one if at cap).
// For ≤8 visible rows this is cheaper than a full sort over N sections.
function insertSorted(arr: RowDatum[], r: RowDatum): void {
  let pos = arr.length;
  for (let i = 0; i < arr.length; i++) {
    if (r.avg > arr[i].avg) { pos = i; break; }
  }
  if (pos === MAX_TABLE_ROWS) return;
  arr.splice(pos, 0, r);
  if (arr.length > MAX_TABLE_ROWS) arr.length = MAX_TABLE_ROWS;
}
