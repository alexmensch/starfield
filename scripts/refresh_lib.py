#!/usr/bin/env python3
"""Shared infrastructure for Phase 1 catalogue-refresh scripts.

Each refresh script (refresh-gaia-hip-xmatch.py, refresh-hipparcos2.py,
refresh-gaia-nss.py, refresh-gaia-tyc-xmatch.py, refresh-gaia-astrometry.py,
refresh-simbad-sample.py, refresh-bailer-jones.py, refresh-gaia-apsis.py)
runs ADQL against an external archive and writes a TSV under data/ that
is then committed (LFS where >1 MB). These scripts are MANUAL-RUN — they
are NOT part of `npm run build`.

Provides:
  TapClient        — backend-agnostic TAP wrapper. Tries each backend in
                     order; auto-falls-back to the next on 5xx / connection
                     errors. Default backends: ESA Gaia archive via
                     astroquery.gaia, then CDS TAP via pyvo. SIMBAD
                     (simbad_backend) speaks a divergent ADQL dialect and
                     is always used as a single-backend override.
  retry            — exponential-backoff retry over a callable, with
                     injectable transient-error classifier, sleep, and
                     RNG hooks for deterministic testing.
  run_batched      — chunked-query helper for `WHERE id IN (...)` style
                     queries where the id list exceeds TAP IN-clause limits.
  validate_schema  — assert column names + dtypes on the returned table
                     (astropy Table / pandas DataFrame / dict-of-columns).
  is_up_to_date    — mtime-based idempotency check; mirrors the
                     scripts/build-clouds.py pattern.
  write_tsv        — canonical tab-separated writer (header + rows;
                     None → empty cell; optional float rounding).

Venv setup:
    python3 -m venv .venv
    .venv/bin/pip install -r scripts/requirements-refresh.txt

Test (no network):
    .venv/bin/python scripts/refresh_lib.test.py
"""

from __future__ import annotations

import os
import random
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence, TypeVar

T = TypeVar("T")
R = TypeVar("R")


# ─── Idempotency ──────────────────────────────────────────────────────

_LIB_PATH = Path(__file__).resolve()


def is_up_to_date(output: Path, sources: Iterable[Path]) -> bool:
    """True iff `output` exists and is newer than every path in `sources`
    AND newer than refresh_lib.py itself.

    Callers pass the refresh script's `Path(__file__)` plus any data
    inputs; refresh_lib's own mtime is folded in automatically so a fix
    to `coerce_masked`, `write_tsv`, `_dtype_matches`, or the atomic-
    rename plumbing invalidates every cached output without each caller
    having to list `Path(refresh_lib.__file__)` explicitly. A missing
    source is treated as stale rather than ignored — refusing to skip
    is safer than silently keeping a possibly-out-of-date output.
    """
    if not output.exists():
        return False
    out_mtime = output.stat().st_mtime
    if _LIB_PATH.stat().st_mtime > out_mtime:
        return False
    for src in sources:
        if not src.exists() or src.stat().st_mtime > out_mtime:
            return False
    return True


# ─── Retry ────────────────────────────────────────────────────────────

class TransientError(Exception):
    """Synthetic transient error used by callers (and tests) that want to
    signal 'please retry' without having to construct a real `requests`
    exception. The default classifier treats this as transient."""


def is_transient_http_error(exc: BaseException) -> bool:
    """Default classifier: True for 5xx HTTP responses, network-level
    errors, and `TransientError`. Imports `requests` and `pyvo` lazily so
    this lib remains importable in environments that don't have them
    (the test file uses synthetic exceptions only)."""
    if isinstance(exc, TransientError):
        return True
    try:
        import requests
        if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
            return True
        if isinstance(exc, requests.HTTPError) and exc.response is not None:
            return 500 <= exc.response.status_code < 600
    except ImportError:
        pass
    try:
        import pyvo
        if isinstance(exc, pyvo.dal.DALServiceError):
            return True
    except ImportError:
        pass
    return False


def retry(
    fn: Callable[[], T],
    *,
    max_attempts: int = 4,
    base_delay_s: float = 1.0,
    backoff: float = 2.0,
    jitter: float = 0.25,
    is_transient: Callable[[BaseException], bool] = is_transient_http_error,
    sleep: Callable[[float], None] = time.sleep,
    rand: Callable[[], float] = random.random,
) -> T:
    """Call `fn` with exponential-backoff retry on transient errors.

    Attempt N (1..max_attempts): if `fn` returns, return its value. If it
    raises, ask `is_transient` — non-transient errors and the final
    attempt re-raise immediately. Sleep before attempt N+1 is
    `base_delay_s * backoff**(N-1)`, scaled by a random factor in
    `[1 - jitter, 1 + jitter]`. `sleep` and `rand` are injectable so
    tests can run synchronously and deterministically.
    """
    if max_attempts < 1:
        raise ValueError(f"max_attempts must be >= 1, got {max_attempts}")
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as exc:
            if attempt >= max_attempts or not is_transient(exc):
                raise
            delay = base_delay_s * (backoff ** (attempt - 1))
            delay *= 1.0 + (rand() * 2.0 - 1.0) * jitter
            sleep(max(0.0, delay))
    raise RuntimeError("retry: unreachable — loop must return or raise")


