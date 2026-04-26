import * as THREE from 'three';
import { GAL_TO_ICRS, GALACTIC_CENTRE_PC } from './galactic-coords';

const MIDPLANE_RADIUS_PC = 15_000;
const THICKNESS_HALF_PC = 400;
const MIDPLANE_SEGMENTS = 128;
const BULGE_RADIUS_PC = 3000;
const BULGE_HALF_THICKNESS_PC = 1500;
const BULGE_SEGMENTS = 64;

// Zoom-based fade range, "distance from Sol" (= ||camera.position +
// worldOffset|| in absolute ICRS pc). Below the inner edge the disc is
// invisible; above the outer edge it's at its full base opacity. Tunable —
// the local high-density regime is well within 500 pc, and Edenhofer's voxel
// grid reaches 1.25 kpc, so by 500 pc the disc is no longer visually noisy.
const FADE_INNER_PC = 500;
const FADE_OUTER_PC = 5000;

// Default colour — warm amber for the dark theme. Chart (mono) mode hides
// the disc entirely rather than swapping the stroke; a 15 kpc reference ring
// reads as visual noise on a paper-chart aesthetic, and the arrows + sphere
// already provide orientation in mono.
const DARK_COLOUR = 0xa08660;

const DARK_BASE_OPACITY = 0.55;

/**
 * Always-on Milky Way disc reference. Three concentric line components live
 * in absolute equatorial space centred on the galactic centre:
 *
 *   1. a 15 kpc radius midplane ring (b=0),
 *   2. two thickness rings offset ±400 pc along the galactic z-axis,
 *   3. a small bulge wireframe at the galactic centre itself.
 *
 * Sol sits ~8 kpc *inside* the disc, so the rendered disc is centred on the
 * GC, not on the camera. The geometry is pre-transformed once (galactic →
 * ICRS via GAL_TO_ICRS, plus the GC offset) and rebased per frame by
 * setting `group.position = -worldOffset`, so under the floating origin the
 * absolute-space vertices project correctly into the renderer's local frame.
 *
 * Opacity smoothsteps from 0 to a base value as the camera pulls away from
 * Sol — invisible during local browsing, gradually revealed as the user
 * zooms out enough to need orientation context. In mono (chart) mode the
 * fade is disabled and the strokes swap to dark, fully-opaque lines for the
 * paper-chart aesthetic.
 */
export class GalacticDisc {
  readonly group: THREE.Group;
  private materials: THREE.LineBasicMaterial[] = [];
  private mono = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.renderOrder = -1;

    const midplane = this.makeRing(
      MIDPLANE_RADIUS_PC,
      MIDPLANE_RADIUS_PC,
      0,
      MIDPLANE_SEGMENTS,
      'xy',
    );
    const thicknessTop = this.makeRing(
      MIDPLANE_RADIUS_PC,
      MIDPLANE_RADIUS_PC,
      THICKNESS_HALF_PC,
      MIDPLANE_SEGMENTS,
      'xy',
    );
    const thicknessBot = this.makeRing(
      MIDPLANE_RADIUS_PC,
      MIDPLANE_RADIUS_PC,
      -THICKNESS_HALF_PC,
      MIDPLANE_SEGMENTS,
      'xy',
    );

    // Bulge: three orthogonal loops in galactic frame, all centred on GC.
    // xy gives the equator of the bulge (circle of radius 3 kpc); xz and yz
    // are the meridians (ellipses 3 kpc × 1.5 kpc thick) so the wireframe
    // reads as an oblate ellipsoid from any angle.
    const bulgeXY = this.makeRing(BULGE_RADIUS_PC, BULGE_RADIUS_PC, 0, BULGE_SEGMENTS, 'xy');
    const bulgeXZ = this.makeRing(BULGE_RADIUS_PC, BULGE_HALF_THICKNESS_PC, 0, BULGE_SEGMENTS, 'xz');
    const bulgeYZ = this.makeRing(BULGE_RADIUS_PC, BULGE_HALF_THICKNESS_PC, 0, BULGE_SEGMENTS, 'yz');

    for (const m of [midplane, thicknessTop, thicknessBot, bulgeXY, bulgeXZ, bulgeYZ]) {
      this.group.add(m);
    }
  }

  /** Per-frame update. Call before render. */
  update(worldOffset: THREE.Vector3, distFromSolPc: number) {
    // Hidden in chart mode entirely — the disc reference is dark-mode only.
    if (this.mono) {
      this.group.visible = false;
      return;
    }

    // Place the group at -worldOffset so absolute-space vertices project to
    // local frame: localVertex = absoluteVertex + group.position
    //                          = absoluteVertex - worldOffset.
    this.group.position.copy(worldOffset).negate();

    const opacity = DARK_BASE_OPACITY * smoothstep(
      FADE_INNER_PC,
      FADE_OUTER_PC,
      distFromSolPc,
    );
    if (opacity <= 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    for (const m of this.materials) m.opacity = opacity;
  }

  setMonochrome(on: boolean) {
    this.mono = on;
  }

  /**
   * Build a closed line loop in the galactic frame, transform to ICRS, and
   * translate by GALACTIC_CENTRE_PC so it lives in absolute equatorial pc.
   * `plane` selects which two galactic axes carry the radial sweep:
   *  - 'xy' → ring lies in the b=0 plane (z held at zOffset)
   *  - 'xz' → meridian in the l=0 plane
   *  - 'yz' → meridian in the l=90 plane
   * For 'xz'/'yz' rings, the secondary axis sweeps to ±radiusB so we can
   * draw oblate ellipses (e.g. the 3 kpc × 1.5 kpc bulge).
   */
  private makeRing(
    radiusA: number,
    radiusB: number,
    zOffset: number,
    segments: number,
    plane: 'xy' | 'xz' | 'yz',
  ): THREE.LineLoop {
    const v = new Float32Array(segments * 3);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const a = Math.cos(t) * radiusA;
      const b = Math.sin(t) * radiusB;
      if (plane === 'xy') tmp.set(a, b, zOffset);
      else if (plane === 'xz') tmp.set(a, 0, b);
      else /* yz */ tmp.set(0, a, b);
      tmp.applyMatrix4(GAL_TO_ICRS).add(GALACTIC_CENTRE_PC);
      v[i * 3 + 0] = tmp.x;
      v[i * 3 + 1] = tmp.y;
      v[i * 3 + 2] = tmp.z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(v, 3));
    // Bounding sphere drawn from the geometry would be huge and miscentred
    // (group origin is offset per frame); turn off frustum culling so the
    // disc never disappears at extreme camera positions.
    const mat = new THREE.LineBasicMaterial({
      color: DARK_COLOUR,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
    });
    this.materials.push(mat);
    const loop = new THREE.LineLoop(geom, mat);
    loop.frustumCulled = false;
    loop.renderOrder = -1;
    return loop;
  }

  dispose() {
    for (const child of this.group.children) {
      const obj = child as THREE.LineLoop;
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
