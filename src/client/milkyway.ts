import * as THREE from 'three';
import milkywayVert from './shaders/milkyway.vert.glsl?raw';
import milkywayFrag from './shaders/milkyway.frag.glsl?raw';
import { GAL_TO_ICRS, GALACTIC_CENTRE_PC, R0_PC } from './galactic-coords';
import type { DustField } from './dust-loader';

// Phase 5 (rev 4) — bounded volumetric raymarch through proxy meshes.
//
// Two proxy meshes (a flattened disc + an oblate bulge) define
// integration volumes centred on the galactic centre. For each
// fragment, the shader raymarches from front-face entry (or camera
// position if camera is inside the mesh) to the back-face fragment,
// evaluating the component's density profile and accumulating emission
// with running dust extinction. The two meshes' contributions add via
// AdditiveBlending.
//
// Why volumetric (vs. surface-only): surface-only emission evaluates
// density at exactly one point per fragment, which can't represent the
// path-length anisotropy that's the defining feature of the band — long
// edge-on path through the disc gives bright band, short out-of-plane
// path gives dim glow, smoothly. Volumetric integration produces this
// for free. As a bonus the silhouette of the proxy mesh tapers to zero
// naturally (the path through the volume shrinks to zero at the edge),
// no `pow(|n·v|, k)` softening hack required.
//
// Why analytical-only dust (no voxel sampling in milky way layer): the
// Edenhofer voxel grid has ~5 pc native structure, designed for short
// per-star sightlines. Sampling it at coarse step intervals along the
// long camera→fragment ray (8-15 kpc) aliases into visible parallel
// streaks regardless of step distribution. Dropping voxel sampling
// here loses the local-cloud bites in the band, but those belong to
// the molecular cloud layer (renderOrder = -2) which renders named SF
// clouds as proper 3D ellipsoids in front of the milky way. The voxel
// grid stays in use for per-star extinction (star.vert.glsl) where
// short rays + dense per-star sampling work cleanly.

// --- Geometry / density parameters -------------------------------------

// Disc proxy mesh extent. ~30 kpc total radial diameter, ~1.2 kpc total
// vertical thickness — enough to encompass the visible disc with a
// buffer past Jurić's exponential drop-off.
const DISC_RADIUS_PC = 15_000;       // half-extent radial (xy)
const DISC_HALF_THICKNESS_PC = 600;  // half-extent vertical (z)

// Disc emission profile. Double-exponential thin disc (Jurić 2008
// Table 10 / Robin 2003 acceptable range).
const DISC_SCALE_LENGTH_PC = 3_000;  // radial scale length hR
const DISC_SCALE_HEIGHT_PC = 300;    // vertical scale height hz
const DISC_DENSITY0 = 1.5;           // peak density (relative units; tunable)
// Pale lavender disc — empirically tuned. Combined with the warm
// reddening law, the disc reads as a cool blue-grey band off the
// galactic plane and shifts warmer through dust columns toward the GC.
const DISC_COLOR = new THREE.Color(0.6706, 0.6588, 0.8745); // 171/168/223

// Bulge proxy mesh extent. Encompasses 5× scale radius at the equator
// and ~1.7× scale radius along z (axis ratio 0.6, oblate). The density
// profile is exp(-r'/r_b), so the proxy boundary's actual density is
// already negligible; the integration just terminates there.
const BULGE_RADIUS_PC = 5_000;        // half-extent radial (xy)
const BULGE_HALF_THICKNESS_PC = 3_000; // half-extent vertical (z)

// Bulge emission profile.
const BULGE_SCALE_RADIUS_PC = 1_000; // r_b
const BULGE_AXIS_RATIO = 0.6;        // q (z'/r flattening, oblate)
const BULGE_DENSITY0 = 18.0;         // peak density relative to disc
// Near-white bulge with a faint warm bias — empirically tuned. The
// reddening law warms the bulge further along high-extinction GC
// sightlines without making it look uniformly orange off-dust.
const BULGE_COLOR = new THREE.Color(1.0, 0.9647, 0.9294); // 255/246/237

// --- Dust extinction parameters ---------------------------------------

// Analytical disc dust profile. Thinner scale height than the stellar
// disc (canonical thin-disc dust h ≈ 125 pc; Drimmel & Spergel 2001).
// Normalisation tuned so density × av_factor at (R₀, z=0) ≈ 0.15 mag/kpc,
// the canonical local extinction rate (Schlegel/Finkbeiner/Davis 1998).
const ANALYTICAL_DUST_SCALE_LENGTH_PC = 3_500;
const ANALYTICAL_DUST_SCALE_HEIGHT_PC = 125;
const ANALYTICAL_DUST_NORM_PER_PC = 5.5e-5;

