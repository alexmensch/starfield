// Global planet-body field (stellata-3re.15 / 3re.16 / bk5 prep).
//
// One instanced mesh holding every attached host's planet bodies. v1
// attaches Sol once at startup; the exoplanet epic (stellata-bk5)
// will iterate through additional hosts as their per-star
// PlanetSystem shards land.
//
// # Why a global field instead of per-host instances
//
// Bodies are PHYSICAL objects — they exist whether or not the camera
// is focused on their host. Per the unfocus-split rule (3re.15) we
// keep them rendering when the host loses focus, gated only by:
//   • per-planet apparent-magnitude visibility (3re.16);
//   • a per-host distance cull (CPU-side optimisation that skips the
//     ephemeris + buffer upload for hosts whose brightest planet is
//     already below the slider cutoff at the current camera distance).
//
// At bk5 scale (potentially hundreds of attached hosts) we cannot
// afford per-host THREE.Mesh instances. One InstancedBufferGeometry
// holds all of them; the per-host distance cull handles the bulk
// rejection.
//
// # Render passes
//
// Four materials share the geometry (same pattern as the star
// pipeline, plus an outer-disc occluder for orbit rings):
//   • disc  — per-channel-max, depth-write on (close-range resolved)
//   • glow  — additive, depth-test on (distant point glow)
//   • core  — depth-only mask, colorWrite off (occludes background
//             layers behind close planet cores)
//   • outer — depth-only mask across the full visible disc, colorWrite
//             off; renders before orbit rings so the rings are occluded
//             by the full disc rather than just the bright core
//             (stellata-3re.19). Sits after background layers in render
//             order so MW / clouds remain visible through the soft halo.
//
// uRenderMode is the only divergent uniform. Everything else
// (apparent-mag math, view-space distances, perceptual-disc shaping)
// is computed once per quad regardless of which pass is drawing it.

import * as THREE from 'three';
import type { PlanetSystem } from './planet-system';
import { applyDiscBlendDefaults } from './stellata';
import {
  AU_PC,
  KM_PC,
  orbitalPlaneNormalFor,
  placeholderEccentricAnomaly,
  planetLocalPosition,
  solidityForType,
} from './orbit-rings-layer';
import planetVert from './shaders/planet.vert.glsl?raw';
import planetFrag from './shaders/planet.frag.glsl?raw';

/**
 * Shared per-frame uniforms the body materials read from. The star
 * pipeline owns the canonical references (initialised once in
 * stellata.ts and mutated as state changes); the body materials hold
 * pointers to the same `{ value }` objects so a single update on the
 * star side propagates everywhere.
 */
export interface PlanetMaterialUniforms {
  uMaxAppMag: { value: number };
  uSizeMin: { value: number };
  uSizeMax: { value: number };
  uSizeSpan: { value: number };
  uSizeKnee: { value: number };
  uVisibleThreshold: { value: number };
  uVisibleK: { value: number };
  uCoreThreshold: { value: number };
  uDiscardThreshold: { value: number };
  uDistNMin: { value: number };
  uDistNMax: { value: number };
  uLumBiasMin: { value: number };
  uLumBiasMax: { value: number };
  uViewport: { value: THREE.Vector2 };
  uPixelRatio: { value: number };
  uFovYRad: { value: number };
}

// Initial slot capacity. v1 attaches Sol (9 planets) once; bk5 may
// grow this as exoplanet hosts come online. Resizing reallocates the
// instanced attribute buffers — relatively cheap compared to a frame.
const INITIAL_CAPACITY = 16;

/**
 * Maximum d_v_p at which any planet of an attached host could plausibly
 * cross the magnitude cutoff. Closed-form solution of the apparent-mag
 * equation evaluated at the brightest planet's `p · (R/a)²` (the
 * geometry-independent reflectance proxy):
 *
 *   m_planet ≈ M_host + 5·log10(d/10) − 2.5·log10(p · (R/a)²)
 *
 * Set m_planet = maxAppMag and solve for d:
 *
 *   d_cull = 10 pc · √(p · (R/a)²) · 10^((maxAppMag − M_host) / 5)
 *         = 10 pc · sqrt(p) · (R/a) · 10^((maxAppMag − M_host) / 5)
 *
 * The actual apparent-mag formula has a φ(α) factor in [0, 1], so the
 * real visibility threshold is at d ≤ d_cull. Using d_cull as the
 * outer bound is conservative (we keep working a host that could in
 * principle still be visible).
 *
 * Pure function — exported for tests.
 */
