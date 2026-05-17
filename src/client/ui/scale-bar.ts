import * as THREE from 'three';
import type { Stellata } from '../stellata';
import { AU_PER_PC } from '../solar-system/astronomy-constants';
import {
  fmtDistAuto,
  niceRound,
  getUnit,
  LY_PER_PC,
  AU_SWITCH_PC,
} from './distance-util';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Horizontal scene-scale bar targets ~20% of viewport width before
// snap-to-nice trims it to a 1/2/5×10^N value. niceRound brings it back
// down to between 0.27× and 1.5× the target — wide enough to read clearly
// on a desktop, slim enough to leave room for the meta widget.
const TARGET_BAR_FRAC = 0.20;
// Z-axis recession line: 10% of viewport width drawn as a fixed-length
// hypotenuse pointing at the focused object's projected screen position
// so the indicator literally aims at what it labels. When the projection
// is unavailable (focus behind camera, off-screen) or unstable (delta
// vector too small) the line falls back to a default 45° up-and-right.
const Z_AXIS_FRAC = 0.10;
const Z_DEFAULT_ANGLE_RAD = -Math.PI / 4; // -45° in screen-y-down convention = up-and-right
// Bound the projected angle so the line doesn't fold below the bar or
// overlap the label area. Going above ~-15° (almost horizontal) flattens
// the indicator's depth metaphor; going past about -160° wraps onto the
// bar's left side. Outside this range we clamp to the nearest endpoint.
const Z_ANGLE_MIN_RAD = -Math.PI + Math.PI / 12;  // -165° (steep up-left)
const Z_ANGLE_MAX_RAD = -Math.PI / 12;            // -15° (almost horizontal up-right)

// Three internal ticks at 25/50/75% — quartering reads naturally for
// niceRound values like 100, 1000, 10 (round multiples of 4 fractions).
// The tradeoff for 1/2/5 nice values is minor; we accept a small
// inconsistency on "5 pc" rather than carry a per-decade tick policy.
const TICK_FRACTIONS = [0.25, 0.5, 0.75];
const TICK_HEIGHT_PX = 4;
const ENDCAP_HEIGHT_PX = 7;

// Z-axis tip dressing: ⇥-style. Arrowhead size is chosen so the
// perpendicular endcap visibly extends past it on both sides.
const Z_ARROW_LEN_PX = 7;
const Z_ARROW_HALF_WIDTH_PX = 3.5;
const Z_ENDCAP_HALF_LEN_PX = 6;

// Padding inside the SVG so the bar's left endcap (extends below baseline)
// and the z-axis name label (extends above the endcap) don't clip.
const PAD_LEFT_PX = 10;
const PAD_TOP_PX = 18;
const BAR_LABEL_GAP_PX = 6;
const BAR_LABEL_HEIGHT_PX = 14;
// The name label rides along the same 45° line, anchored a few px past
// the line's tip so the text starts where the line "would have continued"
// and reads horizontally to the right. NAME_TIP_GAP is the distance along
// the extended line between the endcap and the text anchor.
const NAME_TIP_GAP_PX = 10;
const DIST_OFFSET_PX = 10;

const tmpFocusPos = new THREE.Vector3();
const tmpProj = new THREE.Vector3();
const tmpAB = new THREE.Vector3();
const tmpCamToA = new THREE.Vector3();

interface Elements {
  svg: SVGSVGElement;
  // horizontal bar group
  hLine: SVGLineElement;
  hEndcapL: SVGLineElement;
  hEndcapR: SVGLineElement;
  hTicks: SVGLineElement[];
  hLabel: SVGTextElement;
  // z-axis group
  zGroup: SVGGElement;
  zLine: SVGLineElement;
  zArrow: SVGPolygonElement;
  zEndcap: SVGLineElement;
  zName: SVGTextElement;
  zDist: SVGTextElement;
}

