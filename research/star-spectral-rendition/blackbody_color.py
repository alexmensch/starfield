"""Blackbody temperature → sRGB colour.

Computes the apparent chromaticity of a Planckian radiator at a given
temperature, then maps to sRGB via CIE 1931 2° standard observer and
the sRGB D65 transform.

Approach:
  1. Sample Planck's law B_λ(T) over the visible band [380, 780] nm at
     5 nm resolution.
  2. Multiply by CIE 1931 colour-matching functions (x̄, ȳ, z̄) — using
     the multi-lobe Gaussian analytical fits from Wyman/Sloan/Shirley
     (JCGT 2(2), 2013, doi:10.5281/zenodo.10049479). Accurate to ~1%
     vs the tabulated CIE 1931 2° standard.
  3. Integrate → XYZ tristimulus.
  4. Linear-sRGB transform (D65 illuminant).
  5. Normalize each blackbody so its brightest linear channel = 1.0
     (preserves chroma; brightness is handled separately by the renderer).
  6. Gamma-encode linear sRGB → sRGB via the standard piecewise transfer
     function (1.055·lin^(1/2.4) − 0.055 above 0.0031308; 12.92·lin below).

Cross-check: spot-tested against Mitchell Charity's tabulated blackbody
RGB values (http://www.vendian.org/mncharity/dir3/blackbody/) — see the
__main__ block.

Run: research/star-spectral-rendition/.venv/bin/python research/star-spectral-rendition/blackbody_color.py
"""

from __future__ import annotations

import numpy as np

H = 6.62607015e-34   # Planck (J·s)
C = 2.99792458e8     # speed of light (m/s)
KB = 1.380649e-23    # Boltzmann (J/K)

WAVELENGTHS_NM = np.arange(380.0, 781.0, 5.0)


def planck_spectral_radiance(wavelength_nm: np.ndarray, temperature_k: float) -> np.ndarray:
    """B_λ(T) in W·sr⁻¹·m⁻³, vectorized over wavelength array (nm)."""
    lam = wavelength_nm * 1e-9
    a = 2.0 * H * C * C / (lam ** 5)
    exponent = (H * C) / (lam * KB * temperature_k)
    return a / (np.exp(exponent) - 1.0)


def _wyman_gaussian(lam: np.ndarray, alpha: float, beta_lo: float, beta_hi: float) -> np.ndarray:
    """Piecewise Gaussian with different σs below and above the peak λ."""
    sigma = np.where(lam < alpha, beta_lo, beta_hi)
    return np.exp(-0.5 * ((lam - alpha) / sigma) ** 2)


def cmf_xyz(wavelength_nm: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """CIE 1931 2° colour-matching functions via Wyman et al. 2013 fits."""
    lam = wavelength_nm
    x_bar = (
        0.362 * _wyman_gaussian(lam, 442.0, 16.0, 26.7)
        + 1.056 * _wyman_gaussian(lam, 599.8, 37.9, 31.0)
        - 0.065 * _wyman_gaussian(lam, 501.1, 20.4, 26.2)
    )
    y_bar = (
        0.821 * _wyman_gaussian(lam, 568.8, 46.9, 40.5)
        + 0.286 * _wyman_gaussian(lam, 530.9, 16.3, 31.1)
    )
    z_bar = (
        1.217 * _wyman_gaussian(lam, 437.0, 11.8, 36.0)
        + 0.681 * _wyman_gaussian(lam, 459.0, 26.0, 13.8)
    )
    return x_bar, y_bar, z_bar


# D65 XYZ → linear sRGB matrix (IEC 61966-2-1).
XYZ_TO_LIN_SRGB = np.array([
    [ 3.2406, -1.5372, -0.4986],
    [-0.9689,  1.8758,  0.0415],
    [ 0.0557, -0.2040,  1.0570],
])

# Back-compat alias — earlier scripts imported the original name.
XYZ_TO_LIN_RGB = XYZ_TO_LIN_SRGB

# D65 XYZ → linear Display P3 matrix.
# Display P3 = DCI-P3 primaries + D65 white point + sRGB transfer function.
# Coefficients from IEC 61966-2-2 / Apple Display P3 specification.
# ~25% larger gamut than sRGB, expansion concentrated in saturated reds + greens
# + the deep-blue edge — the latter is what matters for hot O/B stars whose
# Planckian chromaticity sits outside sRGB.
XYZ_TO_LIN_P3 = np.array([
    [ 2.4934969119, -0.9313836179, -0.4027107845],
    [-0.8294889696,  1.7626640603,  0.0236246858],
    [ 0.0358458302, -0.0761723893,  0.9568845240],
])


def _gamma_encode(x: np.ndarray) -> np.ndarray:
    """sRGB piecewise transfer function. Display P3 reuses this transfer
    function — only the primaries + matrix differ."""
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1.0 / 2.4) - 0.055)


def _xyz_for_temperature(temperature_k: float) -> np.ndarray:
    """Compute CIE XYZ tristimulus for a blackbody at the given temperature.
    Factored out so the sRGB and Display P3 paths share the optical chain."""
    lam = WAVELENGTHS_NM
    spectrum = planck_spectral_radiance(lam, temperature_k)
    x_bar, y_bar, z_bar = cmf_xyz(lam)
    dlam = lam[1] - lam[0]
    X = np.trapezoid(spectrum * x_bar, dx=dlam)
    Y = np.trapezoid(spectrum * y_bar, dx=dlam)
    Z = np.trapezoid(spectrum * z_bar, dx=dlam)
    return np.array([X, Y, Z])


