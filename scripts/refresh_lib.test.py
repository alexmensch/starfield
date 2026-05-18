#!/usr/bin/env python3
"""Unit tests for refresh_lib.

No network. Uses synthetic exceptions (`TransientError`) and in-memory
backends so the suite runs in < 1 s without astroquery / pyvo installed.

Run:
    python3 -m unittest scripts/refresh_lib.test.py
"""

from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import refresh_lib as rl  # noqa: E402


# ─── retry ────────────────────────────────────────────────────────────

class RetryTests(unittest.TestCase):
    def test_returns_first_attempt(self) -> None:
        calls = []
        def fn() -> int:
            calls.append(1)
            return 42
        self.assertEqual(rl.retry(fn, sleep=lambda _: None), 42)
        self.assertEqual(len(calls), 1)

    def test_retries_transient_then_succeeds(self) -> None:
        attempts = {"n": 0}
        sleeps: list[float] = []
        def fn() -> str:
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise rl.TransientError("503")
            return "ok"
        result = rl.retry(
            fn,
            max_attempts=4,
            base_delay_s=0.5,
            backoff=2.0,
            jitter=0.0,
            sleep=sleeps.append,
            rand=lambda: 0.5,
        )
        self.assertEqual(result, "ok")
        self.assertEqual(attempts["n"], 3)
        # 2 sleeps (between attempts 1→2 and 2→3); exponential with no jitter
        self.assertEqual(sleeps, [0.5, 1.0])

    def test_jitter_scales_delay(self) -> None:
        sleeps: list[float] = []
        attempts = {"n": 0}
        def fn() -> None:
            attempts["n"] += 1
            if attempts["n"] < 2:
                raise rl.TransientError()
        rl.retry(
            fn,
            max_attempts=2,
            base_delay_s=1.0,
            backoff=2.0,
            jitter=0.5,
            sleep=sleeps.append,
            rand=lambda: 1.0,  # max jitter
        )
        # 1.0 * (1 + (1.0*2 - 1)*0.5) = 1.0 * 1.5 = 1.5
        self.assertEqual(sleeps, [1.5])

    def test_non_transient_raises_immediately(self) -> None:
        calls = []
        def fn() -> None:
            calls.append(1)
            raise ValueError("syntax error")
        with self.assertRaises(ValueError):
            rl.retry(fn, sleep=lambda _: None)
        self.assertEqual(len(calls), 1)

    def test_exhausts_max_attempts(self) -> None:
        calls = []
        def fn() -> None:
            calls.append(1)
            raise rl.TransientError()
        with self.assertRaises(rl.TransientError):
            rl.retry(fn, max_attempts=3, sleep=lambda _: None)
        self.assertEqual(len(calls), 3)

    def test_max_attempts_validates(self) -> None:
        with self.assertRaises(ValueError):
            rl.retry(lambda: None, max_attempts=0)


# ─── run_batched ──────────────────────────────────────────────────────

class BatchedTests(unittest.TestCase):
    def test_chunks_input(self) -> None:
        batches: list[list[int]] = []
        def q(batch):
            batches.append(list(batch))
            return [x * 10 for x in batch]
        out = rl.run_batched([1, 2, 3, 4, 5], batch_size=2, query_fn=q)
        self.assertEqual(batches, [[1, 2], [3, 4], [5]])
        self.assertEqual(out, [10, 20, 30, 40, 50])

    def test_empty_input(self) -> None:
        calls = []
        def q(batch):
            calls.append(batch)
            return []
        self.assertEqual(rl.run_batched([], batch_size=10, query_fn=q), [])
        self.assertEqual(calls, [])

    def test_invalid_batch_size(self) -> None:
        with self.assertRaises(ValueError):
            rl.run_batched([1], batch_size=0, query_fn=lambda b: [])


# ─── validate_schema ──────────────────────────────────────────────────

class _FakeColumn:
    def __init__(self, dtype: type) -> None:
        self.dtype = dtype


class _FakeTable:
    """astropy-Table-shaped: has `colnames` and `__getitem__` returning a
    column with a `dtype` attribute."""
    def __init__(self, cols: dict[str, type]) -> None:
        self._cols = {k: _FakeColumn(v) for k, v in cols.items()}

    @property
    def colnames(self) -> list[str]:
        return list(self._cols)

    def __getitem__(self, name: str) -> _FakeColumn:
        return self._cols[name]


class SchemaTests(unittest.TestCase):
    def test_passes_when_columns_and_dtypes_match(self) -> None:
        table = _FakeTable({"hip": int, "source_id": int, "ra": float})
        rl.validate_schema(table, {"hip": int, "source_id": int, "ra": float})

    def test_allows_extra_columns(self) -> None:
        table = _FakeTable({"hip": int, "extra": str})
        rl.validate_schema(table, {"hip": int})

    def test_fails_on_missing_column(self) -> None:
        table = _FakeTable({"hip": int})
        with self.assertRaises(rl.SchemaError) as cm:
            rl.validate_schema(table, {"hip": int, "source_id": int})
        self.assertIn("missing columns", str(cm.exception))
        self.assertIn("source_id", str(cm.exception))

    def test_fails_on_wrong_dtype(self) -> None:
        table = _FakeTable({"hip": str})
        with self.assertRaises(rl.SchemaError) as cm:
            rl.validate_schema(table, {"hip": int})
        self.assertIn("hip", str(cm.exception))

    def test_accepts_tuple_of_types(self) -> None:
        table = _FakeTable({"v": float})
        rl.validate_schema(table, {"v": (int, float)})

    def test_accepts_dict_of_columns(self) -> None:
        # Validates the dict-of-columns fallback in _column_names.
        table = {"hip": _FakeColumn(int), "source_id": _FakeColumn(int)}
        rl.validate_schema(table, {"hip": int, "source_id": int})


