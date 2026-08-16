# B15 PR1: Behavior-Neutral DB-Seam Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a database seam (`app/services/db/`) with a SQLite-only implementation and migrate all six stores onto it — unifying on `RETURNING`, `ON CONFLICT DO NOTHING`, and `LOWER()`-based case-insensitivity — with zero behavior change, pinned by the existing test suite.

**Architecture:** `app/services/_sqlite.py` becomes the package `app/services/db/` (`__init__.py` = dialect-neutral contract: `Database`/`Row` protocols, `UniqueViolationError`, `table_columns`, `migrate_columns`; `sqlite.py` = `SqliteDatabase` + a thin `SqliteConnection` wrapper that maps unique-constraint `IntegrityError`s). Stores take a `Database` instead of a `db_path`. PR2 (separate plan) adds `db/postgres.py` behind the same contract.

**Tech Stack:** Python 3.13, stdlib `sqlite3` (bundled SQLite ≥ 3.45, so `RETURNING` and `ON CONFLICT` are available), pytest. **No new dependencies in this PR.**

**Spec:** `docs/superpowers/specs/2026-08-16-b15-postgres-backend-design.md` (§R1, §R2, and Phasing §PR1 govern this plan)

## Global Constraints

- Behavior-neutral: no store API change other than the constructor; the existing test suite must stay green with **zero warnings** (`uv run pytest -q` from `backend/`, Docker- and network-free).
- Live DB `backend/data/fabulous.db` never read or written by tests; every test uses `tmp_path`-based paths/Settings.
- Single-file pytest runs use `-n0`; never `-p no:xdist`.
- SQL passed to the seam must never contain a literal `?` outside a qmark placeholder (seam contract, documented in `db/__init__.py`).
- New/changed guards mutation-verified: delete the guard, watch the test fail, restore **by re-editing** (never `git checkout <file>`).
- Frontend untouched: no frontend changes of any kind in this PR.
- No new Settings keys, no new env vars, no new dependencies in PR1.
- Every commit ends with the two repo trailers (Co-Authored-By + Claude-Session, exact values per repo convention).
- Branch `b15-db-seam-prep` (already exists, carries the spec); commits per task as specified below.

## File Structure

- **Create** `backend/app/services/db/__init__.py` — dialect-neutral contract: `UniqueViolationError`, `Row` protocol, `Database` protocol, `table_columns()`, `migrate_columns()`.
- **Create** `backend/app/services/db/sqlite.py` — `connect()` (moved from `_sqlite.py`), `SqliteConnection` (error-mapping wrapper), `SqliteDatabase`.
- **Create** `backend/tests/test_db_seam.py` — seam unit tests.
- **Modify** the six stores (`users.py`, `documents.py`, `folders.py`, `terminology.py`, `profiles.py`, `usage.py`), `main.py`, `manage.py`, and 13 store-constructing test files + 7 `_sqlite`-importing test files (enumerated per task).
- **Delete** `backend/app/services/_sqlite.py` (Task 6, after nothing imports it).
- **Modify** `docs/backend-architecture.md` (Task 6).

All backend commands below run from `backend/`.

---

### Task 1: The `db` seam package (SQLite implementation + tests)

**Files:**
- Create: `backend/app/services/db/__init__.py`
- Create: `backend/app/services/db/sqlite.py`
- Test: `backend/tests/test_db_seam.py`

**Interfaces:**
- Consumes: nothing (self-contained; `_sqlite.py` stays in place untouched until Task 6).
- Produces (every later task relies on these exact names):
  - `app.services.db.UniqueViolationError(Exception)`
  - `app.services.db.Row` — protocol: `__getitem__(self, key: str | int) -> Any`
  - `app.services.db.Database` — protocol: attribute `dialect: str`; `connect()` context manager yielding a connection; `raw_connect()` returning a connection (caller commits/closes)
  - `app.services.db.table_columns(conn, table: str) -> set[str]`
  - `app.services.db.migrate_columns(conn, table: str, columns: Sequence[tuple[str, str]]) -> None`
  - `app.services.db.sqlite.SqliteDatabase(db_path: Path, *, timeout: float | None = None)` — `dialect = "sqlite"`; creates `db_path.parent` on construction
  - `app.services.db.sqlite.connect(db_path: Path, *, timeout: float | None = None)` — module-level context manager (kept for the test files that open the DB file directly for inspection)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_db_seam.py`:

```python
"""Seam-level tests for app/services/db: transaction wrapping, error
mapping, and column introspection on the SQLite implementation."""

