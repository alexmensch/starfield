import * as THREE from 'three';
import type { Starfield } from './starfield';
import type { ChartModeContext } from './chart-mode';

// Phase 8 — chart-mode label engine. Per-frame, projects every candidate
// label (proper-named star, Bayer-letter star, constellation Latin name,
// molecular cloud) through the camera, prioritises by (kind, brightness),
// runs a greedy collision pass against an axis-aligned screen-rect index,
// and writes the survivors into a single `<g id="chart-labels">` SVG
// container. Unused `<text>` elements are pooled across frames — adding /
// removing nodes is free as long as we cap reuse.
//
// Constellation Latin names are placed first (priority 0) so they survive
// every collision. Stars + Bayer + cloud labels then fill the remaining
// space. There's no density slider — chart shows everything visible at
// the current magnitude limit, subject to collision.

// Inflated AABB around each label's bounding rect, in CSS pixels. Wider
// padding = more aggressive culling = sparser, more readable layout.
const COLLISION_PAD_PX = 4;
// Star-name labels reject any label that lands inside this radius from
// the star centre — keeps the name from sitting on top of its glyph.
const STAR_LABEL_OFFSET_PX = 9;
// Sky-Atlas-style horizontal wings on double / multiple stars extend
// beyond the disc edge by `discPx * RATIO` pixels on each side, so the
// wings stay visually proportional across the chart-mode magnitude range
// (16 px disc → 4 px wings, 6 px disc → 1.5 px wings). Below the
// MIN_EXTENSION_PX floor the wings would be subpixel and the star would
// be too faint to read as a binary anyway, so we skip the glyph entirely
// rather than render a degenerate stub.
//
// The 1.5 px floor (≡ requiring an un-extincted CPU disc of ≥ 6 px) also
// papers over a CPU/GPU mismatch: this code mirrors the chart-mode disc
// formula without per-star dust extinction (the CPU raymarch is too
// expensive to replicate per frame), so for stars sitting behind heavy
// dust the GPU renders a much smaller disc than the CPU computes here.
// Without this margin the wings on a dust-attenuated star (e.g. 55 Cyg
// in the Cygnus arm) would dwarf the actual rendered disc. The margin
// trades a few legitimate wings on faint un-extincted stars for visual
// coherence in dusty regions. Proper fix when needed: load a coarser
// (~128³) Edenhofer voxel resample CPU-side and raymarch per-binary in
// the per-frame loop.
const BINARY_WING_EXTENSION_RATIO = 0.25;
const BINARY_WING_MIN_EXTENSION_PX = 1.5;
// Minimum radial gap (CSS pixels) between the outer variable-ring and the
// inner pulsing disc at its peak size. Without this, low-amplitude
// variables draw a ring sitting flush against the disc — no perceptible
// "ring with breathing dot" reading. We push the ring outward by this
// amount past the brightest-extreme disc radius unconditionally, which
// means the ring diameter no longer encodes "max brightness" exactly —
// that's a deliberate trade so the glyph stays legible.
const VARIABLE_RING_MIN_GAP_PX = 1.0;

interface Candidate {
  kind: 'name' | 'bayer' | 'con' | 'cloud';
  text: string;
  // Screen-space anchor (top-left of the projected bbox), already
  // computed from the projected centre + offset.
  x: number;
  y: number;
  // Approximate bounding rect for collision (text width measured lazily
  // on first render via getBBox; cached per element).
  width: number;
  height: number;
  // Sort priority — lower wins. Stable composite of kind + apparent mag.
  priority: number;
  // Stable identity for DOM-pool keying. Strings keep the pool keys
  // distinct across kinds (e.g. star idx vs cloud idx vs constellation
  // idx don't collide).
  key: string;
}

interface PooledText {
  el: SVGTextElement;
  width: number; // last measured text width
  height: number; // last measured height
}

