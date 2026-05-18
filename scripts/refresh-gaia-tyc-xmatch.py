#!/usr/bin/env python3
"""Refresh data/gaia_dr3_tyc_xmatch.tsv — Tycho-2 → Gaia DR3 source_id cross-walk.

Phase 1 of the source-ID-anchored catalogue-pipeline rewrite (stellata-dch).
Companion to scripts/refresh-gaia-hip-xmatch.py: HIP covers V ≲ 9 and
Tycho-2 (with TDSC merged in) extends down to V ~ 11.5, so this TSV is
how the Stage 1 indexer resolves any Tycho-2 / TDSC component to a Gaia
DR3 source_id without a position match.

ADQL
    SELECT
      original_ext_source_id AS tyc,
      source_id              AS gaia_source_id,
      angular_distance,
      number_of_neighbours,
      xm_flag
    FROM gaiadr3.tycho2tdsc_merge_best_neighbour
    WHERE source_id IS NOT NULL
    ORDER BY original_ext_source_id

`gaiadr3.tycho2tdsc_merge_best_neighbour` is the official Gaia DR3 ×
(Tycho-2 + TDSC) cross-match — ~2.52M rows, all with a non-null
source_id. The merged source catalogue rolls TDSC double-star
components into Tycho-2 identifiers; rows are keyed by the bare
`NNNN-NNNN-N` form (no "TYC " prefix).

TSV columns (5)
    tyc                  str   — Tycho-2 / TDSC identifier ("NNNN-NNNN-N")
    gaia_source_id       int   — Gaia DR3 source_id
    angular_distance     float — match separation, arcsec (6 decimals)
    number_of_neighbours int   — ambiguity flag (1 = unique Gaia neighbour)
    xm_flag              int   — Gaia cross-match flag (see DR3 docs)

Identical 5-column shape to refresh-gaia-hip-xmatch.py so Stage 1 can
ingest both with one parser.

Idempotent — exits early if the output is newer than this script. Pass
`--force` to rebuild unconditionally. Backend fallback (ESA → CDS) is
provided by refresh_lib.TapClient.

Venv setup (see scripts/requirements-refresh.txt):
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements-refresh.txt
    .venv/bin/python scripts/refresh-gaia-tyc-xmatch.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import refresh_lib as rl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "gaia_dr3_tyc_xmatch.tsv"

ADQL = """
SELECT
  original_ext_source_id AS tyc,
  source_id              AS gaia_source_id,
  angular_distance,
  number_of_neighbours,
  xm_flag
FROM gaiadr3.tycho2tdsc_merge_best_neighbour
WHERE source_id IS NOT NULL
ORDER BY original_ext_source_id
"""

TSV_COLUMNS = [
    "tyc",
    "gaia_source_id",
    "angular_distance",
    "number_of_neighbours",
    "xm_flag",
]

EXPECTED_SCHEMA = {
    "tyc": str,
    "gaia_source_id": int,
    "angular_distance": float,
    "number_of_neighbours": int,
    "xm_flag": int,
}

# Tight bounds around the empirically-observed Gaia DR3 row count (2,518,330).
# DR3 is a frozen release so the count should not change; the small slack
# tolerates a hypothetical archive re-index without false-negatives.
EXPECTED_ROW_COUNT_MIN = 2_510_000
EXPECTED_ROW_COUNT_MAX = 2_530_000

# arcsec precision retained on angular_distance. Matches refresh-gaia-hip-xmatch.py.
ANGULAR_DISTANCE_DECIMALS = 6


def main() -> None:
    force = "--force" in sys.argv

    if not force and rl.is_up_to_date(OUT, [Path(__file__)]):
        print(f"{OUT.relative_to(ROOT)} up to date — skipping (use --force to rebuild)")
        return

    client = rl.TapClient()
    print("querying ESA Gaia TAP (fallback: CDS) — gaiadr3.tycho2tdsc_merge_best_neighbour …")
    table = client.run(ADQL)

    rl.validate_schema(table, EXPECTED_SCHEMA, label="tycho2tdsc_merge_best_neighbour")

    n = len(table)
    if not (EXPECTED_ROW_COUNT_MIN <= n <= EXPECTED_ROW_COUNT_MAX):
        raise SystemExit(
            f"refresh-gaia-tyc-xmatch: row count {n} outside expected "
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
