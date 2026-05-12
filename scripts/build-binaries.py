#!/usr/bin/env python3
"""Cross-match WDS + ORB6 against AT-HYG; emit data/multiples.tsv.

Reads four committed source files under data/:
  - wds_summ.txt    (Washington Double Star Catalog; fixed-width 130-char records)
  - wds_notes.txt   (WDS notes; prose HIP cross-refs supplement the cone-match)
  - orb6_orbits.txt (Sixth Catalog of Orbits of Visual Binary Stars; fixed-width 264-char)
  - athyg_33_classic_ids.csv (AT-HYG canonical positions, HIP-keyed)
  - gaia_dr3_binaries.tsv  OPTIONAL — when present, used for the optical-pair filter

For each WDS pair, resolves the primary's HIP (ORB6 direct → AT-HYG cone-match
at 2″ → wds_notes prose), then computes the secondary's xyz under one of three
regimes:

  Regime 1 — visually resolved: WDS ρ_last + θ_last at the last observation
             epoch → tangent-plane projection at A's heliocentric distance.
  Regime 2 — ORB6 orbit available: solve Kepler at J2000.0 with the elements
             (P, T0, e, a, i, ω, Ω); project to (ρ, θ) → tangent offset.
             Grade tie-break — lowest numeric grade wins (1=definitive,
             5=indeterminate, 8/9 spectroscopic/astrometric sort last); ties
             broken by most recent REF year.
  Regime 3 — spectroscopic-only ORB6 entry (no inclination): use a (which
             carries a·sin i implicitly) as the separation magnitude with
             conventional PA=0. Documented in SCIENCE.md.

Optical-pair filter (in priority order):
  1. WDS Notes column flags (S/U/X/Y → optical/reject; T/V/Z → physical/keep)
  2. If data/gaia_dr3_binaries.tsv present: parallax 3σ + ~5 mas/yr common-PM
  3. Spectral / magnitude-difference sanity fallback (reject extreme outliers)

Output `data/multiples.tsv` columns (TSV header):
  system_id  comp  hip  x_pc  y_pc  z_pc  absmag  ci  spect  name  source  regime

Per-component rows. `hip` is the integer HIP, or `SYN-NNN` sentinel for
synthetic injections without HIP. Override rows from
`data/multiples-overrides.tsv` apply last and win.

Side-output `data/wds_upload.csv` (always written): `wds_id,comp,ra_deg,dec_deg`
for the kept pairs — Alex uploads this to the Gaia archive
(https://gea.esac.esa.int/archive/) as a user table, JOINs against
gaiadr3.gaia_source within 1″, downloads as data/gaia_dr3_binaries.tsv, and
re-runs this script to engage the optical filter. Procedure detailed in
SCIENCE.md.

Idempotent — skips when data/multiples.tsv is newer than this script and all
input files. Run via `npm run build:binaries` (invoked automatically by
`npm run build:catalog`).
"""

from __future__ import annotations

import argparse
import csv
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'

SRC_WDS_SUMM = DATA / 'wds_summ.txt'
SRC_WDS_NOTES = DATA / 'wds_notes.txt'
SRC_ORB6 = DATA / 'orb6_orbits.txt'
SRC_ATHYG = DATA / 'athyg_33_classic_ids.csv'
SRC_GAIA = DATA / 'gaia_dr3_binaries.tsv'   # optional

OUT_MULTIPLES = DATA / 'multiples.tsv'
OUT_UPLOAD = DATA / 'wds_upload.csv'
OVERRIDES_PATH = DATA / 'multiples-overrides.tsv'

# Cone-match tolerance for WDS precise coord → AT-HYG. WDS coords are J2000
# but AT-HYG positions come from Tycho-2 / Hipparcos at varying epochs without
# guaranteed PM correction. High-PM stars (Sirius, Barnard's, α Cen) drift
# 10-30″ between WDS J2000 and AT-HYG epochs. 30″ covers them and is still
# tight enough that the sort-by-distance pick is unambiguous in practice.
CONE_MATCH_RADIUS_ARCSEC = 30.0
# Tolerance for the secondary-component cone-match, where we project B at
# A + (ρ, θ) and look for an AT-HYG match within ~30″. Same epoch-drift
# motivation as the primary — α Cen B (HIP 71681) sits 19″ from its J2000
# projected B position via the orbit, so a tight (~5″) tolerance would miss.
# Primary HIP is excluded from results so the next-nearest non-primary wins.
SECONDARY_CONE_MATCH_RADIUS_ARCSEC = 30.0

# Optical-pair filter thresholds (Gaia gating)
GAIA_PARALLAX_NSIGMA = 3.0
GAIA_PM_TOLERANCE_MAS_YR = 5.0

# WDS Notes flag chars (col 108-111 in fixed-width record). Column 108 is N,
# 109 is reserved for O/L/C/X, 110 for W; others may appear in any of the
# four columns. Physical / non-physical determinations per wdsweb_format.txt.
WDS_NOTES_PHYSICAL = set('TVZ')
WDS_NOTES_OPTICAL = set('SUXY')

# ORB6 grade ranking. 1=definitive ... 5=indeterminate; 8=interferometric
# visibility-only, 9=astrometric binary (both non-grade-able qualitatively;
# sort after numeric grades 1-5 for tiebreak).
ORB6_GRADE_SORT_KEY = {1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 8: 6, 9: 7}

# Quadratic fallback when the spectroscopic/m-diff sanity check is invoked
# without Gaia data. Pure defensive: reject if mag gap > 8 AND no spectral
# overlap. Rare; most pairs survive on WDS-Notes alone.
MAG_DIFF_REJECT_THRESHOLD = 8.0

# Override schema columns (multiples.tsv schema + a curator-notes column).
OVERRIDE_COLUMNS = [
    'system_id', 'comp', 'hip', 'x_pc', 'y_pc', 'z_pc',
    'absmag', 'ci', 'spect', 'name', 'source', 'regime', 'notes',
]

# Output schema (multiples.tsv).
OUTPUT_COLUMNS = [
    'system_id', 'comp', 'hip', 'x_pc', 'y_pc', 'z_pc',
    'absmag', 'ci', 'spect', 'name', 'source', 'regime',
]

DEG2RAD = math.pi / 180.0
ARCSEC2RAD = math.pi / (180.0 * 3600.0)
J2000_JD = 2451545.0


# ────────────────────────────────────────────────────────────────────────────
# Parsing helpers
# ────────────────────────────────────────────────────────────────────────────