import sqlite3

import pytest

from app.services.db import UniqueViolationError, migrate_columns, table_columns
from app.services.db.sqlite import SqliteDatabase

_DDL = (
    "CREATE TABLE t ("
    " id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " email TEXT NOT NULL,"
    " n INTEGER NOT NULL);"
    "CREATE UNIQUE INDEX idx_t_email_lower ON t (LOWER(email));"
)


@pytest.fixture
def db(tmp_path):
    database = SqliteDatabase(tmp_path / "seam.db")
    with database.connect() as conn:
        conn.executescript(_DDL)
    return database


def test_connect_commits_on_clean_exit(db):
    with db.connect() as conn:
        conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@x.de", 1))
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 1


def test_connect_rolls_back_on_exception(db):
    with pytest.raises(RuntimeError):
        with db.connect() as conn:
            conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@x.de", 1))
            raise RuntimeError("boom")
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0


def test_rows_support_mapping_and_positional_access(db):
    with db.connect() as conn:
        conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@x.de", 7))
        row = conn.execute("SELECT email, n FROM t").fetchone()
        assert row["email"] == "a@x.de"
        assert row[1] == 7
        (n,) = conn.execute("SELECT n FROM t").fetchone()
        assert n == 7


def test_raw_connect_requires_explicit_commit(db):
    conn = db.raw_connect()
    try:
        conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@x.de", 1))
        conn.rollback()
        conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("b@x.de", 2))
        conn.commit()
    finally:
        conn.close()
    with db.connect() as conn:
        rows = conn.execute("SELECT email FROM t ORDER BY id").fetchall()
        assert [row["email"] for row in rows] == ["b@x.de"]


def test_unique_violation_maps_to_seam_error(db):
    # Expression-index violations are the exact shape the stores hit after
    # the LOWER() migration; the plain-column UNIQUE shape is covered by
    # the AUTOINCREMENT pk implicitly and by the stores' own tests.
    with db.connect() as conn:
        conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("A@x.de", 1))
        with pytest.raises(UniqueViolationError):
            conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("a@X.de", 2))


def test_other_integrity_errors_pass_through_unmapped(db):
    with db.connect() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO t (email, n) VALUES (?, ?)", ("c@x.de", None))


def test_returning_id_works(db):
    with db.connect() as conn:
        cursor = conn.execute(
            "INSERT INTO t (email, n) VALUES (?, ?) RETURNING id", ("a@x.de", 1)
        )
        assert cursor.fetchone()["id"] == 1


def test_table_columns(db):
    with db.connect() as conn:
        assert table_columns(conn, "t") == {"id", "email", "n"}


def test_migrate_columns_adds_missing_and_is_idempotent(db):
    for _ in range(2):
        with db.connect() as conn:
            migrate_columns(conn, "t", [("extra", "TEXT"), ("n", "INTEGER")])
    with db.connect() as conn:
        assert table_columns(conn, "t") == {"id", "email", "n", "extra"}


def test_connect_closes_connection_after_exit(db):
    with db.connect() as conn:
        pass
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_foreign_keys_enforced_via_connect(db):
    with db.connect() as conn:
        conn.executescript(
            "CREATE TABLE parent (id INTEGER PRIMARY KEY);"
            "CREATE TABLE child (pid INTEGER REFERENCES parent(id));"
        )
    with db.connect() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO child (pid) VALUES (999)")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_db_seam.py -n0 -q`
Expected: FAIL at collection with `ModuleNotFoundError: No module named 'app.services.db'`.

- [ ] **Step 3: Implement the package**

Create `backend/app/services/db/__init__.py`:

```python
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
- A violated UNIQUE constraint (column or expression index) raises
  ``UniqueViolationError``; every other integrity error propagates as the
  driver's own exception.
- An ``INSERT … RETURNING`` cursor must be fetched before the transaction
  ends — an undrained statement makes the following ``COMMIT`` fail
  (``cannot commit transaction - SQL statements in progress``) and
  discards the write.
- ``connect()`` wraps a transaction: commit on clean exit, rollback on
  exception, and the connection is always released afterwards.
- ``raw_connect()`` returns a connection whose transaction the CALLER
  controls (``commit()``/``rollback()``) and closes in a ``finally``;
  needed only by UsageStore.reserve_llm_run.
"""

from collections.abc import Sequence
from contextlib import AbstractContextManager
from typing import Any, Protocol


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
```

