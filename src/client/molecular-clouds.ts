import * as THREE from 'three';
import type { Cloud, CloudCatalog } from './cloud-loader';
import cloudVert from './shaders/cloud.vert.glsl?raw';
import cloudFrag from './shaders/cloud.frag.glsl?raw';

// Shared sphere geometry — every cloud is a unit sphere scaled by its
// semi-axes via the per-cloud Mesh matrix. 32×16 segmentation gives a
// smooth silhouette without spending too much on geometry; clouds are
// alpha-blended so silhouette quality matters more than face count.
const SEGMENTS_LON = 32;
const SEGMENTS_LAT = 16;

// Naturalistic dark-mode palette: a warm reddish-brown reminiscent of
// reddened starlight passing through dust. Real ISM dust is dark and
// extincts rather than emits, but the per-star extinction layer (Phase 1)
// already represents that physically; this overlay is the "where the dust
// is" decoration mode the user explicitly chose, so additive warm tones
// are the right stylization. Opacity tuned low (0.18) so even overlapping
// large clouds don't washout the local starfield.
const DARK_COLOR_DEFAULT = 0xb87850;
const DARK_OPACITY_DEFAULT = 0.18;

// Chart/mono mode: soft warm grey, normal alpha blend so it reads as ink
// on the paper canvas rather than a glow.
const MONO_COLOR_DEFAULT = 0x8a7864;
const MONO_OPACITY_DEFAULT = 0.22;

/**
 * Always-on layer rendering molecular clouds as soft warm ellipsoids.
 * Each cloud is a unit sphere mesh scaled by per-cloud semi-axes and
 * rotated by the per-cloud quaternion (Z2021 ellipsoids align to the
 * galactic basis; Z2020 spheres are quat=identity). A custom shader
 * derives a smooth view-direction-based density so the ellipsoid edges
 * fade rather than hard-clip.
 *
 * Lives in absolute ICRS space; the group's position is rebased by
 * -worldOffset each frame so the geometry stays anchored when the
 * floating origin shifts on focus changes.
 */
export class MolecularClouds {
  readonly group: THREE.Group;
  readonly clouds: Cloud[];
  private materials: THREE.ShaderMaterial[] = [];
  private geometry: THREE.SphereGeometry;
  private mono = false;
  /** Map from THREE.Mesh.uuid → cloud index, so raycasts resolve to clouds. */
  private meshIndex = new Map<string, number>();
  /** Mesh references in catalog order, for picking ray-ellipsoid analytically. */
  private meshes: THREE.Mesh[] = [];

  // User-tunable from the dev console via `starfield.clouds.set*()`.
  // Kept here rather than imported as constants so the live materials can
  // be re-pointed when values change without rebuilding the layer.
  private darkColor = new THREE.Color(DARK_COLOR_DEFAULT);
  private monoColor = new THREE.Color(MONO_COLOR_DEFAULT);
  private darkOpacity = DARK_OPACITY_DEFAULT;
  private monoOpacity = MONO_OPACITY_DEFAULT;

