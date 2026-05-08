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
import type { Stellata } from './stellata';
import { AU_PC } from './ephemeris';
import { LABEL_OFFSET_PX } from './planet-labels';
import heliopauseVert from './shaders/heliopause.vert.glsl?raw';
import heliopauseFrag from './shaders/heliopause.frag.glsl?raw';

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
    // Behind planet bodies (renderOrder=3) and above stars (0) — sits
    // alongside orbit rings (2) at renderOrder=1, since both are dim
    // chrome for the same layer.
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

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// Sample points distributed on the heliopause's ellipsoid surface,
// pre-rotated through the group quaternion into the Sol-anchored
// local frame. Projecting these to screen each frame gives a screen-
// space bounding box that hugs the egg's silhouette tightly — within
// the tessellation precision of the sample grid. Computed once at
// module load; geometry is static.
//
// Surface points (not AABB corners) — points off the surface sit
// further from the centre than the silhouette and produce a loose
// bbox that reads as "label floating in space." For the (115, 115,
// 161) AU ellipsoid the AABB corners sit at √(a² + a² + c²) ≈ 229 AU
// from centre, ~40% beyond the actual silhouette extent.
const SAMPLE_POINTS_LOCAL: readonly THREE.Vector3[] = (() => {
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

// Screen-space direction the label sits along, as a unit vector.
// (1, 1)/√2 — bottom-right diagonal in CSS coords (where +y is down).
// Constant direction → the gap to the silhouette stays the same as
// the camera orbits, instead of varying with the rotated ellipse's
// bbox-vs-curve mismatch.
const LABEL_DIR_X = Math.SQRT1_2;
const LABEL_DIR_Y = Math.SQRT1_2;

// Temporal smoothing factor — fraction of the gap to the new target
// covered each frame. The support point is one of 62 discrete samples,
// so it switches abruptly between neighbours as the camera rotates;
// per-frame lerp turns those discrete jumps into a smooth chase. 0.25
// settles in ~4-5 frames (~70 ms at 60 fps), short enough to feel
// responsive on continuous camera motion.
const LABEL_LERP = 0.25;

/** Mount the SVG "Heliopause" label and bind per-frame projection.
 *  Visibility tracks the same predicate the planet labels use —
 *  `stellata.anyOrbitRingVisible()` — so the heliopause label appears
 *  whenever any planet ring would draw and vanishes in lockstep with
 *  the last planet label. The label hugs the bottom-right of the
 *  egg's projected silhouette at a constant 10 px gap, computed each
 *  frame from the silhouette's support point in that direction. */
export function createHeliopauseLabel(stellata: Stellata): void {
  const text = document.getElementById('heliopause-label') as unknown as SVGTextElement | null;
  if (!text) return;

  const tmp = new THREE.Vector3();
  let visible = false;
  // Smoothed screen position, null while hidden so the next show
  // snaps to the current target instead of sliding from the last
  // visible position.
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

  stellata.onFrame(() => {
    const ps = stellata.getFocusedPlanetSystem();
    if (!ps || stellata.getMonochrome()) {
      setVisible(false);
      return;
    }
    // Unified rule with planet labels: hide the heliopause label
    // whenever the orbit-ring visibility heuristic has collapsed all
    // rings (far framings) — and, by the same predicate, keep it on
    // while at least one planet label is up.
    if (!stellata.anyOrbitRingVisible()) {
      setVisible(false);
      return;
    }
    const camera = stellata.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Find the silhouette's *support point* in the chosen offset
    // direction — the surface sample whose screen position projects
    // furthest along (LABEL_DIR_X, LABEL_DIR_Y). The label then sits
    // at support + LABEL_OFFSET_PX in that same direction, giving a
    // constant gap from the silhouette curve regardless of camera
    // angle. (Bbox-corner placement gives a gap that varies because
    // the ellipse curves inward from the corner — for a circle the
    // corner is √2·r from centre while the curve is at r, so the
    // gap balloons by ~41% relative to a true tangent offset.)
    let bestProj = -Infinity;
    let bestX = 0, bestY = 0;
    for (const sample of SAMPLE_POINTS_LOCAL) {
      tmp.copy(sample);
      tmp.applyMatrix4(camera.matrixWorldInverse);
      // Any sample behind the near plane = the egg straddles the
      // camera (user inside or partially inside the bubble); the
      // projection wraps around in that regime, so bail.
      if (tmp.z >= -camera.near) {
        setVisible(false);
        return;
      }
      tmp.applyMatrix4(camera.projectionMatrix);
      const sx = (tmp.x + 1) * 0.5 * w;
      const sy = (1 - tmp.y) * 0.5 * h;
      const proj = sx * LABEL_DIR_X + sy * LABEL_DIR_Y;
      if (proj > bestProj) {
        bestProj = proj;
        bestX = sx;
        bestY = sy;
      }
    }
    const targetX = bestX + LABEL_OFFSET_PX * LABEL_DIR_X;
    const targetY = bestY + LABEL_OFFSET_PX * LABEL_DIR_Y;
    if (smoothedX === null || smoothedY === null) {
      // First visible frame after a hide — snap.
      smoothedX = targetX;
      smoothedY = targetY;
    } else {
      smoothedX += (targetX - smoothedX) * LABEL_LERP;
      smoothedY += (targetY - smoothedY) * LABEL_LERP;
    }
    setVisible(true);
    text.setAttribute('x', smoothedX.toFixed(1));
    text.setAttribute('y', smoothedY.toFixed(1));
  });
}