Create `backend/app/services/db/sqlite.py`:

```python
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
    # owned by a running server instead of failing instantly.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_db_seam.py -n0 -q`
Expected: 11 passed, zero warnings.

- [ ] **Step 5: Mutation-verify the error mapping**

In `sqlite.py`, temporarily replace the `if str(exc).startswith(...)` branch body with `raise` (so no mapping happens). Run `uv run pytest tests/test_db_seam.py -n0 -q` → `test_unique_violation_maps_to_seam_error` must FAIL. Restore the mapping by re-editing (never `git checkout`), re-run, all green.

- [ ] **Step 6: Run the full suite and commit**

Run: `uv run pytest -q` — everything green (existing code untouched), zero warnings.

```bash
git add app/services/db/ tests/test_db_seam.py
git commit -m "feat(db): dialect seam package with SQLite implementation (B15 PR1, #56)"
```

---

### Task 2: Migrate UserStore (constructor, RETURNING, LOWER(email), seam errors)

**Files:**
- Modify: `backend/app/services/users.py`
- Modify: `backend/app/main.py:175-196` (introduce the shared `db`, switch `UserStore`)
- Modify: `backend/app/manage.py:291`
- Modify (mechanical constructor updates): `backend/tests/test_users_store.py` (4 sites), `backend/tests/test_auth_api.py` (1), `backend/tests/test_supabase_auth.py` (9), `backend/tests/test_manage_cli.py` (13), `backend/tests/test_seed_admin.py` (1)

**Interfaces:**
- Consumes (Task 1): `Database`, `Row`, `UniqueViolationError`, `migrate_columns` from `app.services.db`; `SqliteDatabase` from `app.services.db.sqlite`.
- Produces: `UserStore(db: Database)` — no `timeout` parameter anymore (the busy timeout lives on `SqliteDatabase`); every later task follows the same constructor shape.

- [ ] **Step 1: Rewrite `users.py` onto the seam**

Imports: drop `import sqlite3` and `from app.services._sqlite import connect, migrate_columns`; add

```python
from app.services.db import Database, Row, UniqueViolationError, migrate_columns
```

Constructor and delegate (replaces lines 105-114):

```python
    def __init__(self, db: Database) -> None:
        self.db = db
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)

    def _connect(self):
        return self.db.connect()
```

Schema: change line 21 from `email TEXT NOT NULL UNIQUE COLLATE NOCASE,` to `email TEXT NOT NULL,` and append to `_SCHEMA` (after the `admin_audit` table):

```sql
-- No duplicate pre-scan before this index (unlike folders/domains/
-- profiles): email has carried UNIQUE COLLATE NOCASE since the table's
-- first version, and NOCASE ≡ LOWER() on ASCII, so no existing database
-- can hold a pair this index would reject.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
    ON users (LOWER(email));
```

Rewrite the comment block at lines 140-148 (create_user) to tell the LOWER story:

```python
        # Strip only — do NOT lowercase: the LOWER(email) unique index and
        # the LOWER() lookups below already give case-insensitive matching,
        # and lowercasing here would throw away the case the user chose
        # before it ever reaches `User.email`. Stripping keeps this store's
        # notion of "same email" aligned with `_throttle_key`
        # (`app/api/auth.py`), which normalizes with `.strip().lower()`:
        # SQLite's LOWER() is ASCII-only casefolding, a strict subset of
        # Python's `.lower()`, so any two emails the DB treats as one row
        # already map to the same throttle key once both sides strip
        # whitespace the same way. (Databases created before B15 also
        # carry the legacy `UNIQUE COLLATE NOCASE` on the column itself —
        # same ASCII semantics, harmlessly redundant.)
```

`create_user` insert (replaces the lastrowid dance at lines 156-176):

