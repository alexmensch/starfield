// Progressive loader for the 3D dust-extinction voxel grid.
//
// The grid is large (~128 MiB) so we never block the initial render on it.
// Instead:
//   1. We allocate a zero-filled Data3DTexture upfront and force its GPU
//      upload via renderer.initTexture(). Zero density = no extinction, so
//      the scene renders exactly as it does today while the dust is missing.
//   2. We fetch manifest.json + all 64 chunk files in parallel (with a small
//      concurrency cap so mobile browsers don't choke) in priority order
//      (closest chunks to the camera first).
//   3. Each arriving chunk is uploaded into the appropriate sub-volume of
//      the GPU texture via gl.texSubImage3D. Subsequent frames sample the
//      newly-populated region automatically.
//
// The format must stay in sync with scripts/build-dust.py — both derive
// constants from the manifest at runtime, so bumping gridSize/chunkSize/
// bounds in the Python script automatically flows through here.

import * as THREE from 'three';

export interface DustManifest {
  version: number;
  format: string;
  synthetic: boolean;
  gridSize: number;
  chunkSize: number;
  chunksPerAxis: number;
  totalChunks: number;
  boundsPc: [number, number];
  voxelSizePc: number;
  densityMin: number;
  densityMax: number;
  avPerDensityPerPc: number;
  chunks: DustChunkMeta[];
  particles?: { file: string; count: number };
}

/** Pre-computed dust particle cloud — importance-sampled positions +
 *  densities to render as additive billboards. Replaces the abandoned
 *  fullscreen-fog raymarch (which had unfixable banding/jitter at far
 *  zoom). Format: 16-byte header ('PART' magic + version + count) then
 *  N × 16 bytes of (x, y, z, density) float32 records. */
export interface DustParticleData {
  count: number;
  /** Float32Array of length count × 3, xyz triples in absolute ICRS pc. */
  positions: Float32Array;
  /** Float32Array of length count, raw density values from the source grid. */
  densities: Float32Array;
}

export async function loadDustParticles(
  baseUrl: string,
  meta: { file: string; count: number },
): Promise<DustParticleData | null> {
  try {
    const res = await fetch(`${baseUrl}${meta.file}`);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const view = new DataView(ab);
    const magic = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
    );
    if (magic !== 'PART') {
      console.warn(`dust particles: bad magic '${magic}'`);
      return null;
    }
    const version = view.getUint32(4, true);
    if (version !== 1) {
      console.warn(`dust particles: unsupported version ${version}`);
      return null;
    }
    const count = view.getUint32(8, true);
    if (count !== meta.count) {
      console.warn(`dust particles: count mismatch (manifest ${meta.count}, file ${count})`);
    }
    // Records start at byte 16. 4 floats per record (xyz + density),
    // interleaved. Split into separate xyz and density typed arrays so
    // the GPU instance attributes can bind directly.
    const positions = new Float32Array(count * 3);
    const densities = new Float32Array(count);
    const records = new Float32Array(ab, 16, count * 4);
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = records[i * 4 + 0];
      positions[i * 3 + 1] = records[i * 4 + 1];
      positions[i * 3 + 2] = records[i * 4 + 2];
      densities[i] = records[i * 4 + 3];
    }
    return { count, positions, densities };
  } catch (err) {
    console.warn('dust particles: load failed', err);
    return null;
  }
}

export interface DustChunkMeta {
  ix: number;
  iy: number;
  iz: number;
  file: string;
  bytes: number;
  sha256: string;
  centerPc: [number, number, number];
}

export interface DustFieldParams {
  boundsHalfPc: number;      // 1250
  densityMin: number;        // 1e-7
  densityMax: number;        // autotuned from data (~1e-3)
  avPerDensityPerPc: number; // 2.742
  // Shader decode: density = densityMin * pow(ratio, sample).
  // Precomputed: ratio = densityMax / densityMin, logRatio = ln(ratio).
  logRatio: number;
}

export interface DustLoadProgress {
  loaded: number;
  total: number;
  synthetic: boolean;
}

const MAX_CONCURRENT_FETCHES = 6;

export class DustField {
  readonly texture: THREE.Data3DTexture;
  readonly params: DustFieldParams;
  readonly manifest: DustManifest;

  // Track chunk-load completion so consumers can surface a subtle progress
  // indicator if desired. A listener is called after every chunk-upload.
  private listeners: Array<(p: DustLoadProgress) => void> = [];
  private loadedCount = 0;

  private renderer: THREE.WebGLRenderer;
  private baseUrl: string;

