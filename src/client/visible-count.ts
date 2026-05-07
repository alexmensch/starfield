import type { Stellata } from './stellata';

// Bottom-right HUD: the per-frame-throttled counter that drives the
// "N visible" line under the catalog total. The scan iterates the full
// catalog (~313k stars) so we want to avoid running it when nothing
// that affects the count has changed since the last scan — a dirty-
// check gate beats a naive 10 Hz tick on idle (cost goes to zero) and
// matches it during interaction (camera moves every frame anyway, so
// dirty fires every frame and the throttle bounds it).
//
// "Anything that affects the count":
//   - filter knobs we mirror in countVisibleStars: maxAppMag,
//     min/maxDistSol, spectMask
//   - camera pose: position + quaternion (view matrix)
//   - camera projection: fov + aspect (frustum bounds)
//
// uTime / variable pulsation is deliberately excluded — countVisible-
// Stars treats variables at static appMag.

export interface VisibleCountStats {
  /** Last computed value displayed in the HUD. */
  count: number;
  /** Most recent scan duration in milliseconds. */
  lastMs: number;
  /** Cumulative scan time. */
  totalMs: number;
  /** Number of scans run since binding. */
  scans: number;
  /** Number of frames where the dirty check skipped the scan. */
  skipped: number;
  /** Average ms per scan (totalMs / scans). */
  avgMs(): number;
  /** Reset cumulative counters (lastMs survives). */
  reset(): void;
}

/** Minimum gap between scans even if dirty. The scan is bounded but
 *  not free; 100 ms (~10 Hz) is faster than the eye reads numbers. */
const SCAN_THROTTLE_MS = 100;

export function bindVisibleStarCount(stellata: Stellata, mount: HTMLElement): VisibleCountStats {
  const div = document.createElement('div');
  div.className = 'meta-visible';
  mount.appendChild(div);

  const stats: VisibleCountStats = {
    count: -1,
    lastMs: 0,
    totalMs: 0,
    scans: 0,
    skipped: 0,
    avgMs: () => (stats.scans > 0 ? stats.totalMs / stats.scans : 0),
    reset: () => {
      stats.totalMs = 0;
      stats.scans = 0;
      stats.skipped = 0;
    },
  };

  // Snapshot of every input the count depends on. NaN-init forces the
  // first tick to scan regardless of starting state.
  let sCamX = NaN, sCamY = NaN, sCamZ = NaN;
  let sQX = 0, sQY = 0, sQZ = 0, sQW = 0;
  let sFov = 0, sAspect = 0;
  let sMaxAppMag = NaN, sMinDistSol = NaN, sMaxDistSol = NaN, sSpectMask = -1;
  let lastScanMs = 0;

  stellata.onFrame(() => {
    const now = performance.now();
    if (now - lastScanMs < SCAN_THROTTLE_MS) {
      stats.skipped++;
      return;
    }
    const cam = stellata.camera;
    const f = stellata.getFilter();
    const dirty =
      cam.position.x !== sCamX || cam.position.y !== sCamY || cam.position.z !== sCamZ ||
      cam.quaternion.x !== sQX || cam.quaternion.y !== sQY || cam.quaternion.z !== sQZ || cam.quaternion.w !== sQW ||
      cam.fov !== sFov || cam.aspect !== sAspect ||
      f.maxAppMag !== sMaxAppMag || f.minDistSol !== sMinDistSol || f.maxDistSol !== sMaxDistSol || f.spectMask !== sSpectMask;
    if (!dirty) {
      stats.skipped++;
      return;
    }
    sCamX = cam.position.x; sCamY = cam.position.y; sCamZ = cam.position.z;
    sQX = cam.quaternion.x; sQY = cam.quaternion.y; sQZ = cam.quaternion.z; sQW = cam.quaternion.w;
    sFov = cam.fov; sAspect = cam.aspect;
    sMaxAppMag = f.maxAppMag; sMinDistSol = f.minDistSol; sMaxDistSol = f.maxDistSol; sSpectMask = f.spectMask;

    const t0 = performance.now();
    const n = stellata.countVisibleStars();
    const dt = performance.now() - t0;
    lastScanMs = now;
    stats.lastMs = dt;
    stats.totalMs += dt;
    stats.scans++;
    if (n !== stats.count) {
      stats.count = n;
      div.textContent = `${n.toLocaleString()} visible`;
    }
  });

  return stats;
}