// Wavelength-dependent extinction. CCM-derived per-channel τ multipliers
// (relative to V band): A_R/A_V/A_B ≈ 0.751/1.0/1.32. Empirically nudged
// to 0.76/1.0/1.35 — slightly stronger blue extinction reads more
// naturally through the GC dust columns. Applied as transmission =
// exp(-τ_V × these). Red transmits most, blue extincts away.
const REDDENING_RGB = new THREE.Vector3(0.76, 1.0, 1.35);

// --- Output controls ---------------------------------------------------

// Tone-map gain on the integrated emission. The volumetric raymarch
// produces colorAccum values in "density × pc" units summed over ~32
// log-distributed steps spanning kpc-scale path lengths, so the raw
// numbers are large (10⁴-10⁵ along the GC sightline). The tone map is
// `result = 1 - exp(-colorAccum × brightness)`, so brightness ~5e-6
// puts a peak GC sightline near saturation while keeping NGP visibly
// dim. Empirically tuned alongside GLOW_MAG_OFFSET.
const DEFAULT_BRIGHTNESS = 5.35e-6;

// Magnitude calibration. `appMag = uGlowMagOffset - 2.5×log10(intensity)`
// converts integrated emission into an effective apparent magnitude,
// which is then gated through the same brightnessClamp curve as the
// star pipeline so the user's max-mag slider attenuates stars + glow
// together. Lower values lift the layer through the gate sooner;
// higher values demand a brighter slider setting to reveal it. Tuned
// against DEFAULT_BRIGHTNESS so the GC bulge sits near naked-eye
// visibility and NGP stays faint.
const GLOW_MAG_OFFSET = 15.0;

// Default analytical-dust strength applied at construction. < 1 reads
// as the (faintly under-extincted) disc band the user calibrated
// against; the per-frame Starfield knob still overrides this.
const DEFAULT_EXTINCTION_STRENGTH = 0.45;

// Raymarch step count is fixed in the shader (32 steps). Performance
// has been fine through phase 5 even with two materials each running
// 32 steps; bump up if the user reports stutter.

// --- Frame transform constants ----------------------------------------

const GAL_TO_ICRS_M3 = new THREE.Matrix3().setFromMatrix4(GAL_TO_ICRS);
const ICRS_TO_GAL_M3 = GAL_TO_ICRS_M3.clone().transpose();
const GAL_QUAT = new THREE.Quaternion().setFromRotationMatrix(GAL_TO_ICRS);

/** Uniforms shared with the star shader. The MilkyWay layer references
 *  uMaxAppMag and uSizeSpan from this map directly so the magnitude
 *  filter applies uniformly to discrete stars and diffuse glow. */
export interface MilkywaySharedUniforms {
  uMaxAppMag: { value: number };
  uSizeSpan: { value: number };
}

/** Per-component density / colour / scale parameters. Exposed as an
 *  interface so the dev-console levers can target either component. */
interface ComponentMaterials {
  material: THREE.ShaderMaterial;
  density0: { value: number };
  color: { value: THREE.Color };
  meshScale: { value: THREE.Vector3 };
}

export class MilkyWay {
  /** Scene-attached group containing both proxy meshes. Consumer adds
   *  this to the main scene; renderOrder = -3 keeps both meshes behind
   *  the molecular clouds (-2), galactic reference rings (-1), and
   *  stars (0/1). */
  readonly group: THREE.Group;

  private discMesh: THREE.Mesh;
  private bulgeMesh: THREE.Mesh;

  private disc: ComponentMaterials;
  private bulge: ComponentMaterials;

  // Uniform objects shared across both materials (same {value:...} ref
  // in both, so updating one place propagates to both).
  private sharedDust: {
    uDustAvPerDensityPc: { value: number };
    uDustEnabled: { value: number };
    uExtinctionStrength: { value: number };
    uAnalyticalDustScaleLengthPc: { value: number };
    uAnalyticalDustScaleHeightPc: { value: number };
    uAnalyticalDustNormPerPc: { value: number };
    uReddeningRGB: { value: THREE.Vector3 };
  };
  private sharedFrame: {
    uWorldOffset: { value: THREE.Vector3 };
    uIcrsToGal: { value: THREE.Matrix3 };
    uGalCenter: { value: THREE.Vector3 };
    uR0Pc: { value: number };
  };
  private sharedTone: {
    uBrightnessScale: { value: number };
    uGlowMagOffset: { value: number };
  };