export function createScaleBar(
  stellata: Stellata,
  starLabels: Map<number, string>,
) {
  const host = document.getElementById('scale-bar')!;
  host.hidden = false;
  host.innerHTML = '';

  const els = buildSvg();
  host.appendChild(els.svg);

  let lastSig = '';

  stellata.on('frame', () => {
    const camera = stellata.camera;
    const mode = stellata.getCameraMode();
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (mode === 'observe') {
      // OBSERVE: angular extent of sky for the horizontal bar; z-axis
      // hidden because the user is looking out from the focal star, so
      // "distance to focused object" is meaningless (it's zero).
      const targetBarPx = w * TARGET_BAR_FRAC;
      const pxPerDeg = h / camera.fov;
      const idealDeg = targetBarPx / pxPerDeg;
      const niceDeg = niceRound(idealDeg);
      const barPx = niceDeg * pxPerDeg;
      const label = formatDegrees(niceDeg);
      const sig = `obs|${barPx.toFixed(1)}|${label}`;
      if (sig === lastSig) return;
      lastSig = sig;
      drawHorizontalBar(els, barPx, label);
      hideZAxis(els);
      sizeSvg(els, barPx, /*hasZ*/ false, w);
      return;
    }

    // NAVIGATE
    const target = stellata.controls.target;
    const focalDepth = Math.max(camera.position.distanceTo(target), 1e-12);
    const fovRad = (camera.fov * Math.PI) / 180;
    const pxPerPc = h / (2 * focalDepth * Math.tan(fovRad / 2));

    const targetBarPx = w * TARGET_BAR_FRAC;
    const idealPc = targetBarPx / pxPerPc;
    let nicePc: number;
    if (idealPc < AU_SWITCH_PC) {
      // AU regime — niceRound on the AU value so the bar lands on a
      // round Voyager-class number ("1000 AU" not "0.005 pc").
      const niceAu = niceRound(idealPc * AU_PER_PC);
      nicePc = niceAu / AU_PER_PC;
    } else {
      const isLy = getUnit() === 'ly';
      const display = niceRound(isLy ? idealPc * LY_PER_PC : idealPc);
      nicePc = isLy ? display / LY_PER_PC : display;
    }
    const barPx = nicePc * pxPerPc;
    const barLabel = fmtDistAuto(nicePc);

    // Pick which object the z-axis points at.
    //
    //   No warp:        focused star/cloud (existing focus context).
    //   Warp in flight: source while the camera is on the source side of
    //                   the A→B axis; flip to destination once the
    //                   camera has passed A. "Past A" is defined as
    //                   (camera − A) · normalize(B − A) > 0 — purely
    //                   trajectory-relative, so it stays stable under
    //                   future curved-warp paths (a7d.2.9) that swing
    //                   the camera attitude around without moving along
    //                   the axis.
    const display = pickDisplayTarget(stellata, starLabels);

    let zVisible = false;
    let zName = '';
    let zDistLabel = '';
    let zAngleRad = Z_DEFAULT_ANGLE_RAD;
    if (display !== null) {
      zVisible = true;
      zName = display.name;
      const distPc = camera.position.distanceTo(display.pos);
      zDistLabel = fmtDistAuto(distPc);
      zAngleRad = computeZAngle(stellata, display.pos, els.svg);
    }

    const sig = `nav|${barPx.toFixed(1)}|${barLabel}|${zVisible ? 1 : 0}|${zName}|${zDistLabel}|${zAngleRad.toFixed(3)}`;
    if (sig === lastSig) return;
    lastSig = sig;

    drawHorizontalBar(els, barPx, barLabel);
    if (zVisible) {
      drawZAxis(els, w, zName, zDistLabel, zAngleRad);
    } else {
      hideZAxis(els);
    }
    sizeSvg(els, barPx, zVisible, w);
  });
}

// During a warp, swap the displayed target from source to destination
// once the camera has crossed the source plane on the warp axis. Outside
// of warp, the displayed target is whichever object is currently
// focused. Returns null when nothing is focused and no warp is active.
function pickDisplayTarget(
  stellata: Stellata,
  starLabels: Map<number, string>,
): { name: string; pos: THREE.Vector3 } | null {
  const warp = stellata.getWarpInfo();
  const focus = getFocusContext(stellata, starLabels);
  if (warp) {
    tmpAB.subVectors(warp.B, warp.A);
    const ab2 = tmpAB.lengthSq();
    if (ab2 > 1e-30) {
      tmpCamToA.subVectors(stellata.camera.position, warp.A);
      // Project onto AB without normalising — sign is all we need, so
      // we save a sqrt + a divide and avoid a near-zero edge case for
      // co-located A and B.
      const proj = tmpCamToA.dot(tmpAB);
      if (proj > 0) {
        // Past the source plane — swap to destination.
        const destName =
          warp.destKind === 'star'
            ? starLabels.get(warp.destIdx) ?? `Star #${warp.destIdx}`
            : stellata.getCloudCatalog()?.clouds[warp.destIdx]?.name ?? `Cloud #${warp.destIdx}`;
        // Reuse tmpFocusPos as the return slot; B is a Readonly ref we
        // don't want to leak.
        tmpFocusPos.copy(warp.B);
        return { name: destName, pos: tmpFocusPos };
      }
    }
  }
  return focus;
}

