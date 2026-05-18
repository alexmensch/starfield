"""Step 1 of stellata-zsr.1 — coverage stats over AT-HYG classic-IDs subset.

Reads data/athyg_33_classic_ids.csv directly (rather than the post-build
binary) because the build pipeline substitutes the solar DEFAULT_CI=0.65
for any star missing a `ci` field, which collapses the "missing" bucket
into the "looks solar" bucket. The raw CSV is the only source where the
two are distinguishable.

Outputs:
  - research/star-spectral-rendition/coverage.txt        : human-readable summary
  - research/star-spectral-rendition/per_star.tsv        : per-star parsed fields for downstream
                                         HR-plot consumption (id, ci_raw, spect_raw,
                                         class_idx, subclass, lum_class, is_wd,
                                         wd_subclass, t_eff_table, absmag, hip)

Run: research/star-spectral-rendition/.venv/bin/python research/star-spectral-rendition/coverage.py
"""

from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path

from parse_spectral import parse_spectral, temp_kelvin

CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "athyg_33_classic_ids.csv"
OUT_TXT = Path(__file__).resolve().parent / "coverage.txt"
OUT_TSV = Path(__file__).resolve().parent / "per_star.tsv"

LUM_NAMES = {
    0: "VII/D",
    1: "VI/sd",
    2: "V",
    3: "IV",
    4: "III",
    5: "II",
    6: "Ib",
    7: "Iab",
    8: "Ia",
    9: "Ia+/0",
    255: "unknown",
}
CLASS_NAMES = ["O", "B", "A", "F", "G", "K", "M", "C/S/W/N/R", "unknown"]


def main() -> None:
    total = 0
    ci_empty = 0
    spect_empty = 0
    spect_parseable = 0  # class_idx != 8 OR is_white_dwarf
    lum_known = 0  # spect parseable AND lum_class != 255
    both_missing = 0  # ci empty AND spect empty
    ci_empty_spect_present = 0
    ci_present_spect_empty = 0

    class_counter: Counter[int] = Counter()
    lum_counter: Counter[int] = Counter()
    joint_counter: Counter[tuple[int, int]] = Counter()  # (class_idx, lum_class) over parseable

    rows_out: list[tuple] = []

    with CSV_PATH.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            ci_raw = (row.get("ci") or "").strip()
            spect_raw = (row.get("spect") or "").strip()
            id_str = row.get("id") or ""
            hip_str = (row.get("hip") or "").strip()
            absmag_str = (row.get("absmag") or "").strip()

            ci_is_empty = ci_raw == ""
            spect_is_empty = spect_raw == ""
            if ci_is_empty:
                ci_empty += 1
            if spect_is_empty:
                spect_empty += 1
            if ci_is_empty and spect_is_empty:
                both_missing += 1
            if ci_is_empty and not spect_is_empty:
                ci_empty_spect_present += 1
            if not ci_is_empty and spect_is_empty:
                ci_present_spect_empty += 1

            info = parse_spectral(spect_raw)
            # "parseable" = recognized class letter OR white dwarf. class_idx=8
            # AND not is_white_dwarf means parseSpectral fell through (unknown).
            is_parseable = info.is_white_dwarf or info.class_idx < 8
            if is_parseable:
                spect_parseable += 1
                if info.lum_class != 255:
                    lum_known += 1
                class_counter[info.class_idx] += 1
                lum_counter[info.lum_class] += 1
                joint_counter[(info.class_idx, info.lum_class)] += 1
            else:
                class_counter[8] += 1
                lum_counter[255] += 1

            try:
                absmag_val = float(absmag_str)
            except ValueError:
                absmag_val = float("nan")

            try:
                ci_val = float(ci_raw) if ci_raw else float("nan")
            except ValueError:
                ci_val = float("nan")

            rows_out.append((
                id_str, hip_str, absmag_val, ci_val, spect_raw,
                info.class_idx, info.subclass, info.lum_class,
                int(info.is_white_dwarf), info.wd_subclass,
                temp_kelvin(info),
            ))

    # Write per-star TSV (header + rows) for downstream HR plotting.
    with OUT_TSV.open("w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow([
            "id", "hip", "absmag", "ci_raw", "spect_raw",
            "class_idx", "subclass", "lum_class",
            "is_wd", "wd_subclass", "t_eff_table",
        ])
        for r in rows_out:
            w.writerow(r)

    lines = []
    pct = lambda n: f"{100.0 * n / total:.2f}%"
    lines.append("# stellata-zsr.1 coverage report")
    lines.append("")
    lines.append(f"Source: data/{CSV_PATH.name}")
    lines.append("")
    lines.append(f"Total records: {total:,}")
    lines.append("")
    lines.append("## ci (B-V colour index)")
    lines.append(f"  empty in CSV:        {ci_empty:>7,}  ({pct(ci_empty)})")
    lines.append(f"  present in CSV:      {total - ci_empty:>7,}  ({pct(total - ci_empty)})")
    lines.append("")
    lines.append("## spect (spectral type)")
    lines.append(f"  empty in CSV:        {spect_empty:>7,}  ({pct(spect_empty)})")
    lines.append(f"  parseable:           {spect_parseable:>7,}  ({pct(spect_parseable)})")
    lines.append(f"  with lum_class:      {lum_known:>7,}  ({pct(lum_known)})")
    lines.append("")
    lines.append("## joint")
    lines.append(f"  both empty:                 {both_missing:>7,}  ({pct(both_missing)})")
    lines.append(f"  ci empty, spect present:    {ci_empty_spect_present:>7,}  ({pct(ci_empty_spect_present)})")
    lines.append(f"  ci present, spect empty:    {ci_present_spect_empty:>7,}  ({pct(ci_present_spect_empty)})")
    lines.append(f"  both present:               {total - both_missing - ci_empty_spect_present - ci_present_spect_empty:>7,}")
    lines.append("")
    lines.append("## by spectral class (over parseable + unknown)")
    for idx in range(9):
        n = class_counter.get(idx, 0)
        lines.append(f"  {CLASS_NAMES[idx]:<12} {n:>7,}  ({pct(n)})")
    lines.append("")
    lines.append("## by luminosity class (over parseable + unknown)")
    for lum in [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255]:
        n = lum_counter.get(lum, 0)
        lines.append(f"  {LUM_NAMES[lum]:<10}  {n:>7,}  ({pct(n)})")
    lines.append("")
    lines.append("## joint (class, lum) — top 15 buckets")
    top = joint_counter.most_common(15)
    for (cls, lum), n in top:
        lines.append(f"  {CLASS_NAMES[cls]:<12} {LUM_NAMES[lum]:<10}  {n:>7,}  ({pct(n)})")

    out = "\n".join(lines) + "\n"
    OUT_TXT.write_text(out)
    print(out)


if __name__ == "__main__":
    main()
