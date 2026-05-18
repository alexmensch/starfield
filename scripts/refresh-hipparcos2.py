#!/usr/bin/env python3
"""Refresh data/hip2_van_leeuwen.tsv — Hipparcos-2 (van Leeuwen 2007) reduction.

Phase 1 of the source-ID-anchored catalogue-pipeline rewrite (stellata-dch).
HIP2 (VizieR I/311/hip2) is the improved astrometric reduction of all
117,955 HIP stars on a longer baseline than the original ESA 1997 release.
Critical for the bright-binary fallback (Phase 2 Stage 3 stellata-dch.30):
where Gaia DR3's 5-parameter PM is corrupted by orbital wobble in close
binaries (Sirius, α Cen, Castor, Algol) or by saturation (V ≲ 4 — Sirius A,
Polaris, Vega), HIP2 averages over a different window on the orbit and is
often the truer single-star PM.

Reference epoch: J1991.25 for the entire catalogue. NOT stored per-row —
downstream consumers (build-binaries.py) must roll positions forward via
the per-row PM to whatever epoch they consume on.

ADQL
    SELECT "HIP", "RArad", "DErad",
           "Plx", "e_Plx",
           "pmRA", "pmDE", "e_pmRA", "e_pmDE",
           "F2", "Ntr"
    FROM "I/311/hip2"
    ORDER BY "HIP"

Schema discovered by live probe — the VizieR-on-the-wire column names
differ from the van Leeuwen 2007 paper conventions and from the bead spec.
Notably: `RArad`/`DErad` are MISNAMED — the values are stored in degrees
(verified against Sirius A at J1991.25: RArad=101.288°). The script
renames to Stellata-canonical lowercase on write.

TSV columns (11)
    hip               int   — Hipparcos identifier
    ra_icrs           float — RA at J1991.25, deg
    de_icrs           float — Dec at J1991.25, deg
    plx               float — parallax, mas
    e_plx             float — parallax uncertainty, mas
    pm_ra             float — proper motion in RA*cos(dec), mas/yr
    pm_de             float — proper motion in Dec, mas/yr
    e_pm_ra           float — pm_ra uncertainty, mas/yr
    e_pm_de           float — pm_de uncertainty, mas/yr
    goodness_of_fit   float — HIP2 F2 statistic (chi² GoF, ~N(0,1) when good)
    n_transits        int   — number of HIP transits used in the solution

Backend: CDS only. I/311/hip2 is a VizieR-published external catalogue
not hosted on the ESA Gaia archive, so the default ESA→CDS fallback does
not apply.

Idempotent — exits early if the output is newer than this script. Pass
`--force` to rebuild unconditionally.

Venv setup (see scripts/requirements-refresh.txt):
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements-refresh.txt
    .venv/bin/python scripts/refresh-hipparcos2.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import refresh_lib as rl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "hip2_van_leeuwen.tsv"

# Bounds around HIP2's published row count (117,955). Slack accommodates
# the small drift Vizier mirrors occasionally show without false-negatives.
EXPECTED_ROW_COUNT_MIN = 117_000
EXPECTED_ROW_COUNT_MAX = 118_500

# VizieR-on-the-wire → Stellata-canonical TSV column mapping. The keys are
# the case-sensitive column names exposed by I/311/hip2 on VizieR TAP;
# the values are the lowercase names downstream consumers will read.
# Note: `RArad`/`DErad` despite the suffix store values in DEGREES, not
# radians (verified by live probe against Sirius A and Polaris).
VIZIER_TO_CANONICAL = {
    "HIP":    "hip",
    "RArad":  "ra_icrs",
    "DErad":  "de_icrs",
    "Plx":    "plx",
    "e_Plx":  "e_plx",
    "pmRA":   "pm_ra",
    "pmDE":   "pm_de",
    "e_pmRA": "e_pm_ra",
    "e_pmDE": "e_pm_de",
    "F2":     "goodness_of_fit",
    "Ntr":    "n_transits",
}

TSV_COLUMNS = list(VIZIER_TO_CANONICAL.values())

EXPECTED_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "HIP":    int,
    "RArad":  float,
    "DErad":  float,
    "Plx":    float,
    "e_Plx":  float,
    "pmRA":   float,
    "pmDE":   float,
    "e_pmRA": float,
    "e_pmDE": float,
    "F2":     float,
    "Ntr":    int,
}

ADQL = (
    'SELECT "HIP", "RArad", "DErad", '
    '"Plx", "e_Plx", '
    '"pmRA", "pmDE", "e_pmRA", "e_pmDE", '
    '"F2", "Ntr" '
    'FROM "I/311/hip2" '
    'ORDER BY "HIP"'
)

# Sirius A (HIP 32349) reference PM from the live VizieR mirror — the
# script asserts the spot-check survives the refresh so a future schema or
# data drift surfaces immediately. Tolerance covers the ~0.05 mas/yr
# variation seen between Vizier mirrors and the paper's nominal values.
SPOT_HIP = 32349
SPOT_PM_RA = -546.01
SPOT_PM_DE = -1223.07
SPOT_TOL = 0.1


def main() -> None:
    force = "--force" in sys.argv

    if not force and rl.is_up_to_date(OUT, [Path(__file__)]):
        print(f"{OUT.relative_to(ROOT)} up to date — skipping (use --force to rebuild)")
        return

    client = rl.TapClient(backends=[rl.cds_backend()])
    print('querying CDS TAP — "I/311/hip2" (whole catalogue, ~118 k rows) …')
    t0 = time.time()
    table = client.run(ADQL)
    elapsed = time.time() - t0

    rl.validate_schema(table, EXPECTED_SCHEMA, label="hipparcos-2 I/311/hip2")

    n = len(table)
    print(f"  {n} rows in {elapsed:.1f}s")
    if not (EXPECTED_ROW_COUNT_MIN <= n <= EXPECTED_ROW_COUNT_MAX):
        raise SystemExit(
            f"refresh-hipparcos2: row count {n} outside expected "
            f"[{EXPECTED_ROW_COUNT_MIN}, {EXPECTED_ROW_COUNT_MAX}] — "
            f"upstream schema or selection has changed; investigate before re-pinning."
        )

    sirius = [r for r in table if int(r["HIP"]) == SPOT_HIP]
    if not sirius:
        raise SystemExit(
            f"refresh-hipparcos2: spot-check HIP {SPOT_HIP} (Sirius A) missing "
            f"from query result — upstream filter or selection has changed."
        )
    s = sirius[0]
    if abs(float(s["pmRA"]) - SPOT_PM_RA) > SPOT_TOL or abs(float(s["pmDE"]) - SPOT_PM_DE) > SPOT_TOL:
        raise SystemExit(
            f"refresh-hipparcos2: spot-check HIP {SPOT_HIP} (Sirius A) PM drift — "
            f"got pmRA={float(s['pmRA'])}, pmDE={float(s['pmDE'])}; "
            f"expected ~{SPOT_PM_RA} / {SPOT_PM_DE} (±{SPOT_TOL} mas/yr)."
        )

    rows = (
        {canonical: row[vizier] for vizier, canonical in VIZIER_TO_CANONICAL.items()}
        for row in table
    )
    written = rl.write_tsv(rows, columns=TSV_COLUMNS, output=OUT)
    print(f"wrote {OUT.relative_to(ROOT)} ({written} rows)")


if __name__ == "__main__":
    main()