def safe_float(s: str) -> float | None:
    s = s.strip()
    if not s or s == '.':
        return None
    try:
        return float(s)
    except ValueError:
        return None


def safe_int(s: str) -> int | None:
    s = s.strip()
    if not s or s == '.':
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_wds_precise_coord(s: str) -> tuple[float, float] | None:
    """WDS 'Precise Coordinate' (cols 113-130): HHMMSS.SS[+-]DDMMSS.S → (RA°, Dec°)."""
    s = s.strip()
    if len(s) < 17:
        return None
    try:
        ra_h = int(s[0:2])
        ra_m = int(s[2:4])
        ra_s = float(s[4:9])
        sign = -1 if s[9] == '-' else 1
        dec_d = int(s[10:12])
        dec_m = int(s[12:14])
        dec_s = float(s[14:])
        ra_deg = (ra_h + ra_m / 60.0 + ra_s / 3600.0) * 15.0
        dec_deg = sign * (dec_d + dec_m / 60.0 + dec_s / 3600.0)
        return ra_deg, dec_deg
    except (ValueError, IndexError):
        return None


# ────────────────────────────────────────────────────────────────────────────
# AT-HYG
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class AthygRow:
    hip: int
    hd: int | None
    ra_deg: float
    dec_deg: float
    x_pc: float
    y_pc: float
    z_pc: float
    dist_pc: float
    v_mag: float | None      # apparent V (or Tycho VT proxy) — for WDS mag-cross-check
    absmag: float
    ci: float | None
    spect: str
    name: str


def parse_athyg(path: Path) -> dict[int, AthygRow]:
    by_hip: dict[int, AthygRow] = {}
    with path.open(newline='') as fh:
        reader = csv.reader(fh)
        header = next(reader)
        cols = {n: i for i, n in enumerate(header)}
        for row in reader:
            hip = safe_int(row[cols['hip']])
            if hip is None:
                continue
            try:
                ra_h = float(row[cols['ra']])    # AT-HYG stores RA in hours
                dec_d = float(row[cols['dec']])
                x = float(row[cols['x0']])
                y = float(row[cols['y0']])
                z = float(row[cols['z0']])
                dist = float(row[cols['dist']])
            except ValueError:
                continue
            absmag = safe_float(row[cols['absmag']])
            if absmag is None:
                continue
            by_hip[hip] = AthygRow(
                hip=hip,
                hd=safe_int(row[cols['hd']]),
                ra_deg=ra_h * 15.0,
                dec_deg=dec_d,
                x_pc=x, y_pc=y, z_pc=z,
                dist_pc=dist,
                v_mag=safe_float(row[cols['mag']]),
                absmag=absmag,
                ci=safe_float(row[cols['ci']]),
                spect=row[cols['spect']].strip(),
                name=row[cols['proper']].strip(),
            )
    return by_hip


# Sky-tile index for cone-match — 1°×1° buckets, dict-of-lists. Avoids the
# numpy/scipy dependency at the cost of a slightly slower bucket walk that's
# still trivial at WDS-pair counts (~157k queries × ~50 candidates).