  constructor(catalog: CloudCatalog) {
    this.clouds = catalog.clouds;
    this.group = new THREE.Group();
    this.group.renderOrder = -2; // draw before stars so stars composit on top

    this.geometry = new THREE.SphereGeometry(1, SEGMENTS_LON, SEGMENTS_LAT);

    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      const mat = this.makeMaterial();
      this.materials.push(mat);

      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.position.copy(c.centerAbs);
      mesh.quaternion.copy(c.quat);
      mesh.scale.set(c.axes[0], c.axes[1], c.axes[2]);
      mesh.frustumCulled = false; // group origin is offset per frame
      mesh.renderOrder = -2;
      this.meshes.push(mesh);
      this.meshIndex.set(mesh.uuid, i);
      this.group.add(mesh);
    }
  }

  /** Per-frame: rebase the group to compensate for the floating origin. */
  update(worldOffset: THREE.Vector3, visible: boolean) {
    this.group.visible = visible;
    if (!visible) return;
    this.group.position.copy(worldOffset).negate();
  }

  setMonochrome(on: boolean) {
    if (this.mono === on) return;
    this.mono = on;
    for (const mat of this.materials) {
      mat.uniforms.uMonochrome.value = on ? 1 : 0;
      mat.uniforms.uOpacity.value = on ? this.monoOpacity : this.darkOpacity;
      // Mono = alpha-over (paper); colour = additive (glow). Both branches
      // rely on `premultipliedAlpha = true` — the shader bakes intensity
      // into rgb so additive becomes a clean (ONE, ONE) sum and normal
      // becomes a clean (ONE, ONE-α) over-blend. Without that, src.a
      // multiplies into rgb a second time and the cloud comes out ~30×
      // too dim to see.
      mat.blending = on ? THREE.NormalBlending : THREE.AdditiveBlending;
      mat.needsUpdate = true;
    }
  }

  /**
   * Console-accessible debug levers. Live-update all cloud materials so
   * tweaking happens without restart. Examples:
   *   starfield.clouds.setOpacity(0.5)         // make them obvious
   *   starfield.clouds.setColor(0xff8844)      // hotter orange
   *   starfield.clouds.setMonoOpacity(0.4)
   *   starfield.clouds.setMonoColor(0x000000)
   */
  setOpacity(x: number) {
    this.darkOpacity = Math.max(0, x);
    if (!this.mono) {
      for (const mat of this.materials) mat.uniforms.uOpacity.value = this.darkOpacity;
    }
  }
  setColor(hex: number) {
    this.darkColor.setHex(hex);
    for (const mat of this.materials) mat.uniforms.uColor.value = this.darkColor;
  }
  setMonoOpacity(x: number) {
    this.monoOpacity = Math.max(0, x);
    if (this.mono) {
      for (const mat of this.materials) mat.uniforms.uOpacity.value = this.monoOpacity;
    }
  }
  setMonoColor(hex: number) {
    this.monoColor.setHex(hex);
    for (const mat of this.materials) mat.uniforms.uMonoColor.value = this.monoColor;
  }
  /** Force-show every cloud at maximum opacity — handy for "is the layer
   *  rendering at all?" debugging. Pass null to restore the configured
   *  per-mode opacities. */
  setDebugBoost(strength: number | null) {
    for (const mat of this.materials) {
      mat.uniforms.uOpacity.value =
        strength === null
          ? (this.mono ? this.monoOpacity : this.darkOpacity)
          : strength;
    }
  }

  /**
   * Return the index of the cloud the ray hits closest to its origin, or
   * null if no cloud is hit. The renderer's depth-test means foreground
   * stars block clicks from reaching clouds behind them, but we don't
   * test against star geometry here — that's a star pick, handled by
   * pickStar in starfield.ts. Caller should pick the star first and
   * fall back to a cloud pick when no star is hit.
   */
  raycast(raycaster: THREE.Raycaster): number | null {
    const hits = raycaster.intersectObjects(this.meshes, false);
    if (hits.length === 0) return null;
    // intersectObjects sorts by distance ascending, so first hit wins.
    const idx = this.meshIndex.get(hits[0].object.uuid);
    return idx !== undefined ? idx : null;
  }

  dispose() {
    this.geometry.dispose();
    for (const mat of this.materials) mat.dispose();
  }

  private makeMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: cloudVert,
      fragmentShader: cloudFrag,
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      // Shader output is premultiplied — see fragment shader comment for
      // why this matters for both the additive and alpha-over paths.
      premultipliedAlpha: true,
      uniforms: {
        uColor: { value: this.darkColor },
        uMonoColor: { value: this.monoColor },
        uOpacity: { value: this.darkOpacity },
        uMonochrome: { value: 0 },
      },
    });
  }
}

/**
 * Compute a comfortable camera offset distance for viewing the given cloud
 * — the magnitude users pull back by when "fly to" snaps the camera. Uses
 * the cloud's largest semi-axis so a long, thin cloud (Cepheus, Aquila
 * Rift) gets enough pull-back to fit lengthwise in view, but small clouds
 * (Musca) don't park the camera a kpc away. The 2.4× factor matches the
 * tan(half-FoV) at our 60° vertical FoV with a bit of margin.
 */
export function cloudViewingDistancePc(cloud: Cloud): number {
  const maxAxis = Math.max(cloud.axes[0], cloud.axes[1], cloud.axes[2]);
  return Math.max(maxAxis * 2.4, 5.0);
}
