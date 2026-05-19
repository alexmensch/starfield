#!/usr/bin/env python3
"""Unit tests for build-binaries.py Stage 1 parsers.

Pins each loader against tiny fixture inputs written to a temporary
directory. No network, no large catalog files — the suite runs in well
under a second.

Run:
    python3 scripts/build-binaries.test.py

(The `.test.py` filename matches the project's `.test.ts` convention but
trips Python's `-m unittest` module-path parser on the dot; invoking the
file directly executes `unittest.main()` in the `__main__` block below.)
"""

from __future__ import annotations

import importlib.util
import math
import sys
import tempfile
import unittest
from pathlib import Path

# build-binaries.py contains a hyphen and a `from __future__` style import
# that prevents a normal `import build_binaries`. Load it via spec_from_file
# so the test module can address its parsers directly.
_HERE = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location(
    "build_binaries", _HERE / "build-binaries.py",
)
assert _SPEC and _SPEC.loader
bb = importlib.util.module_from_spec(_SPEC)
sys.modules["build_binaries"] = bb
_SPEC.loader.exec_module(bb)


def _write(dirpath: Path, name: str, body: str) -> Path:
    p = dirpath / name
    p.write_text(body)
    return p


class AthygTests(unittest.TestCase):
    HEADER = (
        '"id","tyc","gaia","hyg","hip","hd","hr","gl","bayer","flam","con",'
        '"proper","ra","dec","pos_src","dist","x0","y0","z0","dist_src",'
        '"mag","absmag","ci","mag_src","rv","rv_src","pm_ra","pm_dec",'
        '"pm_src","vx","vy","vz","spect","spect_src"'
    )

    def test_surfaces_hip_tyc_gaia(self) -> None:
        # One Sol-like row (no Tyc/Gaia/HIP), one fully-classical-IDs row.
        body = "\n".join([
            self.HEADER,
            '1,"",,0,,,"","","","","",Sol,0.0,0.0,OTHER,0.0,0.000005,0.0,'
            '0.0,OTHER,-26.7,4.85,0.656,OTHER,,OTHER,,,OTHER,,,,G2 V,OTHER',
            '21,"5841-1155-1",2341871673090078592,0,2,,"","","","","",,'
            '0.0008,75.48,Hip,219.30,55.93,0.42,212.74,Hip,9.27,-1.45,1.46,'
            'Hip,,OTHER,,,Hip,,,,K0V,Hip',
        ]) + "\n"
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "athyg.csv", body)
            rows = bb.parse_athyg(p)
        self.assertEqual(len(rows), 2)

        sol = rows[0]
        self.assertEqual(sol.proper, "Sol")
        self.assertIsNone(sol.hip)
        self.assertIsNone(sol.tyc)
        self.assertIsNone(sol.gaia)

        hip2 = rows[1]
        self.assertEqual(hip2.hip, 2)
        self.assertEqual(hip2.tyc, "5841-1155-1")
        self.assertEqual(hip2.gaia, 2341871673090078592)
        self.assertAlmostEqual(hip2.ra_deg, 0.0008 * 15.0)
        self.assertAlmostEqual(hip2.dec_deg, 75.48)
        self.assertAlmostEqual(hip2.absmag, -1.45)
        self.assertAlmostEqual(hip2.ci or 0.0, 1.46)


