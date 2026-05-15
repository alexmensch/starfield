import type { Stellata } from './stellata';

// Live diagnostic readouts for the navigate-mode Sol/GC arrow fade.
// Mounted as a section inside the unified debug panel (see debug.ts).
//
// What it shows:
//   - For each of Sol and GC: which direction-derivation path was used,
//     whether the target was behind the camera, the drawn shaft length,
//     whether shrink-to-target shortened it, the fade alpha applied.
//   - Aggregate: the focused star, peak disc radius, refLen = max of
//     drawn shafts, coverage = (discRadius - shaftStart) / refLen, the
//     fade alpha both sides agreed on, and any latched extremes.
//
// The bottom row shows latched min/max for alpha, drawn shafts, and disc
// radius, so brief snaps / jumps are visible after they happen. Click
// the reset link to clear them. The section's left border turns red
// when the two arrows disagree on draw / behind-camera state — fast
// visual cue that an independent snap is happening.

interface Latch {
  alphaMin: number; alphaMax: number;
  solMax: number; gcMax: number;
  discMin: number; discMax: number;
  solBehindMaxLen: number;  // longest sol drawn while behindCamera was true
  gcBehindMaxLen: number;
}

function emptyLatch(): Latch {
  return {
    alphaMin: 1, alphaMax: 0,
    solMax: 0, gcMax: 0,
    discMin: Infinity, discMax: 0,
    solBehindMaxLen: 0, gcBehindMaxLen: 0,
  };
}

export interface ArrowSection {
  element: HTMLDivElement;
  dispose: () => void;
  setVisible: (v: boolean) => void;
}

export function buildArrowSection(stellata: Stellata): ArrowSection {
  const latch = emptyLatch();
  let visible = true;

  const root = document.createElement('div');
  root.style.cssText =
    'font:11px/1.3 ui-monospace,monospace;background:rgba(0,0,0,.85);' +
    'color:#0f0;padding:6px 8px;border-radius:4px;' +
    'white-space:pre;overflow-x:auto;user-select:text;' +
    'border-left:3px solid #0f0;';

  const body = document.createElement('div');
  body.style.cssText = 'user-select:text;cursor:text;';
  root.appendChild(body);

  // Reset link: only THIS element is clickable (so dragging across the
  // body to copy values doesn't reset the latches).
  const reset = document.createElement('div');
  reset.textContent = '[click to reset latches]';
  reset.style.cssText = 'margin-top:6px;cursor:pointer;color:#999;user-select:none;';
  reset.title = 'reset latched extremes';
  reset.addEventListener('click', () => {
    Object.assign(latch, emptyLatch());
  });
  root.appendChild(reset);

  const fmt = (n: number) => {
    if (n === 0) return '0';
    if (!Number.isFinite(n)) return String(n);
    if (Math.abs(n) >= 0.001 && Math.abs(n) < 10000) return n.toFixed(2);
    return n.toExponential(2);
  };
  const fmtAlpha = (n: number) => n.toFixed(3);

  const arrowLine = (label: string, len: number, d: ReturnType<typeof stellata.hud.getDebugSnapshot>['sol']) =>
    `${label}: drawn=${fmt(len)}  ` +
    `${d.behindCamera ? 'BEHIND' : 'in-front'}  ` +
    `dir=${d.dirPath}  ` +
    `shrunk=${d.shrunkToTarget ? 'Y' : 'N'}  ` +
    `α=${fmtAlpha(d.fadeAlpha)}\n` +
    `        projAlong=${fmt(d.projAlong)}  hide?${d.hideRequested ? 'Y' : 'N'}`;

  const onFrame = () => {
    const lengths = stellata.hud.getDrawnLengths();
    const dbg = stellata.hud.getDebugSnapshot();
    const shaftStart = stellata.hud.getShaftStartPx();
    const alpha = stellata.getNavigateArrowFadeAlpha();
    const focused = stellata.getFocusedStar();
    const discRadius = focused !== null ? stellata.renderedDiscPxAtPeakDebug(focused) / 2 : 0;
    const refLen = Math.max(lengths.sol, lengths.gc);
    const coverage = refLen > 0 ? Math.max(0, discRadius - shaftStart) / refLen : 0;

    // Latches keep updating regardless of visibility — the user's
    // interaction may have spanned a collapse and we still want the
    // latched extremes to reflect the whole observation window.
    if (alpha < latch.alphaMin) latch.alphaMin = alpha;
    if (alpha > latch.alphaMax) latch.alphaMax = alpha;
    if (lengths.sol > latch.solMax) latch.solMax = lengths.sol;
    if (lengths.gc > latch.gcMax) latch.gcMax = lengths.gc;
    if (discRadius < latch.discMin && discRadius > 0) latch.discMin = discRadius;
    if (discRadius > latch.discMax) latch.discMax = discRadius;
    if (dbg.sol.behindCamera && lengths.sol > latch.solBehindMaxLen) latch.solBehindMaxLen = lengths.sol;
    if (dbg.gc.behindCamera && lengths.gc > latch.gcBehindMaxLen) latch.gcBehindMaxLen = lengths.gc;

    if (!visible) return;

    body.textContent =
      `focus: ${focused}  mode: ${stellata.getCameraMode()}\n` +
      `shaftStart: ${fmt(shaftStart)} px\n` +
      `discRadius (peak): ${fmt(discRadius)} px  range:[${fmt(latch.discMin)}, ${fmt(latch.discMax)}]\n` +
      `refLen: ${fmt(refLen)} px  coverage: ${fmt(coverage)}\n` +
      `alpha: ${fmtAlpha(alpha)}  range:[${fmtAlpha(latch.alphaMin)}, ${fmtAlpha(latch.alphaMax)}]\n` +
      `\n` +
      arrowLine('SOL', lengths.sol, dbg.sol) + `\n` +
      arrowLine(' GC', lengths.gc, dbg.gc) + `\n` +
      `\n` +
      `latch: solMax=${fmt(latch.solMax)}  gcMax=${fmt(latch.gcMax)}\n` +
      `       sol-behind-max=${fmt(latch.solBehindMaxLen)}  gc-behind-max=${fmt(latch.gcBehindMaxLen)}`;

    // Red border when at least one arrow is drawn but disagrees with the
    // other on opacity-relevant state — fast visual cue that an
    // independent snap is happening.
    const independentState =
      (lengths.sol > 0) !== (lengths.gc > 0) ||
      dbg.sol.behindCamera !== dbg.gc.behindCamera;
    root.style.borderLeftColor = independentState ? '#f33' : '#0f0';
  };

  const unsubscribe = stellata.onFrame(onFrame);

  return {
    element: root,
    dispose: () => { unsubscribe(); },
    setVisible: (v: boolean) => { visible = v; },
  };
}
