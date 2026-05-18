"""Step 3 of stellata-zsr.1 — empirical Apsis coverage probe.

Queries the Gaia DR3 archive TAP service for a random 1000-source-id
sample drawn from the AT-HYG classic-IDs subset, then reports per-column
coverage of the Apsis astrophysical-parameter outputs:

  - teff_gspphot (photometric Teff, BP/RP-based, ~470 M Gaia DR3 stars)
  - logg_gspphot (photometric surface gravity — the critical addition
    over Stellata's current spectral-class-only T_TABLE)
  - mh_gspphot   (photometric metallicity [M/H])
  - azero_gspphot (line-of-sight extinction A_0)
  - teff_gspspec / logg_gspspec / mh_gspspec — RVS-spectrum-based,
    higher quality but much smaller subset (~5 M Gaia DR3 stars,
    G_RVS ≤ 14)

The query is one-shot and read-only. Per frozen-external-data, any
permanent ingest of this data would land via dch's Phase 1 refresh_lib
pattern — this script is a research probe, not a build dependency.

Output:
  - research/star-spectral-rendition/apsis_sample.tsv      : raw per-source rows from Gaia
  - research/star-spectral-rendition/apsis_coverage.txt    : coverage summary
"""

from __future__ import annotations

import csv
import json
import random
import sys
import time
from pathlib import Path

import requests

CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "athyg_33_classic_ids.csv"
OUT_TSV = Path(__file__).resolve().parent / "apsis_sample.tsv"
OUT_TXT = Path(__file__).resolve().parent / "apsis_coverage.txt"

GAIA_TAP_SYNC = "https://gea.esac.esa.int/tap-server/tap/sync"
SAMPLE_SIZE = 1000
RANDOM_SEED = 20260517  # deterministic sampling for reproducibility


def fetch_random_source_ids(n: int, seed: int) -> list[str]:
    rng = random.Random(seed)
    rows = []
    with CSV_PATH.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            g = (row.get("gaia") or "").strip()
            if g:
                rows.append(g)
    print(f"AT-HYG rows with Gaia source_id: {len(rows):,}")
    sample = rng.sample(rows, n)
    return sample


def adql_query_apsis(source_ids: list[str]) -> list[dict]:
    """Run a single ADQL IN-clause query against gaiadr3.astrophysical_parameters."""
    ids_csv = ",".join(source_ids)
    adql = f"""
SELECT source_id,
       teff_gspphot, logg_gspphot, mh_gspphot, azero_gspphot,
       teff_gspspec, logg_gspspec, mh_gspspec
FROM gaiadr3.astrophysical_parameters
WHERE source_id IN ({ids_csv})
""".strip()
    print(f"ADQL payload size: {len(adql):,} bytes")
    print("Submitting to Gaia TAP sync endpoint...")
    t0 = time.time()
    resp = requests.post(
        GAIA_TAP_SYNC,
        data={
            "REQUEST": "doQuery",
            "LANG": "ADQL",
            "FORMAT": "json",
            "QUERY": adql,
        },
        timeout=180,
    )
    elapsed = time.time() - t0
    print(f"  HTTP {resp.status_code} in {elapsed:.1f}s, {len(resp.content):,} bytes")
    resp.raise_for_status()
    payload = resp.json()
    cols = [c["name"] for c in payload["metadata"]]
    rows = []
    for row in payload["data"]:
        rows.append({k: v for k, v in zip(cols, row)})
    return rows


