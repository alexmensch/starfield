import * as THREE from 'three';
import { GALACTIC_CENTRE_PC } from '../galactic/galactic-coords';
import { fmtDist } from '../ui/distance-util';
import {
  buildArrowSvgPath,
  screenDirToTarget,
  ARROW_HEAD_DEPTH_PX,
  ARROW_LABEL_OFFSET_PX,
  ARROW_LABEL_PADDING_PX,
  ARROW_PIXEL_LENGTH,
  RING_HALO_GAP_PX,
} from './arrow-path';
import { projectToScreen } from './overlay-project';
import { applyFade, setNumAttr, setStyle, setText } from './dirty-attr';
import { FOCUS_RING_RADIUS_PX } from './focus-ring-overlay';
import { focusedArrowFadeAlpha } from './arrow-fade';
// (Removed MIN_SHAFT_PIXEL_LENGTH cutoff — used to be 8 px; we now render at
// any positive length so the drawn shaft is a continuous function of the
// arrow's projection geometry. This is what makes the navigate-mode disc-
// coverage fade work cleanly: the fade keys on the longest currently-drawn
// shaft, so the shaft shrinking smoothly toward 0 — instead of snapping to
// 0 at 8 px — keeps the alpha consistent with what's visible.)
// FOV anchor for the OBSERVE ring: at 10° vertical FOV the ring radius
// equals `RING_SIZE_FACTOR × f.sizeMax`. Above that the radius scales
// `1/fov` so the ring's angular size stays constant as FOV changes; the
// factor lifts the ring up to a comfortably-readable size at typical
// FOVs (raw `sizeMax` is single-digit pixels and reads as a dot).
const RING_FOV_ANCHOR_DEG = 10;
const RING_SIZE_FACTOR = 5;
// Per-arrow dirty-track state. The Sol/GC arrows recompute geometry every
// frame, but on a stationary camera the resulting attributes are
// identical to the previous frame; storing the last-written value lets
// updateOne skip the SVG attribute / textContent / inline-style writes
// (each of which forces re-parsing or style invalidation). NaN / '\0'
// sentinels guarantee the first write always lands through the gate —
// including for `lastPointerEvents` (steady-state '' would silently match
// a naive '' sentinel and skip the first restore-to-clickable write).
export interface ArrowState {
  lastD: string;
  lastLabelDisplay: string;
  lastLabelText: string;
  lastLabelX: number;
  lastLabelY: number;
  lastOpacity: number;
  lastPointerEvents: string;
}
export function emptyArrowState(): ArrowState {
  return {
    lastD: '\0',
    lastLabelDisplay: '\0',
    lastLabelText: '\0',
    lastLabelX: NaN,
    lastLabelY: NaN,
    // -Infinity (not NaN) because the inline opacity gate in applyFade
    // uses the early-write `>= threshold` form, which NaN poisons in the
    // wrong direction: `Math.abs(α − NaN) = NaN; NaN >= 0.0005 = false`
    // → first-frame write skipped, arrow never fades. -Infinity makes the
    // delta Infinity, which trips both gate directions. (Position sentinels
    // above stay NaN because they route through setNumAttr's early-return
    // `< threshold` form where NaN works correctly.)
    lastOpacity: -Infinity,
    lastPointerEvents: '\0',
  };
}

/**
 * Map current vertical FOV (degrees) and the user-tuned max star size to
 * the HUD ring's pixel radius. Used by the ring itself and by the Sol/GC
 * arrow shafts so the arrows attach to the ring rim and swivel around it
 * as the user looks around in OBSERVE mode.
 */
export function ringRadiusPx(fovDeg: number, sizeMaxPx: number): number {
  return RING_SIZE_FACTOR * sizeMaxPx * (RING_FOV_ANCHOR_DEG / Math.max(fovDeg, 0.0001));
}