# ─── Batched query ────────────────────────────────────────────────────

def run_batched(
    ids: Sequence[Any],
    batch_size: int,
    query_fn: Callable[[Sequence[Any]], Iterable[R]],
) -> list[R]:
    """Chunk `ids` into batches of `batch_size`, call `query_fn(batch)`
    for each, return the concatenated row list. Empty `ids` returns []."""
    if batch_size <= 0:
        raise ValueError(f"batch_size must be positive, got {batch_size}")
    out: list[R] = []
    for i in range(0, len(ids), batch_size):
        out.extend(query_fn(ids[i : i + batch_size]))
    return out


# ─── Schema validation ────────────────────────────────────────────────

class SchemaError(Exception):
    """Raised by validate_schema when actual columns / dtypes don't match
    the expected mapping."""


def validate_schema(
    table: Any,
    expected: Mapping[str, type | tuple[type, ...]],
    *,
    label: str = "table",
) -> None:
    """Validate column names + dtypes of an astropy Table, pandas DataFrame,
    or dict-of-columns. Each `expected` entry is a column name → expected
    Python base type or tuple of types. Extra columns in `table` are
    allowed; missing columns or mismatched dtypes raise SchemaError.
    """
    colnames = _column_names(table)
    missing = [c for c in expected if c not in colnames]
    if missing:
        raise SchemaError(f"{label}: missing columns {missing}")
    for col, want in expected.items():
        dtype = _column_dtype(table, col)
        if not _dtype_matches(dtype, want):
            raise SchemaError(
                f"{label}: column {col!r} has dtype {dtype!r}, expected {want!r}"
            )


def _column_names(table: Any) -> list[str]:
    if hasattr(table, "colnames"):
        return list(table.colnames)
    if hasattr(table, "columns") and not isinstance(table, dict):
        return list(table.columns)
    return list(table.keys())


def _column_dtype(table: Any, col: str) -> Any:
    column = table[col]
    return getattr(column, "dtype", type(column))


def _dtype_matches(dtype: Any, want: type | tuple[type, ...]) -> bool:
    wants = want if isinstance(want, tuple) else (want,)
    try:
        import numpy as np
        if isinstance(dtype, np.dtype):
            # NumPy 2.x: np.issubdtype(int32, int) is False — only int64 is
            # a subdtype of Python int (similarly float32 vs float). Map
            # Python builtins to numpy abstract supertypes so int / float
            # match every width. `str` accepts both fixed-width unicode
            # arrays (<UN) and object-dtype arrays (Gaia TAP returns the
            # latter for variable-length string columns).
            np_supertypes: dict[type, tuple[type, ...]] = {
                int: (np.integer,),
                float: (np.floating,),
                bool: (np.bool_,),
                complex: (np.complexfloating,),
                str: (np.character, np.object_),
            }
            return any(
                any(np.issubdtype(dtype, t) for t in np_supertypes.get(w, (w,)))
                for w in wants
            )
    except ImportError:
        pass
    if isinstance(dtype, type):
        return any(issubclass(dtype, w) for w in wants)
    return dtype in wants


# ─── TAP client ───────────────────────────────────────────────────────

class TapBackend:
    """One TAP service endpoint. `run(adql)` executes the query and returns
    the result table (astropy Table or equivalent). Test backends can return
    any iterable of row mappings."""

    def __init__(self, name: str, run: Callable[[str], Any]) -> None:
        self.name = name
        self.run = run


class TapClient:
    """Backend-agnostic TAP client with auto-fallback.

    Tries each backend in order on every query; falls back to the next on a
    transient (network-level or 5xx) error. Non-transient errors (e.g.
    ADQL syntax) raise from the first backend that returns them — both
    backends share the same ADQL grammar so a syntax error fails the
    same way on either.

    Default backends:
      1. ESA Gaia archive via astroquery.gaia (best Gaia coverage)
      2. CDS TAP (tapvizier.u-strasbg.fr) via pyvo

    Override via `backends=` for SIMBAD-only or VizieR-only tables.
    """

    def __init__(
        self,
        backends: Sequence[TapBackend] | None = None,
        *,
        retry_kwargs: Mapping[str, Any] | None = None,
    ) -> None:
        self.backends = list(backends) if backends is not None else _default_backends()
        if not self.backends:
            raise ValueError("TapClient requires at least one backend")
        self.retry_kwargs = dict(retry_kwargs or {})

    def run(self, query: str) -> Any:
        last_transient: BaseException | None = None
        for backend in self.backends:
            try:
                return retry(lambda b=backend: b.run(query), **self.retry_kwargs)
            except Exception as exc:
                if not is_transient_http_error(exc):
                    raise
                last_transient = exc
        assert last_transient is not None  # at least one backend, all transient
        raise last_transient