  private enabled = true;
  private monochrome = false;

  constructor(shared: MilkywaySharedUniforms) {
    this.sharedDust = {
      uDustAvPerDensityPc: { value: 2.742 },
      uDustEnabled: { value: 0 },
      uExtinctionStrength: { value: DEFAULT_EXTINCTION_STRENGTH },
      uAnalyticalDustScaleLengthPc: { value: ANALYTICAL_DUST_SCALE_LENGTH_PC },
      uAnalyticalDustScaleHeightPc: { value: ANALYTICAL_DUST_SCALE_HEIGHT_PC },
      uAnalyticalDustNormPerPc: { value: ANALYTICAL_DUST_NORM_PER_PC },
      uReddeningRGB: { value: REDDENING_RGB.clone() },
    };
    this.sharedFrame = {
      uWorldOffset: { value: new THREE.Vector3() },
      uIcrsToGal: { value: ICRS_TO_GAL_M3 },
      uGalCenter: { value: GALACTIC_CENTRE_PC.clone() },
      uR0Pc: { value: R0_PC },
    };
    this.sharedTone = {
      uBrightnessScale: { value: DEFAULT_BRIGHTNESS },
      uGlowMagOffset: { value: GLOW_MAG_OFFSET },
    };

    // --- Disc -----------------------------------------------------------
    const discGeom = new THREE.SphereGeometry(1, 96, 48);
    this.disc = this.makeComponent({
      isBulge: false,
      meshScale: new THREE.Vector3(
        DISC_RADIUS_PC,
        DISC_RADIUS_PC,
        DISC_HALF_THICKNESS_PC,
      ),
      density0: DISC_DENSITY0,
      color: DISC_COLOR.clone(),
      magnitudeShared: shared,
    });
    this.discMesh = this.buildMesh(discGeom, this.disc);

    // --- Bulge ----------------------------------------------------------
    const bulgeGeom = new THREE.SphereGeometry(1, 64, 32);
    this.bulge = this.makeComponent({
      isBulge: true,
      meshScale: new THREE.Vector3(
        BULGE_RADIUS_PC,
        BULGE_RADIUS_PC,
        BULGE_HALF_THICKNESS_PC,
      ),
      density0: BULGE_DENSITY0,
      color: BULGE_COLOR.clone(),
      magnitudeShared: shared,
    });
    this.bulgeMesh = this.buildMesh(bulgeGeom, this.bulge);

    this.group = new THREE.Group();
    this.group.add(this.discMesh);
    this.group.add(this.bulgeMesh);
  }

