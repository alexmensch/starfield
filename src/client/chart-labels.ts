import * as THREE from 'three';
import type { Stellata } from './stellata';
import type { ChartModeContext } from './chart-mode';
import { mark as perfMark, measure as perfMeasure } from './perf-hud';

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

export interface Candidate {
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
  // Dirty-tracked attribute writes — every visible label updates x/y per
  // frame, but on a stationary camera those values are identical to the
  // previous frame. Skipping the setAttribute avoids SVG attribute
  // parsing + style invalidation (visible in chart.dom under the perf HUD).
  // Sentinel -Infinity guarantees the first write always happens.
  lastX: number;
  lastY: number;
}

interface PooledCircle {
  el: SVGCircleElement;
  lastCx: number;
  lastCy: number;
  lastR: number;
}

interface PooledLine {
  el: SVGLineElement;
  lastX1: number;
  lastX2: number;
  lastY: number; // y1 and y2 are equal — wings are horizontal
}

// Single per-page state — chart mode is a single-instance feature.
// `active` is the runtime gate read by the per-frame tick; the onFrame
// handler is registered exactly once (the first time chart engages) and
// short-circuits whenever active is false. Toggling chart on/off therefore
// doesn't churn handlers on the stellata's onFrame list.
let active = false;
let registered = false;
let layer: SVGGElement | null = null;
let glyphLayer: SVGGElement | null = null;
let conStars: Map<number, ConMembership> | null = null;
let variableIdxs: number[] | null = null;
let binaryIdxs: number[] | null = null;
// Filter-derived subsets of the static lists above. Eligibility encodes
// the *static* parts of renderableAppMag: spectral-mask and Sol-distance
// bounds. Rebuilt on filter change so the per-frame variable/binary
// loops only walk stars that already passed those gates — typically 50–
// 90% smaller than the full lists under non-default filters.
let variableEligible: number[] | null = null;
let binaryEligible: number[] | null = null;
let eligibleDirty = true;
// distSol[i] = distance from Sol to star i, in parsecs. Catalog positions
// are absolute (Sol-centred ICRS), so |position| is the absolute distance.
// Precomputed once at chart entry; the GPU mirrors this via iDistSol.
let distSolCache: Float32Array | null = null;
let activeCtx: ChartModeContext | null = null;
const pool = new Map<string, PooledText>();
const ringPool = new Map<number, PooledCircle>();
const wingPool = new Map<number, PooledLine>();
// 0.05px threshold — half the display precision of .toFixed(1). Below
// this, the attribute string would round to the same value, so the
// browser would treat the write as a no-op anyway (after re-parsing).
const ATTR_DIRTY_PX = 0.05;
const tmpV3 = new THREE.Vector3();
// Dedicated scratch for projectVec — never aliased with tmpV3 (which is
// owned by projectStar's caller path) so the two can be in flight together.
const projVec = new THREE.Vector3();

export function startChartLabels(
  stellata: Stellata,
  ctx: ChartModeContext,
): void {
  if (active) return;
  active = true;
  activeCtx = ctx;
  layer = ensureLayer('chart-labels');
  glyphLayer = ensureLayer('chart-glyphs');
  layer.style.display = '';
  glyphLayer.style.display = '';

  if (!conStars) conStars = buildConstellationMembership(stellata);
  if (!variableIdxs || !binaryIdxs || !distSolCache) {
    const cat = stellata.catalog;
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
    stellata.onFrame(() => {
      if (!active || !layer || !glyphLayer || !conStars || !activeCtx) return;
      tick(stellata, activeCtx, conStars);
    });
    // Filter changes invalidate both the centroid cache and the static
    // variable/binary eligibility lists. spectMask/distance/maxAppMag
    // don't all feed the centroid math, but bumping on any change is
    // cheap and avoids stale-cache bugs.
    stellata.onFilterChange(() => {
      centroidsVersion++;
      eligibleDirty = true;
    });
  }
  // Force a recompute on each chart-mode entry so the cache doesn't
  // serve a stale centroid from a prior session at a different vantage,
  // and so the full-tick skip definitely runs the first frame after
  // re-entry (stopChartLabels() empties the SVG pools).
  lastCentroidCamPos.set(NaN, NaN, NaN);
  lastTickCamPos.set(NaN, NaN, NaN);
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
  // Brightness-weighted centroid in local frame. Cached across frames
  // when the camera hasn't moved meaningfully (see CENTROID_RECOMPUTE_DIST_SQ).
  centroid: THREE.Vector3;
  // Brightest apparent magnitude among members at the time the centroid
  // was last computed. Cached alongside the centroid; valid iff
  // `centroidsValid` is true for the membership map as a whole.
  minAppMag: number;
}