export function cullDistancePc(
  hostAbsmag: number,
  brightestReflectance: number,
  maxAppMag: number,
): number {
  if (brightestReflectance <= 0) return 0;
  const distanceFactor = 10 ** ((maxAppMag - hostAbsmag) / 5);
  return 10 * Math.sqrt(brightestReflectance) * distanceFactor;
}

interface AttachedHost {
  hostStarIdx: number;
  ps: PlanetSystem;
  hostAbsmag: number;
  /** Absolute (catalog-space) host position in pc. Static for the
   *  session — used to recompute hostLocalPos whenever worldOffset
   *  changes. */
  hostAbsPos: THREE.Vector3;
  /** Cached host-local-frame position (= hostAbsPos − worldOffset). */
  hostLocalPos: THREE.Vector3;
  /** ICRS-aligned orbital-plane orientation for this host. */
  orientation: THREE.Quaternion;
  positionsAt: ((t: number, out: Float32Array) => void) | null;
  positionsScratch: Float32Array | null;
  /** max over planets of `p · (R / a)²` — the geometry-independent
   *  reflectance proxy. Drives cullDistancePc. */
  brightestReflectance: number;
  /** Cached cull distance for the current maxAppMag. */
  cullDistance: number;
  /** Slot range in the global instanced buffer. */
  startInstance: number;
  count: number;
}

export class PlanetBodyField {
  readonly group: THREE.Group;
  private mono = false;
  private hidden = false;
  private hosts = new Map<number, AttachedHost>();
  private capacity = INITIAL_CAPACITY;
  private liveCount = 0;
  private worldOffset = new THREE.Vector3();
  private maxAppMag: number;
  // Per-instance attribute buffers. Re-allocated on capacity grow.
  private bufLocalRel!: Float32Array;
  private bufHostLocalPos!: Float32Array;
  private bufRadius!: Float32Array;
  private bufColour!: Float32Array;
  private bufSolidity!: Float32Array;
  private bufAlbedo!: Float32Array;
  private bufHostAbsmag!: Float32Array;
  private geometry!: THREE.InstancedBufferGeometry;
  private matDisc!: THREE.ShaderMaterial;
  private matGlow!: THREE.ShaderMaterial;
  private matCore!: THREE.ShaderMaterial;
  private matOuter!: THREE.ShaderMaterial;
  private meshDisc!: THREE.Mesh;
  private meshGlow!: THREE.Mesh;
  private meshCore!: THREE.Mesh;
  private meshOuter!: THREE.Mesh;
  // Reusable scratch — avoids per-frame allocation in update().
  private rotateTmp = new THREE.Vector3();

  constructor(magnitudeShared: PlanetMaterialUniforms) {
    this.maxAppMag = magnitudeShared.uMaxAppMag.value;
    this.group = new THREE.Group();
    this.group.visible = false;
    // PlanetBodyField sits in the renderer's local frame (no group
    // translation). iHostLocalPos delivers each host's offset from
    // world-local origin per-instance; the shader does the rest.
    this.allocateBuffers(this.capacity);
    this.buildGeometry();
    this.buildMaterials(magnitudeShared);
  }

  /**
   * Attach a planet system to the global field. Idempotent — calling
   * with an already-attached host idx replaces its data without
   * compacting the buffer (the new instance range may shift).
   *
   * `hostAbsPos` is the host's absolute (catalog-space) position in
   * pc. The class converts to local-frame each time `recenter()`
   * fires.
   */
  attachHost(
    hostStarIdx: number,
    ps: PlanetSystem,
    hostAbsmag: number,
    hostAbsPos: Readonly<THREE.Vector3>,
    solIndex: number,
  ): void {
    if (ps.planets.length === 0) return;
    if (this.hosts.has(hostStarIdx)) this.detachHost(hostStarIdx);

    const n = ps.planets.length;
    while (this.liveCount + n > this.capacity) {
      this.growCapacity();
    }

    const planeNormal = orbitalPlaneNormalFor(ps.hostStarIdx, solIndex);
    const orientation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      planeNormal,
    );

