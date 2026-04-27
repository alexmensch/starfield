#!/usr/bin/env python3
"""Build the molecular cloud catalog consumed by the client renderer.

Reads two committed source files under data/molecular-clouds/:
  - zucker2020-tablea1.tsv  (326 sightlines, ~96 unique cloud names, distances)
  - zucker2021-table1.dat   (12 famous local SF clouds with 3D bounding boxes)

Emits public/clouds.json with one entry per cloud:

  {
    "name":       "Taurus",                   # display name
    "id":         "taurus",                   # slug, also used by URL/search
    "center":     [x, y, z],                  # ICRS heliocentric pc
    "axes":       [a, b, c],                  # semi-axes in pc, sphere = [r,r,r]
    "quat":       [qx, qy, qz, qw],           # rotation, identity = [0,0,0,1]
    "source":     "Z2021T1" | "Z2020" ,       # provenance
    "distance":   d,                          # heliocentric distance to centroid (pc)
  }

The Zucker 2021 entries are the authoritative source for the 12 clouds they
cover: their bounding boxes are axis-aligned in galactic Cartesian, so the
ellipsoid axes align to the galactic basis and `quat` is the GAL_TO_ICRS
rotation. Zucker 2020 entries are aggregated to one record per unique name,
sphere-shaped (orientation irrelevant, quat = identity), with radius
estimated from the spread of sightlines for that cloud (or a 5 pc default
when only one sightline exists).

Idempotent — exits early if public/clouds.json is newer than this script
and both source files. Run via `npm run build:clouds`.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_2020 = ROOT / 'data' / 'molecular-clouds' / 'zucker2020-tablea1.tsv'
SRC_2021 = ROOT / 'data' / 'molecular-clouds' / 'zucker2021-table1.dat'
OUT = ROOT / 'public' / 'clouds.json'

# Default sphere radius for Zucker-2020 clouds with only a single sightline.
# Most local SF clouds fall in the 5–30 pc effective-radius range; 5 pc is the
# small end so over-estimation isn't visually dominant. Multi-sightline clouds
# get a real spread-based radius.
DEFAULT_SPHERE_RADIUS_PC = 5.0

# Floor for spread-based radius so a tight pair of sightlines doesn't render
# as a near-zero-size dot.
MIN_SPHERE_RADIUS_PC = 3.0

# IAU/Hipparcos J2000 galactic-frame definition (must match
# src/client/galactic-coords.ts so all coordinate transforms agree).
ALPHA_GC = math.radians(266.4051)
DELTA_GC = math.radians(-28.93617)
ALPHA_NGP = math.radians(192.85948)
DELTA_NGP = math.radians(27.12825)


def normalise(v: tuple[float, float, float]) -> tuple[float, float, float]:
    n = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    return (v[0] / n, v[1] / n, v[2] / n)


def cross(
    a: tuple[float, float, float],
    b: tuple[float, float, float],
) -> tuple[float, float, float]:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def build_gal_to_icrs() -> list[list[float]]:
    """3x3 rotation matrix mapping galactic-Cartesian → ICRS-Cartesian.
    Columns are unit vectors of galactic +X, +Y, +Z expressed in ICRS.
    """
    gc_dir = normalise((
        math.cos(DELTA_GC) * math.cos(ALPHA_GC),
        math.cos(DELTA_GC) * math.sin(ALPHA_GC),
        math.sin(DELTA_GC),
    ))
    ngp_dir = normalise((
        math.cos(DELTA_NGP) * math.cos(ALPHA_NGP),
        math.cos(DELTA_NGP) * math.sin(ALPHA_NGP),
        math.sin(DELTA_NGP),
    ))
    gal_y = normalise(cross(ngp_dir, gc_dir))
    gal_z = normalise(cross(gc_dir, gal_y))
    # Column-major: row i column j = component i of basis vector j.
    return [
        [gc_dir[0], gal_y[0], gal_z[0]],
        [gc_dir[1], gal_y[1], gal_z[1]],
        [gc_dir[2], gal_y[2], gal_z[2]],
    ]


GAL_TO_ICRS = build_gal_to_icrs()


def matvec(m: list[list[float]], v: tuple[float, float, float]) -> tuple[float, float, float]:
    return (
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    )


def matrix_to_quat(m: list[list[float]]) -> tuple[float, float, float, float]:
    """Convert a 3x3 rotation matrix to a unit quaternion [x, y, z, w].
    Standard Shepperd's method — robust to all rotations.
    """
    m00, m01, m02 = m[0]
    m10, m11, m12 = m[1]
    m20, m21, m22 = m[2]
    trace = m00 + m11 + m22
    if trace > 0:
        s = 0.5 / math.sqrt(trace + 1.0)
        return ((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s)
    if m00 > m11 and m00 > m22:
        s = 2.0 * math.sqrt(1.0 + m00 - m11 - m22)
        return (0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s)
    if m11 > m22:
        s = 2.0 * math.sqrt(1.0 + m11 - m00 - m22)
        return ((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s)
    s = 2.0 * math.sqrt(1.0 + m22 - m00 - m11)
    return ((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s)


def galactic_lbd_to_xyz_pc(l_deg: float, b_deg: float, d_pc: float) -> tuple[float, float, float]:
    """Galactic spherical (l, b, distance) → galactic-Cartesian heliocentric pc."""
    lr = math.radians(l_deg)
    br = math.radians(b_deg)
    cb = math.cos(br)
    return (d_pc * cb * math.cos(lr), d_pc * cb * math.sin(lr), d_pc * math.sin(br))


# Display-name normalisation. Z2020 uses underscores; Z2021 uses contracted
# forms ("Coraus", "Oriona", "Orionb", "Orionlam"). Map both to clean human
# forms for search and label display.
DISPLAY_NAME_OVERRIDES: dict[str, str] = {
    'Coraus': 'Corona Australis',
    'Corona_Australis': 'Corona Australis',
    'Oriona': 'Orion A',
    'Orionb': 'Orion B',
    'Orionlam': 'Orion λ',
    'Orion_Lam': 'Orion λ',
    'Aquila_Rift': 'Aquila Rift',
    'Aquila_S': 'Aquila South',
    'CMa_OB1': 'CMa OB1',
    'Gem_OB1': 'Gem OB1',
    'Mon_OB1_NGC2264': 'Mon OB1 / NGC 2264',
    'Cam': 'Cam',
    'CygnusX': 'Cygnus X',
    'IC1396': 'IC 1396',
    'IC2118': 'IC 2118',
    'IC2944': 'IC 2944',
    'IC443': 'IC 443',
    'IC5146': 'IC 5146',
    'NGC2362': 'NGC 2362',
    'NGC6604': 'NGC 6604',
    'Pipe_B59': 'Pipe (B59)',
}


def display_name(raw: str) -> str:
    if raw in DISPLAY_NAME_OVERRIDES:
        return DISPLAY_NAME_OVERRIDES[raw]
    # Generic fallback: replace underscores with spaces, leave other casing.
    return raw.replace('_', ' ')


# Map from Zucker 2021 raw cloud name → canonical Z2020 cloud name to
# suppress when the Z2021 entry is present. Without this we'd render two
# overlapping objects (sphere from Z2020 + ellipsoid from Z2021) for the
# same cloud. Z2020 sub-regions (Ophiuchus_Arc etc.) are NOT suppressed —
# they're separate physical structures even when contained in the Z2021
# parent ellipsoid.
Z2021_TO_Z2020_SUPPRESS: dict[str, str] = {
    'Chamaeleon': 'Chamaeleon',
    'Ophiuchus': 'Ophiuchus',
    'Lupus': 'Lupus',
    'Taurus': 'Taurus',
    'Perseus': 'Perseus',
    'Cepheus': 'Cepheus',
    'Coraus': 'Corona_Australis',
    'Pipe': 'Pipe_B59',
    'Oriona': 'Orion',
    'Orionb': 'Orion',
    'Orionlam': 'Orion_Lam',
    # Musca has no Z2020 counterpart at this granularity; nothing to suppress.
}


def slugify(name: str) -> str:
    s = re.sub(r'[^A-Za-z0-9]+', '-', name).strip('-').lower()
    return s or 'cloud'


def parse_z2020(path: Path) -> dict[str, list[dict]]:
    """Parse the Zucker 2020 VizieR TSV. Returns {cloud_name: [sightline,...]}.
    Each sightline carries glon, glat, d_pc."""
    rows: dict[str, list[dict]] = {}
    with path.open() as fh:
        for line in fh:
            line = line.rstrip('\n')
            if not line or line.startswith('#'):
                continue
            parts = line.split('\t')
            if len(parts) < 16:
                continue
            # The header rows ("recno\tName\t...", units, dashes) survive the
            # comment filter. Skip anything where field 0 isn't a number.
            try:
                int(parts[0].strip())
            except ValueError:
                continue
            name = parts[1].strip()
            try:
                glon = float(parts[2])
                glat = float(parts[3])
                d50 = float(parts[14])  # 50th-percentile cloud distance
            except ValueError:
                continue
            rows.setdefault(name, []).append({'l': glon, 'b': glat, 'd': d50})
    return rows


def parse_z2021(path: Path) -> list[dict]:
    """Parse the Zucker 2021 Table 1 (whitespace-delimited)."""
    out: list[dict] = []
    with path.open() as fh:
        header = fh.readline().split()
        col = {name: i for i, name in enumerate(header)}
        for line in fh:
            parts = line.split()
            if not parts:
                continue
            out.append({
                'cloud': parts[col['cloud']],
                'lmed': float(parts[col['lmed']]),
                'bmed': float(parts[col['bmed']]),
                'dmed': float(parts[col['dmed']]),
                'xmin': float(parts[col['xmin']]),
                'xmax': float(parts[col['xmax']]),
                'ymin': float(parts[col['ymin']]),
                'ymax': float(parts[col['ymax']]),
                'zmin': float(parts[col['zmin']]),
                'zmax': float(parts[col['zmax']]),
            })
    return out


def build_z2021_clouds(entries: list[dict]) -> list[dict]:
    """Z2021 → ellipsoid clouds in ICRS frame.
    Bounding box is axis-aligned in galactic Cartesian; rotate the *centre*
    to ICRS, and emit the GAL_TO_ICRS rotation as the orientation quaternion
    so the ellipsoid axes correctly align with galactic +X/+Y/+Z when
    expanded by the renderer.
    """
    quat_gal_to_icrs = matrix_to_quat(GAL_TO_ICRS)
    out: list[dict] = []
    for e in entries:
        cx = 0.5 * (e['xmin'] + e['xmax'])
        cy = 0.5 * (e['ymin'] + e['ymax'])
        cz = 0.5 * (e['zmin'] + e['zmax'])
        a = 0.5 * (e['xmax'] - e['xmin'])
        b = 0.5 * (e['ymax'] - e['ymin'])
        c = 0.5 * (e['zmax'] - e['zmin'])
        # Per-axis floor — Musca's c=7 pc is fine, but a degenerate flat box
        # would render invisibly edge-on; clamp to MIN_SPHERE_RADIUS_PC.
        a = max(a, MIN_SPHERE_RADIUS_PC)
        b = max(b, MIN_SPHERE_RADIUS_PC)
        c = max(c, MIN_SPHERE_RADIUS_PC)
        center_icrs = matvec(GAL_TO_ICRS, (cx, cy, cz))
        name = display_name(e['cloud'])
        d = math.sqrt(center_icrs[0] ** 2 + center_icrs[1] ** 2 + center_icrs[2] ** 2)
        out.append({
            'name': name,
            'id': slugify(name),
            'center': [round(center_icrs[0], 2), round(center_icrs[1], 2), round(center_icrs[2], 2)],
            'axes': [round(a, 2), round(b, 2), round(c, 2)],
            'quat': [round(q, 6) for q in quat_gal_to_icrs],
            'source': 'Z2021T1',
            'distance': round(d, 1),
        })
    return out


def build_z2020_clouds(
    grouped: dict[str, list[dict]],
    suppress: set[str],
) -> list[dict]:
    """Z2020 → sphere clouds in ICRS frame.
    For multi-sightline clouds, the sphere radius is the maximum distance from
    centroid to any sightline (with a small floor). Singletons get a default.
    """
    out: list[dict] = []
    for raw_name, sightlines in grouped.items():
        if raw_name in suppress:
            continue
        if not sightlines:
            continue
        # Centroid in galactic Cartesian (then rotate to ICRS).
        gal_pts = [galactic_lbd_to_xyz_pc(s['l'], s['b'], s['d']) for s in sightlines]
        cx = sum(p[0] for p in gal_pts) / len(gal_pts)
        cy = sum(p[1] for p in gal_pts) / len(gal_pts)
        cz = sum(p[2] for p in gal_pts) / len(gal_pts)
        if len(gal_pts) >= 2:
            spread = max(
                math.sqrt((p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2)
                for p in gal_pts
            )
            radius = max(spread, MIN_SPHERE_RADIUS_PC)
        else:
            radius = DEFAULT_SPHERE_RADIUS_PC
        center_icrs = matvec(GAL_TO_ICRS, (cx, cy, cz))
        name = display_name(raw_name)
        d = math.sqrt(center_icrs[0] ** 2 + center_icrs[1] ** 2 + center_icrs[2] ** 2)
        out.append({
            'name': name,
            'id': slugify(name),
            'center': [round(center_icrs[0], 2), round(center_icrs[1], 2), round(center_icrs[2], 2)],
            'axes': [round(radius, 2), round(radius, 2), round(radius, 2)],
            'quat': [0, 0, 0, 1],
            'source': 'Z2020',
            'distance': round(d, 1),
        })
    return out


def is_up_to_date() -> bool:
    if not OUT.exists():
        return False
    out_mtime = OUT.stat().st_mtime
    for src in (SRC_2020, SRC_2021, Path(__file__)):
        if src.stat().st_mtime > out_mtime:
            return False
    return True


def main() -> None:
    if '--force' not in sys.argv and is_up_to_date():
        print(f'clouds.json up to date — skipping (use --force to rebuild)')
        return

    if not SRC_2020.exists():
        print(f'error: missing {SRC_2020}', file=sys.stderr)
        sys.exit(1)
    if not SRC_2021.exists():
        print(f'error: missing {SRC_2021}', file=sys.stderr)
        sys.exit(1)

    z2020 = parse_z2020(SRC_2020)
    z2021 = parse_z2021(SRC_2021)
    suppress = {z20 for raw, z20 in Z2021_TO_Z2020_SUPPRESS.items()
                if any(raw == e['cloud'] for e in z2021)}
    ellipsoids = build_z2021_clouds(z2021)
    spheres = build_z2020_clouds(z2020, suppress)

    # Dedup by id — Z2021 wins when ids collide (defensive; the suppress
    # table should already have prevented this).
    by_id: dict[str, dict] = {}
    for c in ellipsoids + spheres:
        by_id.setdefault(c['id'], c)
    clouds = sorted(by_id.values(), key=lambda c: c['name'].lower())

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'version': 1,
        'count': len(clouds),
        'clouds': clouds,
    }
    OUT.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
    print(
        f'wrote {OUT.relative_to(ROOT)} '
        f'({len(ellipsoids)} ellipsoids from Z2021, '
        f'{len(spheres)} spheres from Z2020, '
        f'{len(clouds)} total)'
    )


if __name__ == '__main__':
    main()
