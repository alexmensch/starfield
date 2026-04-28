import type { Starfield } from './starfield';
import { sliderToDist, distToSlider, SLIDER_STEPS } from './controls';
import { applyTheme, getTheme } from './theme-toggle';
import { applyUnit } from './unit-toggle';
import { getUnit, onUnitChange } from './distance-util';

const DEBOUNCE_MS = 300;
const ALL_SPECT_MASK = 0b111111111;

// Defaults that are omitted from the URL when they match.
const DEFAULTS = {
  dmin: 0,
  dmax: SLIDER_STEPS,
  mag: 6.5,
  spect: ALL_SPECT_MASK,
  con: -1,
  smin: 2.0,
  smax: 24.0,
  span: 6.0,
  gov: 0,
  // Molecular cloud overlay defaults to ON, so the URL param appears only
  // when the user explicitly turns it off.
  mc: 1,
  // Milky Way analytic background also defaults to ON. Same omit-when-default
  // convention. Note the FPS probe may force this off post-load on slow
  // hardware; if so, the synthetic state-change fires through the writer
  // and `mw=0` lands in the URL.
  mw: 1,
  camX: 0,
  camY: 0,
  camZ: 30,
  tgtX: 0,
  tgtY: 0,
  tgtZ: 0,
  upX: 0,
  upY: 1,
  upZ: 0,
};

const EPS = 1e-3;

export function applyFromUrl(starfield: Starfield) {
  const params = new URLSearchParams(location.search);
  if (params.toString() === '') return;

  // Theme + unit first so any later DOM syncs render in the chosen theme.
  const t = params.get('t');
  if (t === 'mono' || t === 'dark') applyTheme(t);
  const u = params.get('u');
  if (u === 'ly' || u === 'pc') applyUnit(u);

  // Filter
  const patch: Record<string, number | boolean> = {};
  if (params.has('dmin') || params.has('dmax')) {
    const vMin = params.has('dmin') ? Number(params.get('dmin')) : DEFAULTS.dmin;
    const vMax = params.has('dmax') ? Number(params.get('dmax')) : DEFAULTS.dmax;
    patch.minDistSol = sliderToDist(vMin, true);
    patch.maxDistSol = sliderToDist(vMax, false);
  }
  if (params.has('mag')) patch.maxAppMag = Number(params.get('mag'));
  if (params.has('spect')) patch.spectMask = Number(params.get('spect'));
  if (params.has('con')) patch.highlightCon = Number(params.get('con'));
  if (params.has('smin')) patch.sizeMin = Number(params.get('smin'));
  if (params.has('smax')) patch.sizeMax = Number(params.get('smax'));
  if (params.has('span')) patch.sizeSpan = Number(params.get('span'));
  if (params.has('gov')) patch.showGalacticOverlays = params.get('gov') === '1';
  if (params.has('mc')) patch.showMolecularClouds = params.get('mc') === '1';
  if (params.has('mw')) patch.showMilkyway = params.get('mw') === '1';
  if (Object.keys(patch).length) starfield.setFilter(patch);

  // Detect camera params up-front so focus handling can decide whether to
  // teleport the camera (manually-typed URL) or just set the orbit target
  // (shared URL where the camera position is explicit).
  const hasCam = params.has('cx') || params.has('cy') || params.has('cz');
  const hasTgt = params.has('tx') || params.has('ty') || params.has('tz');
  const hasUp = params.has('ux') || params.has('uy') || params.has('uz');

  // Apply camera.up before focus handling — focusStar/setOrbitTarget call
  // controls.update() which reads camera.up to orient the view.
  if (hasUp) {
    starfield.camera.up.set(
      Number(params.get('ux') ?? DEFAULTS.upX),
      Number(params.get('uy') ?? DEFAULTS.upY),
      Number(params.get('uz') ?? DEFAULTS.upZ),
    ).normalize();
  }

  if (params.has('focus')) {
    const idx = Number(params.get('focus'));
    if (idx === -1) starfield.unfocus();
    else if (Number.isFinite(idx) && idx >= 0 && idx < starfield.catalog.count) {
      if (hasCam || hasTgt) starfield.setOrbitTarget(idx);
      else starfield.focusStar(idx);
    }
  }
  // Cloud focus mirrors the star-focus pattern: with explicit camera params
  // we just set the focus state and let the camera params win; without,
  // flyToCloud both sets focus and snaps the camera. Cloud and star focus
  // are mutually exclusive in Starfield, so the URL won't carry both —
  // applying after `focus` lets cloud override on the off chance both are
  // somehow present.
  if (params.has('cloud')) {
    const ci = Number(params.get('cloud'));
    if (Number.isFinite(ci) && ci >= 0) {
      if (hasCam || hasTgt) starfield.setFocusedCloud(ci);
      else starfield.flyToCloud(ci);
    }
  }
  if (params.has('toc')) {
    const ci = Number(params.get('toc'));
    if (Number.isFinite(ci) && ci >= 0) starfield.setVectorToCloud(ci);
  }
  if (params.has('to')) {
    const idx = Number(params.get('to'));
    if (Number.isFinite(idx) && idx >= 0 && idx < starfield.catalog.count) {
      starfield.setVectorTo(idx);
    }
  }
  // Camera overrides whatever focusStar/setOrbitTarget set above.
  if (hasCam) {
    starfield.camera.position.set(
      Number(params.get('cx') ?? DEFAULTS.camX),
      Number(params.get('cy') ?? DEFAULTS.camY),
      Number(params.get('cz') ?? DEFAULTS.camZ),
    );
  }
  if (hasTgt) {
    starfield.controls.target.set(
      Number(params.get('tx') ?? DEFAULTS.tgtX),
      Number(params.get('ty') ?? DEFAULTS.tgtY),
      Number(params.get('tz') ?? DEFAULTS.tgtZ),
    );
  }
  if (hasCam || hasTgt || hasUp) starfield.controls.update();
}