CDS_TAP_URL = "https://tapvizier.u-strasbg.fr/TAPVizieR/tap"
SIMBAD_TAP_URL = "https://simbad.cds.unistra.fr/simbad/sim-tap"


def _esa_run(query: str) -> Any:
    from astroquery.gaia import Gaia
    return Gaia.launch_job_async(query).get_results()


def _cds_run(query: str) -> Any:
    import pyvo
    service = pyvo.dal.TAPService(CDS_TAP_URL)
    return service.search(query).to_table()


def _simbad_run(query: str) -> Any:
    import pyvo
    service = pyvo.dal.TAPService(SIMBAD_TAP_URL)
    return service.search(query).to_table()


def esa_backend() -> TapBackend:
    """ESA Gaia archive backend (gaiadr3.* tables, full DR3 catalogue)."""
    return TapBackend(name="ESA", run=_esa_run)


def cds_backend() -> TapBackend:
    """CDS / VizieR TAP backend. Required for VizieR-only tables (e.g.
    Bailer-Jones I/352/gedr3dis, Hipparcos-2 I/311/hip2) that ESA does
    not host."""
    return TapBackend(name="CDS", run=_cds_run)


def simbad_backend() -> TapBackend:
    """SIMBAD TAP backend (basic, ident, allfluxes, otypedef, mes*
    tables). Used by refresh-simbad-sample.py as a single-backend override
    — SIMBAD speaks its own dialect (LIKE forbidden on basic.otype; MOD()
    available but `%` operator is not) and is not interchangeable with
    ESA or CDS for these tables, so callers pass `backends=[simbad_backend()]`
    explicitly rather than relying on the default fallback list."""
    return TapBackend(name="SIMBAD", run=_simbad_run)


def _default_backends() -> list[TapBackend]:
    """Default ESA → CDS fallback list. Lazy imports keep this lib
    importable without astroquery/pyvo installed."""
    return [esa_backend(), cds_backend()]


# ─── Masked-value normaliser ──────────────────────────────────────────

def coerce_masked(value: Any) -> Any:
    """Convert astropy/numpy masked values to None for clean TSV nulls.

    Astropy MaskedColumn elements return `numpy.ma.masked` (a
    MaskedConstant) for missing cells; `str(np.ma.masked)` is "--" which
    would corrupt the TSV via write_tsv's `str(v)` fallback. Coerce to
    None so write_tsv emits an empty cell. Object-dtype string columns
    return masked as `--` strings too — the MaskedConstant isinstance
    check catches those.
    """
    try:
        import numpy as np
        if value is np.ma.masked:
            return None
        if isinstance(value, np.ma.core.MaskedConstant):
            return None
    except ImportError:
        pass
    return value


# ─── TSV writer ───────────────────────────────────────────────────────

def write_tsv(
    rows: Iterable[Mapping[str, Any]],
    columns: Sequence[str],
    output: Path,
    *,
    round_floats: int | None = None,
) -> int:
    """Write `rows` to `output` as tab-separated values with a header line.
    Returns the row count written. None values become empty cells; floats
    (Python float OR numpy floating width) round to `round_floats` decimal
    places when set.

    Atomic: writes to ``output.with_suffix(output.suffix + ".tmp")`` and
    swaps in via ``os.replace`` once the row stream completes. Any
    mid-stream failure (disk full, KeyboardInterrupt, masked-cell coerce
    raising, OOM on a large batch) leaves the committed output untouched
    — never half-written — and the ``.tmp`` sibling is cleaned up so a
    future ``is_up_to_date`` check can't be fooled by a stale partial.
    POSIX ``rename(2)`` guarantees the swap is atomic on the same
    filesystem, which the sibling-path layout ensures.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(output.suffix + ".tmp")
    n = 0
    try:
        with tmp.open("w", encoding="utf-8") as f:
            f.write("\t".join(columns) + "\n")
            for row in rows:
                cells: list[str] = []
                for col in columns:
                    v = row.get(col)
                    if v is None:
                        cells.append("")
                    elif round_floats is not None and _is_float(v):
                        cells.append(f"{float(v):.{round_floats}f}")
                    else:
                        cells.append(str(v))
                f.write("\t".join(cells) + "\n")
                n += 1
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, output)
    return n


def _is_float(v: Any) -> bool:
    """True for Python float or any numpy floating width. NumPy 2.x stopped
    treating np.float32 as a Python-float subclass, so a plain isinstance
    check would miss astroquery's float32 columns."""
    if isinstance(v, float):
        return True
    try:
        import numpy as np
        return isinstance(v, np.floating)
    except ImportError:
        return False