def _normalise_peak(lin_rgb: np.ndarray) -> np.ndarray:
    """Clip out-of-gamut negative components, then rescale so the peak
    channel = 1.0. Preserves chroma; renderer handles brightness elsewhere."""
    lin_rgb = np.maximum(lin_rgb, 0.0)
    peak = np.max(lin_rgb)
    if peak > 0:
        lin_rgb = lin_rgb / peak
    return lin_rgb


def blackbody_to_srgb(temperature_k: float) -> tuple[float, float, float]:
    """Map T (Kelvin) → gamma-encoded sRGB triplet in [0, 1].

    Negative linear-RGB components (which signal "this chromaticity is outside
    the sRGB gamut") are clipped to zero before peak normalisation. For hot
    O-star temperatures the clipping is significant — see blackbody_to_displayp3
    for the wider-gamut version that loses less chroma at the blue extreme.
    """
    xyz = _xyz_for_temperature(temperature_k)
    lin = XYZ_TO_LIN_SRGB @ xyz
    srgb = _gamma_encode(_normalise_peak(lin))
    return float(srgb[0]), float(srgb[1]), float(srgb[2])


def blackbody_to_displayp3(temperature_k: float) -> tuple[float, float, float]:
    """Map T (Kelvin) → gamma-encoded Display P3 triplet in [0, 1].

    Same Planck + CIE 1931 optical chain as the sRGB path; differs only in
    the final XYZ → linear matrix and the gamut at which negative components
    appear. Output bytes are meant to be embedded in a Display-P3-tagged PNG
    (see p3_swatches.py) so the OS colour-management layer renders them
    correctly on both P3 and sRGB displays.
    """
    xyz = _xyz_for_temperature(temperature_k)
    lin = XYZ_TO_LIN_P3 @ xyz
    p3 = _gamma_encode(_normalise_peak(lin))
    return float(p3[0]), float(p3[1]), float(p3[2])


def srgb_clipped_to_displayp3(srgb: tuple[float, float, float]) -> tuple[float, float, float]:
    """Re-encode an existing gamma-encoded sRGB triplet as Display P3 bytes.

    Used when we want to display an already-sRGB-clipped colour inside a
    Display-P3-tagged image so the comparison "sRGB vs P3" renders correctly
    on a P3 monitor. The encoded P3 bytes preserve the perceptual look of the
    original sRGB colour (no further gamut expansion — that already happened
    when sRGB was the source space).
    """
    srgb_arr = np.array(srgb, dtype=np.float64)
    # Decode sRGB gamma → linear sRGB.
    lin_srgb = np.where(
        srgb_arr <= 0.04045,
        srgb_arr / 12.92,
        np.power((srgb_arr + 0.055) / 1.055, 2.4),
    )
    # Linear sRGB → XYZ via the inverse of XYZ_TO_LIN_SRGB.
    xyz = np.linalg.inv(XYZ_TO_LIN_SRGB) @ lin_srgb
    # XYZ → linear Display P3. sRGB gamut is a subset of P3, so any valid
    # peak-normalised sRGB input lands inside P3 — clipping to [0, 1] is
    # enough (no renormalisation needed, which would shift hue).
    lin_p3 = XYZ_TO_LIN_P3 @ xyz
    p3 = _gamma_encode(np.clip(lin_p3, 0.0, 1.0))
    return float(p3[0]), float(p3[1]), float(p3[2])


# Mitchell Charity's "10deg" blackbody RGB table (subset for cross-check).
# Source: http://www.vendian.org/mncharity/dir3/blackbody/UnstableURLs/bbr_color.html
# Values quoted as RGB 0-255; we normalise to [0,1] for comparison.
CHARITY_REFERENCE = {
    # T (K): (R, G, B) in 0-255
     3000: (255, 180, 107),
     4000: (255, 209, 163),
     5000: (255, 228, 206),
     5800: (255, 244, 242),  # solar
     6500: (255, 249, 253),  # D65-ish
     8000: (227, 233, 255),
    10000: (201, 219, 255),
    15000: (181, 205, 255),
    20000: (175, 200, 255),
    30000: (171, 197, 255),
}


def _delta_e(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    """Approximate perceptual ΔE — just Euclidean distance in sRGB 0-255.

    Not Lab-space ΔE, but adequate for "are these visibly different?"
    given the comparisons here. ΔE ≈ 10 is roughly the just-noticeable
    threshold against a flat background; against a black background with
    dim point-source rendering, the threshold is higher (~20-30).
    """
    return float(np.sqrt(sum((255 * (ax - bx)) ** 2 for ax, bx in zip(a, b))))


if __name__ == "__main__":
    print(f"{'T (K)':>7}  {'Wyman+CIE (R,G,B)':<22}  {'Charity (R,G,B)':<22}  ΔE")
    print("-" * 72)
    for T, charity_255 in CHARITY_REFERENCE.items():
        ours = blackbody_to_srgb(T)
        ours_255 = tuple(int(round(255 * c)) for c in ours)
        charity_norm = tuple(c / 255.0 for c in charity_255)
        de = _delta_e(ours, charity_norm)
        ours_str = f"({ours_255[0]:3d},{ours_255[1]:3d},{ours_255[2]:3d})"
        char_str = f"({charity_255[0]:3d},{charity_255[1]:3d},{charity_255[2]:3d})"
        print(f"{T:>7}  {ours_str:<22}  {char_str:<22}  {de:5.1f}")
