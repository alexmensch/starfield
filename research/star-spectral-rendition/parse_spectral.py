"""Python port of scripts/catalog-pure.ts parseSpectral + tempKelvin.

Mirrors the TS implementation exactly. Verified by spot-checking against a
handful of known stars (Sol G2V, Sirius A1V, Vega A0V, Betelgeuse M2Iab,
Proxima M5.5V, Sirius B DA2) — see test_parse_spectral.py for the assertions.

Keeping this file thin and idiomatic-Python (no fancy abstractions) so the
TS↔Python parity is easy to eyeball.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class SpectralInfo:
    class_idx: int
    subclass: int
    lum_class: int
    is_white_dwarf: bool
    wd_subclass: int


def spect_class_index(first_char: str) -> int:
    mapping = {
        "O": 0, "B": 1, "A": 2, "F": 3, "G": 4, "K": 5, "M": 6,
        "C": 7, "S": 7, "W": 7, "N": 7, "R": 7,
    }
    return mapping.get(first_char, 8)


_LEADING_JUNK = re.compile(r'^["\':\s]+')
_SPACES = re.compile(r"\s+")


def parse_spectral(raw: str) -> SpectralInfo:
    s = _SPACES.sub("", _LEADING_JUNK.sub("", raw)).upper()
    if not s:
        return SpectralInfo(8, 5, 255, False, 0)

    if s[0] == "D" and (len(s) == 1 or s[1].isalpha()):
        m = re.match(r"^D[A-Z]*(\d(?:\.\d)?)?", s)
        wd_sub = round(float(m.group(1))) if m and m.group(1) else 5
        return SpectralInfo(8, 5, 0, True, max(0, min(9, wd_sub)))

    if s.startswith("SD"):
        letter = s[2:3]
        cls = spect_class_index(letter)
        sub_match = re.match(r"^(\d)", s[3:])
        sub = int(sub_match.group(1)) if sub_match else 5
        return SpectralInfo(cls, sub, 1, False, 0)

    first_char = s[0]
    class_idx = spect_class_index(first_char)

    sub_match = re.match(r"^(\d)(?:\.\d)?", s[1:])
    subclass = int(sub_match.group(1)) if sub_match else 5

    after_prefix = s[1 + (len(sub_match.group(0)) if sub_match else 0):]
    lum_class = 255
    if re.match(r"^(IA\+|0)", after_prefix):
        lum_class = 9
    elif re.match(r"^IAB", after_prefix):
        lum_class = 7
    elif re.match(r"^IA", after_prefix):
        lum_class = 8
    elif re.match(r"^IB", after_prefix):
        lum_class = 6
    elif re.match(r"^III", after_prefix):
        lum_class = 4
    elif re.match(r"^II(?!I)", after_prefix):
        lum_class = 5
    elif re.match(r"^IV", after_prefix):
        lum_class = 3
    elif re.match(r"^VII", after_prefix):
        lum_class = 0
    elif re.match(r"^VI(?!I)", after_prefix):
        lum_class = 1
    elif re.match(r"^V", after_prefix):
        lum_class = 2
    elif re.match(r"^I(?![IV])", after_prefix):
        lum_class = 7  # bare "I" treated as Iab

    return SpectralInfo(class_idx, subclass, lum_class, False, 0)


# Main-sequence T_eff table (Kelvin) keyed by spectral class index, with
# (subclass, T_eff) breakpoints. Mirrors scripts/catalog-pure.ts T_TABLE.
T_TABLE = {
    0: [(0, 50000), (5, 42000), (9, 34000)],
    1: [(0, 30000), (5, 15200), (9, 10500)],
    2: [(0,  9790), (5,  8180), (9,  7600)],
    3: [(0,  7300), (5,  6650), (9,  6050)],
    4: [(0,  5940), (5,  5560), (9,  5310)],
    5: [(0,  5150), (5,  4410), (9,  3900)],
    6: [(0,  3840), (5,  3170), (9,  2500)],
    7: [(0,  4000), (5,  3000), (9,  2500)],
    8: [(0,  5000), (5,  5000), (9,  5000)],
}


def _interp(table: list[tuple[int, float]], key: float) -> float:
    last = table[-1]
    if key >= last[0]:
        return last[1]
    for i in range(1, len(table)):
        k0, v0 = table[i - 1]
        k1, v1 = table[i]
        if key <= k1:
            t = (key - k0) / (k1 - k0)
            return v0 + (v1 - v0) * t
    return last[1]


def temp_kelvin(info: SpectralInfo) -> float:
    if info.is_white_dwarf:
        n = max(1, info.wd_subclass)
        return 50400.0 / n
    return _interp(T_TABLE.get(info.class_idx, T_TABLE[8]), info.subclass)