def summarize(rows: list[dict], sample_size: int) -> str:
    """Tabulate per-column coverage and key joint coverage stats."""
    lines = []
    n_returned = len(rows)
    lines.append("# stellata-zsr.1 Apsis empirical coverage probe")
    lines.append("")
    lines.append(f"Sample size (random Gaia source_ids from AT-HYG): {sample_size}")
    lines.append(f"Rows returned by gaiadr3.astrophysical_parameters: {n_returned}")
    lines.append(f"  → astrophysical_parameters coverage of sample:  {100*n_returned/sample_size:.1f}%")
    lines.append("")
    lines.append("## Per-column coverage (over returned rows)")
    cols = [
        "teff_gspphot", "logg_gspphot", "mh_gspphot", "azero_gspphot",
        "teff_gspspec", "logg_gspspec", "mh_gspspec",
    ]
    for c in cols:
        present = sum(1 for r in rows if r.get(c) is not None)
        lines.append(f"  {c:<22} {present:>5,}  ({100*present/max(1,n_returned):.1f}%)")

    lines.append("")
    lines.append("## Joint coverage (over returned rows)")
    joint_phot = sum(1 for r in rows if r.get("teff_gspphot") is not None and r.get("logg_gspphot") is not None)
    joint_phot_mh = sum(1 for r in rows if r.get("teff_gspphot") is not None
                        and r.get("logg_gspphot") is not None and r.get("mh_gspphot") is not None)
    joint_spec = sum(1 for r in rows if r.get("teff_gspspec") is not None and r.get("logg_gspspec") is not None)
    union_teff_logg = sum(1 for r in rows if (
        (r.get("teff_gspphot") is not None and r.get("logg_gspphot") is not None) or
        (r.get("teff_gspspec") is not None and r.get("logg_gspspec") is not None)
    ))
    both_pipelines = sum(1 for r in rows if (
        r.get("teff_gspphot") is not None and r.get("logg_gspphot") is not None and
        r.get("teff_gspspec") is not None and r.get("logg_gspspec") is not None
    ))
    lines.append(f"  (teff_gspphot AND logg_gspphot):                    {joint_phot:>5,}  ({100*joint_phot/max(1,n_returned):.1f}%)")
    lines.append(f"  (teff_gspphot AND logg_gspphot AND mh_gspphot):     {joint_phot_mh:>5,}  ({100*joint_phot_mh/max(1,n_returned):.1f}%)")
    lines.append(f"  (teff_gspspec AND logg_gspspec):                    {joint_spec:>5,}  ({100*joint_spec/max(1,n_returned):.1f}%)")
    lines.append(f"  UNION — (teff+logg) from gspphot OR gspspec:        {union_teff_logg:>5,}  ({100*union_teff_logg/max(1,n_returned):.1f}%)")
    lines.append(f"  INTERSECTION — both pipelines have (teff+logg):     {both_pipelines:>5,}  ({100*both_pipelines/max(1,n_returned):.1f}%)")
    lines.append("")
    lines.append("  Note: gspphot uses BP/RP photometric spectra; gspspec uses RVS")
    lines.append("  high-resolution spectra. Failures are largely independent at")
    lines.append("  AT-HYG brightness, so the union is the realistic ingestable")
    lines.append("  bucket — either pipeline gives us a usable (Teff, logg) pair.")

    lines.append("")
    lines.append("## Coverage projected to the full AT-HYG.gaia subset")
    lines.append(f"  AT-HYG rows with Gaia source_id (from coverage.py): 314,865")
    proj_apsis = int(314865 * n_returned / sample_size)
    proj_phot = int(314865 * joint_phot / sample_size)
    proj_spec = int(314865 * joint_spec / sample_size)
    proj_union = int(314865 * union_teff_logg / sample_size)
    lines.append(f"  Projected with astrophysical_parameters row:        ~{proj_apsis:,}")
    lines.append(f"  Projected with joint (teff+logg) gspphot:           ~{proj_phot:,}")
    lines.append(f"  Projected with joint (teff+logg) gspspec:           ~{proj_spec:,}")
    lines.append(f"  Projected with (teff+logg) from EITHER pipeline:    ~{proj_union:,}")
    lines.append("")
    lines.append("  Comparison vs status quo (catalog-pure.ts T_TABLE today):")
    lines.append(f"    Stars with parseable spectral class:               209,817")
    lines.append(f"    Stars with KNOWN luminosity class:                  92,995  (29.3% of catalog)")
    lines.append(f"    With Apsis ingest (union projection):             ~{proj_union:,}  ({100*proj_union/313258:.1f}% of catalog)")

    # Teff distribution from gspphot
    teff_vals = [r["teff_gspphot"] for r in rows if r.get("teff_gspphot") is not None]
    if teff_vals:
        teff_vals.sort()
        n = len(teff_vals)
        lines.append("")
        lines.append("## teff_gspphot distribution (K)")
        lines.append(f"  N={n}  min={teff_vals[0]:.0f}  p25={teff_vals[n//4]:.0f}  "
                     f"median={teff_vals[n//2]:.0f}  p75={teff_vals[3*n//4]:.0f}  max={teff_vals[-1]:.0f}")

    logg_vals = [r["logg_gspphot"] for r in rows if r.get("logg_gspphot") is not None]
    if logg_vals:
        logg_vals.sort()
        n = len(logg_vals)
        lines.append("")
        lines.append("## logg_gspphot distribution (dex)")
        lines.append(f"  N={n}  min={logg_vals[0]:.2f}  p25={logg_vals[n//4]:.2f}  "
                     f"median={logg_vals[n//2]:.2f}  p75={logg_vals[3*n//4]:.2f}  max={logg_vals[-1]:.2f}")
        giants = sum(1 for v in logg_vals if v < 3.5)
        ms = sum(1 for v in logg_vals if v >= 4.0)
        sub = n - giants - ms
        lines.append(f"  Giant-like (logg < 3.5):       {giants:>5,}  ({100*giants/n:.1f}%)")
        lines.append(f"  Subgiant-like (3.5 ≤ logg < 4.0): {sub:>5,}  ({100*sub/n:.1f}%)")
        lines.append(f"  MS-like (logg ≥ 4.0):          {ms:>5,}  ({100*ms/n:.1f}%)")

    return "\n".join(lines) + "\n"


def main() -> None:
    print("Sampling source_ids...")
    source_ids = fetch_random_source_ids(SAMPLE_SIZE, RANDOM_SEED)
    print(f"Sampled {len(source_ids)} source_ids")

    rows = adql_query_apsis(source_ids)
    print(f"Got {len(rows)} rows back from Apsis table")

    with OUT_TSV.open("w", newline="") as f:
        if rows:
            cols = list(rows[0].keys())
            w = csv.writer(f, delimiter="\t")
            w.writerow(cols)
            for r in rows:
                w.writerow([r.get(c, "") if r.get(c) is not None else "" for c in cols])
    print(f"Wrote raw rows to {OUT_TSV}")

    summary = summarize(rows, SAMPLE_SIZE)
    OUT_TXT.write_text(summary)
    print()
    print(summary)


if __name__ == "__main__":
    main()
