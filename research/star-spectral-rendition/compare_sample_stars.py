"""Step 2b of stellata-zsr.1 — sample-star three-way colour comparison.

For each reference star, computes three RGB triplets:

  (A) current shader ciToColor(ci)
        - the 3-stop piecewise-linear gradient in CI space currently
          shipped in src/client/shaders/star.vert.glsl.

  (B) blackbody → sRGB at Teff(spect)
        - uses scripts/catalog-pure.ts T_TABLE (MS-only) for Teff.
          Honest about its weakness: T_TABLE indexes only by spectral
          class + subclass, NOT luminosity class — so a K3 giant gets
          the same Teff as a K3 dwarf. The Apsis assessment in Step 3
          tackles whether logg-aware Teff is worth the catalog work.

  (C) blackbody → sRGB at Teff(B-V)
        - Ballesteros (2012) empirical relation Teff(B-V), valid for
          MS over -0.4 ≤ B-V ≤ 1.6. Used as a "what does the existing
          ci field alone tell us about temperature" sanity check.

Outputs:
  - research/star-spectral-rendition/sample_comparison.txt   : aligned text table
  - research/star-spectral-rendition/sample_swatches.png     : visual swatch matrix

Run: research/star-spectral-rendition/.venv/bin/python research/star-spectral-rendition/compare_sample_stars.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt

from blackbody_color import blackbody_to_srgb
from parse_spectral import parse_spectral, temp_kelvin

OUT_TXT = Path(__file__).resolve().parent / "sample_comparison.txt"
OUT_PNG = Path(__file__).resolve().parent / "sample_swatches.png"

# Reference stars — name, spectral type (raw), B-V index (mag), notes.
# B-V values from SIMBAD/Hipparcos. Spectral types as the user would see
# them in a typical catalog (close to what AT-HYG carries).
REFERENCE_STARS = [
    ("Sol",         "G2 V",     0.656),
    ("Sirius A",    "A1 V",     0.009),
    ("Vega",        "A0 V",     0.000),
    ("Altair",      "A7 V",     0.221),
    ("Procyon",     "F5 IV-V",  0.432),
    ("Polaris",     "F7 Ib",    0.601),
    ("Capella",     "G3 III",   0.795),
    ("Pollux",      "K0 III",   0.991),
    ("Arcturus",    "K1.5 III", 1.234),
    ("Aldebaran",   "K5 III",   1.538),
    ("Antares",     "M1.5 Iab", 1.830),
    ("Betelgeuse",  "M2 Iab",   1.860),
    ("Proxima",     "M5.5 V",   1.807),
    ("Mintaka",     "O9.5 II",  -0.170),
    ("Spica",       "B1 V",     -0.235),
    ("Rigel",       "B8 Ia",    -0.030),
    ("Bellatrix",   "B2 III",   -0.224),
    ("Deneb",       "A2 Ia",     0.090),
    ("Castor A",    "A1 V",      0.034),
    ("Sirius B",    "DA2",       0.000),
]


def ci_to_color(ci: float) -> tuple[float, float, float]:
    """Mirror of src/client/shaders/star.vert.glsl:137 ciToColor.

    Three-stop piecewise-linear gradient: hot blue (CI≈-0.4) → solar
    white (CI≈0.65) → cool red (CI≈2.0). Identical to the GLSL fn so
    the comparison is apples-to-apples.
    """
    t = max(0.0, min(1.0, (ci + 0.4) / 2.4))
    hot = np.array([0.65, 0.78, 1.00])
    mid = np.array([1.00, 0.98, 0.92])
    cool = np.array([1.00, 0.55, 0.35])
    if t < 0.5:
        c = hot + (mid - hot) * (t * 2.0)
    else:
        c = mid + (cool - mid) * ((t - 0.5) * 2.0)
    return tuple(float(x) for x in c)


def teff_from_bv(bv: float) -> float:
    """Ballesteros (2012) empirical Teff from B-V index.

    Valid roughly -0.4 ≤ B-V ≤ 1.6 (MS regime). Clamped beyond that.
    """
    bv_c = max(-0.4, min(1.6, bv))
    return 4600.0 * (1.0 / (0.92 * bv_c + 1.7) + 1.0 / (0.92 * bv_c + 0.62))


def rgb_255(rgb: tuple[float, float, float]) -> tuple[int, int, int]:
    return tuple(int(round(255 * c)) for c in rgb)


def delta_e_8(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    """Euclidean distance in 8-bit sRGB space — rough perceptual proxy."""
    return float(np.sqrt(sum((255 * (ax - bx)) ** 2 for ax, bx in zip(a, b))))


def main() -> None:
    lines = []
    lines.append("# stellata-zsr.1 sample-star three-way colour comparison")
    lines.append("")
    lines.append("(A) ciToColor(B-V) — current shader piecewise gradient")
    lines.append("(B) blackbody → sRGB at Teff(spect) — T_TABLE MS lookup")
    lines.append("(C) blackbody → sRGB at Teff(B-V) — Ballesteros 2012")
    lines.append("")
    lines.append(f"{'Name':<13} {'Spect':<10} {'B-V':>6} {'Tspc':>5} {'Tbv':>5}  "
                 f"{'(A) ci_shdr':<14} {'(B) bb@Tspc':<14} {'(C) bb@Tbv':<14}"
                 f" {'ΔE_AB':>6} {'ΔE_AC':>6}")
    lines.append("-" * 130)

    panel_rgbs: list[tuple[str, tuple, tuple, tuple]] = []

    for name, spect_raw, bv in REFERENCE_STARS:
        info = parse_spectral(spect_raw)
        t_spec = temp_kelvin(info)
        t_bv = teff_from_bv(bv)

        col_a = ci_to_color(bv)
        col_b = blackbody_to_srgb(t_spec)
        col_c = blackbody_to_srgb(t_bv)

        de_ab = delta_e_8(col_a, col_b)
        de_ac = delta_e_8(col_a, col_c)

        a255 = rgb_255(col_a)
        b255 = rgb_255(col_b)
        c255 = rgb_255(col_c)
        lines.append(
            f"{name:<13} {spect_raw:<10} {bv:>6.3f} {t_spec:>5.0f} {t_bv:>5.0f}  "
            f"({a255[0]:3d},{a255[1]:3d},{a255[2]:3d}) "
            f"({b255[0]:3d},{b255[1]:3d},{b255[2]:3d}) "
            f"({c255[0]:3d},{c255[1]:3d},{c255[2]:3d}) "
            f"{de_ab:>6.1f} {de_ac:>6.1f}"
        )
        panel_rgbs.append((name, col_a, col_b, col_c))

    out_text = "\n".join(lines) + "\n"
    OUT_TXT.write_text(out_text)
    print(out_text)

    # Render a swatch matrix: rows = stars, columns = (A, B, C).
    fig, ax = plt.subplots(figsize=(8, len(panel_rgbs) * 0.35 + 1.5), dpi=140)
    ax.set_xlim(0, 4)
    ax.set_ylim(0, len(panel_rgbs))
    ax.invert_yaxis()
    ax.set_xticks([0.5, 1.5, 2.5, 3.5])
    ax.set_xticklabels(["star", "(A) ciToColor", "(B) bb @ Teff(spect)", "(C) bb @ Teff(B-V)"])
    ax.set_yticks([])
    ax.set_facecolor("#0a0a0e")
    fig.patch.set_facecolor("#0a0a0e")
    for spine in ax.spines.values():
        spine.set_color("#888")
    ax.tick_params(colors="#cccccc")

    for i, (name, ca, cb, cc) in enumerate(panel_rgbs):
        ax.text(0.05, i + 0.5, name, va="center", ha="left", color="#cccccc", fontsize=9)
        for col, rgb in enumerate([ca, cb, cc]):
            ax.add_patch(plt.Rectangle((1 + col, i + 0.1), 0.9, 0.8, facecolor=rgb, edgecolor="#222"))

    ax.set_title("stellata-zsr.1 — sample star colour comparison",
                 color="#cccccc", fontsize=11)
    plt.tight_layout()
    plt.savefig(OUT_PNG, dpi=140, facecolor=fig.get_facecolor())
    print(f"\nSwatch grid saved to {OUT_PNG}")


if __name__ == "__main__":
    main()
