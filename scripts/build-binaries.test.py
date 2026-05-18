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


class WdsNotesTests(unittest.TestCase):
    def test_harvests_hip_tokens(self) -> None:
        body = (
            "<header\n"
            "USNO header line\n"
            "00006-5306 HJ 5437        Companion B is HIP 12345.\n"
            "                          Continuation mentioning HIP 67890.\n"
            "00010+1234 OTHER          No HIPs here.\n"
        )
        with tempfile.TemporaryDirectory() as td:
            p = _write(Path(td), "notes.txt", body)
            notes = bb.parse_wds_notes(p)
        self.assertEqual(set(notes.keys()), {"00006-5306"})
        self.assertEqual(notes["00006-5306"], [12345, 67890])


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
