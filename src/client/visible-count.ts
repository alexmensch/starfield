import type { Stellata } from './stellata';

// Bottom-right HUD: the "N visible" line under the catalog total.
// Settle-debounced — the scan is bounded but not free (a clip-space
// projection per surviving star), and a continuous live count is more
// distraction than feedback during interaction. Behaviour:
//
//   - Any per-frame change to an input that affects the count resets
//     a settle timer and replaces the count with an em-dash placeholder.
//   - Once SETTLE_MS has passed with no further change, the scan runs
//     once and the real count appears.
//
// Inputs the count depends on:
//   - filter knobs we mirror in countVisibleStars: maxAppMag,
//     min/maxDistSol, spectMask
//   - camera pose: position + quaternion (view matrix)
//   - camera projection: fov + aspect (frustum bounds)
//
// uTime / variable pulsation is deliberately excluded — count-
// VisibleStars treats variables at static appMag.

export interface VisibleCountStats {
  /** Last computed value displayed in the HUD, or -1 while settling. */
  count: number;
  /** Most recent scan duration in milliseconds. */
  lastMs: number;
  /** Cumulative scan time. */
  totalMs: number;
  /** Number of scans run since binding. */
  scans: number;
  /** Average ms per scan (totalMs / scans). */
  avgMs(): number;
  /** Reset cumulative counters (lastMs survives). */
  reset(): void;
}

/** How long the inputs must be unchanged before we run a scan. Chosen
 *  so a quick magnitude-slider drag or continuous orbit gesture stays
 *  on the placeholder until the user lets go, while a single rotation
 *  or click resolves to a number quickly enough to feel snappy. */
const SETTLE_MS = 220;
const PLACEHOLDER = '— visible';

export function bindVisibleStarCount(stellata: Stellata, mount: HTMLElement): VisibleCountStats {
  const div = document.createElement('div');
  div.className = 'meta-visible';
  div.textContent = PLACEHOLDER;
  mount.appendChild(div);

  const stats: VisibleCountStats = {
    count: -1,
    lastMs: 0,
    totalMs: 0,
    scans: 0,
    avgMs: () => (stats.scans > 0 ? stats.totalMs / stats.scans : 0),
    reset: () => {
      stats.totalMs = 0;
      stats.scans = 0;
    },
  };

  // Snapshot of every input the count depends on. NaN-init so the
  // first tick always counts as "changed" and starts the settle clock.
  let sCamX = NaN, sCamY = NaN, sCamZ = NaN;
  let sQX = 0, sQY = 0, sQZ = 0, sQW = 0;
  let sFov = 0, sAspect = 0;
  let sMaxAppMag = NaN, sMinDistSol = NaN, sMaxDistSol = NaN, sSpectMask = -1;
  let lastChangeMs = performance.now();
  // True until we've completed a scan for the current settled state;
  // flips back to true the moment any input changes.
  let placeholderShown = true;

  stellata.onFrame(() => {
    const cam = stellata.camera;
    const f = stellata.getFilter();
    const changed =
      cam.position.x !== sCamX || cam.position.y !== sCamY || cam.position.z !== sCamZ ||
      cam.quaternion.x !== sQX || cam.quaternion.y !== sQY || cam.quaternion.z !== sQZ || cam.quaternion.w !== sQW ||
      cam.fov !== sFov || cam.aspect !== sAspect ||
      f.maxAppMag !== sMaxAppMag || f.minDistSol !== sMinDistSol || f.maxDistSol !== sMaxDistSol || f.spectMask !== sSpectMask;

    if (changed) {
      sCamX = cam.position.x; sCamY = cam.position.y; sCamZ = cam.position.z;
      sQX = cam.quaternion.x; sQY = cam.quaternion.y; sQZ = cam.quaternion.z; sQW = cam.quaternion.w;
      sFov = cam.fov; sAspect = cam.aspect;
      sMaxAppMag = f.maxAppMag; sMinDistSol = f.minDistSol; sMaxDistSol = f.maxDistSol; sSpectMask = f.spectMask;
      lastChangeMs = performance.now();
      if (!placeholderShown) {
        div.textContent = PLACEHOLDER;
        placeholderShown = true;
        stats.count = -1;
      }
      return;
    }

    if (!placeholderShown) return;
    if (performance.now() - lastChangeMs < SETTLE_MS) return;

    const t0 = performance.now();
    const n = stellata.countVisibleStars();
    const dt = performance.now() - t0;
    stats.lastMs = dt;
    stats.totalMs += dt;
    stats.scans++;
    stats.count = n;
    div.textContent = `${n.toLocaleString()} visible`;
    placeholderShown = false;
  });

  return stats;
}