class WdsSummTests(unittest.TestCase):
    def test_parses_precise_coord_and_components(self) -> None:
        # 130-char fixed-width WDS_SUMM record (synthetic, mirrors a real
        # row's column offsets). Padding ensures every field reaches the
        # column the parser expects.
        line = (
            "00000+7530A  1248      1904 1982    5 246 235   0.8   0.6 "
            "10.27 11.5  A7IV      +034+005          +74 1056      "
            "000006.64+752859.8"
        ).ljust(130)
        # WDS files include a header block our parser skips — verify the
        # regex catches it.
        body = (
            "<some HTML\n"
            "Identifier             Frst Last      Fst Lst First  Last  "
            "Pri   Sec  Type      RA\" DEC\" RA\" DEC\"                 "
            "Coordinate      \n"
            "\n"
            f"{line}\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "wds.txt", body)
            pairs = bb.parse_wds_summ(p)
        self.assertEqual(len(pairs), 1)
        pr = pairs[0]
        self.assertEqual(pr.wds_id, "00000+7530")
        self.assertEqual(pr.discoverer, "A  1248")
        self.assertEqual(pr.date_last, 1982)
        self.assertIsNotNone(pr.precise_ra_deg)
        self.assertIsNotNone(pr.precise_dec_deg)
        assert pr.precise_dec_deg is not None
        self.assertAlmostEqual(pr.precise_dec_deg, 75.4833, places=2)


class Orb6Tests(unittest.TestCase):
    def test_parses_row_with_components(self) -> None:
        # Real-shape ORB6 line with an Aa,Ab component designator at the
        # tail of the discoverer field. Positions follow the banner ruler
        # in data/orb6_orbits.txt.
        line = "000233.44+184100.1 00026+1841 HDS   2Aa,Ab   .     225000    201   8.49  10.62     22.68    y   0.34       0.1106 a  0.0028   59.8      1.3     17.4       2.3     2020.967       0.074    0.6313   0.0130   302.2      3.1    2000 2023 3 n Tok2024a wds00026+1841b.png"
        body = (
            "Sixth Catalog of Orbits of Visual Binary Stars: Orbits\n"
            "0000000000111111111122222\n"
            "0123456789012345678901234\n"
            f"{line}\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "orb6.txt", body)
            rows = bb.parse_orb6(p)
        self.assertEqual(len(rows), 1)
        e = rows[0]
        self.assertEqual(e.wds_id, "00026+1841")
        self.assertEqual(e.components, "Aa,Ab")
        self.assertEqual(e.grade, 3)
        self.assertEqual(e.hip, 201)
        self.assertEqual(e.P_unit, "y")

    def test_parses_row_without_components(self) -> None:
        # Discoverer field "I  1477        " has no component designator —
        # parser must still load the row, with components = "".
        line = "000019.10-441726.0 00003-4417 I  1477        .     224750     25   6.80   7.56    115.4     y   2.9        0.435  a  0.014    65.6      2.6    147.5       1.5     2011.58    y   0.86     0.717    0.020    297.3      2.2    2000 2022 3   Tok2023a wds00003-4417d.png"
        body = "banner line\n" + line + "\n"
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "orb6.txt", body)
            rows = bb.parse_orb6(p)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].wds_id, "00003-4417")
        self.assertEqual(rows[0].components, "")
        self.assertEqual(rows[0].grade, 3)
        self.assertEqual(rows[0].hip, 25)


class GcvsTests(unittest.TestCase):
    def test_parses_rows_and_crossids(self) -> None:
        gcvs_body = (
            "#\n"
            "#   VizieR header\n"
            "#\n"
            "---\n"
            "010001 |R     And *|002401.95 +383437.3 |M         |  5.8    "
            "|  15.2      |            |V |53820.      |     |   409.2   "
            "|38   |S3,5e-S8,8e(M7e) |HIP   00002|           |-0.016 -0.035|"
            "2000.0  | |Hip      |M         |R     And |\n"
        )
        crossid_body = (
            "---\n"
            "GCVS R     And                |    =HIP    2| | |\n"
            "GCVS S     And                |    =M31   V0894| | |\n"
        )
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            gp = _write(tdp, "gcvs5.txt", gcvs_body)
            xp = _write(tdp, "crossid.txt", crossid_body)
            rows = bb.parse_gcvs(gp)
            xid = bb.parse_gcvs_crossid(xp)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].gcvs_id, "010001")
        self.assertEqual(rows[0].designation, "R     And *")
        self.assertEqual(rows[0].var_type, "M")
        self.assertIn("R     And", xid)
        self.assertEqual(xid["R     And"], ["HIP    2"])


