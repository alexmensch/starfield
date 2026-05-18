#!/usr/bin/env python3
"""Refresh data/simbad_sample.tsv — stratified random 10k-star SIMBAD sample.

Phase 1 of the source-ID-anchored catalogue-pipeline rewrite (stellata-dch).
Builds an independent external-authority reference set for the Phase 4
Tier-C validator (stellata-dch.39) to cross-check Stellata's catalog
against SIMBAD without paying SIMBAD-query cost per-validation-run.

Sample is V-magnitude-stratified for diversity across the AT-HYG depth
range, with a stable seed so re-runs are reproducible:
    V <    6.0  →  1000  stars  (naked-eye bright)
    V 6.0-9.0   →  3000  stars  (HIP-completeness regime)
    V 9.0-11.5  →  4000  stars  (Tycho-2 completeness)
    V 11.5-15.0 →  2000  stars  (faint Tycho-Gaia merge)
                  -----
                   10000 total

Backend: SIMBAD TAP only (refresh_lib.simbad_backend; refresh-bailer-jones.py's
cds-only override is the structural precedent). SIMBAD's ADQL dialect
diverges from ESA/CDS — LIKE is disallowed on `basic.otype`, MOD() is
supported but the `%` operator is not — so SIMBAD never sits in the
default ESA→CDS fallback list; refresh scripts targeting SIMBAD pass
`backends=[rl.simbad_backend()]` explicitly.

TSV columns (15)
    simbad_oid       int    — SIMBAD basic.oid (stable primary key)
    simbad_main_id   str    — SIMBAD basic.main_id (e.g. "* alf Car")
    hip              int|"" — Hipparcos number (from ident.id LIKE 'HIP %')
    gaia_source_id   int|"" — Gaia DR3 source_id (from ident.id LIKE 'Gaia DR3 %')
    ra               float  — basic.ra (deg, ICRS J2000)
    dec              float  — basic.dec (deg, ICRS J2000)
    plx_value        float|"" — basic.plx_value (mas)
    plx_err          float|"" — basic.plx_err (mas)
    pmra             float|"" — basic.pmra (mas/yr)
    pmdec            float|"" — basic.pmdec (mas/yr)
    v_mag            float  — allfluxes.V (mag) — preserved so validator can
                              verify the stratification it received
    distance_pc      float|"" — derived: 1000/plx_value when plx_value>0
    absmag           float|"" — derived: v_mag − 5·log10(distance_pc/10)
                              when both v_mag and distance_pc exist
    sp_type          str|""  — basic.sp_type
    otype            str    — basic.otype (SIMBAD hierarchical short code)

Sampling — stratified MOD-then-local-random for determinism. For each
bin: if the live population (filtered by `basic.otype` matching the
star branch of `otypedef` and `allfluxes.V NOT NULL`) is small enough
to fetch whole, fetch all candidates; otherwise pre-filter server-side
with `MOD(basic.oid, K) = SEED % K` to a candidate set ~3× the bin
target. Then `random.Random(SEED).sample(candidates, target)` locally.
The MOD subsample is necessary because SIMBAD's largest bins (V≥9)
hold >1 M stars — fetching whole would exceed both client memory and
TAP MAXREC. Resulting selection is fully deterministic in (SEED, live
SIMBAD oid distribution).

Idempotent — exits early if the output is newer than this script.
Pass `--force` to rebuild unconditionally. (No input-data file: the
catalogue lives upstream at SIMBAD.)

Venv setup (see scripts/requirements-refresh.txt):
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements-refresh.txt
    .venv/bin/python scripts/refresh-simbad-sample.py
"""

from __future__ import annotations

import math
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import refresh_lib as rl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "simbad_sample.tsv"

# Reproducibility seed. Bumping this regenerates every row; treat it as a
# breaking change to the validation corpus (downstream pinned hashes
# rebaseline). The numeric form is the bead-spec convention `YYYYMMDD`
# of the date the corpus was first cut.
SEED = 20260515

# Bin definitions — (min_V_inclusive, max_V_exclusive, target_count, mod_K).
# `mod_K`==1 means "fetch every candidate, no server-side subsample"; >1
# means `WHERE MOD(b.oid, mod_K) = SEED % mod_K` to subsample server-side.
# K is chosen so the candidate set is ~3× target — large enough that the
# local random.sample step has slack to work with, small enough that the
# TAP response stays under MAXREC and under a few-MB transfer. Tuned
# against live populations probed 2026-05-18:
#     V<6           5,056 stars  → K=1  → all 5056 candidates
#     V 6-9       125,047 stars  → K=14 → ~8,932 candidates
#     V 9-11.5  1,414,045 stars  → K=118→ ~11,983 candidates
#     V 11.5-15 2,321,952 stars  → K=387→ ~6,000 candidates
# Re-tune K (downward) if SIMBAD growth pushes the candidate set below
# ~2× target.
@dataclass(frozen=True)
class Bin:
    v_min: float | None
    v_max: float
    target: int
    mod_K: int


