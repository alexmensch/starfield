// Local Group wireframe layer (stellata-38m).
//
// Renders LineLoop outlines for confirmed-galaxy Local Group members
// within 250 kpc of Sol. Each object's geometry is pre-baked in
// absolute ICRS pc at construction; the group is rebased to
// -worldOffset per frame so the floating origin doesn't drift the
// outlines. Opacity tracks the same FADE_INNER_PC / FADE_OUTER_PC
// curve the MW disc uses (galactic-fade.ts), so the two layers fade
// in lockstep as context overlays rather than disjoint reveals.
//
// Object kinds:
//
//   disc       — Magellanic-style inclined disc. Three LineLoop rings:
//                 the midplane (z=0 in the disc-local frame) and a
//                 thickness pair offset ±c along the disc normal. axes
//                 = (R, R, h) for a circular disc with semi-thickness h.
//   ellipsoid  — Triaxial blob. Three orthogonal meridian LineLoops on
//                 the principal axes — xy, xz, yz — so the silhouette
//                 reads as an ellipsoid from any angle.
//
// Per stellata-pattern-coverage-across-peers, every renderable kind in
// the catalog is exhaustively covered here; a future addition (e.g. a
// shell/torus kind for a circumgalactic component) needs both a JSON
// schema bump and a new branch.
//
// Per-object silhouette samples are precomputed for the label engine
// (createDistanceGatedLabel) — see getAbsSample / sampleCount. The
// label engine subtracts worldOffset from these to project them.

import * as THREE from 'three';
import type { LgCatalog, LgObject } from './local-group-loader';
import { FADE_INNER_PC, FADE_OUTER_PC, smoothstep } from './galactic-fade';
import type { Stellata } from './stellata';
import { createDistanceGatedLabel } from './distance-gated-label';
import { GALACTIC_CENTRE_PC } from './galactic-coords';

const RING_SEGMENTS = 64;

// Sample grid for the silhouette projection that drives label placement.
// 12 longitudes × 5 mid-latitudes + 2 poles = 62 points per object —
// matches heliopause.ts's grid density (the per-frame cost is one
// vec3 transform per sample, negligible at ~10 labelled objects).
const SAMPLE_N_LONGS = 12;
const SAMPLE_N_LATS = 5;

// Default colour — dim chrome family, slightly cooler than the
// galactic-disc amber so the two reference layers read distinctly when
// both fade in past 5 kpc from Sol.
const DARK_COLOUR = 0x8090a8;
const DARK_BASE_OPACITY = 0.45;

/**
 * Renderable Local Group wireframe layer. Constructed once from the
 * catalog; per-frame update only writes the group's floating-origin
 * offset and the shared material's opacity.
 */
export class LocalGroupLayer {
  readonly group: THREE.Group;
  readonly objects: LgObject[];
  private readonly material: THREE.LineBasicMaterial;
  /** Per-object silhouette samples in absolute ICRS pc. Indexed
   *  `absSamples[objectIdx][sampleIdx]`. */
  private readonly absSamples: THREE.Vector3[][];
  private mono = false;

  constructor(catalog: LgCatalog) {
    this.objects = catalog.objects;
    this.group = new THREE.Group();
    // Behind the star pass but in front of the cloud layer (which is
    // shelved for v1.0). renderOrder = -1 matches GalacticDisc; the two
    // are sibling reference overlays.
    this.group.renderOrder = -1;

    this.material = new THREE.LineBasicMaterial({
      color: DARK_COLOUR,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
    });

    this.absSamples = [];
    for (const obj of this.objects) {
      const loops = buildObjectLineLoops(obj, this.material);
      for (const loop of loops) this.group.add(loop);
      this.absSamples.push(buildSilhouetteSamples(obj));
    }
  }

  /** Per-frame update. Call before render.
   *  @param worldOffset absolute-space origin of the renderer frame
   *  @param distFromSolPc ||camera.position + worldOffset|| in absolute pc */
  update(worldOffset: THREE.Vector3, distFromSolPc: number): void {
    if (this.mono) {
      // Chart (mono / paper) mode hides the Local Group wireframes — same
      // policy GalacticDisc + heliopause adopt; chart-mode renders its
      // own paper-aesthetic when stellata-m40 takes this on, currently
      // it does not.
      this.group.visible = false;
      return;
    }
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
    this.material.opacity = opacity;
  }

  setMonochrome(on: boolean): void {
    this.mono = on;
  }

  /** Number of silhouette samples for an object — for the label engine. */
  sampleCount(objectIdx: number): number {
    return this.absSamples[objectIdx].length;
  }

