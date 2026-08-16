"""Database seam: one connection contract, per-dialect implementations.

PR1 of B15 (spec: docs/superpowers/specs/2026-08-16-b15-postgres-backend-
design.md) ships the SQLite implementation only; PR2 adds Postgres behind
the same contract.

Connection contract — everything a store may rely on:

- ``execute(sql, params=())`` returning a cursor with ``rowcount``,
  ``fetchone()``, ``fetchall()``. Placeholders are qmark (``?``); the SQL
  text must never contain a literal ``?`` in any other role, because the
  Postgres implementation translates placeholders textually.
- ``executescript(ddl)`` for multi-statement DDL.
- Rows support mapping access (``row["col"]``) AND positional access /
  tuple unpacking (``row[0]``, ``(x,) = fetchone()``).
- A violated UNIQUE constraint (column or expression index) on an
  ``execute()`` call raises ``UniqueViolationError``; every other
  integrity error propagates as the driver's own exception.
  ``executescript()`` propagates driver errors as-is, unmapped.
- An ``INSERT … RETURNING`` cursor must be fetched before the transaction
  ends — an undrained statement makes the following ``COMMIT`` fail
  (``cannot commit transaction - SQL statements in progress``) and
  discards the write.
- ``connect()`` wraps a transaction: commit on clean exit, rollback on
  exception, and the connection is always released afterwards.
- ``rowcount`` remains readable after the connection is released — stores
  read it after the ``connect()`` context manager exits.
- Cursors are iterable directly, in addition to ``fetchone()``/``fetchall()``.
- ``raw_connect()`` returns a connection whose transaction the CALLER
  controls (``commit()``/``rollback()``) and closes in a ``finally``;
  needed only by UsageStore.reserve_llm_run.
"""

import logging
import os
from collections.abc import Mapping, Sequence
from contextlib import AbstractContextManager
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from app.core.config import Settings


class UniqueViolationError(Exception):
    """A UNIQUE constraint (column or expression index) was violated."""


class Row(Protocol):
    """Mapping + positional row access (satisfied by sqlite3.Row)."""

    def __getitem__(self, key: str | int, /) -> Any: ...


class Database(Protocol):
    """One database, one dialect; stores hold exactly one of these."""

    dialect: str

    def connect(self) -> AbstractContextManager[Any]: ...

    def raw_connect(self) -> Any: ...


def table_columns(conn: Any, table: str) -> set[str]:
    """Column names of an existing table (SQLite: PRAGMA table_info;
    PR2 adds the information_schema branch for Postgres)."""
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def migrate_columns(
    conn: Any, table: str, columns: Sequence[tuple[str, str]]
) -> None:
    """Add any missing columns (name, declaration). Pre-existing databases
    lack columns added in later iterations; guarded by name, idempotent."""
    existing = table_columns(conn, table)
    for name, decl in columns:
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


logger = logging.getLogger(__name__)

DATABASE_URL_ENV = "FW_DATABASE_URL"


def create_database(
    settings: "Settings",
    *,
    timeout: float | None = None,
    env: Mapping[str, str] | None = None,
) -> Database:
    """Build the app's one Database from settings (spec §R5/§R6).

    sqlite (default): SqliteDatabase on settings.db_path; `timeout` is the
    operator CLI's busy timeout. postgres: DSN from FW_DATABASE_URL (env
    only — it carries a password and must never appear in config or logs);
    missing/blank -> RuntimeError naming the VARIABLE, never a value.
    `timeout` is ignored (the pool has its own checkout timeout).
    """
    environ = os.environ if env is None else env
    dsn = environ.get(DATABASE_URL_ENV, "").strip()
    if settings.database.backend == "postgres":
        if not dsn:
            raise RuntimeError(
                f"database.backend is 'postgres' but {DATABASE_URL_ENV} is not set"
            )
        # Imported lazily: sqlite deployments never import psycopg.
        from app.services.db.postgres import PostgresDatabase

        return PostgresDatabase(dsn)
    if dsn:
        logger.warning(
            "%s is set but database.backend is 'sqlite'; the variable is ignored",
            DATABASE_URL_ENV,
        )
    from app.services.db.sqlite import SqliteDatabase

    return SqliteDatabase(settings.db_path, timeout=timeout)
