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
                     astroquery.gaia, then CDS TAP via pyvo.
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
    .venv/bin/python -m unittest scripts/refresh_lib.test.py
"""

from __future__ import annotations

import random
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence, TypeVar

T = TypeVar("T")
R = TypeVar("R")


# ─── Idempotency ──────────────────────────────────────────────────────

def is_up_to_date(output: Path, sources: Iterable[Path]) -> bool:
    """True iff `output` exists and is newer than every path in `sources`.

    Callers should include `Path(__file__)` of the refresh script so logic
    changes invalidate the cached output. A missing source is treated as
    stale rather than ignored — refusing to skip is safer than silently
    keeping a possibly-out-of-date output.
    """
    if not output.exists():
        return False
    out_mtime = output.stat().st_mtime
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
            return any(np.issubdtype(dtype, w) for w in wants)
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


def _default_backends() -> list[TapBackend]:
    """Build the default ESA + CDS backend list. Lazy imports keep this lib
    importable without astroquery/pyvo installed."""

    def esa_run(query: str) -> Any:
        from astroquery.gaia import Gaia
        return Gaia.launch_job_async(query).get_results()

    def cds_run(query: str) -> Any:
        import pyvo
        service = pyvo.dal.TAPService("https://tapvizier.u-strasbg.fr/TAPVizieR/tap")
        return service.search(query).to_table()

    return [
        TapBackend(name="ESA", run=esa_run),
        TapBackend(name="CDS", run=cds_run),
    ]


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
    round to `round_floats` decimal places when set."""
    output.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with output.open("w", encoding="utf-8") as f:
        f.write("\t".join(columns) + "\n")
        for row in rows:
            cells: list[str] = []
            for col in columns:
                v = row.get(col)
                if v is None:
                    cells.append("")
                elif isinstance(v, float) and round_floats is not None:
                    cells.append(f"{v:.{round_floats}f}")
                else:
                    cells.append(str(v))
            f.write("\t".join(cells) + "\n")
            n += 1
    return n
