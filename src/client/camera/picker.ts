// Per-layer pick paths. Click picks (pickStar / pickCloud) return raw
// catalog indices; hover picks (pickStarHit / pickCloudHit / etc.)
// return HoverHit so the cross-provider disambiguator can rank without
// re-projecting.
//
// Hover visibility mirrors the renderer's own draw predicates exactly
// (visibility ⇒ hoverable). Click pickers keep an extra warp gate
// (pickCloud returns null mid-warp).

import * as THREE from 'three';
import type { Catalog } from '../loaders/catalog-loader';
import type { FilterState } from '../stellata';
import type { MolecularClouds } from '../molecular-clouds/molecular-clouds';
import type { LocalGroupLayer } from '../local-group/local-group';
import type { PlanetBodyField } from '../solar-system/planet-body-field';
import {
  Heliopause,
  HELIOPAUSE_APEX_LOCAL_PC,
  HELIOPAUSE_LABEL_ELEMENT_ID,
  HELIOPAUSE_SAMPLE_POINTS_LOCAL,
} from '../solar-system/heliopause';
import { DCAM_LOG_FLOOR_PC } from './timing';
import {
  MIN_DISC_HIT_RADIUS_PX,
  pickFromCandidates,
  pickScore,
  sortedDistRange,
  type PickResult,
  type StarPickCandidate,
} from './star-geometry';
import type { HoverHit } from '../hover/hover-types';

export interface PickerDeps {
  domElement: HTMLElement;
  camera: THREE.PerspectiveCamera;
  catalog: Catalog;
  sortedByDistFromSol: Uint32Array;
  sortedDistFromSol: Float32Array;
  // The local-frame star position buffer lives on Stellata and is
  // shifted in-place on floating-origin recentre, so the getter returns
  // the live Float32Array rather than a snapshot reference.
  getLocalPositions: () => Float32Array;
  getFilter: () => Readonly<FilterState>;
  getClouds: () => MolecularClouds | null;
  getLocalGroupLayer: () => LocalGroupLayer | null;
  getHeliopause: () => Heliopause;
  getPlanetBodyField: () => PlanetBodyField;
  // Floating-origin offset — picks for objects in absolute (catalog)
  // space (clouds, Local Group) need to project into the local frame
  // the camera lives in. Read each call; recentre mutates it in-place.
  getWorldOffset: () => Readonly<THREE.Vector3>;
  getWarpActive: () => boolean;
  // Star disc pixel diameter for the prime-tier hit radius. Threaded
  // as a callback so Picker stays decoupled from material uniforms.
  renderedSizePxFn: (idx: number) => number;
  // Currently unused by Picker — held on the deps struct for the
  // eventual hand-off when Picker computes physSizePx itself.
  fovYRadRef: { value: number };
  viewportRef: { value: THREE.Vector2 };
}

export class Picker {
  private readonly deps: PickerDeps;

  // Per-instance scratch state. Reused per call to avoid re-allocating
  // Three.js objects on the hot pick path.
  private readonly cloudRaycaster = new THREE.Raycaster();
  private readonly tmpNdc = new THREE.Vector2();
  private readonly tmpV3 = new THREE.Vector3();

  constructor(deps: PickerDeps) {
    this.deps = deps;
  }

  // ─── Click picks ──────────────────────────────────────────────────

  /** Pick a star under the cursor for the click FSM. Returns the
   *  winning catalog index or -1 if no star is hit. */
  pickStar(clientX: number, clientY: number, pixelThreshold = 16): number {
    return this.pickStarResult(clientX, clientY, pixelThreshold)?.candidate.idx ?? -1;
  }

  /** Hit-test a screen-space cursor against the cloud layer. Returns
   *  the cloud index of the nearest hit, or null if no cloud is under
   *  the cursor. Always returns null when the layer is hidden by the
   *  toggle or warping. */
  pickCloud(clientX: number, clientY: number): number | null {
    const clouds = this.deps.getClouds();
    if (!clouds || this.deps.getWarpActive()) return null;
    const rect = this.deps.domElement.getBoundingClientRect();
    const ndc = this.tmpNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.cloudRaycaster.setFromCamera(ndc, this.deps.camera);
    return clouds.raycast(this.cloudRaycaster);
  }

