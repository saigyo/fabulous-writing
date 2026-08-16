"""Seam-level tests for app/services/db: transaction wrapping, error
mapping, and column introspection on the SQLite implementation."""

import logging
import sqlite3

import pytest

from app.core.config import Settings
from app.services.db import UniqueViolationError, create_database, migrate_columns, table_columns
from app.services.db.sqlite import SqliteDatabase

_DDL = (
    "CREATE TABLE t ("
    " id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " email TEXT NOT NULL,"
    " n INTEGER NOT NULL);"
    "CREATE UNIQUE INDEX idx_t_email_lower ON t (LOWER(email));"
)


@pytest.fixture
def db(tmp_path):  # intentionally shadows conftest's parametrized `db`: this module is seam-scoped by design
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
            # GENERATED BY DEFAULT (not ALWAYS) is a deliberate spec choice:
            # PR3's import tool must be able to insert explicit ids.
            conn.execute(
                "INSERT INTO t (id, email, n) VALUES (?, ?, ?)", (77, "b@x.de", 2)
            )
            (explicit,) = conn.execute(
                "SELECT id FROM t WHERE email = ?", ("b@x.de",)
            ).fetchone()
            assert explicit == 77

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
