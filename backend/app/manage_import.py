"""One-time SQLite→Postgres import (B15 PR3, spec §R8).

Operator flow: configure FW_DATABASE_URL (target), keep database.backend
on sqlite until the import verifies, run
`python -m app.manage --db SOURCE.db import-to-postgres`, then flip
database.backend to postgres. The tool is all-or-nothing: one target
transaction, committed only after per-table count verification.
"""

import sqlite3
import sys
from collections.abc import Mapping
from pathlib import Path

# Not a new lazy-load path: app.services.db.postgres already imports psycopg,
# and this module (manage_import) is itself imported lazily by manage.py, so
# sqlite-only deployments still never load psycopg.
import psycopg

from app.schema import init_stores
from app.services.db import DATABASE_URL_ENV, table_columns
from app.services.db.postgres import PostgresDatabase
from app.services.db.sqlite import SqliteDatabase

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


def _collisions_under_unicode_folding(src_conn, dst_conn) -> list[tuple[int, str]]:
    """users rows whose emails collide under the TARGET's own LOWER().

    SQLite's LOWER() is ASCII-only, so two rows can coexist there and
    still violate the target's LOWER(email) unique index. The fold that
    matters is the exact one that index applies — the target's LOWER(),
    which follows the database's collation — not Python's str.lower(),
    which is locale-independent and can disagree with it on exotic
    locales. So each email is folded by asking the target directly, one
    query per row (operator-scale N keeps the round-trip cost fine).
    """
    rows = src_conn.execute("SELECT id, email FROM users ORDER BY id").fetchall()
    by_folded: dict[str, list[tuple[int, str]]] = {}
    for row in rows:
        (folded,) = dst_conn.execute("SELECT LOWER(?)", (row["email"],)).fetchone()
        by_folded.setdefault(folded, []).append((row["id"], row["email"]))
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


_COPY_CHUNK_SIZE = 500


def _copy_table(src_conn, dst_conn, table: str) -> int:
    columns = sorted(table_columns(src_conn, table))
    column_list = ", ".join(columns)
    placeholders = ", ".join("?" for _ in columns)
    # Streamed via fetchmany, not fetchall: documents carries large texts
    # and llm_usage grows without bound, so a whole-table fetch risks
    # unbounded memory. Row-at-a-time insert count is unchanged (still one
    # round-trip per row) and the copy still sits in one transaction —
    # streaming only bounds how much of the source is held in memory at
    # once, not the round-trip count.
    cursor = src_conn.execute(f"SELECT {column_list} FROM {table}")
    count = 0
    while True:
        rows = cursor.fetchmany(_COPY_CHUNK_SIZE)
        if not rows:
            break
        for row in rows:
            dst_conn.execute(
                f"INSERT INTO {table} ({column_list}) VALUES ({placeholders})",
                tuple(row[c] for c in columns),
            )
        count += len(rows)
    return count


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

    try:
        # source_path.exists() only rules out "nothing there" — a locked,
        # corrupt, or non-database file (or a directory, which passes
        # .exists() too) only surfaces once sqlite3 actually opens it, which
        # happens lazily on the first statement the store constructors run
        # below. Mirrors manage.py's own catch around UserStore construction.
        source = SqliteDatabase(source_path)
        init_stores(source)
    except sqlite3.Error as exc:
        print(
            f"could not open source database at {source_path} ({exc}). Check "
            "the path and its permissions.",
            file=sys.stderr,
        )
        return 1
    try:
        # A bad DSN raises RuntimeError from the pool's boot wait; keep the
        # CLI's rc=1 convention instead of a traceback. The message names
        # the variable only — never the value.
        target = PostgresDatabase(dsn)
    except RuntimeError as exc:
        print(f"import-to-postgres: {exc}", file=sys.stderr)
        return 1
    try:
        # NOTE: this creates the target schema (empty tables) BEFORE the
        # refusal checks below — deliberate, so the checks can query the
        # tables; a refused target holds only empty tables and is safe to
        # re-import into after fixing the cause.
        try:
            init_stores(target)
        except psycopg.Error as exc:
            # A connectable target whose role lacks DDL privileges, or one
            # with an incompatible existing schema, fails here — driver/DDL
            # errors of this kind name the offending object, not the DSN, so
            # this is safe to print in full (unlike the RuntimeError catch
            # above, which guards a message that could otherwise echo the
            # connection string).
            print(f"could not initialize the target schema: {exc}", file=sys.stderr)
            return 1

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

            with target.connect() as probe_conn:
                collisions = _collisions_under_unicode_folding(src_conn, probe_conn)
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
                        # collides with an imported row. setval() is
                        # deliberately NOT used here: it is non-transactional
                        # (a sequence advance it makes survives a ROLLBACK),
                        # which would contradict this function's "nothing
                        # committed" promise on a later failure. ALTER
                        # TABLE ... RESTART WITH is ordinary catalog DDL and
                        # rolls back with the rest of the transaction
                        # (verified empirically against live Postgres).
                        (max_id,) = dst_conn.execute(
                            f"SELECT MAX(id) FROM {table}"
                        ).fetchone()
                        dst_conn.execute(
                            f"ALTER TABLE {table} ALTER COLUMN id RESTART WITH"
                            f" {int(max_id) + 1}"
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
