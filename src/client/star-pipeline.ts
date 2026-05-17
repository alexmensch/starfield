import * as THREE from 'three';
import type { Catalog } from './loaders/catalog-loader';

// Disc-pass blending state. Applied at material construction and re-applied
// on chart-mode -> colour-mode swap-back, since chart mode swaps the disc
// material to MultiplyBlending. Single source of truth for the four
// CustomBlending fields plus the depth flags so a future tweak (e.g. the
// AddEquation -> MaxEquation switch in PR #25) only needs to touch one site.
export function applyDiscBlendDefaults(m: THREE.ShaderMaterial) {
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.blendEquation = THREE.MaxEquation;
  m.depthWrite = true;
  m.depthTest = true;
}

export interface StarPipelineOptions {
  scene: THREE.Scene;
  catalog: Catalog;
  /** Per-star log10(physicalRadius_solar). Decoded shader-side via
   *  `pow(10, iLogRadius)` and multiplied by `uRSunPc` to recover parsecs. */
  logRadii: Float32Array;
  /** Per-star luminosity class as Float32 (255 = unknown, preserved
   *  through the conversion and handled inside the shader). */
  lumClassF32: Float32Array;
  /** Per-star distance from Sol in pc. Replaces the shader's old
   *  `length(iPosition)` derivation, which broke when iPosition shifted
   *  to local-frame after the floating-origin recentre. */
  distSol: Float32Array;
  /** Buffer backing the dynamic `iPosition` attribute. Owned by the
   *  caller — Stellata's floating-origin recentre rewrites it in place
   *  and bumps `iPositionAttr.needsUpdate`. Must outlive the pipeline. */
  localPositions: Float32Array;
  vertexShader: string;
  fragmentShader: string;
  /** Shared uniforms map. Each pass spreads it with its own
   *  `uRenderMode`; the value-object identities are preserved so a
   *  single uniform write propagates to disc + glow + core-mask. */
  sharedUniforms: Record<string, THREE.IUniform>;
  /** Bounding-sphere radius (pc) covering every star in the catalog —
   *  feeds three.js frustum culling (we disable it on the meshes too,
   *  but the bound is still useful as documentation of the world span). */
  boundingSphereRadiusPc: number;
}

/**
 * Owns the InstancedBufferGeometry + the three ShaderMaterials + their
 * meshes that make up the star render pipeline:
 *
 *   - core depth-mask (renderOrder -4, depth-only, gated each frame)
 *   - disc pass (renderOrder 0, opaque, per-channel max blending)
 *   - glow pass (renderOrder 1, additive)
 *
 * One geometry feeds all three; uRenderMode is the only divergent
 * uniform, so the three materials share the rest of the uniforms map by
 * reference. dispose() walks all owned resources in the right order.
 *
 * Per-frame uniform writes still go through
 * `pipeline.discMaterial.uniforms.<name>.value` from the integration
 * shell — the encapsulation here is resource ownership + dispose, not
 * access discipline. See bd issue stellata-9mm.43.
 */
export class StarPipeline {
  readonly geometry: THREE.InstancedBufferGeometry;
  /** Dynamic — overwritten on every Stellata.recenterOrigin. Callers
   *  set `needsUpdate = true` after rewriting the backing buffer. */
  readonly iPositionAttr: THREE.InstancedBufferAttribute;
  readonly discMaterial: THREE.ShaderMaterial;
  readonly glowMaterial: THREE.ShaderMaterial;
  readonly coreMaskMaterial: THREE.ShaderMaterial;
  readonly discMesh: THREE.Mesh;
  readonly glowMesh: THREE.Mesh;
  readonly coreMaskMesh: THREE.Mesh;

  private scene: THREE.Scene;