  private makeComponent(opts: {
    isBulge: boolean;
    meshScale: THREE.Vector3;
    density0: number;
    color: THREE.Color;
    magnitudeShared: MilkywaySharedUniforms;
  }): ComponentMaterials {
    const density0 = { value: opts.density0 };
    const color = { value: opts.color };
    const meshScale = { value: opts.meshScale };

    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: milkywayVert,
      fragmentShader: milkywayFrag,
      // BackSide so each ray that intersects the volume produces exactly
      // one fragment — the back-face surface point IS the natural exit
      // of the volumetric integration. Front-face fragments are skipped
      // (would require a separate pass to produce entry positions; we
      // compute entry analytically in the fragment shader).
      side: THREE.BackSide,
      // depthTest off so opaque foreground stars (renderOrder 0) drawn
      // after this layer don't depth-fail against an empty buffer; the
      // milky way renders first under renderOrder = -3, then everything
      // else paints over additively. depthWrite off so the mesh never
      // occludes anything later.
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        // Shared (same {value:...} ref in both materials).
        ...this.sharedDust,
        ...this.sharedFrame,
        ...this.sharedTone,
        uMaxAppMag: opts.magnitudeShared.uMaxAppMag,
        uSizeSpan: opts.magnitudeShared.uSizeSpan,

        // Per-component.
        uIsBulge: { value: opts.isBulge },
        uMeshScalePc: meshScale,
        uDensity0: density0,
        uColor: color,
        uDiscScaleLengthPc: { value: DISC_SCALE_LENGTH_PC },
        uDiscScaleHeightPc: { value: DISC_SCALE_HEIGHT_PC },
        uBulgeScaleRadiusPc: { value: BULGE_SCALE_RADIUS_PC },
        uBulgeAxisRatio: { value: BULGE_AXIS_RATIO },
      },
    });

    return { material, density0, color, meshScale };
  }

  private buildMesh(geom: THREE.SphereGeometry, comp: ComponentMaterials): THREE.Mesh {
    const mesh = new THREE.Mesh(geom, comp.material);
    // Mesh-local axes align with galactic axes by virtue of this
    // quaternion. mesh.scale extends the unit sphere into galactic-frame
    // pc per axis (radial, radial, vertical).
    mesh.quaternion.copy(GAL_QUAT);
    mesh.scale.copy(comp.meshScale.value);
    // The mesh is huge but its bounding sphere is centred on the local
    // mesh origin; per-frame we rebase mesh.position to the galactic
    // centre under the floating origin. Auto-frustum-culling would
    // mis-cull when the camera is offset far from Sol.
    mesh.frustumCulled = false;
    mesh.renderOrder = -3;
    return mesh;
  }

  /** Wire the dust voxel field into the shared uniforms. The volumetric
   *  raymarch only uses analytical dust, so we just set the enabled
   *  flag — the texture itself isn't sampled by this shader anymore.
   *  We keep the API for symmetry with the per-star pipeline so a
   *  single attachDust call keeps both layers in sync. */
  attachDust(dust: DustField | null) {
    const u = this.sharedDust;
    if (dust === null) {
      u.uDustEnabled.value = 0;
      return;
    }
    u.uDustAvPerDensityPc.value = dust.params.avPerDensityPerPc;
    u.uDustEnabled.value = 1;
  }

  setExtinctionStrength(x: number) {
    this.sharedDust.uExtinctionStrength.value = Math.max(0, x);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.group.visible = on && !this.monochrome;
  }

  isEnabled(): boolean { return this.enabled; }

  setMonochrome(on: boolean) {
    this.monochrome = on;
    // Chart mode hides the analytical background entirely — paper-chart
    // aesthetic shows discrete named objects, not a diffuse glow.
    this.group.visible = this.enabled && !on;
  }

  setBrightness(x: number) {
    this.sharedTone.uBrightnessScale.value = Math.max(0, x);
  }

  setGlowMagOffset(x: number) {
    this.sharedTone.uGlowMagOffset.value = x;
  }

  setDiscDensity(x: number) {
    this.disc.density0.value = Math.max(0, x);
  }
  setBulgeDensity(x: number) {
    this.bulge.density0.value = Math.max(0, x);
  }

  setDiscColor(r: number, g: number, b: number) {
    this.disc.color.value.setRGB(r, g, b);
  }
  setBulgeColor(r: number, g: number, b: number) {
    this.bulge.color.value.setRGB(r, g, b);
  }

  /** Set the wavelength-reddening per-channel τ multipliers. CCM
   *  default is (0.751, 1.0, 1.32). Larger spread = more dramatic
   *  reddening. */
  setReddeningRGB(r: number, g: number, b: number) {
    this.sharedDust.uReddeningRGB.value.set(r, g, b);
  }

  /** Read-only snapshot of all tunable values, for the dev tuning panel
   *  to initialise its inputs from the live state. */
  getValues() {
    const c = this.sharedDust.uReddeningRGB.value;
    return {
      brightness: this.sharedTone.uBrightnessScale.value,
      glowMagOffset: this.sharedTone.uGlowMagOffset.value,
      discDensity: this.disc.density0.value,
      bulgeDensity: this.bulge.density0.value,
      extinctionStrength: this.sharedDust.uExtinctionStrength.value,
      discColor: { r: this.disc.color.value.r, g: this.disc.color.value.g, b: this.disc.color.value.b },
      bulgeColor: { r: this.bulge.color.value.r, g: this.bulge.color.value.g, b: this.bulge.color.value.b },
      reddening: { r: c.x, g: c.y, b: c.z },
    };
  }

  /** Per-frame update. Re-anchors both meshes to the galactic centre
   *  under the floating-origin offset, and refreshes the camera-side
   *  frame uniforms. Call once before scene render. */
  update(_camera: THREE.PerspectiveCamera, worldOffset: THREE.Vector3) {
    if (!this.enabled || this.monochrome) return;

    // Both meshes sit at the galactic centre in absolute ICRS, which
    // becomes (GALACTIC_CENTRE_PC - worldOffset) in renderer-local frame.
    const galCenterLocal = this.sharedFrame.uGalCenter.value;
    galCenterLocal.copy(GALACTIC_CENTRE_PC).sub(worldOffset);
    this.discMesh.position.copy(galCenterLocal);
    this.bulgeMesh.position.copy(galCenterLocal);

    this.sharedFrame.uWorldOffset.value.copy(worldOffset);
  }

  dispose() {
    this.discMesh.geometry.dispose();
    this.bulgeMesh.geometry.dispose();
    this.disc.material.dispose();
    this.bulge.material.dispose();
  }
}
