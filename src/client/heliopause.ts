// Heliopause boundary (stellata-3re.5).
//
// Asymmetric ellipsoid wireframe centred on Sol — upwind boundary at
// 122 AU (Voyager 1 crossing 2012-08-25), flanks at 115 AU (Voyager 2
// crossing 2018-11-05), heliotail at 200 AU (IBEX/Cassini ENA estimate).
// Apex direction: solar apex of motion through the local interstellar
// medium, ICRS RA 17h53m, Dec +27.4° per Frisch & Slavin (2013).
//
// Construction: unit sphere → wireframe → scale to (115, 115, 161) AU →
// translate centre by 39 AU toward antiapex → rotate +Z onto antiapex
// in ICRS. Result: upwind apex lands at +122 AU along apex; downwind
// at -200 AU along apex.
//
// Static geometry — no `t` dependence on human timescales. Visibility
// gated on focused star = Sol (the only planet-bearing host in v1).
// Mesh + apex label live here; main.ts wires the SVG label via
// `createHeliopauseLabel`.

import * as THREE from 'three';
import type { Stellata } from './stellata';

const AU_PC = 1 / 206264.80624709636;

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

// Wireframe granularity. 16 longitudes × 8 latitudes reads as a
// recognisable globe-style mesh without becoming triangle noise.
const SPHERE_W_SEGMENTS = 16;
const SPHERE_H_SEGMENTS = 8;

// Same dim chrome family as the per-planet orbit rings (3re.7) so the
// solar-system layer reads as a single coherent visual layer.
const COLOUR = 0xc8d6ff;
const OPACITY = 0.18;

/** Upwind apex point in the Sol-anchored local frame (parsecs). The
 *  label overlay reads this to project the "Heliopause" tag to screen.
 *  Valid only while Sol is the focused star — under floating-origin,
 *  world origin sits at the focal star's absolute position, and the
 *  heliopause renders only when that star is Sol. */
export const HELIOPAUSE_APEX_LOCAL_PC: Readonly<THREE.Vector3> =
  APEX_DIR_ICRS.clone().multiplyScalar(UPWIND_APEX_AU * AU_PC);

export class Heliopause {
  readonly group: THREE.Group;
  private mesh: THREE.LineSegments;
  private wireframeGeom: THREE.WireframeGeometry;
  private material: THREE.LineBasicMaterial;
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
    const antiapex = APEX_DIR_ICRS.clone().negate();
    this.group.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      antiapex,
    );

    const sphere = new THREE.SphereGeometry(1, SPHERE_W_SEGMENTS, SPHERE_H_SEGMENTS);
    this.wireframeGeom = new THREE.WireframeGeometry(sphere);
    sphere.dispose();

    this.material = new THREE.LineBasicMaterial({
      color: COLOUR,
      transparent: true,
      opacity: OPACITY,
      depthWrite: false,
    });
    this.mesh = new THREE.LineSegments(this.wireframeGeom, this.material);
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
    this.wireframeGeom.dispose();
    this.material.dispose();
  }
}

/** Mount the SVG "Heliopause" label and bind per-frame projection.
 *  Visibility tracks the focused-planet-system gate (Sol = focused) +
 *  chart-mode off, mirroring the mesh's visibility contract. */
export function createHeliopauseLabel(stellata: Stellata): void {
  const text = document.getElementById('heliopause-label') as unknown as SVGTextElement | null;
  if (!text) return;

  const tmp = new THREE.Vector3();
  let visible = false;
  const setVisible = (on: boolean): void => {
    if (on === visible) return;
    text.style.display = on ? '' : 'none';
    visible = on;
  };
  setVisible(false);

  stellata.onFrame(() => {
    const ps = stellata.getFocusedPlanetSystem();
    if (!ps || stellata.getMonochrome()) {
      setVisible(false);
      return;
    }
    // Project the upwind apex point (Sol-anchored local frame) to
    // screen via the same path planet-labels uses.
    const camera = stellata.camera;
    tmp.copy(HELIOPAUSE_APEX_LOCAL_PC);
    tmp.applyMatrix4(camera.matrixWorldInverse);
    if (tmp.z >= -camera.near) {
      setVisible(false);
      return;
    }
    tmp.applyMatrix4(camera.projectionMatrix);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const sx = (tmp.x + 1) * 0.5 * w;
    const sy = (1 - tmp.y) * 0.5 * h;
    setVisible(true);
    text.setAttribute('x', sx.toFixed(1));
    text.setAttribute('y', sy.toFixed(1));
  });
}
