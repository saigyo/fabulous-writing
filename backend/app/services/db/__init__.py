"""Database seam: one connection contract, per-dialect implementations.

PR1 of B15 (spec: docs/superpowers/specs/2026-08-16-b15-postgres-backend-
design.md) ships the SQLite implementation only; PR2 adds Postgres behind
the same contract.

Connection contract — everything a store may rely on:

- ``execute(sql, params=())`` returning a cursor with ``rowcount``,
  ``fetchone()``, ``fetchall()``. Placeholders are qmark (``?``); the SQL
  text must contain no literal ``?`` and no literal ``%`` outside a
  placeholder — ``?`` because the Postgres implementation translates
  placeholders textually, ``%`` because psycopg's placeholder parser
  rejects any other use of it.
- ``executescript(ddl)`` for multi-statement DDL. It renders the canonical
  ``INTEGER PRIMARY KEY AUTOINCREMENT`` into the dialect's identity form,
  so a single canonical ``_SCHEMA`` string runs unmodified on both
  backends.
- Connections expose a ``dialect`` attribute (``"sqlite"`` or
  ``"postgres"``).
- Rows support mapping access (``row["col"]``) AND positional access /
  tuple unpacking (``row[0]``, ``(x,) = fetchone()``). An unknown column
  name in mapping access raises a backend-specific exception
  (``IndexError`` on sqlite3.Row, ``ValueError`` on the Postgres row) —
  stores must not rely on the exact type.
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
- Bind Python ``bool``s as ``int(...)`` — Postgres rejects a bare bool
  bound to an INTEGER column; every current write site already wraps.
- ``Database.close()`` releases the backend's resources: a no-op on
  SQLite, closes the pool on Postgres. The app lifespan calls it
  unconditionally on shutdown.
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

    def close(self) -> None: ...


def table_columns(conn: Any, table: str) -> set[str]:
    """Column names of an existing table, honoring search_path on PG."""
    if getattr(conn, "dialect", "sqlite") == "postgres":
        rows = conn.execute(
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_schema = current_schema() AND table_name = ?",
            (table,),
        ).fetchall()
        return {row[0] for row in rows}
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


def verify_schema(
    conn: Any, required: Mapping[str, Sequence[tuple[str, str]]]
) -> None:
    """Check that every required table exists and carries the columns
    `migrate_columns` would ensure (same (name, decl) shape; decls unused).
    Read-only by design: must work under a DML-only role (B36 spec R3).
    Raises RuntimeError naming every problem plus the remedy."""
    problems = []
    for table, columns in required.items():
        existing = table_columns(conn, table)
        if not existing:
            # information_schema.columns is privilege-filtered on Postgres
            # (probed): a table that exists but was never granted to this
            # role is indistinguishable here from one that doesn't exist.
            problems.append(f"table '{table}' is missing or not readable by this role")
            continue
        missing = [name for name, _decl in columns if name not in existing]
        if missing:
            problems.append(
                f"table '{table}' is missing columns: {', '.join(missing)}"
            )
    if problems:
        raise RuntimeError(
            "database schema is not ready: "
            + "; ".join(problems)
            + f". Run the 'init-db' manage command with an admin {DATABASE_URL_ENV} first;"
            " if the table already exists, check this role's grants instead."
        )


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
