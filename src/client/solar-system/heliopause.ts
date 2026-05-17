// Heliopause boundary (stellata-3re.5).
//
// Asymmetric ellipsoid wireframe centred on Sol — upwind boundary at
// 122 AU (Voyager 1 crossing 2012-08-25), flanks at 115 AU (Voyager 2
// crossing 2018-11-05), heliotail at 200 AU (IBEX/Cassini ENA estimate).
// Apex direction: solar apex of motion through the local interstellar
// medium, ICRS RA 17h53m, Dec +27.4° per Frisch & Slavin (2013).
//
// Construction: unit sphere → ShaderMaterial with Fresnel limb
// darkening (alpha peaks at the silhouette where the view ray grazes
// the surface, drops toward `FACE_ON_FLOOR` at the apex) → scale to
// (115, 115, 161) AU → translate centre by 39 AU toward antiapex →
// rotate +Z onto antiapex in ICRS. Result: upwind apex lands at
// +122 AU along apex; downwind at -200 AU along apex.
//
// Front-side rendering: the camera sees the near hemisphere's front
// faces from outside, and back-face culling hides the entire shell
// when the camera sits inside (Sol focus, zoomed in). The shell only
// reads as a 3D volume from the outside — by design, since from
// inside there's nothing geometrically informative to show anyway.
//
// Static geometry — no `t` dependence on human timescales. Visibility
// gated on focused star = Sol (the only planet-bearing host in v1).
// Mesh + apex label live here; main.ts wires the SVG label via
// `createHeliopauseLabel`.

import * as THREE from 'three';
import type { Stellata } from '../stellata';
import { AU_PC } from './astronomy-constants';
import { LABEL_OFFSET_PX } from './planet-labels';
import { createDistanceGatedLabel } from '../ui/distance-gated-label';
import heliopauseVert from '../shaders/heliopause.vert.glsl?raw';
import heliopauseFrag from '../shaders/heliopause.frag.glsl?raw';

// Solar apex (upwind) direction in ICRS Cartesian. Pure unit vector.
const APEX_RA_RAD = (17 + 53 / 60) * 15 * Math.PI / 180; // 268.25°
const APEX_DEC_RAD = 27.4 * Math.PI / 180;
const APEX_DIR_ICRS = new THREE.Vector3(
  Math.cos(APEX_DEC_RAD) * Math.cos(APEX_RA_RAD),
  Math.cos(APEX_DEC_RAD) * Math.sin(APEX_RA_RAD),
  Math.sin(APEX_DEC_RAD),
).normalize();

// Ellipsoid geometry (AU). 115 / 115 / 161 with the centre offset
// 39 AU toward antiapex lands the upwind boundary at 122 AU and the
// downwind at 200 AU (115 + 39 + … wait, 161 + 39 = 200 ✓).
const SEMI_EQUATORIAL_AU = 115;
const SEMI_MAJOR_AU = 161;
const CENTRE_OFFSET_AU = 39;
const UPWIND_APEX_AU = SEMI_MAJOR_AU - CENTRE_OFFSET_AU; // 122

// Sphere tessellation. 64 longitudes × 32 latitudes — silhouette reads
// smooth at any zoom we afford. Cost is negligible (one mesh, one
// draw call), so there's no reason to ride a tighter budget here.
const SPHERE_W_SEGMENTS = 64;
const SPHERE_H_SEGMENTS = 32;

// Same dim chrome family as the per-planet orbit rings (3re.7) so the
// solar-system layer reads as a single coherent visual layer. Limb
// (silhouette) alpha is the peak; face-on geometry receives only a
// small fraction of it so the upwind apex region doesn't paint the
// shell as a flat disc against the starfield.
const COLOUR = new THREE.Color(0xc8d6ff);
const ALPHA_LIMB = 0.45;
const FACE_ON_FLOOR = 0.04;
const FRESNEL_POWER = 2.5;

/** Upwind apex point in the Sol-anchored local frame (parsecs). The
 *  label overlay reads this to project the "Heliopause" tag to screen.
 *  Valid only while Sol is the focused star — under floating-origin,
 *  world origin sits at the focal star's absolute position, and the
 *  heliopause renders only when that star is Sol. */
export const HELIOPAUSE_APEX_LOCAL_PC: Readonly<THREE.Vector3> =
  APEX_DIR_ICRS.clone().multiplyScalar(UPWIND_APEX_AU * AU_PC);