// Single per-page state — chart mode is a single-instance feature.
// `active` is the runtime gate read by the per-frame tick; the onFrame
// handler is registered exactly once (the first time chart engages) and
// short-circuits whenever active is false. Toggling chart on/off therefore
// doesn't churn handlers on the starfield's onFrame list.
let active = false;
let registered = false;
let layer: SVGGElement | null = null;
let glyphLayer: SVGGElement | null = null;
let conStars: Map<number, ConMembership> | null = null;
let variableIdxs: number[] | null = null;
let binaryIdxs: number[] | null = null;
// distSol[i] = distance from Sol to star i, in parsecs. Catalog positions
// are absolute (Sol-centred ICRS), so |position| is the absolute distance.
// Precomputed once at chart entry; the GPU mirrors this via iDistSol.
let distSolCache: Float32Array | null = null;
let activeCtx: ChartModeContext | null = null;
const pool = new Map<string, PooledText>();
const ringPool = new Map<number, SVGCircleElement>();
const wingPool = new Map<number, SVGLineElement>();
const tmpV3 = new THREE.Vector3();

export function startChartLabels(
  starfield: Starfield,
  ctx: ChartModeContext,
): void {
  if (active) return;
  active = true;
  activeCtx = ctx;
  layer = ensureLayer('chart-labels');
  glyphLayer = ensureLayer('chart-glyphs');
  layer.style.display = '';
  glyphLayer.style.display = '';

  if (!conStars) conStars = buildConstellationMembership(starfield);
  if (!variableIdxs || !binaryIdxs || !distSolCache) {
    const cat = starfield.catalog;
    const vs: number[] = [];
    const bs: number[] = [];
    const ds = new Float32Array(cat.count);
    const pos = cat.positions;
    for (let i = 0; i < cat.count; i++) {
      if (cat.periodDays[i] > 0 && cat.amplitudeMag[i] > 0) vs.push(i);
      // Bit 4 (0x10) = isBinaryPrimary per the catalog flag schema. We
      // use the primary-only set so each system gets one wings glyph
      // anchored on the brighter component.
      if ((cat.flags[i] & 0x10) !== 0) bs.push(i);
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      ds[i] = Math.sqrt(x * x + y * y + z * z);
    }
    variableIdxs = vs;
    binaryIdxs = bs;
    distSolCache = ds;
  }

  if (!registered) {
    registered = true;
    starfield.onFrame(() => {
      if (!active || !layer || !glyphLayer || !conStars || !activeCtx) return;
      tick(starfield, activeCtx, conStars);
    });
  }
}

export function stopChartLabels(): void {
  if (!active) return;
  active = false;
  if (layer) {
    layer.style.display = 'none';
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }
  if (glyphLayer) {
    glyphLayer.style.display = 'none';
    while (glyphLayer.firstChild) glyphLayer.removeChild(glyphLayer.firstChild);
  }
  pool.clear();
  ringPool.clear();
  wingPool.clear();
}

function ensureLayer(id: string): SVGGElement {
  const existing = document.getElementById(id) as SVGGElement | null;
  if (existing) return existing;
  const overlay = document.getElementById('overlay') as unknown as SVGSVGElement;
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('id', id);
  overlay.appendChild(g);
  return g;
}

interface ConMembership {
  stars: number[];
  // Recomputed per frame from positions[]. Stored on the membership
  // object itself to avoid allocating per-frame.
  centroid: THREE.Vector3;
}

function buildConstellationMembership(starfield: Starfield): Map<number, ConMembership> {
  const cat = starfield.catalog;
  const out = new Map<number, ConMembership>();
  for (let i = 0; i < cat.count; i++) {
    const conIdx = cat.constellation[i];
    if (conIdx === 255) continue;
    const m = out.get(conIdx);
    if (!m) {
      out.set(conIdx, { stars: [i], centroid: new THREE.Vector3() });
    } else {
      m.stars.push(i);
    }
  }
  return out;
}