class CcdmTests(unittest.TestCase):
    def test_skips_vizier_header(self) -> None:
        body = (
            "#\n"
            "#   VizieR header\n"
            "#\n"
            "HIP\tCCDM\tMultFlag\n"
            " \t \t\n"
            "------\t----------\t-\n"
            "     3\t00000+3852\t\n"
            "    18\t          \tO\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "ccdm.tsv", body)
            rows = bb.parse_ccdm(p)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].hip, 3)
        self.assertEqual(rows[0].ccdm, "00000+3852")
        self.assertEqual(rows[1].hip, 18)
        self.assertEqual(rows[1].mult_flag, "O")


class Hip2Tests(unittest.TestCase):
    def test_parses_astrometry_row(self) -> None:
        body = (
            "hip\tra_icrs\tde_icrs\tplx\te_plx\tpm_ra\tpm_de\te_pm_ra\t"
            "e_pm_de\tgoodness_of_fit\tn_transits\n"
            "2\t0.00379738\t-19.49883738\t20.85\t1.13\t182.88\t-1.31\t1.22"
            "\t0.66\t0.06\t121\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "hip2.tsv", body)
            rows = bb.parse_hip2(p)
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r.hip, 2)
        self.assertEqual(r.plx_mas, 20.85)
        self.assertEqual(r.n_transits, 121)


