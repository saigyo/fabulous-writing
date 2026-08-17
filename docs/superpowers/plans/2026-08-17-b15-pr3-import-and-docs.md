# B15 PR3: Import Tool + Postgres Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the one-time SQLite→Postgres import (`manage.py import-to-postgres`) and the operator documentation (`docs/postgres-setup.md` + cross-references), closing #56.

**Architecture:** The import logic lives in a new module `app/manage_import.py` (keeps `manage.py` lean); `manage.py` registers the subcommand and branches to it early, because the importer manages TWO databases (SQLite source from `--db`/settings, Postgres target from `FW_DATABASE_URL`) and doesn't fit the `(store, args)` handler contract. Constructing the stores against both databases first normalizes both schemas (source migrations run, target schema is created); then raw rows copy in FK order with explicit ids through ONE target transaction, identity sequences reset via `setval`, per-table counts verified before the single commit.

**Tech Stack:** Python 3.13, the PR1/PR2 seam (`SqliteDatabase`, `PostgresDatabase`, `table_columns`), pytest with a module-local throwaway-schema fixture.

**Spec:** `docs/superpowers/specs/2026-08-16-b15-postgres-backend-design.md` §R8 + §R9 + Phasing PR3.

## Global Constraints

- Default gate `uv run pytest -q` (from `backend/`) green with ZERO warnings and no `FW_TEST_DATABASE_URL`; PG-dependent tests skip cleanly. With the env var set, the full matrix stays green. Local PG: `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (supabase stack via `supabase start` only).
- Tests never touch a live database (`tmp_path` SQLite, throwaway-schema Postgres); `backend/data/fabulous.db` never read or written.
- `FW_DATABASE_URL` value never logged or echoed — the variable NAME only. Printing operator account emails in the collision error is correct and spec-sanctioned (operator-only CLI; the secret rules cover credentials, not account data).
- The importer must never write to the SOURCE beyond the store constructors' own idempotent migrations; the TARGET is written only inside the single transaction.
- Mutation-verify every new guard (delete guard → watch the test fail → restore by re-editing, NEVER `git checkout <file>`).
- Single-file pytest `-n0`. Frontend untouched. Commit trailers per repo convention on every commit.
- Branch `b15-postgres-import`; the PR body carries `Closes #56.` on its own line (this is the closing PR).

## File Structure

- **Create** `backend/app/manage_import.py` — the importer: table order, collision pre-check, copy, `setval`, verification.
- **Modify** `backend/app/manage.py` — subcommand registration + early branch (~10 lines).
- **Create** `backend/tests/test_import_postgres.py` — the importer's test module.
- **Create** `docs/postgres-setup.md`; **Modify** `docs/supabase-auth-setup.md` (one cross-reference), `docs/backend-architecture.md` (importer paragraph + operator-CLI section touch-up).

All backend commands run from `backend/`. `PG_ENV` means the prefix `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (controller confirms the stack is up before execution).

---

### Task 1: The importer + subcommand + tests

**Files:**
- Create: `backend/app/manage_import.py`
- Modify: `backend/app/manage.py` (`_build_parser` ~line 246, `main()` early branch after `_parse_args`)
- Test: `backend/tests/test_import_postgres.py`

**Interfaces:**
- Consumes: `SqliteDatabase`, `PostgresDatabase` (constructed directly — the importer bypasses `create_database` because source and target coexist regardless of `database.backend`), `table_columns`, `DATABASE_URL_ENV`, all six store classes (schema init), `load_settings`/`Settings` from manage.py's existing imports.
- Produces: `app.manage_import.run_import(source_path: Path, *, env: Mapping[str, str] | None = None) -> int` (0 success, 1 refusal/error); manage.py subcommand `import-to-postgres` honoring `--db` as the SOURCE override.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_import_postgres.py`. Structure (write the module in this order; the PG-dependent tests use the module-local DSN fixture defined in item 0 below):

```python
"""SQLite→Postgres import tool (B15 PR3, spec §R8).

The PG tests drive main(["import-to-postgres", ...]) in-process with
FW_DATABASE_URL pointing at a module-local throwaway-schema fixture;
the source is a tmp_path SQLite file populated through the real stores.
"""
```

