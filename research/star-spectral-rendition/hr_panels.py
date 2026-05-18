"""Step 2c of stellata-zsr.1 — three-panel HR diagram render.

Plots the full AT-HYG classic-IDs subset on the classical HR plane
(absmag inverted vs B-V), coloured three ways for side-by-side comparison.

Panels:
  (A) ciToColor(B-V)          — current shader piecewise gradient
  (B) blackbody @ Teff(spect) — T_TABLE MS lookup
  (C) blackbody @ Teff(B-V)   — Ballesteros 2012

Reads research/star-spectral-rendition/per_star.tsv (produced by coverage.py).

Caches blackbody → sRGB by (class_idx, subclass, is_wd, wd_subclass) for
panel B and by binned B-V for panel C, so the 317k-row scatter stays fast.

Outputs: research/star-spectral-rendition/hr_panels.png
"""

from __future__ import annotations

import csv
import math
from pathlib import Path
from typing import Dict, Tuple

import matplotlib.pyplot as plt
import numpy as np

from blackbody_color import blackbody_to_srgb
from compare_sample_stars import ci_to_color, teff_from_bv
from parse_spectral import SpectralInfo, temp_kelvin

PER_STAR_TSV = Path(__file__).resolve().parent / "per_star.tsv"
OUT_PNG = Path(__file__).resolve().parent / "hr_panels.png"


def _bb_for_spect(class_idx: int, subclass: int, is_wd: int, wd_subclass: int) -> tuple[float, float, float]:
    """Cached wrapper — Teff is determined by (class_idx, subclass) for normal stars
    or by wd_subclass for white dwarfs."""
    info = SpectralInfo(class_idx, subclass, 0, bool(is_wd), wd_subclass)
    return blackbody_to_srgb(temp_kelvin(info))


def _bb_for_bv_bin(bv: float) -> tuple[float, float, float]:
    return blackbody_to_srgb(teff_from_bv(bv))


def main() -> None:
    print(f"Reading {PER_STAR_TSV}...")
    ids = []
    absmag = []
    ci = []
    class_idx = []
    subclass = []
    is_wd = []
    wd_subclass = []

    with PER_STAR_TSV.open() as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            try:
                am = float(row["absmag"])
            except (ValueError, KeyError):
                continue
            if not math.isfinite(am):
                continue
            ci_raw = row.get("ci_raw") or ""
            try:
                ci_val = float(ci_raw) if ci_raw not in ("", "nan") else float("nan")
            except ValueError:
                ci_val = float("nan")
            ids.append(row["id"])
            absmag.append(am)
            ci.append(ci_val)
            class_idx.append(int(row["class_idx"]))
            subclass.append(int(row["subclass"]))
            is_wd.append(int(row["is_wd"]))
            wd_subclass.append(int(row["wd_subclass"]))

    absmag_arr = np.array(absmag, dtype=np.float32)
    ci_arr = np.array(ci, dtype=np.float32)
    class_idx_arr = np.array(class_idx, dtype=np.int8)
    subclass_arr = np.array(subclass, dtype=np.int8)
    is_wd_arr = np.array(is_wd, dtype=np.int8)
    wd_subclass_arr = np.array(wd_subclass, dtype=np.int8)
    n = len(absmag_arr)
    print(f"Loaded {n:,} stars with finite absmag.")

    # ---- Build per-panel RGB arrays via caches -----------------------
    print("Computing panel A (ciToColor)...")
    has_ci = np.isfinite(ci_arr)
    rgb_a = np.zeros((n, 3), dtype=np.float32)
    # ciToColor is cheap (no integration) — vectorize directly.
    bv_clip = np.clip(ci_arr, -0.4, 2.0)
    t = np.clip((bv_clip + 0.4) / 2.4, 0.0, 1.0)
    hot = np.array([0.65, 0.78, 1.00])
    mid = np.array([1.00, 0.98, 0.92])
    cool = np.array([1.00, 0.55, 0.35])
    lower_mask = t < 0.5
    rgb_a[lower_mask] = hot + (mid - hot) * (t[lower_mask, None] * 2.0)
    rgb_a[~lower_mask] = mid + (cool - mid) * ((t[~lower_mask, None] - 0.5) * 2.0)
    rgb_a = np.clip(rgb_a, 0.0, 1.0)

    print("Computing panel B (blackbody @ Teff(spect)) with cache...")
    spect_cache: Dict[Tuple[int, int, int, int], Tuple[float, float, float]] = {}
    rgb_b = np.zeros((n, 3), dtype=np.float32)
    parseable_b = (class_idx_arr < 8) | (is_wd_arr == 1)
    for i in range(n):
        if not parseable_b[i]:
            continue
        key = (int(class_idx_arr[i]), int(subclass_arr[i]), int(is_wd_arr[i]), int(wd_subclass_arr[i]))
        if key not in spect_cache:
            spect_cache[key] = _bb_for_spect(*key)
        rgb_b[i] = spect_cache[key]
    print(f"  spect cache size: {len(spect_cache)}")

    print("Computing panel C (blackbody @ Teff(B-V)) with binned cache...")
    bv_bin_cache: Dict[int, Tuple[float, float, float]] = {}
    rgb_c = np.zeros((n, 3), dtype=np.float32)
    parseable_c = has_ci
    # Bin B-V to 0.02 resolution → ~150 bins over [-0.5, 2.5].
    for i in range(n):
        if not parseable_c[i]:
            continue
        b = float(ci_arr[i])
        key = int(round(b / 0.02))
        if key not in bv_bin_cache:
            bv_bin_cache[key] = _bb_for_bv_bin(key * 0.02)
        rgb_c[i] = bv_bin_cache[key]
    print(f"  bv bin cache size: {len(bv_bin_cache)}")

    # ---- Plot --------------------------------------------------------
    print("Rendering panels...")
    fig, axes = plt.subplots(1, 3, figsize=(18, 7), dpi=130, sharey=True)
    fig.patch.set_facecolor("#0a0a0e")
    bg = "#0a0a0e"

    panels = [
        (axes[0], parseable_c, rgb_a, "(A) ciToColor — current shader"),
        (axes[1], parseable_b, rgb_b, "(B) Blackbody @ Teff(spect) — T_TABLE MS"),
        (axes[2], parseable_c, rgb_c, "(C) Blackbody @ Teff(B-V) — Ballesteros"),
    ]

    for ax, mask, rgb, title in panels:
        ax.set_facecolor(bg)
        x = ci_arr[mask]
        y = absmag_arr[mask]
        cols = rgb[mask]
        ax.scatter(x, y, c=cols, s=1.3, alpha=0.55, edgecolors="none")
        ax.set_xlim(-0.5, 2.5)
        ax.set_ylim(18, -8)  # absmag inverted
        ax.set_xlabel("B-V", color="#cccccc")
        if ax is axes[0]:
            ax.set_ylabel("Absolute magnitude (M_V)", color="#cccccc")
        ax.set_title(title, color="#eeeeee", fontsize=10)
        ax.tick_params(colors="#cccccc")
        for spine in ax.spines.values():
            spine.set_color("#444")
        ax.grid(True, color="#222", linewidth=0.4, alpha=0.6)

    fig.suptitle("stellata-zsr.1 — HR diagram coloured three ways  "
                 f"(AT-HYG classic-IDs subset, {n:,} stars)",
                 color="#dddddd", fontsize=12)
    plt.tight_layout(rect=[0, 0, 1, 0.96])
    plt.savefig(OUT_PNG, dpi=130, facecolor=fig.get_facecolor())
    print(f"Saved {OUT_PNG}")


if __name__ == "__main__":
    main()