// Cache state for the constellation centroid block. The flux-weighted
// centroid pulls toward whichever member is currently apparent-brightest,
// so it depends weakly on camera position — recomputing every frame is
// wasteful when the camera is steady. We invalidate on:
//   - camera moved more than CENTROID_RECOMPUTE_DIST (~0.5 pc), OR
//   - filter changed (spectMask doesn't actually feed the centroid pass,
//     but a single bump on any filter change is conservative and cheap)
const lastCentroidCamPos = new THREE.Vector3(NaN, NaN, NaN);
let centroidsVersion = 0;
let lastCentroidsVersion = -1;
const CENTROID_RECOMPUTE_DIST_SQ = 0.25; // 0.5 pc squared

// Full-tick skip state. The chart-mode visual is purely a function of
// camera transform + filter version + viewport size — variable-star
// pulsation animates on the GPU side via uTime, the CPU labels and ring
// glyphs don't move when those inputs are stable. Identity-comparing the
// state at the top of tick() lets us drop ~1.6ms / frame of iteration
// work when the user is sitting idle in chart mode.
const lastTickCamPos = new THREE.Vector3(NaN, NaN, NaN);
// Quaternion sentinel: x=NaN forces a mismatch on the first equals() call
// after entering chart mode, since NaN === anything is always false.
const lastTickCamQuat = new THREE.Quaternion(NaN, 0, 0, 0);
let lastTickFilterVersion = -1;
let lastTickViewportW = 0;
let lastTickViewportH = 0;

function rebuildEligible(stellata: Stellata): void {
  if (!variableIdxs || !binaryIdxs || !distSolCache) return;
  const f = stellata.getFilter();
  const cat = stellata.catalog;
  variableEligible = filterByDistAndSpect(
    variableIdxs, distSolCache, cat.spectClass, f.minDistSol, f.maxDistSol, f.spectMask,
  );
  binaryEligible = filterByDistAndSpect(
    binaryIdxs, distSolCache, cat.spectClass, f.minDistSol, f.maxDistSol, f.spectMask,
  );
  eligibleDirty = false;
}

// Pure: keeps only the indices whose Sol-distance is within [minDist,
// maxDist] AND whose spectral class bit is set in `spectMask`. Used by
// `rebuildEligible` to derive variable/binary subsets at filter-change
// time so the per-frame glyph loops walk the smallest possible list.
export function filterByDistAndSpect(
  idxs: ArrayLike<number>,
  distSol: ArrayLike<number>,
  spectClass: ArrayLike<number>,
  minDist: number,
  maxDist: number,
  spectMask: number,
): number[] {
  const out: number[] = [];
  for (let k = 0; k < idxs.length; k++) {
    const idx = idxs[k];
    const d = distSol[idx];
    if (d < minDist || d > maxDist) continue;
    if ((spectMask & (1 << spectClass[idx])) === 0) continue;
    out.push(idx);
  }
  return out;
}

function buildConstellationMembership(stellata: Stellata): Map<number, ConMembership> {
  const cat = stellata.catalog;
  const out = new Map<number, ConMembership>();
  for (let i = 0; i < cat.count; i++) {
    const conIdx = cat.constellation[i];
    if (conIdx === 255) continue;
    const m = out.get(conIdx);
    if (!m) {
      out.set(conIdx, { stars: [i], centroid: new THREE.Vector3(), minAppMag: Infinity });
    } else {
      m.stars.push(i);
    }
  }
  return out;
}