/** Upwind apex distance from Sol in AU. The shell's upwind boundary
 *  (Voyager 1 termination crossing, 2012-08-25). Surfaced for hover
 *  labels so the readout is keyed off the same constant the geometry
 *  is derived from rather than duplicated downstream. */
export const HELIOPAUSE_UPWIND_APEX_AU = UPWIND_APEX_AU;

/** DOM element id of the SVG `<text>` node that renders the apex label.
 *  Exported so the hover picker can hit-test the label's bounding rect
 *  via getElementById — single source so the id can't drift between
 *  the label engine and the hover picker. */
export const HELIOPAUSE_LABEL_ELEMENT_ID = 'heliopause-label';

/** Visibility predicate for the apex SVG label. The label engine layers
 *  an additional near-plane guard on top of this (any sample point behind
 *  the camera near plane hides the label, since that means the camera
 *  is geometrically inside the ellipsoid). Shared between
 *  `createHeliopauseLabel` and the hover picker so the label eligibility
 *  rule can't silently drift between them.
 *
 *  Predicate: a planet system is focused, chart mode is off, and at
 *  least one orbit ring is currently drawn. In v1 the only attached
 *  planet host is Sol, so "focused planet system" effectively means
 *  "Sol focused"; once stellata-bk5 attaches exoplanet hosts the
 *  apex visibility will need to additionally require Sol-host —
 *  flag at that bead, don't pre-empt here. */
export function isHeliopauseApexVisible(stellata: Stellata): boolean {
  return stellata.getFocusedPlanetSystem() !== null
    && !stellata.getMonochrome()
    && stellata.anyOrbitRingVisible();
}

// Group quaternion that rotates +Z onto the antiapex direction in ICRS.
// Same value the Heliopause instance applies to its group; precomputed
// at module load so the label overlay can pre-rotate its sample points
// without depending on the live class instance.
const GROUP_QUATERNION = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1),
  APEX_DIR_ICRS.clone().negate(),
);

export class Heliopause {
  readonly group: THREE.Group;
  private mesh: THREE.Mesh;
  private geometry: THREE.SphereGeometry;
  private material: THREE.ShaderMaterial;
  private hidden = true;
  private mono = false;

