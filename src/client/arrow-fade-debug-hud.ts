import type { Stellata } from './stellata';

// Live diagnostic HUD for the navigate-mode arrow fade. Toggled via
// `debug.arrows()` in the dev console.
//
// Shows per-frame everything that drives the fade so we can see exactly
// why an arrow ended up at a given length / opacity:
//   - For each of Sol and GC: which direction-derivation path was used,
//     whether the target was behind the camera, the drawn shaft length,
//     whether shrink-to-target shortened it, the fade alpha applied.
//   - Aggregate: the focused star, peak disc radius, refLen = max of
//     drawn shafts, coverage = (discRadius - shaftStart) / refLen, the
//     fade alpha both sides agreed on, and any latched extremes.
//
// The bottom row of the HUD shows latched min/max for the alpha, the
// drawn shafts, and the disc radius, so brief snaps / jumps are visible
// after they happen. Click [click to reset latches] to clear them.

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

let panel: HTMLDivElement | null = null;

export function toggleArrowFadeHud(stellata: Stellata): void {
  if (panel) {
    panel.remove();
    panel = null;
    return;
  }

  const latch = emptyLatch();

  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:9999;' +
    'font:11px/1.3 ui-monospace,monospace;background:rgba(0,0,0,.85);' +
    'color:#0f0;padding:6px 8px;border-radius:4px;' +
    'white-space:pre;max-width:420px;user-select:text;';

  const body = document.createElement('div');
  body.style.cssText = 'user-select:text;cursor:text;';
  root.appendChild(body);

  const reset = document.createElement('div');
  reset.textContent = '[click to reset latches]';
  reset.style.cssText = 'margin-top:6px;cursor:pointer;color:#999;user-select:none;';
  reset.addEventListener('click', () => {
    Object.assign(latch, emptyLatch());
  });
  root.appendChild(reset);

  document.body.appendChild(root);
  panel = root;

  const fmt = (n: number) => {
    if (n === 0) return '0';
    if (!Number.isFinite(n)) return String(n);
    if (Math.abs(n) >= 0.001 && Math.abs(n) < 10000) return n.toFixed(2);
    return n.toExponential(2);
  };
  const fmtAlpha = (n: number) => n.toFixed(3);

  stellata.onFrame(() => {
    if (!panel) return;
    const lengths = stellata.hud.getDrawnLengths();
    const dbg = stellata.hud.getDebugSnapshot();
    const shaftStart = stellata.hud.getShaftStartPx();
    const alpha = stellata.getNavigateArrowFadeAlpha();
    const focused = stellata.getFocusedStar();
    const discRadius = focused !== null ? stellata.renderedDiscPxAtPeakDebug(focused) / 2 : 0;
    const refLen = Math.max(lengths.sol, lengths.gc);
    const coverage = refLen > 0 ? Math.max(0, discRadius - shaftStart) / refLen : 0;

    if (alpha < latch.alphaMin) latch.alphaMin = alpha;
    if (alpha > latch.alphaMax) latch.alphaMax = alpha;
    if (lengths.sol > latch.solMax) latch.solMax = lengths.sol;
    if (lengths.gc > latch.gcMax) latch.gcMax = lengths.gc;
    if (discRadius < latch.discMin && discRadius > 0) latch.discMin = discRadius;
    if (discRadius > latch.discMax) latch.discMax = discRadius;
    if (dbg.sol.behindCamera && lengths.sol > latch.solBehindMaxLen) latch.solBehindMaxLen = lengths.sol;
    if (dbg.gc.behindCamera && lengths.gc > latch.gcBehindMaxLen) latch.gcBehindMaxLen = lengths.gc;

    const arrowLine = (label: string, len: number, d: typeof dbg.sol) =>
      `${label}: drawn=${fmt(len)}  ` +
      `${d.behindCamera ? 'BEHIND' : 'in-front'}  ` +
      `dir=${d.dirPath}  ` +
      `shrunk=${d.shrunkToTarget ? 'Y' : 'N'}  ` +
      `α=${fmtAlpha(d.fadeAlpha)}\n` +
      `        projAlong=${fmt(d.projAlong)}  hide?${d.hideRequested ? 'Y' : 'N'}`;

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
    root.style.borderLeft = independentState ? '3px solid #f33' : '3px solid #0f0';
    root.style.paddingLeft = '8px';
  });
}