```python
            try:
                cursor = conn.execute(
                    "INSERT INTO users"
                    " (email, display_name, password_hash, tier, is_admin, created_at,"
                    " external_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
                    (
                        email,
                        display_name,
                        password_hash,
                        tier,
                        int(is_admin),
                        _utcnow(),
                        external_id,
                    ),
                )
                new_id = cursor.fetchone()["id"]
            except UniqueViolationError as exc:
                raise DuplicateEmailError(f"A user with email {email} already exists") from exc
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (new_id,)
            ).fetchone()
```

Email queries: `get_by_email` (line 187) and `verify_credentials` (line 279) become
`"SELECT * FROM users WHERE LOWER(email) = LOWER(?)"`; `list_users` (line 262) becomes
`"SELECT * FROM users ORDER BY LOWER(email)"`.

`link_external_id` (line 225): catch `UniqueViolationError` instead of `sqlite3.IntegrityError`, and update the docstring sentence at line 210 accordingly ("instead of letting the seam's UniqueViolationError propagate").

Type hints: `_row_to_user(row: Row)`, `list_audit(self) -> list[Row]`.

- [ ] **Step 2: Update the call sites**

`main.py`: directly above the store block (before line 175), add

```python
    from app.services.db.sqlite import SqliteDatabase

    db = SqliteDatabase(settings.db_path)
```

(import at top of file with the other imports, not inline — shown here for placement of the `db =` line only). Switch **both** `UserStore(settings.db_path)` sites (lines 188 and 196) to `UserStore(db)`. The other five stores keep `settings.db_path` until their tasks.

`manage.py:291`:

```python
        store = UserStore(SqliteDatabase(db_path, timeout=_BUSY_TIMEOUT_SECONDS))
```

with `from app.services.db.sqlite import SqliteDatabase` added to the imports.

- [ ] **Step 3: Update the test constructors**

In the five test files listed above, every `UserStore(<path>)` / `UserStore(<path>, timeout=...)` becomes `UserStore(SqliteDatabase(<path>))` / `UserStore(SqliteDatabase(<path>, timeout=...))`, with `from app.services.db.sqlite import SqliteDatabase` added per file. Update the stale comment at `tests/test_users_store.py:38` (references COLLATE NOCASE) to name the LOWER(email) index instead.

- [ ] **Step 4: Run the store's own tests, then the full gate**

