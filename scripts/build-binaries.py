#!/usr/bin/env python3
"""Catalogue builder for the source-ID-anchored binary-system pipeline — Stages 1-2.

Stage 1 (``stellata-dch.27``) loads every reference catalog the resolution
chain needs (WDS + ORB6 + AT-HYG + GCVS + CCDM + HIP2 + Gaia HIP/Tyc
cross-walks + Gaia NSS + optionally Gaia 5p astrometry) and builds the
identifier indices that Stages 2-7 consume.

Stage 2 (``stellata-dch.28``) resolves each WDS component to a Gaia DR3
``source_id`` via a four-tier priority chain: ORB6's published HIP,
AT-HYG's natively-stored ``gaia`` field reached either through a HIP or
via a 2″ position match against the WDS precise coordinates, then PM-
propagated and bare position match against ``data/gaia_dr3_astrometry.tsv``
(the latter two stubbed until ``stellata-dch.29`` lands the astrometry
table). A SIMBAD-backed supplement for the residual set is tracked in
``stellata-dch.60`` and lands after the position-match tiers.

Stage 2 emits two side effects:

* ``data/gaia_astrometry_source_id_request.tsv`` — the deduped union of
  source_ids resolved in tiers 1-2, which ``stellata-dch.29`` reads to
  drive its ADQL query.
* Build log lines per tier so coverage drift is visible at every run.

The final ``data/multiples.tsv`` is produced by Stage 6
(``stellata-dch.32``). Until Stages 3-7 land this script remains a
load-and-resolve-and-report harness.

Run via ``npm run build:binaries`` (or directly: ``python3
scripts/build-binaries.py``). Idempotent against ``data/multiples.tsv``;
pass ``--force`` to ignore the mtime check and reload everything.

See the parent epic ``stellata-dch`` for the seven-stage architecture.
"""

from __future__ import annotations

import argparse
import csv
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SCRIPT = Path(__file__).resolve()

sys.path.insert(0, str(SCRIPT.parent))
from refresh_lib import is_up_to_date  # noqa: E402

SRC_WDS_SUMM = DATA / "wds_summ.txt"
SRC_ORB6 = DATA / "orb6_orbits.txt"
SRC_ATHYG = DATA / "athyg_33_classic_ids.csv"
SRC_GCVS = DATA / "gcvs5.txt"
SRC_GCVS_CROSSID = DATA / "crossid.txt"
SRC_CCDM = DATA / "hip_ccdm.tsv"
SRC_HIP2 = DATA / "hip2_van_leeuwen.tsv"
SRC_GAIA_HIP_XM = DATA / "gaia_dr3_hip_xmatch.tsv"
SRC_GAIA_TYC_XM = DATA / "gaia_dr3_tyc_xmatch.tsv"
SRC_GAIA_NSS = DATA / "gaia_dr3_nss_two_body.tsv"
SRC_GAIA_ASTROMETRY = DATA / "gaia_dr3_astrometry.tsv"  # lands with dch.29

OUT_MULTIPLES = DATA / "multiples.tsv"
OUT_ASTROMETRY_REQUEST = DATA / "gaia_astrometry_source_id_request.tsv"

# Expected fraction of AT-HYG rows that carry a Gaia DR3 source_id. AT-HYG
# documentation reports ~98% coverage (the remainder are bright stars Gaia
# saturated or systems Gaia could not detect). Coverage outside this band
# signals an input drift worth flagging at build time.
ATHYG_GAIA_COVERAGE_BOUNDS = (0.90, 1.00)

# Strict priority order Stage 2 attempts for every WDS component. The
# log line and unit tests both read from this tuple so adding a tier or
# renaming one only edits the canonical list. Order is significant —
# earlier strategies win when more than one would succeed.
RESOLVE_VIA_VALUES: tuple[str, ...] = (
    "orb6_hip",
    "athyg_gaia_native",
    "position_pm",
    "position_nopm",
    "unresolved",
)

# ─── Parsing primitives ──────────────────────────────────────────────


def safe_float(s: str) -> float | None:
    s = s.strip()
    if not s or s == ".":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def safe_int(s: str) -> int | None:
    s = s.strip()
    if not s or s == ".":
        return None
    try:
        return int(s)
    except ValueError:
        return None


# ─── AT-HYG ──────────────────────────────────────────────────────────


@dataclass
class AthygRow:
    """Subset of the AT-HYG v3.3 classic-IDs CSV the binary pipeline reads.

    All three classical identifiers are surfaced — ``hip``, ``tyc``,
    ``gaia`` — so Stage 2 can resolve a WDS / GCVS component through any
    available channel before falling back to position-match.
    """

    hip: int | None
    tyc: str | None       # Tycho-2 designation, e.g. "4669-731-1"
    gaia: int | None      # Gaia DR3 source_id
    hd: int | None
    ra_deg: float
    dec_deg: float
    x_pc: float
    y_pc: float
    z_pc: float
    dist_pc: float
    v_mag: float | None
    absmag: float
    ci: float | None
    spect: str
    proper: str