function tick(
  starfield: Starfield,
  ctx: ChartModeContext,
  conStars: Map<number, ConMembership>,
): void {
  if (!layer || !glyphLayer) return;
  const labelLayer = layer;
  const glyphs = glyphLayer;
  const f = starfield.getFilter();
  const camera = starfield.camera;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const positions = starfield.localPositions;
  const cat = starfield.catalog;

  const candidates: Candidate[] = [];
  const seen = new Set<number>(); // dedupe star idx across name+bayer

  // 1) Proper-named stars. Iterate the names map directly; size of the
  // map is small (~hundreds) so this is cheap. Priority sits below the
  // constellation Latin labels (priority 0) so the constellation name
  // always wins a collision.
  for (const [idx, name] of cat.names) {
    const xy = projectStar(idx, positions, camera, w, h);
    if (!xy) continue;
    const appMag = computeAppMag(idx, positions, cat.absmag);
    if (appMag > f.maxAppMag) continue;
    candidates.push({
      kind: 'name',
      text: name,
      x: xy[0] + STAR_LABEL_OFFSET_PX,
      y: xy[1] - STAR_LABEL_OFFSET_PX,
      width: 0,
      height: 0,
      priority: 1 + appMag * 0.001, // brightness tie-break inside the kind
      key: `n:${idx}`,
    });
    seen.add(idx);
  }

  // 2) Bayer-letter stars — render the Greek glyph + optional unicode
  // superscript. Iterating the bayerMap covers every Bayer'd star;
  // candidates that also have proper names are dropped (proper name
  // wins). The constellation-relative form is just the glyph — chart
  // mode renders the Latin name separately at the constellation's
  // brightness-weighted centroid.
  for (const [idx, info] of ctx.bayerMap) {
    if (seen.has(idx)) continue;
    const xy = projectStar(idx, positions, camera, w, h);
    if (!xy) continue;
    const appMag = computeAppMag(idx, positions, cat.absmag);
    if (appMag > f.maxAppMag) continue;
    candidates.push({
      kind: 'bayer',
      text: `${info.greek}${info.suffix}`,
      x: xy[0] + STAR_LABEL_OFFSET_PX,
      y: xy[1] - STAR_LABEL_OFFSET_PX,
      width: 0,
      height: 0,
      // Ranks after named stars; brightness tie-break inside the kind.
      priority: 2 + appMag * 0.005,
      key: `b:${idx}`,
    });
  }

  // 3) Constellation Latin names — at the brightness-weighted centroid
  // of the member stars. Iterate every member to find the *apparent*
  // brightest from the current camera position; the precomputed
  // brightestIdx-by-absmag is the most luminous intrinsically (e.g.
  // γ Vel for Vela), but at typical vantages a closer star with weaker
  // absolute luminosity may appear brighter, and using the absolute-
  // mag champion can leave the constellation labelled-or-not arbitrarily
  // as the maxAppMag slider crosses one threshold instead of the other.
  // Per-frame iteration over a few thousand member stars is cheap.
  const constellations = cat.constellations;
  for (const [conIdx, m] of conStars) {
    const con = constellations[conIdx];
    if (!con) continue;

    // Find the brightest apparent magnitude among constellation members.
    // While iterating, also accumulate the brightness-weighted centroid
    // (weight in flux space so Sirius dominates over a faint dim star).
    let minAppMag = Infinity;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let wsum = 0;
    for (const i of m.stars) {
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      const dCam = Math.sqrt(px * px + py * py + pz * pz);
      const appMag = dCam > 0
        ? cat.absmag[i] + 5 * (Math.log10(dCam) - 1)
        : cat.absmag[i];
      if (appMag < minAppMag) minAppMag = appMag;
      // Flux weight = 10^(-0.4 * appMag) — brighter (lower) appMag gives
      // exponentially more pull, matching how the eye reads a chart.
      const wi = Math.pow(10, -0.4 * appMag);
      sx += px * wi;
      sy += py * wi;
      sz += pz * wi;
      wsum += wi;
    }
    if (wsum === 0 || minAppMag > f.maxAppMag) continue;
    m.centroid.set(sx / wsum, sy / wsum, sz / wsum);
    const xy = projectVec(m.centroid, camera, w, h);
    if (!xy) continue;
    candidates.push({
      kind: 'con',
      text: con.name.toUpperCase(),
      x: xy[0],
      y: xy[1],
      width: 0,
      height: 0,
      // Constellation Latin names skip the collision pass entirely; the
      // priority value is purely a sort key for the order they get laid
      // down in (matters only if two collide, but the outline-style
      // typography accepts overlap). Brightest constellation first.
      priority: 0 + minAppMag * 0.01,
      key: `c:${conIdx}`,
    });
  }

  // 4) Molecular clouds — name labels at the cloud centroid. Cheap to
  // iterate (count is in the hundreds at most).
  const clouds = starfield.getCloudCatalog();
  if (clouds && f.showMolecularClouds) {
    for (let i = 0; i < clouds.clouds.length; i++) {
      const local = starfield.cloudLocalPosition(i);
      if (!local) continue;
      const xy = projectVec(local, camera, w, h);
      if (!xy) continue;
      candidates.push({
        kind: 'cloud',
        text: clouds.clouds[i].name,
        x: xy[0] + STAR_LABEL_OFFSET_PX,
        y: xy[1] + STAR_LABEL_OFFSET_PX,
        width: 0,
        height: 0,
        priority: 3 + i * 0.0001,
        key: `m:${i}`,
      });
    }
  }

  // Sort by priority — proper names first, then Bayer, then clouds.
  // Constellation Latin labels skip the collision pass entirely
  // (rendered as outline-style overlay typography à la Sky Atlas
  // 2000.0; see styles.css `.chart-label.kind-con`). They're laid out
  // separately below and are never excluded by competing labels.
  candidates.sort((a, b) => a.priority - b.priority);

  // Greedy collision pass against star/Bayer/cloud labels only. Walks
  // the priority-ordered list, accepting any candidate whose AABB
  // doesn't overlap a previously-accepted one. No upper budget — chart
  // shows everything at the current magnitude limit subject to
  // collision, which is the intent of the feature. Pool existing
  // <text> elements per key.
  const accepted: Candidate[] = [];
  for (const cand of candidates) {
    if (cand.kind === 'con') {
      // Constellations bypass collision; they always render.
      accepted.push(cand);
      continue;
    }
    measureCandidate(cand);
    if (collides(cand, accepted)) continue;
    accepted.push(cand);
  }

  // Render: ensure each accepted candidate has a pooled <text>; drop any
  // pooled elements not in the accepted set this frame.
  const used = new Set<string>();
  for (const cand of accepted) {
    used.add(cand.key);
    let p = pool.get(cand.key);
    if (!p) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      el.setAttribute('class', `chart-label kind-${cand.kind}`);
      el.setAttribute('text-anchor', cand.kind === 'con' ? 'middle' : 'start');
      el.setAttribute('dominant-baseline', 'central');
      labelLayer.appendChild(el);
      p = { el, width: 0, height: 0 };
      pool.set(cand.key, p);
    }
    if (p.el.textContent !== cand.text) p.el.textContent = cand.text;
    p.el.setAttribute('x', cand.x.toFixed(1));
    p.el.setAttribute('y', cand.y.toFixed(1));
  }
  for (const [key, p] of pool) {
    if (!used.has(key)) {
      labelLayer.removeChild(p.el);
      pool.delete(key);
    }
  }

  // ---- Glyphs (variable rings + binary wings) ----
  // Both layers paint screen-space SVG primitives sized in the same
  // space the GPU disc renders. We mirror the chart-mode magnitude →
  // pixel formula (vertex shader's chart branch) here so the visual
  // matches the rendered disc exactly.
  const discParams = starfield.getChartDiscParams();
  const usedRings = new Set<number>();
  const usedWings = new Set<number>();
  const discPxFor = (appMag: number): number => {
    const t = Math.max(0, Math.min(1,
      (appMag - discParams.magBright) /
        Math.max(f.maxAppMag - discParams.magBright, 0.001)));
    return discParams.maxPx + (discParams.minPx - discParams.maxPx) * t;
  };

  // Helper: replicate the GPU's "is this star renderable" gate as
  // closely as we can on the CPU. Spectral mask + per-star distance
  // filter are exact mirrors of the shader; dust extinction is the
  // one filter we don't replicate (the per-star raymarch is too
  // expensive on CPU) so a star deep behind dust may still get a ring
  // even though its inner disc is dust-attenuated past the limit.
  // Returns the computed appMag, or null if any CPU-side filter
  // rejects the star.
  const renderableAppMag = (idx: number): number | null => {
    const dSol = distSolCache ? distSolCache[idx] : 0;
    if (dSol < f.minDistSol || dSol > f.maxDistSol) return null;
    const spect = cat.spectClass[idx];
    if ((f.spectMask & (1 << spect)) === 0) return null;
    // Camera-relative distance — local-frame positions cover the
    // floating-origin recentering automatically.
    const x = positions[idx * 3];
    const y = positions[idx * 3 + 1];
    const z = positions[idx * 3 + 2];
    const dCam = Math.sqrt(x * x + y * y + z * z);
    if (dCam <= 0) return cat.absmag[idx];
    return cat.absmag[idx] + 5 * (Math.log10(dCam) - 1);
  };

  // Variable stars — outer ring at the max-brightness extreme of the
  // variability sine. Inner disc keeps pulsing on the GPU side, so the
  // visible glyph reads as Sky Atlas's ring-with-breathing-dot pair.
  // Only emitted when the star passes the same filters the GPU applies
  // — spectral mask, distance, and the magnitude limit at the *bright
  // extreme* (mag - amp/2). At the faint extreme the inner disc may
  // dim past the limit and disappear; the ring still indicates that
  // a variable lives here.
  if (variableIdxs) {
    for (const idx of variableIdxs) {
      const appMag = renderableAppMag(idx);
      if (appMag === null) continue;
      const amp = cat.amplitudeMag[idx];
      const ringMag = appMag - amp * 0.5;
      if (ringMag > f.maxAppMag) continue;
      const xy = projectStar(idx, positions, camera, w, h);
      if (!xy) continue;
      // Ring sits one VARIABLE_RING_MIN_GAP_PX outside the peak disc
      // radius, guaranteeing a visible gap even for low-amplitude
      // variables where the disc would otherwise grow flush with the
      // ring. Adds 2× to the diameter (one gap on each side).
      const peakDiscPx = discPxFor(ringMag);
      const ringPx = peakDiscPx + 2 * VARIABLE_RING_MIN_GAP_PX;
      let circle = ringPool.get(idx);
      if (!circle) {
        circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('class', 'chart-variable-ring');
        glyphs.appendChild(circle);
        ringPool.set(idx, circle);
      }
      circle.setAttribute('cx', xy[0].toFixed(1));
      circle.setAttribute('cy', xy[1].toFixed(1));
      circle.setAttribute('r', (ringPx * 0.5).toFixed(2));
      usedRings.add(idx);
    }
  }
  for (const [idx, el] of ringPool) {
    if (!usedRings.has(idx)) {
      glyphs.removeChild(el);
      ringPool.delete(idx);
    }
  }

  // Binary primaries — horizontal wings extending past the disc on
  // each side. Always horizontal in screen space (SVG line uses
  // viewport coords) so camera roll doesn't tilt them. Same per-star
  // filter gate as variable rings so the wings track inner-disc
  // visibility instead of floating standalone.
  if (binaryIdxs) {
    for (const idx of binaryIdxs) {
      const appMag = renderableAppMag(idx);
      if (appMag === null) continue;
      if (appMag > f.maxAppMag) continue;
      const xy = projectStar(idx, positions, camera, w, h);
      if (!xy) continue;
      const discPx = discPxFor(appMag);
      const ext = discPx * BINARY_WING_EXTENSION_RATIO;
      if (ext < BINARY_WING_MIN_EXTENSION_PX) continue;
      const half = discPx * 0.5 + ext;
      let line = wingPool.get(idx);
      if (!line) {
        line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'chart-binary-wings');
        glyphs.appendChild(line);
        wingPool.set(idx, line);
      }
      line.setAttribute('x1', (xy[0] - half).toFixed(1));
      line.setAttribute('x2', (xy[0] + half).toFixed(1));
      line.setAttribute('y1', xy[1].toFixed(1));
      line.setAttribute('y2', xy[1].toFixed(1));
      usedWings.add(idx);
    }
  }
  for (const [idx, el] of wingPool) {
    if (!usedWings.has(idx)) {
      glyphs.removeChild(el);
      wingPool.delete(idx);
    }
  }
}