Run: `uv run pytest tests/test_users_store.py tests/test_auth_api.py tests/test_manage_cli.py -n0 -q` → green.
Run: `uv run pytest -q` → green, zero warnings. The pre-existing case-insensitivity tests (duplicate emails differing in case, case-insensitive login) are the behavioral pin for the NOCASE→LOWER swap — they must pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add app/services/users.py app/main.py app/manage.py tests/
git commit -m "refactor(users): UserStore onto the db seam — RETURNING, LOWER(email), seam errors (B15 PR1)"
```

---

### Task 3: Migrate FolderStore and DocumentStore

**Files:**
- Modify: `backend/app/services/folders.py`, `backend/app/services/documents.py`
- Modify: `backend/app/main.py:180-181`
- Modify (mechanical): `backend/tests/test_folders.py` (20 sites + `_sqlite` import), `backend/tests/test_documents.py` (9), `backend/tests/test_folders_api.py` (1)

**Interfaces:**
- Consumes: Task 1's names; constructor shape from Task 2 (`Store(db: Database)`).
- Produces: `FolderStore(db: Database)`, `DocumentStore(db: Database)`.

- [ ] **Step 1: Rewrite `folders.py` onto the seam**

Same import/constructor/`_connect` transformation as Task 2 (drop `import sqlite3` and the `_sqlite` import; `__init__(self, db: Database)`; no `mkdir`). Then:

- Index (lines 147-150): `"CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_owner_name ON folders(owner_id, LOWER(name))"`. The duplicate pre-scan directly above already groups by `lower(name)` — unchanged.
- `list_folders` (line 188): `" ORDER BY LOWER(name), id"`.
- `create_folder` (lines 201-210): append ` RETURNING id` to the INSERT, `folder_id = cursor.fetchone()["id"]`, and change the `except sqlite3.IntegrityError` to `except UniqueViolationError`. Same exception swap at the second catch site (line 227, the rename path).
- The legacy-rebuild branch reading `sqlite_master` (lines 120-134) stays byte-identical — it is SQLite-legacy migration logic by nature (PR2 dialect-gates the whole `_migrate` path; out of scope here).
- Update the comment at line 135 ("Per-owner NOCASE uniqueness, …") to say LOWER(name).
- Hint: `_row_to_folder(row: Row)`.
- Update the stale test comment at `tests/test_folders.py:229` (mentions the NOCASE index) to say LOWER(name).

- [ ] **Step 2: Rewrite `documents.py` onto the seam**

Same import/constructor transformation. No NOCASE here. Changes:

- Line 124: `columns = {row[1] for row in conn.execute("PRAGMA table_info(documents)")}` → `columns = table_columns(conn, "documents")` (import `table_columns` from `app.services.db`).
- `create` (line 187): append ` RETURNING id` to its INSERT, `document_id = cursor.fetchone()["id"]`.
- Hint: `_row_to_document(row: Row)`.

- [ ] **Step 3: Update call sites and tests**

`main.py`: lines 180-181 → `DocumentStore(db)`, `FolderStore(db)`. Test files: wrap constructions in `SqliteDatabase(...)` as in Task 2; in `tests/test_folders.py`, also switch `from app.services._sqlite import connect` to `from app.services.db.sqlite import connect`.

- [ ] **Step 4: Run tests, full gate**

Run: `uv run pytest tests/test_folders.py tests/test_documents.py tests/test_folders_api.py -n0 -q` → green.
Run: `uv run pytest -q` → green, zero warnings. The folder-duplicate tests (case-variant folder names per owner) pin the index rewrite.

- [ ] **Step 5: Commit**

```bash
git add app/services/folders.py app/services/documents.py app/main.py tests/
git commit -m "refactor(folders,documents): onto the db seam — RETURNING, LOWER(name) index (B15 PR1)"
```

---

### Task 4: Migrate TerminologyStore and ProfileStore

**Files:**
- Modify: `backend/app/services/terminology.py`, `backend/app/services/profiles.py`
- Modify: `backend/app/main.py:175,182`
- Modify (mechanical): `backend/tests/test_terminology.py` (7 sites + `_sqlite` import), `backend/tests/test_profiles.py` (16 + `_sqlite` import), `backend/tests/test_seed.py` (1), `backend/tests/test_demo_texts.py` (1 — a `TerminologyStore` construction at line 123, belongs to THIS task, not Task 3; the `SqliteDatabase` import goes next to the function-local `TerminologyStore` import at line 121)

**Interfaces:**
- Consumes: Task 1's names; constructor shape from Task 2.
- Produces: `TerminologyStore(db: Database)`, `ProfileStore(db: Database)`.

- [ ] **Step 1: Rewrite `terminology.py` onto the seam**

Standard transformation (imports, constructor, `_connect`), plus:

- Indexes: line 113-116 → `" ON domains(owner_id, LOWER(name)) WHERE owner_id IS NOT NULL"`; line 127-131 → `" ON domains(LOWER(name)) WHERE owner_id IS NULL"`. Pre-scans above each already use `lower(name)` — unchanged.
- Line 90: PRAGMA-set comprehension → `table_columns(conn, "domains")`.
- RETURNING at both creates: line 166 (`domain_id`) and line 281 (`term_id`) — append ` RETURNING id`, fetch `["id"]`.
- Both `except sqlite3.IntegrityError` sites (lines 167, 201) → `except UniqueViolationError`.
- Hints: `_row_to_domain`, `_row_to_term`, and the `-> sqlite3.Row | None` at line 219 → `Row`.

- [ ] **Step 2: Rewrite `profiles.py` onto the seam**

Standard transformation, plus:

- Indexes: line 156-160 → `" ON profiles(owner_id, language, LOWER(name)) WHERE owner_id IS NOT NULL"`; line 171-175 → `" ON profiles(language, LOWER(name)) WHERE owner_id IS NULL"`.
- Line 106: → `table_columns(conn, "profiles")`.
- RETURNING at the create (line 240), `profile_id = cursor.fetchone()["id"]`; both `except sqlite3.IntegrityError` sites (lines 241, 297) → `except UniqueViolationError`.
- Line 344: `"INSERT OR IGNORE INTO profile_seed_markers (language) VALUES (?)"` → `"INSERT INTO profile_seed_markers (language) VALUES (?) ON CONFLICT DO NOTHING"`.
- Hint: `_row_to_profile(row: Row)`.

- [ ] **Step 3: Update call sites and tests**

`main.py` lines 175 and 182 → `TerminologyStore(db)`, `ProfileStore(db)`. Tests: constructor wraps + the two `_sqlite` import switches. Update the stale NOCASE comments at `tests/test_terminology.py:185` and `tests/test_profiles.py:302` to say "case-insensitive (LOWER)".

- [ ] **Step 4: Run tests, full gate**

Run: `uv run pytest tests/test_terminology.py tests/test_profiles.py tests/test_seed.py -n0 -q` → green.
Run: `uv run pytest -q` → green, zero warnings. The domain/profile case-duplicate tests (e.g. `tests/test_terminology.py:185`) pin the index rewrites; the seed-marker idempotency tests pin the ON CONFLICT swap.

- [ ] **Step 5: Commit**

```bash
git add app/services/terminology.py app/services/profiles.py app/main.py tests/
git commit -m "refactor(terminology,profiles): onto the db seam — RETURNING, ON CONFLICT, LOWER(name) indexes (B15 PR1)"
```

---

### Task 5: Migrate UsageStore (including the raw-connection path)

**Files:**
- Modify: `backend/app/services/usage.py`
- Modify: `backend/app/main.py:183`
- Modify (mechanical): `backend/tests/test_usage.py` (5 constructor sites + 5 `store.db_path` reads + `_sqlite` import)

**Interfaces:**
- Consumes: Task 1's names; constructor shape from Task 2.
- Produces: `UsageStore(db: Database, *, credit_cost: CreditCostSettings | None = None)` — the `timeout` parameter moves to the `Database`.

- [ ] **Step 1: Rewrite `usage.py` onto the seam**

Standard import swap. Constructor (replaces lines 133-154):

```python
    def __init__(
        self,
        db: Database,
        *,
        credit_cost: CreditCostSettings | None = None,
    ) -> None:
        self.db = db
        # Pricing is global and static, unlike per-tier limits -- injected
        # once here so finish_run's signature (and every settle frame that
        # calls it) stays untouched (B6 spec §4).
        self.credit_cost = credit_cost or CreditCostSettings()
        with self.db.connect() as conn:
            conn.executescript(_SCHEMA)
            migrate_columns(
                conn,
                "llm_usage",
                [("fail_stage", "TEXT"), ("fail_detail", "TEXT"),
                 ("credits", "INTEGER")],
            )