export interface HudUpdateOpts {
  /** User-facing HUD toggle. When false the entire overlay hides. */
  enabled: boolean;
  /** Live perspective camera (matrices must be current). */
  camera: THREE.PerspectiveCamera;
  /** Orbit target in local frame — used as origin when unfocused. */
  target: THREE.Vector3;
  /** Floating-origin offset (catalog absolute → local). */
  worldOffset: THREE.Vector3;
  /** Focused star's local-frame position, or null when unfocused. */
  focusedLocal: THREE.Vector3 | null;
  /** True when the focused star is Sol — Sol arrow hidden in that case. */
  hideSolArrow: boolean;
  /** Current max-app-size from the Camera panel (≈ disc diameter). The
   *  arrow tip stays this far from the projected target so it doesn't
   *  crowd the star's disc. */
  sizeMaxPx: number;
  /** Steady-state camera mode. */
  cameraMode: 'navigate' | 'observe';
  /** Eased progress of the in-flight observe transition, or null. Driven
   *  by Stellata.getObserveTransitionProgress(). */
  transition: { f: number; kind: 'enter' | 'exit' } | null;
  /** Focused star's peak-amplitude rendered disc *radius* in CSS pixels,
   *  or 0 when no star is focused. The Sol/GC chevrons fade together once
   *  the disc grows past `max(solShaftLen, gcShaftLen)` — see
   *  arrow-fade.ts. Computing alpha from this-frame's shaft geometry +
   *  this-frame's disc size eliminates the one-frame lag that caused the
   *  ml8 toggle-on flash. */
  focusedDiscRadiusPx: number;
  /** Viewport size in CSS pixels. */
  w: number;
  h: number;
}

/**
 * The HUD: Sol/GC locator arrows + the OBSERVE-mode screen-centred ring.
 * One feature, one module. Future HUD widgets (e.g. compass tick marks,
 * roll indicator) hang off the same toggle and live here.
 *
 * The arrows project from the focused-star (or controls.target when
 * unfocused) and point toward Sol / the galactic centre. They share the
 * `#overlay` SVG with the distance vector so they inherit the
 * `body.warping` hide rule and the same stroke palette.
 *
 * Per-frame the ring + the arrow shaft start radius scale together with
 * mode + transition state so the navigate→observe (and reverse)
 * transition reads as a smooth morph: the focus ring shrinks while the
 * HUD ring grows, and the arrows track whichever circle is dominant.
 */
export class HudOverlay {
  private ring: SVGCircleElement;
  private solPath: SVGPathElement;
  private solBg: SVGPathElement;
  private gcPath: SVGPathElement;
  private gcBg: SVGPathElement;
  private solLabel: SVGTextElement;
  private gcLabel: SVGTextElement;

  // Most-recently rendered shaft length per arrow, in CSS pixels. 0 when the
  // arrow was hidden this frame. Read by Stellata's nav-arrow fade alpha
  // computation (with one frame of lag — alpha computed at the start of the
  // next frame uses these values) so the fade keys on the longest *actually
  // drawn* shaft rather than a re-derived geometric estimate.
  private solDrawnLen = 0;
  private gcDrawnLen = 0;

  // Per-arrow per-frame diagnostic record, populated by updateOne. Read by
  // the arrow-fade debug-panel section so we can see live why an arrow
  // ended up at the length it did — front-of-camera vs behind, which
  // direction path was used, whether shrink-to-target shortened it, and
  // the screen-direction magnitude that drove the path choice.
  private solDebug: ArrowDebugRecord = emptyArrowDebug();
  private gcDebug: ArrowDebugRecord = emptyArrowDebug();

  // Reusable scratch vectors so per-frame updates allocate nothing.
  private tmpDir = new THREE.Vector3();
  private tmpOrigin = new THREE.Vector3();
  private tmpSolLocal = new THREE.Vector3();
  private tmpGcLocal = new THREE.Vector3();

  // Dirty-track state for Sol/GC arrows + the OBSERVE ring. See
  // ArrowState comment above.
  private solArrowState: ArrowState = emptyArrowState();
  private gcArrowState: ArrowState = emptyArrowState();
  private lastRingDisplay = '\0';
  private lastRingCx = NaN;
  private lastRingCy = NaN;
  private lastRingR = NaN;

  // Click handlers — owned here so dispose() can remove them and let the SVG
  // labels release their references back to the Stellata closure.
  private onSolLabelClick: (() => void) | null = null;
  private onGcLabelClick: (() => void) | null = null;

  constructor(
    ring: SVGCircleElement,
    solPath: SVGPathElement,
    solBg: SVGPathElement,
    gcPath: SVGPathElement,
    gcBg: SVGPathElement,
    solLabel: SVGTextElement,
    gcLabel: SVGTextElement,
    onSolClick: () => void,
    onGcClick: () => void,
  ) {
    this.ring = ring;
    this.solPath = solPath;
    this.solBg = solBg;
    this.gcPath = gcPath;
    this.gcBg = gcBg;
    this.solLabel = solLabel;
    this.gcLabel = gcLabel;
    this.onSolLabelClick = onSolClick;
    this.onGcLabelClick = onGcClick;
    this.solLabel.addEventListener('click', this.onSolLabelClick);
    this.gcLabel.addEventListener('click', this.onGcLabelClick);
    this.hideAll();
  }

