#!/usr/bin/env python3
"""Resample the Edenhofer+ 2023 3D dust map onto a Cartesian voxel grid and
emit it as 64 chunks for progressive client-side loading.

Output format (canonical; must stay in sync with src/client/dust-loader.ts):

  data/dust/
    manifest.json          # grid params, chunk index, encoding constants
    chunk_XXX_YYY_ZZZ.bin  # raw uint8 voxels, 128**3 = 2,097,152 bytes each

Grid:
  - 512**3 voxels total, split into 4**3 = 64 chunks of 128**3.
  - Covers a symmetric cube [-1250, +1250] pc on each axis in heliocentric
    equatorial (ICRS) Cartesian coordinates. Matches the frame of
    catalog.bin, so the renderer can sample the texture using the same
    star xyz positions without any rotation.
  - Voxel size = 2500 / 512 ≈ 4.883 pc.

Encoding:
  Edenhofer density spans ~6 orders of magnitude (1e-7 diffuse ISM to
  ~1e-1 dense cloud cores). Linear or log1p encoding collapses this range
  poorly — most voxels end up at uint8=0 while dense cores saturate at
  uint8=255. We use pure log encoding over a fixed [DENSITY_MIN,
  DENSITY_MAX] window instead:

    log_clamped = log10(clamp(d, d_min, d_max))
    encoded     = round(255 * (log_clamped - log10(d_min)) / log10(d_max/d_min))
    decoded     = d_min * pow(d_max/d_min, encoded/255)   # shader does this

  DENSITY_MIN is well below the noise floor (~1e-7) so "empty" voxels
  decode to a vanishingly small density that integrates to < 0.01 mag A_V
  over any realistic sightline. DENSITY_MAX covers the 99.95th percentile
  of real data — the few hundred voxels above it saturate to 255 but still
  decode as "very dense" so the visual effect is preserved.

Usage:
  python3 scripts/build-dust.py                 # fetch + resample real map (main flavor)
  python3 scripts/build-dust.py --synthetic     # fake pattern for dev
  python3 scripts/build-dust.py --flavor less_data_but_2kpc   # extended-range validation run

The real mode needs `pip install -r scripts/requirements-dust.txt` and
downloads ~3.2 GB via `dustmaps` on first run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

# Canonical grid params — changing any of these is a format version bump.
GRID_SIZE = 512
CHUNK_SIZE = 128
CHUNKS_PER_AXIS = GRID_SIZE // CHUNK_SIZE   # 4
BOUNDS_PC = 1250.0                          # half-extent; full cube is 2*bounds
VOXEL_SIZE_PC = 2.0 * BOUNDS_PC / GRID_SIZE  # ≈ 4.883

# Encoding params. DENSITY_MIN is fixed below the real-data noise floor;
# DENSITY_MAX is autotuned from the 99.95th percentile of nonzero voxels so
# the brightest cores saturate but the bulk of the range is unsaturated.
# Synthetic mode uses the same DENSITY_MIN and a fixed DENSITY_MAX matching
# the real-data scale, so both pipelines share a single shader decode.
DENSITY_MIN = 1e-7
DENSITY_MAX_SYNTHETIC = 0.1
DENSITY_MAX_PERCENTILE = 99.95

# Particle cloud — for visualising dust as discrete additive billboards
# (replaces the fullscreen raymarch fog, which had unfixable banding/
# jitter at far zoom). Particles are importance-sampled with probability
# proportional to voxel density: dense regions get many particles, diffuse
# regions get few or none. The result is a smooth-looking cloud with no
# voxel aliasing because adjacent particles are at different sub-voxel
# positions (per-particle jitter).
PARTICLE_COUNT_DEFAULT = 50_000
# Voxels below this density threshold contribute no particles — keeps the
# sampling concentrated where there's actually visible structure.
PARTICLE_DENSITY_THRESHOLD = 1e-6

# Zhang-Green-Rix 2023 "E" unit → V-band extinction. Edenhofer outputs
# density in units of E_ZGR per parsec, so path-integral × this factor
# yields A_V magnitudes. Reference: Zhang, Green & Rix 2023 (Zenodo
# 10.5281/zenodo.6674521) — A_V / E_ZGR ≈ 2.742 at V (551 nm). Applied at
# runtime in the shader, NOT baked into the stored density, so we can
# retune without re-encoding.
ZGR_TO_AV = 2.742   # mag A_V per E_ZGR (dimensionless)

# Sanity check: Aquila Rift at ~200 pc, peak density ~0.05 E_ZGR/pc,
# sightline 200 pc → 10 E_ZGR → 27 mag A_V peak-through-the-densest-filament
# (matches published values; most real sightlines clip far below this).

ROOT = Path(__file__).resolve().parent.parent
DATA_DUST = ROOT / "data" / "dust"
PUBLIC_DUST = ROOT / "public" / "dust"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--synthetic", action="store_true",
                        help="Generate a test-pattern voxel grid without any real data.")
    parser.add_argument("--flavor", default="main", choices=["main", "less_data_but_2kpc"],
                        help="Edenhofer map flavor: 'main' is 1.25 kpc standard, "
                             "'less_data_but_2kpc' is a validation run extending to 2 kpc.")
    parser.add_argument("--output", type=Path, default=DATA_DUST,
                        help=f"Output directory for chunks + manifest (default: {DATA_DUST.relative_to(ROOT)}).")
    parser.add_argument("--skip-public", action="store_true",
                        help="Skip mirroring to public/dust/ (useful for alt output dirs).")
    parser.add_argument("--force-resample", action="store_true",
                        help="Ignore any cached .voxels.npy and re-run the full resample.")
    parser.add_argument("--particle-count", type=int, default=PARTICLE_COUNT_DEFAULT,
                        help=f"Number of dust particles to emit (default: {PARTICLE_COUNT_DEFAULT}).")
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)

    if args.synthetic:
        print("Generating synthetic test-pattern dust grid…", file=sys.stderr)
        voxels = make_synthetic_grid()
        density_max = DENSITY_MAX_SYNTHETIC
    else:
        # Cache the raw resampled float32 grid (~512 MiB, gitignored) so
        # re-encoding after tweaking DENSITY_MAX etc. doesn't require
        # re-running the 10-minute query phase. Delete it manually to force
        # a fresh resample.
        cache_path = args.output / ".voxels.npy"
        if cache_path.exists() and not args.force_resample:
            print(f"Loading cached voxel grid from {cache_path.relative_to(ROOT)}…", file=sys.stderr)
            voxels = np.load(cache_path)
        else:
            print(f"Fetching + resampling Edenhofer 2023 dust map (flavor={args.flavor})…", file=sys.stderr)
            voxels = resample_edenhofer(flavor=args.flavor)
            print(f"Saving raw grid cache to {cache_path.relative_to(ROOT)}…", file=sys.stderr)
            np.save(cache_path, voxels)
        nonzero = voxels[voxels > 0]
        if nonzero.size:
            density_max = float(np.percentile(nonzero, DENSITY_MAX_PERCENTILE))
        else:
            density_max = DENSITY_MAX_SYNTHETIC  # shouldn't happen; safe fallback

    # Encode float densities → uint8 via pure-log scaling over
    # [DENSITY_MIN, density_max]. The shader inverts this; manifest carries
    # both ends so the decode constants match.
    encoded = encode_log_uint8(voxels, DENSITY_MIN, density_max)
    nonzero_mean = voxels[voxels > 0].mean() if (voxels > 0).any() else 0.0
    print(f"Encoded density: raw {voxels.min():.6f}..{voxels.max():.6f}  "
          f"(nonzero mean {nonzero_mean:.6f}); "
          f"uint8 {int(encoded.min())}..{int(encoded.max())}; "
          f"log window [{DENSITY_MIN:.0e}, {density_max:.6f}]", file=sys.stderr)

    # Write chunks + manifest to `args.output`. Then mirror into public/dust/
    # so Vite and the Cloudflare asset build see them; data/dust/ remains
    # the canonical LFS-tracked source.
    chunks = write_chunks(encoded, args.output)

    # Particle cloud — importance-sampled from the float voxel grid (not
    # the encoded uint8) so dense cores get representative particle density.
    print(f"Sampling {args.particle_count} dust particles…", file=sys.stderr)
    particles = sample_particles(voxels, args.particle_count)
    write_particles(particles, args.output / "particles.bin")
    print(f"Wrote particles.bin ({particles.shape[0]} particles, "
          f"{(particles.shape[0] * 16 + 16) / 1024:.1f} KiB)", file=sys.stderr)

    manifest = build_manifest(
        chunks, synthetic=args.synthetic, density_max=density_max,
        particle_count=int(particles.shape[0]),
    )
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {len(chunks)} chunks + manifest to {args.output.relative_to(ROOT)}/", file=sys.stderr)

    if not args.skip_public and args.output == DATA_DUST:
        copy_to_public()

    return 0


def sample_particles(voxels: np.ndarray, n: int, seed: int = 42) -> np.ndarray:
    """Importance-sample `n` particles from the density grid.

    Returns an (n, 4) float32 array: columns are (x, y, z, density). Each
    particle is placed at a uniformly-jittered position within its source
    voxel so the sampled cloud isn't quantised to voxel centres.

    Sampling probability is proportional to voxel density (clipped at the
    threshold); regions of zero density contribute no particles.
    """
    rng = np.random.default_rng(seed)

    flat = voxels.ravel()
    weights = np.where(flat > PARTICLE_DENSITY_THRESHOLD, flat, 0.0).astype(np.float64)
    total = weights.sum()
    if total <= 0.0:
        return np.zeros((0, 4), dtype=np.float32)
    weights /= total

    flat_idx = rng.choice(weights.size, size=n, replace=True, p=weights)

    # voxels.ravel() is C-order with last axis innermost, so for our [ix,iy,iz]
    # layout the flat index decomposes as iz innermost.
    n_axis = voxels.shape[0]
    iz = flat_idx % n_axis
    iy = (flat_idx // n_axis) % n_axis
    ix = flat_idx // (n_axis * n_axis)

    # Per-particle jitter inside the voxel breaks the voxel-grid look that
    # would otherwise show in dense regions where many particles share a
    # voxel.
    jitter = rng.uniform(-0.5, 0.5, size=(n, 3)).astype(np.float32) * VOXEL_SIZE_PC
    centres_x = (ix.astype(np.float32) + 0.5) * VOXEL_SIZE_PC - BOUNDS_PC
    centres_y = (iy.astype(np.float32) + 0.5) * VOXEL_SIZE_PC - BOUNDS_PC
    centres_z = (iz.astype(np.float32) + 0.5) * VOXEL_SIZE_PC - BOUNDS_PC
    pos = np.stack([centres_x, centres_y, centres_z], axis=1) + jitter
    density = flat[flat_idx].astype(np.float32)
    return np.column_stack([pos, density]).astype(np.float32)


def write_particles(particles: np.ndarray, path: Path) -> None:
    """Write particles as a tiny binary file: 16-byte header + raw float32.

    Header (16 bytes):
      0..3   ASCII 'PART'
      4..7   uint32 version (= 1)
      8..11  uint32 count
      12..15 reserved (zero)
    Records: count × 16 bytes (4 float32: x, y, z, density)."""
    count = int(particles.shape[0])
    header = bytearray(16)
    header[0:4] = b"PART"
    header[4:8] = (1).to_bytes(4, "little")
    header[8:12] = count.to_bytes(4, "little")
    with open(path, "wb") as f:
        f.write(header)
        f.write(particles.astype(np.float32).tobytes())


def encode_log_uint8(voxels: np.ndarray, dmin: float, dmax: float) -> np.ndarray:
    """Pure-log encoding over [dmin, dmax] → [0,1] → uint8.

    Values below dmin clamp to uint8=0 (decodes as dmin — a bias that's
    negligible for the shader's accumulated path extinction). Values above
    dmax clamp to uint8=255 (decodes as dmax — saturation in dense cores,
    which underestimates extinction through the very densest clouds but
    preserves their visual prominence)."""
    clipped = np.clip(voxels, dmin, dmax)
    log_lo = math.log10(dmin)
    log_hi = math.log10(dmax)
    norm = (np.log10(clipped) - log_lo) / (log_hi - log_lo)
    return np.clip(np.round(norm * 255.0), 0, 255).astype(np.uint8)


def make_synthetic_grid() -> np.ndarray:
    """Deterministic test pattern for end-to-end dev without external data.

    Uses realistic E_ZGR/pc density scales so the resulting A_V values
    match what the real map produces through the same shader pipeline —
    switching between synthetic and real mode doesn't require re-tuning
    uExtinctionStrength.

    - Dense slab in +X direction (200-400 pc), peak ~0.05/pc (Aquila-Rift
      scale). Stars behind along +X should show ~5 mag A_V at the centre.
    - -X hemisphere is completely clear (control). No diffuse plane —
      earlier versions had one but it contaminated the control direction.
    """
    n = GRID_SIZE
    ax = (np.arange(n, dtype=np.float32) + 0.5) * VOXEL_SIZE_PC - BOUNDS_PC
    xs, ys, zs = np.meshgrid(ax, ax, ax, indexing="ij")

    x_in_band = np.where((xs > 200) & (xs < 400), 1.0, 0.0)
    yz_r = np.sqrt(ys * ys + zs * zs)
    slab = 0.05 * x_in_band * np.exp(-(yz_r / 120.0) ** 2)

    r3 = np.sqrt(xs * xs + ys * ys + zs * zs)
    total = np.where(r3 <= BOUNDS_PC, slab, 0.0)
    return total.astype(np.float32)


def resample_edenhofer(*, flavor: str) -> np.ndarray:
    """Load the Edenhofer 2023 dust map and resample onto our Cartesian grid.

    Imports dustmaps/astropy lazily so --synthetic mode has zero extra deps.
    """
    try:
        import astropy.units as u
        from astropy.coordinates import SkyCoord
        import dustmaps.edenhofer2023
        from dustmaps.edenhofer2023 import Edenhofer2023Query
    except ImportError as e:
        raise SystemExit(
            f"Missing dependency: {e.name}. Install with:\n"
            f"  pip install -r scripts/requirements-dust.txt"
        ) from None

    # Fetch the data if not already present. Respects the user's
    # dustmaps.config['data_dir'] — set it in ~/.dustmapsrc to relocate.
    # 'main' flavor is the 3.2 GB mean+std HEALPix file; 2kpc flavor adds
    # a second file of similar size. We do not download samples (19 GB),
    # which would only matter for uncertainty propagation.
    try:
        dustmaps.edenhofer2023.fetch(fetch_2kpc=(flavor == "less_data_but_2kpc"))
    except Exception as e:  # pragma: no cover — network / filesystem errors
        raise SystemExit(f"Failed to fetch Edenhofer map: {e}") from None

    query = Edenhofer2023Query(flavor=flavor)

    # Build voxel-center coordinates in ICRS heliocentric Cartesian (parsecs),
    # matching catalog.bin's frame. astropy handles the ICRS → Galactic
    # conversion internally when the query pulls (l, b, distance) off the
    # SkyCoord.
    n = GRID_SIZE
    ax = (np.arange(n, dtype=np.float32) + 0.5) * VOXEL_SIZE_PC - BOUNDS_PC

    print("  Preparing voxel-center coords…", file=sys.stderr)
    # Query in Z-slab batches to keep peak memory bounded. Each slab is
    # 512*512 = 262,144 voxels.
    out = np.zeros((n, n, n), dtype=np.float32)
    xs2d, ys2d = np.meshgrid(ax, ax, indexing="ij")
    xs_flat = xs2d.ravel()
    ys_flat = ys2d.ravel()

    for iz, z in enumerate(ax):
        zs_flat = np.full_like(xs_flat, float(z))
        sc = SkyCoord(
            x=xs_flat * u.pc, y=ys_flat * u.pc, z=zs_flat * u.pc,
            frame="icrs", representation_type="cartesian",
        )
        # Queries outside the map's coverage return NaN; we sanitise below.
        d = query(sc)
        out[:, :, iz] = np.asarray(d, dtype=np.float32).reshape(n, n)
        if iz % 32 == 0:
            print(f"  …z-slab {iz}/{n}", file=sys.stderr)

    out = np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)
    # Clip negatives (shouldn't occur, but rounding in float32 can produce
    # tiny negative values that the uint8 encoding would then misrender).
    out = np.clip(out, 0.0, None)
    return out


def write_chunks(encoded: np.ndarray, out_dir: Path) -> list[dict]:
    """Split the full grid into 64 chunks and write each as raw uint8 bytes.

    Axis order: data is indexed encoded[ix, iy, iz] in the Cartesian grid.
    Each chunk file's bytes are X-innermost, Y-middle, Z-outermost
    (WebGL texSubImage3D expects this layout for its width/height/depth
    arguments), so we transpose to (iz, iy, ix) before tobytes().
    """
    chunks: list[dict] = []
    c = CHUNK_SIZE
    for ix in range(CHUNKS_PER_AXIS):
        for iy in range(CHUNKS_PER_AXIS):
            for iz in range(CHUNKS_PER_AXIS):
                sub = encoded[ix*c:(ix+1)*c, iy*c:(iy+1)*c, iz*c:(iz+1)*c]
                # Reorder to Z-major for WebGL upload.
                raw = np.ascontiguousarray(sub.transpose(2, 1, 0)).tobytes()
                assert len(raw) == c * c * c
                name = f"chunk_{ix}_{iy}_{iz}.bin"
                path = out_dir / name
                path.write_bytes(raw)
                chunks.append({
                    "ix": ix, "iy": iy, "iz": iz,
                    "file": name,
                    "bytes": len(raw),
                    "sha256": hashlib.sha256(raw).hexdigest()[:16],
                    # Central pc coord of the chunk — lets the loader
                    # prioritise chunks by distance from the camera without
                    # recomputing from indices.
                    "centerPc": [
                        -BOUNDS_PC + (ix + 0.5) * c * VOXEL_SIZE_PC,
                        -BOUNDS_PC + (iy + 0.5) * c * VOXEL_SIZE_PC,
                        -BOUNDS_PC + (iz + 0.5) * c * VOXEL_SIZE_PC,
                    ],
                })
    return chunks


def build_manifest(chunks: list[dict], *, synthetic: bool, density_max: float,
                   particle_count: int) -> dict:
    return {
        "version": 2,
        "format": "u8-log-window",
        "synthetic": synthetic,
        "gridSize": GRID_SIZE,
        "chunkSize": CHUNK_SIZE,
        "chunksPerAxis": CHUNKS_PER_AXIS,
        "totalChunks": CHUNKS_PER_AXIS ** 3,
        "boundsPc": [-BOUNDS_PC, BOUNDS_PC],
        "voxelSizePc": VOXEL_SIZE_PC,
        "axisOrderInFile": "z-major (innermost = x)",
        "frame": "ICRS heliocentric Cartesian (matches catalog.bin)",
        "densityMin": DENSITY_MIN,
        "densityMax": density_max,
        "encoding": "uint8: 255 * (log10(clamp(d,dmin,dmax)) - log10(dmin)) / log10(dmax/dmin)",
        "avPerDensityPerPc": ZGR_TO_AV,
        "chunks": chunks,
        "particles": {
            "file": "particles.bin",
            "count": particle_count,
        },
    }


def copy_to_public() -> None:
    """Mirror data/dust → public/dust so Vite serves the chunks at /dust/.

    `data/dust/` is the canonical LFS-tracked location; `public/dust/` is a
    gitignored copy so the dev server and Vite build pick it up without
    the preprocessor having to know about two locations.
    """
    import shutil
    PUBLIC_DUST.mkdir(parents=True, exist_ok=True)
    # Wipe stale files so stepping back from --synthetic to real (or vice
    # versa) doesn't leave mismatched chunks behind.
    for old in PUBLIC_DUST.iterdir():
        if old.is_file():
            old.unlink()
    for src in DATA_DUST.iterdir():
        if src.is_file():
            shutil.copy2(src, PUBLIC_DUST / src.name)
    print(f"Mirrored to {PUBLIC_DUST.relative_to(ROOT)}/", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