BINS: tuple[Bin, ...] = (
    Bin(v_min=None, v_max=6.0,  target=1000, mod_K=1),
    Bin(v_min=6.0,  v_max=9.0,  target=3000, mod_K=14),
    Bin(v_min=9.0,  v_max=11.5, target=4000, mod_K=118),
    Bin(v_min=11.5, v_max=15.0, target=2000, mod_K=387),
)

# Expected total — sum of BINS targets. Drives the row-count guard.
SAMPLE_SIZE = sum(b.target for b in BINS)

# Gaia DR3 ident-coverage floor (overall, NOT per-bin). Live probe 2026-05-18
# placed the weighted-average at ~96.7%; the V<6 bin alone runs ~94% because
# bright stars hit Gaia's saturation cliff (e.g. Canopus is absent from DR3),
# so a per-bin floor would false-fail on the brightest stratum.
GAIA_COVERAGE_MIN = 0.95

# Output sort key + decimal precision. RA/Dec at 6 decimals ≈ 4 mas at the
# equator (SIMBAD's coo_err_maj is typically 0.1-10 mas, so 6 decimals
# preserves all upstream precision). Parallax + PM at 4 decimals matches
# Gaia DR3's quoted precision. Magnitudes at 3 decimals — SIMBAD stores
# V to ~0.01 mag at best; 3 absorbs the float32→float64 conversion noise.
COORD_DECIMALS = 6
ASTROM_DECIMALS = 4
MAG_DECIMALS = 3
DIST_DECIMALS = 3

# Per-batch ident-lookup IN-clause size. SIMBAD's TAP accepts up to ~64KB
# of POST body in practice; 1000 oids ≈ 20 KB and leaves headroom. Tuned
# alongside refresh-bailer-jones.py's 5000-id batches (CDS accepts more).
IDENT_BATCH = 1_000

# Schema validation for the basic+allfluxes JOIN (Phase A). Live probe
# 2026-05-18 shape on SIMBAD TAP:
#   oid:int64, main_id:object, ra:float64, dec:float64,
#   plx_value:float64 (masked-aware), plx_err:float32, pmra:float64,
#   pmdec:float64, otype:object, sp_type:object, v_mag:float64.
BASIC_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "oid": int,
    "main_id": str,
    "ra": float,
    "dec": float,
    "plx_value": float,
    "plx_err": float,
    "pmra": float,
    "pmdec": float,
    "otype": str,
    "sp_type": str,
    "v_mag": float,
}

# Phase B ident-table schema.
IDENT_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "oidref": int,
    "id": str,
}

# Output column order (matches the TSV-columns block in the file docstring).
TSV_COLUMNS = [
    "simbad_oid",
    "simbad_main_id",
    "hip",
    "gaia_source_id",
    "ra",
    "dec",
    "plx_value",
    "plx_err",
    "pmra",
    "pmdec",
    "v_mag",
    "distance_pc",
    "absmag",
    "sp_type",
    "otype",
]

# Identifier prefixes — exact LIKE patterns and the integer-extraction
# offsets after stripping. SIMBAD encodes "HIP <int>" (one space) and
# "Gaia DR3 <int>" (one space inside the catalogue tag, one space before
# the id). Keep the patterns/prefixes paired so a SIMBAD rename of either
# only needs to be edited here.
HIP_LIKE = "HIP %"
HIP_PREFIX_LEN = len("HIP ")
GAIA_LIKE = "Gaia DR3 %"
GAIA_PREFIX_LEN = len("Gaia DR3 ")


def fetch_star_otype_inlist(client: rl.TapClient) -> str:
    """Enumerate all `otype` codes whose otypedef.path begins with `*`,
    return a comma-joined quoted IN-clause string.

    SIMBAD's ADQL parser rejects `LIKE` on `basic.otype` directly
    ("LIKE not supported on otype !" — live probe 2026-05-18), so the
    star-branch otype set must be precomputed via `otypedef` and passed
    as an explicit IN clause. The set is ~122 codes / ~720 chars — well
    under any TAP body-size limit.
    """
    table = client.run("SELECT otype FROM otypedef WHERE path LIKE '*%'")
    codes = sorted(str(row["otype"]) for row in table)
    if not codes:
        raise SystemExit(
            "refresh-simbad-sample: otypedef returned no star branch — "
            "SIMBAD schema has changed; investigate before re-pinning."
        )
    return ",".join(f"'{c}'" for c in codes)


