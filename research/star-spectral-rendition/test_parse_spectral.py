"""Parity sanity-check for parse_spectral.py against the TS reference.

These cases were computed by hand from scripts/catalog-pure.ts parseSpectral
+ TS unit tests. Any change here that drifts from the TS implementation
will fail this check.

Run: research/star-spectral-rendition/.venv/bin/python research/star-spectral-rendition/test_parse_spectral.py
"""

from parse_spectral import parse_spectral, temp_kelvin

CASES = [
    # (raw_spect, class_idx, subclass, lum_class, is_wd, wd_sub)
    ("G2 V",        4, 2, 2,   False, 0),    # Sol
    ("A1 V",        2, 1, 2,   False, 0),    # Sirius A
    ("A0 V",        2, 0, 2,   False, 0),    # Vega
    ("M2 Iab",      6, 2, 7,   False, 0),    # Betelgeuse
    ("K5 III",      5, 5, 4,   False, 0),    # Aldebaran-like
    ("M5.5 V",      6, 5, 2,   False, 0),    # Proxima
    ("DA2",         8, 5, 0,   True,  2),    # Sirius B
    ("sdB",         1, 5, 1,   False, 0),    # subdwarf B
    ("O9 V",        0, 9, 2,   False, 0),    # Mintaka primary
    ("",            8, 5, 255, False, 0),    # unknown
    ("B0 Ia",       1, 0, 8,   False, 0),    # luminous supergiant
    ("F5 IV",       3, 5, 3,   False, 0),    # subgiant
    ("M2 III",      6, 2, 4,   False, 0),    # red giant
    ("B3 V",        1, 3, 2,   False, 0),    # B main sequence
]

failures = []
for raw, exp_cls, exp_sub, exp_lum, exp_wd, exp_wdsub in CASES:
    info = parse_spectral(raw)
    actual = (info.class_idx, info.subclass, info.lum_class, info.is_white_dwarf, info.wd_subclass)
    expected = (exp_cls, exp_sub, exp_lum, exp_wd, exp_wdsub)
    ok = actual == expected
    status = "PASS" if ok else "FAIL"
    print(f"{status}  '{raw:<10}'  cls={info.class_idx} sub={info.subclass} lum={info.lum_class} wd={info.is_white_dwarf}/{info.wd_subclass}  Teff={temp_kelvin(info):.0f}")
    if not ok:
        failures.append((raw, expected, actual))

if failures:
    print(f"\n{len(failures)} failure(s):")
    for raw, exp, act in failures:
        print(f"  {raw!r}: expected {exp}, got {act}")
    raise SystemExit(1)
else:
    print(f"\nAll {len(CASES)} cases pass.")