  dispose() {
    if (this.onSolLabelClick) {
      this.solLabel.removeEventListener('click', this.onSolLabelClick);
      this.onSolLabelClick = null;
    }
    if (this.onGcLabelClick) {
      this.gcLabel.removeEventListener('click', this.onGcLabelClick);
      this.onGcLabelClick = null;
    }
  }

  /** Per-frame update. */
  update(opts: HudUpdateOpts) {
    if (!opts.enabled) {
      this.hideAll();
      return;
    }

    const { camera, target, worldOffset, focusedLocal, hideSolArrow,
            sizeMaxPx, cameraMode, transition, focusedDiscRadiusPx, w, h } = opts;

    // Sol's local-frame position is `-worldOffset` (Sol is the catalog
    // origin); GC is the absolute GC vector minus the same offset.
    this.tmpSolLocal.set(-worldOffset.x, -worldOffset.y, -worldOffset.z);
    this.tmpGcLocal.set(
      GALACTIC_CENTRE_PC.x - worldOffset.x,
      GALACTIC_CENTRE_PC.y - worldOffset.y,
      GALACTIC_CENTRE_PC.z - worldOffset.z,
    );

    // Origin: the focal star (or controls.target if unfocused) is what the
    // arrows project from and what distance labels measure to.
    const origin = this.tmpOrigin.copy(focusedLocal ?? target);

    // 2D anchor for the ring + arrow shaft starts. Try projecting origin;
    // fall back to screen-centre when the projection is degenerate (camera
    // at/behind origin — the OBSERVE steady state, where the camera is
    // parked at the focal star). The fallback is also what the focal-star
    // projection naturally tends toward as the enter-transition completes,
    // so the post-transition switch is invisible.
    const originScreen = projectToScreen(origin, camera, w, h);
    const cx = originScreen ? originScreen[0] : w * 0.5;
    const cy = originScreen ? originScreen[1] : h * 0.5;

    // Mode-aware shaft start radius. Drives both arrow shaft starts and
    // the ring's drawn radius. Anchored to the user's max-star-size knob
    // so the ring scales with the rest of the scene's star presentation.
    const R = ringRadiusPx(camera.fov, sizeMaxPx);
    const shaftStartPx = computeShaftStartRadius(cameraMode, transition, R);
    const ringRadius = computeRingRadius(cameraMode, transition, R);

    // Ring rendering. Centred on the same anchor as the arrow shaft starts
    // so the arrows always tangent the ring rim, even mid-transition when
    // the anchor slides from the projected focal-star toward screen-centre.
    if (ringRadius > 0) {
      this.lastRingDisplay = setStyle(this.ring, 'display', '', this.lastRingDisplay);
      this.lastRingCx = setNumAttr(this.ring, 'cx', cx, this.lastRingCx);
      this.lastRingCy = setNumAttr(this.ring, 'cy', cy, this.lastRingCy);
      this.lastRingR = setNumAttr(this.ring, 'r', ringRadius, this.lastRingR);
    } else {
      this.lastRingDisplay = setStyle(this.ring, 'display', 'none', this.lastRingDisplay);
    }

    const targetMarginPx = Math.max(sizeMaxPx, 0);
    this.lastShaftStartPx = shaftStartPx;

    // Two-pass: first commit each arrow's geometry (path / label / debug
    // record), then compute the shared Sol+GC fade alpha from THIS frame's
    // shaft lengths and apply it. The previous design read last frame's
    // drawn lengths from `getDrawnLengths()` to compute alpha BEFORE
    // updateOne ran — that one-frame lag is exactly what flashed Sol/GC at
    // alpha=1 the first frame after a HUD toggle-on (ml8 symptom 1).
    const solDist = this.tmpSolLocal.distanceTo(origin);
    this.solDrawnLen = this.updateOne(
      this.solPath, this.solBg, this.solLabel,
      cx, cy,
      this.tmpDir.copy(this.tmpSolLocal).sub(origin),
      solDist, this.tmpSolLocal,
      camera, w, h,
      hideSolArrow, targetMarginPx, shaftStartPx, 'Sol',
      this.solDebug, this.solArrowState,
    );

    const gcDist = this.tmpGcLocal.distanceTo(origin);
    this.gcDrawnLen = this.updateOne(
      this.gcPath, this.gcBg, this.gcLabel,
      cx, cy,
      this.tmpDir.copy(this.tmpGcLocal).sub(origin),
      gcDist, this.tmpGcLocal,
      camera, w, h,
      false, targetMarginPx, shaftStartPx, 'Galactic centre',
      this.gcDebug, this.gcArrowState,
    );

    // Sol+GC share one alpha so the chevron pair fades together. The ref
    // length is the longer of the two so a degenerate-projection arrow
    // (Sol projects close to focus, shrunk to 0) doesn't drag the pair to
    // alpha=0 — the still-visible sibling drives the threshold. The
    // distance-vector overlay computes its OWN alpha against its OWN
    // shaft length (option B from the ml8 bead).
    const refLen = Math.max(this.solDrawnLen, this.gcDrawnLen);
    const alpha = focusedArrowFadeAlpha(
      cameraMode, transition, focusedDiscRadiusPx, refLen, shaftStartPx,
    );
    this.lastFadeAlpha = alpha;
    if (this.solDrawnLen > 0) {
      this.solDebug.fadeAlpha = alpha;
      applyFade([this.solPath, this.solBg, this.solLabel], this.solLabel, alpha, this.solArrowState);
    }
    if (this.gcDrawnLen > 0) {
      this.gcDebug.fadeAlpha = alpha;
      applyFade([this.gcPath, this.gcBg, this.gcLabel], this.gcLabel, alpha, this.gcArrowState);
    }
  }

