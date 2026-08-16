# B15 PR2: Postgres Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Postgres side of the B15 seam — `db/postgres.py` behind PR1's contract, `database:` settings + `FW_DATABASE_URL`, the advisory-lock concurrency fix, backend-parametrized store tests, a PG-mode API smoke test, and an always-on CI lane.

**Architecture:** `db/postgres.py` implements the PR1 contract with psycopg 3 + `psycopg_pool` (one pool per `Database`, qmark→`%s` placeholder translation, a dual-access row factory, `UniqueViolation`→`UniqueViolationError` mapping, dialect-rendered DDL in `executescript`). A `create_database(settings)` factory in `db/__init__.py` selects the backend and enforces the env contract. Store code changes are four dialect gates (two legacy rebuilds, one explicit `BEGIN`, the advisory lock). Tests: a schema-per-test `pg_database` fixture plus a parametrized `db` fixture in conftest; store test files adopt `db` for portable tests and pin genuinely SQLite-specific tests to SQLite.

**Tech Stack:** Python 3.13, psycopg[binary] ≥3.2 + psycopg-pool (new, regular dependencies, imported only inside `db/postgres.py`), Postgres 17 (CI service container / supabase local stack on port 54322), pytest.

**Spec:** `docs/superpowers/specs/2026-08-16-b15-postgres-backend-design.md` §R3–§R7 + Phasing PR2. The spec's recorded PR2 landmines (plain `ORDER BY name` collation, legacy index permanence) bind Task 4/5 test design.

## Global Constraints

- Default gate `uv run pytest -q` (from `backend/`) stays green with ZERO warnings **without** `FW_TEST_DATABASE_URL` set — every Postgres-dependent test skips cleanly in that case (skips are fine; warnings are not).
- With `FW_TEST_DATABASE_URL` set, the same command runs the full matrix and must be green with zero warnings. Local PG for development: the supabase e2e stack's Postgres — `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (stack via `supabase start` only; never raw docker).
- Tests never touch a live database: SQLite via `tmp_path`, Postgres via a throwaway per-test schema created and dropped by the fixture. `backend/data/fabulous.db` never read or written.
- `FW_DATABASE_URL` / `FW_TEST_DATABASE_URL` are secrets by shape: their NAMES may appear in output and messages, their VALUES must never be logged or embedded in errors (the test DSN above is a documented local-stack constant, allowed in test/docs text).
- No pool-sizing or other new tuning knobs beyond `database.backend` (spec Non-requirements). Pool: min 1 / max 5, fixed.
- Seam contract (PR1, `db/__init__.py` docstring) binds the Postgres implementation: qmark placeholders (no literal `?`), dual-access rows, `UniqueViolationError` from `execute()` only (`executescript()` unmapped), RETURNING-drain rule, post-release `rowcount`, iterable cursors.
- Mutation-verify every new guard (delete guard → watch test fail → restore by re-editing, NEVER `git checkout <file>`). The advisory lock especially.
- Single-file pytest `-n0`. Frontend untouched. Commit trailers per repo convention on every commit.
- Branch `b15-postgres-backend`; PR body references #56 but does NOT close it (PR3 closes).

## File Structure

- **Create** `backend/app/services/db/postgres.py` — `PostgresDatabase`, `PostgresConnection`, row factory. The only module importing psycopg.
- **Modify** `backend/app/services/db/__init__.py` — `create_database()` factory, `table_columns()` PG branch, contract-docstring additions (DDL rendering, factory).
- **Modify** `backend/app/core/config.py` — `DatabaseSettings` block.
- **Modify** `backend/app/main.py` — factory + lifespan close. `backend/app/manage.py` — factory.
- **Modify** `backend/app/services/folders.py`, `profiles.py` (rebuild gates), `usage.py` (BEGIN gate + advisory lock).
- **Modify** `backend/tests/conftest.py` — `pg_database` + parametrized `db` fixtures; `backend/tests/test_db_seam.py` — PG contract tests; store test files (Tasks 4-5); `backend/tests/test_config.py`.
- **Create** `backend/tests/test_postgres_smoke.py`, plus the concurrency test in `backend/tests/test_usage.py`.
- **Modify** `.github/workflows/backend.yml` (new job), `docs/backend-architecture.md`, `backend/config.example.yaml`, `backend/pyproject.toml`.

