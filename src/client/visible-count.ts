import type { Stellata } from './stellata';

// Bottom-right HUD: the "N visible" line under the catalog total.
// Settle-debounced — the scan is bounded but not free, and a continuous
// live count is more distraction than feedback during interaction.
//
// Behaviour:
//   - Any per-frame change that materially affects the count resets a
//     settle timer and replaces the count with an em-dash placeholder.
//   - Once SETTLE_MS has passed with no further material change, the
//     scan runs once and the real count appears.
//
// Material-change detection uses small epsilons rather than strict
// `!==`: TrackballControls writes camera.position and camera.quaternion
// every frame and its dynamicDampingFactor leaves residual sub-
// perceptible motion for many seconds after the user releases. Strict
// equality treats that as continuous change and the count never
// resolves; the epsilon thresholds drop the residual below the dirty
// bar within ~1 s.
//
// Inputs the count depends on:
//   - filter knobs we mirror in countVisibleStars: maxAppMag,
//     min/maxDistSol, spectMask
//   - camera pose: position + quaternion (view matrix)
//   - camera projection: fov + aspect (frustum bounds)

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

const SETTLE_MS = 220;
const PLACEHOLDER = '— visible';

// Per-frame deltas below these thresholds count as "not moving."
//   Position: 1e-4 pc per frame ≈ 6e-3 pc/sec at 60 fps — well below
//     anything the user would perceive even at AU-scale focus.
//   Quaternion: squared L2 across components. ‖Δq‖² < 1e-10 ⇒ rotation
//     delta < ~2e-5 rad (~0.001°), imperceptible.
//   FOV: 1e-3°. Aspect snaps on resize so an exact compare is fine.
const POS_EPS_SQ = 1e-4 * 1e-4;
const QUAT_EPS_SQ = 1e-10;
const FOV_EPS = 1e-3;

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

  // Last-frame snapshot. Position+quaternion start at NaN/0 so the
  // first frame's delta is NaN (compares false against epsilons) — we
  // fall through to "no material change", placeholder stays, and the
  // settle clock starts; the scan fires SETTLE_MS later with the real
  // initial camera state.
  let sCamX = NaN, sCamY = NaN, sCamZ = NaN;
  let sQX = NaN, sQY = NaN, sQZ = NaN, sQW = NaN;
  let sFov = NaN, sAspect = NaN;
  let sMaxAppMag = NaN, sMinDistSol = NaN, sMaxDistSol = NaN, sSpectMask = -1;
  let lastChangeMs = performance.now();
  let placeholderShown = true;

  stellata.onFrame(() => {
    const cam = stellata.camera;
    const f = stellata.getFilter();
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    const qx = cam.quaternion.x, qy = cam.quaternion.y, qz = cam.quaternion.z, qw = cam.quaternion.w;
    const fv = cam.fov, asp = cam.aspect;

    const dPx = cx - sCamX, dPy = cy - sCamY, dPz = cz - sCamZ;
    const dPos2 = dPx * dPx + dPy * dPy + dPz * dPz;
    const dQx = qx - sQX, dQy = qy - sQY, dQz = qz - sQZ, dQw = qw - sQW;
    const dQuat2 = dQx * dQx + dQy * dQy + dQz * dQz + dQw * dQw;
    const dFov = Math.abs(fv - sFov);

    const moved = dPos2 > POS_EPS_SQ || dQuat2 > QUAT_EPS_SQ || dFov > FOV_EPS || asp !== sAspect;
    const filterChanged =
      f.maxAppMag !== sMaxAppMag || f.minDistSol !== sMinDistSol ||
      f.maxDistSol !== sMaxDistSol || f.spectMask !== sSpectMask;

    // Snapshot every frame so per-frame deltas measure this-frame vs
    // last-frame, not cumulative drift since the last "real" change.
    sCamX = cx; sCamY = cy; sCamZ = cz;
    sQX = qx; sQY = qy; sQZ = qz; sQW = qw;
    sFov = fv; sAspect = asp;
    sMaxAppMag = f.maxAppMag; sMinDistSol = f.minDistSol;
    sMaxDistSol = f.maxDistSol; sSpectMask = f.spectMask;

    if (moved || filterChanged) {
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
