#!/usr/bin/env python3
"""Refresh data/gaia_dr3_hip_xmatch.tsv — HIP → Gaia DR3 source_id cross-walk.

Phase 1 of the source-ID-anchored catalogue-pipeline rewrite (stellata-dch).
This table is the cornerstone of the new pipeline: every WDS / GCVS / SIMBAD
component that carries a HIP identifier resolves to a Gaia DR3 source_id via
this committed TSV, without any position-based match.

ADQL
    SELECT
      original_ext_source_id AS hip,
      source_id              AS gaia_source_id,
      angular_distance,
      number_of_neighbours,
      xm_flag
    FROM gaiadr3.hipparcos2_best_neighbour
    WHERE source_id IS NOT NULL
    ORDER BY original_ext_source_id

`gaiadr3.hipparcos2_best_neighbour` exposes the official Gaia DR3 ×
Hipparcos-2 (van Leeuwen 2007) cross-match — 99,525 rows, all with a
non-null source_id. Sirius / Polaris / Vega and other V ≲ 4 stars are
absent (Gaia saturates on the brightest stars); brightness-driven gaps
are handled downstream by Hipparcos-2-anchored fallbacks (stellata-dch.24).

TSV columns (5)
    hip                  int   — Hipparcos identifier (HIP number)
    gaia_source_id       int   — Gaia DR3 source_id
    angular_distance     float — match separation, arcsec (6 decimals)
    number_of_neighbours int   — ambiguity flag (1 = unique Gaia neighbour)
    xm_flag              int   — Gaia cross-match flag (see DR3 docs)

Idempotent — exits early if the output is newer than this script. Pass
`--force` to rebuild unconditionally. Backend fallback (ESA → CDS) is
provided by refresh_lib.TapClient.

Venv setup (see scripts/requirements-refresh.txt):
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements-refresh.txt
    .venv/bin/python scripts/refresh-gaia-hip-xmatch.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import refresh_lib as rl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "gaia_dr3_hip_xmatch.tsv"

ADQL = """
SELECT
  original_ext_source_id AS hip,
  source_id              AS gaia_source_id,
  angular_distance,
  number_of_neighbours,
  xm_flag
FROM gaiadr3.hipparcos2_best_neighbour
WHERE source_id IS NOT NULL
ORDER BY original_ext_source_id
"""

TSV_COLUMNS = [
    "hip",
    "gaia_source_id",
    "angular_distance",
    "number_of_neighbours",
    "xm_flag",
]

EXPECTED_SCHEMA = {
    "hip": int,
    "gaia_source_id": int,
    "angular_distance": float,
    "number_of_neighbours": int,
    "xm_flag": int,
}

# Tight bounds around the empirically-observed Gaia DR3 row count (99,525).
# DR3 is a frozen release so the count should not change; the small slack
# tolerates a hypothetical archive re-index without false-negatives.
EXPECTED_ROW_COUNT_MIN = 99_400
EXPECTED_ROW_COUNT_MAX = 99_600

# arcsec precision retained on angular_distance. Gaia astrometry is sub-mas
# (1e-3 arcsec) — 6 decimals preserves it with no loss of useful signal.
ANGULAR_DISTANCE_DECIMALS = 6


def main() -> None:
    force = "--force" in sys.argv

    if not force and rl.is_up_to_date(OUT, [Path(__file__)]):
        print(f"{OUT.relative_to(ROOT)} up to date — skipping (use --force to rebuild)")
        return

    client = rl.TapClient()
    print(f"querying ESA Gaia TAP (fallback: CDS) — gaiadr3.hipparcos2_best_neighbour …")
    table = client.run(ADQL)

    rl.validate_schema(table, EXPECTED_SCHEMA, label="hipparcos2_best_neighbour")

    n = len(table)
    if not (EXPECTED_ROW_COUNT_MIN <= n <= EXPECTED_ROW_COUNT_MAX):
        raise SystemExit(
            f"refresh-gaia-hip-xmatch: row count {n} outside expected "
            f"[{EXPECTED_ROW_COUNT_MIN}, {EXPECTED_ROW_COUNT_MAX}] — "
            f"upstream schema or selection has changed; investigate before re-pinning."
        )

    rows = ({col: row[col] for col in TSV_COLUMNS} for row in table)
    written = rl.write_tsv(
        rows,
        columns=TSV_COLUMNS,
        output=OUT,
        round_floats=ANGULAR_DISTANCE_DECIMALS,
    )
    print(f"wrote {OUT.relative_to(ROOT)} ({written} rows)")


if __name__ == "__main__":
    main()