class GaiaXmatchTests(unittest.TestCase):
    def test_hip_xmatch_keeps_nearest(self) -> None:
        body = (
            "hip\tgaia_source_id\tangular_distance\tnumber_of_neighbours\txm_flag\n"
            "2\t2341871673090078592\t0.043826\t1\t8\n"
            "2\t9999999999999999999\t1.234\t1\t8\n"   # farther — should lose
            "3\t2881742980523997824\t0.001604\t1\t8\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "xm.tsv", body)
            m = bb.parse_gaia_hip_xmatch(p)
        self.assertEqual(m[2], 2341871673090078592)
        self.assertEqual(m[3], 2881742980523997824)

    def test_tyc_xmatch(self) -> None:
        body = (
            "tyc\tgaia_source_id\tangular_distance\tnumber_of_neighbours\txm_flag\n"
            "1000-1006-1\t4493609606459508864\t0.065120\t1\t8\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "tyc.tsv", body)
            m = bb.parse_gaia_tyc_xmatch(p)
        self.assertEqual(m["1000-1006-1"], 4493609606459508864)

    def test_nss_returns_raw_row(self) -> None:
        body = (
            "source_id\tnss_solution_type\tperiod\tperiod_error\n"
            "33711199137024\tOrbital\t773.09\t27.35\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "nss.tsv", body)
            m = bb.parse_gaia_nss(p)
        self.assertEqual(set(m.keys()), {33711199137024})
        self.assertEqual(m[33711199137024]["nss_solution_type"], "Orbital")
        self.assertEqual(m[33711199137024]["period"], "773.09")


class SplitComponentsTests(unittest.TestCase):
    def test_two_letter_pair(self) -> None:
        self.assertEqual(bb.split_components("AB"), ("A", "B"))

    def test_comma_separated_pair(self) -> None:
        self.assertEqual(bb.split_components("Aa,Ab"), ("Aa", "Ab"))
        self.assertEqual(bb.split_components("BC,D"), ("BC", "D"))

    def test_skips_system_level_row(self) -> None:
        self.assertIsNone(bb.split_components(""))
        self.assertIsNone(bb.split_components("   "))

    def test_skips_ambiguous_three_letter(self) -> None:
        # "ABC" could be A+BC or AB+C — refuse rather than guess.
        self.assertIsNone(bb.split_components("ABC"))

    def test_skips_single_letter(self) -> None:
        self.assertIsNone(bb.split_components("A"))


def _wds_pair(*, wds_id: str = "00000+0000", components: str = "AB") -> "bb.WdsPair":
    return bb.WdsPair(
        wds_id=wds_id, discoverer="TST   1", components=components,
        date_last=None, rho_last=None, theta_last=None,
        mag_pri=None, mag_sec=None, spectral="", notes="    ",
        precise_ra_deg=None, precise_dec_deg=None,
    )


def _athyg_row(*, hip: int | None = None, gaia: int | None = None) -> "bb.AthygRow":
    return bb.AthygRow(
        hip=hip, tyc=None, gaia=gaia, hd=None,
        ra_deg=0.0, dec_deg=0.0,
        x_pc=0.0, y_pc=0.0, z_pc=0.0,
        dist_pc=1.0, v_mag=None, absmag=5.0,
        ci=None, spect="", proper="",
    )


def _indices(
    *,
    hip_to_gaia: dict[int, int] | None = None,
    athyg: list["bb.AthygRow"] | None = None,
) -> "bb.IdentifierIndices":
    return bb.build_indices(
        athyg=athyg or [],
        hip2=[],
        hip_to_gaia=hip_to_gaia or {},
        tyc_to_gaia={},
        src_to_nss={},
    )


def _orb6(*, wds_id: str, components: str, hip: int | None) -> "bb.Orb6Entry":
    return bb.Orb6Entry(
        wds_id=wds_id, discoverer="TST   1", components=components,
        hd=None, hip=hip,
        P_val=None, P_unit="", a_val=None, a_unit="",
        i_deg=None, Omega_deg=None, omega_deg=None,
        e=None, T0_val=None, T0_unit="", grade=5, ref="",
    )


class ResolveComponentTests(unittest.TestCase):
    def test_tier1_orb6_hip_for_primary(self) -> None:
        # ORB6 publishes HIP for the pair; Gaia HIP xwalk covers it.
        pair = _wds_pair(wds_id="06451-1643", components="AB")
        orb6 = [_orb6(wds_id="06451-1643", components="AB", hip=32349)]
        idx = _indices(hip_to_gaia={32349: 2947050466531873024})
        r = bb.resolve_component(
            pair, "A", is_primary=True,
            orb6_for_pair=orb6, indices=idx,
        )
        self.assertEqual(r.resolve_via, "orb6_hip")
        self.assertEqual(r.gaia_source_id, 2947050466531873024)

    def test_tier1_does_not_fire_for_secondary(self) -> None:
        # ORB6 has one HIP per orbit row (the primary's by convention).
        # Secondary must fall through to a later tier.
        pair = _wds_pair(components="AB")
        orb6 = [_orb6(wds_id=pair.wds_id, components="AB", hip=100)]
        idx = _indices(hip_to_gaia={100: 999})
        r = bb.resolve_component(
            pair, "B", is_primary=False,
            orb6_for_pair=orb6, indices=idx,
        )
        self.assertEqual(r.resolve_via, "unresolved")
        self.assertIsNone(r.gaia_source_id)

    def test_tier2_athyg_when_orb6_hip_misses_xwalk(self) -> None:
        # ORB6 hip exists, Gaia HIP xwalk misses; AT-HYG carries gaia
        # natively for that HIP.
        pair = _wds_pair(components="AB")
        orb6 = [_orb6(wds_id=pair.wds_id, components="AB", hip=42)]
        idx = _indices(
            hip_to_gaia={},  # xwalk does not cover HIP 42
            athyg=[_athyg_row(hip=42, gaia=12345)],
        )
        r = bb.resolve_component(
            pair, "A", is_primary=True,
            orb6_for_pair=orb6, indices=idx,
        )
        self.assertEqual(r.resolve_via, "athyg_gaia_native")
        self.assertEqual(r.gaia_source_id, 12345)

    def test_unresolved_when_no_hip_signal(self) -> None:
        pair = _wds_pair(components="AB")
        idx = _indices(hip_to_gaia={1: 1})
        r = bb.resolve_component(
            pair, "A", is_primary=True,
            orb6_for_pair=[], indices=idx,
        )
        self.assertEqual(r.resolve_via, "unresolved")
        self.assertIsNone(r.gaia_source_id)

    def test_priority_xwalk_beats_athyg(self) -> None:
        # Both tier 1 and the HIP branch of tier 2 would succeed for
        # the same HIP — tier 1 wins because the Gaia HIP xwalk is
        # canonical.
        pair = _wds_pair(components="AB")
        orb6 = [_orb6(wds_id=pair.wds_id, components="AB", hip=10)]
        idx = _indices(
            hip_to_gaia={10: 100},
            athyg=[_athyg_row(hip=10, gaia=999)],   # disagreeing AT-HYG
        )
        r = bb.resolve_component(
            pair, "A", is_primary=True,
            orb6_for_pair=orb6, indices=idx,
        )
        self.assertEqual(r.resolve_via, "orb6_hip")
        self.assertEqual(r.gaia_source_id, 100)


class GroupOrb6ByPairTests(unittest.TestCase):
    def test_strict_components_key(self) -> None:
        ab = _orb6(wds_id="X", components="AB", hip=1)
        ac = _orb6(wds_id="X", components="AC", hip=2)
        sys = _orb6(wds_id="X", components="", hip=3)
        grouped = bb.group_orb6_by_pair([ab, ac, sys])
        self.assertEqual(grouped[("X", "AB")], [ab])
        self.assertEqual(grouped[("X", "AC")], [ac])
        self.assertEqual(grouped[("X", "")], [sys])


class ResolveAllPairsTests(unittest.TestCase):
    def test_pipeline_emits_primary_and_secondary(self) -> None:
        # Primary resolves via ORB6's HIP; secondary has no HIP signal
        # and falls through to ``unresolved`` (the SIMBAD-backed tier
        # 2 supplement, dch.60, would pick this case up later).
        pair = _wds_pair(components="AB")
        orb6 = [_orb6(wds_id=pair.wds_id, components="AB", hip=1)]
        idx = _indices(hip_to_gaia={1: 1001})
        results = bb.resolve_all_pairs(
            pairs=[pair], orb6=orb6, indices=idx, athyg=[],
        )
        self.assertEqual(len(results), 2)
        primary, secondary = results
        self.assertTrue(primary.is_primary)
        self.assertEqual(primary.resolve_via, "orb6_hip")
        self.assertEqual(primary.gaia_source_id, 1001)
        self.assertFalse(secondary.is_primary)
        self.assertEqual(secondary.resolve_via, "unresolved")
        self.assertIsNone(secondary.gaia_source_id)

    def test_skips_system_level_rows(self) -> None:
        pair = _wds_pair(components="")
        idx = _indices()
        results = bb.resolve_all_pairs(
            pairs=[pair], orb6=[], indices=idx, athyg=[],
        )
        self.assertEqual(results, [])


def _wds_pair_with_pos(
    *, wds_id: str = "14296-6241", components: str = "Ca,Cb",
    precise_ra: float | None = None, precise_dec: float | None = None,
    rho: float | None = None, theta: float | None = None,
) -> "bb.WdsPair":
    return bb.WdsPair(
        wds_id=wds_id, discoverer="TST   1", components=components,
        date_last=None, rho_last=rho, theta_last=theta,
        mag_pri=None, mag_sec=None, spectral="", notes="    ",
        precise_ra_deg=precise_ra, precise_dec_deg=precise_dec,
    )


def _athyg_row_at(
    *, ra: float, dec: float, gaia: int | None,
) -> "bb.AthygRow":
    return bb.AthygRow(
        hip=None, tyc=None, gaia=gaia, hd=None,
        ra_deg=ra, dec_deg=dec,
        x_pc=0.0, y_pc=0.0, z_pc=0.0,
        dist_pc=1.0, v_mag=None, absmag=5.0,
        ci=None, spect="", proper="",
    )


class PositionGeometryTests(unittest.TestCase):
    def test_predict_secondary_due_north(self) -> None:
        # ρ = 3600″ = 1°, θ = 0° → secondary is 1° north of primary.
        ra, dec = bb.predict_secondary_position(
            primary_ra_deg=100.0, primary_dec_deg=0.0,
            rho_arcsec=3600.0, theta_deg=0.0,
        )
        self.assertAlmostEqual(ra, 100.0, places=6)
        self.assertAlmostEqual(dec, 1.0, places=6)

    def test_predict_secondary_due_east(self) -> None:
        # θ = 90° (east), at dec=60° → ra offset is 1°/cos(60°) = 2°.
        ra, dec = bb.predict_secondary_position(
            primary_ra_deg=100.0, primary_dec_deg=60.0,
            rho_arcsec=3600.0, theta_deg=90.0,
        )
        self.assertAlmostEqual(ra, 102.0, places=3)
        self.assertAlmostEqual(dec, 60.0, places=6)


class PositionMatchTests(unittest.TestCase):
    def test_within_tolerance_matches(self) -> None:
        athyg = [_athyg_row_at(ra=100.0, dec=20.0, gaia=42)]
        grid = bb.build_athyg_position_grid(athyg)
        # Query 1″ east of target (≈ 0.000297° at dec=20°). Inside 2″ tol.
        idx = bb.find_nearest_athyg_at_position(
            ra_deg=100.0 + 1.0 / 3600.0 / math.cos(math.radians(20.0)),
            dec_deg=20.0,
            grid=grid, athyg=athyg, tol_arcsec=2.0,
        )
        self.assertEqual(idx, 0)

    def test_outside_tolerance_misses(self) -> None:
        athyg = [_athyg_row_at(ra=100.0, dec=20.0, gaia=42)]
        grid = bb.build_athyg_position_grid(athyg)
        # 5″ east of target — outside 2″ tolerance.
        idx = bb.find_nearest_athyg_at_position(
            ra_deg=100.0 + 5.0 / 3600.0 / math.cos(math.radians(20.0)),
            dec_deg=20.0,
            grid=grid, athyg=athyg, tol_arcsec=2.0,
        )
        self.assertIsNone(idx)

    def test_exclude_idx_skips_known_row(self) -> None:
        # Two AT-HYG rows, both within tolerance — exclude_idx forces
        # the secondary slot to find the OTHER one.
        athyg = [
            _athyg_row_at(ra=100.0, dec=0.0, gaia=10),
            _athyg_row_at(ra=100.0 + 0.0002, dec=0.0, gaia=20),
        ]
        grid = bb.build_athyg_position_grid(athyg)
        idx = bb.find_nearest_athyg_at_position(
            ra_deg=100.0, dec_deg=0.0,
            grid=grid, athyg=athyg, tol_arcsec=2.0,
            exclude_idx=0,
        )
        self.assertEqual(idx, 1)


class ResolveViaPositionTests(unittest.TestCase):
    def test_primary_matches_athyg_when_no_hip_signal(self) -> None:
        pair = _wds_pair_with_pos(
            components="Ca,Cb",
            precise_ra=217.4296, precise_dec=-62.6795,
        )
        # AT-HYG row at the same coordinates with a gaia value.
        athyg = [_athyg_row_at(ra=217.4296, dec=-62.6795, gaia=5853498713190525696)]
        # No HIP signals; tier 1/2/3-by-id all return unresolved.
        components = [
            bb.ResolvedComponent(
                wds_id=pair.wds_id, discoverer=pair.discoverer,
                component="Ca", is_primary=True,
                gaia_source_id=None, resolve_via="unresolved",
            ),
        ]
        bb.resolve_via_position(
            components=components, pairs=[pair], athyg=athyg,
            tolerance_arcsec=2.0,
        )
        self.assertEqual(components[0].resolve_via, "athyg_gaia_native")
        self.assertEqual(components[0].gaia_source_id, 5853498713190525696)

    def test_secondary_resolves_via_predicted_position(self) -> None:
        pair = _wds_pair_with_pos(
            components="AB",
            precise_ra=100.0, precise_dec=0.0,
            rho=3600.0, theta=0.0,    # secondary 1° north of primary
        )
        athyg = [
            _athyg_row_at(ra=100.0, dec=0.0, gaia=111),       # primary
            _athyg_row_at(ra=100.0, dec=1.0, gaia=222),       # secondary
        ]
        components = [
            bb.ResolvedComponent(
                wds_id=pair.wds_id, discoverer=pair.discoverer,
                component="A", is_primary=True,
                gaia_source_id=None, resolve_via="unresolved",
            ),
            bb.ResolvedComponent(
                wds_id=pair.wds_id, discoverer=pair.discoverer,
                component="B", is_primary=False,
                gaia_source_id=None, resolve_via="unresolved",
            ),
        ]
        bb.resolve_via_position(
            components=components, pairs=[pair], athyg=athyg,
            tolerance_arcsec=2.0,
        )
        self.assertEqual(components[0].gaia_source_id, 111)
        self.assertEqual(components[1].gaia_source_id, 222)
        self.assertEqual(components[1].resolve_via, "athyg_gaia_native")

    def test_skips_resolved_components(self) -> None:
        pair = _wds_pair_with_pos(
            components="AB",
            precise_ra=100.0, precise_dec=0.0,
        )
        athyg = [_athyg_row_at(ra=100.0, dec=0.0, gaia=999)]
        # Component already resolved via tier 1; position pass must leave it.
        c = bb.ResolvedComponent(
            wds_id=pair.wds_id, discoverer=pair.discoverer,
            component="A", is_primary=True,
            gaia_source_id=100, resolve_via="orb6_hip",
        )
        bb.resolve_via_position([c], pairs=[pair], athyg=athyg)
        self.assertEqual(c.resolve_via, "orb6_hip")
        self.assertEqual(c.gaia_source_id, 100)

    def test_skips_when_athyg_row_has_no_gaia(self) -> None:
        # The matched AT-HYG row exists but its gaia field is empty —
        # tier 3 must not invent a value; component stays unresolved.
        pair = _wds_pair_with_pos(
            components="AB",
            precise_ra=100.0, precise_dec=0.0,
        )
        athyg = [_athyg_row_at(ra=100.0, dec=0.0, gaia=None)]
        c = bb.ResolvedComponent(
            wds_id=pair.wds_id, discoverer=pair.discoverer,
            component="A", is_primary=True,
            gaia_source_id=None, resolve_via="unresolved",
        )
        bb.resolve_via_position([c], pairs=[pair], athyg=athyg)
        self.assertEqual(c.resolve_via, "unresolved")
        self.assertIsNone(c.gaia_source_id)


class PropagateWithinSystemTests(unittest.TestCase):
    def test_inherits_letter_binding_across_pairs(self) -> None:
        # Component "A" of system X resolved in pair "AB". The same
        # letter as primary of pair "AC" must inherit the binding.
        ab_a = bb.ResolvedComponent(
            wds_id="X", discoverer="DA", component="A", is_primary=True,
            gaia_source_id=42, resolve_via="orb6_hip",
        )
        ac_a = bb.ResolvedComponent(
            wds_id="X", discoverer="DA", component="A", is_primary=True,
            gaia_source_id=None, resolve_via="unresolved",
        )
        ac_c = bb.ResolvedComponent(
            wds_id="X", discoverer="DA", component="C", is_primary=False,
            gaia_source_id=None, resolve_via="unresolved",
        )
        components = [ab_a, ac_a, ac_c]
        bb.propagate_within_system(components)
        self.assertEqual(ac_a.gaia_source_id, 42)
        self.assertEqual(ac_a.resolve_via, "orb6_hip")
        # Unrelated letter "C" must stay unresolved.
        self.assertIsNone(ac_c.gaia_source_id)

    def test_does_not_cross_systems(self) -> None:
        # Same letter "A" but different wds_id → no propagation.
        x_a = bb.ResolvedComponent(
            wds_id="X", discoverer="D", component="A", is_primary=True,
            gaia_source_id=100, resolve_via="orb6_hip",
        )
        y_a = bb.ResolvedComponent(
            wds_id="Y", discoverer="D", component="A", is_primary=True,
            gaia_source_id=None, resolve_via="unresolved",
        )
        bb.propagate_within_system([x_a, y_a])
        self.assertIsNone(y_a.gaia_source_id)


class ResolutionCountsTests(unittest.TestCase):
    def test_every_canonical_key_present(self) -> None:
        comps = [
            bb.ResolvedComponent(
                wds_id="X", discoverer="D", component="A", is_primary=True,
                gaia_source_id=1, resolve_via="orb6_hip",
            ),
            bb.ResolvedComponent(
                wds_id="X", discoverer="D", component="B", is_primary=False,
                gaia_source_id=None, resolve_via="unresolved",
            ),
        ]
        counts = bb.resolution_counts(comps)
        # All keys present (zeros for absent strategies), totals match.
        self.assertEqual(set(counts.keys()), set(bb.RESOLVE_VIA_VALUES))
        self.assertEqual(counts["orb6_hip"], 1)
        self.assertEqual(counts["unresolved"], 1)
        self.assertEqual(counts["position_pm"], 0)


class AstrometryRequestTests(unittest.TestCase):
    def test_dedupes_and_skips_unresolved(self) -> None:
        comps = [
            bb.ResolvedComponent(
                wds_id="X", discoverer="D", component="A", is_primary=True,
                gaia_source_id=222, resolve_via="orb6_hip",
            ),
            bb.ResolvedComponent(
                wds_id="X", discoverer="D", component="B", is_primary=False,
                gaia_source_id=111, resolve_via="athyg_gaia_native",
            ),
            bb.ResolvedComponent(
                wds_id="Y", discoverer="D", component="A", is_primary=True,
                gaia_source_id=222, resolve_via="athyg_gaia_native",
            ),
            bb.ResolvedComponent(
                wds_id="Z", discoverer="D", component="A", is_primary=True,
                gaia_source_id=None, resolve_via="unresolved",
            ),
        ]
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "request.tsv"
            n = bb.write_astrometry_request(comps, p)
            body = p.read_text().splitlines()
        self.assertEqual(n, 2)
        # Header + sorted unique ids; unresolved row contributes nothing.
        self.assertEqual(body, ["gaia_source_id", "111", "222"])


class BuildIndicesTests(unittest.TestCase):
    def _row(
        self, *, hip: int | None = None,
        tyc: str | None = None, gaia: int | None = None,
    ) -> "bb.AthygRow":
        return bb.AthygRow(
            hip=hip, tyc=tyc, gaia=gaia, hd=None,
            ra_deg=0.0, dec_deg=0.0,
            x_pc=0.0, y_pc=0.0, z_pc=0.0,
            dist_pc=1.0, v_mag=None, absmag=5.0,
            ci=None, spect="", proper="",
        )

    def test_three_athyg_views(self) -> None:
        athyg = [
            self._row(hip=1, tyc="100-1-1", gaia=111),
            self._row(hip=2, tyc=None, gaia=222),
            self._row(hip=None, tyc="200-2-1", gaia=None),
        ]
        idx = bb.build_indices(
            athyg=athyg, hip2=[],
            hip_to_gaia={1: 999}, tyc_to_gaia={"100-1-1": 998},
            src_to_nss={111: {"period": "10.0"}},
        )
        self.assertEqual(set(idx.hip_to_athyg.keys()), {1, 2})
        self.assertEqual(set(idx.tyc_to_athyg.keys()), {"100-1-1", "200-2-1"})
        self.assertEqual(set(idx.src_to_athyg.keys()), {111, 222})
        self.assertEqual(idx.hip_to_gaia, {1: 999})
        self.assertEqual(idx.tyc_to_gaia, {"100-1-1": 998})
        self.assertEqual(idx.src_to_nss[111]["period"], "10.0")
        # Astrometry index intentionally empty at Stage 1.
        self.assertEqual(idx.src_to_astrometry, {})


if __name__ == "__main__":
    unittest.main()