def fetch_bin_candidates(
    client: rl.TapClient,
    bin_: Bin,
    star_otypes_inlist: str,
) -> Any:
    """Return the astropy Table of candidate rows for one bin — every
    basic+allfluxes row that matches the bin's V-mag range and is in the
    star-branch of otypedef, optionally pre-filtered server-side by
    MOD(b.oid, mod_K). Returned shape lets the caller schema-validate
    before iterating into a Python list for `random.Random.sample`.
    """
    conds = [
        'f."V" IS NOT NULL',
        f'f."V" < {bin_.v_max}',
        f"b.otype IN ({star_otypes_inlist})",
    ]
    if bin_.v_min is not None:
        conds.append(f'f."V" >= {bin_.v_min}')
    if bin_.mod_K > 1:
        residue = SEED % bin_.mod_K
        conds.append(f"MOD(b.oid, {bin_.mod_K}) = {residue}")
    where = " AND ".join(conds)
    # Aliasing every selected column lets ORDER BY reference the alias —
    # SIMBAD's ADQL parser rejects qualified names (both `f."V"` and
    # `b.oid`) inside ORDER BY ("Encountered '.'" — live probe 2026-05-18).
    query = (
        "SELECT b.oid AS oid, b.main_id AS main_id, "
        "b.ra AS ra, b.dec AS dec, "
        "b.plx_value AS plx_value, b.plx_err AS plx_err, "
        "b.pmra AS pmra, b.pmdec AS pmdec, "
        "b.otype AS otype, b.sp_type AS sp_type, "
        'f."V" AS v_mag '
        "FROM basic AS b "
        "JOIN allfluxes AS f ON f.oidref = b.oid "
        f"WHERE {where} "
        "ORDER BY oid"
    )
    return client.run(query)


def select_sample(rows: list[Any], target: int, rng: random.Random) -> list[Any]:
    if len(rows) < target:
        raise SystemExit(
            f"refresh-simbad-sample: bin yielded {len(rows)} candidates "
            f"but target is {target} — tighten mod_K (more candidates) "
            f"before re-running."
        )
    return rng.sample(rows, target)


def fetch_ident_for_oids(
    client: rl.TapClient,
    oids: list[int],
) -> dict[int, dict[str, int]]:
    """Return {oid: {'hip': ..., 'gaia': ...}} (missing keys are absent).
    Batches the IN-clause so the POST body stays under SIMBAD's TAP limit.
    """
    out: dict[int, dict[str, int]] = {}
    n_batches = (len(oids) + IDENT_BATCH - 1) // IDENT_BATCH
    for batch_idx, offset in enumerate(range(0, len(oids), IDENT_BATCH), start=1):
        batch = oids[offset : offset + IDENT_BATCH]
        inlist = ",".join(str(o) for o in batch)
        t0 = time.time()
        table = client.run(
            "SELECT oidref, id FROM ident "
            f"WHERE oidref IN ({inlist}) "
            f"AND (id LIKE '{HIP_LIKE}' OR id LIKE '{GAIA_LIKE}') "
            "ORDER BY oidref, id"
        )
        if batch_idx == 1:
            rl.validate_schema(table, IDENT_SCHEMA, label="SIMBAD ident")
        for row in table:
            oid = int(row["oidref"])
            id_str = str(rl.coerce_masked(row["id"]) or "")
            if id_str.startswith("HIP "):
                try:
                    out.setdefault(oid, {})["hip"] = int(id_str[HIP_PREFIX_LEN:])
                except ValueError:
                    # Rare HIP aliases like "HIP 12345 A" — skip; the
                    # canonical integer-only entry will appear in the
                    # same result set with no suffix.
                    pass
            elif id_str.startswith("Gaia DR3 "):
                try:
                    out.setdefault(oid, {})["gaia"] = int(id_str[GAIA_PREFIX_LEN:])
                except ValueError:
                    pass
        print(
            f"  ident batch {batch_idx}/{n_batches}: "
            f"{len(table):4d} rows in {time.time()-t0:5.1f}s "
            f"(resolved {len(out)}/{offset+len(batch)} oids)"
        )
    return out


def round_or_blank(v: Any, decimals: int) -> str:
    v = rl.coerce_masked(v)
    if v is None:
        return ""
    return f"{float(v):.{decimals}f}"