function tick(
  stellata: Stellata,
  ctx: ChartModeContext,
  conStars: Map<number, ConMembership>,
): void {
  if (!layer || !glyphLayer) return;
  const labelLayer = layer;
  const glyphs = glyphLayer;
  const f = stellata.getFilter();
  const camera = stellata.camera;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const positions = stellata.localPositions;
  const cat = stellata.catalog;

  // Full-tick skip. Chart-mode SVG output is fully determined by camera
  // transform + filter version + viewport — none of which are changing
  // when the user is sitting still. Iterating ~1500 binaries / ~1000
  // variables and ~hundreds of named stars to discover that nothing
  // moved is the dominant idle cost; skipping the entire body collapses
  // chart.* sections to zero on stationary frames.
  if (
    camera.position.equals(lastTickCamPos) &&
    camera.quaternion.equals(lastTickCamQuat) &&
    centroidsVersion === lastTickFilterVersion &&
    w === lastTickViewportW &&
    h === lastTickViewportH
  ) {
    return;
  }
  lastTickCamPos.copy(camera.position);
  lastTickCamQuat.copy(camera.quaternion);
  lastTickFilterVersion = centroidsVersion;
  lastTickViewportW = w;
  lastTickViewportH = h;

  const candidates: Candidate[] = [];
  const seen = new Set<number>(); // dedupe star idx across name+bayer

  // 1) Proper-named stars. Iterate the names map directly; size of the
  // map is small (~hundreds) so this is cheap. Priority sits below the
  // constellation Latin labels (priority 0) so the constellation name
  // always wins a collision.
  perfMark('chart.names');
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
  perfMeasure('chart.names');

  // 2) Bayer-letter stars — render the Greek glyph + optional unicode
  // superscript. Iterating the bayerMap covers every Bayer'd star;
  // candidates that also have proper names are dropped (proper name
  // wins). The constellation-relative form is just the glyph — chart
  // mode renders the Latin name separately at the constellation's
  // brightness-weighted centroid.
  perfMark('chart.bayer');
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
  perfMeasure('chart.bayer');

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
  // The Latin-name labels follow the constellation lines — when the
  // master toggle is off, both disappear together.
  perfMark('chart.constellations');
  // Decide whether to recompute centroids this frame. The flux-weighted
  // barycentre depends weakly on camera position, so a small camera nudge
  // doesn't meaningfully shift it. With ~88 constellations × ~30 members
  // each = ~2,600 inner iterations doing transcendentals, skipping the
  // recompute on stationary frames is the largest single chart-mode CPU
  // win.
  const camDx = camera.position.x - lastCentroidCamPos.x;
  const camDy = camera.position.y - lastCentroidCamPos.y;
  const camDz = camera.position.z - lastCentroidCamPos.z;
  const camMovedSq = camDx * camDx + camDy * camDy + camDz * camDz;
  // NaN propagates through the comparison so the initial sentinel value
  // forces a recompute on first use after chart-mode entry.
  const recompute =
    !(camMovedSq < CENTROID_RECOMPUTE_DIST_SQ) ||
    centroidsVersion !== lastCentroidsVersion;
  if (recompute) {
    lastCentroidCamPos.copy(camera.position);
    lastCentroidsVersion = centroidsVersion;
  }
  if (f.showConstellation) for (const [conIdx, m] of conStars) {
    const con = constellations[conIdx];
    if (!con) continue;

    if (recompute) {
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
      m.minAppMag = minAppMag;
      if (wsum > 0) m.centroid.set(sx / wsum, sy / wsum, sz / wsum);
    }
    if (m.minAppMag > f.maxAppMag) continue;
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
      priority: 0 + m.minAppMag * 0.01,
      key: `c:${conIdx}`,
    });
  }
  perfMeasure('chart.constellations');

  // 4) Molecular clouds — name labels at the cloud centroid. Cheap to
  // iterate (count is in the hundreds at most).
  perfMark('chart.clouds');
  const clouds = stellata.getCloudCatalog();
  if (clouds && f.showMolecularClouds) {
    for (let i = 0; i < clouds.clouds.length; i++) {
      const local = stellata.cloudLocalPosition(i);
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
  perfMeasure('chart.clouds');

  // Sort by priority — proper names first, then Bayer, then clouds.
  // Constellation Latin labels skip the collision pass entirely
  // (rendered as outline-style overlay typography à la Sky Atlas
  // 2000.0; see styles.css `.chart-label.kind-con`). They're laid out
  // separately below and are never excluded by competing labels.
  perfMark('chart.collision');
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
  perfMeasure('chart.collision');

  // Render: ensure each accepted candidate has a pooled <text>; drop any
  // pooled elements not in the accepted set this frame.
  perfMark('chart.dom');
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
      p = { el, width: 0, height: 0, lastX: -Infinity, lastY: -Infinity };
      pool.set(cand.key, p);
    }
    if (p.el.textContent !== cand.text) p.el.textContent = cand.text;
    if (Math.abs(cand.x - p.lastX) >= ATTR_DIRTY_PX) {
      p.el.setAttribute('x', cand.x.toFixed(1));
      p.lastX = cand.x;
    }
    if (Math.abs(cand.y - p.lastY) >= ATTR_DIRTY_PX) {
      p.el.setAttribute('y', cand.y.toFixed(1));
      p.lastY = cand.y;
    }
  }
  for (const [key, p] of pool) {
    if (!used.has(key)) {
      labelLayer.removeChild(p.el);
      pool.delete(key);
    }
  }
  perfMeasure('chart.dom');

  // ---- Glyphs (variable rings + binary wings) ----
  // Both layers paint screen-space SVG primitives sized in the same
  // space the GPU disc renders. We mirror the chart-mode magnitude →
  // pixel formula (vertex shader's chart branch) here so the visual
  // matches the rendered disc exactly.
  const discParams = stellata.getChartDiscParams();
  const usedRings = new Set<number>();
  const usedWings = new Set<number>();
  const discPxFor = (appMag: number): number => {
    const t = Math.max(0, Math.min(1,
      (appMag - discParams.magBright) /
        Math.max(f.maxAppMag - discParams.magBright, 0.001)));
    return discParams.maxPx + (discParams.minPx - discParams.maxPx) * t;
  };

  // Spectral mask + Sol-distance bounds are encoded in variableEligible
  // and binaryEligible (rebuilt on filter change), so the per-frame loops
  // below only need to compute the camera-relative apparent magnitude
  // and apply the maxAppMag gate. Dust extinction is the one shader
  // filter we don't replicate (per-star raymarch is too expensive on
  // CPU) — see BINARY_WING_MIN_EXTENSION_PX for the visual margin that
  // covers the resulting CPU/GPU disc-size mismatch.
  if (eligibleDirty) rebuildEligible(stellata);
  const absmag = cat.absmag;

  // Variable stars — outer ring at the max-brightness extreme of the
  // variability sine. Inner disc keeps pulsing on the GPU side, so the
  // visible glyph reads as Sky Atlas's ring-with-breathing-dot pair.
  // Only emitted when the star passes the same filters the GPU applies
  // — spectral mask, distance, and the magnitude limit at the *bright
  // extreme* (mag - amp/2). At the faint extreme the inner disc may
  // dim past the limit and disappear; the ring still indicates that
  // a variable lives here.
  perfMark('chart.glyphs.var');
  if (variableEligible) {
    for (const idx of variableEligible) {
      // Inlined appMag: spectral / distance-from-Sol gates already done
      // by eligibility filtering, so just camera-relative magnitude.
      const px = positions[idx * 3];
      const py = positions[idx * 3 + 1];
      const pz = positions[idx * 3 + 2];
      const dCam = Math.sqrt(px * px + py * py + pz * pz);
      const appMag = dCam > 0
        ? absmag[idx] + 5 * (Math.log10(dCam) - 1)
        : absmag[idx];
      const amp = cat.amplitudeMag[idx];
      const ringMag = appMag - amp * 0.5;
      // Magnitude gate hoisted above the projection — projectStar's
      // matrix-multiply is the expensive part, so pre-rejecting saves
      // it for stars over the brightness limit.
      if (ringMag > f.maxAppMag) continue;
      const xy = projectStar(idx, positions, camera, w, h);
      if (!xy) continue;
      // Ring sits one VARIABLE_RING_MIN_GAP_PX outside the peak disc
      // radius, guaranteeing a visible gap even for low-amplitude
      // variables where the disc would otherwise grow flush with the
      // ring. Adds 2× to the diameter (one gap on each side).
      const peakDiscPx = discPxFor(ringMag);
      const ringPx = peakDiscPx + 2 * VARIABLE_RING_MIN_GAP_PX;
      const ringR = ringPx * 0.5;
      let p = ringPool.get(idx);
      if (!p) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        el.setAttribute('class', 'chart-variable-ring');
        glyphs.appendChild(el);
        p = { el, lastCx: -Infinity, lastCy: -Infinity, lastR: -Infinity };
        ringPool.set(idx, p);
      }
      if (Math.abs(xy[0] - p.lastCx) >= ATTR_DIRTY_PX) {
        p.el.setAttribute('cx', xy[0].toFixed(1));
        p.lastCx = xy[0];
      }
      if (Math.abs(xy[1] - p.lastCy) >= ATTR_DIRTY_PX) {
        p.el.setAttribute('cy', xy[1].toFixed(1));
        p.lastCy = xy[1];
      }
      // r uses .toFixed(2), so half-precision is 0.005 — but the ring
      // radius is dominated by the disc-pulse magnitude formula and
      // changes whenever the camera moves. The tighter threshold here
      // catches the genuinely-static-frame case.
      if (Math.abs(ringR - p.lastR) >= 0.005) {
        p.el.setAttribute('r', ringR.toFixed(2));
        p.lastR = ringR;
      }
      usedRings.add(idx);
    }
  }
  for (const [idx, p] of ringPool) {
    if (!usedRings.has(idx)) {
      glyphs.removeChild(p.el);
      ringPool.delete(idx);
    }
  }
  perfMeasure('chart.glyphs.var');

  // Binary primaries — horizontal wings extending past the disc on
  // each side. Always horizontal in screen space (SVG line uses
  // viewport coords) so camera roll doesn't tilt them. Same per-star
  // filter gate as variable rings so the wings track inner-disc
  // visibility instead of floating standalone.
  perfMark('chart.glyphs.bin');
  if (binaryEligible) {
    for (const idx of binaryEligible) {
      const px = positions[idx * 3];
      const py = positions[idx * 3 + 1];
      const pz = positions[idx * 3 + 2];
      const dCam = Math.sqrt(px * px + py * py + pz * pz);
      const appMag = dCam > 0
        ? absmag[idx] + 5 * (Math.log10(dCam) - 1)
        : absmag[idx];
      // Magnitude gate before the projection — same reasoning as above.
      if (appMag > f.maxAppMag) continue;
      const discPx = discPxFor(appMag);
      const ext = discPx * BINARY_WING_EXTENSION_RATIO;
      if (ext < BINARY_WING_MIN_EXTENSION_PX) continue;
      const xy = projectStar(idx, positions, camera, w, h);
      if (!xy) continue;
      const half = discPx * 0.5 + ext;
      const x1 = xy[0] - half;
      const x2 = xy[0] + half;
      const y = xy[1];
      let p = wingPool.get(idx);
      if (!p) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        el.setAttribute('class', 'chart-binary-wings');
        glyphs.appendChild(el);
        p = { el, lastX1: -Infinity, lastX2: -Infinity, lastY: -Infinity };
        wingPool.set(idx, p);
      }
      if (Math.abs(x1 - p.lastX1) >= ATTR_DIRTY_PX) {
        p.el.setAttribute('x1', x1.toFixed(1));
        p.lastX1 = x1;
      }
      if (Math.abs(x2 - p.lastX2) >= ATTR_DIRTY_PX) {
        p.el.setAttribute('x2', x2.toFixed(1));
        p.lastX2 = x2;
      }
      if (Math.abs(y - p.lastY) >= ATTR_DIRTY_PX) {
        p.el.setAttribute('y1', y.toFixed(1));
        p.el.setAttribute('y2', y.toFixed(1));
        p.lastY = y;
      }
      usedWings.add(idx);
    }
  }
  for (const [idx, p] of wingPool) {
    if (!usedWings.has(idx)) {
      glyphs.removeChild(p.el);
      wingPool.delete(idx);
    }
  }
  perfMeasure('chart.glyphs.bin');
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