# ─── is_up_to_date ────────────────────────────────────────────────────

class IdempotencyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name)
        self.addCleanup(self.dir.cleanup)

    def _touch(self, name: str, mtime: float | None = None) -> Path:
        p = self.path / name
        p.write_text("x")
        if mtime is not None:
            import os
            os.utime(p, (mtime, mtime))
        return p

    def test_false_when_output_missing(self) -> None:
        src = self._touch("src.py", mtime=1000.0)
        self.assertFalse(rl.is_up_to_date(self.path / "missing.tsv", [src]))

    def test_true_when_output_newer(self) -> None:
        src = self._touch("src.py", mtime=1000.0)
        out = self._touch("out.tsv", mtime=2000.0)
        self.assertTrue(rl.is_up_to_date(out, [src]))

    def test_false_when_source_newer(self) -> None:
        out = self._touch("out.tsv", mtime=1000.0)
        src = self._touch("src.py", mtime=2000.0)
        self.assertFalse(rl.is_up_to_date(out, [src]))

    def test_false_when_source_missing(self) -> None:
        out = self._touch("out.tsv", mtime=2000.0)
        self.assertFalse(rl.is_up_to_date(out, [self.path / "missing.py"]))


# ─── TapClient ────────────────────────────────────────────────────────

class TapClientTests(unittest.TestCase):
    def _silent_retry(self) -> dict:
        return {"sleep": lambda _: None, "jitter": 0.0, "rand": lambda: 0.5}

    def test_uses_first_backend(self) -> None:
        calls: list[str] = []
        def esa(_q: str) -> str:
            calls.append("esa")
            return "esa-result"
        def cds(_q: str) -> str:
            calls.append("cds")
            return "cds-result"
        client = rl.TapClient(
            [rl.TapBackend("esa", esa), rl.TapBackend("cds", cds)],
            retry_kwargs=self._silent_retry(),
        )
        self.assertEqual(client.run("SELECT 1"), "esa-result")
        self.assertEqual(calls, ["esa"])

    def test_falls_back_on_transient(self) -> None:
        calls: list[str] = []
        def esa(_q: str) -> None:
            calls.append("esa")
            raise rl.TransientError("503")
        def cds(_q: str) -> str:
            calls.append("cds")
            return "cds-result"
        client = rl.TapClient(
            [rl.TapBackend("esa", esa), rl.TapBackend("cds", cds)],
            retry_kwargs={**self._silent_retry(), "max_attempts": 2},
        )
        self.assertEqual(client.run("SELECT 1"), "cds-result")
        # esa is retried max_attempts (2) times before fallback
        self.assertEqual(calls, ["esa", "esa", "cds"])

    def test_raises_when_all_backends_transient(self) -> None:
        def esa(_q: str) -> None:
            raise rl.TransientError("esa down")
        def cds(_q: str) -> None:
            raise rl.TransientError("cds down")
        client = rl.TapClient(
            [rl.TapBackend("esa", esa), rl.TapBackend("cds", cds)],
            retry_kwargs={**self._silent_retry(), "max_attempts": 1},
        )
        with self.assertRaises(rl.TransientError):
            client.run("SELECT 1")

    def test_non_transient_raises_without_fallback(self) -> None:
        calls: list[str] = []
        def esa(_q: str) -> None:
            calls.append("esa")
            raise ValueError("ADQL syntax error")
        def cds(_q: str) -> None:
            calls.append("cds")
        client = rl.TapClient(
            [rl.TapBackend("esa", esa), rl.TapBackend("cds", cds)],
            retry_kwargs=self._silent_retry(),
        )
        with self.assertRaises(ValueError):
            client.run("SELECT bogus")
        self.assertEqual(calls, ["esa"])

    def test_empty_backends_rejected(self) -> None:
        with self.assertRaises(ValueError):
            rl.TapClient([])


# ─── write_tsv ────────────────────────────────────────────────────────

class WriteTsvTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "out.tsv"
        self.addCleanup(self.dir.cleanup)

    def test_writes_header_and_rows(self) -> None:
        n = rl.write_tsv(
            [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}],
            columns=["a", "b"],
            output=self.path,
        )
        self.assertEqual(n, 2)
        self.assertEqual(
            self.path.read_text(), "a\tb\n1\tx\n2\ty\n"
        )

    def test_none_becomes_empty(self) -> None:
        rl.write_tsv([{"a": None, "b": 7}], columns=["a", "b"], output=self.path)
        self.assertEqual(self.path.read_text(), "a\tb\n\t7\n")

    def test_rounds_floats(self) -> None:
        rl.write_tsv(
            [{"ra": 1.234567}], columns=["ra"], output=self.path, round_floats=3
        )
        self.assertEqual(self.path.read_text(), "ra\n1.235\n")

    def test_creates_parent_dir(self) -> None:
        target = self.path.parent / "nested" / "deep.tsv"
        rl.write_tsv([{"a": 1}], columns=["a"], output=target)
        self.assertTrue(target.exists())


if __name__ == "__main__":
    unittest.main()
