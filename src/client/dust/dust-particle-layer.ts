import * as THREE from 'three';
import type { DustParticleData } from '../loaders/dust-loader';
import dustParticleVert from '../shaders/dust-particle.vert.glsl?raw';
import dustParticleFrag from '../shaders/dust-particle.frag.glsl?raw';

// Star-material uniforms shared with the particle shader. Reference-
// shared (not cloned) so floating-origin recenters, resize updates, and
// dust-texture loads propagate to the particle pass automatically.
export interface DustParticleSharedUniforms {
  uPixelRatio: { value: number };
  uViewport: { value: THREE.Vector2 };
  uWorldOffset: { value: THREE.Vector3 };
  uDustEnabled: { value: number };
  uDustDensityMin: { value: number };
  uDustLogRatio: { value: number };
}

// Shelved for v1.0 — see docs/rendering.md § "Dust extinction + the
// shelved particle layer" and bd issue stellata-zq3 for the open
// questions. Default strength = 0 → mesh.visible = false → zero
// per-frame cost.
export class DustParticleLayer {
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;

  constructor(
    private scene: THREE.Scene,
    private sharedUniforms: DustParticleSharedUniforms,
  ) {}

  /** Build the particle mesh from loaded data. Idempotent — re-calling
   *  with new data replaces the existing mesh. */
  attach(data: DustParticleData) {
    this.dispose({ removeFromScene: true });

    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute(
      'aCorner',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
        2,
      ),
    );
    geom.setIndex([0, 1, 2, 1, 3, 2]);
    geom.setAttribute('iPosition', new THREE.InstancedBufferAttribute(data.positions, 3));
    geom.setAttribute('iDensity', new THREE.InstancedBufferAttribute(data.densities, 1));
    geom.instanceCount = data.count;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60_000);

    const u = this.sharedUniforms;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uPixelRatio: u.uPixelRatio,
        uViewport: u.uViewport,
        uWorldOffset: u.uWorldOffset,
        uDustEnabled: u.uDustEnabled,
        uDustDensityMin: u.uDustDensityMin,
        uDustLogRatio: u.uDustLogRatio,
        uParticleStrength: { value: 0.0 },
      },
      vertexShader: dustParticleVert,
      fragmentShader: dustParticleFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2; // after disc + glow passes
    this.mesh.visible = false; // hidden until strength > 0
    this.scene.add(this.mesh);
  }

  /** User-facing visibility knob. 0 = hidden (default); higher = stronger
   *  additive contribution. The mesh is hidden entirely at strength 0 so
   *  the GPU draw call is skipped. No-op before attach(). */
  setStrength(x: number) {
    if (!this.material || !this.mesh) return;
    const v = Math.max(0, x);
    this.material.uniforms.uParticleStrength.value = v;
    this.mesh.visible = v > 0;
  }

  // Two callers: attach() (removeFromScene: true — pull old mesh before
  // adding new one) and Stellata.dispose (default false — whole scene is
  // GC-bound). Both must release geometry + material; one owner means a
  // third resource can't be forgotten in one of the two cleanup paths.
  dispose(opts: { removeFromScene: boolean } = { removeFromScene: false }) {
    if (!this.mesh) return;
    if (opts.removeFromScene) this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
  }
}