export function projectVec(
  p: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): [number, number] | null {
  // Near-clip-safe matrix transform; same shape as constellation-overlay /
  // hud-overlay. Uses a module-level scratch to avoid the per-call
  // Vector3 allocation — the chart-mode tick projects 5–15k vectors per
  // frame and the GC pressure from clone() showed up directly in 1%-low
  // FPS during long observe sessions.
  projVec.copy(p).applyMatrix4(camera.matrixWorldInverse);
  if (projVec.z >= -camera.near) return null;
  projVec.applyMatrix4(camera.projectionMatrix);
  const x = (projVec.x + 1) * 0.5 * w;
  const y = (1 - projVec.y) * 0.5 * h;
  // Drop labels well outside the viewport — saves measurement cost.
  if (x < -200 || x > w + 200 || y < -100 || y > h + 100) return null;
  return [x, y];
}

// Apparent magnitude from absolute magnitude + distance-modulus (no dust;
// extinction would matter at the boundary but the goal here is to track
// the slider, not to simulate). Position is in local frame (renderer
// coords); since the camera also operates in local frame the resulting
// distance is what the viewer sees.
export function computeAppMag(
  idx: number,
  positions: ArrayLike<number>,
  absmag: ArrayLike<number>,
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
export function measureCandidate(c: Candidate): void {
  // Approximation: 6.5 px per char @ 11 px font with letter-spacing 0.05em.
  // Good enough for collision; the constellation labels use a heavier
  // weight, so widen them slightly.
  const charPx = c.kind === 'con' ? 7.5 : 6.5;
  c.width = c.text.length * charPx + COLLISION_PAD_PX * 2;
  c.height = 14;
}

export function collides(c: Candidate, others: Candidate[]): boolean {
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