def parse_athyg(path: Path) -> list[AthygRow]:
    rows: list[AthygRow] = []
    with path.open(newline="") as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            try:
                ra_h = float(r["ra"])     # AT-HYG stores RA in hours
                dec_d = float(r["dec"])
                x = float(r["x0"])
                y = float(r["y0"])
                z = float(r["z0"])
                dist = float(r["dist"])
            except (KeyError, ValueError):
                continue
            absmag = safe_float(r.get("absmag") or "")
            if absmag is None:
                continue
            tyc = (r.get("tyc") or "").strip() or None
            rows.append(AthygRow(
                hip=safe_int(r.get("hip") or ""),
                tyc=tyc,
                gaia=safe_int(r.get("gaia") or ""),
                hd=safe_int(r.get("hd") or ""),
                ra_deg=ra_h * 15.0,
                dec_deg=dec_d,
                x_pc=x, y_pc=y, z_pc=z,
                dist_pc=dist,
                v_mag=safe_float(r.get("mag") or ""),
                absmag=absmag,
                ci=safe_float(r.get("ci") or ""),
                spect=(r.get("spect") or "").strip(),
                proper=(r.get("proper") or "").strip(),
            ))
    return rows


# ─── WDS summary ─────────────────────────────────────────────────────


@dataclass
class WdsPair:
    wds_id: str           # "HHMMm±DDMM" 10-char positional anchor
    discoverer: str       # e.g. "STF  202", "BU  860"
    components: str       # e.g. "AB", "AC", "Aa,Ab"; "" for the system-level row
    date_last: int | None
    rho_last: float | None       # arcsec
    theta_last: float | None     # degrees east of north
    mag_pri: float | None
    mag_sec: float | None
    spectral: str
    notes: str            # 4-char flag block (cols 107-110)
    precise_ra_deg: float | None
    precise_dec_deg: float | None


_WDS_HEADER_RE = re.compile(r"^[A-Za-z<]")


def _parse_wds_precise_coord(s: str) -> tuple[float, float] | None:
    """``HHMMSS.SS[+-]DDMMSS.S`` (cols 113-130) → (RA°, Dec°)."""
    s = s.strip()
    if len(s) < 17:
        return None
    try:
        ra_h = int(s[0:2])
        ra_m = int(s[2:4])
        ra_s = float(s[4:9])
        sign = -1 if s[9] == "-" else 1
        dec_d = int(s[10:12])
        dec_m = int(s[12:14])
        dec_s = float(s[14:])
    except (ValueError, IndexError):
        return None
    ra_deg = (ra_h + ra_m / 60.0 + ra_s / 3600.0) * 15.0
    dec_deg = sign * (dec_d + dec_m / 60.0 + dec_s / 3600.0)
    return ra_deg, dec_deg


