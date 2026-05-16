// Per-frame SVG label anchored to a 3D object's projected silhouette,
// with a per-target visibility predicate that gates "is this label
// worth showing right now?". Factored out of the heliopause label
// (originally at heliopause.ts:217-315 before this lift); the Local
// Group wireframe layer reuses it for the Milky Way label + per-object
// dwarf-galaxy labels, with the predicate switched from "any orbit
// ring visible" (heliopause) to "camera-to-object distance past
// threshold" (Local Group / MW).
//
// Per stellata-named-constants-and-dry rule 2, "schemas / structures
// / functions that are mostly-identical share a builder" — the
// heliopause and Local Group label families differ only in their
// sample geometry and visibility predicate, so they share this builder
// rather than copy-paste with attribution.

import * as THREE from 'three';
import type { Stellata } from './stellata';

export interface DistanceGatedLabelOptions {
  /** ID of the existing SVG <text> element the label binds to. */
  elementId: string;
  /** Number of silhouette samples to project per frame. */
  sampleCount: number;
  /** Fill `out` with sample i's *world-space* position (the renderer's
   *  post-worldOffset frame). For Sol-anchored static geometry like the
   *  heliopause this is a direct array lookup since Sol is the focus
   *  whenever the label can show. For absolute-ICRS geometry (MW
   *  galactic centre, Local Group objects) the implementer subtracts
   *  `stellata.getWorldOffset()` from the absolute position. */
  getWorldSample: (i: number, out: THREE.Vector3) => void;
  /** Per-frame visibility predicate. Returning false hides the label
   *  AND resets the screen-position smoothing so the next show snaps
   *  to the new target instead of sliding from the last visible pose. */
  visible: () => boolean;
  /** Screen-space unit vector the label sits along from the silhouette
   *  support point. (1/√2, 1/√2) = bottom-right in CSS y-down coords;
   *  (-1/√2, -1/√2) = top-left. The support point is the sample whose
   *  screen projection sits furthest along this direction, so the
   *  label hugs the silhouette in a stable direction regardless of
   *  camera orbit (a bbox-corner placement would give a gap that
   *  varies because the ellipse curves inward from the corner). */
  labelDir: { x: number; y: number };
  /** Pixel gap between silhouette support point and label anchor. */
  offsetPx: number;
  /** Per-frame screen-position smoothing factor in [0, 1]. The support
   *  point switches abruptly between neighbouring samples as the camera
   *  rotates; per-frame lerp turns those discrete jumps into a smooth
   *  chase. 0.25 settles in ~4-5 frames (~70 ms at 60 fps). */
  lerp: number;
}

export function createDistanceGatedLabel(
  stellata: Stellata,
  opts: DistanceGatedLabelOptions,
): void {
  const text = document.getElementById(opts.elementId) as unknown as SVGTextElement | null;
  if (!text) return;

  const tmp = new THREE.Vector3();
  // Poison sentinel — `null` disagrees with both true and false so the
  // first setVisible() call always writes through. Without this, an SVG
  // element with no `display: none` in markup is treated as visible by
  // default and the first hide call doesn't paint until something else
  // forces a write (stellata-8ee).
  let visible: boolean | null = null;
  let smoothedX: number | null = null;
  let smoothedY: number | null = null;
  const setVisible = (on: boolean): void => {
    if (on === visible) return;
    text.style.display = on ? '' : 'none';
    visible = on;
    if (!on) {
      smoothedX = null;
      smoothedY = null;
    }
  };
  setVisible(false);

  stellata.on('frame', () => {
    if (!opts.visible()) {
      setVisible(false);
      return;
    }
    const camera = stellata.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Find the silhouette's support point in `labelDir`: the surface
    // sample whose screen projection sits furthest along that direction.
    // The label then anchors at support + offsetPx · labelDir, giving a
    // constant gap from the silhouette curve regardless of camera angle.
    // (Bbox-corner placement gives a varying gap because the silhouette
    // curve falls inside the bbox corner — for a circle the corner is
    // √2·r from centre while the curve is at r, so the gap balloons by
    // ~41% relative to a true tangent offset.)
    let bestProj = -Infinity;
    let bestX = 0, bestY = 0;
    for (let i = 0; i < opts.sampleCount; i++) {
      opts.getWorldSample(i, tmp);
      tmp.applyMatrix4(camera.matrixWorldInverse);
      // Any sample behind the near plane means the geometry straddles
      // the camera (user inside or partially inside the silhouette);
      // the projection wraps around in that regime, so bail.
      if (tmp.z >= -camera.near) {
        setVisible(false);
        return;
      }
      tmp.applyMatrix4(camera.projectionMatrix);
      const sx = (tmp.x + 1) * 0.5 * w;
      const sy = (1 - tmp.y) * 0.5 * h;
      const proj = sx * opts.labelDir.x + sy * opts.labelDir.y;
      if (proj > bestProj) {
        bestProj = proj;
        bestX = sx;
        bestY = sy;
      }
    }
    const targetX = bestX + opts.offsetPx * opts.labelDir.x;
    const targetY = bestY + opts.offsetPx * opts.labelDir.y;
    if (smoothedX === null || smoothedY === null) {
      // First visible frame after a hide (or on init) — snap.
      smoothedX = targetX;
      smoothedY = targetY;
    } else {
      smoothedX += (targetX - smoothedX) * opts.lerp;
      smoothedY += (targetY - smoothedY) * opts.lerp;
    }
    setVisible(true);
    text.setAttribute('x', smoothedX.toFixed(1));
    text.setAttribute('y', smoothedY.toFixed(1));
  });
}
