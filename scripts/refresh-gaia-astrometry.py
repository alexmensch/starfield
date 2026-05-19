#!/usr/bin/env python3
"""Refresh data/gaia_dr3_astrometry.tsv — Gaia DR3 astrometry by source_id.

Phase 2 Stage 2-output consumer (stellata-dch.29). Reads the deduped
``data/gaia_astrometry_source_id_request.tsv`` produced by
scripts/build-binaries.py Stage 2 (stellata-dch.28), chunks the
source_id list, queries ``gaiadr3.gaia_source`` via TAP, and writes
the per-source astrometry needed by Stage 3 (stellata-dch.30) and
Stage 4 (stellata-dch.31).

Querying by source_id rather than position bypasses the orbital-
contamination problem entirely for close binaries — there is no
"nearest neighbour" ambiguity when the source_id is already resolved
upstream.

ADQL (per batch)
    SELECT source_id, ra, ra_error, dec, dec_error,
           parallax, parallax_error,
           pmra, pmra_error, pmdec, pmdec_error,
           ref_epoch, ruwe, ipd_frac_multi_peak,
           phot_g_mean_mag, phot_bp_mean_mag, phot_rp_mean_mag
    FROM gaiadr3.gaia_source
    WHERE source_id IN (<Stage-2 source_id batch>)

Backend: ESA Gaia archive (default refresh_lib ESA → CDS fallback).
Batched IN-clause queries; 5000 ids per batch matches the empirical
bailer-jones sweet spot. The Gaia archive's IN-list cap is ~5000.

TSV columns (17) — see file docstring for `gaiadr3.gaia_source`
upstream documentation. All upstream column names preserved verbatim;
empty cells correspond to masked (NULL) values from TAP. ``ruwe`` +
``ipd_frac_multi_peak`` are consumed by Stage 3 (stellata-dch.30) to
flag unreliable single-star solutions.

Coverage expectation: ≥ 95% of input source_ids resolve. The small
shortfall covers retracted-DR3 sources and any IDs Stage 2 emitted
that the live ``gaia_source`` table no longer carries. The bead spec's
±5% acceptance is encoded as ``EXPECTED_COVERAGE_MIN``.

Idempotent — exits early if the output is newer than this script AND
the Stage-2 request file. Pass ``--force`` to rebuild unconditionally.

Note on the bead's original Sirius-A spot-check: Sirius A's
``source_id`` 2947050466531873024 is NOT in the Stage-2 request file.
Stage 2 dch.28 only resolves components via the Gaia cross-match
tables (``gaiadr3.hipparcos2_best_neighbour`` /
``gaiadr3.tycho2tdsc_merge_best_neighbour``); Sirius A (V=-1.46)
saturates Gaia and is absent from both. The bead description was
updated to drop the Sirius example; this script uses pinned source_ids
that are confirmed members of the request file (see SPOT_CHECKS).

Venv setup (see scripts/requirements-refresh.txt):
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements-refresh.txt
    .venv/bin/python scripts/refresh-gaia-astrometry.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import refresh_lib as rl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REQUEST = ROOT / "data" / "gaia_astrometry_source_id_request.tsv"
OUT = ROOT / "data" / "gaia_dr3_astrometry.tsv"

TSV_COLUMNS = [
    "source_id",
    "ra",
    "ra_error",
    "dec",
    "dec_error",
    "parallax",
    "parallax_error",
    "pmra",
    "pmra_error",
    "pmdec",
    "pmdec_error",
    "ref_epoch",
    "ruwe",
    "ipd_frac_multi_peak",
    "phot_g_mean_mag",
    "phot_bp_mean_mag",
    "phot_rp_mean_mag",
]

ADQL_TEMPLATE = (
    "SELECT " + ", ".join(TSV_COLUMNS) + " "
    "FROM gaiadr3.gaia_source "
    "WHERE source_id IN ({inlist})"
)

# Gaia DR3 dtype shape: ``ipd_frac_multi_peak`` is a short (0-100
# percent) integer; everything else is float64 except ``source_id``
# (int64) and the photometry magnitudes (float32). The
# refresh_lib._dtype_matches supertype map handles width variance.
EXPECTED_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "source_id": int,
    "ra": float,
    "ra_error": float,
    "dec": float,
    "dec_error": float,
    "parallax": float,
    "parallax_error": float,
    "pmra": float,
    "pmra_error": float,
    "pmdec": float,
    "pmdec_error": float,
    "ref_epoch": float,
    "ruwe": float,
    "ipd_frac_multi_peak": int,
    "phot_g_mean_mag": float,
    "phot_bp_mean_mag": float,
    "phot_rp_mean_mag": float,
}

# 5000 ids per IN-clause — Gaia archive's IN-list cap and the empirical
# bailer-jones / apsis sweet spot.
BATCH_SIZE = 5_000

# Coverage floor — bead acceptance says output row count matches input
# ±5%, i.e. ≥ 95% of input ids resolve. The shortfall captures retracted
# DR3 sources + the rare ID-only-in-cross-match-table edge cases.
EXPECTED_COVERAGE_MIN = 0.95

# Astrometric precision retained. Gaia DR3 angular astrometry is sub-mas
# (~1e-3 arcsec); 9 decimals on ra/dec (degrees) preserves the full
# precision Gaia publishes. Errors and PMs use 4 decimals — 0.1 µas on
# parallax/PM is well below the noise floor of any DR3 source.
DEG_DECIMALS = 9
ERR_DECIMALS = 4
RUWE_DECIMALS = 4
MAG_DECIMALS = 6
REF_EPOCH_DECIMALS = 2

# Per-column rounding rules.
COLUMN_DECIMALS: dict[str, int] = {
    "ra":                  DEG_DECIMALS,
    "dec":                 DEG_DECIMALS,
    "ra_error":            ERR_DECIMALS,
    "dec_error":           ERR_DECIMALS,
    "parallax":            ERR_DECIMALS,
    "parallax_error":      ERR_DECIMALS,
    "pmra":                ERR_DECIMALS,
    "pmra_error":          ERR_DECIMALS,
    "pmdec":               ERR_DECIMALS,
    "pmdec_error":         ERR_DECIMALS,
    "ruwe":                RUWE_DECIMALS,
    "phot_g_mean_mag":     MAG_DECIMALS,
    "phot_bp_mean_mag":    MAG_DECIMALS,
    "phot_rp_mean_mag":    MAG_DECIMALS,
    "ref_epoch":           REF_EPOCH_DECIMALS,
}

# DR3 reference epoch is J2016.0 for the full catalogue. Pin it so a
# DR4 swap-in (which would change to J2017.5) is caught immediately —
# the build-binaries Stage 3 epoch propagation assumes 2016.0.
EXPECTED_REF_EPOCH = 2016.0
REF_EPOCH_TOL = 0.01

# Self-consistency spot-checks against pinned DR3 ``gaia_source`` rows.
# DR3 is frozen so values can be pinned tightly; tolerance is set to
# ~1% of the formal uncertainty quoted in DR3 (looser than archive-side
# rounding, tighter than any plausible drift this script could itself
# introduce).
#
# Three rows so a DR4 column rename, unit change, or epoch swap surfaces
# against at least one row whose code-path it touched. All three are
# confirmed members of the Stage-2 request file (see notes in module
# docstring on why Sirius A from the original bead spec is not).
#
# Pattern matches refresh-gaia-nss.py's 3-rows-per-shape robustness.
SPOT_CHECKS: list[dict[str, Any]] = [
    # Pinned from the live ESA Gaia archive on 2026-05-19. Three rows
    # spanning the request file: first row (largest at-bat for ingest-
    # side row-1 bugs), mid-file row, and a HIP-anchored low-RA row
    # near the file tail. Picking source_ids that are confirmed members
    # of the request file (vs. the bead spec's Sirius example, which is
    # not — Gaia saturates at V ≲ 4 so the WDS bright-binary tail does
    # not appear in Stage 2's HIP / TYC cross-match output).
    {
        "source_id":          594595272471808,    # request file row 1
        "ref_epoch":          (2016.0, REF_EPOCH_TOL),
        "parallax":           (11.0297, 0.001),
        "pmra":               (49.4157, 0.001),
        "pmdec":              (-45.9419, 0.001),
        "phot_g_mean_mag":    (11.953011, 0.0001),
    },
    {
        "source_id":          3723554268436602240,  # request file row 5000
        "ref_epoch":          (2016.0, REF_EPOCH_TOL),
        "parallax":           (3.0991, 0.001),
        "pmra":               (-189.5386, 0.001),
        "pmdec":              (-70.4150, 0.001),
        "phot_g_mean_mag":    (5.874960, 0.0001),
    },
    {
        "source_id":          4923860051276772608,  # HIP 65 (first HIP)
        "ref_epoch":          (2016.0, REF_EPOCH_TOL),
        "parallax":           (16.1641, 0.001),
        "pmra":               (-202.7111, 0.001),
        "pmdec":              (-71.6125, 0.001),
        "phot_g_mean_mag":    (10.588468, 0.0001),
    },
]


def read_source_ids(path: Path) -> list[int]:
    """Read the one-column request TSV; skip the header row.

    Contract from scripts/build-binaries.py:write_astrometry_request —
    one ``gaia_source_id`` column, sorted, unique, non-null.
    """
    ids: list[int] = []
    with path.open() as f:
        header = f.readline().strip()
        if header != "gaia_source_id":
            raise SystemExit(
                f"refresh-gaia-astrometry: unexpected header {header!r} in "
                f"{path} — expected 'gaia_source_id'."
            )
        for line in f:
            line = line.strip()
            if line:
                ids.append(int(line))
    return ids


def query_batch(client: rl.TapClient, ids: list[int]):
    inlist = ",".join(str(i) for i in ids)
    return client.run(ADQL_TEMPLATE.format(inlist=inlist))


def check_spot_row(rows_by_id: dict[int, Any], spec: dict[str, Any]) -> None:
    """Assert one pinned row matches expectations; raise SystemExit
    listing every mismatched field so a future DR3.x reload, column
    rename, or epoch swap shows the full delta in a single failure
    message.

    Expected-value forms in `spec`:
      - (float, float)  : (expected, abs-tolerance)
      - None            : the cell must be masked / null
    """
    sid = spec["source_id"]
    row = rows_by_id.get(sid)
    if row is None:
        raise SystemExit(
            f"refresh-gaia-astrometry: spot-check source_id {sid} missing "
            f"from query result — upstream selection has changed."
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
                deltas.append(
                    f"  {field}: expected ~{want} (±{tol}), got {float(actual)}"
                )
    if deltas:
        joined = "\n".join(deltas)
        raise SystemExit(
            f"refresh-gaia-astrometry: spot-check source_id {sid} drift — "
            f"{len(deltas)} field(s) outside tolerance:\n{joined}"
        )


def write_row(row: Any) -> dict[str, Any]:
    """Build one output dict — coerce_masked every cell, pre-round
    floats per COLUMN_DECIMALS so write_tsv emits stable widths."""
    out: dict[str, Any] = {"source_id": int(row["source_id"])}
    for col in TSV_COLUMNS[1:]:
        v = rl.coerce_masked(row[col])
        if v is None:
            out[col] = None
        elif col in COLUMN_DECIMALS:
            out[col] = f"{float(v):.{COLUMN_DECIMALS[col]}f}"
        else:
            out[col] = v
    return out


def main() -> None:
    force = "--force" in sys.argv

    if not force and rl.is_up_to_date(OUT, [Path(__file__), REQUEST]):
        print(f"{OUT.relative_to(ROOT)} up to date — skipping (use --force to rebuild)")
        return

    if not REQUEST.exists():
        raise SystemExit(
            f"refresh-gaia-astrometry: request file {REQUEST.relative_to(ROOT)} "
            f"is missing — run `npm run build:binaries` (Phase 2 Stage 2) first."
        )

    source_ids = read_source_ids(REQUEST)
    total = len(source_ids)
    if total == 0:
        raise SystemExit(
            f"refresh-gaia-astrometry: no source_ids in {REQUEST.relative_to(ROOT)}"
        )
    n_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    print(
        f"reading {total} Stage-2 source_ids → {n_batches} batches of "
        f"{BATCH_SIZE} on Gaia TAP (gaiadr3.gaia_source)"
    )

    client = rl.TapClient()
    rows_by_id: dict[int, Any] = {}
    start = time.time()
    for batch_idx, offset in enumerate(range(0, total, BATCH_SIZE), start=1):
        batch = source_ids[offset : offset + BATCH_SIZE]
        t0 = time.time()
        table = query_batch(client, batch)
        if batch_idx == 1:
            rl.validate_schema(table, EXPECTED_SCHEMA, label="gaiadr3.gaia_source")
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
    coverage = matched / total
    print(
        f"matched {matched}/{total} = {coverage*100:.1f}% in "
        f"{(time.time()-start)/60:.1f}m"
    )
    if coverage < EXPECTED_COVERAGE_MIN:
        raise SystemExit(
            f"refresh-gaia-astrometry: coverage {coverage:.1%} below floor "
            f"{EXPECTED_COVERAGE_MIN:.0%} — Stage-2 emitted source_ids the "
            f"live gaia_source table no longer carries; investigate before "
            f"re-pinning."
        )

    for spec in SPOT_CHECKS:
        check_spot_row(rows_by_id, spec)

    # Emit in the request file's order — stable across runs because the
    # request file is itself sorted by source_id (see Stage 2's
    # write_astrometry_request). Rows present in the request but missing
    # from gaia_source are dropped silently; coverage check above gates.
    rows = (write_row(rows_by_id[sid]) for sid in source_ids if sid in rows_by_id)
    written = rl.write_tsv(rows, columns=TSV_COLUMNS, output=OUT)
    print(f"wrote {OUT.relative_to(ROOT)} ({written} rows)")


if __name__ == "__main__":
    main()