def parse_wds_summ(path: Path) -> list[WdsPair]:
    pairs: list[WdsPair] = []
    with path.open(errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\r\n")
            if not line or len(line) < 22 or _WDS_HEADER_RE.match(line):
                continue
            try:
                int(line[0:5])    # WDS rows always start HHMMm — 5 digits
            except ValueError:
                continue
            wds_id = line[0:10].strip()
            discoverer = line[10:17].strip()
            if not wds_id or not discoverer:
                continue
            line = line.ljust(130)
            precise = _parse_wds_precise_coord(line[112:130])
            pairs.append(WdsPair(
                wds_id=wds_id,
                discoverer=discoverer,
                components=line[17:22].strip(),
                date_last=safe_int(line[28:32]),
                theta_last=safe_float(line[42:45]),
                rho_last=safe_float(line[52:57]),
                mag_pri=safe_float(line[58:63]),
                mag_sec=safe_float(line[64:69]),
                spectral=line[70:79].strip(),
                notes=line[107:111],
                precise_ra_deg=precise[0] if precise else None,
                precise_dec_deg=precise[1] if precise else None,
            ))
    return pairs


# ─── ORB6 ────────────────────────────────────────────────────────────


@dataclass
class Orb6Entry:
    """Sixth Catalog of Orbits row. Unit columns are kept verbatim — Stage 4
    (orbit picking) normalises them to canonical units (yr, arcsec, JD)."""

    wds_id: str
    discoverer: str
    components: str
    hd: int | None
    hip: int | None
    P_val: float | None     # period
    P_unit: str
    a_val: float | None     # semi-major axis
    a_unit: str
    i_deg: float | None
    Omega_deg: float | None
    omega_deg: float | None
    e: float | None
    T0_val: float | None
    T0_unit: str
    grade: int              # 1=definitive..5=indeterminate; 8/9 are spectroscopic/astrometric
    ref: str


_ORB6_COMPONENTS_RE = re.compile(r"([A-Za-z][A-Za-z\d,\-]*)$")


def parse_orb6(path: Path) -> list[Orb6Entry]:
    """Returns one entry per orbit row. Multiple fits per system are
    possible (different grades / refs); Stage 4 tie-breaks."""
    out: list[Orb6Entry] = []
    with path.open(errors="replace") as fh:
        for raw in fh:
            line = raw.rstrip("\r\n")
            if not line or len(line) < 30:
                continue
            head = line[0:9].strip()
            if not head or not head[0].isdigit():
                continue       # title + numeric-ruler banner lines (1-4)
            line = line.ljust(264)
            wds_id = line[19:29].strip()
            if not wds_id:
                continue
            disc_field = line[30:44]
            # Component designator (Aa,Ab / AB / B,C) is appended to the
            # discoverer field for some rows but absent for the majority.
            # Stage 4 orbit-picking treats the empty string as "system-
            # level / pair-default"; do not skip these rows at load time.
            m = _ORB6_COMPONENTS_RE.search(disc_field.rstrip())
            components = m.group(1) if m else ""
            grade_str = line[233:234].strip()
            out.append(Orb6Entry(
                wds_id=wds_id,
                discoverer=disc_field.strip(),
                components=components,
                hd=safe_int(line[51:57]),
                hip=safe_int(line[58:64]),
                P_val=safe_float(line[81:92]),
                P_unit=line[92:93].strip(),
                a_val=safe_float(line[105:114]),
                a_unit=line[114:115].strip(),
                i_deg=safe_float(line[125:133]),
                Omega_deg=safe_float(line[143:151]),
                omega_deg=safe_float(line[205:213]),
                e=safe_float(line[187:195]),
                T0_val=safe_float(line[162:174]),
                T0_unit=line[174:175].strip(),
                grade=int(grade_str) if grade_str.isdigit() else 5,
                ref=line[237:245].strip(),
            ))
    return out


# ─── GCVS ────────────────────────────────────────────────────────────


@dataclass
class GcvsRow:
    """One row of ``gcvs5.txt`` (main variable-star catalog).

    Only the fields Stage 5 (intrinsic-variability cross-match) actually
    needs are pinned here; type / period / amplitude parsing live in
    ``scripts/catalog-pure.ts`` for the TS-side consumer and need not be
    duplicated for Stage 1's load-and-count.
    """

    gcvs_id: str
    designation: str
    var_type: str
    max_mag: str        # raw string; uncertainty markers stripped at use-site
    min_mag: str


def parse_gcvs(path: Path) -> list[GcvsRow]:
    """Pipe-delimited records, skip VizieR header (`#...`) + sep/dash rows."""
    rows: list[GcvsRow] = []
    with path.open(errors="replace") as fh:
        for line in fh:
            if not line or line.startswith("#") or line.startswith("---"):
                continue
            parts = line.split("|")
            if len(parts) < 6:
                continue
            gcvs_id = parts[0].strip()
            if not gcvs_id.isdigit():
                continue
            rows.append(GcvsRow(
                gcvs_id=gcvs_id,
                designation=parts[1].strip(),
                var_type=parts[3].strip(),
                max_mag=parts[4].strip(),
                min_mag=parts[5].strip(),
            ))
    return rows


def parse_gcvs_crossid(path: Path) -> dict[str, list[str]]:
    """``crossid.txt`` → ``{gcvs_designation: [external IDs]}``.

    External IDs are the second pipe field; their format is heterogeneous
    (HIP / HD / Tycho / ADS / Stellarium etc.). Stage 5 parses out the HIP
    tokens when cross-matching GCVS rows to AT-HYG / Gaia.
    """
    out: dict[str, list[str]] = {}
    with path.open(errors="replace") as fh:
        for line in fh:
            if not line or line.startswith("#") or line.startswith("---"):
                continue
            if not line.startswith("GCVS"):
                continue
            parts = line.split("|")
            if len(parts) < 2:
                continue
            designation = parts[0][4:].strip()
            ext_id = parts[1].strip().lstrip("=").strip()
            if not designation or not ext_id:
                continue
            out.setdefault(designation, []).append(ext_id)
    return out


# ─── CCDM ────────────────────────────────────────────────────────────


@dataclass
class CcdmRow:
    hip: int
    ccdm: str           # may be empty for non-multiple systems
    mult_flag: str      # blank / "O" / etc. — see Hipparcos doc


def parse_ccdm(path: Path) -> list[CcdmRow]:
    """``hip_ccdm.tsv`` (VizieR): TSV with `#` comment lines, then a three-
    line header (column names, separator spec, dashes) before the data."""
    rows: list[CcdmRow] = []
    with path.open() as fh:
        in_data = False
        for line in fh:
            if not line or line.startswith("#"):
                continue
            stripped = line.rstrip("\n")
            if not in_data:
                # Sentinel: the first row that starts with ``------`` is the
                # dash separator immediately preceding the data.
                if stripped.startswith("------"):
                    in_data = True
                continue
            parts = stripped.split("\t")
            if len(parts) < 1:
                continue
            hip = safe_int(parts[0])
            if hip is None:
                continue
            rows.append(CcdmRow(
                hip=hip,
                ccdm=(parts[1].strip() if len(parts) > 1 else ""),
                mult_flag=(parts[2].strip() if len(parts) > 2 else ""),
            ))
    return rows


# ─── HIP2 van Leeuwen ────────────────────────────────────────────────


@dataclass
class Hip2Row:
    hip: int
    ra_deg: float
    dec_deg: float
    plx_mas: float | None
    e_plx_mas: float | None
    pm_ra_masyr: float | None
    pm_de_masyr: float | None
    e_pm_ra_masyr: float | None
    e_pm_de_masyr: float | None
    goodness_of_fit: float | None
    n_transits: int | None


def parse_hip2(path: Path) -> list[Hip2Row]:
    rows: list[Hip2Row] = []
    with path.open(newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        for r in reader:
            hip = safe_int(r.get("hip") or "")
            try:
                ra = float(r["ra_icrs"])
                dec = float(r["de_icrs"])
            except (KeyError, ValueError):
                continue
            if hip is None:
                continue
            rows.append(Hip2Row(
                hip=hip,
                ra_deg=ra,
                dec_deg=dec,
                plx_mas=safe_float(r.get("plx") or ""),
                e_plx_mas=safe_float(r.get("e_plx") or ""),
                pm_ra_masyr=safe_float(r.get("pm_ra") or ""),
                pm_de_masyr=safe_float(r.get("pm_de") or ""),
                e_pm_ra_masyr=safe_float(r.get("e_pm_ra") or ""),
                e_pm_de_masyr=safe_float(r.get("e_pm_de") or ""),
                goodness_of_fit=safe_float(r.get("goodness_of_fit") or ""),
                n_transits=safe_int(r.get("n_transits") or ""),
            ))
    return rows


# ─── Gaia DR3 cross-walks ────────────────────────────────────────────


def parse_gaia_hip_xmatch(path: Path) -> dict[int, int]:
    """Returns ``hip -> gaia_source_id``. Many-to-one collisions keep the
    nearest match (lowest ``angular_distance``)."""
    by_hip: dict[int, tuple[float, int]] = {}
    with path.open(newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        for r in reader:
            hip = safe_int(r.get("hip") or "")
            src = safe_int(r.get("gaia_source_id") or "")
            ang = safe_float(r.get("angular_distance") or "") or 0.0
            if hip is None or src is None:
                continue
            best = by_hip.get(hip)
            if best is None or ang < best[0]:
                by_hip[hip] = (ang, src)
    return {hip: src for hip, (_, src) in by_hip.items()}


def parse_gaia_tyc_xmatch(path: Path) -> dict[str, int]:
    """Returns ``tyc -> gaia_source_id`` (nearest match per Tycho ID)."""
    by_tyc: dict[str, tuple[float, int]] = {}
    with path.open(newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        for r in reader:
            tyc = (r.get("tyc") or "").strip()
            src = safe_int(r.get("gaia_source_id") or "")
            ang = safe_float(r.get("angular_distance") or "") or 0.0
            if not tyc or src is None:
                continue
            best = by_tyc.get(tyc)
            if best is None or ang < best[0]:
                by_tyc[tyc] = (ang, src)
    return {tyc: src for tyc, (_, src) in by_tyc.items()}


def parse_gaia_nss(path: Path) -> dict[int, dict[str, str]]:
    """Returns ``source_id -> NSS two-body row`` (raw dict per record).
    Schema is wide (28 columns) and Stage 4 reads only the orbital subset;
    handing back the raw row keeps Stage 1 schema-agnostic.
    """
    by_src: dict[int, dict[str, str]] = {}
    with path.open(newline="") as fh:
        reader = csv.DictReader(fh, delimiter="\t")
        for r in reader:
            src = safe_int(r.get("source_id") or "")
            if src is None:
                continue
            by_src[src] = dict(r)
    return by_src


# ─── Identifier indices ──────────────────────────────────────────────


@dataclass
class IdentifierIndices:
    """Output of Stage 1. Every Stage 2-7 lookup goes through these maps
    so the resolution chain stays cone-match-free for stars carrying a
    classical identifier."""

    hip_to_gaia: dict[int, int]
    tyc_to_gaia: dict[str, int]
    src_to_nss: dict[int, dict[str, str]]
    src_to_astrometry: dict[int, dict[str, str]]   # empty pre-Stage-2-I (dch.29)
    hip_to_athyg: dict[int, AthygRow]
    tyc_to_athyg: dict[str, AthygRow]
    src_to_athyg: dict[int, AthygRow]
    hip_to_hip2: dict[int, Hip2Row]


def build_indices(
    athyg: list[AthygRow],
    hip2: list[Hip2Row],
    hip_to_gaia: dict[int, int],
    tyc_to_gaia: dict[str, int],
    src_to_nss: dict[int, dict[str, str]],
) -> IdentifierIndices:
    hip_to_athyg: dict[int, AthygRow] = {}
    tyc_to_athyg: dict[str, AthygRow] = {}
    src_to_athyg: dict[int, AthygRow] = {}
    for row in athyg:
        if row.hip is not None:
            hip_to_athyg[row.hip] = row
        if row.tyc is not None:
            tyc_to_athyg[row.tyc] = row
        if row.gaia is not None:
            src_to_athyg[row.gaia] = row
    hip_to_hip2: dict[int, Hip2Row] = {row.hip: row for row in hip2}
    return IdentifierIndices(
        hip_to_gaia=hip_to_gaia,
        tyc_to_gaia=tyc_to_gaia,
        src_to_nss=src_to_nss,
        src_to_astrometry={},
        hip_to_athyg=hip_to_athyg,
        tyc_to_athyg=tyc_to_athyg,
        src_to_athyg=src_to_athyg,
        hip_to_hip2=hip_to_hip2,
    )


# ─── Stage 2: WDS-component → gaia_source_id resolution ─────────────


@dataclass
class ResolvedComponent:
    """One row of Stage 2's output. ``gaia_source_id`` is ``None`` only
    when ``resolve_via == 'unresolved'``."""

    wds_id: str
    discoverer: str
    component: str            # e.g. 'A', 'B', 'Aa', 'Ab'
    is_primary: bool
    gaia_source_id: int | None
    resolve_via: str


def split_components(comp_str: str) -> tuple[str, str] | None:
    """Decompose a WDS ``components`` field into (primary, secondary).

    Returns ``None`` for system-level rows (empty field) and for rows we
    cannot confidently split. Stage 2 treats ``None`` as "skip this pair"
    rather than guessing.

    The WDS convention is:

    * ``"AB"``  → ("A", "B")
    * ``"Aa,Ab"`` → ("Aa", "Ab")  — comma separates multi-character labels
    * ``"BC,D"`` → ("BC", "D")    — first part can be multi-letter

    Three-letter unbraced forms like ``"ABC"`` are ambiguous (could mean
    A vs BC, or AB vs C) and are skipped rather than partitioned wrong.
    """
    s = comp_str.strip()
    if not s:
        return None
    if "," in s:
        parts = [p.strip() for p in s.split(",") if p.strip()]
        if len(parts) == 2:
            return parts[0], parts[1]
        return None
    if len(s) == 2:
        return s[0], s[1]
    return None


def group_orb6_by_pair(
    orb6: list[Orb6Entry],
) -> dict[tuple[str, str], list[Orb6Entry]]:
    """Index ORB6 entries by ``(wds_id, components)`` so Stage 2 can fetch
    every fit for a given WDS pair in O(1).

    Components-string match is strict: ``"AB"`` and ``""`` (system-level)
    are different keys. Stage 2 only consults the entry whose components
    string exactly matches the pair it is resolving — using a system-level
    ORB6 HIP for an ``"AC"`` pair would attribute the primary's gaia
    source to the wrong component when multiple orbit fits coexist.
    """
    out: dict[tuple[str, str], list[Orb6Entry]] = {}
    for e in orb6:
        out.setdefault((e.wds_id, e.components), []).append(e)
    return out


def _gaia_from_athyg_via_hip(
    hip: int, indices: IdentifierIndices,
) -> int | None:
    """Tier 2 (HIP branch) lookup. AT-HYG's gaia field (~98% coverage)
    is broader than Gaia's HIP cross-walk because AT-HYG ingests
    source_ids through its own pipeline. When a HIP exists but Gaia's
    published xwalk misses it, AT-HYG often still carries a gaia
    value."""
    row = indices.hip_to_athyg.get(hip)
    if row is None or row.gaia is None:
        return None
    return row.gaia


def resolve_component(
    pair: WdsPair,
    component: str,
    is_primary: bool,
    orb6_for_pair: list[Orb6Entry],
    indices: IdentifierIndices,
) -> ResolvedComponent:
    """Resolve a single WDS component to a Gaia DR3 source_id via the
    identifier-anchored tiers 1-2 (ORB6's HIP → Gaia xwalk, then
    AT-HYG's natively-stored ``gaia`` for the same HIP). Returns an
    ``unresolved`` record when neither tier fires; the position-match
    pass in ``resolve_via_position`` then takes a second swing, and
    tiers 3-4 (against ``data/gaia_dr3_astrometry.tsv``) are stubbed
    until ``stellata-dch.29`` lands.

    Secondary components have no direct ORB6 signal (ORB6 publishes one
    HIP per orbit row, which by convention is the primary's), so tier 1
    only applies to primaries. A SIMBAD-backed supplement for the
    residual set is tracked in ``stellata-dch.60``.
    """
    def emit(gaia: int | None, via: str) -> ResolvedComponent:
        return ResolvedComponent(
            wds_id=pair.wds_id,
            discoverer=pair.discoverer,
            component=component,
            is_primary=is_primary,
            gaia_source_id=gaia,
            resolve_via=via,
        )

    candidate_hips: list[int] = []

    if is_primary:
        for e in orb6_for_pair:
            if e.hip is None:
                continue
            candidate_hips.append(e.hip)
            # Tier 1: Gaia-published HIP xwalk is the canonical source.
            gaia = indices.hip_to_gaia.get(e.hip)
            if gaia is not None:
                return emit(gaia, "orb6_hip")

    for hip in candidate_hips:
        gaia = _gaia_from_athyg_via_hip(hip, indices)
        if gaia is not None:
            return emit(gaia, "athyg_gaia_native")

    return emit(None, "unresolved")


# ─── Tier 2 position-match path ──────────────────────────────────────


# Position-match tolerance for the AT-HYG position branch of tier 2
# (WDS precise coords → AT-HYG row). 2″ matches the bead's stated bar
# and is well below the typical AT-HYG inter-source separation away
# from the densest clusters. High-PM stars may miss at this tolerance
# — that's intentional; tier 3 (PM-propagated match against Gaia
# astrometry, stubbed until ``stellata-dch.29``) is the principled fix
# for the PM-driven epoch-residual class.
ATHYG_POSITION_MATCH_TOLERANCE_ARCSEC = 2.0


def _spherical_to_unit_vec(ra_deg: float, dec_deg: float) -> tuple[float, float, float]:
    """ICRS spherical (degrees) → unit vector on the celestial sphere.
    Chord distance squared between two such vectors is monotone with
    angular separation, so the squared dot/chord forms can be compared
    directly without trig in the hot loop.
    """
    ra_rad = math.radians(ra_deg)
    dec_rad = math.radians(dec_deg)
    c = math.cos(dec_rad)
    return c * math.cos(ra_rad), c * math.sin(ra_rad), math.sin(dec_rad)


def build_athyg_position_grid(
    athyg: list[AthygRow],
) -> dict[tuple[int, int], list[int]]:
    """Bucket AT-HYG rows by ``(int(ra_deg) % 360, int(dec_deg) + 90)`` —
    1°×1° cells with the dec axis shifted into ``[0, 180)`` so the key is
    always non-negative. Cell occupancy averages ~5 rows; the query walks
    a 3-cell-tall dec strip whose ra width is widened by ``1/cos(dec)``
    so the search radius stays consistent at high declinations.
    """
    grid: dict[tuple[int, int], list[int]] = {}
    for i, row in enumerate(athyg):
        key = (int(row.ra_deg) % 360, int(row.dec_deg) + 90)
        grid.setdefault(key, []).append(i)
    return grid


def find_nearest_athyg_at_position(
    ra_deg: float,
    dec_deg: float,
    grid: dict[tuple[int, int], list[int]],
    athyg: list[AthygRow],
    tol_arcsec: float,
    exclude_idx: int | None = None,
) -> int | None:
    """Return the AT-HYG list index nearest to ``(ra_deg, dec_deg)`` within
    ``tol_arcsec`` (or ``None`` if no row is within tolerance).

    ``exclude_idx`` skips a known row — used when matching a secondary
    component so the primary's own AT-HYG row cannot win.
    """
    cos_dec = max(math.cos(math.radians(dec_deg)), 1e-3)
    ra_window = max(1, int(math.ceil(1.0 / cos_dec)))
    base_ra = int(ra_deg) % 360
    base_dec = int(dec_deg) + 90
    qx, qy, qz = _spherical_to_unit_vec(ra_deg, dec_deg)
    threshold_chord_sq = (2.0 * math.sin(math.radians(tol_arcsec / 3600.0) / 2.0)) ** 2

    best_idx: int | None = None
    best_chord_sq = float("inf")
    for ddec in (-1, 0, 1):
        dec_key = base_dec + ddec
        for dra in range(-ra_window, ra_window + 1):
            ra_key = (base_ra + dra) % 360
            for i in grid.get((ra_key, dec_key), ()):
                if i == exclude_idx:
                    continue
                rx, ry, rz = _spherical_to_unit_vec(
                    athyg[i].ra_deg, athyg[i].dec_deg,
                )
                dx = rx - qx
                dy = ry - qy
                dz = rz - qz
                d_sq = dx * dx + dy * dy + dz * dz
                if d_sq < best_chord_sq:
                    best_chord_sq = d_sq
                    best_idx = i
    if best_idx is None or best_chord_sq > threshold_chord_sq:
        return None
    return best_idx


def predict_secondary_position(
    primary_ra_deg: float,
    primary_dec_deg: float,
    rho_arcsec: float,
    theta_deg: float,
) -> tuple[float, float]:
    """Offset a primary's ICRS position by the WDS (ρ, θ) pair last-seen
    relative motion — θ measured east of north, ρ in arcseconds. The
    small-offset approximation is fine at WDS separations (<1000″ for
    the vast majority of pairs); larger separations are rare and the
    secondary is usually individually catalogued in AT-HYG.
    """
    theta_rad = math.radians(theta_deg)
    rho_deg = rho_arcsec / 3600.0
    new_dec = primary_dec_deg + rho_deg * math.cos(theta_rad)
    cos_dec = max(math.cos(math.radians(primary_dec_deg)), 1e-3)
    new_ra = (primary_ra_deg + (rho_deg * math.sin(theta_rad)) / cos_dec) % 360.0
    return new_ra, new_dec


def resolve_via_position(
    components: list[ResolvedComponent],
    pairs: list[WdsPair],
    athyg: list[AthygRow],
    tolerance_arcsec: float = ATHYG_POSITION_MATCH_TOLERANCE_ARCSEC,
) -> None:
    """Second pass over components that fell through tier 1 (ORB6 HIP)
    and the HIP-mediated branch of tier 2 (AT-HYG via HIP). Position-
    matches WDS precise coordinates into AT-HYG and reads the resulting
    row's natively-stored gaia field. Mutates ``components`` in place —
    sets ``gaia_source_id`` and rewrites ``resolve_via`` from
    ``unresolved`` to ``athyg_gaia_native`` on hit.

    Primary uses the WDS pair's ``precise_ra/dec``; secondary uses that
    plus the pair's last-reported ``(ρ, θ)`` offset, EXCLUDING the
    primary's matched row so a close-binary primary cannot claim its own
    secondary slot. Components without precise coords (or, for
    secondaries, without ρ/θ) stay unresolved here and roll forward to
    tiers 3-4 once ``stellata-dch.29`` lands.
    """
    grid = build_athyg_position_grid(athyg)

    # ResolvedComponent carries the component letter, not the pair's
    # components string — relink each unresolved component to its WDS
    # pair via (wds_id, discoverer) + the component letter matching
    # split_components(pair.components)[primary/secondary]. For typical
    # WDS_SUMM data each (wds_id, discoverer) yields one pair, so this
    # is O(1) per component in practice.
    pair_by_id: dict[tuple[str, str], list[WdsPair]] = {}
    for p in pairs:
        pair_by_id.setdefault((p.wds_id, p.discoverer), []).append(p)

    def _find_owning_pair(c: ResolvedComponent) -> WdsPair | None:
        slot = 0 if c.is_primary else 1
        for p in pair_by_id.get((c.wds_id, c.discoverer), ()):
            split = split_components(p.components)
            if split is not None and split[slot] == c.component:
                return p
        return None

    # Pass 1 — primaries. Cache the AT-HYG row each primary claims so
    # the secondary pass can exclude it (close-binary primaries must not
    # be matched twice for both slots of the same pair).
    primary_athyg_idx: dict[tuple[str, str, str], int] = {}
    for c in components:
        if c.gaia_source_id is not None or not c.is_primary:
            continue
        pair = _find_owning_pair(c)
        if pair is None or pair.precise_ra_deg is None or pair.precise_dec_deg is None:
            continue
        match_idx = find_nearest_athyg_at_position(
            pair.precise_ra_deg, pair.precise_dec_deg,
            grid, athyg, tolerance_arcsec,
        )
        if match_idx is None:
            continue
        row = athyg[match_idx]
        if row.gaia is None:
            continue
        c.gaia_source_id = row.gaia
        c.resolve_via = "athyg_gaia_native"
        primary_athyg_idx[(c.wds_id, c.discoverer, pair.components)] = match_idx

    # Pass 2 — secondaries. Predict position from primary + (ρ, θ),
    # exclude the primary's AT-HYG row.
    for c in components:
        if c.gaia_source_id is not None or c.is_primary:
            continue
        pair = _find_owning_pair(c)
        if (
            pair is None
            or pair.precise_ra_deg is None
            or pair.precise_dec_deg is None
            or pair.rho_last is None
            or pair.theta_last is None
        ):
            continue
        secondary_ra, secondary_dec = predict_secondary_position(
            pair.precise_ra_deg, pair.precise_dec_deg,
            pair.rho_last, pair.theta_last,
        )
        primary_idx = primary_athyg_idx.get(
            (c.wds_id, c.discoverer, pair.components),
        )
        match_idx = find_nearest_athyg_at_position(
            secondary_ra, secondary_dec,
            grid, athyg, tolerance_arcsec, exclude_idx=primary_idx,
        )
        if match_idx is None:
            continue
        row = athyg[match_idx]
        if row.gaia is None:
            continue
        c.gaia_source_id = row.gaia
        c.resolve_via = "athyg_gaia_native"


def resolve_all_pairs(
    pairs: list[WdsPair],
    orb6: list[Orb6Entry],
    indices: IdentifierIndices,
    athyg: list[AthygRow],
    position_tolerance_arcsec: float = ATHYG_POSITION_MATCH_TOLERANCE_ARCSEC,
) -> list[ResolvedComponent]:
    """Run Stage 2's full resolution chain — identifier-then-position
    over every WDS pair that decomposes into two components. System-
    level rows (empty ``components``) and rows we cannot split are
    skipped.

    Pass 1 (identifier): for each component, run tier 1 (ORB6's HIP →
    Gaia xwalk) and tier 2 (AT-HYG's natively-stored gaia via the same
    HIP).
    Pass 2 (position): for components left unresolved, match WDS
    precise coordinates against AT-HYG and read AT-HYG's gaia field
    directly. This also classifies as ``athyg_gaia_native`` because it
    does NOT touch ``data/gaia_dr3_astrometry.tsv`` — that file backs
    tiers 3-4 (stubbed until ``stellata-dch.29``).
    """
    orb6_by_pair = group_orb6_by_pair(orb6)
    out: list[ResolvedComponent] = []
    for pair in pairs:
        split = split_components(pair.components)
        if split is None:
            continue
        primary, secondary = split
        orb6_for_pair = orb6_by_pair.get((pair.wds_id, pair.components), [])
        out.append(resolve_component(
            pair, primary, is_primary=True,
            orb6_for_pair=orb6_for_pair, indices=indices,
        ))
        out.append(resolve_component(
            pair, secondary, is_primary=False,
            orb6_for_pair=orb6_for_pair, indices=indices,
        ))
    resolve_via_position(
        components=out, pairs=pairs, athyg=athyg,
        tolerance_arcsec=position_tolerance_arcsec,
    )
    propagate_within_system(out)
    return out


def propagate_within_system(components: list[ResolvedComponent]) -> None:
    """Within each WDS system, the same component letter always refers
    to the same physical star (e.g. component A of WDS 00491+5749 is η
    Cas A whether it appears in the AB, AC, AD, …, AH pair rows). When
    one pair's A primary resolves via HIP-mediated AT-HYG lookup but
    the other A primaries can't (their pair has no ORB6 entry and the
    WDS precise coord drift exceeds the 2″ position tolerance), this
    pass copies the resolved binding forward. The inherited
    ``resolve_via`` classification is preserved so the per-tier counts
    log the strategy that actually fetched the source_id, not a
    synthetic propagation tag.
    """
    by_system_letter: dict[tuple[str, str], tuple[int, str]] = {}
    for c in components:
        if c.gaia_source_id is None:
            continue
        key = (c.wds_id, c.component)
        by_system_letter.setdefault(key, (c.gaia_source_id, c.resolve_via))
    for c in components:
        if c.gaia_source_id is not None:
            continue
        binding = by_system_letter.get((c.wds_id, c.component))
        if binding is None:
            continue
        c.gaia_source_id, c.resolve_via = binding


def resolution_counts(
    components: list[ResolvedComponent],
) -> dict[str, int]:
    """Per-strategy counters in canonical ``RESOLVE_VIA_VALUES`` order.
    Every key present so the log line shape stays stable across runs."""
    counts: dict[str, int] = {k: 0 for k in RESOLVE_VIA_VALUES}
    for c in components:
        counts[c.resolve_via] = counts.get(c.resolve_via, 0) + 1
    return counts


def write_astrometry_request(
    components: list[ResolvedComponent], path: Path,
) -> int:
    """Emit the deduped union of source_ids resolved in tiers 1-2.

    ``stellata-dch.29`` (``scripts/refresh-gaia-astrometry.py``) reads
    this file to drive its ADQL ``WHERE source_id IN (...)`` query — so
    Stage 3 onward has 5-parameter Gaia astrometry for exactly the
    sources we resolved here.
    """
    ids = sorted({c.gaia_source_id for c in components if c.gaia_source_id is not None})
    with path.open("w") as fh:
        fh.write("gaia_source_id\n")
        for sid in ids:
            fh.write(f"{sid}\n")
    return len(ids)


# ─── Driver ──────────────────────────────────────────────────────────


def _iter_input_paths() -> Iterator[Path]:
    yield SCRIPT
    yield SRC_WDS_SUMM
    yield SRC_ORB6
    yield SRC_ATHYG
    yield SRC_GCVS
    yield SRC_GCVS_CROSSID
    yield SRC_CCDM
    yield SRC_HIP2
    yield SRC_GAIA_HIP_XM
    yield SRC_GAIA_TYC_XM
    yield SRC_GAIA_NSS
    # SRC_GAIA_ASTROMETRY skipped: optional, lands with dch.29.


def log(msg: str) -> None:
    print(f"[build-binaries] {msg}")


def run(force: bool) -> int:
    if not force and OUT_MULTIPLES.exists() and is_up_to_date(
        OUT_MULTIPLES, _iter_input_paths(),
    ):
        log(
            f"{OUT_MULTIPLES.relative_to(ROOT)} up to date — skipping "
            "(use --force to rebuild)"
        )
        return 0

    log("loading reference catalogs (Stage 1) …")

    wds_pairs = parse_wds_summ(SRC_WDS_SUMM)
    log(f"loaded {len(wds_pairs):,} WDS pair rows")

    orb6 = parse_orb6(SRC_ORB6)
    log(f"loaded {len(orb6):,} ORB6 orbit rows")

    athyg = parse_athyg(SRC_ATHYG)
    n_gaia = sum(1 for r in athyg if r.gaia is not None)
    log(f"loaded {len(athyg):,} AT-HYG rows")
    coverage = n_gaia / len(athyg) if athyg else 0.0
    log(f"{n_gaia:,} / {len(athyg):,} AT-HYG rows carry gaia ({coverage:.1%})")
    lo, hi = ATHYG_GAIA_COVERAGE_BOUNDS
    if not (lo <= coverage <= hi):
        log(
            f"WARNING: AT-HYG gaia coverage {coverage:.1%} outside expected "
            f"band [{lo:.0%}, {hi:.0%}] — input drift suspected"
        )

    gcvs = parse_gcvs(SRC_GCVS)
    log(f"loaded {len(gcvs):,} GCVS variable-star rows")

    gcvs_xid = parse_gcvs_crossid(SRC_GCVS_CROSSID)
    log(
        f"loaded GCVS cross-IDs for {len(gcvs_xid):,} designations "
        f"({sum(len(v) for v in gcvs_xid.values()):,} external refs)"
    )

    ccdm = parse_ccdm(SRC_CCDM)
    log(f"loaded {len(ccdm):,} CCDM rows")

    hip2 = parse_hip2(SRC_HIP2)
    log(f"loaded {len(hip2):,} HIP2 van Leeuwen astrometry rows")

    hip_to_gaia = parse_gaia_hip_xmatch(SRC_GAIA_HIP_XM)
    log(
        f"loaded Gaia HIP xmatch; built hip -> gaia_source_id of "
        f"cardinality {len(hip_to_gaia):,}"
    )

    tyc_to_gaia = parse_gaia_tyc_xmatch(SRC_GAIA_TYC_XM)
    log(
        f"loaded Gaia Tycho xmatch; built tyc -> gaia_source_id of "
        f"cardinality {len(tyc_to_gaia):,}"
    )

    src_to_nss = parse_gaia_nss(SRC_GAIA_NSS)
    log(
        f"loaded Gaia NSS two-body; built gaia_source_id -> nss_row of "
        f"cardinality {len(src_to_nss):,}"
    )

    if SRC_GAIA_ASTROMETRY.exists():
        log(
            f"NOTE: {SRC_GAIA_ASTROMETRY.name} present but Stage 2-I "
            "ingestion (stellata-dch.29) has not landed yet — file ignored"
        )
    else:
        log(
            f"{SRC_GAIA_ASTROMETRY.name} not yet present "
            "(expected — produced by stellata-dch.29)"
        )

    indices = build_indices(athyg, hip2, hip_to_gaia, tyc_to_gaia, src_to_nss)
    log(
        f"built AT-HYG identifier views: "
        f"hip -> row {len(indices.hip_to_athyg):,}, "
        f"tyc -> row {len(indices.tyc_to_athyg):,}, "
        f"gaia_source_id -> row {len(indices.src_to_athyg):,}"
    )
    log(
        f"built hip -> hip2_row of cardinality {len(indices.hip_to_hip2):,}"
    )

    log("Stage 1 complete. Resolving WDS components (Stage 2) …")

    components = resolve_all_pairs(
        pairs=wds_pairs, orb6=orb6,
        indices=indices, athyg=athyg,
    )
    counts = resolution_counts(components)
    log(
        "Resolution: "
        + ", ".join(f"{k}={counts[k]:,}" for k in RESOLVE_VIA_VALUES)
    )

    n_requested = write_astrometry_request(components, OUT_ASTROMETRY_REQUEST)
    log(
        f"wrote {OUT_ASTROMETRY_REQUEST.relative_to(ROOT)} with "
        f"{n_requested:,} unique source_ids (input for stellata-dch.29)"
    )

    log("Stage 2 complete. Stages 3-7 (astrometry-attach / orbit-fit / optical-filter / emit) land in stellata-dch.29-32.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--force", action="store_true",
        help="ignore mtime check and reload all inputs",
    )
    args = p.parse_args()
    return run(force=args.force)


if __name__ == "__main__":
    sys.exit(main())