class SkyTileIndex:
    """Bucket index over (ra, dec) for cone-match within a few arcseconds.

    Buckets are 1° wide in dec, ~1° wide in RA at the equator (uses cos(dec)
    of the bucket center). Query checks the 3×3 neighborhood; great-circle
    distance via dot product of unit vectors.
    """

    BUCKET_DEG = 1.0

    def __init__(self, rows: list[AthygRow]) -> None:
        self._buckets: dict[tuple[int, int], list[tuple[int, float, float, float]]] = {}
        for r in rows:
            key = self._key(r.ra_deg, r.dec_deg)
            cd = math.cos(r.dec_deg * DEG2RAD)
            self._buckets.setdefault(key, []).append((
                r.hip,
                cd * math.cos(r.ra_deg * DEG2RAD),
                cd * math.sin(r.ra_deg * DEG2RAD),
                math.sin(r.dec_deg * DEG2RAD),
            ))

    @staticmethod
    def _key(ra_deg: float, dec_deg: float) -> tuple[int, int]:
        ra_key = int(ra_deg // SkyTileIndex.BUCKET_DEG) % 360
        dec_key = int(dec_deg // SkyTileIndex.BUCKET_DEG)
        return ra_key, dec_key

    def query(
        self, ra_deg: float, dec_deg: float, radius_arcsec: float,
    ) -> list[int]:
        if math.isnan(ra_deg) or math.isnan(dec_deg):
            return []
        cd = math.cos(dec_deg * DEG2RAD)
        tx = cd * math.cos(ra_deg * DEG2RAD)
        ty = cd * math.sin(ra_deg * DEG2RAD)
        tz = math.sin(dec_deg * DEG2RAD)
        cos_thresh = math.cos(radius_arcsec * ARCSEC2RAD)
        # Widen RA window near the poles to keep coverage tight.
        ra_span = 1 + int(math.ceil(1.0 / max(cd, 1e-3)))
        ra_key, dec_key = self._key(ra_deg, dec_deg)
        candidates: list[tuple[float, int]] = []
        for ddec in (-1, 0, 1):
            for dra in range(-ra_span, ra_span + 1):
                key = ((ra_key + dra) % 360, dec_key + ddec)
                bucket = self._buckets.get(key)
                if not bucket:
                    continue
                for hip, x, y, z in bucket:
                    dot = tx * x + ty * y + tz * z
                    if dot >= cos_thresh:
                        candidates.append((-dot, hip))
        candidates.sort()  # closest (highest dot) first
        return [hip for _, hip in candidates]


def cone_match_hips(
    index: SkyTileIndex,
    ra_deg: float,
    dec_deg: float,
    radius_arcsec: float = CONE_MATCH_RADIUS_ARCSEC,
) -> list[int]:
    return index.query(ra_deg, dec_deg, radius_arcsec)


# ────────────────────────────────────────────────────────────────────────────
# WDS summary
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class WdsPair:
    wds_id: str
    discoverer: str
    components: str
    date_last: int | None
    rho_last: float | None       # arcsec
    theta_last: float | None     # degrees east of north
    mag_pri: float | None
    mag_sec: float | None
    spectral: str
    notes: str
    precise_ra_deg: float | None
    precise_dec_deg: float | None


_WDS_HEADER_RE = re.compile(r'^[A-Za-z<]')


def parse_wds_summ(path: Path) -> list[WdsPair]:
    pairs: list[WdsPair] = []
    with path.open(errors='replace') as fh:
        for line in fh:
            line = line.rstrip('\r\n')
            if not line or len(line) < 22:
                continue
            if _WDS_HEADER_RE.match(line):
                continue
            # First 5 chars are HH MM.M (HHMM + tenths digit, e.g. "00000")
            # — must parse to integers.
            try:
                int(line[0:5])
            except ValueError:
                continue
            wds_id = line[0:10].strip()
            discoverer = line[10:17].strip()
            components = line[17:22].strip()
            if not wds_id or not discoverer:
                continue
            line = line.ljust(130)
            date_last = safe_int(line[28:32])
            theta_last = safe_float(line[42:45])
            rho_last = safe_float(line[52:57])
            mag_pri = safe_float(line[58:63])
            mag_sec = safe_float(line[64:69])
            spectral = line[70:79].strip()
            notes = line[107:111]
            precise = parse_wds_precise_coord(line[112:130])
            ra, dec = precise if precise else (None, None)
            pairs.append(WdsPair(
                wds_id=wds_id,
                discoverer=discoverer,
                components=components,
                date_last=date_last,
                rho_last=rho_last,
                theta_last=theta_last,
                mag_pri=mag_pri,
                mag_sec=mag_sec,
                spectral=spectral,
                notes=notes,
                precise_ra_deg=ra,
                precise_dec_deg=dec,
            ))
    return pairs


# ────────────────────────────────────────────────────────────────────────────
# WDS notes (prose HIP supplement + optical-flag prose)
# ────────────────────────────────────────────────────────────────────────────

_NOTES_HIP_RE = re.compile(r'HIP\s+(\d+)')


def parse_wds_notes(path: Path) -> dict[str, list[int]]:
    """Returns {wds_id: [HIPs mentioned in prose]} — supplements cone-match.

    The notes table is free-text. We harvest 'HIP NNN' tokens against the
    leading WDS id on each note block.
    """
    notes: dict[str, list[int]] = {}
    current_wds: str | None = None
    with path.open(errors='replace') as fh:
        for line in fh:
            line = line.rstrip('\r\n')
            if not line or line.startswith('<') or line.startswith('USNO'):
                continue
            # Note lines either start with a WDS id (cols 0-9) or with spaces
            # (continuation of the previous note).
            head = line[0:10]
            if head.strip() and re.match(r'\d{5}[+-]\d{4}', head):
                current_wds = head.strip()
            if not current_wds:
                continue
            for m in _NOTES_HIP_RE.finditer(line):
                hip = int(m.group(1))
                notes.setdefault(current_wds, [])
                if hip not in notes[current_wds]:
                    notes[current_wds].append(hip)
    return notes


# ────────────────────────────────────────────────────────────────────────────
# ORB6
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class Orb6Entry:
    wds_id: str
    components: str
    hd: int | None
    hip: int | None
    P_yr: float | None       # period, years
    a_arcsec: float | None   # semi-major axis, arcsec (sin-i embedded when i unknown)
    i_deg: float | None      # blank → spectroscopic-only (Regime 3)
    Omega_deg: float | None  # node
    omega_deg: float | None  # arg of periastron
    e: float | None
    T0_jd: float            # epoch of periastron (Julian Date)
    grade: int
    ref: str


# Match the trailing components designator in an ORB6 discoverer field:
# starts with a letter, then any mix of letters/digits/commas/dashes through
# end of string. Examples: "AB", "AC", "Aa,Ab", "AB-C", "Aa1,2", "Aa1,Aa2".
_ORB6_COMPONENTS_RE = re.compile(r'([A-Za-z][A-Za-z\d,\-]*)$')


def _orb6_unit_to_years(value: float, unit: str) -> float | None:
    if unit == 'y':
        return value
    if unit == 'd':
        return value / 365.25
    if unit == 'c':
        return value * 100.0
    if unit == 'h':
        return value / (24.0 * 365.25)
    if unit == 'm':
        return value / (60.0 * 24.0 * 365.25)
    return None


def _orb6_unit_to_arcsec(value: float, unit: str) -> float | None:
    if unit == 'a':
        return value
    if unit == 'm':
        return value / 1000.0          # milliarcsec
    if unit == 'M':
        return value * 60.0            # arcminutes (α Cen + Proxima only)
    if unit == 'u':
        return value / 1_000_000.0     # microarcsec
    return None


def _orb6_t0_to_jd(value: float, unit: str) -> float | None:
    if unit == 'd':
        return value + 2_400_000.0     # truncated JD (JD - 2,400,000)
    if unit == 'm':
        return value + 2_400_000.5     # modified JD
    if unit == 'y':
        # fractional Besselian year. B1900.0 = JD 2415020.31352.
        return 2_415_020.31352 + (value - 1900.0) * 365.242198781
    if unit == 'c':
        return 2_415_020.31352 + (value * 100.0 - 1900.0) * 365.242198781
    return None


def parse_orb6(path: Path) -> dict[tuple[str, str], list[Orb6Entry]]:
    """Returns {(wds_id, components): [Orb6Entry,...]}.

    Multiple fits per system are possible. Caller picks via grade-tiebreak.
    """
    out: dict[tuple[str, str], list[Orb6Entry]] = {}
    with path.open(errors='replace') as fh:
        for raw in fh:
            line = raw.rstrip('\r\n')
            if not line or len(line) < 30:
                continue
            # Skip title + numeric-ruler banner lines (1-4).
            head = line[0:9].strip()
            if not head or not head[0].isdigit():
                continue
            line = line.ljust(264)
            wds_id = line[19:29].strip()
            disc_field = line[30:44]
            m = _ORB6_COMPONENTS_RE.search(disc_field.rstrip())
            components = m.group(1) if m else ''
            if not wds_id or not components:
                continue
            hd = safe_int(line[51:57])
            hip = safe_int(line[58:64])
            P_val = safe_float(line[81:92])
            P_unit = line[92:93].strip()
            a_val = safe_float(line[105:114])
            a_unit = line[114:115].strip()
            i_val = safe_float(line[125:133])
            Omega_val = safe_float(line[143:151])
            T0_val = safe_float(line[162:174])
            T0_unit = line[174:175].strip()
            e_val = safe_float(line[187:195])
            omega_val = safe_float(line[205:213])
            grade_str = line[233:234].strip()
            grade = int(grade_str) if grade_str.isdigit() else 5
            ref = line[237:245].strip()
            P_yr = _orb6_unit_to_years(P_val, P_unit) if P_val is not None else None
            a_arcsec = _orb6_unit_to_arcsec(a_val, a_unit) if a_val is not None else None
            T0_jd = _orb6_t0_to_jd(T0_val, T0_unit) if T0_val is not None else math.nan
            entry = Orb6Entry(
                wds_id=wds_id,
                components=components,
                hd=hd, hip=hip,
                P_yr=P_yr,
                a_arcsec=a_arcsec,
                i_deg=i_val,
                Omega_deg=Omega_val,
                omega_deg=omega_val,
                e=e_val,
                T0_jd=T0_jd if T0_jd is not None else math.nan,
                grade=grade,
                ref=ref,
            )
            out.setdefault((wds_id, components), []).append(entry)
    return out


def pick_best_orb6(entries: list[Orb6Entry]) -> Orb6Entry:
    """Lowest grade wins; tie broken by most recent REF year (parsed from REF)."""
    def ref_year(ref: str) -> int:
        m = re.search(r'(\d{4})', ref)
        return int(m.group(1)) if m else 0
    return min(
        entries,
        key=lambda e: (ORB6_GRADE_SORT_KEY.get(e.grade, 99), -ref_year(e.ref)),
    )


# ────────────────────────────────────────────────────────────────────────────
# Gaia (optional)
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class GaiaPairData:
    """Gaia DR3 astrometry for one WDS component."""
    parallax_mas: float
    parallax_err_mas: float
    pmra: float
    pmdec: float


def parse_gaia(path: Path) -> dict[tuple[str, str], GaiaPairData]:
    """Returns {(wds_id, comp): GaiaPairData} keyed by upload identifier.

    Expected schema (Alex-curated after ADQL): TSV with at minimum
    columns `wds_id`, `comp`, `parallax`, `parallax_error`, `pmra`, `pmdec`.
    """
    out: dict[tuple[str, str], GaiaPairData] = {}
    with path.open(newline='') as fh:
        reader = csv.DictReader(fh, delimiter='\t')
        for row in reader:
            wds_id = (row.get('wds_id') or '').strip()
            comp = (row.get('comp') or '').strip()
            if not wds_id or not comp:
                continue
            try:
                plx = float(row['parallax'])
                plx_err = float(row.get('parallax_error') or 0.0) or 1e-3
                pmra = float(row.get('pmra') or 0.0)
                pmdec = float(row.get('pmdec') or 0.0)
            except (KeyError, ValueError):
                continue
            out[(wds_id, comp)] = GaiaPairData(plx, plx_err, pmra, pmdec)
    return out


# ────────────────────────────────────────────────────────────────────────────
# Kepler solver + sky-plane projection
# ────────────────────────────────────────────────────────────────────────────

def solve_kepler(M: float, e: float, tol: float = 1e-10, max_iter: int = 50) -> float:
    """Newton-Raphson on E - e·sinE = M. Returns eccentric anomaly E (rad)."""
    E = M if e < 0.8 else math.pi
    for _ in range(max_iter):
        f = E - e * math.sin(E) - M
        fp = 1.0 - e * math.cos(E)
        dE = -f / fp
        E += dE
        if abs(dE) < tol:
            break
    return E


def orbit_to_sky_offset(
    P_yr: float,
    T0_jd: float,
    e: float,
    a_arcsec: float,
    i_deg: float,
    omega_deg: float,
    Omega_deg: float,
    t_jd: float = J2000_JD,
) -> tuple[float, float]:
    """Compute (ρ_arcsec, θ_deg east-of-north) of B relative to A at epoch t_jd.

    Thiele–Innes constant formulation. North is +X, east is +Y.
    """
    P_days = P_yr * 365.25
    M = (2.0 * math.pi * (t_jd - T0_jd) / P_days) % (2.0 * math.pi)
    E = solve_kepler(M, e)
    omega = omega_deg * DEG2RAD
    Omega = Omega_deg * DEG2RAD
    i = i_deg * DEG2RAD
    cos_o, sin_o = math.cos(omega), math.sin(omega)
    cos_O, sin_O = math.cos(Omega), math.sin(Omega)
    cos_i = math.cos(i)
    # Thiele-Innes constants (in units of a; semi-major axis multiplied later).
    A = cos_o * cos_O - sin_o * sin_O * cos_i
    B = cos_o * sin_O + sin_o * cos_O * cos_i
    F = -sin_o * cos_O - cos_o * sin_O * cos_i
    G = -sin_o * sin_O + cos_o * cos_O * cos_i
    X = math.cos(E) - e
    Y = math.sqrt(max(0.0, 1.0 - e * e)) * math.sin(E)
    # x = north, y = east in the sky plane.
    x = a_arcsec * (A * X + F * Y)
    y = a_arcsec * (B * X + G * Y)
    rho = math.hypot(x, y)
    theta_deg = math.degrees(math.atan2(y, x)) % 360.0
    return rho, theta_deg


# ────────────────────────────────────────────────────────────────────────────
# Tangent-plane offset → ICRS xyz delta
# ────────────────────────────────────────────────────────────────────────────

def project_sky(
    ra_deg: float, dec_deg: float, rho_arcsec: float, theta_deg: float,
) -> tuple[float, float]:
    """Tangent-plane projection on the celestial sphere — returns (b_ra°, b_dec°).

    Pure (ra, dec) math; used for sky-coordinate lookups. xyz reconstruction
    goes through `sky_offset_to_icrs_xyz` instead, since AT-HYG's stored xyz
    has only 0.001 pc precision (≈150″ for nearby stars), too coarse to round
    trip ra/dec through.
    """
    rho_deg = rho_arcsec / 3600.0
    cos_dec = math.cos(dec_deg * DEG2RAD)
    if abs(cos_dec) < 1e-9:
        cos_dec = 1e-9
    theta = theta_deg * DEG2RAD
    b_ra = ra_deg + (rho_deg * math.sin(theta)) / cos_dec
    b_dec = dec_deg + rho_deg * math.cos(theta)
    return b_ra % 360.0, b_dec


def sky_offset_to_icrs_xyz(
    ra_deg: float, dec_deg: float,
    rho_arcsec: float, theta_deg: float,
    dist_pc: float,
) -> tuple[float, float, float]:
    """Project (ρ arcsec, θ deg east of north) at distance dist_pc → ICRS Δxyz."""
    ra = ra_deg * DEG2RAD
    dec = dec_deg * DEG2RAD
    theta = theta_deg * DEG2RAD
    rho_rad = rho_arcsec * ARCSEC2RAD
    # Local sky basis at (ra, dec). East = +α direction; North = +δ direction.
    east_hat = (-math.sin(ra), math.cos(ra), 0.0)
    north_hat = (-math.sin(dec) * math.cos(ra), -math.sin(dec) * math.sin(ra), math.cos(dec))
    # Small-angle tangent-plane offset, magnitude = ρ_rad · dist (radian arc).
    scale = rho_rad * dist_pc
    e_amp = scale * math.sin(theta)   # east component
    n_amp = scale * math.cos(theta)   # north component
    return (
        e_amp * east_hat[0] + n_amp * north_hat[0],
        e_amp * east_hat[1] + n_amp * north_hat[1],
        e_amp * east_hat[2] + n_amp * north_hat[2],
    )


# ────────────────────────────────────────────────────────────────────────────
# Optical-pair filter
# ────────────────────────────────────────────────────────────────────────────

def wds_notes_verdict(notes: str) -> str:
    """Return 'physical', 'optical', or 'unknown' from WDS Notes flag chars."""
    chars = set(notes)
    if chars & WDS_NOTES_OPTICAL:
        return 'optical'
    if chars & WDS_NOTES_PHYSICAL:
        return 'physical'
    return 'unknown'


def gaia_pair_verdict(
    a: GaiaPairData | None,
    b: GaiaPairData | None,
) -> str:
    """parallax 3σ overlap + common-PM check on Gaia data."""
    if a is None or b is None:
        return 'unknown'
    plx_diff = abs(a.parallax_mas - b.parallax_mas)
    plx_sigma = math.sqrt(a.parallax_err_mas ** 2 + b.parallax_err_mas ** 2)
    if plx_diff > GAIA_PARALLAX_NSIGMA * plx_sigma:
        return 'optical'
    pm_diff = math.hypot(a.pmra - b.pmra, a.pmdec - b.pmdec)
    if pm_diff > GAIA_PM_TOLERANCE_MAS_YR:
        return 'optical'
    return 'physical'


def sanity_verdict(pair: WdsPair) -> str:
    """Fallback when neither WDS-Notes nor Gaia speaks.

    Reject only on a clear outlier: huge brightness gap with no shared
    spectral hint. Defensive — most pairs pass through to 'unknown' and
    we keep them by default.
    """
    if pair.mag_pri is not None and pair.mag_sec is not None:
        if abs(pair.mag_pri - pair.mag_sec) > MAG_DIFF_REJECT_THRESHOLD and not pair.spectral:
            return 'optical'
    return 'unknown'


def keep_pair(
    pair: WdsPair,
    gaia_a: GaiaPairData | None,
    gaia_b: GaiaPairData | None,
) -> tuple[bool, str]:
    """Optical-pair filter cascade. Returns (keep, source_tag)."""
    v = wds_notes_verdict(pair.notes)
    if v == 'optical':
        return False, 'wds-notes:optical'
    if v == 'physical':
        return True, 'wds-notes:physical'
    v = gaia_pair_verdict(gaia_a, gaia_b)
    if v == 'optical':
        return False, 'gaia:optical'
    if v == 'physical':
        return True, 'gaia:physical'
    v = sanity_verdict(pair)
    if v == 'optical':
        return False, 'sanity:optical'
    return True, 'unknown:kept'


# ────────────────────────────────────────────────────────────────────────────
# Primary anchor — what a pair's "A" is, regardless of whether it comes
# from a real AT-HYG row (top-level pair) or from a previously-resolved
# parent (sub-pair like Castor's Ba,Bb).
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class PrimaryAnchor:
    hip_str: str               # 'NNN' or 'SYN-NNN'
    ra_deg: float
    dec_deg: float
    x_pc: float
    y_pc: float
    z_pc: float
    dist_pc: float
    absmag: float
    ci: float | None
    spect: str
    name: str


def anchor_from_athyg(row: AthygRow) -> PrimaryAnchor:
    return PrimaryAnchor(
        hip_str=str(row.hip),
        ra_deg=row.ra_deg, dec_deg=row.dec_deg,
        x_pc=row.x_pc, y_pc=row.y_pc, z_pc=row.z_pc,
        dist_pc=row.dist_pc,
        absmag=row.absmag,
        ci=row.ci, spect=row.spect, name=row.name,
    )


def parent_letter_of(components: str) -> str:
    """First letter of the WDS components field — sub-pair detector key.

    'AB', 'AC', 'AD', 'Aa,Ab', 'Aa1,2', 'AB-C' → 'A' (top-level).
    'BC', 'Ba,Bb' → 'B' (sub-pair of B).
    'CD' → 'C' (sub-pair of C).
    """
    s = (components or '').strip()
    return s[0:1].upper() if s else 'A'


# ────────────────────────────────────────────────────────────────────────────
# Regime selection + per-pair processing
# ────────────────────────────────────────────────────────────────────────────

@dataclass
class ComponentRow:
    system_id: str
    comp: str
    hip: str           # int as string, or 'SYN-NNN'
    x_pc: float
    y_pc: float
    z_pc: float
    absmag: float
    ci: float | None
    spect: str
    name: str
    source: str
    regime: int

    def as_tsv_fields(self) -> list[str]:
        return [
            self.system_id,
            self.comp,
            self.hip,
            f'{self.x_pc:.9f}',
            f'{self.y_pc:.9f}',
            f'{self.z_pc:.9f}',
            f'{self.absmag:.3f}',
            '' if self.ci is None else f'{self.ci:.3f}',
            self.spect,
            self.name,
            self.source,
            str(self.regime),
        ]


_ALPHA_PREFIX_RE = re.compile(r'^([A-Za-z]+)')


def split_components(components_field: str) -> tuple[str, str]:
    """'AB' → ('A','B'); 'AC' → ('A','C'); 'Aa,Ab' → ('Aa','Ab'); 'AB-C' → ('AB','C').

    'Aa1,2' → ('Aa1','Aa2') — the bare-digit secondary inherits the alphabet
    prefix of the primary.
    """
    f = components_field.strip()
    if not f:
        return 'A', 'B'
    sep = ',' if ',' in f else ('-' if '-' in f else '')
    if sep:
        a, _, b = f.partition(sep)
        a, b = a.strip(), b.strip()
        if b and b.isdigit():
            m = _ALPHA_PREFIX_RE.match(a)
            if m:
                b = m.group(1) + b
        return a, b
    if len(f) >= 2:
        return f[0], f[1:]
    return f, 'B'


def synth_hip_id(counter: int) -> str:
    return f'SYN-{counter:03d}'


def process_pair(
    pair: WdsPair,
    anchor: PrimaryAnchor,
    orb6_entry: Orb6Entry | None,
    athyg_b: AthygRow | None,
    gaia_a: GaiaPairData | None,
    gaia_b: GaiaPairData | None,
    synth_counter: list[int],
) -> tuple[list[ComponentRow], str, int] | None:
    """Build the (A, B) component rows for one accepted pair. None to drop.

    `anchor` is the pair's A-side primary — either a top-level AT-HYG row
    (`anchor_from_athyg`) or a sub-pair anchor inherited from a previously-
    resolved parent (e.g. Castor's Ba,Bb inherits anchor = Castor B from the
    earlier-processed STF1110 AB pair's secondary).
    """
    keep, filter_tag = keep_pair(pair, gaia_a, gaia_b)
    if not keep:
        return None

    comp_a, comp_b = split_components(pair.components)

    # ──── Regime selection
    regime = 0
    src_orbit_tag = ''
    rho_theta: tuple[float, float] | None = None
    if orb6_entry and orb6_entry.P_yr and orb6_entry.a_arcsec is not None and orb6_entry.e is not None \
            and orb6_entry.omega_deg is not None and orb6_entry.Omega_deg is not None \
            and not math.isnan(orb6_entry.T0_jd):
        if orb6_entry.i_deg is None:
            # Regime 3 — spectroscopic-only: PA=0, separation magnitude = a (a·sin i).
            regime = 3
            rho_theta = (orb6_entry.a_arcsec, 0.0)
            src_orbit_tag = f':orb6-spec:{orb6_entry.ref}'
        else:
            regime = 2
            rho_theta = orbit_to_sky_offset(
                P_yr=orb6_entry.P_yr,
                T0_jd=orb6_entry.T0_jd,
                e=orb6_entry.e,
                a_arcsec=orb6_entry.a_arcsec,
                i_deg=orb6_entry.i_deg,
                omega_deg=orb6_entry.omega_deg,
                Omega_deg=orb6_entry.Omega_deg,
            )
            src_orbit_tag = f':orb6:{orb6_entry.ref}'

    if rho_theta is None:
        if pair.rho_last is not None and pair.theta_last is not None:
            regime = 1
            rho_theta = (pair.rho_last, pair.theta_last)
        else:
            return None  # nothing to project

    rho, theta = rho_theta

    # Tangent-plane basis = anchor's (ra, dec) — consistent with the anchor's
    # xyz frame. For top-level pairs this is AT-HYG's recorded ra/dec; for
    # sub-pairs it's the parent's projected sky position.
    dx, dy, dz = sky_offset_to_icrs_xyz(
        anchor.ra_deg, anchor.dec_deg, rho, theta, anchor.dist_pc,
    )

    bx, by, bz = anchor.x_pc + dx, anchor.y_pc + dy, anchor.z_pc + dz

    # ──── Component rows
    source = f'wds[{filter_tag}]{src_orbit_tag}'
    rows: list[ComponentRow] = []

    # A — uses the anchor (real AT-HYG for top-level, inherited for sub-pair).
    rows.append(ComponentRow(
        system_id=pair.wds_id,
        comp=comp_a,
        hip=anchor.hip_str,
        x_pc=anchor.x_pc, y_pc=anchor.y_pc, z_pc=anchor.z_pc,
        absmag=anchor.absmag,
        ci=anchor.ci,
        spect=anchor.spect,
        name=anchor.name,
        source=source,
        regime=regime,
    ))

    # B — synthesised position; HIP from cone-match / notes-supplement if found.
    if athyg_b is not None:
        b_hip_str = str(athyg_b.hip)
        b_absmag = athyg_b.absmag
        b_ci = athyg_b.ci
        b_spect = athyg_b.spect
        b_name = athyg_b.name
    else:
        synth_counter[0] += 1
        b_hip_str = synth_hip_id(synth_counter[0])
        # Estimate absmag for the secondary from WDS mag_sec - mag_pri delta
        # added to A's absmag (distance modulus cancels).
        if pair.mag_pri is not None and pair.mag_sec is not None:
            b_absmag = anchor.absmag + (pair.mag_sec - pair.mag_pri)
        else:
            b_absmag = anchor.absmag + 2.0  # conservative dimming
        b_ci = anchor.ci
        b_spect = pair.spectral or anchor.spect
        # Synthesise a search-friendly name: "Sirius B", "Castor Ab", etc.
        # Only when the anchor has a proper name — otherwise leave blank so
        # unknown systems don't pollute search with cryptic labels.
        b_name = f'{anchor.name} {comp_b}' if anchor.name else ''

    rows.append(ComponentRow(
        system_id=pair.wds_id,
        comp=comp_b,
        hip=b_hip_str,
        x_pc=bx, y_pc=by, z_pc=bz,
        absmag=b_absmag,
        ci=b_ci,
        spect=b_spect,
        name=b_name,
        source=source,
        regime=regime,
    ))
    return rows, filter_tag, regime


# ────────────────────────────────────────────────────────────────────────────
# Overrides
# ────────────────────────────────────────────────────────────────────────────

def parse_overrides(path: Path) -> list[ComponentRow]:
    if not path.exists():
        return []
    rows: list[ComponentRow] = []
    with path.open(newline='') as fh:
        # Skip leading comment lines starting with '#'.
        lines = [ln for ln in fh if ln.strip() and not ln.lstrip().startswith('#')]
    if not lines:
        return rows
    reader = csv.DictReader(lines, delimiter='\t')
    for r in reader:
        try:
            rows.append(ComponentRow(
                system_id=r['system_id'].strip(),
                comp=r['comp'].strip(),
                hip=r['hip'].strip(),
                x_pc=float(r['x_pc']),
                y_pc=float(r['y_pc']),
                z_pc=float(r['z_pc']),
                absmag=float(r['absmag']),
                ci=safe_float(r.get('ci', '')),
                spect=(r.get('spect') or '').strip(),
                name=(r.get('name') or '').strip(),
                source=(r.get('source') or 'override').strip() or 'override',
                regime=int(r.get('regime') or 0),
            ))
        except (KeyError, ValueError) as exc:
            print(f'warning: skipping malformed override row: {exc}', file=sys.stderr)
    return rows


def apply_overrides(
    base: list[ComponentRow], overrides: list[ComponentRow],
) -> list[ComponentRow]:
    """Override rows with matching (system_id, comp) replace; novel keys append."""
    by_key = {(r.system_id, r.comp): i for i, r in enumerate(base)}
    out = list(base)
    for o in overrides:
        key = (o.system_id, o.comp)
        if key in by_key:
            out[by_key[key]] = o
        else:
            by_key[key] = len(out)
            out.append(o)
    return out


def write_overrides_scaffold(path: Path) -> None:
    """Create an empty overrides file with header + comment block, if missing."""
    if path.exists():
        return
    header = '\t'.join(OVERRIDE_COLUMNS)
    body = (
        '# data/multiples-overrides.tsv — hand-curated edge cases for the\n'
        '# multiple-star pipeline. Loaded last by scripts/build-binaries.py;\n'
        '# rows matching (system_id, comp) on a programmatic entry replace it,\n'
        '# rows with a novel key append. hip = integer HIP or SYN-NNN sentinel.\n'
        '# Lines starting with # are ignored. Edit by hand only — do not\n'
        '# regenerate from upstream.\n'
        '#\n'
        f'{header}\n'
    )
    path.write_text(body)


# ────────────────────────────────────────────────────────────────────────────
# Output
# ────────────────────────────────────────────────────────────────────────────

def write_multiples(path: Path, rows: list[ComponentRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w') as fh:
        fh.write('\t'.join(OUTPUT_COLUMNS) + '\n')
        for r in rows:
            fh.write('\t'.join(r.as_tsv_fields()) + '\n')


# ────────────────────────────────────────────────────────────────────────────
# Idempotency
# ────────────────────────────────────────────────────────────────────────────

def is_up_to_date() -> bool:
    if not OUT_MULTIPLES.exists():
        return False
    out_mtime = OUT_MULTIPLES.stat().st_mtime
    sources = [Path(__file__), SRC_WDS_SUMM, SRC_WDS_NOTES, SRC_ORB6, SRC_ATHYG, OVERRIDES_PATH]
    if SRC_GAIA.exists():
        sources.append(SRC_GAIA)
    for src in sources:
        if src.exists() and src.stat().st_mtime > out_mtime:
            return False
    return True


# ────────────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--force', action='store_true',
                    help='rebuild even if outputs are newer than inputs')
    args = ap.parse_args()

    if not args.force and is_up_to_date():
        print('multiples.tsv up to date — skipping (use --force to rebuild)')
        return

    for required in (SRC_WDS_SUMM, SRC_WDS_NOTES, SRC_ORB6, SRC_ATHYG):
        if not required.exists():
            print(f'error: missing {required}', file=sys.stderr)
            sys.exit(1)

    print(f'reading {SRC_ATHYG.relative_to(ROOT)} …')
    athyg = parse_athyg(SRC_ATHYG)
    athyg_rows = list(athyg.values())
    index = SkyTileIndex(athyg_rows)
    print(f'  {len(athyg)} AT-HYG rows with HIP indexed')

    print(f'reading {SRC_ORB6.relative_to(ROOT)} …')
    orb6 = parse_orb6(SRC_ORB6)
    print(f'  {sum(len(v) for v in orb6.values())} ORB6 entries across {len(orb6)} system/component keys')

    print(f'reading {SRC_WDS_SUMM.relative_to(ROOT)} …')
    pairs = parse_wds_summ(SRC_WDS_SUMM)
    print(f'  {len(pairs)} WDS pairs')

    print(f'reading {SRC_WDS_NOTES.relative_to(ROOT)} …')
    notes = parse_wds_notes(SRC_WDS_NOTES)
    print(f'  HIP prose-cross-refs for {len(notes)} WDS systems')

    gaia: dict[tuple[str, str], GaiaPairData] = {}
    if SRC_GAIA.exists():
        print(f'reading {SRC_GAIA.relative_to(ROOT)} …')
        gaia = parse_gaia(SRC_GAIA)
        print(f'  {len(gaia)} Gaia DR3 component astrometric rows')
    else:
        print(f'note: {SRC_GAIA.relative_to(ROOT)} missing — optical filter '
              'falls back to WDS-Notes + sanity heuristic')

    # ──── Per-system, per-pair processing
    # Group pairs by WDS system; within each system, process A-led pairs
    # before B-led / C-led sub-pairs so sub-pairs can inherit their parent's
    # resolved position. Sirius BC and Castor's Ba,Bb-style entries are the
    # canonical case — without this ordering the WDS components field's
    # implicit hierarchy is lost and Ba ends up grafted onto A's HIP.
    from collections import defaultdict
    by_system: dict[str, list[WdsPair]] = defaultdict(list)
    for p in pairs:
        by_system[p.wds_id].append(p)
    for group in by_system.values():
        group.sort(key=lambda p: (parent_letter_of(p.components), p.components))

    component_rows: list[ComponentRow] = []
    synth_counter = [0]
    stats = {
        'pairs_seen': len(pairs),
        'no_hip_a': 0,
        'no_athyg_a': 0,
        'no_parent_anchor': 0,
        'no_geometry': 0,
        'optical': 0,
        'kept': 0,
        'regime_1': 0,
        'regime_2': 0,
        'regime_3': 0,
        'orb6_matched': 0,
        'synth_b': 0,
        'athyg_b': 0,
        'sub_pair': 0,
    }

    for wds_id, group in by_system.items():
        # Per-system map of resolved sub-system anchors, keyed by first
        # component letter. Populated as pairs in this system are processed
        # in (A, B, C, …) order.
        resolved: dict[str, PrimaryAnchor] = {}

        for pair in group:
            comp_a, comp_b = split_components(pair.components)
            pletter = parent_letter_of(pair.components)
            is_sub_pair = pletter != 'A'

            # ──── Determine the A anchor for this pair
            if is_sub_pair:
                parent_anchor = resolved.get(pletter)
                if parent_anchor is None:
                    stats['no_parent_anchor'] += 1
                    continue
                anchor = parent_anchor
                # No need for a second ORB6 lookup specific to the sub-pair;
                # use whatever ORB6 entry exists at this (wds_id, components).
                orb6_entries = orb6.get((pair.wds_id, pair.components))
                stats['sub_pair'] += 1
            else:
                # Top-level pair — resolve primary HIP via ORB6 / cone-match /
                # WDS-notes prose.
                orb6_entries = orb6.get((pair.wds_id, pair.components))
                primary_hip: int | None = None
                if orb6_entries:
                    for e in orb6_entries:
                        if e.hip:
                            primary_hip = e.hip
                            break
                if primary_hip is None and pair.precise_ra_deg is not None:
                    hits = cone_match_hips(index, pair.precise_ra_deg, pair.precise_dec_deg)
                    if hits:
                        primary_hip = hits[0]
                if primary_hip is None:
                    for hip in notes.get(pair.wds_id, []):
                        if hip in athyg:
                            primary_hip = hip
                            break
                if primary_hip is None:
                    stats['no_hip_a'] += 1
                    continue
                athyg_a = athyg.get(primary_hip)
                if athyg_a is None:
                    stats['no_athyg_a'] += 1
                    continue
                anchor = anchor_from_athyg(athyg_a)

            # ──── Best ORB6 fit (grade tiebreak)
            orb6_best = pick_best_orb6(orb6_entries) if orb6_entries else None
            if orb6_best is not None:
                stats['orb6_matched'] += 1

            # ──── B's HIP via cone-match around the projected sky position
            # of the secondary. Only attempted for top-level pairs; sub-pair
            # secondaries inherit the synthesised name path from the anchor.
            athyg_b: AthygRow | None = None
            if not is_sub_pair and pair.rho_last is not None and pair.theta_last is not None:
                b_ra, b_dec = project_sky(
                    anchor.ra_deg, anchor.dec_deg,
                    pair.rho_last, pair.theta_last,
                )
                anchor_hip = int(anchor.hip_str) if anchor.hip_str.isdigit() else -1
                for hip in cone_match_hips(index, b_ra, b_dec, SECONDARY_CONE_MATCH_RADIUS_ARCSEC):
                    if hip != anchor_hip and hip in athyg:
                        athyg_b = athyg[hip]
                        break

            gaia_a = gaia.get((pair.wds_id, comp_a))
            gaia_b = gaia.get((pair.wds_id, comp_b))

            result = process_pair(
                pair=pair,
                anchor=anchor,
                orb6_entry=orb6_best,
                athyg_b=athyg_b,
                gaia_a=gaia_a,
                gaia_b=gaia_b,
                synth_counter=synth_counter,
            )
            if result is None:
                if process_pair_was_optical(pair, gaia_a, gaia_b):
                    stats['optical'] += 1
                else:
                    stats['no_geometry'] += 1
                continue
            rows, _filter_tag, regime = result
            component_rows.extend(rows)
            stats['kept'] += 1
            stats[f'regime_{regime}'] += 1
            if athyg_b is None:
                stats['synth_b'] += 1
            else:
                stats['athyg_b'] += 1

            # ──── Register this pair's resolved A and B for sub-pair lookup.
            # Keyed by the first character of each component label so e.g.
            # 'B' from 'AB' pair becomes the anchor for a future 'Ba,Bb' or
            # 'BC' sub-pair within the same WDS system.
            a_letter = comp_a[0:1].upper() if comp_a else 'A'
            b_letter = comp_b[0:1].upper() if comp_b else 'B'
            if a_letter and a_letter not in resolved:
                resolved[a_letter] = anchor
            if b_letter and b_letter not in resolved:
                resolved[b_letter] = PrimaryAnchor(
                    hip_str=rows[1].hip,
                    ra_deg=anchor.ra_deg, dec_deg=anchor.dec_deg,  # approximate; only used as tangent basis
                    x_pc=rows[1].x_pc, y_pc=rows[1].y_pc, z_pc=rows[1].z_pc,
                    dist_pc=anchor.dist_pc,
                    absmag=rows[1].absmag,
                    ci=rows[1].ci,
                    spect=rows[1].spect,
                    name=rows[1].name,
                )

    # ──── Overrides
    write_overrides_scaffold(OVERRIDES_PATH)
    overrides = parse_overrides(OVERRIDES_PATH)
    if overrides:
        print(f'applying {len(overrides)} overrides from {OVERRIDES_PATH.relative_to(ROOT)}')
    component_rows = apply_overrides(component_rows, overrides)

    # ──── Write outputs
    write_multiples(OUT_MULTIPLES, component_rows)
    write_upload_csv_from_components(OUT_UPLOAD, component_rows, athyg)

    # ──── Print stats
    print()
    print(f'wrote {OUT_MULTIPLES.relative_to(ROOT)}: {len(component_rows)} component rows')
    print(f'  pairs seen        : {stats["pairs_seen"]}')
    print(f'  no primary HIP    : {stats["no_hip_a"]}')
    print(f'  no AT-HYG row     : {stats["no_athyg_a"]}')
    print(f'  no parent anchor  : {stats["no_parent_anchor"]}  (sub-pair whose parent letter never resolved)')
    print(f'  optical-filt      : {stats["optical"]}')
    print(f'  no geometry       : {stats["no_geometry"]}')
    print(f'  kept              : {stats["kept"]}')
    print(f'    regime 1 (ρ/θ visual)         : {stats["regime_1"]}')
    print(f'    regime 2 (ORB6 orbit)          : {stats["regime_2"]}')
    print(f'    regime 3 (ORB6 spectroscopic)  : {stats["regime_3"]}')
    print(f'  ORB6 matched      : {stats["orb6_matched"]}')
    print(f'  sub-pairs         : {stats["sub_pair"]}  (anchored to a previously-resolved B/C/…)')
    print(f'  B from AT-HYG     : {stats["athyg_b"]}')
    print(f'  B synth (SYN-)    : {stats["synth_b"]}')
    print(f'  overrides         : {len(overrides)}')
    print(f'wrote {OUT_UPLOAD.relative_to(ROOT)}: {len(component_rows)} component coords for Gaia upload')


def process_pair_was_optical(
    pair: WdsPair,
    gaia_a: GaiaPairData | None,
    gaia_b: GaiaPairData | None,
) -> bool:
    keep, _ = keep_pair(pair, gaia_a, gaia_b)
    return not keep


def write_upload_csv_from_components(
    path: Path,
    rows: list[ComponentRow],
    athyg: dict[int, AthygRow],
) -> None:
    """Emit Gaia upload CSV from the final component rows.

    For each component, derive its (ra_deg, dec_deg) from xyz. Pure components
    keep AT-HYG's recorded ra/dec when their HIP exists; synthesised ones get
    derived coords from the projected xyz.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['wds_id', 'comp', 'ra_deg', 'dec_deg'])
        for r in rows:
            athyg_row = athyg.get(int(r.hip)) if r.hip.isdigit() else None
            if athyg_row is not None:
                ra, dec = athyg_row.ra_deg, athyg_row.dec_deg
            else:
                norm = math.sqrt(r.x_pc ** 2 + r.y_pc ** 2 + r.z_pc ** 2)
                if norm <= 0:
                    continue
                ra = math.degrees(math.atan2(r.y_pc, r.x_pc)) % 360.0
                dec = math.degrees(math.asin(r.z_pc / norm))
            w.writerow([r.system_id, r.comp, f'{ra:.6f}', f'{dec:.6f}'])


if __name__ == '__main__':
    main()
