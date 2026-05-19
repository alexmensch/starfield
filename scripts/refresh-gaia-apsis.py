#!/usr/bin/env python3
"""Refresh data/gaia_dr3_apsis.tsv — Gaia DR3 Apsis astrophysical parameters.

Phase 1 of the source-ID-anchored catalogue-pipeline rewrite (stellata-dch).
Pulls per-Gaia-source spectroscopic stellar parameters from
`gaiadr3.astrophysical_parameters` — the (Teff, logg, [M/H], A0) products
of the Apsis processing chain (Creevey+22 GSP-Phot, Recio-Blanco+23
GSP-Spec). Coverage of (Teff, logg) goes from 29.3% (spectral-class
parsing in `catalog-pure.ts`) to 84.8% — see
research/star-spectral-rendition/RECOMMENDATION.md § Tier 2.

Two pipelines per source:
  * GSP-Phot — BP/RP photometric spectra, ~470 M DR3 sources, robust to
    crowding; columns `*_gspphot`.
  * GSP-Spec — RVS high-resolution spectra, ~5 M sources at G_RVS ≤ 14;
    columns `*_gspspec`. Higher-quality but bright-end only.

Either pipeline can return NULL for any cell independently — see the live
2026-05-18 probe in research/star-spectral-rendition/apsis_coverage.txt.
The unfiltered query returns ~99.9% of AT-HYG.gaia source_ids (a row
exists per source even when every Apsis column is masked). The 84.8%
figure that motivates ingest is the UNION of (Teff, logg) populated by
either pipeline — a downstream stat, not the query's row count.

ADQL (per batch)
    SELECT source_id,
           teff_gspphot, logg_gspphot, mh_gspphot, azero_gspphot,
           teff_gspspec, logg_gspspec, mh_gspspec
    FROM gaiadr3.astrophysical_parameters
    WHERE source_id IN (<AT-HYG source_id batch>)
    ORDER BY source_id

Backend: ESA Gaia archive (default refresh_lib ESA → CDS fallback).
Batched IN-clause queries per dch.21; 5000 ids per batch matches the
empirical bailer-jones sweet spot.

TSV columns (8) — see file docstring for `gaiadr3.astrophysical_parameters`
upstream documentation. All upstream column names preserved verbatim;
empty cells in the TSV correspond to masked (NULL) values from TAP.

Idempotent — exits early if the output is newer than this script AND the
AT-HYG source CSV. Pass `--force` to rebuild unconditionally.

Venv setup (see scripts/requirements-refresh.txt):
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements-refresh.txt
    .venv/bin/python scripts/refresh-gaia-apsis.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import refresh_lib as rl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ATHYG = ROOT / "data" / "athyg_33_classic_ids.csv"
OUT = ROOT / "data" / "gaia_dr3_apsis.tsv"

TSV_COLUMNS = [
    "source_id",
    "teff_gspphot",
    "logg_gspphot",
    "mh_gspphot",
    "azero_gspphot",
    "teff_gspspec",
    "logg_gspspec",
    "mh_gspspec",
]

ADQL_TEMPLATE = (
    "SELECT " + ", ".join(TSV_COLUMNS) + " "
    "FROM gaiadr3.astrophysical_parameters "
    "WHERE source_id IN ({inlist})"
)

# upstream dtypes: int64 + 7 × float32 (live probe 2026-05-18).
# validate_schema maps `float` to np.floating via _dtype_matches so the
# float32 width passes — bailer-jones uses the same pattern.
EXPECTED_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "source_id": int,
    "teff_gspphot": float,
    "logg_gspphot": float,
    "mh_gspphot": float,
    "azero_gspphot": float,
    "teff_gspspec": float,
    "logg_gspspec": float,
    "mh_gspspec": float,
}

# 5000 ids per IN-clause — same empirical sweet spot as refresh-bailer-jones.py
# (CDS / ESA TAP runtime is superlinear in IN-clause length beyond ~5k).
BATCH_SIZE = 5_000

# DR3 is frozen — the 1000-source-id probe returned 999 rows (99.9% of
# input). AT-HYG.gaia has 314,865 source_ids, so ~314,550 ± 5% is the
# expected count. The earlier draft of the bead spec quoted ~266k; that
# is the UNION-(teff+logg) coverage projection (~84.8%), not the query's
# row count. The unfiltered TAP query returns all matched rows including
# all-NULL Apsis rows.
EXPECTED_ROW_COUNT_MIN = 298_000
EXPECTED_ROW_COUNT_MAX = 330_000

# Union-(teff+logg) coverage projection — the actual ingestable bucket.
EXPECTED_UNION_COVERAGE_MIN = 0.80

# Teff has order ~1-10 K formal uncertainty, logg ~0.01-0.1 dex,
# [M/H] ~0.01-0.1 dex, A_0 ~0.01-0.1 mag. 4 decimals on logg/mh/azero
# preserves all useful signal; teff stays integer-K (1 decimal handles
# the rare fractional values Gaia emits).
TEFF_DECIMALS = 1
DEX_DECIMALS = 4

# Self-consistency spot-checks against pinned DR3 Apsis rows. DR3 is
# frozen so values can be pinned tightly; tolerance set to ~1% of the
# formal uncertainty quoted in DR3 (looser than archive-side rounding,
# tighter than any plausible drift this script could itself introduce).
#
# Three rows × 8 fields across the three Apsis coverage shapes so a
# DR3.x reload, column rename, or null-handling regression surfaces
# against at least one row whose code-path it touched. The all-null row
# is critical — it exercises `coerce_masked` for every column
# simultaneously, the most common silent-corruption shape.
#
#   - JOINT     : gspphot + gspspec both populated (joint case)
#   - PHOT_ONLY : gspphot populated, gspspec masked  (BP/RP only)
#   - ALL_NULL  : astrophysical_parameters row exists but every Apsis
#                 cell is masked (no Apsis processing for this source)
#
# Pattern matches refresh-gaia-nss.py's 3-rows × 3-solution-type
# robustness extension, applied to the Apsis coverage axis instead.
SPOT_CHECKS: list[dict[str, Any]] = [
    {
        "source_id":     164919361120841856,  # JOINT — gspphot + gspspec
        "teff_gspphot":  (6115.373, 0.01),
        "logg_gspphot":  (3.4688, 0.001),
        "mh_gspphot":    (-0.4904, 0.001),
        "azero_gspphot": (0.677, 0.001),
        "teff_gspspec":  (6624.0, 0.1),
        "logg_gspspec":  (4.17, 0.01),
        "mh_gspspec":    (-0.07, 0.01),
    },
    {
        "source_id":     1631144127080202752,  # PHOT_ONLY — gspspec masked
        "teff_gspphot":  (6807.42, 0.01),
        "logg_gspphot":  (3.6578, 0.001),
        "mh_gspphot":    (-0.3636, 0.001),
        "azero_gspphot": (0.0655, 0.001),
        "teff_gspspec":  None,
        "logg_gspspec":  None,
        "mh_gspspec":    None,
    },
    {
        "source_id":     3305738406773071744,  # ALL_NULL — every column masked
        "teff_gspphot":  None,
        "logg_gspphot":  None,
        "mh_gspphot":    None,
        "azero_gspphot": None,
        "teff_gspspec":  None,
        "logg_gspspec":  None,
        "mh_gspspec":    None,
    },
]


def query_batch(client: rl.TapClient, ids: list[int]):
    inlist = ",".join(str(i) for i in ids)
    return client.run(ADQL_TEMPLATE.format(inlist=inlist))


def check_spot_row(rows_by_id: dict[int, Any], spec: dict[str, Any]) -> None:
    """Assert one pinned row matches expectations; raise SystemExit listing
    every mismatched field (not just the first) so a future DR3.x reload
    or column rename shows the full delta in a single failure message.

    Expected-value forms in `spec`:
      - (float, float)       : (expected, abs-tolerance)
      - None                 : the cell must be masked / null
    """
    sid = spec["source_id"]
    row = rows_by_id.get(sid)
    if row is None:
        raise SystemExit(
            f"refresh-gaia-apsis: spot-check source_id {sid} missing from "
            f"query result — upstream selection has changed."
        )
    deltas: list[str] = []
    for field, expected in spec.items():
        if field == "source_id":
            continue
        actual = rl.coerce_masked(row[field])
        if expected is None:
            if actual is not None:
                deltas.append(f"  {field}: expected NULL, got {actual!r}")
        else:
            want, tol = expected
            if actual is None:
                deltas.append(f"  {field}: expected ~{want} (±{tol}), got NULL")
            elif abs(float(actual) - float(want)) > tol:
                deltas.append(f"  {field}: expected ~{want} (±{tol}), got {float(actual)}")
    if deltas:
        joined = "\n".join(deltas)
        raise SystemExit(
            f"refresh-gaia-apsis: spot-check source_id {sid} drift — "
            f"{len(deltas)} field(s) outside tolerance:\n{joined}"
        )


def report_coverage(rows_by_id: dict[int, Any], total_input: int) -> float:
    """Log per-pipeline and union (Teff AND logg) coverage; return union %.
    Union coverage is the headline number motivating Apsis ingest — see
    research/star-spectral-rendition/RECOMMENDATION.md § Tier 2.
    """
    n = len(rows_by_id)
    phot = sum(
        1 for r in rows_by_id.values()
        if rl.coerce_masked(r["teff_gspphot"]) is not None
        and rl.coerce_masked(r["logg_gspphot"]) is not None
    )
    spec = sum(
        1 for r in rows_by_id.values()
        if rl.coerce_masked(r["teff_gspspec"]) is not None
        and rl.coerce_masked(r["logg_gspspec"]) is not None
    )
    union = sum(
        1 for r in rows_by_id.values()
        if (
            rl.coerce_masked(r["teff_gspphot"]) is not None
            and rl.coerce_masked(r["logg_gspphot"]) is not None
        ) or (
            rl.coerce_masked(r["teff_gspspec"]) is not None
            and rl.coerce_masked(r["logg_gspspec"]) is not None
        )
    )
    print(
        f"coverage of {total_input} AT-HYG source_ids:\n"
        f"  astrophysical_parameters row:  {n:>6} ({100*n/total_input:.1f}%)\n"
        f"  (teff_gspphot AND logg_gspphot): {phot:>6} ({100*phot/total_input:.1f}%)\n"
        f"  (teff_gspspec AND logg_gspspec): {spec:>6} ({100*spec/total_input:.1f}%)\n"
        f"  union (teff+logg, either):       {union:>6} ({100*union/total_input:.1f}%)"
    )
    return union / total_input


def write_row(row: Any) -> dict[str, Any]:
    """Build one output dict — coerce_masked every cell, round floats so
    write_tsv emits stable widths. Teff stays at 1 decimal; logg / [M/H]
    / A_0 at 4 decimals (~1% of formal uncertainty, see DEX_DECIMALS)."""
    out: dict[str, Any] = {"source_id": int(row["source_id"])}
    for col in TSV_COLUMNS[1:]:
        v = rl.coerce_masked(row[col])
        if v is None:
            out[col] = None
        elif col.startswith("teff_"):
            out[col] = f"{float(v):.{TEFF_DECIMALS}f}"
        else:
            out[col] = f"{float(v):.{DEX_DECIMALS}f}"
    return out


def main() -> None:
    force = "--force" in sys.argv

    if not force and rl.is_up_to_date(OUT, [Path(__file__), ATHYG]):
        print(f"{OUT.relative_to(ROOT)} up to date — skipping (use --force to rebuild)")
        return

    source_ids = rl.read_athyg_source_ids(ATHYG)
    total = len(source_ids)
    if total == 0:
        raise SystemExit(f"refresh-gaia-apsis: no source_ids in {ATHYG}")
    n_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    print(
        f"reading {total} AT-HYG source_ids → {n_batches} batches of "
        f"{BATCH_SIZE} on Gaia TAP (gaiadr3.astrophysical_parameters)"
    )

    client = rl.TapClient()
    rows_by_id: dict[int, Any] = {}
    start = time.time()
    for batch_idx, offset in enumerate(range(0, total, BATCH_SIZE), start=1):
        batch = source_ids[offset : offset + BATCH_SIZE]
        t0 = time.time()
        table = query_batch(client, batch)
        if batch_idx == 1:
            rl.validate_schema(
                table, EXPECTED_SCHEMA, label="gaiadr3.astrophysical_parameters"
            )
        for row in table:
            rows_by_id[int(row["source_id"])] = row
        elapsed = time.time() - t0
        cum = time.time() - start
        print(
            f"  batch {batch_idx}/{n_batches}: "
            f"{len(table):4d} rows in {elapsed:5.1f}s "
            f"(cum {cum/60:.1f}m, total rows {len(rows_by_id)})"
        )

    matched = len(rows_by_id)
    print(f"matched {matched}/{total} in {(time.time()-start)/60:.1f}m")

    if not (EXPECTED_ROW_COUNT_MIN <= matched <= EXPECTED_ROW_COUNT_MAX):
        raise SystemExit(
            f"refresh-gaia-apsis: row count {matched} outside expected "
            f"[{EXPECTED_ROW_COUNT_MIN}, {EXPECTED_ROW_COUNT_MAX}] — "
            f"upstream selection or AT-HYG.gaia subset has changed; "
            f"investigate before re-pinning."
        )

    union_coverage = report_coverage(rows_by_id, total)
    if union_coverage < EXPECTED_UNION_COVERAGE_MIN:
        raise SystemExit(
            f"refresh-gaia-apsis: union (teff+logg) coverage "
            f"{union_coverage:.1%} below floor "
            f"{EXPECTED_UNION_COVERAGE_MIN:.0%} — Apsis pipeline output "
            f"or AT-HYG cross-match has regressed; investigate."
        )

    for spec in SPOT_CHECKS:
        check_spot_row(rows_by_id, spec)

    # Emit sorted by source_id so re-runs are byte-identical.
    rows = (write_row(rows_by_id[sid]) for sid in sorted(rows_by_id))
    written = rl.write_tsv(rows, columns=TSV_COLUMNS, output=OUT)
    print(f"wrote {OUT.relative_to(ROOT)} ({written} rows)")


if __name__ == "__main__":
    main()
