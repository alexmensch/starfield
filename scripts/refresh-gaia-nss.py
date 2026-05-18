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

# Self-consistency spot-check — replaces the bead's original 70 Oph
# (HIP 88601) check, which is impossible: HIP 88601 is too bright (V=4.0)
# for Gaia's Hipparcos2 cross-match, and 70 Oph's 88-year period is far
# beyond NSS's max observed period (~9,936 d / 27 yr). The pinned values
# are the actual DR3 NSS solution for the brightest HIP-mapped NSS entry
# at 2026-05-18 probe time. Matches the Sirius pmRA/pmDE pattern in
# refresh-hipparcos2.py.
SPOT_SOURCE_ID = 5823248090239625088  # HIP 74946, G=2.88
SPOT_SOLUTION_TYPE = "OrbitalTargetedSearch"
SPOT_PERIOD = 488.4292
SPOT_PERIOD_TOL = 0.01
SPOT_ECCENTRICITY = 0.1495
SPOT_ECCENTRICITY_TOL = 0.001


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

    spot = [r for r in table if int(r["source_id"]) == SPOT_SOURCE_ID]
    if not spot:
        raise SystemExit(
            f"refresh-gaia-nss: spot-check source_id {SPOT_SOURCE_ID} (HIP 74946) missing "
            f"from query result — upstream selection has changed."
        )
    s = spot[0]
    sol = str(s["nss_solution_type"])
    if sol != SPOT_SOLUTION_TYPE:
        raise SystemExit(
            f"refresh-gaia-nss: spot-check source_id {SPOT_SOURCE_ID} nss_solution_type drift — "
            f"got {sol!r}, expected {SPOT_SOLUTION_TYPE!r}."
        )
    p = float(s["period"])
    e = float(s["eccentricity"])
    if abs(p - SPOT_PERIOD) > SPOT_PERIOD_TOL or abs(e - SPOT_ECCENTRICITY) > SPOT_ECCENTRICITY_TOL:
        raise SystemExit(
            f"refresh-gaia-nss: spot-check source_id {SPOT_SOURCE_ID} (HIP 74946) drift — "
            f"got P={p}, e={e}; expected ~{SPOT_PERIOD} d / {SPOT_ECCENTRICITY} "
            f"(±{SPOT_PERIOD_TOL} d / ±{SPOT_ECCENTRICITY_TOL})."
        )

    rows = (
        {col: coerce_masked(row[col]) for col in TSV_COLUMNS}
        for row in table
    )
    written = rl.write_tsv(rows, columns=TSV_COLUMNS, output=OUT)
    print(f"wrote {OUT.relative_to(ROOT)} ({written} rows)")


if __name__ == "__main__":
    main()
