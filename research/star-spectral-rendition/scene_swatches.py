"""Step 4 of stellata-zsr.1 — offline scene-style swatch render.

Simulates how each colour function looks when rendered as a glowing point
against a black background — the real perceptual context for the colours
in Stellata's renderer.

This is NOT a faithful reproduction of the shader stack. It skips the
core-mask depth pass, the variable-pulse modulation, and the per-pixel
distance-driven super-Gaussian morph. What it DOES reproduce is the
high-order driver of how chroma reads on screen: a bright peak with
exponential falloff into a black field, multi-source-blended where the
glows overlap, gamma-encoded for sRGB display.

Each sample star is rendered three times, side by side, one per colour
function (A/B/C from compare_sample_stars.py). All renders share the same
peak intensity so the comparison isolates chroma, not magnitude.

Output: research/star-spectral-rendition/scene_swatches.png
"""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

from blackbody_color import blackbody_to_srgb
from compare_sample_stars import REFERENCE_STARS, ci_to_color, teff_from_bv
from parse_spectral import parse_spectral, temp_kelvin

OUT_PNG = Path(__file__).resolve().parent / "scene_swatches.png"

# Each cell: a single star rendered as an additive Gaussian glow.
CELL_PX = 96
GLOW_SIGMA_PX = 12.0   # core "disc" radius
HALO_SIGMA_PX = 32.0   # outer glow
HALO_WEIGHT = 0.45     # halo contribution relative to core
GAMMA = 2.2            # display gamma


def render_glow(rgb: tuple[float, float, float]) -> np.ndarray:
    """Render a single glowing-star cell with the given chroma.

    Builds a 2-D Gaussian (core) plus a wider Gaussian (halo). The core is
    bright enough to saturate the channel that already sits at 1.0 in the
    input chroma, replicating what the eye sees when a coloured point of
    light is bright enough to bleach the peak toward white. This is the
    correct perceptual behaviour for additive blending against black —
    cool reds desaturate at the peak (because the R channel saturates and
    G/B continue to grow with intensity), so the eye reads them as
    cream/peach near the core and as their "true" chroma only in the
    wings. The current shader's flat chroma misses this.
    """
    yy, xx = np.mgrid[0:CELL_PX, 0:CELL_PX]
    cx = cy = (CELL_PX - 1) / 2.0
    r2 = (xx - cx) ** 2 + (yy - cy) ** 2

    core = np.exp(-r2 / (2.0 * GLOW_SIGMA_PX ** 2))
    halo = HALO_WEIGHT * np.exp(-r2 / (2.0 * HALO_SIGMA_PX ** 2))
    intensity = core + halo  # ranges roughly [0, 1 + HALO_WEIGHT]

    rgb_arr = np.array(rgb, dtype=np.float32)
    # Additive accumulation against black: linear-space multiplication of
    # intensity by chroma, then clamp + gamma-encode.
    lin = intensity[..., None] * rgb_arr[None, None, :]
    # Apply soft-clip toward white at the peak (saturating exposure): the
    # eye sees bright additive lights as whitened at the core. Reinhard-like
    # tone map per channel: x / (x + 0.5). 0.5 chosen so a single-channel
    # input of 1.0 at peak intensity ≈ 1.5 maps to ~0.75, and 1.5 * white
    # saturates near 1.0 — the cream/peach effect.
    tonemap = lin / (lin + 0.5)
    srgb = np.clip(tonemap, 0.0, 1.0) ** (1.0 / GAMMA)
    return srgb


def main() -> None:
    nrows = len(REFERENCE_STARS)
    fig, axes = plt.subplots(nrows, 4, figsize=(7, nrows * 0.55 + 1.0), dpi=140,
                              gridspec_kw=dict(width_ratios=[1.6, 1, 1, 1]))
    fig.patch.set_facecolor("#000000")

    for i, (name, spect_raw, bv) in enumerate(REFERENCE_STARS):
        info = parse_spectral(spect_raw)
        t_spec = temp_kelvin(info)
        t_bv = teff_from_bv(bv)
        ca = ci_to_color(bv)
        cb = blackbody_to_srgb(t_spec)
        cc = blackbody_to_srgb(t_bv)

        # Text cell (label).
        ax_label = axes[i, 0]
        ax_label.text(0.05, 0.5, f"{name}\n{spect_raw}  B-V={bv:+.2f}",
                      va="center", ha="left", color="#cccccc", fontsize=8,
                      family="monospace")
        ax_label.set_xlim(0, 1)
        ax_label.set_ylim(0, 1)
        ax_label.set_xticks([])
        ax_label.set_yticks([])
        ax_label.set_facecolor("#000000")
        for spine in ax_label.spines.values():
            spine.set_visible(False)

        for col, rgb in enumerate([ca, cb, cc]):
            ax = axes[i, col + 1]
            ax.imshow(render_glow(rgb), interpolation="bilinear")
            ax.set_xticks([])
            ax.set_yticks([])
            for spine in ax.spines.values():
                spine.set_color("#222")

    # Column headers.
    headers = ["", "(A) ciToColor", "(B) bb @ Teff(spect)", "(C) bb @ Teff(B-V)"]
    for col, label in enumerate(headers):
        axes[0, col].set_title(label, color="#dddddd", fontsize=9, pad=8)

    fig.suptitle("stellata-zsr.1 — scene-style colour swatches (additive glow on black)",
                 color="#dddddd", fontsize=10, y=0.995)
    plt.tight_layout(rect=[0, 0, 1, 0.985])
    plt.savefig(OUT_PNG, dpi=140, facecolor=fig.get_facecolor())
    print(f"Saved {OUT_PNG}")


if __name__ == "__main__":
    main()