  constructor(opts: StarPipelineOptions) {
    const {
      scene, catalog, logRadii, lumClassF32, distSol, localPositions,
      vertexShader, fragmentShader, sharedUniforms, boundingSphereRadiusPc,
    } = opts;
    this.scene = scene;

    // Instanced quads: one unit square per star, expanded in screen space in
    // the vertex shader. This replaces the earlier THREE.Points approach,
    // which was capped by the driver-defined gl_PointSize maximum (often
    // 64-255 px) — too small for the angular-diameter rendering to reach the
    // viewport-filling sizes we want for supergiants at close range.
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute(
      'aCorner',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
        2,
      ),
    );
    this.geometry.setIndex([0, 1, 2, 1, 3, 2]);
    this.iPositionAttr = new THREE.InstancedBufferAttribute(localPositions, 3);
    this.iPositionAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iPosition', this.iPositionAttr);
    this.geometry.setAttribute('iAbsmag', new THREE.InstancedBufferAttribute(catalog.absmag, 1));
    this.geometry.setAttribute('iCi', new THREE.InstancedBufferAttribute(catalog.ci, 1));
    this.geometry.setAttribute('iSpectClass', new THREE.InstancedBufferAttribute(catalog.spectClass, 1));
    this.geometry.setAttribute('iLogRadius', new THREE.InstancedBufferAttribute(logRadii, 1));
    this.geometry.setAttribute('iPeriodDays', new THREE.InstancedBufferAttribute(catalog.periodDays, 1));
    this.geometry.setAttribute('iAmplitudeMag', new THREE.InstancedBufferAttribute(catalog.amplitudeMag, 1));
    this.geometry.setAttribute('iLumClass', new THREE.InstancedBufferAttribute(lumClassF32, 1));
    this.geometry.setAttribute('iDistSol', new THREE.InstancedBufferAttribute(distSol, 1));
    this.geometry.instanceCount = catalog.count;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), boundingSphereRadiusPc);

    // Disc pass: per-channel max so overlapping discs/halos don't sum.
    // Shader writes premultiplied (C·α, α); MaxEquation gives
    // dst = max(src, dst) per channel. Depth write stays on so the
    // glow pass can depth-test against the disc silhouettes.
    this.discMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...sharedUniforms, uRenderMode: { value: 1 } },
      vertexShader,
      fragmentShader,
      transparent: true,
    });
    applyDiscBlendDefaults(this.discMaterial);

    // Glow pass: additive so overlapping distant stars accumulate brightness
    // (catalog density preserved). No depth write so multiple glows at the
    // same pixel all contribute. Depth *test* is on so glows behind a disc
    // drawn in the disc pass are correctly occluded.
    this.glowMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...sharedUniforms, uRenderMode: { value: 0 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    // Core depth-mask: writes near depth at disc-pass star cores before any
    // background layer renders, so the Milky Way / molecular clouds /
    // galactic grid depth-fail behind close stars instead of bleeding
    // through. colorWrite off → cheaper than a colour pass and never paints
    // anything visible. Visibility gated each frame on focus / warp state by
    // the integration shell.
    this.coreMaskMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...sharedUniforms, uRenderMode: { value: 2 } },
      vertexShader,
      fragmentShader,
      depthWrite: true,
      depthTest: true,
      colorWrite: false,
    });

    // renderOrder: core mask (-4) → background layers → discs (0) → glows (1).
    this.coreMaskMesh = new THREE.Mesh(this.geometry, this.coreMaskMaterial);
    this.coreMaskMesh.frustumCulled = false;
    this.coreMaskMesh.renderOrder = -4;
    this.coreMaskMesh.visible = false;
    scene.add(this.coreMaskMesh);

    this.discMesh = new THREE.Mesh(this.geometry, this.discMaterial);
    this.discMesh.frustumCulled = false;
    this.discMesh.renderOrder = 0;
    scene.add(this.discMesh);

    this.glowMesh = new THREE.Mesh(this.geometry, this.glowMaterial);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 1;
    scene.add(this.glowMesh);
  }

  /** Swap disc + glow blend state for chart mode. Disc-pass uses
   *  MultiplyBlending (with depth flags off) and glow-pass also flips
   *  to multiply / depth-off in mono mode; restored to the calibrated
   *  defaults on swap-back. uMonochrome is a shared uniform written by
   *  the caller — only the per-material blend state lives here. */
  setMonochromeBlend(on: boolean) {
    if (on) {
      this.discMaterial.blending = THREE.MultiplyBlending;
      this.discMaterial.depthWrite = false;
      this.discMaterial.depthTest = false;
      this.glowMaterial.blending = THREE.MultiplyBlending;
      this.glowMaterial.depthTest = false;
    } else {
      applyDiscBlendDefaults(this.discMaterial);
      this.glowMaterial.blending = THREE.AdditiveBlending;
      this.glowMaterial.depthTest = true;
    }
    this.discMaterial.needsUpdate = true;
    this.glowMaterial.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.coreMaskMesh);
    this.scene.remove(this.discMesh);
    this.scene.remove(this.glowMesh);
    // One shared InstancedBufferGeometry feeds the disc, glow, and
    // core-mask passes, so it's disposed once. Each pass has its own
    // ShaderMaterial.
    this.geometry.dispose();
    this.discMaterial.dispose();
    this.glowMaterial.dispose();
    this.coreMaskMaterial.dispose();
  }
}
