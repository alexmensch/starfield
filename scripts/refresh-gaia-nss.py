#!/usr/bin/env python3
"""Refresh data/gaia_dr3_nss_two_body.tsv — Gaia DR3 NSS two-body orbits.

Phase 1 of the source-ID-anchored catalogue-pipeline rewrite (stellata-dch).
Pulls the full `gaiadr3.nss_two_body_orbit` table — 443,205 rows of
orbital solutions Gaia DR3 fit directly from astrometry, spectroscopy,
or eclipses. Phase 2 Stage 4 (stellata-dch.31) prefers these over ORB6
inside Gaia's observability regime (P < ~10 yr, separation < ~1").

ADQL
    SELECT source_id, nss_solution_type,
           period, period_error,
           t_periastron, t_periastron_error,
           eccentricity, eccentricity_error,
           a_thiele_innes, a_thiele_innes_error,
           b_thiele_innes, b_thiele_innes_error,
           f_thiele_innes, f_thiele_innes_error,
           g_thiele_innes, g_thiele_innes_error,
           c_thiele_innes, c_thiele_innes_error,
           h_thiele_innes, h_thiele_innes_error,
           inclination, inclination_error,
           arg_periastron, arg_periastron_error,
           mass_ratio, mass_ratio_error,
           goodness_of_fit, significance
    FROM gaiadr3.nss_two_body_orbit
    ORDER BY source_id

Schema notes (from live probe 2026-05-18):
  * DR3 NSS uses Thiele-Innes constants (A, B, F, G in mas; C, H in AU
    for AstroSpectro* rows) — NOT classical Campbell elements. The
    helper `nss_to_canonical_elements` in dch.31 (Phase 2 Stage 4)
    derives (a, i, Omega, omega) from Thiele-Innes via Heintz 1978 /
    Pourbaix algebra. See dch.31 description.
  * `inclination` and `arg_periastron` columns exist but are NULL for
    pure-astrometric solutions (`Orbital`*); they're populated only for
    AstroSpectroSB1 / spectroscopic-orbit rows where one is observed
    directly.
  * `nss_solution_type` is categorical across 12 distinct values
    (SB1 / Orbital / EclipsingBinary / AstroSpectroSB1 / SB2 / ...).
    Downstream consumers must route conversion logic per type.

TSV columns (27) — see file docstring for `gaiadr3.nss_two_body_orbit`
upstream documentation. All upstream column names preserved verbatim;
empty cells in the TSV correspond to masked (NULL) values from TAP.

Backend: ESA Gaia archive (default refresh_lib ESA → CDS fallback).

Idempotent — exits early if the output is newer than this script. Pass
`--force` to rebuild unconditionally.

Venv setup (see scripts/requirements-refresh.txt):
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements-refresh.txt
    .venv/bin/python scripts/refresh-gaia-nss.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import refresh_lib as rl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "gaia_dr3_nss_two_body.tsv"

TSV_COLUMNS = [
    "source_id",
    "nss_solution_type",
    "period",
    "period_error",
    "t_periastron",
    "t_periastron_error",
    "eccentricity",
    "eccentricity_error",
    "a_thiele_innes",
    "a_thiele_innes_error",
    "b_thiele_innes",
    "b_thiele_innes_error",
    "f_thiele_innes",
    "f_thiele_innes_error",
    "g_thiele_innes",
    "g_thiele_innes_error",
    "c_thiele_innes",
    "c_thiele_innes_error",
    "h_thiele_innes",
    "h_thiele_innes_error",
    "inclination",
    "inclination_error",
    "arg_periastron",
    "arg_periastron_error",
    "mass_ratio",
    "mass_ratio_error",
    "goodness_of_fit",
    "significance",
]

ADQL = (
    "SELECT "
    + ", ".join(TSV_COLUMNS)
    + " FROM gaiadr3.nss_two_body_orbit "
    + "ORDER BY source_id"
)

EXPECTED_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "source_id": int,
    "nss_solution_type": str,
    "period": float,
    "period_error": float,
    "t_periastron": float,
    "t_periastron_error": float,
    "eccentricity": float,
    "eccentricity_error": float,
    "a_thiele_innes": float,
    "a_thiele_innes_error": float,
    "b_thiele_innes": float,
    "b_thiele_innes_error": float,
    "f_thiele_innes": float,
    "f_thiele_innes_error": float,
    "g_thiele_innes": float,
    "g_thiele_innes_error": float,
    "c_thiele_innes": float,
    "c_thiele_innes_error": float,
    "h_thiele_innes": float,
    "h_thiele_innes_error": float,
    "inclination": float,
    "inclination_error": float,
    "arg_periastron": float,
    "arg_periastron_error": float,
    "mass_ratio": float,
    "mass_ratio_error": float,
    "goodness_of_fit": float,
    "significance": float,
}

# DR3 is frozen — observed 443,205 on 2026-05-18 from the live ESA archive.
# Tight bounds; an out-of-range count means the upstream selection has
# changed (re-pin intentionally).
EXPECTED_ROW_COUNT_MIN = 440_000
EXPECTED_ROW_COUNT_MAX = 446_000

# Self-consistency spot-checks against pinned DR3 NSS rows. DR3 is frozen
# so values can be pinned tightly; tolerances are set to ~1% of the formal
# uncertainty quoted in DR3 (looser than archive-side rounding, tighter
# than any plausible drift the refresh script could itself introduce).
#
# Three rows across three solution types so a DR4 column-rename, unit
# change, or solution-type re-routing surfaces against at least one row
# whose code-path it touched:
#   - Orbital                : pure-astrometric, exercises Thiele-Innes
#   - OrbitalTargetedSearch  : variant routed through a different fit
#   - SB1                    : spectroscopic-only, exercises masked
#                              Thiele-Innes (a/b/f/g = NULL by design)
#
# Replaces the bead's original 70 Oph (HIP 88601) check, which is doubly
# impossible: HIP 88601 saturates Gaia's HIP2 cross-match (V=4.03), and
# 70 Oph's 88-year period is far beyond NSS's max observed period
# (~9,936 d / 27 yr — DR3 NSS only fits orbits with phase coverage that
# beats the 5-parameter astrometric solution's linear-trend absorption).
#
# Pattern matches refresh-hipparcos2.py's Sirius pmRA/pmDE check, but
# extended to multiple rows so single-target drift can't pass silently.
SPOT_CHECKS: list[dict[str, Any]] = [
    {
        "source_id":         6360853029303982592,  # Orbital — Thiele-Innes pinned
        "nss_solution_type": "Orbital",
        "period":            (466.2104, 0.001),
        "eccentricity":      (0.7918, 0.001),
        "a_thiele_innes":    (-4.6393, 0.001),
        "b_thiele_innes":    (-0.0809, 0.001),
        "f_thiele_innes":    (3.5245, 0.001),
        "g_thiele_innes":    (1.1596, 0.001),
        "mass_ratio":        None,                 # masked — null on write
    },
    {
        "source_id":         5823248090239625088,  # OrbitalTargetedSearch (HIP 74946)
        "nss_solution_type": "OrbitalTargetedSearch",
        "period":            (488.4292, 0.001),
        "eccentricity":      (0.1495, 0.001),
        "a_thiele_innes":    (0.1156, 0.001),
        "b_thiele_innes":    (-0.1710, 0.001),
        "f_thiele_innes":    (1.2353, 0.001),
        "g_thiele_innes":    (2.1121, 0.001),
        "mass_ratio":        None,
    },
    {
        "source_id":         4648984790038560256,  # SB1 — Thiele-Innes null
        "nss_solution_type": "SB1",
        "period":            (524.0654, 0.001),
        "eccentricity":      (0.0815, 0.001),
        "a_thiele_innes":    None,
        "b_thiele_innes":    None,
        "f_thiele_innes":    None,
        "g_thiele_innes":    None,
        "mass_ratio":        None,
    },
]


def check_spot_row(rows_by_id: dict[int, Any], spec: dict[str, Any]) -> None:
    """Assert one pinned row matches expectations; raise SystemExit listing
    every mismatched field (not just the first) so a future DR4 column
    rename / unit change / re-routing of solution types shows the full
    delta in a single failure message.

    Expected-value forms in `spec`:
      - str                  : exact match (e.g. nss_solution_type)
      - (float, float)       : (expected, abs-tolerance)
      - None                 : the cell must be masked / null
    """
    sid = spec["source_id"]
    row = rows_by_id.get(sid)
    if row is None:
        raise SystemExit(
            f"refresh-gaia-nss: spot-check source_id {sid} missing from query result — "
            f"upstream selection has changed."
        )
    deltas: list[str] = []
    for field, expected in spec.items():
        if field == "source_id":
            continue
        actual = coerce_masked(row[field])
        if expected is None:
            if actual is not None:
                deltas.append(f"  {field}: expected NULL, got {actual!r}")
        elif isinstance(expected, tuple):
            want, tol = expected
            if actual is None:
                deltas.append(f"  {field}: expected ~{want} (±{tol}), got NULL")
            elif abs(float(actual) - float(want)) > tol:
                deltas.append(f"  {field}: expected ~{want} (±{tol}), got {float(actual)}")
        else:
            if str(actual) != str(expected):
                deltas.append(f"  {field}: expected {expected!r}, got {actual!r}")
    if deltas:
        joined = "\n".join(deltas)
        raise SystemExit(
            f"refresh-gaia-nss: spot-check source_id {sid} drift — "
            f"{len(deltas)} field(s) outside tolerance:\n{joined}"
        )


def coerce_masked(value: Any) -> Any:
    """Convert astropy/numpy masked values to None for clean TSV nulls.

    Astropy MaskedColumn elements return `numpy.ma.masked` (a
    MaskedConstant) for missing cells; `str(np.ma.masked)` is "--" which
    would corrupt the TSV. Coerce to None so `write_tsv` emits an empty
    cell. Object-dtype string columns return masked as `--` strings too —
    handle those with the explicit check.
    """
    try:
        import numpy as np
        if value is np.ma.masked:
            return None
        # Object-dtype masked strings: astropy renders them as "--".
        if isinstance(value, np.ma.core.MaskedConstant):
            return None
    except ImportError:
        pass
    return value


def main() -> None:
    force = "--force" in sys.argv

    if not force and rl.is_up_to_date(OUT, [Path(__file__)]):
        print(f"{OUT.relative_to(ROOT)} up to date — skipping (use --force to rebuild)")
        return

    client = rl.TapClient()
    print("querying ESA Gaia TAP (fallback: CDS) — gaiadr3.nss_two_body_orbit (~443 k rows) …")
    t0 = time.time()
    table = client.run(ADQL)
    elapsed = time.time() - t0

    rl.validate_schema(table, EXPECTED_SCHEMA, label="gaiadr3.nss_two_body_orbit")

    n = len(table)
    print(f"  {n} rows in {elapsed:.1f}s")
    if not (EXPECTED_ROW_COUNT_MIN <= n <= EXPECTED_ROW_COUNT_MAX):
        raise SystemExit(
            f"refresh-gaia-nss: row count {n} outside expected "
            f"[{EXPECTED_ROW_COUNT_MIN}, {EXPECTED_ROW_COUNT_MAX}] — "
            f"upstream schema or selection has changed; investigate before re-pinning."
        )

    rows_by_id = {int(r["source_id"]): r for r in table}
    for spec in SPOT_CHECKS:
        check_spot_row(rows_by_id, spec)

    rows = (
        {col: coerce_masked(row[col]) for col in TSV_COLUMNS}
        for row in table
    )
    written = rl.write_tsv(rows, columns=TSV_COLUMNS, output=OUT)
    print(f"wrote {OUT.relative_to(ROOT)} ({written} rows)")


if __name__ == "__main__":
    main()