All backend commands run from `backend/`. In steps below, `PG_ENV` means the env prefix `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (the controller confirms the supabase stack is up before execution starts).

---

### Task 1: `DatabaseSettings` + `create_database` factory (validation paths, no live PG needed)

**Files:**
- Modify: `backend/app/core/config.py` (after `AuthSettings`, ~line 230)
- Modify: `backend/app/services/db/__init__.py`
- Modify: `backend/config.example.yaml`
- Modify: `backend/pyproject.toml` (via `uv add`)
- Test: `backend/tests/test_config.py`, `backend/tests/test_db_seam.py`

**Interfaces:**
- Consumes: PR1's `Database` protocol, `SqliteDatabase`.
- Produces (later tasks rely on these exact names):
  - `app.core.config.DatabaseSettings` — `backend: Literal["sqlite", "postgres"] = "sqlite"`, `extra="forbid"`.
  - `Settings.database: DatabaseSettings` (default factory).
  - `app.services.db.create_database(settings, *, timeout: float | None = None, env: Mapping[str, str] | None = None) -> Database` — sqlite → `SqliteDatabase(settings.db_path, timeout=timeout)`; postgres → reads `FW_DATABASE_URL` from `env or os.environ`, raises `RuntimeError` naming the variable (never its value) when missing/blank, lazily imports `db.postgres` and returns `PostgresDatabase(dsn)`; sqlite-with-`FW_DATABASE_URL`-set → one `logger.warning` naming the variable, value ignored.
  - `app.services.db.DATABASE_URL_ENV = "FW_DATABASE_URL"`.

- [ ] **Step 1: Add the dependencies**

```bash
uv add "psycopg[binary]>=3.2" "psycopg-pool>=3.2"
```

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/test_config.py`:

```python
class TestDatabaseSettings:
    def test_default_backend_is_sqlite(self):
        assert Settings().database.backend == "sqlite"

    def test_postgres_backend_accepted(self):
        assert Settings(database={"backend": "postgres"}).database.backend == "postgres"

    def test_unknown_backend_rejected(self):
        with pytest.raises(ValidationError):
            Settings(database={"backend": "mysql"})

    def test_unknown_key_rejected(self):
        with pytest.raises(ValidationError):
            Settings(database={"backend": "sqlite", "pool_size": 3})
```

Append to `backend/tests/test_db_seam.py`:

```python
class TestCreateDatabase:
    def test_sqlite_mode_returns_sqlite_database(self, tmp_path):
        settings = Settings(db_path=tmp_path / "t.db")
        database = create_database(settings, env={})
        assert isinstance(database, SqliteDatabase)
        assert database.dialect == "sqlite"

    def test_sqlite_mode_passes_timeout_through(self, tmp_path):
        settings = Settings(db_path=tmp_path / "t.db")
        database = create_database(settings, timeout=7.5, env={})
        assert database.timeout == 7.5

    def test_postgres_mode_without_env_fails_loudly(self, tmp_path):
        settings = Settings(db_path=tmp_path / "t.db", database={"backend": "postgres"})
        with pytest.raises(RuntimeError, match="FW_DATABASE_URL"):
            create_database(settings, env={})

    def test_postgres_mode_blank_env_fails_loudly(self, tmp_path):
        settings = Settings(db_path=tmp_path / "t.db", database={"backend": "postgres"})
        with pytest.raises(RuntimeError, match="FW_DATABASE_URL"):
            create_database(settings, env={"FW_DATABASE_URL": "   "})

    def test_sqlite_mode_with_env_set_warns_and_ignores(self, tmp_path, caplog):
        settings = Settings(db_path=tmp_path / "t.db")
        with caplog.at_level(logging.WARNING):
            database = create_database(
                settings, env={"FW_DATABASE_URL": "postgresql://user:s3cret@h/db"}
            )
        assert isinstance(database, SqliteDatabase)
        assert any("FW_DATABASE_URL" in r.message for r in caplog.records)
        # The VALUE must never be logged.
        assert not any("s3cret" in r.message for r in caplog.records)
```

(Imports to add at the top of each file: `pytest`, `pydantic.ValidationError`, `logging`, `app.core.config.Settings`, `app.services.db.create_database`, `app.services.db.sqlite.SqliteDatabase` as appropriate.)

- [ ] **Step 3: Run to verify they fail**

Run: `uv run pytest tests/test_config.py::TestDatabaseSettings tests/test_db_seam.py::TestCreateDatabase -n0 -q`
Expected: FAIL — `DatabaseSettings` unknown / `create_database` import error.

- [ ] **Step 4: Implement**