export function startUrlSync(starfield: Starfield) {
  let timer: number | undefined;
  let lastCamHash = '';

  const serialize = (): string => {
    const f = starfield.getFilter();
    const p = new URLSearchParams();

    const sMin = distToSlider(f.minDistSol, true);
    const sMax = distToSlider(f.maxDistSol, false);
    if (sMin !== DEFAULTS.dmin) p.set('dmin', String(sMin));
    if (sMax !== DEFAULTS.dmax) p.set('dmax', String(sMax));
    if (!approx(f.maxAppMag, DEFAULTS.mag)) p.set('mag', fmt(f.maxAppMag));
    if (f.spectMask !== DEFAULTS.spect) p.set('spect', String(f.spectMask));
    if (f.highlightCon !== DEFAULTS.con) p.set('con', String(f.highlightCon));
    if (!approx(f.sizeMin, DEFAULTS.smin)) p.set('smin', fmt(f.sizeMin));
    if (!approx(f.sizeMax, DEFAULTS.smax)) p.set('smax', fmt(f.sizeMax));
    if (!approx(f.sizeSpan, DEFAULTS.span)) p.set('span', fmt(f.sizeSpan));
    if (f.showGalacticOverlays) p.set('gov', '1');
    if (!f.showMolecularClouds) p.set('mc', '0');
    if (!f.showMilkyway) p.set('mw', '0');

    if (getUnit() !== 'pc') p.set('u', getUnit());
    if (getTheme() !== 'dark') p.set('t', getTheme());

    const focus = starfield.getFocusedStar();
    const focusCloud = starfield.getFocusedCloud();
    const sol = starfield.catalog.solIndex;
    if (focusCloud !== null) {
      p.set('cloud', String(focusCloud));
      // No `focus=` when a cloud is focused — they're mutually exclusive.
    } else if (focus === null) {
      p.set('focus', '-1');
    } else if (focus !== sol) {
      p.set('focus', String(focus));
    }

    const to = starfield.getVectorTo();
    const toCloud = starfield.getVectorToCloud();
    if (to !== null) p.set('to', String(to));
    else if (toCloud !== null) p.set('toc', String(toCloud));

    const c = starfield.camera.position;
    const tgt = starfield.controls.target;
    const camDefault =
      approx(c.x, DEFAULTS.camX) && approx(c.y, DEFAULTS.camY) && approx(c.z, DEFAULTS.camZ) &&
      approx(tgt.x, DEFAULTS.tgtX) && approx(tgt.y, DEFAULTS.tgtY) && approx(tgt.z, DEFAULTS.tgtZ);
    if (!camDefault) {
      p.set('cx', fmt(c.x));
      p.set('cy', fmt(c.y));
      p.set('cz', fmt(c.z));
      p.set('tx', fmt(tgt.x));
      p.set('ty', fmt(tgt.y));
      p.set('tz', fmt(tgt.z));
    }

    const up = starfield.camera.up;
    if (!approx(up.x, DEFAULTS.upX) || !approx(up.y, DEFAULTS.upY) || !approx(up.z, DEFAULTS.upZ)) {
      p.set('ux', fmt(up.x));
      p.set('uy', fmt(up.y));
      p.set('uz', fmt(up.z));
    }
    return p.toString();
  };

  const write = () => {
    const qs = serialize();
    const url = location.pathname + (qs ? '?' + qs : '');
    if (url !== location.pathname + location.search) {
      history.replaceState(null, '', url);
    }
  };

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(write, DEBOUNCE_MS);
  };

  starfield.onStateChange(schedule);
  onUnitChange(schedule);

  starfield.onFrame(() => {
    // Skip URL writes while a warp is in flight — the camera mutates every
    // frame and we don't want to serialise every intermediate pose. The
    // finishWarp() path fires a state change and a focus change that will
    // flush the final URL on arrival.
    if (starfield.getWarpActive()) return;
    const c = starfield.camera.position;
    const t = starfield.controls.target;
    const u = starfield.camera.up;
    const hash = `${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}|${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)}|${u.x.toFixed(3)},${u.y.toFixed(3)},${u.z.toFixed(3)}`;
    if (hash !== lastCamHash) {
      lastCamHash = hash;
      schedule();
    }
  });
}

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

function fmt(v: number): string {
  // Trim unneeded decimal zeros. Up to 3 decimals is plenty for sharing views.
  const rounded = Math.round(v * 1000) / 1000;
  return rounded.toString();
}