```

Delete `_raw_connect` (lines 156-169) — its docstring's explanation now lives on the seam's `raw_connect`. In `reserve_llm_run`, line 201 becomes `conn = self.db.raw_connect()`; the method's commit/rollback/close calls work unchanged through `SqliteConnection`.

RETURNING at line 212-234: append ` RETURNING id` to the reservation INSERT, then `reservation_id = cursor.fetchone()["id"]` (replaces the `cursor.lastrowid` at line 234; the later `assert reservation_id is not None` may stay). Hint at line 344: `row: Row`.

The three remaining module-level `connect` calls — lines 309, 370, and 400, each `with connect(self.db_path, timeout=self.timeout) as conn:` — become `with self.db.connect() as conn:`. (Line 370's method issues an explicit `conn.execute("BEGIN")` inside the context manager for its multi-window snapshot — that stays byte-identical; the seam's commit-on-exit ends it exactly as before.)

- [ ] **Step 2: Update call sites and tests**

`main.py:183` → `UsageStore(db, credit_cost=settings.credit_cost)`. `tests/test_usage.py`: constructor wraps + `_sqlite` import switch, **plus the five `store.db_path` reads** (the store no longer has that attribute): the `rows(store)` helper at line 47 and the inline `with connect(store.db_path) as conn:` sites at lines 78, 303, 549 become `with store.db.connect() as conn:` (drop the module-level `connect` import if it becomes unused); the re-construction at line 428, `UsageStore(store.db_path, credit_cost=config)`, becomes `UsageStore(store.db, credit_cost=config)`.

- [ ] **Step 3: Run tests, full gate**

Run: `uv run pytest tests/test_usage.py -n0 -q` → green.
Run: `uv run pytest -q` → green, zero warnings. The reservation/rollback tests (quota exhausted → no row persisted) pin the raw-connection path.

- [ ] **Step 4: Commit**

```bash
git add app/services/usage.py app/main.py tests/test_usage.py
git commit -m "refactor(usage): onto the db seam — raw_connect via seam, RETURNING (B15 PR1)"
```

---

### Task 6: Delete `_sqlite.py`, final sweep, docs

**Files:**
- Delete: `backend/app/services/_sqlite.py`
- Modify: `backend/tests/test_documents_api.py`, `backend/tests/test_suggestions_api.py`, `backend/tests/test_main.py` (import switches)
- Modify: `docs/backend-architecture.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a repo with zero `_sqlite` references.