  /** Write sample i (absolute ICRS pc) into `out`. The label engine
   *  subtracts worldOffset to get world-space coords for projection. */
  getAbsSample(objectIdx: number, sampleIdx: number, out: THREE.Vector3): void {
    out.copy(this.absSamples[objectIdx][sampleIdx]);
  }

  dispose(): void {
    for (const child of this.group.children) {
      const obj = child as THREE.LineLoop;
      obj.geometry.dispose();
    }
    this.material.dispose();
  }
}

/** Build the LineLoop rings for one Local Group object. For discs:
 *  midplane + thickness pair. For ellipsoids: three orthogonal
 *  meridians. */
function buildObjectLineLoops(
  obj: LgObject,
  material: THREE.LineBasicMaterial,
): THREE.LineLoop[] {
  const rings: THREE.LineLoop[] = [];
  if (obj.kind === 'disc') {
    // Disc-local frame: a (=axes[0]) and b (=axes[1]) span the disc
    // plane; c (=axes[2]) is the semi-thickness along disc normal.
    // Three rings of radius (a, b) — one at z=0 (midplane), two at
    // z=±c (thickness markers).
    rings.push(makeRing(obj, 'xy', 0, material));
    rings.push(makeRing(obj, 'xy', obj.axes[2], material));
    rings.push(makeRing(obj, 'xy', -obj.axes[2], material));
  } else {
    // Ellipsoid: three orthogonal meridian rings in the local frame.
    rings.push(makeRing(obj, 'xy', 0, material));
    rings.push(makeRing(obj, 'xz', 0, material));
    rings.push(makeRing(obj, 'yz', 0, material));
  }
  return rings;
}

/** Build a single ring as a LineLoop. `plane` selects which two local
 *  axes carry the radial sweep:
 *   - 'xy' → axes[0] × axes[1], offset along local z by zOffset
 *   - 'xz' → axes[0] × axes[2], offset along local y by zOffset
 *   - 'yz' → axes[1] × axes[2], offset along local x by zOffset
 *  Vertices are pre-rotated by the object's quaternion and translated
 *  by centerAbs so the geometry lives in absolute ICRS pc. The group
 *  applies per-frame floating-origin offset. */
function makeRing(
  obj: LgObject,
  plane: 'xy' | 'xz' | 'yz',
  zOffset: number,
  material: THREE.LineBasicMaterial,
): THREE.LineLoop {
  const verts = new Float32Array(RING_SEGMENTS * 3);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const t = (i / RING_SEGMENTS) * Math.PI * 2;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    if (plane === 'xy') tmp.set(obj.axes[0] * ct, obj.axes[1] * st, zOffset);
    else if (plane === 'xz') tmp.set(obj.axes[0] * ct, zOffset, obj.axes[2] * st);
    else /* yz */ tmp.set(zOffset, obj.axes[1] * ct, obj.axes[2] * st);
    tmp.applyQuaternion(obj.quat).add(obj.centerAbs);
    verts[i * 3 + 0] = tmp.x;
    verts[i * 3 + 1] = tmp.y;
    verts[i * 3 + 2] = tmp.z;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  const loop = new THREE.LineLoop(geom, material);
  loop.frustumCulled = false; // group origin offset per frame
  loop.renderOrder = -1;
  return loop;
}

/** Precompute silhouette sample points in absolute ICRS pc for one
 *  object — enough density that the label engine's support-point
 *  search lands on a tight bbox curve as the camera orbits. Same grid
 *  shape as heliopause.ts's: 12 longitudes × 5 mid-latitudes + 2 poles.
 *  Cost is 62 vec3 transforms once at construction. */
function buildSilhouetteSamples(obj: LgObject): THREE.Vector3[] {
  const samples: THREE.Vector3[] = [];
  const a = obj.axes[0];
  const b = obj.axes[1];
  const c = obj.axes[2];
  const push = (lx: number, ly: number, lz: number): void => {
    const v = new THREE.Vector3(lx, ly, lz)
      .applyQuaternion(obj.quat)
      .add(obj.centerAbs);
    samples.push(v);
  };
  for (let i = 0; i < SAMPLE_N_LATS; i++) {
    const theta = ((i + 0.5) / SAMPLE_N_LATS) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let j = 0; j < SAMPLE_N_LONGS; j++) {
      const phi = (j / SAMPLE_N_LONGS) * 2 * Math.PI;
      push(a * sinT * Math.cos(phi), b * sinT * Math.sin(phi), c * cosT);
    }
  }
  push(0, 0, c);
  push(0, 0, -c);
  return samples;
}