  constructor(renderer: THREE.WebGLRenderer, baseUrl: string, manifest: DustManifest) {
    this.renderer = renderer;
    this.baseUrl = baseUrl;
    this.manifest = manifest;

    const n = manifest.gridSize;
    const data = new Uint8Array(n * n * n); // zero-filled → no extinction yet
    const tex = new THREE.Data3DTexture(data, n, n, n);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;

    // Force initial GPU allocation so subsequent texSubImage3D uploads have
    // a valid texture object to target. Without this the first chunk
    // upload would fail silently (no storage allocated yet).
    renderer.initTexture(tex);

    this.texture = tex;
    this.params = {
      boundsHalfPc: Math.abs(manifest.boundsPc[1]),
      densityMin: manifest.densityMin,
      densityMax: manifest.densityMax,
      avPerDensityPerPc: manifest.avPerDensityPerPc,
      logRatio: Math.log(manifest.densityMax / manifest.densityMin),
    };
  }

  onProgress(h: (p: DustLoadProgress) => void) {
    this.listeners.push(h);
  }

  /** Kick off background downloads. Resolves when every chunk has been
   *  fetched + uploaded, but callers typically fire-and-forget — the
   *  texture is usable the whole time; it just gets denser as chunks land. */
  async startLoading(): Promise<void> {
    // Priority: closest-to-origin first. When the user later flies far from
    // Sol the camera is typically revisiting the dense inner volume we've
    // already loaded; the far-corner chunks only matter for distant-fog
    // rendering which is a secondary concern anyway.
    const ordered = [...this.manifest.chunks].sort((a, b) => {
      const da = a.centerPc[0] ** 2 + a.centerPc[1] ** 2 + a.centerPc[2] ** 2;
      const db = b.centerPc[0] ** 2 + b.centerPc[1] ** 2 + b.centerPc[2] ** 2;
      return da - db;
    });

    // Simple semaphore — cap parallel fetches so mobile Safari doesn't
    // hang with 64 inflight requests. Workers static assets are served
    // HTTP/2 so a handful of parallel streams is plenty.
    let i = 0;
    const worker = async () => {
      while (i < ordered.length) {
        const idx = i++;
        const chunk = ordered[idx];
        try {
          await this.fetchAndUpload(chunk);
          this.loadedCount++;
          for (const h of this.listeners) {
            h({
              loaded: this.loadedCount,
              total: this.manifest.totalChunks,
              synthetic: this.manifest.synthetic,
            });
          }
        } catch (err) {
          // One bad chunk shouldn't prevent the rest from loading — the
          // unaffected regions still render correctly. Log and continue.
          console.warn(`dust chunk ${chunk.file} failed:`, err);
        }
      }
    };
    const workers = Array.from({ length: MAX_CONCURRENT_FETCHES }, worker);
    await Promise.all(workers);
  }

  private async fetchAndUpload(chunk: DustChunkMeta): Promise<void> {
    const res = await fetch(`${this.baseUrl}${chunk.file}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== chunk.bytes) {
      throw new Error(`size mismatch: ${buf.byteLength} vs ${chunk.bytes}`);
    }
    this.uploadChunk(chunk, new Uint8Array(buf));
  }

  private uploadChunk(chunk: DustChunkMeta, data: Uint8Array) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    // Three.js stashes the GL handle on a "properties" side-map keyed off
    // the texture. Accessing it is a published pattern for low-level
    // interop (see renderer.copyTextureToTexture3D for the same trick),
    // though technically undocumented — if three rearranges this in a
    // future major we'll need to revisit.
    const props = (this.renderer as unknown as {
      properties: { get: (tex: THREE.Texture) => { __webglTexture?: WebGLTexture } };
    }).properties;
    const glTex = props.get(this.texture).__webglTexture;
    if (!glTex) {
      // Can happen if initTexture hasn't flushed yet (rare); skip this
      // chunk silently and the caller's listeners will see us fall one
      // short of total. Alternative would be to defer upload a frame.
      console.warn('dust texture not yet GPU-resident, dropping chunk');
      return;
    }
    gl.bindTexture(gl.TEXTURE_3D, glTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const c = this.manifest.chunkSize;
    // Chunk bytes are z-major per the Python writer (innermost=x), which
    // matches WebGL's width/height/depth interpretation of texSubImage3D.
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      chunk.ix * c, chunk.iy * c, chunk.iz * c, // offsets
      c, c, c,                                   // size
      gl.RED,
      gl.UNSIGNED_BYTE,
      data,
    );
  }
}

/** Fetch manifest.json. Returns null (without throwing) if the manifest
 *  is missing — dust is an optional feature and its absence should leave
 *  the existing renderer untouched. */
export async function loadDustManifest(baseUrl: string): Promise<DustManifest | null> {
  try {
    const res = await fetch(`${baseUrl}manifest.json`);
    if (!res.ok) return null;
    return (await res.json()) as DustManifest;
  } catch {
    return null;
  }
}
