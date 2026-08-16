"""SQLite implementation of the db seam (contract: db/__init__.py)."""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from app.services.db import UniqueViolationError


class SqliteConnection:
    """Thin proxy over sqlite3.Connection adding the seam's error mapping.

    Everything else — cursors, rows (sqlite3.Row satisfies the seam's Row
    protocol), rowcount — passes through untouched.
    """

    def __init__(self, raw: sqlite3.Connection) -> None:
        self._raw = raw

    def execute(self, sql: str, params: object = ()) -> sqlite3.Cursor:
        try:
            return self._raw.execute(sql, params)
        except sqlite3.IntegrityError as exc:
            # sqlite3 reports every UNIQUE failure (plain column or
            # expression index) with this prefix; other integrity errors
            # (NOT NULL, FK) keep their driver exception per the contract.
            if str(exc).startswith("UNIQUE constraint failed"):
                raise UniqueViolationError(str(exc)) from exc
            raise

    def executescript(self, ddl: str) -> None:
        self._raw.executescript(ddl)

    def commit(self) -> None:
        self._raw.commit()

    def rollback(self) -> None:
        self._raw.rollback()

    def close(self) -> None:
        self._raw.close()


def _open(db_path: Path, timeout: float | None) -> sqlite3.Connection:
    conn = (
        sqlite3.connect(db_path)
        if timeout is None
        else sqlite3.connect(db_path, timeout=timeout)
    )
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def connect(
    db_path: Path, *, timeout: float | None = None
) -> Iterator[SqliteConnection]:
    # sqlite3's own context manager only wraps a transaction (commit or
    # rollback); this wrapper also closes the connection afterwards, so
    # `with connect(...) as conn:` cannot leak connections. `timeout`
    # lets the operator CLI (app/manage.py) wait out a busy database
    # owned by a running server instance instead of failing instantly.
    raw = _open(db_path, timeout)
    raw.execute("PRAGMA foreign_keys = ON")
    try:
        with raw:
            yield SqliteConnection(raw)
    finally:
        raw.close()


class SqliteDatabase:
    """The seam's SQLite backend: one file, connection per operation."""

    dialect = "sqlite"

    def __init__(self, db_path: Path, *, timeout: float | None = None) -> None:
        self.db_path = db_path
        self.timeout = timeout
        db_path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self):
        return connect(self.db_path, timeout=self.timeout)

    def raw_connect(self) -> SqliteConnection:
        # No `PRAGMA foreign_keys` here: parity with the UsageStore
        # `_raw_connect` this replaces (llm_usage has no FK constraints);
        # the caller owns commit/rollback and close.
        return SqliteConnection(_open(self.db_path, self.timeout))