    let brightestReflectance = 0;
    for (const planet of ps.planets) {
      const aPc = planet.semiMajorAxisAu * AU_PC;
      const RoverA = (planet.radiusKm * KM_PC) / Math.max(aPc, 1e-30);
      const refl = planet.albedo * RoverA * RoverA;
      if (refl > brightestReflectance) brightestReflectance = refl;
    }

    const host: AttachedHost = {
      hostStarIdx,
      ps,
      hostAbsmag,
      hostAbsPos: new THREE.Vector3().copy(hostAbsPos),
      hostLocalPos: new THREE.Vector3().copy(hostAbsPos).sub(this.worldOffset),
      orientation,
      positionsAt: ps.positionsAt ?? null,
      positionsScratch: ps.positionsAt ? new Float32Array(n * 3) : null,
      brightestReflectance,
      cullDistance: cullDistancePc(hostAbsmag, brightestReflectance, this.maxAppMag),
      startInstance: this.liveCount,
      count: n,
    };
    this.hosts.set(hostStarIdx, host);
    this.liveCount += n;

    // Initial fill — bodies, host position, and one immediate
    // ephemeris-or-placeholder pass so the first frame after attach
    // has valid iLocalRel data.
    this.writeHostStaticAttributes(host);
    this.writeHostPositions(host, Date.now() / 1000);
    this.flushAttributeRange(host.startInstance, host.count);
    this.geometry.instanceCount = this.liveCount;
    this.group.visible = !this.hidden && !this.mono;
  }

  detachHost(hostStarIdx: number): void {
    const host = this.hosts.get(hostStarIdx);
    if (!host) return;
    // Compact: shift any later hosts down to fill the gap so the
    // buffer stays packed. v1 only ever attaches Sol once and never
    // detaches, so this path is exercised by future bk5 lifecycle
    // changes — keep the implementation simple, not blazing fast.
    const tailStart = host.startInstance + host.count;
    const shiftCount = this.liveCount - tailStart;
    if (shiftCount > 0) {
      this.shiftInstancesDown(tailStart, shiftCount, host.count);
      for (const h of this.hosts.values()) {
        if (h.startInstance >= tailStart) {
          h.startInstance -= host.count;
        }
      }
    }
    this.liveCount -= host.count;
    this.geometry.instanceCount = this.liveCount;
    this.flushAllAttributes();
    this.hosts.delete(hostStarIdx);
    if (this.liveCount === 0) this.group.visible = false;
  }

  /**
   * Adjust each attached host's local-frame position when the
   * floating-origin shifts. Cheap — a vector subtract per host plus
   * a buffer write. Called once by `Stellata.recenterOrigin`.
   */
  recenter(newWorldOffset: Readonly<THREE.Vector3>): void {
    if (newWorldOffset.equals(this.worldOffset)) return;
    this.worldOffset.copy(newWorldOffset);
    for (const host of this.hosts.values()) {
      host.hostLocalPos.copy(host.hostAbsPos).sub(this.worldOffset);
      this.writeHostLocalPos(host);
    }
    this.flushAttributeRange(0, this.liveCount);
  }

  /**
   * Recompute per-host cull distances when the magnitude slider
   * moves. Stellata.ts calls this from `setFilter` whenever
   * `maxAppMag` changes.
   */
  setMaxAppMag(maxAppMag: number): void {
    if (this.maxAppMag === maxAppMag) return;
    this.maxAppMag = maxAppMag;
    for (const host of this.hosts.values()) {
      host.cullDistance = cullDistancePc(host.hostAbsmag, host.brightestReflectance, maxAppMag);
    }
  }

  /**
   * Per-frame ephemeris refresh + buffer upload. For each attached
   * host, skip the work entirely when the camera is past `cullDistance`
   * — the planets would be sub-cutoff anyway and stale iLocalRel data
   * is harmless once the host comes back into range.
   */
  update(camera: THREE.PerspectiveCamera, t: number): void {
    if (this.hidden || this.mono || this.liveCount === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    let touched = false;
    for (const host of this.hosts.values()) {
      const dToHost = camera.position.distanceTo(host.hostLocalPos);
      if (dToHost > host.cullDistance) continue;
      if (host.positionsAt) {
        this.writeHostPositions(host, t);
        touched = true;
      }
    }
    if (touched) this.flushAttributeRange(0, this.liveCount);
  }

  /**
   * Read-only slice of the focused host's planet local-frame positions.
   * Layout: 3 floats per planet, ordering matches PlanetSystem.planets.
   * Returns null when the host isn't attached.
   *
   * The planet-labels overlay reads this so labels project to the same
   * positions the body shader renders at, without re-running the
   * Keplerian math itself.
   */
  getHostLocalPositions(hostStarIdx: number): Float32Array | null {
    const host = this.hosts.get(hostStarIdx);
    if (!host) return null;
    return this.bufLocalRel.subarray(
      host.startInstance * 3,
      (host.startInstance + host.count) * 3,
    );
  }

  setMonochrome(on: boolean): void {
    this.mono = on;
    if (on) this.group.visible = false;
    else this.group.visible = !this.hidden && this.liveCount > 0;
  }

  setHidden(on: boolean): void {
    this.hidden = on;
    if (on) this.group.visible = false;
    else this.group.visible = !this.mono && this.liveCount > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.matDisc.dispose();
    this.matGlow.dispose();
    this.matCore.dispose();
    this.matOuter.dispose();
  }

  // ── private ─────────────────────────────────────────────────────────

  private allocateBuffers(capacity: number): void {
    this.bufLocalRel = new Float32Array(capacity * 3);
    this.bufHostLocalPos = new Float32Array(capacity * 3);
    this.bufRadius = new Float32Array(capacity);
    this.bufColour = new Float32Array(capacity * 3);
    this.bufSolidity = new Float32Array(capacity);
    this.bufAlbedo = new Float32Array(capacity);
    this.bufHostAbsmag = new Float32Array(capacity);
  }

  private growCapacity(): void {
    const newCap = this.capacity * 2;
    const oldLocalRel = this.bufLocalRel;
    const oldHostLocal = this.bufHostLocalPos;
    const oldRadius = this.bufRadius;
    const oldColour = this.bufColour;
    const oldSolidity = this.bufSolidity;
    const oldAlbedo = this.bufAlbedo;
    const oldAbsmag = this.bufHostAbsmag;
    this.allocateBuffers(newCap);
    this.bufLocalRel.set(oldLocalRel);
    this.bufHostLocalPos.set(oldHostLocal);
    this.bufRadius.set(oldRadius);
    this.bufColour.set(oldColour);
    this.bufSolidity.set(oldSolidity);
    this.bufAlbedo.set(oldAlbedo);
    this.bufHostAbsmag.set(oldAbsmag);
    this.capacity = newCap;
    // Replace the geometry with a fresh one over the new buffers.
    // Materials and meshes are re-bound via three.js's normal
    // geometry-swap path.
    const old = this.geometry;
    this.buildGeometry();
    this.meshDisc.geometry = this.geometry;
    this.meshGlow.geometry = this.geometry;
    this.meshCore.geometry = this.geometry;
    this.meshOuter.geometry = this.geometry;
    old.dispose();
  }

  private buildGeometry(): void {
    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute(
      'aCorner',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
        2,
      ),
    );
    geom.setIndex([0, 1, 2, 1, 3, 2]);
    geom.setAttribute('iLocalRel', new THREE.InstancedBufferAttribute(this.bufLocalRel, 3));
    geom.setAttribute('iHostLocalPos', new THREE.InstancedBufferAttribute(this.bufHostLocalPos, 3));
    geom.setAttribute('iRadiusPc', new THREE.InstancedBufferAttribute(this.bufRadius, 1));
    geom.setAttribute('iColour', new THREE.InstancedBufferAttribute(this.bufColour, 3));
    geom.setAttribute('iSolidity', new THREE.InstancedBufferAttribute(this.bufSolidity, 1));
    geom.setAttribute('iAlbedoP', new THREE.InstancedBufferAttribute(this.bufAlbedo, 1));
    geom.setAttribute('iHostAbsmag', new THREE.InstancedBufferAttribute(this.bufHostAbsmag, 1));
    geom.instanceCount = this.liveCount;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geom;
  }

  private buildMaterials(sm: PlanetMaterialUniforms): void {
    const sharedPlanetUniforms = {
      uMaxAppMag: sm.uMaxAppMag,
      uSizeMin: sm.uSizeMin,
      uSizeMax: sm.uSizeMax,
      uSizeSpan: sm.uSizeSpan,
      uSizeKnee: sm.uSizeKnee,
      uVisibleThreshold: sm.uVisibleThreshold,
      uVisibleK: sm.uVisibleK,
      uCoreThreshold: sm.uCoreThreshold,
      uDiscardThreshold: sm.uDiscardThreshold,
      uDistNMin: sm.uDistNMin,
      uDistNMax: sm.uDistNMax,
      uLumBiasMin: sm.uLumBiasMin,
      uLumBiasMax: sm.uLumBiasMax,
      uViewport: sm.uViewport,
      uPixelRatio: sm.uPixelRatio,
      uFovYRad: sm.uFovYRad,
    };

    this.matDisc = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: planetVert,
      fragmentShader: planetFrag,
      transparent: true,
      uniforms: { ...sharedPlanetUniforms, uRenderMode: { value: 1 } },
    });
    applyDiscBlendDefaults(this.matDisc);

    this.matGlow = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: planetVert,
      fragmentShader: planetFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: { ...sharedPlanetUniforms, uRenderMode: { value: 0 } },
    });

    this.matCore = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: planetVert,
      fragmentShader: planetFrag,
      depthWrite: true,
      depthTest: true,
      colorWrite: false,
      uniforms: { ...sharedPlanetUniforms, uRenderMode: { value: 2 } },
    });

    // transparent: true puts this material in the transparent queue so
    // its renderOrder (1.5) is honoured relative to the orbit-rings
    // layer (renderOrder 2) — opaque always draws before transparent.
    this.matOuter = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: planetVert,
      fragmentShader: planetFrag,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      colorWrite: false,
      uniforms: { ...sharedPlanetUniforms, uRenderMode: { value: 3 } },
    });

    this.meshDisc = new THREE.Mesh(this.geometry, this.matDisc);
    this.meshDisc.frustumCulled = false;
    this.meshDisc.renderOrder = 3;
    this.meshGlow = new THREE.Mesh(this.geometry, this.matGlow);
    this.meshGlow.frustumCulled = false;
    this.meshGlow.renderOrder = 4;
    this.meshCore = new THREE.Mesh(this.geometry, this.matCore);
    this.meshCore.frustumCulled = false;
    this.meshCore.renderOrder = -4;
    this.meshOuter = new THREE.Mesh(this.geometry, this.matOuter);
    this.meshOuter.frustumCulled = false;
    this.meshOuter.renderOrder = 1.5;

    this.group.add(this.meshCore);
    this.group.add(this.meshOuter);
    this.group.add(this.meshDisc);
    this.group.add(this.meshGlow);
  }

  /** One-shot fill of static per-instance attributes (radius, colour,
   *  solidity, albedo, host absmag) for a freshly-attached host. */
  private writeHostStaticAttributes(host: AttachedHost): void {
    const baseScalar = host.startInstance;
    const baseVec3 = host.startInstance * 3;
    for (let i = 0; i < host.count; i++) {
      const planet = host.ps.planets[i];
      this.bufRadius[baseScalar + i] = planet.radiusKm * KM_PC;
      this.bufColour[baseVec3 + i * 3 + 0] = planet.colour[0];
      this.bufColour[baseVec3 + i * 3 + 1] = planet.colour[1];
      this.bufColour[baseVec3 + i * 3 + 2] = planet.colour[2];
      this.bufSolidity[baseScalar + i] = solidityForType(planet.type);
      this.bufAlbedo[baseScalar + i] = planet.albedo;
      this.bufHostAbsmag[baseScalar + i] = host.hostAbsmag;
    }
    this.writeHostLocalPos(host);
  }

  /** Write the host's renderer-local position into the iHostLocalPos
   *  slots of all of its planet instances. */
  private writeHostLocalPos(host: AttachedHost): void {
    const base = host.startInstance * 3;
    const x = host.hostLocalPos.x;
    const y = host.hostLocalPos.y;
    const z = host.hostLocalPos.z;
    for (let i = 0; i < host.count; i++) {
      this.bufHostLocalPos[base + i * 3 + 0] = x;
      this.bufHostLocalPos[base + i * 3 + 1] = y;
      this.bufHostLocalPos[base + i * 3 + 2] = z;
    }
  }

  /** Resolve planet positions at time `t` and write them to the
   *  host's iLocalRel slots. Uses the host's positionsAt resolver
   *  when present (Sol via JPL Standish), else the placeholder
   *  eccentric-anomaly layout. */
  private writeHostPositions(host: AttachedHost, t: number): void {
    const base = host.startInstance * 3;
    if (host.positionsAt && host.positionsScratch) {
      host.positionsAt(t, host.positionsScratch);
      this.rotateInto(
        host.positionsScratch,
        this.bufLocalRel,
        base,
        host.orientation,
      );
    } else {
      const tmp = this.rotateTmp;
      for (let i = 0; i < host.count; i++) {
        const p = host.ps.planets[i];
        const ea = placeholderEccentricAnomaly(i, host.count);
        planetLocalPosition(p.semiMajorAxisAu, p.eccentricity, ea, host.orientation, tmp);
        this.bufLocalRel[base + i * 3 + 0] = tmp.x;
        this.bufLocalRel[base + i * 3 + 1] = tmp.y;
        this.bufLocalRel[base + i * 3 + 2] = tmp.z;
      }
    }
  }

  /** Rotate a flat plane-frame xyz buffer into ICRS-aligned local frame
   *  and write it at `dstStart` in `dst`. */
  private rotateInto(
    src: Float32Array,
    dst: Float32Array,
    dstStart: number,
    orientation: THREE.Quaternion,
  ): void {
    const tmp = this.rotateTmp;
    const n = src.length;
    for (let i = 0; i < n; i += 3) {
      tmp.set(src[i], src[i + 1], src[i + 2]);
      tmp.applyQuaternion(orientation);
      dst[dstStart + i + 0] = tmp.x;
      dst[dstStart + i + 1] = tmp.y;
      dst[dstStart + i + 2] = tmp.z;
    }
  }

  /** Mark all instance attributes dirty so three.js uploads them on
   *  the next render. Called after any buffer mutation that affects
   *  the visible region. */
  private flushAttributeRange(_start: number, _count: number): void {
    if (!this.geometry) return;
    // three.js doesn't currently support partial-range InstancedBuffer
    // updates without `updateRanges`; full-buffer dirty is the
    // pragmatic path. At Sol-only scale this is a 7-attr × 9-instance
    // upload — fast. bk5 may need range-based updates.
    const attrs = this.geometry.attributes;
    (attrs.iLocalRel as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iHostLocalPos as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iRadiusPc as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iColour as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iSolidity as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iAlbedoP as THREE.InstancedBufferAttribute).needsUpdate = true;
    (attrs.iHostAbsmag as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  private flushAllAttributes(): void {
    this.flushAttributeRange(0, this.liveCount);
  }

  /** Compact-down step used by detachHost(). Shifts a contiguous tail
   *  range backwards by `gap` slots in every per-instance buffer. */
  private shiftInstancesDown(tailStart: number, tailCount: number, gap: number): void {
    const shiftScalar = (buf: Float32Array, dim: number) => {
      const tailBase = tailStart * dim;
      const tailEnd = tailBase + tailCount * dim;
      buf.copyWithin(tailBase - gap * dim, tailBase, tailEnd);
    };
    shiftScalar(this.bufLocalRel, 3);
    shiftScalar(this.bufHostLocalPos, 3);
    shiftScalar(this.bufRadius, 1);
    shiftScalar(this.bufColour, 3);
    shiftScalar(this.bufSolidity, 1);
    shiftScalar(this.bufAlbedo, 1);
    shiftScalar(this.bufHostAbsmag, 1);
  }
}