- [ ] **Step 1: Switch the remaining imports**

In the three test files, `from app.services._sqlite import connect` (and the `as sqlite_connect` aliased variants) → `from app.services.db.sqlite import connect` (keeping any alias).

- [ ] **Step 2: Delete `_sqlite.py` and sweep**

```bash
rm app/services/_sqlite.py
```

Run: `rtk proxy grep -rn "_sqlite" app/ tests/ tests_e2e/ --include="*.py"`
Expected: zero hits (fix any straggler the sweep finds — this is the directory-sweep guard against fixed-at-named-sites-only).

Run: `rtk proxy grep -n "_sqlite" ../docs/backend-architecture.md ../docs/frontend-architecture.md`
Expected: zero hits after Step 3. **Do NOT touch** `docs/LOGBOOK.md` or dated files under `docs/superpowers/plans/` and `docs/superpowers/specs/` — those are frozen history and legitimately mention `_sqlite`.

Run: `rtk proxy grep -rn "NOCASE" app/ tests/ --include="*.py"`
Expected: exactly 3 hits, all comment lines in `app/services/users.py` (the deliberate NOCASE-rationale comments Task 2 wrote — the `_SCHEMA` pre-scan-asymmetry comment and the legacy-constraint sentence in `create_user`); zero hits anywhere else, and zero `COLLATE NOCASE` in executable SQL.

- [ ] **Step 3: Update the architecture doc (three sites)**

`docs/backend-architecture.md` has **three** stale sites:

1. Line 62 (file tree): `_sqlite.py` entry → the `db/` package (`__init__.py` contract + `sqlite.py` implementation).
2. Lines 698-712 ("All five SQLite-backed stores … share `connect()` … from `app/services/_sqlite.py`"): replace with the seam description — `app/services/db/` package, contract in `__init__.py` (qmark placeholders, Row protocol, `UniqueViolationError`, transaction-wrapping `connect()` / caller-managed `raw_connect()`), `sqlite.py` as the only implementation until B15 PR2, stores hold a `Database` instead of a path, and the B15 PR1 unifications (`RETURNING`, `ON CONFLICT DO NOTHING`, `LOWER()` case-insensitivity everywhere NOCASE used to be). Also fix the store count ("five" → six).
3. Lines 2055-2061 (reservation-transaction section): `_raw_connect()` no longer exists — the paragraph now describes `self.db.raw_connect()`, the seam's caller-managed connection.

- [ ] **Step 4: Full gates**

Run (from `backend/`): `uv run pytest -q` → green, zero warnings.
Run (from `frontend/`): `npm test -- --run && npx tsc -b --noEmit && npx oxlint` → clean (nothing changed there; this is the standard whole-branch gate).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(db): retire _sqlite.py; document the seam (B15 PR1, #56)"
```

---

## Post-plan (not tasks)

- Push `b15-db-seam-prep`, open PR ("B15 PR1: db seam prep (#56)" — body references #56 but does **not** close it; PR3 closes), request Copilot review, reply to and resolve every thread, triage suppressed comments each round.
- LOGBOOK entry (by PR number) as the LAST commit on the branch before merge, on the owner's cue.
- Known PR2 concerns recorded during this plan (do NOT address in PR1): the stores' `_migrate` paths contain SQLite-legacy logic (`sqlite_master` reads, PRAGMA-based rebuilds) that PR2 must dialect-gate; `table_columns` grows its `information_schema` branch in PR2; the factory named by spec §R1/§R6 lands in PR2 with the `database:` settings block — PR1's direct `SqliteDatabase` imports in `main.py`/`manage.py` are its future call sites.
- Deliberate refinement vs spec §R1 wording: the busy `timeout` moves entirely onto `SqliteDatabase` instead of remaining a store parameter — only `manage.py:291` ever passes one, and it goes straight to the `Database` it constructs. The spec has been amended to match.
