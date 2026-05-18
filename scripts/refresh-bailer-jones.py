#!/usr/bin/env python3
"""Refresh data/bailer-jones-dr3.tsv — Bayesian DR3 distance posteriors.

Phase 1 of the source-ID-anchored catalogue-pipeline rewrite (stellata-dch).
Bailer-Jones et al. 2021 (AJ 161, 147; VizieR I/352) publishes Bayesian
distance posteriors (`r_med_geo`, `r_med_photogeo`) for every Gaia DR3
source. The principled fix for AT-HYG's naive-1/parallax distances on
low-S/N parallaxes (see stellata-dch.46 for the OB-supergiant outlier
class that motivated this).

ADQL
    SELECT bj."Source", bj."rgeo", bj."b_rgeo", bj."B_rgeo",
           bj."rpgeo", bj."b_rpgeo", bj."B_rpgeo", bj."Flag"
    FROM "I/352/gedr3dis" AS bj
    WHERE bj."Source" IN (<AT-HYG source_id batch>)

VizieR exposes the table with case-sensitive column names: `Source`,
`rgeo` / `b_rgeo` / `B_rgeo` (lowercase b = lower bound, uppercase B =
upper bound), `rpgeo` / `b_rpgeo` / `B_rpgeo`, `Flag`. The script renames
to the paper's `r_med_*` / `r_lo_*` / `r_hi_*` form on write — the TSV
is self-documenting against the Bailer-Jones 2021 reference.

TSV columns (8)
    source_id        int   — Gaia DR3 source_id
    r_med_geo        float — geometric posterior median distance (pc)
    r_lo_geo         float — geometric posterior 16th-percentile lower bound
    r_hi_geo         float — geometric posterior 84th-percentile upper bound
    r_med_photogeo   float — photogeometric posterior median (pc)
    r_lo_photogeo    float — photogeometric posterior 16th-percentile lower
    r_hi_photogeo    float — photogeometric posterior 84th-percentile upper
    flag             int   — Bailer-Jones quality flag (see I/352 docs)

Backend: CDS only. I/352/gedr3dis is a VizieR-published external catalogue
not hosted on the ESA Gaia archive, so the default ESA→CDS fallback does
not apply.

Batch size: 5000 source_ids per IN-clause query. Empirical CDS sweet
spot — runtime is superlinear in batch size beyond this.

Coverage expectation: ≥ 90% of AT-HYG.gaia source_ids resolve. The ~10%
gap is the bright-end saturation cliff that Gaia's own astrometry hits.

Idempotent — exits early if the output is newer than this script AND the
AT-HYG source CSV. Pass `--force` to rebuild unconditionally.

Venv setup (see scripts/requirements-refresh.txt):
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements-refresh.txt
    .venv/bin/python scripts/refresh-bailer-jones.py
"""

from __future__ import annotations

import csv
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import refresh_lib as rl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ATHYG = ROOT / "data" / "athyg_33_classic_ids.csv"
OUT = ROOT / "data" / "bailer-jones-dr3.tsv"

# 5000 ids → ~98 KB query, ~80 s round-trip on CDS TAP. 10000 was ~5 min
# (superlinear server cost in IN-clause length).
BATCH_SIZE = 5_000

# Pinned coverage bounds. AT-HYG has ~315 k source_ids; the empirical first
# 5000-id probe returned 98.7%, so ≥ 90% (~283 k) is the floor and the
# upper bound is just AT-HYG itself (can't exceed input set size).
EXPECTED_COVERAGE_MIN = 0.90
EXPECTED_ROW_COUNT_MAX = 320_000

# Distance precision: B-J posterior intervals are typically ±10% of the
# median (e.g. ±30 pc on a 350 pc star), so 0.001 pc (millipc) preserves
# all useful signal without bloating the TSV.
DISTANCE_DECIMALS = 3

# VizieR-on-the-wire → paper-name TSV column mapping. The keys are the
# case-sensitive column names exposed by I/352/gedr3dis on the VizieR
# TAP service; the values are the Bailer-Jones 2021 paper's names (and
# what downstream consumers — build-catalog.ts etc. — will read).
VIZIER_TO_PAPER = {
    "Source": "source_id",
    "rgeo": "r_med_geo",
    "b_rgeo": "r_lo_geo",
    "B_rgeo": "r_hi_geo",
    "rpgeo": "r_med_photogeo",
    "b_rpgeo": "r_lo_photogeo",
    "B_rpgeo": "r_hi_photogeo",
    "Flag": "flag",
}