function projectStar(
  idx: number,
  positions: Float32Array,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): [number, number] | null {
  tmpV3.set(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
  return projectVec(tmpV3, camera, w, h);
}

function projectVec(
  p: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): [number, number] | null {
  // Reuse the same matrix transform pattern as constellation-overlay /
  // hud-overlay (near-clip safe). Important: clone before transforming
  // so the caller's vector isn't clobbered.
  const v = p.clone().applyMatrix4(camera.matrixWorldInverse);
  if (v.z >= -camera.near) return null;
  v.applyMatrix4(camera.projectionMatrix);
  const x = (v.x + 1) * 0.5 * w;
  const y = (1 - v.y) * 0.5 * h;
  // Drop labels well outside the viewport — saves measurement cost.
  if (x < -200 || x > w + 200 || y < -100 || y > h + 100) return null;
  return [x, y];
}

// Apparent magnitude from absolute magnitude + distance-modulus (no dust;
// extinction would matter at the boundary but the goal here is to track
// the slider, not to simulate). Position is in local frame (renderer
// coords); since the camera also operates in local frame the resulting
// distance is what the viewer sees.
function computeAppMag(
  idx: number,
  positions: Float32Array,
  absmag: Float32Array,
): number {
  const x = positions[idx * 3];
  const y = positions[idx * 3 + 1];
  const z = positions[idx * 3 + 2];
  const d = Math.sqrt(x * x + y * y + z * z);
  if (d <= 0) return absmag[idx]; // Sol-on-Sol or origin: distance modulus → 0
  return absmag[idx] + 5 * (Math.log10(d) - 1);
}

// Approximate label box on the first frame the candidate survives. SVG's
// getBBox forces a layout flush, so we estimate via character count first
// (cheap) and only fall back to the real measurement if needed for
// collision tightness — not yet, but flagging the spot.
function measureCandidate(c: Candidate): void {
  // Approximation: 6.5 px per char @ 11 px font with letter-spacing 0.05em.
  // Good enough for collision; the constellation labels use a heavier
  // weight, so widen them slightly.
  const charPx = c.kind === 'con' ? 7.5 : 6.5;
  c.width = c.text.length * charPx + COLLISION_PAD_PX * 2;
  c.height = 14;
}

function collides(c: Candidate, others: Candidate[]): boolean {
  // Convert (x, y) anchor into a centred AABB. text-anchor is 'middle'
  // for con labels (centre-anchored), 'start' for the rest (left-anchored).
  const left = c.kind === 'con' ? c.x - c.width / 2 : c.x;
  const right = left + c.width;
  const top = c.y - c.height / 2;
  const bottom = c.y + c.height / 2;
  for (const o of others) {
    const oLeft = o.kind === 'con' ? o.x - o.width / 2 : o.x;
    const oRight = oLeft + o.width;
    const oTop = o.y - o.height / 2;
    const oBottom = o.y + o.height / 2;
    if (
      left < oRight &&
      right > oLeft &&
      top < oBottom &&
      bottom > oTop
    ) {
      return true;
    }
  }
  return false;
}