  /** Sol/GC arrow shaft lengths actually drawn last frame, in CSS pixels.
   *  0 when the arrow was hidden. Used by the nav-arrow fade alpha calc
   *  in Stellata to key the fade on `max(sol, gc)`. */
  getDrawnLengths(): { sol: number; gc: number } {
    return { sol: this.solDrawnLen, gc: this.gcDrawnLen };
  }

  /** Debug snapshot of the most recent updateOne for each arrow. Read each
   *  frame by the Arrows section of the debug panel. */
  getDebugSnapshot(): { sol: ArrowDebugRecord; gc: ArrowDebugRecord } {
    return { sol: this.solDebug, gc: this.gcDebug };
  }

  /** Most-recent shaft start radius (focus-ring rim + halo gap in nav,
   *  HUD ring + halo gap in observe). Frozen between frames at the value
   *  used by the last `update`. Surfaced for the arrow-fade debug HUD. */
  getShaftStartPx(): number { return this.lastShaftStartPx; }
  private lastShaftStartPx = 0;

  /** Sol/GC pair's most-recent fade alpha (the value applied to both
   *  arrows this frame). 1 when no fade is engaged. Surfaced for the
   *  arrow-fade debug HUD so the panel can show the alpha the chevrons
   *  actually painted at, without having to re-derive it. */
  getCurrentFadeAlpha(): number { return this.lastFadeAlpha; }
  private lastFadeAlpha = 1;