0. **The DSN fixture** (module-local — there is NO existing fixture to reuse; `pg_database` exposes no DSN and `test_postgres_smoke.py`'s fixture builds its own): mirror the smoke test's schema handling — read `FW_TEST_DATABASE_URL` (skip if unset), create a throwaway schema via an admin psycopg connection, build `dsn = f"{base}{sep}options=-csearch_path%3D{schema}"`, `monkeypatch.setenv("FW_DATABASE_URL", dsn)`, yield a `PostgresDatabase(dsn)` for the tests' target-side assertions, and in teardown close it and `DROP SCHEMA … CASCADE`. Do not reference the conftest `pg_database` fixture.

1. `test_missing_env_fails_naming_the_variable` (NO PG needed — runs in the default gate): build a small source via `SqliteDatabase(tmp_path / "src.db")` + `UserStore(db)` + one `create_user`; call `main(["--db", str(src), "import-to-postgres"])` with `FW_DATABASE_URL` guaranteed absent (`monkeypatch.delenv("FW_DATABASE_URL", raising=False)`); assert return 1 and `capsys` stderr contains `FW_DATABASE_URL` and does NOT contain any DSN-ish value.
1b. `test_missing_source_fails_naming_the_path` (NO PG needed): `main(["--db", str(tmp_path / "absent.db"), "import-to-postgres"])` with a syntactically valid dummy `FW_DATABASE_URL` set — the DSN-present check runs first, so a dummy is needed; the source-not-found return then fires BEFORE any connection is attempted, so the dummy is never dialed. Assert return 1 and stderr names the path.
1c. `test_default_source_comes_from_settings` (PG): omit `--db`; point `FW_CONFIG_FILE` at a tmp config whose `db_path` names the populated source (see `tests/conftest.py`'s `_config_isolation` for the mechanism); run `main(["import-to-postgres"])`; assert the import succeeds — this pins the `load_settings().db_path` default.
2. `test_happy_path_copies_all_tables_with_ids_and_sequences` (PG): populate the source through the real stores — at least: two users (one with `external_id`), one audit row (`UserStore.record_audit` — keyword-only), one folder (`FolderStore.create_folder(name, *, owner_id=…)`), one document IN that folder, one OWNED domain + one term in it (`TerminologyStore.create_term(domain_id, *, owner_id, is_admin, …)` — a term on a GLOBAL domain with `is_admin=False` raises `GlobalReadOnlyError`, so create the domain with an owner or pass `is_admin=True`), one profile, a seed marker (`ProfileStore.mark_example_seeded(Language…)`), one settled `llm_usage` row — for the reservation, reuse `tests/test_usage.py:17-45`'s ready-made `LIMITS`/`SERVER`/`REQUESTED`/`EFFECTIVE`/`FakeUser` constants rather than constructing settings objects (a bare `TierLimitsSettings()` fails validation). Run the import. Assert per table: target count == source count; spot-check ids preserved (the document's `folder_id` still resolves, the term's `domain_id` still resolves); **sequence continuation**: construct a `UserStore` on the fixture's `PostgresDatabase` and `create_user` a fresh user — its id must be `max(imported ids) + 1` (the `setval` pin; mutation target).
3. `test_non_empty_target_refused_without_writes` (PG): pre-create one user directly in the target schema (construct a `UserStore` on the module-local fixture's `PostgresDatabase` + `create_user`), then run the import of a 2-user source; assert return 1, stderr names the non-empty table, and the target still has exactly 1 user (nothing copied).
4. `test_email_collision_under_unicode_folding_refused` (PG): source with two users whose emails are distinct under SQLite’s ASCII folding but collide under full-Unicode folding — **write the second address with an explicit escape in the test code, never a raw glyph**: `"kelvin@x.de"` and `"\u212Aelvin@x.de"` (KELVIN SIGN + "elvin@x.de"; both Python’s `str.lower()` and PG’s `lower()` fold U+212A to `k` — probe-verified). Assert return 1, stderr lists both ids and both emails, and the target user count is 0.
4b. `test_source_only_column_refused_before_any_write` (PG): add a stray column to the source after store init (`ALTER TABLE users ADD COLUMN legacy_flag INTEGER` through a raw connect); assert return 1, stderr names the table and the extra column, and every target count is 0 — the pre-write column-set check (mutation target (d)).
5. `test_failure_mid_copy_leaves_target_empty` (PG): monkeypatch one late table's copy to raise (e.g. patch `app.manage_import._copy_table` with a wrapper raising on `"llm_usage"`); assert the importer returns 1 (or propagates — pick one and assert it; returning 1 with the error on stderr matches the CLI's conventions) and EVERY earlier table's target count is 0 — the single-transaction pin (mutation target: committing per-table instead must fail this).

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/test_import_postgres.py -n0 -q` → collection error (`app.manage_import` missing / unknown command). Then `PG_ENV uv run pytest tests/test_import_postgres.py -n0 -q` → same.

- [ ] **Step 3: Implement `app/manage_import.py`**

```python
"""One-time SQLite→Postgres import (B15 PR3, spec §R8).

Operator flow: configure FW_DATABASE_URL (target), keep database.backend
on sqlite until the import verifies, run
`python -m app.manage --db SOURCE.db import-to-postgres`, then flip
database.backend to postgres. The tool is all-or-nothing: one target
transaction, committed only after per-table count verification.
"""

import sys
from collections.abc import Mapping
from pathlib import Path

from app.services.db import DATABASE_URL_ENV, table_columns
from app.services.db.postgres import PostgresDatabase
from app.services.db.sqlite import SqliteDatabase
from app.services.documents import DocumentStore
from app.services.folders import FolderStore
from app.services.profiles import ProfileStore
from app.services.terminology import TerminologyStore
from app.services.usage import UsageStore
from app.services.users import UserStore

# Copy order: terms REFERENCES domains (the schema's one declared FK);
# everything else is logical-reference only, ordered parents-first for
# sanity. profile_seed_markers has no identity column.
_TABLES = (
    "users",
    "admin_audit",
    "folders",
    "documents",
    "domains",
    "terms",
    "profiles",
    "profile_seed_markers",
    "llm_usage",
)
_IDENTITY_TABLES = tuple(t for t in _TABLES if t != "profile_seed_markers")


def _init_stores(db) -> None:
    """Constructing the stores runs schema init + idempotent migrations —
    normalizing an old source file and creating the target schema."""
    UserStore(db)
    FolderStore(db)
    DocumentStore(db)
    TerminologyStore(db)
    ProfileStore(db)
    UsageStore(db)


def _collisions_under_unicode_folding(src_conn) -> list[tuple[int, str]]:
    """users rows whose emails collide under full-Unicode lower().

    SQLite's LOWER() is ASCII-only, so two rows can coexist there and
    still violate the target's LOWER(email) unique index (Postgres folds
    full Unicode). Grouping happens in Python for exactly that reason.
    """
    rows = src_conn.execute("SELECT id, email FROM users ORDER BY id").fetchall()
    by_folded: dict[str, list[tuple[int, str]]] = {}
    for row in rows:
        by_folded.setdefault(row["email"].lower(), []).append((row["id"], row["email"]))
    return [item for group in by_folded.values() if len(group) > 1 for item in group]


def _source_only_columns(src_conn, dst_conn) -> list[tuple[str, set[str]]]:
    """Tables whose SOURCE carries columns the target schema lacks.

    Both sides run the same store migrations, so ADDED columns are
    symmetric — but CREATE TABLE IF NOT EXISTS never drops a column, so a
    pre-B15 file can carry one the current schema no longer has. Refusing
    up front with names beats a raw driver error mid-copy.
    """
    extras = []
    for table in _TABLES:
        extra = table_columns(src_conn, table) - table_columns(dst_conn, table)
        if extra:
            extras.append((table, extra))
    return extras


def _copy_table(src_conn, dst_conn, table: str) -> int:
    columns = sorted(table_columns(src_conn, table))
    column_list = ", ".join(columns)
    placeholders = ", ".join("?" for _ in columns)
    # Whole-table fetch is deliberate: a one-time operator tool at
    # single-deployment scale, and the copy must sit in one transaction
    # anyway.
    rows = src_conn.execute(f"SELECT {column_list} FROM {table}").fetchall()
    for row in rows:
        dst_conn.execute(
            f"INSERT INTO {table} ({column_list}) VALUES ({placeholders})",
            tuple(row[c] for c in columns),
        )
    return len(rows)


def run_import(source_path: Path, *, env: Mapping[str, str] | None = None) -> int:
    import os

    environ = os.environ if env is None else env
    dsn = environ.get(DATABASE_URL_ENV, "").strip()
    if not dsn:
        print(
            f"import-to-postgres needs {DATABASE_URL_ENV} set to the target"
            " database (the value is never printed).",
            file=sys.stderr,
        )
        return 1
    if not source_path.exists():
        print(f"source database not found: {source_path}", file=sys.stderr)
        return 1

    source = SqliteDatabase(source_path)
    _init_stores(source)
    try:
        # A bad DSN raises RuntimeError from the pool's boot wait; keep the
        # CLI's rc=1 convention instead of a traceback. The message names
        # the variable only — never the value.
        target = PostgresDatabase(dsn)
    except RuntimeError as exc:
        print(f"could not connect to the {DATABASE_URL_ENV} target: {exc}", file=sys.stderr)
        return 1
    try:
        # NOTE: this creates the target schema (empty tables) BEFORE the
        # refusal checks below — deliberate, so the checks can query the
        # tables; a refused target holds only empty tables and is safe to
        # re-import into after fixing the cause.
        _init_stores(target)

        with source.connect() as src_conn:
            with target.connect() as probe_conn:
                extras = _source_only_columns(src_conn, probe_conn)
            if extras:
                print(
                    "refusing to import: the source carries columns the"
                    " current schema does not — inspect these before"
                    " migrating:",
                    file=sys.stderr,
                )
                for table, cols in extras:
                    print(f"  {table}: {', '.join(sorted(cols))}", file=sys.stderr)
                return 1

            collisions = _collisions_under_unicode_folding(src_conn)
            if collisions:
                print(
                    "refusing to import: these user emails are distinct in"
                    " SQLite but collide under Postgres' case folding —"
                    " resolve them first:",
                    file=sys.stderr,
                )
                for row_id, email in collisions:
                    print(f"  id={row_id}  {email}", file=sys.stderr)
                return 1

            with target.connect() as probe:
                non_empty = [
                    t
                    for t in _TABLES
                    if probe.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] > 0
                ]
            if non_empty:
                print(
                    "refusing to import into a non-empty target — rows exist"
                    f" in: {', '.join(non_empty)}",
                    file=sys.stderr,
                )
                return 1

            # One transaction for every write below: raw_connect gives the
            # caller-managed connection; nothing commits until the counts
            # verify. Any failure (including a raise) rolls back on close.
            dst_conn = target.raw_connect()
            try:
                source_counts: dict[str, int] = {}
                for table in _TABLES:
                    source_counts[table] = _copy_table(src_conn, dst_conn, table)
                for table in _IDENTITY_TABLES:
                    if source_counts[table]:
                        # GENERATED BY DEFAULT accepted our explicit ids; the
                        # sequence must move past them or the next insert
                        # collides with an imported row.
                        dst_conn.execute(
                            f"SELECT setval(pg_get_serial_sequence('{table}', 'id'),"
                            f" (SELECT MAX(id) FROM {table}))"
                        )
                # Belt-and-braces: these counts run inside the same
                # uncommitted transaction that wrote the rows, so a mismatch
                # is unreachable today — the check guards against a future
                # ON CONFLICT / trigger silently dropping rows.
                mismatches = []
                for table in _TABLES:
                    (count,) = dst_conn.execute(
                        f"SELECT COUNT(*) FROM {table}"
                    ).fetchone()
                    if count != source_counts[table]:
                        mismatches.append((table, source_counts[table], count))
                if mismatches:
                    dst_conn.rollback()
                    for table, expected, got in mismatches:
                        print(
                            f"verification failed for {table}: source"
                            f" {expected}, target {got}; nothing committed",
                            file=sys.stderr,
                        )
                    return 1
                dst_conn.commit()
            except Exception as exc:
                dst_conn.rollback()
                print(f"import failed, nothing committed: {exc}", file=sys.stderr)
                return 1
            finally:
                dst_conn.close()

        for table in _TABLES:
            print(f"  {table}: {source_counts[table]} rows")
        print("import complete and verified; set database.backend to 'postgres'.")
        return 0
    finally:
        target.close()
        source.close()  # documented no-op; symmetry with the seam contract
```

- [ ] **Step 4: Wire the subcommand in `manage.py`**

In `_build_parser` (~line 252), after the `_COMMANDS` loop:

```python
    subparsers.add_parser(
        "import-to-postgres",
        help="one-time copy of the SQLite database into FW_DATABASE_URL",
    )
```

`_SilentArgumentParser.error()` builds its command list from `_COMMANDS`, so it would omit the new command while argparse's usage line lists it — two lines contradicting each other. Read `error()` and fix it: introduce `_ALL_COMMANDS = (*_COMMANDS, "import-to-postgres")` next to `_COMMANDS` and have `error()` join that instead.

In `main()`, directly after `args = _parse_args(...)` and the `read_password` line (BEFORE the `--db`/settings resolution, which warns about postgres config — that warning is wrong for this command, whose whole point is a sqlite source):

```python
    if args.command == "import-to-postgres":
        # Imported lazily so sqlite-only deployments and every other
        # subcommand keep never importing psycopg (seam §R1).
        from app.manage_import import run_import

        source_path = args.db if args.db is not None else load_settings().db_path
        return run_import(source_path)
```

- [ ] **Step 5: Run to verify green, both env modes**

Run: `uv run pytest tests/test_import_postgres.py -n0 -q` → test 1 passes, PG tests skip.
Run: `PG_ENV uv run pytest tests/test_import_postgres.py -n0 -q` → all pass.

- [ ] **Step 6: Mutation-verify the three guards**

(a) Comment out the `setval` loop → `test_happy_path…` must fail, and the OBSERVED failure is a `DuplicateEmailError` ("A user with email … already exists"), NOT a low-id assertion: the identity PK collision surfaces as `UniqueViolation`, which `create_user` maps to its duplicate-email error (probe-verified). Do not write an `id ==` assertion expecting to see it fire under mutation. Restore.
(b) Replace the single-transaction shape with a per-table `dst_conn.commit()` inside the copy loop → `test_failure_mid_copy_leaves_target_empty` must fail (earlier tables committed); restore.
(c) Make `_collisions_under_unicode_folding` return `[]` unconditionally → `test_email_collision…` must fail (import proceeds and either succeeds vacuously or dies on the unique index — either way the refusal assertion fails); restore.
(d) Make `_source_only_columns` return `[]` unconditionally → `test_source_only_column_refused_before_any_write` must fail (the copy aborts on the raw driver error instead of the named refusal); restore.
Record all four transcripts in the report.

- [ ] **Step 7: Full gates and commit**

Run: `uv run pytest -q` → green, zero warnings. `PG_ENV uv run pytest -q` → green.

```bash
git add app/manage_import.py app/manage.py tests/test_import_postgres.py
git commit -m "feat(manage): import-to-postgres — FK-ordered copy, unicode-collision pre-check, setval, single transaction (B15 PR3, #56)"
```

---

### Task 2: Operator docs

**Files:**
- Create: `docs/postgres-setup.md`
- Modify: `docs/supabase-auth-setup.md` (one sentence), `docs/backend-architecture.md` (importer paragraph)

**Interfaces:**
- Consumes: Task 1's shipped command name and output; spec §R9's content list (including the owner-requested password-mechanisms bullet, 2026-08-17).

- [ ] **Step 1: Write `docs/postgres-setup.md`**

Match the voice and structure of `docs/supabase-auth-setup.md` (read it first). Required content, all from spec §R9 — write it as an operator guide, not a feature list:

1. **When to use Postgres mode** — one paragraph: hosted deployments; SQLite remains the default and fully supported; the backend treats Postgres as plain managed Postgres (Supabase is the documented hosted instance).
2. **Connection string** — `database.backend: postgres` in config; `FW_DATABASE_URL` env-only (why: it carries the password; never in config.yaml, never logged — the app prints only the variable name). Supabase specifics: use the **direct connection or Supavisor session mode**, never transaction mode. The honest reason (the spec's original wording is corrected in this task, see below): the app issues server-side prepared statements (psycopg's default `prepare_threshold`), which transaction-mode pooling does not support — and the app already runs its own connection pool, so an external transaction pooler adds nothing. (The app's advisory locks are the transaction-scoped `pg_advisory_xact_lock` kind and would survive transaction pooling; they are not the reason.)
3. **How the password reaches the app** (owner-requested): normally the DSN's userinfo, special characters percent-encoded (`@`→`%40`, `:`→`%3A`, `/`→`%2F`, `%`→`%25`); alternatives inherited from libpq because the app passes the DSN verbatim — password-less DSN + `PGPASSWORD`, `~/.pgpass` (`PGPASSFILE`), or `key=value` conninfo format. Deployment example: the container env-var form that ships today (`docker run -e FW_DATABASE_URL=... `, per the single-container setup); note `fly secrets set FW_DATABASE_URL=...` as the forward-looking B16 pattern, explicitly marked as not yet shipped.
4. **Migrating an existing SQLite deployment** — the `import-to-postgres` walkthrough: stop the server; **copy the .db file first** (the importer runs the same idempotent schema migrations the server itself would run on next start — content is preserved, but the file is not byte-frozen); set `FW_DATABASE_URL` (keep `database.backend: sqlite` for now); run `python -m app.manage --db /path/to/fabulous.db import-to-postgres` — **`--db` is a top-level option and MUST precede the subcommand** (or omit it to use the configured `db_path`); the tool refuses non-empty targets, source-only columns, and email collisions under Postgres' case folding, copies everything in one verified transaction, and prints per-table counts; on success flip `database.backend: postgres` and start the server. Two failure modes worth naming: a refused run leaves the target with empty tables only — safe to re-run after fixing the cause; and duplicate folder/domain/profile NAMES that old SQLite databases may legally hold (their unique indexes were skipped-with-warning) surface as a unique-constraint error and roll back cleanly — resolve the duplicates in the app, then re-run.
5. **Backup** — one paragraph: your Postgres provider's backup story replaces copying the data directory; the pre-import copy of the SQLite file is the point-in-time fallback until you delete it.
6. **Known logging caveat** — one sentence: on a MALFORMED `FW_DATABASE_URL` (syntax errors, not wrong credentials), psycopg's pool logger may echo the offending connection string in its error line before the app's own variable-name-only message; treat those log lines as sensitive (tracked as a follow-up issue).

- [ ] **Step 1b: Correct the spec's Supavisor rationale**

Spec §R9's session-mode sentence gives the wrong reason ("relies on advisory locks and `search_path`" — the locks are transaction-scoped and pooling-compatible; production DSNs carry no `search_path`). Amend the spec sentence to the prepared-statements + own-pool rationale from Step 1 item 2, in the same commit — a wrong reason in an operator doc's source-of-truth is worse than none.

- [ ] **Step 2: Cross-references**

`docs/supabase-auth-setup.md`: one sentence in its intro region — auth mode and database backend are independent; Postgres setup lives in `docs/postgres-setup.md`.
`docs/backend-architecture.md`: a short importer paragraph in the operator-CLI/manage.py area (locate by content): what `import-to-postgres` does (stores-initialized schemas, unicode-folding pre-check, FK-ordered copy with explicit ids, `setval`, count-verified single transaction) with a pointer to `docs/postgres-setup.md`.

- [ ] **Step 3: Sweep and gates**

Run: `rtk proxy grep -rn "postgres-setup" docs/ --include="*.md"` → the two new references plus the file itself; no dead links.
Run (from `backend/`): `uv run pytest -q` → green, zero warnings (docs-only task; this is the standard gate).

- [ ] **Step 4: Commit**

```bash
git add ../docs/postgres-setup.md ../docs/supabase-auth-setup.md ../docs/backend-architecture.md ../docs/superpowers/specs/2026-08-16-b15-postgres-backend-design.md
git commit -m "docs(postgres): operator setup guide — DSN/password mechanisms, session-mode pooling, import walkthrough (B15 PR3, #56)"
```

---

## Post-plan (not tasks)

- Push `b15-postgres-import`, open PR ("B15 PR3: import tool + Postgres docs" — body carries `Closes #56.` on its own line), Copilot review, reply/resolve every thread, triage suppressed comments each round. LOGBOOK entry as LAST commit on the owner's cue; owner merges.
- Controller pre-flight before Task 1: supabase stack PG answering on 54322.
- After merge: #56 closes automatically; B15 complete — B16 (fly.io) unblocked with the stateless profile available.