def build_output_row(
    row: Any,
    ident_map: dict[str, int] | None,
) -> dict[str, Any]:
    """Build one fully-formatted output dict — derives distance_pc + absmag
    from upstream basic columns, joins HIP/Gaia IDs from the ident map,
    formats every float to its stable decimal width so write_tsv produces
    byte-identical output across re-runs."""
    plx_value = rl.coerce_masked(row["plx_value"])
    v_mag = float(rl.coerce_masked(row["v_mag"]))
    # Negative or zero parallaxes are unphysical for stellar distances; treat
    # them as "no distance" rather than emitting a negative pc. SIMBAD does
    # publish negative plx values for low-S/N sources.
    distance_pc: float | None = None
    if plx_value is not None and float(plx_value) > 0:
        distance_pc = 1000.0 / float(plx_value)
    absmag: float | None = None
    if distance_pc is not None and distance_pc > 0:
        absmag = v_mag - 5.0 * math.log10(distance_pc / 10.0)

    ident_map = ident_map or {}
    return {
        "simbad_oid": int(row["oid"]),
        "simbad_main_id": str(rl.coerce_masked(row["main_id"]) or ""),
        "hip": ident_map.get("hip", ""),
        "gaia_source_id": ident_map.get("gaia", ""),
        "ra": round_or_blank(row["ra"], COORD_DECIMALS),
        "dec": round_or_blank(row["dec"], COORD_DECIMALS),
        "plx_value": round_or_blank(row["plx_value"], ASTROM_DECIMALS),
        "plx_err": round_or_blank(row["plx_err"], ASTROM_DECIMALS),
        "pmra": round_or_blank(row["pmra"], ASTROM_DECIMALS),
        "pmdec": round_or_blank(row["pmdec"], ASTROM_DECIMALS),
        "v_mag": f"{v_mag:.{MAG_DECIMALS}f}",
        "distance_pc": "" if distance_pc is None else f"{distance_pc:.{DIST_DECIMALS}f}",
        "absmag": "" if absmag is None else f"{absmag:.{MAG_DECIMALS}f}",
        "sp_type": str(rl.coerce_masked(row["sp_type"]) or ""),
        "otype": str(rl.coerce_masked(row["otype"]) or ""),
    }


def main() -> None:
    force = "--force" in sys.argv
    if not force and rl.is_up_to_date(OUT, [Path(__file__)]):
        print(f"{OUT.relative_to(ROOT)} up to date — skipping (use --force to rebuild)")
        return

    client = rl.TapClient(backends=[rl.simbad_backend()])

    print("enumerating SIMBAD star otype codes from otypedef…")
    star_otypes_inlist = fetch_star_otype_inlist(client)

    rng = random.Random(SEED)

    selected: list[Any] = []
    start = time.time()
    for i, bin_ in enumerate(BINS):
        label = f"V<{bin_.v_max}" if bin_.v_min is None else f"V∈[{bin_.v_min},{bin_.v_max})"
        t0 = time.time()
        print(
            f"bin {i+1}/{len(BINS)} {label} target={bin_.target} mod_K={bin_.mod_K}…"
        )
        table = fetch_bin_candidates(client, bin_, star_otypes_inlist)
        # Schema-validate once on the first table — covers every later table
        # with the same JOIN shape; matches refresh-bailer-jones.py's pattern.
        if i == 0:
            rl.validate_schema(table, BASIC_SCHEMA, label="SIMBAD basic+allfluxes")
        candidates = list(table)
        picked = select_sample(candidates, bin_.target, rng)
        selected.extend(picked)
        print(
            f"  fetched {len(candidates)} candidates → sampled {bin_.target} "
            f"in {time.time()-t0:.1f}s "
            f"(cum {(time.time()-start)/60:.1f}m, total selected {len(selected)})"
        )

    if len(selected) != SAMPLE_SIZE:
        raise SystemExit(
            f"refresh-simbad-sample: expected {SAMPLE_SIZE} rows, got "
            f"{len(selected)} — bin targets don't sum to {SAMPLE_SIZE}; "
            f"check BINS table."
        )

    print(f"resolving HIP + Gaia DR3 identifiers for {len(selected)} oids…")
    oids = sorted(int(r["oid"]) for r in selected)
    ident_map = fetch_ident_for_oids(client, oids)

    gaia_count = sum(1 for ids in ident_map.values() if "gaia" in ids)
    coverage = gaia_count / len(selected)
    print(
        f"Gaia DR3 ident coverage: {gaia_count}/{len(selected)} = {coverage:.1%}"
    )
    if coverage < GAIA_COVERAGE_MIN:
        raise SystemExit(
            f"refresh-simbad-sample: Gaia DR3 coverage {coverage:.1%} below "
            f"floor {GAIA_COVERAGE_MIN:.0%} — SIMBAD ident table or the "
            f"strata-weighted coverage rate has regressed; investigate "
            f"before re-pinning."
        )

    # Sort by simbad_oid so the TSV is byte-identical across re-runs.
    selected.sort(key=lambda r: int(r["oid"]))
    rows = (build_output_row(r, ident_map.get(int(r["oid"]))) for r in selected)
    written = rl.write_tsv(rows, columns=TSV_COLUMNS, output=OUT)
    print(
        f"wrote {OUT.relative_to(ROOT)} ({written} rows) "
        f"in {(time.time()-start)/60:.1f}m total"
    )


if __name__ == "__main__":
    main()