  private updateOne(
    path: SVGPathElement,
    bg: SVGPathElement,
    label: SVGTextElement,
    cx: number,
    cy: number,
    dir: THREE.Vector3,
    distancePc: number,
    targetLocal: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    w: number,
    h: number,
    hide: boolean,
    targetMarginPx: number,
    shaftStartPx: number,
    labelPrefix: string,
    debug: ArrowDebugRecord,
    state: ArrowState,
  ): number {
    // updateOne commits arrow geometry (path / label) and returns the
    // drawn shaft length. The caller (update) applies the shared Sol/GC
    // fade alpha after both arrows are committed, so the alpha responds
    // to THIS frame's geometry — no one-frame lag.
    debug.hideRequested = hide;
    debug.dirPath = 'none';
    debug.behindCamera = false;
    debug.shrunkToTarget = false;
    debug.projAlong = 0;
    debug.shaftLengthPx = 0;
    // debug.fadeAlpha is populated by the caller after the shared alpha
    // is computed; default to 1 so an arrow hidden this frame reports
    // "no fade" rather than a stale value.
    debug.fadeAlpha = 1;

    const dirLenSq = dir.lengthSq();
    if (hide || dirLenSq < 1e-12) {
      this.hideArrow(path, bg, label, state);
      return 0;
    }
    dir.multiplyScalar(1 / Math.sqrt(dirLenSq));

    const targetScreen = projectToScreen(targetLocal, camera, w, h);
    debug.behindCamera = !targetScreen;

    // Screen direction of the arrow via the shared two-tier cascade in
    // arrow-path.ts: target's screen projection when in front + visible
    // offset, otherwise view-space xy of the world direction (robust to
    // behind-camera targets).
    const sdir = screenDirToTarget(cx, cy, targetScreen, dir, camera);
    if (!sdir) {
      // dir is exactly along the camera axis — no preferred screen
      // direction (measure-zero orientation).
      this.hideArrow(path, bg, label, state);
      return 0;
    }
    const sux = sdir[0];
    const suy = sdir[1];
    debug.dirPath = targetScreen && Math.hypot(targetScreen[0] - cx, targetScreen[1] - cy) >= 1
      ? 'targetScreen' : 'viewSpaceDir';

    // Shaft endpoints + chevron tip in screen pixels. Default length
    // ARROW_PIXEL_LENGTH; shrunk so the tip stays `targetMarginPx` short of
    // the projected target when the target falls inside the nominal shaft.
    // When the target is behind the camera (no targetScreen) the arrow is
    // drawn at full length to indicate direction only.
    let shaftLengthPx = ARROW_PIXEL_LENGTH;
    if (targetScreen) {
      const tdx = targetScreen[0] - cx;
      const tdy = targetScreen[1] - cy;
      const projAlong = tdx * sux + tdy * suy;
      debug.projAlong = projAlong;
      if (projAlong > 0) {
        const allowed = projAlong - shaftStartPx - targetMarginPx;
        if (allowed < shaftLengthPx) {
          shaftLengthPx = allowed;
          debug.shrunkToTarget = true;
        }
      }
    }
    debug.shaftLengthPx = shaftLengthPx;

    if (shaftLengthPx <= 0) {
      this.hideArrow(path, bg, label, state);
      return 0;
    }

    const shaftStartX = cx + sux * shaftStartPx;
    const shaftStartY = cy + suy * shaftStartPx;
    const tipX = shaftStartX + sux * shaftLengthPx;
    const tipY = shaftStartY + suy * shaftLengthPx;

    // Chevron scales with shaft length so a heavily-shrunk shaft (slen-
    // degeneracy) doesn't end up dominated by a full-size arrowhead. Above
    // CHEVRON_FULL_AT_PX shafts the chevron is at its nominal size; below
    // it scales linearly to zero.
    const CHEVRON_FULL_AT_PX = 16;
    const chevronScale = Math.min(1, shaftLengthPx / CHEVRON_FULL_AT_PX);
    const d = buildArrowSvgPath(shaftStartX, shaftStartY, tipX, tipY, chevronScale);
    if (!d) {
      this.hideArrow(path, bg, label, state);
      return 0;
    }
    if (d !== state.lastD) {
      path.setAttribute('d', d);
      bg.setAttribute('d', d);
      state.lastD = d;
    }

    const labelAnchorX = tipX + ARROW_LABEL_OFFSET_PX + ARROW_HEAD_DEPTH_PX;
    const labelAnchorY = tipY - ARROW_LABEL_OFFSET_PX;
    const sx = clamp(labelAnchorX, ARROW_LABEL_PADDING_PX, w - ARROW_LABEL_PADDING_PX);
    const sy = clamp(labelAnchorY, ARROW_LABEL_PADDING_PX, h - ARROW_LABEL_PADDING_PX);
    state.lastLabelDisplay = setStyle(label, 'display', '', state.lastLabelDisplay);
    state.lastLabelX = setNumAttr(label, 'x', sx, state.lastLabelX);
    state.lastLabelY = setNumAttr(label, 'y', sy, state.lastLabelY);
    state.lastLabelText = setText(label, `${labelPrefix} · ${fmtDist(distancePc)}`, state.lastLabelText);

    return shaftLengthPx;
  }

  /** Mono-mode swap is handled by CSS rules on `.gal-arrow`, `.gal-arrow-bg`,
   *  and `.hud-ring`, so this method is intentionally empty. Kept on the
   *  interface for symmetry with the disc/grid layers. */
  setMonochrome(_on: boolean) { /* CSS-only */ }

  /** Top-level visibility for warp-hide. */
  setVisible(on: boolean) {
    if (!on) this.hideAll();
  }

  private hideAll() {
    this.lastRingDisplay = setStyle(this.ring, 'display', 'none', this.lastRingDisplay);
    this.hideArrow(this.solPath, this.solBg, this.solLabel, this.solArrowState);
    this.hideArrow(this.gcPath, this.gcBg, this.gcLabel, this.gcArrowState);
    this.solDrawnLen = 0;
    this.gcDrawnLen = 0;
    this.lastFadeAlpha = 1;
    Object.assign(this.solDebug, emptyArrowDebug());
    Object.assign(this.gcDebug, emptyArrowDebug());
  }