`backend/app/core/config.py`, after `AuthSettings` (follow the file's block style):

```python
class DatabaseSettings(BaseModel):
    """Database backend selection (B15). The Postgres DSN is NOT config —
    it carries a password and lives exclusively in the FW_DATABASE_URL
    environment variable, required iff backend == "postgres"
    (app/services/db.create_database enforces)."""

    model_config = ConfigDict(extra="forbid")  # a typo'd key must fail loudly

    backend: Literal["sqlite", "postgres"] = "sqlite"
```

Add to `Settings` (next to the other block fields):

```python
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
```

`backend/app/services/db/__init__.py` — add at the end (plus `import logging`, `import os`, `from collections.abc import Mapping`, `from typing import TYPE_CHECKING`; under `TYPE_CHECKING` import `Settings` for the annotation only, to avoid an import cycle if one exists — check and use a plain string annotation if `app.core.config` imports nothing from here, which it does not today):

```python
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
```

`backend/config.example.yaml`: add a commented `database:` block next to the `auth:` block explaining `backend: sqlite | postgres` and that postgres mode requires `FW_DATABASE_URL` in the environment.

- [ ] **Step 5: Run to verify green, full gate, commit**

Run: `uv run pytest tests/test_config.py tests/test_db_seam.py -n0 -q` → green.
Run: `uv run pytest -q` → green, zero warnings (`PostgresDatabase` does not exist yet — fine, nothing imports it eagerly).

```bash
git add pyproject.toml uv.lock app/core/config.py app/services/db/__init__.py config.example.yaml tests/test_config.py tests/test_db_seam.py
git commit -m "feat(db,config): database backend selection + create_database factory (B15 PR2, #56)"
```

---

### Task 2: `db/postgres.py` + dialect plumbing + wiring (first live-PG task)

**Files:**
- Create: `backend/app/services/db/postgres.py`
- Modify: `backend/app/services/db/__init__.py` (`table_columns` PG branch; contract docstring: DDL rendering + `dialect` attribute)
- Modify: `backend/app/services/db/sqlite.py` (add `dialect = "sqlite"` to `SqliteConnection`)
- Modify: `backend/app/main.py` (factory + lifespan), `backend/app/manage.py` (factory)
- Test: `backend/tests/conftest.py` (`pg_database` fixture), `backend/tests/test_db_seam.py` (PG contract tests)

**Interfaces:**
- Consumes: Task 1's `create_database`/`DATABASE_URL_ENV`; PR1's contract and `UniqueViolationError`.
- Produces:
  - `PostgresDatabase(dsn: str)` — `dialect = "postgres"`; `connect()` context manager (transaction + return-to-pool); `raw_connect() -> PostgresConnection` (caller commits/rolls back; `close()` returns to pool); `close()` closes the pool. **`SqliteDatabase` gains a no-op `close()` in this task too** so the lifespan can call it unconditionally.
  - `PostgresConnection` — `dialect = "postgres"`; `execute(sql, params=())` with qmark→`%s` translation and `UniqueViolation`→`UniqueViolationError`; `executescript(ddl)` rendering `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` then executing the multi-statement string unmapped; `commit()/rollback()`.
  - conftest fixture `pg_database` — yields a schema-isolated `PostgresDatabase` or `pytest.skip("FW_TEST_DATABASE_URL not set")`.

- [ ] **Step 1: Write the failing PG contract tests**

Append to `backend/tests/conftest.py`:

```python
@pytest.fixture
def pg_database():
    """A PostgresDatabase isolated in a throwaway schema, or skip.

    Never a live database: each test gets its own schema, dropped on
    teardown; the base DSN (FW_TEST_DATABASE_URL) points at a disposable
    local server (CI service container / supabase stack port 54322).
    """
    base_dsn = os.environ.get("FW_TEST_DATABASE_URL", "").strip()
    if not base_dsn:
        pytest.skip("FW_TEST_DATABASE_URL not set")
    import psycopg

    from app.services.db.postgres import PostgresDatabase

    schema = f"fw_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        admin.execute(f'CREATE SCHEMA "{schema}"')
    sep = "&" if "?" in base_dsn else "?"
    dsn = f"{base_dsn}{sep}options=-csearch_path%3D{schema}"
    database = PostgresDatabase(dsn)
    try:
        yield database
    finally:
        database.close()
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            admin.execute(f'DROP SCHEMA "{schema}" CASCADE')
```

(`import uuid` at the top of conftest.)

Append to `backend/tests/test_db_seam.py` — mirror of the SQLite contract tests, against `pg_database`:

```python
class TestPostgresContract:
    _DDL = (
        "CREATE TABLE IF NOT EXISTS t ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " email TEXT NOT NULL,"
        " n INTEGER NOT NULL);"
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_t_email_lower ON t (LOWER(email));"
    )

    @pytest.fixture
    def pdb(self, pg_database):
        with pg_database.connect() as conn:
            conn.executescript(self._DDL)
        return pg_database

    def test_ddl_renders_identity_pk_and_is_idempotent(self, pdb):
        with pdb.connect() as conn:
            conn.executescript(self._DDL)  # IF NOT EXISTS second run
            cursor = conn.execute(
                "INSERT INTO t (email, n) VALUES (?, ?) RETURNING id", ("a@x.de", 1)
            )
            assert cursor.fetchone()["id"] == 1

    def test_connect_commits_and_rolls_back(self, pdb):
        with pdb.connect() as conn:
            conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@x.de", 1))
        with pytest.raises(RuntimeError):
            with pdb.connect() as conn:
                conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("b@x.de", 2))
                raise RuntimeError("boom")
        with pdb.connect() as conn:
            (count,) = conn.execute("SELECT COUNT(*) FROM t").fetchone()
            assert count == 1

    def test_rows_support_mapping_and_positional_access(self, pdb):
        with pdb.connect() as conn:
            conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@x.de", 7))
            row = conn.execute("SELECT email, n FROM t").fetchone()
            assert row["email"] == "a@x.de"
            assert row[1] == 7
            (n,) = conn.execute("SELECT n FROM t").fetchone()
            assert n == 7

    def test_unique_violation_maps_to_seam_error(self, pdb):
        with pdb.connect() as conn:
            conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("A@x.de", 1))
        with pdb.connect() as conn:
            with pytest.raises(UniqueViolationError):
                conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@X.de", 2))

    def test_other_integrity_errors_pass_through_unmapped(self, pdb):
        import psycopg

        with pdb.connect() as conn:
            with pytest.raises(psycopg.errors.NotNullViolation):
                conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("c@x.de", None))

    def test_raw_connect_requires_explicit_commit(self, pdb):
        conn = pdb.raw_connect()
        try:
            conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@x.de", 1))
            conn.rollback()
            conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("b@x.de", 2))
            conn.commit()
        finally:
            conn.close()
        with pdb.connect() as conn:
            rows = conn.execute("SELECT email FROM t ORDER BY id").fetchall()
            assert [row["email"] for row in rows] == ["b@x.de"]

    def test_rowcount_readable_after_release(self, pdb):
        with pdb.connect() as conn:
            conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@x.de", 1))
        with pdb.connect() as conn:
            cursor = conn.execute("UPDATE t SET n = 2 WHERE email = ?", ("a@x.de",))
        assert cursor.rowcount == 1

    def test_table_columns_and_migrate_columns(self, pdb):
        with pdb.connect() as conn:
            assert table_columns(conn, "t") == {"id", "email", "n"}
            for _ in range(2):
                migrate_columns(conn, "t", [("extra", "TEXT"), ("n", "INTEGER")])
            assert table_columns(conn, "t") == {"id", "email", "n", "extra"}
```

- [ ] **Step 2: Run to verify they fail (with PG up)**

Run: `PG_ENV uv run pytest tests/test_db_seam.py::TestPostgresContract -n0 -q`
Expected: FAIL — `app.services.db.postgres` does not exist.
Also run once WITHOUT the env var: expected `s` skips, zero failures — the skip path works.

- [ ] **Step 3: Implement `db/postgres.py`**

```python
"""Postgres implementation of the db seam (contract: db/__init__.py).

The only module that imports psycopg — loaded lazily by create_database,
so sqlite deployments never pay for it.
"""

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool

from app.services.db import UniqueViolationError

# The canonical schema strings are written in the seam's shared dialect;
# this is the one construct with no common form (spec §R2). GENERATED BY
# DEFAULT (not ALWAYS) so the PR3 import tool may insert explicit ids.
_PK_CANONICAL = "INTEGER PRIMARY KEY AUTOINCREMENT"
_PK_POSTGRES = "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY"


class _DualRow(Sequence):
    """Mapping + positional row access (the seam's Row contract)."""

    __slots__ = ("_names", "_values")

    def __init__(self, names: tuple[str, ...], values: tuple[Any, ...]) -> None:
        self._names = names
        self._values = values

    def __getitem__(self, key):
        if isinstance(key, str):
            return self._values[self._names.index(key)]
        return self._values[key]

    def __len__(self) -> int:
        return len(self._values)


def _dual_row_factory(cursor: psycopg.Cursor) -> Any:
    names = tuple(d.name for d in cursor.description or ())

    def make(values: Sequence[Any]) -> _DualRow:
        return _DualRow(names, tuple(values))

    return make


class PostgresConnection:
    """Thin proxy over psycopg.Connection: qmark translation + the seam's
    error mapping on execute(); executescript() renders the canonical DDL
    and propagates driver errors unmapped (contract)."""

    dialect = "postgres"

    def __init__(self, raw: psycopg.Connection, pool: ConnectionPool) -> None:
        self._raw = raw
        self._pool = pool

    def execute(self, sql: str, params: object = ()):
        # The contract forbids literal '?' outside placeholders, which is
        # what makes this textual translation safe.
        try:
            return self._raw.execute(sql.replace("?", "%s"), params)
        except psycopg.errors.UniqueViolation as exc:
            raise UniqueViolationError(str(exc)) from exc

    def executescript(self, ddl: str) -> None:
        self._raw.execute(ddl.replace(_PK_CANONICAL, _PK_POSTGRES))

    def commit(self) -> None:
        self._raw.commit()

    def rollback(self) -> None:
        self._raw.rollback()

    def close(self) -> None:
        # raw_connect contract: "close" releases — return to the pool
        # (putconn rolls back any open transaction), never sever the socket.
        self._pool.putconn(self._raw)


class PostgresDatabase:
    """The seam's Postgres backend: one pool, fixed sizing (no knobs)."""

    dialect = "postgres"

    def __init__(self, dsn: str) -> None:
        # open=True: connect at startup so a bad DSN fails loudly at boot,
        # not on the first request (spec §R5).
        self._pool = ConnectionPool(
            dsn,
            min_size=1,
            max_size=5,
            timeout=30,
            open=True,
            configure=lambda conn: setattr(conn, "row_factory", _dual_row_factory),
        )

    @contextmanager
    def connect(self) -> Iterator[PostgresConnection]:
        # pool.connection() commits on clean exit, rolls back on exception,
        # and returns the connection to the pool — the seam's connect()
        # semantics exactly.
        with self._pool.connection() as raw:
            yield PostgresConnection(raw, self._pool)

    def raw_connect(self) -> PostgresConnection:
        return PostgresConnection(self._pool.getconn(), self._pool)

    def close(self) -> None:
        self._pool.close()
```

- [ ] **Step 4: Dialect plumbing in the existing seam files**

`db/sqlite.py`: add `dialect = "sqlite"` as a class attribute on `SqliteConnection`, and this method to `SqliteDatabase`:

```python
    def close(self) -> None:
        """No-op: sqlite opens a connection per operation (lifespan parity
        with the Postgres pool's close)."""
```

`db/__init__.py` — `table_columns` grows the PG branch (branching on the connection's `dialect`, which both wrappers now carry):

```python
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
```

Contract docstring additions (same voice): a bullet that connections expose `dialect`; a bullet that `executescript()` renders the canonical `INTEGER PRIMARY KEY AUTOINCREMENT` into the dialect's identity form, so canonical `_SCHEMA` strings run on both backends.

- [ ] **Step 5: Wire the factory**

`app/main.py`: replace `db = SqliteDatabase(settings.db_path)` with `db = create_database(settings)` (import swap: `from app.services.db import create_database`; drop the `SqliteDatabase` import), keep `app.state` assignments, add `app.state.db = db`, and give the app a lifespan that closes it — `FastAPI(title=APP_NAME, lifespan=_lifespan, **docs_kwargs)` with:

```python
@asynccontextmanager
async def _lifespan(app: FastAPI):
    yield
    # The Postgres pool must release its connections on shutdown; the
    # SQLite implementation's close() is a documented no-op.
    app.state.db.close()
```

(module-level, `from contextlib import asynccontextmanager`).

`app/manage.py`: it already calls `load_settings()` and computes `db_path = args.db or load_settings().db_path` (line ~279). Replace the construction at line ~292:

```python
        settings = load_settings().model_copy(update={"db_path": db_path})
        store = UserStore(create_database(settings, timeout=_BUSY_TIMEOUT_SECONDS))
```

(import swap: `create_database` from `app.services.db` replaces the `SqliteDatabase` import; hoist the `load_settings()` call so it runs once, not twice). `--db` keeps its meaning in sqlite mode and is ignored by the factory in postgres mode — add one sentence to the `--db` argparse help ("sqlite mode only"). The `except sqlite3.OperationalError` busy-timeout handling stays exactly as-is (sqlite-mode path; postgres connection failures surface as their own errors, which is the fail-loudly behavior the spec wants).

- [ ] **Step 6: Verify, both modes**

Run: `PG_ENV uv run pytest tests/test_db_seam.py -n0 -q` → all green (SQLite + PG contract classes).
Run: `uv run pytest -q` (no env) → green, zero warnings, PG tests skip.
Mutation-verify the translation: in `postgres.py`, drop `.replace("?", "%s")`; `PG_ENV … TestPostgresContract` must fail (syntax error from `?`); restore by re-editing. Same for the `UniqueViolation` mapping (expect `test_unique_violation_maps_to_seam_error` to fail); restore.

- [ ] **Step 7: Commit**

```bash
git add app/services/db/ app/main.py app/manage.py tests/conftest.py tests/test_db_seam.py
git commit -m "feat(db): Postgres seam implementation — pool, qmark translation, dual rows, DDL rendering (B15 PR2, #56)"
```

---

### Task 3: Store dialect gates + the advisory lock

**Files:**
- Modify: `backend/app/services/folders.py` (~lines 115-134), `backend/app/services/profiles.py` (~lines 125-141), `backend/app/services/usage.py` (BEGIN in `credits_used`; `reserve_llm_run` head)
- Test: `backend/tests/test_usage.py` (concurrency test)

**Interfaces:**
- Consumes: `self.db.dialect` (Task 2), `pg_database` fixture (Task 2).
- Produces: `app.services.usage._RESERVATION_LOCK_KEY: int` (module constant).

- [ ] **Step 1: Gate the two legacy rebuild blocks**

In `folders.py` `_migrate`, wrap the M3 rebuild block — from the `sql = conn.execute("SELECT sql FROM sqlite_master …` line through the `ALTER TABLE folders_new RENAME TO folders` line — in:

```python
        if self.db.dialect == "sqlite":
```

with a one-line comment: `# Legacy rebuild reads sqlite_master; pre-B15 databases are SQLite by definition — Postgres only ever sees fresh schemas.` The duplicate pre-scan and index creation below the block stay unconditional (portable SQL). Same treatment for the equivalent rebuild block in `profiles.py` (its `sqlite_master` read through its `RENAME TO profiles`).

- [ ] **Step 2: Gate the explicit BEGIN**

In `usage.py` `credits_used` (~line 370), the `conn.execute("BEGIN")` becomes:

```python
            if self.db.dialect == "sqlite":
                # Plain SELECTs run in sqlite3's autocommit mode; BEGIN pins
                # every window's sum to one snapshot. psycopg opens a
                # transaction implicitly on the first statement, so the
                # snapshot already holds there — an explicit BEGIN would
                # only draw a "transaction already in progress" warning.
                conn.execute("BEGIN")
```

(fold the existing comment lines into this shape rather than duplicating them).

- [ ] **Step 3: Write the failing concurrency test**

Append to `backend/tests/test_usage.py` (imports: `threading`, plus whatever the file already has; construct settings objects exactly like the file's existing reservation tests do — read one before writing):

The file's existing `test_two_simultaneous_reservations_admit_exactly_one` (line ~163) is the template — same helpers (`budget_limits`, `FakeUser`, module constants `SERVER`, `REQUESTED`, `EFFECTIVE`), same positional `reserve_llm_run` call shape, widened to 8 racers:

```python
class TestPostgresReservationConcurrency:
    def test_concurrent_reservations_admit_exactly_one(self, pg_database):
        """Write-skew regression pin (spec §R4): under READ COMMITTED every
        racing insert-first reservation sees only its own uncommitted row
        (spent = 1, not > 1) and ALL of them pass the budget check — the
        SQLite write lock that made insert-first TOCTOU-safe does not
        exist here. pg_advisory_xact_lock serializes the transactions;
        with it, exactly one of these eight is admitted, deterministically.
        Mutation contract: with the lock removed this fails on the first
        round with a multi-admission overshoot."""
        store = UsageStore(pg_database)
        limits = budget_limits(credits_per_day=1)
        barrier = threading.Barrier(8)
        decisions = []
        record = threading.Lock()

        def attempt(run_id):
            barrier.wait()
            decision = store.reserve_llm_run(
                FakeUser(1), limits, SERVER, REQUESTED, EFFECTIVE,
                1, "check", run_id,
            )
            with record:
                decisions.append(decision)

        threads = [threading.Thread(target=attempt, args=(f"race{i}",))
                   for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        admitted = [d for d in decisions if d.kind == "admitted"]
        assert len(admitted) == 1, (
            f"budget overshoot: {len(admitted)} admissions against a"
            " one-credit day window"
        )
```

(Serialized, the outcome is deterministic: the first transaction sums to 1 — not > 1, admitted; every later one sees the committed row, sums ≥ 2, and is rejected — so the assertion is exact, no slack, no rounds needed. If the class needs any import or constant the file does not already have at module level, only `pg_database` qualifies — everything else above already exists in the file.)

- [ ] **Step 4: Run to verify it fails**

Run: `PG_ENV uv run pytest tests/test_usage.py::TestPostgresReservationConcurrency -n0 -q`
Expected: FAIL (intermittently within the 5 rounds) — the lock does not exist yet. If it passes on a first run, run it a few times; it must fail at least once before the fix. Record the observed failure in the report.

- [ ] **Step 5: Implement the advisory lock**

`usage.py`, module level (near the other constants):

```python
# One global advisory lock for the reservation transaction (spec §R4):
# SQLite serializes all writers globally, and the server-wide concurrency
# count spans users, so a per-user key would not close the write skew.
# Any stable 64-bit constant works; this one spells "fw-reserve" in hex.
_RESERVATION_LOCK_KEY = 0x66772D7265736572
```

At the top of `reserve_llm_run`'s try block, BEFORE the staleness sweep:

```python
            if self.db.dialect == "postgres":
                # Must be the transaction's first statement: it serializes
                # the whole insert-then-count sequence, restoring the
                # single-writer property the SQLite path gets for free.
                conn.execute(
                    "SELECT pg_advisory_xact_lock(?)", (_RESERVATION_LOCK_KEY,)
                )
```

- [ ] **Step 6: Verify + mutation-verify**

Run: `PG_ENV uv run pytest tests/test_usage.py::TestPostgresReservationConcurrency -n0 -q` five times → green every time.
Mutation: comment the lock statement out → the test must fail within a few invocations; restore by re-editing; green again.
Run: `uv run pytest -q` (no env) → green, zero warnings (test skips; sqlite behavior pinned by the existing suite).
Run: `PG_ENV uv run pytest tests/test_usage.py tests/test_folders.py tests/test_profiles.py -n0 -q` → green.

- [ ] **Step 7: Commit**

```bash
git add app/services/folders.py app/services/profiles.py app/services/usage.py tests/test_usage.py
git commit -m "feat(usage,db): advisory-lock reservation serialization + sqlite-only dialect gates (B15 PR2, #56)"
```

---

### Task 4: Parametrized `db` fixture + adopt in users/folders/documents test files

**Files:**
- Modify: `backend/tests/conftest.py` (the `db` fixture)
- Modify: `backend/tests/test_users_store.py`, `backend/tests/test_folders.py`, `backend/tests/test_documents.py`

**Interfaces:**
- Consumes: `pg_database` (Task 2), `SqliteDatabase`.
- Produces: conftest fixture `db` — `params=["sqlite", "postgres"]`, yielding a ready `Database`; Task 5 adopts it in the remaining files.

- [ ] **Step 1: Add the parametrized fixture to conftest**

```python
@pytest.fixture(params=["sqlite", "postgres"])
def db(request, tmp_path):
    """One Database per test, parametrized over both backends (spec §R7).

    The postgres parameter skips without FW_TEST_DATABASE_URL, keeping the
    default gate Docker- and network-free.
    """
    if request.param == "sqlite":
        yield SqliteDatabase(tmp_path / "test.db")
        return
    yield request.getfixturevalue("pg_database")
```

- [ ] **Step 2: Adopt in the three store test files (the classification rule)**

Per file, convert tests to take the `db` fixture and construct stores as `UserStore(db)` / `FolderStore(db)` / `DocumentStore(db)` instead of `Store(SqliteDatabase(tmp_path / "…"))`. Tests in one test that build TWO stores over the same file now share the one `db` — same semantics (one database).

**A test stays SQLite-pinned (keeps explicit `SqliteDatabase`, does NOT take `db`) iff it exercises SQLite-specific machinery.** Known members of that class in these files — verify by reading, not from this list alone:
- every legacy-schema/migration test that hand-writes old DDL through `connect(path)` (the `test_lower_name_index_migration_is_idempotent` / `test_legacy_case_duplicates_skip_index_with_warning` family in `test_folders.py`, the pre-B15/pre-M3 rebuild tests, `test_users_store.py`'s migrate-columns tests if they hand-build legacy tables),
- connection-lifecycle tests asserting `sqlite3.ProgrammingError` after close,
- anything reading `sqlite_master` or constructing with `timeout=`.

Where a test is pinned, add the reason as a trailing comment on the construction line (`# sqlite-only: hand-built legacy schema`). Everything else parametrizes. Expected empirical check: run the file with PG env — a failing `[postgres]` variant means either a genuinely sqlite-specific test to pin (fix by pinning) or a real portability bug (report it, do not pin over it). The spec's recorded landmine applies: do not add assertions on cross-case ordering through plain `ORDER BY name` columns.

- [ ] **Step 3: Run both modes**

Run: `PG_ENV uv run pytest tests/test_users_store.py tests/test_folders.py tests/test_documents.py -n0 -q` → green, with `[postgres]` variants executing (assert non-zero by reading the tail counts).
Run: `uv run pytest tests/test_users_store.py tests/test_folders.py tests/test_documents.py -n0 -q` (no env) → green, `[postgres]` variants skip.
Run: `uv run pytest -q` → green, zero warnings.

- [ ] **Step 4: Commit**

```bash
git add tests/conftest.py tests/test_users_store.py tests/test_folders.py tests/test_documents.py
git commit -m "test(db): backend-parametrized db fixture; users/folders/documents suites run on Postgres (B15 PR2, #56)"
```

---

### Task 5: Adopt `db` in terminology/profiles/usage test files

**Files:**
- Modify: `backend/tests/test_terminology.py`, `backend/tests/test_profiles.py`, `backend/tests/test_usage.py`, `backend/tests/test_seed.py`

**Interfaces:**
- Consumes: the `db` fixture (Task 4) and its classification rule.
- Produces: nothing new — completes §R7's store-level parametrization.

- [ ] **Step 1: Adopt, same rule as Task 4**

Same conversion and the same SQLite-pinning rule, same trailing-comment convention. File-specific notes:
- `test_usage.py`: the reservation/settlement tests parametrize (the store's SQL is portable); the pre-B5 legacy-migration test and any `timeout=` constructions stay pinned. The Task 3 concurrency class already uses `pg_database` directly — leave it.
- `test_profiles.py` / `test_terminology.py`: seed-marker idempotency and case-duplicate tests parametrize; legacy rebuild/migration tests pin.
- `test_seed.py`: its single construction parametrizes (seeding is portable SQL).
- The plain-`ORDER BY name` landmine applies to `test_terminology.py`/`test_profiles.py` list-order tests: if an existing test orders mixed-case names and fails only on `[postgres]`, pin it SQLite with the comment `# sqlite-only: BINARY collation order (spec §R2 landmine)` rather than weakening the assertion.

- [ ] **Step 2: Run both modes**

Run: `PG_ENV uv run pytest tests/test_terminology.py tests/test_profiles.py tests/test_usage.py tests/test_seed.py -n0 -q` → green with `[postgres]` variants executing.
Run: `uv run pytest -q` (no env) → green, zero warnings.

- [ ] **Step 3: Commit**

```bash
git add tests/test_terminology.py tests/test_profiles.py tests/test_usage.py tests/test_seed.py
git commit -m "test(db): terminology/profiles/usage/seed suites run on Postgres (B15 PR2, #56)"
```

---

### Task 6: PG-mode API smoke test

**Files:**
- Create: `backend/tests/test_postgres_smoke.py`

**Interfaces:**
- Consumes: `create_app`, `Settings(database={"backend": "postgres"})`, the `pg_database` fixture's schema-isolation pattern (NOT the fixture itself — the app builds its own Database via `create_database`, so the test supplies `FW_DATABASE_URL` pointing at a throwaway schema).

- [ ] **Step 1: Write the module**

```python
"""End-to-end PG-mode smoke (spec §R7): one app, real Postgres, exercising
login, a CRUD round-trip, and one metered check. The full API matrix
deliberately stays SQLite-only."""
```

Structure:

1. Module-level skip: `pytestmark = pytest.mark.skipif(not os.environ.get("FW_TEST_DATABASE_URL", "").strip(), reason="FW_TEST_DATABASE_URL not set")`.
2. The client fixture — conftest's `authed_client` (tests/conftest.py:151-165) is the exact template, with three deltas: a throwaway schema on `FW_TEST_DATABASE_URL` (same admin-connection create/drop pattern as conftest's `pg_database`), `monkeypatch.setenv("FW_DATABASE_URL", schema_scoped_dsn)`, and `database={"backend": "postgres"}` in the `Settings(...)` call (keep `db_path=tmp_path / "test.db"` — sqlite path unused in this mode but the field is required-with-default, and `rules_dir=tmp_path / "rules"` exactly as `authed_client` does). Yield the `TestClient` **as a context manager** (`with TestClient(create_app(settings)) as client:`) so startup seeding and the lifespan pool-close both run; attach `auth_headers(client)` like `authed_client` does; drop the schema in teardown.
3. `test_login_crud_and_metered_check_on_postgres`: the fixture's `auth_headers` call already proves login (it performs the real login round-trip); then create a folder and a document through the API and read both back asserting the persisted fields; then run one metered check through the same fake-provider path the SQLite API tests use — **read one metered test in `tests/test_suggestions_api.py` (its `make_client`/fake-provider helper) or `tests/test_documents_api.py` first and reuse its provider-injection setup and its usage-ledger assertion unchanged** — that mirrored assertion (a usage row recorded for the run) is the smoke's final claim.

- [ ] **Step 2: Run**

Run: `PG_ENV uv run pytest tests/test_postgres_smoke.py -n0 -q` → green.
Run without env → module skips.
Run: `uv run pytest -q` → green, zero warnings.

- [ ] **Step 3: Commit**

```bash
git add tests/test_postgres_smoke.py
git commit -m "test(db): PG-mode API smoke — login, CRUD, metered check end-to-end (B15 PR2, #56)"
```

---

### Task 7: CI lane + architecture doc

**Files:**
- Modify: `.github/workflows/backend.yml`
- Modify: `docs/backend-architecture.md`

- [ ] **Step 1: Add the job**

New job after `test` in `backend.yml`, mirroring its setup steps (checkout, uv with the same cache config, `uv sync --locked`, dictionaries) — same `defaults.run.working-directory: backend` — plus:

```yaml
  test-postgres:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd="pg_isready -U postgres" --health-interval=5s
          --health-timeout=5s --health-retries=10
    env:
      FW_TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
    steps:
      # (same checkout/uv/sync/dictionaries steps as the `test` job)
      - name: Run tests against Postgres
        run: uv run pytest -q
```

Full suite, plain `-q` — no coverage/badge coupling (that stays on the `test` job). Postgres 17 matches the supabase stack's major version (spec §R7).

- [ ] **Step 2: Update the architecture doc**

`docs/backend-architecture.md`, the `db/` seam section (Task 6 of PR1 wrote it): add the Postgres implementation — `create_database` factory + `FW_DATABASE_URL` (env-only, required iff `database.backend: postgres`), pool (fixed 1–5, closed via app lifespan), qmark translation + dual rows + DDL rendering, the advisory-lock serialization in `reserve_llm_run` with the write-skew rationale, the accepted sync-in-async latency residual (spec Decision 5), and the local test recipe (`FW_TEST_DATABASE_URL` → supabase stack port 54322; schema-per-test isolation). Also extend the reservation-transaction section with the PG lock sentence.

- [ ] **Step 3: Gates and commit**

Run: `uv run pytest -q` and `PG_ENV uv run pytest -q` → both green, zero warnings.
Frontend (from `frontend/`): `npm test -- --run && npx tsc -b --noEmit && npx oxlint` → clean (whole-branch check; nothing changed there).

```bash
git add ../.github/workflows/backend.yml ../docs/backend-architecture.md
git commit -m "ci(db): always-on Postgres lane; document the Postgres backend (B15 PR2, #56)"
```

---

## Post-plan (not tasks)

- Push `b15-postgres-backend`, open PR ("B15 PR2: Postgres backend (#56)" — references #56, does NOT close it), Copilot review, reply/resolve every thread, triage suppressed comments each round. LOGBOOK entry as LAST commit on the owner's cue; owner merges.
- The `test-postgres` CI job runs on the PR itself (backend paths trigger) — its first green run is part of the merge evidence.
- Known PR3 concerns: `import-to-postgres` manage.py subcommand (needs `GENERATED BY DEFAULT` + `setval`, delivered here), `docs/postgres-setup.md` (Supavisor session-mode guidance), the supabase-auth-setup cross-reference.
- Controller pre-flight before Task 2: confirm the supabase stack's PG answers on 54322 (`supabase start` if not) so implementers can actually run the `[postgres]` variants.