// Project the display-target world position into screen space and
// derive the angle from the bar's left-end origin to that screen point.
// Returns Z_DEFAULT_ANGLE_RAD when the projection is unusable (target
// behind the camera, delta vector too short, or the SVG host hasn't
// laid out yet).
function computeZAngle(
  stellata: Stellata,
  worldPos: THREE.Vector3,
  svg: SVGSVGElement,
): number {
  tmpProj.copy(worldPos).project(stellata.camera);
  // .project gives NDC in [-1, 1]. NDC z > 1 means behind the far plane;
  // < -1 means behind the near plane / camera. The latter is the case
  // we actually care about — direction is meaningless when the target
  // is behind us.
  if (tmpProj.z < -1 || tmpProj.z > 1) return Z_DEFAULT_ANGLE_RAD;
  const targetVx = (tmpProj.x * 0.5 + 0.5) * window.innerWidth;
  const targetVy = (-tmpProj.y * 0.5 + 0.5) * window.innerHeight;

  // Bar origin in viewport coords. getBoundingClientRect can be {0,0}
  // pre-layout; in that case fall back to the default angle rather than
  // computing a nonsense direction.
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return Z_DEFAULT_ANGLE_RAD;
  const zRunPx = window.innerWidth * Z_AXIS_FRAC;
  const zDy = zRunPx * Math.sin(-Z_DEFAULT_ANGLE_RAD); // worst-case baseline
  const baselineY = PAD_TOP_PX + zDy;
  const originVx = rect.left + PAD_LEFT_PX;
  const originVy = rect.top + baselineY;

  const dx = targetVx - originVx;
  const dy = targetVy - originVy;
  if (dx * dx + dy * dy < 16) return Z_DEFAULT_ANGLE_RAD; // < 4 px — unstable
  let angle = Math.atan2(dy, dx);
  // Constrain to the upward hemisphere. The display target normally
  // sits well above the bar's bottom-left corner; if heavy panning has
  // dragged it under or behind the bar, clamp to the nearest endpoint
  // of the allowed range so the line stays sensibly oriented.
  if (angle > 0) {
    // Below the bar — clamp to whichever side of the upward arc is
    // closer (sign-of-dx picks left vs right).
    angle = dx < 0 ? Z_ANGLE_MIN_RAD : Z_ANGLE_MAX_RAD;
  } else if (angle > Z_ANGLE_MAX_RAD) {
    angle = Z_ANGLE_MAX_RAD;
  } else if (angle < Z_ANGLE_MIN_RAD) {
    angle = Z_ANGLE_MIN_RAD;
  }
  return angle;
}

function getFocusContext(
  stellata: Stellata,
  starLabels: Map<number, string>,
): { name: string; pos: THREE.Vector3 } | null {
  const starIdx = stellata.getFocusedStar();
  if (starIdx !== null) {
    const p = stellata.localPositions;
    tmpFocusPos.set(p[starIdx * 3], p[starIdx * 3 + 1], p[starIdx * 3 + 2]);
    const name = starLabels.get(starIdx) ?? `Star #${starIdx}`;
    return { name, pos: tmpFocusPos };
  }
  const cloudIdx = stellata.getFocusedCloud();
  if (cloudIdx !== null) {
    if (!stellata.cloudLocalPositionInto(cloudIdx, tmpFocusPos)) return null;
    const cat = stellata.getCloudCatalog();
    if (!cat) return null;
    return { name: cat.clouds[cloudIdx].name, pos: tmpFocusPos };
  }
  return null;
}

function buildSvg(): Elements {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'scale-bar-svg');
  svg.setAttribute('xmlns', SVG_NS);

  const hLine = mkLine('h-line');
  const hEndcapL = mkLine('h-endcap');
  const hEndcapR = mkLine('h-endcap');
  const hTicks = TICK_FRACTIONS.map(() => mkLine('h-tick'));
  const hLabel = mkText('h-label', 'middle', 'hanging');

  const zGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement;
  const zLine = mkLine('z-line');
  const zArrow = document.createElementNS(SVG_NS, 'polygon') as SVGPolygonElement;
  zArrow.setAttribute('class', 'z-arrow');
  const zEndcap = mkLine('z-endcap');
  const zName = mkText('z-name', 'start', 'central');
  const zDist = mkText('z-dist', 'middle', 'auto');
  zGroup.append(zLine, zArrow, zEndcap, zDist, zName);

  // Bar first so the z-axis line renders above its left endcap join.
  svg.append(hLine, hEndcapL, hEndcapR, ...hTicks, hLabel, zGroup);

  return { svg, hLine, hEndcapL, hEndcapR, hTicks, hLabel, zGroup, zLine, zArrow, zEndcap, zName, zDist };
}