  // ─── Hover picks ──────────────────────────────────────────────────

  pickStarHit(clientX: number, clientY: number, pixelThreshold = 14): HoverHit | null {
    const r = this.pickStarResult(clientX, clientY, pixelThreshold);
    if (r === null) return null;
    return {
      idx: r.candidate.idx,
      cameraDistancePc: r.candidate.cameraDistancePc,
      tier: r.tier,
    };
  }

  pickPlanetHit(clientX: number, clientY: number, pixelThreshold = 14): HoverHit | null {
    const rect = this.deps.domElement.getBoundingClientRect();
    return this.deps.getPlanetBodyField().pick(
      this.deps.camera,
      rect,
      clientX,
      clientY,
      pixelThreshold,
    );
  }

  // Returns null when the LG layer isn't attached (fresh checkout
  // without the build artifact).
  pickLocalGroupHit(clientX: number, clientY: number, pixelThreshold = 14): HoverHit | null {
    const lg = this.deps.getLocalGroupLayer();
    if (!lg) return null;
    const rect = this.deps.domElement.getBoundingClientRect();
    return lg.pick(
      this.deps.camera,
      this.deps.getWorldOffset() as THREE.Vector3,
      rect,
      clientX,
      clientY,
      pixelThreshold,
    );
  }

  // Fallback-only tier (extended shell, no rendered disc). Hit surface
  // is the projected ellipsoid silhouette OR the apex SVG label rect.
  // Inside-shell branch (camera within ellipsoid): any sample behind
  // the near plane bails the silhouette test, but the label test still
  // fires via getBoundingClientRect (zero bounds when display:none, so
  // the inside-bbox check harmlessly fails when the label is hidden).
  pickHeliopauseHit(clientX: number, clientY: number, _pixelThreshold = 14): HoverHit | null {
    const heliopause = this.deps.getHeliopause();
    if (!heliopause.isVisible()) return null;
    const camera = this.deps.camera;
    const rect = this.deps.domElement.getBoundingClientRect();
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;

    // Silhouette bbox: project all sample points to screen-space.
    // Bail (allInFront=false) if any sample is behind the near plane —
    // matches the label engine's exact predicate so the silhouette is
    // hoverable iff it's also drawn.
    let allInFront = true;
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    const tmp = this.tmpV3;
    const nearNeg = -camera.near;
    for (const sample of HELIOPAUSE_SAMPLE_POINTS_LOCAL) {
      tmp.copy(sample);
      tmp.applyMatrix4(camera.matrixWorldInverse);
      if (tmp.z >= nearNeg) { allInFront = false; break; }
      tmp.applyMatrix4(camera.projectionMatrix);
      const sx = (tmp.x + 1) * 0.5 * rect.width;
      const sy = (1 - tmp.y) * 0.5 * rect.height;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
    const insideSilhouette = allInFront
      && cursorX >= minX && cursorX <= maxX
      && cursorY >= minY && cursorY <= maxY;

    // Label bbox: getBoundingClientRect returns all-zero bounds for a
    // `display: none` element, so this test harmlessly fails whenever
    // the label engine has hidden the label (orbit-ring fade, chart
    // mode, near-plane guard).
    let insideLabel = false;
    const labelEl = document.getElementById(HELIOPAUSE_LABEL_ELEMENT_ID);
    if (labelEl) {
      const lr = labelEl.getBoundingClientRect();
      if (lr.width > 0 && lr.height > 0) {
        insideLabel = clientX >= lr.left && clientX <= lr.right
          && clientY >= lr.top && clientY <= lr.bottom;
      }
    }

    if (!insideSilhouette && !insideLabel) return null;

    const cam = camera.position;
    const apex = HELIOPAUSE_APEX_LOCAL_PC;
    const dx = apex.x - cam.x;
    const dy = apex.y - cam.y;
    const dz = apex.z - cam.z;
    const cameraDistancePc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return { idx: 0, cameraDistancePc, tier: 'fallback' };
  }

  // Fallback-only tier. Decoupled from warp state (the click-focus
  // pickCloud keeps its warp gate; hover doesn't need one).
  pickCloudHit(clientX: number, clientY: number, _pixelThreshold = 14): HoverHit | null {
    const clouds = this.deps.getClouds();
    if (!clouds || !clouds.group.visible) return null;
    const rect = this.deps.domElement.getBoundingClientRect();
    const ndc = this.tmpNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.cloudRaycaster.setFromCamera(ndc, this.deps.camera);
    const idx = clouds.raycast(this.cloudRaycaster);
    if (idx === null) return null;

    const cloud = clouds.clouds[idx];
    const cam = this.deps.camera.position;
    const worldOffset = this.deps.getWorldOffset();
    const cx = cloud.centerAbs.x - worldOffset.x - cam.x;
    const cy = cloud.centerAbs.y - worldOffset.y - cam.y;
    const cz = cloud.centerAbs.z - worldOffset.z - cam.z;
    const cameraDistancePc = Math.sqrt(cx * cx + cy * cy + cz * cz);
    return { idx, cameraDistancePc, tier: 'fallback' };
  }

  // ─── Internal ─────────────────────────────────────────────────────

  // Two-tier star pick (project + filter + collect; reducer in
  // star-geometry.ts). Camera distance is deliberately ignored — see
  // pickScore for the rationale.
  private pickStarResult(
    clientX: number,
    clientY: number,
    pixelThreshold: number,
  ): PickResult<StarPickCandidate> | null {
    const { camera, catalog } = this.deps;
    const rect = this.deps.domElement.getBoundingClientRect();
    const viewportW = rect.width;
    const viewportH = rect.height;
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;

    const camPos = camera.position;
    // Local-frame positions drive camera-relative math and screen projection
    // (the camera lives in local frame under the floating origin). distSol
    // values are precomputed in sortedDistFromSol — no per-star sqrt needed.
    const locPos = this.deps.getLocalPositions();
    const { absmag, spectClass, amplitudeMag, periodDays } = catalog;
    const f = this.deps.getFilter();
    const v = new THREE.Vector3();

    // Window the scan to the slice of sortedDistFromSol that lies inside
    // the user's [minDistSol, maxDistSol] band. Skips out-of-band stars
    // without computing per-star sqrt(x²+y²+z²); also collapses the
    // catalog to the visible distance window when the user has narrowed
    // the slider.
    const sortedIdx = this.deps.sortedByDistFromSol;
    const { start, end } = sortedDistRange(this.deps.sortedDistFromSol, f.minDistSol, f.maxDistSol);

    const candidates: StarPickCandidate[] = [];
    for (let k = start; k < end; k++) {
      const i = sortedIdx[k];
      const bit = 1 << (spectClass[i] | 0);
      if (!(f.spectMask & bit)) continue;
      const x = locPos[i * 3 + 0];
      const y = locPos[i * 3 + 1];
      const z = locPos[i * 3 + 2];
      const dx = x - camPos.x;
      const dy = y - camPos.y;
      const dz = z - camPos.z;
      const dCam = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), DCAM_LOG_FLOOR_PC);
      const appMag = absmag[i] + 5 * (Math.log10(dCam) - 1);
      // For variables, use the bright-extreme appMag so a star whose
      // disc is only visible at peak phase remains pickable across the
      // whole cycle. Without this, a variable with static appMag just
      // above the limit gets dropped here even though the GPU shows
      // its disc whenever magMod swings negative.
      const amp = periodDays[i] > 0 ? amplitudeMag[i] : 0;
      const filterMag = appMag - amp * 0.5;
      if (filterMag > f.maxAppMag) continue;

      v.set(x, y, z).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const screenX = (v.x + 1) * 0.5 * viewportW;
      const screenY = (1 - v.y) * 0.5 * viewportH;
      const pxDist = Math.hypot(cursorX - screenX, cursorY - screenY);
      const pxSize = this.deps.renderedSizePxFn(i);
      const hitRadius = Math.max(pxSize * 0.5, MIN_DISC_HIT_RADIUS_PX);
      // Prune to candidates that could win in either tier; the reducer
      // re-checks tier eligibility, this is just to keep the array tiny.
      if (pxDist > hitRadius && pxDist > pixelThreshold) continue;
      candidates.push({ idx: i, pxDist, hitRadius, appMag, cameraDistancePc: dCam });
    }
    return pickFromCandidates(
      candidates,
      pixelThreshold,
      (c) => pickScore(c.pxDist, c.appMag),
    );
  }
}
