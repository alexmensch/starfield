"""Display P3 vs sRGB blackbody swatch comparison — Tier 3 demo for zsr.1.

Renders side-by-side swatches at a range of temperatures with:
  - sRGB-clipped colour (re-encoded into P3 coordinates so it renders
    correctly inside the P3-tagged image)
  - Display P3 colour (directly encoded)

The output PNG embeds the macOS Display P3 ICC profile so a P3-aware
viewer (Preview, Safari, modern Chrome/Firefox) on a P3 monitor will
render each swatch in its true gamut. sRGB-only viewers will colour-
manage P3 → sRGB; the comparison still shows but the saturation
delta is reduced.

Honest empirical finding (see blackbody_color.py spot-check + this
script's `clipping_summary` output): for the Planckian locus above
~1700 K, both gamuts contain the chromaticity, so sRGB and P3
swatches render perceptually identical. The 1500 K row is included
as the ONE regime where sRGB clips and P3 doesn't — so you can see
what the "P3 win" looks like in practice. Stellata's actual catalog
floor is ~3000 K (M dwarfs), so this regime is degenerate for us.

Output: research/star-spectral-rendition/p3_swatches.png
"""

from __future__ import annotations

import io
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

from blackbody_color import (
    XYZ_TO_LIN_P3,
    XYZ_TO_LIN_SRGB,
    _xyz_for_temperature,
    blackbody_to_displayp3,
    blackbody_to_srgb,
    srgb_clipped_to_displayp3,
)
from compare_sample_stars import REFERENCE_STARS, ci_to_color, teff_from_bv
from parse_spectral import parse_spectral, temp_kelvin

OUT_PNG = Path(__file__).resolve().parent / "p3_swatches.png"
ICC_PATH = Path(__file__).resolve().parent / "display-p3.icc"

# Subset of REFERENCE_STARS + a synthetic 1500 K row to expose the only
# regime where sRGB clips and P3 doesn't (deep cool red, below anything
# in our actual catalog).
ROWS = [
    ("synthetic 1500 K",  None,        None,    1500.0),  # outside sRGB gamut
    ("Antares",          "M1.5 Iab",   1.830,   None),
    ("Betelgeuse",       "M2 Iab",     1.860,   None),
    ("Aldebaran",        "K5 III",     1.538,   None),
    ("Sol",              "G2 V",       0.656,   None),
    ("Vega",             "A0 V",       0.000,   None),
    ("Rigel",            "B8 Ia",     -0.030,   None),
    ("Spica",            "B1 V",      -0.235,   None),
    ("Mintaka",          "O9.5 II",   -0.170,   None),
]


def clipping_summary() -> str:
    """Show which rows lose chroma to sRGB clipping vs P3 clipping."""
    lines = ["Linear-RGB clipping per row (any negative component means clipping):"]
    for name, spect_raw, bv, t_override in ROWS:
        if t_override is not None:
            T = t_override
        else:
            T = teff_from_bv(bv) if bv is not None else temp_kelvin(parse_spectral(spect_raw))
        xyz = _xyz_for_temperature(T)
        lin_srgb = XYZ_TO_LIN_SRGB @ xyz
        lin_p3 = XYZ_TO_LIN_P3 @ xyz
        s_clip = any(c < 0 for c in lin_srgb)
        p_clip = any(c < 0 for c in lin_p3)
        lines.append(f"  T={T:6.0f}K  {name:<18}  sRGB-clip={s_clip!s:<5}  P3-clip={p_clip!s:<5}")
    return "\n".join(lines)


def main() -> None:
    print(clipping_summary())
    print()

    icc_bytes = ICC_PATH.read_bytes()
    print(f"Embedding Display P3 ICC profile ({len(icc_bytes)} bytes)")

    nrows = len(ROWS)
    fig, axes = plt.subplots(nrows, 4, figsize=(8, nrows * 0.6 + 1.0), dpi=140,
                              gridspec_kw=dict(width_ratios=[2.3, 1, 1, 0.3]))
    fig.patch.set_facecolor("#000000")

    for i, (name, spect_raw, bv, t_override) in enumerate(ROWS):
        if t_override is not None:
            T = t_override
            spect_label = f"T = {int(T)} K"
        elif bv is not None:
            T = teff_from_bv(bv)
            spect_label = f"{spect_raw}  B-V {bv:+.2f}"
        else:
            T = temp_kelvin(parse_spectral(spect_raw))
            spect_label = spect_raw

        srgb = blackbody_to_srgb(T)
        p3 = blackbody_to_displayp3(T)
        srgb_in_p3 = srgb_clipped_to_displayp3(srgb)

        # Label cell.
        ax_lbl = axes[i, 0]
        ax_lbl.text(0.05, 0.55, name, va="center", ha="left", color="#ffffff",
                    fontsize=9, family="monospace", weight="bold")
        ax_lbl.text(0.05, 0.2, spect_label, va="center", ha="left",
                    color="#999999", fontsize=8, family="monospace")
        ax_lbl.set_xlim(0, 1); ax_lbl.set_ylim(0, 1)
        ax_lbl.set_xticks([]); ax_lbl.set_yticks([])
        ax_lbl.set_facecolor("#000000")
        for spine in ax_lbl.spines.values():
            spine.set_visible(False)

        # sRGB (re-encoded as P3 for correct rendering inside P3-tagged PNG).
        ax_s = axes[i, 1]
        ax_s.imshow(np.ones((1, 1, 3)) * np.array(srgb_in_p3), interpolation="nearest")
        ax_s.set_xticks([]); ax_s.set_yticks([])
        for spine in ax_s.spines.values():
            spine.set_color("#222")

        # P3.
        ax_p = axes[i, 2]
        ax_p.imshow(np.ones((1, 1, 3)) * np.array(p3), interpolation="nearest")
        ax_p.set_xticks([]); ax_p.set_yticks([])
        for spine in ax_p.spines.values():
            spine.set_color("#222")

        # Diff indicator (max channel delta in 0-255 units).
        ax_d = axes[i, 3]
        delta = int(round(255 * max(abs(p3[j] - srgb_in_p3[j]) for j in range(3))))
        # Highlight rows where the delta is visible
        color = "#ff8888" if delta >= 8 else ("#cccccc" if delta >= 3 else "#666666")
        ax_d.text(0.5, 0.5, f"Δ{delta}", va="center", ha="center", color=color,
                  fontsize=9, family="monospace")
        ax_d.set_xlim(0, 1); ax_d.set_ylim(0, 1)
        ax_d.set_xticks([]); ax_d.set_yticks([])
        ax_d.set_facecolor("#000000")
        for spine in ax_d.spines.values():
            spine.set_visible(False)

    headers = ["", "sRGB-rendered", "Display P3", "Δ"]
    for col, label in enumerate(headers):
        axes[0, col].set_title(label, color="#dddddd", fontsize=9, pad=8)

    fig.suptitle("stellata-zsr.1 — Display P3 vs sRGB blackbody swatches  (image tagged Display P3)",
                 color="#dddddd", fontsize=10, y=0.995)
    plt.tight_layout(rect=[0, 0, 1, 0.985])

    # Render matplotlib figure into an in-memory PNG, then re-save through
    # Pillow with the Display P3 ICC profile embedded.
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=140, facecolor=fig.get_facecolor())
    buf.seek(0)
    img = Image.open(buf)
    img.save(OUT_PNG, format="PNG", icc_profile=icc_bytes)
    print(f"Saved {OUT_PNG} ({OUT_PNG.stat().st_size} bytes, Display P3 tagged)")


if __name__ == "__main__":
    main()