function mkLine(cls: string): SVGLineElement {
  const el = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
  el.setAttribute('class', cls);
  return el;
}

function mkText(
  cls: string,
  anchor: 'start' | 'middle' | 'end',
  baseline: 'auto' | 'hanging' | 'middle' | 'central',
): SVGTextElement {
  const el = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
  el.setAttribute('class', cls);
  el.setAttribute('text-anchor', anchor);
  el.setAttribute('dominant-baseline', baseline);
  return el;
}

function sizeSvg(els: Elements, barPx: number, hasZ: boolean, vw: number): void {
  const zRunPx = vw * Z_AXIS_FRAC;
  // Default-angle z-axis projection — used as the worst-case bounding
  // size so the SVG dimensions don't churn when the line angle changes
  // (it now tracks the focused object). Other angles overflow visibly
  // thanks to overflow:visible on the SVG, which is fine for a non-
  // interactive widget.
  const zDxDefault = zRunPx * Math.cos(Z_DEFAULT_ANGLE_RAD);
  const zDyDefault = zRunPx * Math.sin(-Z_DEFAULT_ANGLE_RAD);

  // Always reserve the z-axis vertical extent so the bar's screen
  // position stays steady whether or not the z-axis is visible. Without
  // this, the SVG shrinks on unfocus and the bar (whose y is always
  // computed against the worst-case baseline) gets clipped outside the
  // SVG bounds — visually disappearing along with the z-axis.
  const baselineY = PAD_TOP_PX + zDyDefault;
  const totalH = baselineY + ENDCAP_HEIGHT_PX + BAR_LABEL_GAP_PX + BAR_LABEL_HEIGHT_PX;

  // The right edge needs to clear:
  //   - the bar's right endcap PLUS the right half of the bar label
  //     (which is now centred on the right endcap, not the bar midpoint)
  //   - the z-axis tip at default angle plus name text margin (visible)
  const barLabelHalfWidth = 30; // covers labels up to ~60px wide ("1234 AU", "12.5 pc")
  const barRight = PAD_LEFT_PX + barPx + barLabelHalfWidth;
  const zRight = hasZ ? PAD_LEFT_PX + zDxDefault + NAME_TIP_GAP_PX + 80 : 0;
  const totalW = Math.max(barRight, zRight) + 8;

  els.svg.setAttribute('width', String(Math.ceil(totalW)));
  els.svg.setAttribute('height', String(Math.ceil(totalH)));
}

function drawHorizontalBar(els: Elements, barPx: number, label: string): void {
  const vw = window.innerWidth;
  const zRunPx = vw * Z_AXIS_FRAC;
  // Worst-case zDy (line at default angle) so the bar's screen position
  // stays steady whether or not the z-axis is visible.
  const zDy = zRunPx * Math.sin(-Z_DEFAULT_ANGLE_RAD);
  const baselineY = PAD_TOP_PX + zDy;
  const x0 = PAD_LEFT_PX;
  const x1 = PAD_LEFT_PX + barPx;

  setLine(els.hLine, x0, baselineY, x1, baselineY);
  setLine(els.hEndcapL, x0, baselineY, x0, baselineY + ENDCAP_HEIGHT_PX);
  setLine(els.hEndcapR, x1, baselineY, x1, baselineY + ENDCAP_HEIGHT_PX);
  for (let i = 0; i < TICK_FRACTIONS.length; i++) {
    const tx = x0 + barPx * TICK_FRACTIONS[i];
    setLine(els.hTicks[i], tx, baselineY, tx, baselineY + TICK_HEIGHT_PX);
  }
  // Anchor the label at the bar's right end (centered on the right
  // endcap) rather than at the bar's midpoint. The internal ticks make
  // a midpoint-centered label read as "this distance is to the nearest
  // tick" — anchoring it at the terminating endcap clarifies that the
  // value applies to the whole bar.
  els.hLabel.setAttribute('x', String(x1));
  els.hLabel.setAttribute('y', String(baselineY + ENDCAP_HEIGHT_PX + BAR_LABEL_GAP_PX));
  els.hLabel.textContent = label;
}