  // Hide an arrow. The visible d / display writes go through the dirty-
  // track gate; the remaining numeric + text sentinels are reset to poison
  // via resetArrowSentinels so the next show-from-hide cycle's first write
  // always lands — without this reset, a re-show whose new label coords
  // fell within ATTR_DIRTY_PX of the prior session's values would silently
  // skip the setAttribute and inherit the stale x/y. Same shape as the
  // heliopause first-load fix (PR #64) and the consistency-at-the-seam §3
  // rule.
  private hideArrow(
    path: SVGPathElement,
    bg: SVGPathElement,
    label: SVGTextElement,
    state: ArrowState,
  ) {
    // path + bg are kept in sync via the single state.lastD sentinel — write
    // them as a pair inside one guard.
    if ('' !== state.lastD) {
      path.setAttribute('d', '');
      bg.setAttribute('d', '');
      state.lastD = '';
    }
    state.lastLabelDisplay = setStyle(label, 'display', 'none', state.lastLabelDisplay);
    resetArrowSentinels(state);
  }
}

/**
 * Reset every per-attribute sentinel in `state` to its poison-init value
 * so the next visible frame's first write through the dirty-attr gate
 * always lands. Used by `hideArrow` after the gated d / display writes.
 * Surfaced for direct test coverage of the sentinel-wipe contract (
 * — without this reset the first show-from-hide cycle would inherit stale
 * cx/cy/lx/ly/opacity from the prior visible session).
 *
 * `lastD` and `lastLabelDisplay` are NOT wiped — they pass through the
 * dirty-attr gate so the hide-state value is the correct cached value.
 * `lastOpacity` uses `-Infinity` (not NaN) to match the gate direction in
 * `applyFade` — see emptyArrowState's comment for why NaN poisons it.
 */
export function resetArrowSentinels(state: ArrowState): void {
  state.lastLabelText = '\0';
  state.lastLabelX = NaN;
  state.lastLabelY = NaN;
  state.lastOpacity = -Infinity;
  state.lastPointerEvents = '\0';
}

// The "active" ring the arrows attach to:
//   - Navigate steady state → focus ring (24 px, drawn by focus-ring-overlay)
//   - Observe steady state  → HUD ring (R px, drawn by this module)
//   - Transition            → max of the two as both lerp through 0
// The arrow shaft starts `RING_HALO_GAP_PX` outside this radius, so the
// halo gap reads identically in either mode and lerps continuously through
// the transition.
function activeRingRadius(
  cameraMode: 'navigate' | 'observe',
  transition: { f: number; kind: 'enter' | 'exit' } | null,
  R: number,
): number {
  if (transition) {
    const focus = transition.kind === 'enter'
      ? FOCUS_RING_RADIUS_PX * (1 - transition.f)
      : FOCUS_RING_RADIUS_PX * transition.f;
    const hud = transition.kind === 'enter'
      ? R * transition.f
      : R * (1 - transition.f);
    return Math.max(focus, hud);
  }
  return cameraMode === 'observe' ? R : FOCUS_RING_RADIUS_PX;
}

function computeShaftStartRadius(
  cameraMode: 'navigate' | 'observe',
  transition: { f: number; kind: 'enter' | 'exit' } | null,
  R: number,
): number {
  return activeRingRadius(cameraMode, transition, R) + RING_HALO_GAP_PX;
}

// HUD ring's drawn radius (the focus ring is rendered separately by
// focus-ring-overlay.ts, with its own lerp). Returns 0 when the ring
// shouldn't be drawn this frame.
function computeRingRadius(
  cameraMode: 'navigate' | 'observe',
  transition: { f: number; kind: 'enter' | 'exit' } | null,
  R: number,
): number {
  if (transition) {
    return transition.kind === 'enter' ? R * transition.f : R * (1 - transition.f);
  }
  return cameraMode === 'observe' ? R : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface ArrowDebugRecord {
  hideRequested: boolean;
  behindCamera: boolean;
  dirPath: 'none' | 'targetScreen' | 'viewSpaceDir';
  projAlong: number;
  shrunkToTarget: boolean;
  shaftLengthPx: number;
  fadeAlpha: number;
}

export function emptyArrowDebug(): ArrowDebugRecord {
  return {
    hideRequested: false,
    behindCamera: false,
    dirPath: 'none',
    projAlong: 0,
    shrunkToTarget: false,
    shaftLengthPx: 0,
    fadeAlpha: 1,
  };
}