  constructor() {
    this.group = new THREE.Group();
    // renderOrder = 1: shares the slot with star glow (both are dim
    // chrome). See docs/rendering.md §RenderOrder ladder for the full
    // cross-layer hierarchy.
    this.group.renderOrder = 1;
    this.group.visible = false;
    // Rotate the entire group so its local +Z aligns with the antiapex
    // direction in ICRS. The mesh inside scales + translates within
    // that rotated frame.
    this.group.quaternion.copy(GROUP_QUATERNION);

    this.geometry = new THREE.SphereGeometry(1, SPHERE_W_SEGMENTS, SPHERE_H_SEGMENTS);
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: heliopauseVert,
      fragmentShader: heliopauseFrag,
      transparent: true,
      depthWrite: false,
      // FrontSide so the inside of the shell back-face-culls when the
      // camera sits inside the heliopause (Sol focus, zoomed in to
      // sub-100 AU). From outside the shell, the near hemisphere's
      // front faces render with the Fresnel limb-darkening below.
      side: THREE.FrontSide,
      uniforms: {
        uColour: { value: COLOUR },
        uAlphaLimb: { value: ALPHA_LIMB },
        uFaceOnFloor: { value: FACE_ON_FLOOR },
        uFresnelPower: { value: FRESNEL_POWER },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // The ellipsoid is huge (~hundreds of AU) and the camera can sit
    // inside it; auto-bounding sphere culling gets confused. Skip cull.
    this.mesh.frustumCulled = false;

    // Scale to ellipsoid semi-axes in parsecs. Local (x, y, z) →
    // (equatorial, equatorial, major) since z = antiapex axis.
    const eqPc = SEMI_EQUATORIAL_AU * AU_PC;
    const majorPc = SEMI_MAJOR_AU * AU_PC;
    this.mesh.scale.set(eqPc, eqPc, majorPc);
    // Translate centre 39 AU along the rotated +Z = antiapex.
    this.mesh.position.set(0, 0, CENTRE_OFFSET_AU * AU_PC);

    this.group.add(this.mesh);
  }

  setVisible(on: boolean): void {
    this.hidden = !on;
    this.group.visible = !this.hidden && !this.mono;
  }

  /** Chart (mono / paper) mode hides the heliopause — chart-mode renders
   *  its own paper-aesthetic visualisation if/when stellata-m40 cares to
   *  cover this layer (currently it does not). */
  setMonochrome(on: boolean): void {
    this.mono = on;
    this.group.visible = !this.hidden && !this.mono;
  }

  /** Live shell-mesh visibility. Mirrors the actual rendered state
   *  (`group.visible`) so the hover picker can gate without re-deriving
   *  the Sol-focus + chart-mode + future-toggle conjunction. The right
   *  single source of truth — any layer-level toggle added later (a
   *  representational-layer settings switch, for example) AND's into
   *  `group.visible` automatically. */
  isVisible(): boolean {
    return this.group.visible;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Sample points distributed on the heliopause's ellipsoid surface,
 *  pre-rotated through the group quaternion into the Sol-anchored
 *  local frame. Projecting these to screen each frame gives a screen-
 *  space bounding box that hugs the egg's silhouette tightly — within
 *  the tessellation precision of the sample grid. Computed once at
 *  module load; geometry is static.
 *
 *  Surface points (not AABB corners) — points off the surface sit
 *  further from the centre than the silhouette and produce a loose
 *  bbox that reads as "label floating in space." For the (115, 115,
 *  161) AU ellipsoid the AABB corners sit at √(a² + a² + c²) ≈ 229 AU
 *  from centre, ~40% beyond the actual silhouette extent.
 *
 *  Exported so the hover picker can hit-test the projected silhouette
 *  bbox against the cursor — same 62 points, same near-plane guard,
 *  so the hover surface stays in lockstep with the label engine. */
export const HELIOPAUSE_SAMPLE_POINTS_LOCAL: readonly THREE.Vector3[] = (() => {
  const arr: THREE.Vector3[] = [];
  const cz = CENTRE_OFFSET_AU * AU_PC;
  const a = SEMI_EQUATORIAL_AU * AU_PC;
  const c = SEMI_MAJOR_AU * AU_PC;
  // 12 longitudes × 5 mid-latitudes + 2 poles = 62 points. Plenty
  // dense for a tight silhouette bbox; cost is 62 vec3 transforms
  // per frame.
  const N_LONGS = 12;
  const N_LATS = 5;
  for (let i = 0; i < N_LATS; i++) {
    const theta = (i + 0.5) / N_LATS * Math.PI; // avoid degenerate poles here
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let j = 0; j < N_LONGS; j++) {
      const phi = (j / N_LONGS) * 2 * Math.PI;
      const v = new THREE.Vector3(
        a * sinT * Math.cos(phi),
        a * sinT * Math.sin(phi),
        cz + c * cosT,
      );
      v.applyQuaternion(GROUP_QUATERNION);
      arr.push(v);
    }
  }
  // Antiapex/apex tips at the poles.
  arr.push(new THREE.Vector3(0, 0, cz + c).applyQuaternion(GROUP_QUATERNION));
  arr.push(new THREE.Vector3(0, 0, cz - c).applyQuaternion(GROUP_QUATERNION));
  return arr;
})();

/** Mount the SVG "Heliopause" label and bind per-frame projection.
 *  Thin wrapper around the shared distance-gated label engine that
 *  carries the heliopause-specific configuration: the 62-sample
 *  ellipsoid silhouette, the bottom-right anchor direction, and the
 *  visibility predicate gated on the same orbit-ring heuristic the
 *  planet labels use — so the heliopause label appears whenever any
 *  planet ring would draw and vanishes in lockstep with the last
 *  planet label. */
export function createHeliopauseLabel(stellata: Stellata): void {
  createDistanceGatedLabel(stellata, {
    elementId: HELIOPAUSE_LABEL_ELEMENT_ID,
    sampleCount: HELIOPAUSE_SAMPLE_POINTS_LOCAL.length,
    // HELIOPAUSE_SAMPLE_POINTS_LOCAL is already in Sol-anchored local pc — which
    // *is* world space whenever the heliopause label can show (the
    // predicate below requires a focused planet system, and Sol is the
    // only planet-bearing host in v1 so worldOffset == Sol's absolute
    // position). No worldOffset subtraction needed here.
    getWorldSample: (i, out) => out.copy(HELIOPAUSE_SAMPLE_POINTS_LOCAL[i]),
    visible: () => isHeliopauseApexVisible(stellata),
    // Bottom-right diagonal (1, 1)/√2 in CSS y-down coords.
    labelDir: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    offsetPx: LABEL_OFFSET_PX,
    // Settles in ~4-5 frames (~70 ms at 60 fps) — responsive but smooth
    // enough to hide the support-point's discrete neighbour switching.
    lerp: 0.25,
  });
}