function drawZAxis(
  els: Elements,
  vw: number,
  name: string,
  distLabel: string,
  angleRad: number,
): void {
  els.zGroup.removeAttribute('display');

  const zRunPx = vw * Z_AXIS_FRAC;
  // Direction along the line in screen coords (y-down). At the default
  // -45° this resolves to (cos45, -sin45) = (0.707, -0.707) — line
  // going up-and-right. Perpendicular (rotated 90° CCW): (-sin θ, cos θ).
  const dxN = Math.cos(angleRad);
  const dyN = Math.sin(angleRad);
  const pxN = -Math.sin(angleRad);
  const pyN = Math.cos(angleRad);

  // Bar baseline stays at the worst-case (default angle) y so the bar
  // doesn't shift when the z-axis points at a steeper angle.
  const baselineY = PAD_TOP_PX + zRunPx * Math.sin(-Z_DEFAULT_ANGLE_RAD);
  const ox = PAD_LEFT_PX;
  const oy = baselineY;
  const tx = ox + dxN * zRunPx;
  const ty = oy + dyN * zRunPx;

  setLine(els.zLine, ox, oy, tx, ty);

  const baseCx = tx - dxN * Z_ARROW_LEN_PX;
  const baseCy = ty - dyN * Z_ARROW_LEN_PX;
  const baseLx = baseCx + pxN * Z_ARROW_HALF_WIDTH_PX;
  const baseLy = baseCy + pyN * Z_ARROW_HALF_WIDTH_PX;
  const baseRx = baseCx - pxN * Z_ARROW_HALF_WIDTH_PX;
  const baseRy = baseCy - pyN * Z_ARROW_HALF_WIDTH_PX;
  els.zArrow.setAttribute(
    'points',
    `${tx.toFixed(2)},${ty.toFixed(2)} ${baseLx.toFixed(2)},${baseLy.toFixed(2)} ${baseRx.toFixed(2)},${baseRy.toFixed(2)}`,
  );

  // Endcap bar: perpendicular at the tip, centered. Slightly longer than
  // the arrowhead base so it visibly brackets the arrow (the ⇥ silhouette).
  const eLx = tx + pxN * Z_ENDCAP_HALF_LEN_PX;
  const eLy = ty + pyN * Z_ENDCAP_HALF_LEN_PX;
  const eRx = tx - pxN * Z_ENDCAP_HALF_LEN_PX;
  const eRy = ty - pyN * Z_ENDCAP_HALF_LEN_PX;
  setLine(els.zEndcap, eLx, eLy, eRx, eRy);

  // Distance label rides along the line, offset perpendicular to the
  // upper side so it sits above the line. The rotation matches the
  // line's angle so the text reads along the line itself.
  const midX = ox + dxN * zRunPx / 2;
  const midY = oy + dyN * zRunPx / 2;
  // The "upper" side depends on the line's orientation: for a typical
  // up-right line, that's (-pxN, -pyN); we always offset toward whatever
  // direction has a more negative y so the label clears the line.
  const offsetSign = pyN > 0 ? -1 : 1;
  const distAnchorX = midX + offsetSign * pxN * DIST_OFFSET_PX;
  const distAnchorY = midY + offsetSign * pyN * DIST_OFFSET_PX;
  const rotDeg = (angleRad * 180) / Math.PI;
  els.zDist.setAttribute('x', distAnchorX.toFixed(2));
  els.zDist.setAttribute('y', distAnchorY.toFixed(2));
  els.zDist.setAttribute(
    'transform',
    `rotate(${rotDeg.toFixed(2)} ${distAnchorX.toFixed(2)} ${distAnchorY.toFixed(2)})`,
  );
  els.zDist.textContent = distLabel;

  // Name label: anchored on the projected continuation of the line a
  // few px past the tip, text running horizontally to the right (not
  // rotated — names need to be readable without head-tilt). Visually
  // the name "rides" the diagonal as if the line carried on into the text.
  const nameAnchorX = tx + dxN * NAME_TIP_GAP_PX;
  const nameAnchorY = ty + dyN * NAME_TIP_GAP_PX;
  els.zName.setAttribute('x', nameAnchorX.toFixed(2));
  els.zName.setAttribute('y', nameAnchorY.toFixed(2));
  els.zName.textContent = name;
}

function hideZAxis(els: Elements): void {
  els.zGroup.setAttribute('display', 'none');
}

function setLine(el: SVGLineElement, x1: number, y1: number, x2: number, y2: number): void {
  el.setAttribute('x1', x1.toFixed(2));
  el.setAttribute('y1', y1.toFixed(2));
  el.setAttribute('x2', x2.toFixed(2));
  el.setAttribute('y2', y2.toFixed(2));
}

function formatDegrees(deg: number): string {
  if (deg >= 1) return `${deg.toFixed(0)}°`;
  if (deg >= 0.1) return `${deg.toFixed(1)}°`;
  return `${deg.toFixed(2)}°`;
}