# Output column order — see file docstring for semantics.
TSV_COLUMNS = list(VIZIER_TO_PAPER.values())

# Schema expected from the VizieR TAP table (validated post-query).
EXPECTED_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "Source": int,
    "rgeo": float,
    "b_rgeo": float,
    "B_rgeo": float,
    "rpgeo": float,
    "b_rpgeo": float,
    "B_rpgeo": float,
    "Flag": int,
}

ADQL_TEMPLATE = (
    'SELECT "Source", "rgeo", "b_rgeo", "B_rgeo", '
    '"rpgeo", "b_rpgeo", "B_rpgeo", "Flag" '
    'FROM "I/352/gedr3dis" '
    'WHERE "Source" IN ({inlist})'
)


def read_athyg_source_ids(csv_path: Path) -> list[int]:
    """Return the non-empty, non-zero Gaia DR3 source_id list from AT-HYG.

    Sol (id=1) and a handful of historical rows carry an empty `gaia`
    field — we drop those; Bailer-Jones is defined per Gaia source only.
    """
    ids: list[int] = []
    with csv_path.open(newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        gi = header.index("gaia")
        for row in reader:
            cell = row[gi]
            if cell and cell != "0":
                ids.append(int(cell))
    return ids


def query_batch(client: rl.TapClient, ids: list[int]):
    inlist = ",".join(str(i) for i in ids)
    return client.run(ADQL_TEMPLATE.format(inlist=inlist))


def rename_row(row, vizier_to_paper: dict[str, str]) -> dict[str, object]:
    return {paper: row[vizier] for vizier, paper in vizier_to_paper.items()}


def main() -> None:
    force = "--force" in sys.argv

    if not force and rl.is_up_to_date(OUT, [Path(__file__), ATHYG]):
        print(f"{OUT.relative_to(ROOT)} up to date — skipping (use --force to rebuild)")
        return

    source_ids = read_athyg_source_ids(ATHYG)
    total = len(source_ids)
    if total == 0:
        raise SystemExit(f"refresh-bailer-jones: no source_ids in {ATHYG}")
    n_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    print(
        f"reading {total} AT-HYG source_ids → {n_batches} batches of "
        f"{BATCH_SIZE} on CDS TAP (I/352/gedr3dis)"
    )

    client = rl.TapClient(backends=[rl.cds_backend()])
    rows: list[dict[str, object]] = []
    start = time.time()
    for batch_idx, offset in enumerate(range(0, total, BATCH_SIZE), start=1):
        batch = source_ids[offset : offset + BATCH_SIZE]
        t0 = time.time()
        table = query_batch(client, batch)
        if batch_idx == 1:
            rl.validate_schema(table, EXPECTED_SCHEMA, label="bailer-jones I/352/gedr3dis")
        for row in table:
            rows.append(rename_row(row, VIZIER_TO_PAPER))
        elapsed = time.time() - t0
        cum = time.time() - start
        print(
            f"  batch {batch_idx}/{n_batches}: "
            f"{len(table):4d} rows in {elapsed:5.1f}s "
            f"(cum {cum/60:.1f}m, total rows {len(rows)})"
        )

    matched = len(rows)
    coverage = matched / total
    print(
        f"matched {matched}/{total} = {coverage*100:.1f}% in "
        f"{(time.time()-start)/60:.1f}m"
    )
    if coverage < EXPECTED_COVERAGE_MIN:
        raise SystemExit(
            f"refresh-bailer-jones: coverage {coverage:.1%} below floor "
            f"{EXPECTED_COVERAGE_MIN:.0%} — VizieR table or AT-HYG source_id "
            f"set has changed; investigate before re-pinning."
        )
    if matched > EXPECTED_ROW_COUNT_MAX:
        raise SystemExit(
            f"refresh-bailer-jones: row count {matched} above ceiling "
            f"{EXPECTED_ROW_COUNT_MAX} — input set must have grown; "
            f"raise the ceiling intentionally."
        )

    written = rl.write_tsv(
        rows,
        columns=TSV_COLUMNS,
        output=OUT,
        round_floats=DISTANCE_DECIMALS,
    )
    print(f"wrote {OUT.relative_to(ROOT)} ({written} rows)")


if __name__ == "__main__":
    main()