// Label distance threshold for the Milky Way label — camera-to-galactic-
// centre distance past which the SVG "Milky Way" tag fades in. The MW
// disc itself starts revealing at FADE_INNER_PC (500 pc from Sol); the
// label lights up only once the camera is outside the disc plane far
// enough to read the disc as a whole structure. Coupled to the bead's
// ~10 kpc spec.
const MW_LABEL_THRESHOLD_PC = 10_000;

// Bottom-right SVG anchor direction (1, 1)/√2 in CSS y-down coords.
// Matches heliopause's choice so the label-anchor family reads
// consistently across context overlays.
const LABEL_DIR = { x: Math.SQRT1_2, y: Math.SQRT1_2 };

// Constant 10 px gap from silhouette support point to label anchor —
// same as planet labels + heliopause for visual continuity.
const LABEL_OFFSET_PX = 10;

// Settles in ~4-5 frames at 60 fps (~70 ms).
const LABEL_LERP = 0.25;

/** Mount the SVG "Milky Way" label and bind per-frame projection.
 *  Anchored to GALACTIC_CENTRE_PC (a single sample point); fades in
 *  once the camera sits past MW_LABEL_THRESHOLD_PC from the galactic
 *  centre. Hidden in chart (monochrome) mode — chart-mode has its own
 *  paper-aesthetic treatment for galactic structure when stellata-m40
 *  covers it. */
export function createMilkyWayLabel(stellata: Stellata): void {
  const sampleAbs = GALACTIC_CENTRE_PC; // absolute ICRS pc
  const tmpCam = new THREE.Vector3();
  createDistanceGatedLabel(stellata, {
    elementId: 'mw-label',
    sampleCount: 1,
    getWorldSample: (_, out) => out.copy(sampleAbs).sub(stellata.getWorldOffset()),
    visible: () => {
      if (stellata.getMonochrome()) return false;
      // camera-to-GC distance in absolute pc = ||camera.position +
      // worldOffset - GALACTIC_CENTRE_PC||.
      const w = stellata.getWorldOffset();
      const c = stellata.camera.position;
      tmpCam.set(c.x + w.x - sampleAbs.x, c.y + w.y - sampleAbs.y, c.z + w.z - sampleAbs.z);
      return tmpCam.length() >= MW_LABEL_THRESHOLD_PC;
    },
    labelDir: LABEL_DIR,
    offsetPx: LABEL_OFFSET_PX,
    lerp: LABEL_LERP,
  });
}

/** Mount per-object SVG labels for the labelled Local Group members
 *  (those with non-null labelThresholdPc). Mints one `<text>` under
 *  the `#lg-labels` group per labelled object and binds it to the
 *  distance-gated label engine with the object's silhouette samples
 *  as the projection input + camera-to-object-centre distance as the
 *  visibility predicate. */
export function createLocalGroupLabels(
  stellata: Stellata,
  layer: LocalGroupLayer,
): void {
  const group = document.getElementById('lg-labels') as unknown as SVGGElement | null;
  if (!group) return;
  // Camera scratch for the per-object visibility predicate.
  const tmpCam = new THREE.Vector3();
  for (let i = 0; i < layer.objects.length; i++) {
    const obj = layer.objects[i];
    const threshold = obj.labelThresholdPc;
    if (threshold === null) continue;
    const elementId = `lg-${obj.id}-label`;
    // Mint the SVG <text> element. innerHTML escape is unnecessary
    // since both id and name come from our own build-time output
    // (object names are real catalogue entries, no user input).
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('id', elementId);
    text.setAttribute('class', 'lg-label');
    text.setAttribute('text-anchor', 'start');
    text.setAttribute('dominant-baseline', 'hanging');
    text.textContent = obj.name;
    group.appendChild(text);

    const idx = i;
    createDistanceGatedLabel(stellata, {
      elementId,
      sampleCount: layer.sampleCount(idx),
      getWorldSample: (j, out) => {
        layer.getAbsSample(idx, j, out);
        out.sub(stellata.getWorldOffset());
      },
      visible: () => {
        if (stellata.getMonochrome()) return false;
        const w = stellata.getWorldOffset();
        const c = stellata.camera.position;
        // camera-to-object-centre in absolute pc.
        tmpCam.set(
          c.x + w.x - obj.centerAbs.x,
          c.y + w.y - obj.centerAbs.y,
          c.z + w.z - obj.centerAbs.z,
        );
        return tmpCam.length() >= threshold;
      },
      labelDir: LABEL_DIR,
      offsetPx: LABEL_OFFSET_PX,
      lerp: LABEL_LERP,
    });
  }
}
