"""SQLite→Postgres import tool (B15 PR3, spec §R8).

The PG tests drive main(["import-to-postgres", ...]) in-process with
FW_DATABASE_URL pointing at a module-local throwaway-schema fixture;
the source is a tmp_path SQLite file populated through the real stores.
"""

import os
import sqlite3
import uuid
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from app.core.models import Language
from app.manage import main
from app.manage_import import run_import
from app.services.db.postgres import PostgresDatabase
from app.services.db.sqlite import SqliteDatabase
from app.services.documents import DocumentStore
from app.services.folders import FolderStore
from app.services.profiles import ProfileStore
from app.services.terminology import TerminologyStore
from app.services.usage import UsageStore
from app.services.users import UserStore
from tests.test_usage import EFFECTIVE, LIMITS, REQUESTED, SERVER, FakeUser


@pytest.fixture()
def pg_import_target(monkeypatch: pytest.MonkeyPatch) -> Iterator[PostgresDatabase]:
    """A throwaway-schema Postgres target, wired in via FW_DATABASE_URL.

    Module-local — there is no existing fixture to reuse: conftest's
    pg_database exposes no DSN, and test_postgres_smoke.py's fixture builds
    its own for the same reason (it needs the raw DSN to monkeypatch it in).
    Mirrors both fixtures' schema handling: an admin connection creates a
    throwaway schema, the DSN pins search_path to it, and teardown drops it.
    """
    base_dsn = os.environ.get("FW_TEST_DATABASE_URL", "").strip()
    if not base_dsn:
        pytest.skip("FW_TEST_DATABASE_URL not set")
    schema = f"fw_import_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        admin.execute(f'CREATE SCHEMA "{schema}"')
    sep = "&" if "?" in base_dsn else "?"
    dsn = f"{base_dsn}{sep}options=-csearch_path%3D{schema}"
    monkeypatch.setenv("FW_DATABASE_URL", dsn)
    database = PostgresDatabase(dsn)
    try:
        yield database
    finally:
        database.close()
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            admin.execute(f'DROP SCHEMA "{schema}" CASCADE')


_ALL_TABLES = (
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


def _table_counts(database: PostgresDatabase) -> dict[str, int]:
    with database.connect() as conn:
        return {
            table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in _ALL_TABLES
        }


def test_missing_env_fails_naming_the_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    src = tmp_path / "src.db"
    UserStore(SqliteDatabase(src)).create_user("user@example.com", "password12345")
    monkeypatch.delenv("FW_DATABASE_URL", raising=False)

    rc = main(["--db", str(src), "import-to-postgres"])

    assert rc == 1
    err = capsys.readouterr().err
    assert "FW_DATABASE_URL" in err
    assert "postgresql://" not in err


def test_run_import_env_mapping_is_honored(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # run_import's env kwarg mirrors create_database's seam; main() never
    # exercises it (it always passes the process environment implicitly),
    # so this drives run_import directly to prove the kwarg is honored.
    src = tmp_path / "src.db"
    UserStore(SqliteDatabase(src)).create_user("user@example.com", "password12345")

    rc = run_import(src, env={})

    assert rc == 1
    err = capsys.readouterr().err
    assert "FW_DATABASE_URL" in err


def test_missing_source_fails_naming_the_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # The DSN-present check runs first, so a syntactically valid dummy is
    # needed here — but the source-not-found return fires before any
    # connection is attempted, so the dummy is never dialed.
    monkeypatch.setenv("FW_DATABASE_URL", "postgresql://user:pass@localhost:5432/db")
    absent = tmp_path / "absent.db"

    rc = main(["--db", str(absent), "import-to-postgres"])

    assert rc == 1
    err = capsys.readouterr().err
    assert str(absent) in err


def test_directory_source_fails_naming_the_path_without_traceback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # A dummy DSN is needed for the same reason as
    # test_missing_source_fails_naming_the_path: the DSN-present check runs
    # first. Unlike that test, a directory passes source_path.exists(), so
    # this exercises the sqlite3.Error catch around opening the source —
    # which must fire (and print a named, actionable message) before PG is
    # ever dialed, so no PG env/fixture is needed here.
    monkeypatch.setenv("FW_DATABASE_URL", "postgresql://user:pass@localhost:5432/db")
    src_dir = tmp_path / "not_a_file.db"
    src_dir.mkdir()

    rc = main(["--db", str(src_dir), "import-to-postgres"])

    assert rc == 1
    err = capsys.readouterr().err
    assert str(src_dir) in err
    assert "Traceback" not in err


def test_default_source_comes_from_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pg_import_target: PostgresDatabase
) -> None:
    src = tmp_path / "src.db"
    UserStore(SqliteDatabase(src)).create_user("user@example.com", "password12345")
    config_file = tmp_path / "config.yaml"
    config_file.write_text(f'db_path: "{src}"\n', encoding="utf-8")
    monkeypatch.setenv("FW_CONFIG_FILE", str(config_file))

    rc = main(["import-to-postgres"])

    assert rc == 0
    assert _table_counts(pg_import_target)["users"] == 1


def test_happy_path_copies_all_tables_with_ids_and_sequences(
    tmp_path: Path, pg_import_target: PostgresDatabase
) -> None:
    src_path = tmp_path / "src.db"
    source = SqliteDatabase(src_path)

    users = UserStore(source)
    user1 = users.create_user("alice@example.com", "password12345")
    user2 = users.create_user(
        "bob@example.com", "password12345", external_id="ext-bob-1"
    )
    users.record_audit(
        actor_id=user1.id,
        target_id=user2.id,
        field="tier",
        old_value="basic",
        new_value="pro",
    )

    folders = FolderStore(source)
    folder = folders.create_folder("Reports", owner_id=user1.id)

    documents = DocumentStore(source)
    document = documents.create_document(
        "Doc", Language.EN, owner_id=user1.id, folder_id=folder.id
    )

    terms = TerminologyStore(source)
    domain = terms.create_domain("Style", owner_id=user1.id)
    term = terms.create_term(
        domain.id,
        owner_id=user1.id,
        is_admin=False,
        language=Language.EN,
        preferred="color",
    )

    profiles = ProfileStore(source)
    profiles.create_profile(Language.EN, "My Profile", owner_id=user1.id)
    profiles.mark_example_seeded(Language.EN)

    usage = UsageStore(source)
    decision = usage.reserve_llm_run(
        FakeUser(user1.id), LIMITS, SERVER, REQUESTED, EFFECTIVE, 100, "check", "run-1"
    )
    assert decision.kind == "admitted"
    usage.finish_run(
        decision.reservation_id, "completed", input_tokens=10, output_tokens=5
    )

    source.close()

    rc = main(["--db", str(src_path), "import-to-postgres"])
    assert rc == 0

    counts = _table_counts(pg_import_target)
    assert counts == {
        "users": 2,
        "admin_audit": 1,
        "folders": 1,
        "documents": 1,
        "domains": 1,
        "terms": 1,
        "profiles": 1,
        "profile_seed_markers": 1,
        "llm_usage": 1,
    }

    with pg_import_target.connect() as conn:
        doc_row = conn.execute(
            "SELECT folder_id FROM documents WHERE id = ?", (document.id,)
        ).fetchone()
        assert doc_row["folder_id"] == folder.id
        term_row = conn.execute(
            "SELECT domain_id FROM terms WHERE id = ?", (term.id,)
        ).fetchone()
        assert term_row["domain_id"] == domain.id

    target_users = UserStore(pg_import_target)
    expected_next_id = max(user1.id, user2.id) + 1
    fresh = target_users.create_user("carol@example.com", "password12345")
    assert fresh.id == expected_next_id


def test_non_empty_target_refused_without_writes(
    tmp_path: Path, pg_import_target: PostgresDatabase, capsys: pytest.CaptureFixture[str]
) -> None:
    UserStore(pg_import_target).create_user("existing@example.com", "password12345")

    src_path = tmp_path / "src.db"
    source_users = UserStore(SqliteDatabase(src_path))
    source_users.create_user("one@example.com", "password12345")
    source_users.create_user("two@example.com", "password12345")

    rc = main(["--db", str(src_path), "import-to-postgres"])

    assert rc == 1
    err = capsys.readouterr().err
    assert "users" in err
    # Pinned to the refusal's own wording, mirroring the source-only-column
    # test: with the guard removed the copy fails on users_pkey instead, whose
    # message also contains "users" and also leaves the count at 1.
    assert "refusing to import into a non-empty target" in err
    assert _table_counts(pg_import_target)["users"] == 1


def test_email_collision_under_unicode_folding_refused(
    tmp_path: Path, pg_import_target: PostgresDatabase, capsys: pytest.CaptureFixture[str]
) -> None:
    src_path = tmp_path / "src.db"
    users = UserStore(SqliteDatabase(src_path))
    # Distinct under SQLite's ASCII-only LOWER(), but the second address's
    # first character is U+212A KELVIN SIGN, which both Python's str.lower()
    # and Postgres' lower() fold to 'k' — so the pair collides on import.
    # Written as the \u212A escape deliberately, never a raw glyph: a raw
    # glyph was silently mangled once already in this project's docs.
    user1 = users.create_user("kelvin@x.de", "password12345")
    user2 = users.create_user("\u212Aelvin@x.de", "password12345")

    rc = main(["--db", str(src_path), "import-to-postgres"])

    assert rc == 1
    err = capsys.readouterr().err
    assert str(user1.id) in err
    assert str(user2.id) in err
    assert "kelvin@x.de" in err
    assert "\u212Aelvin@x.de" in err
    assert _table_counts(pg_import_target)["users"] == 0


def test_source_only_column_refused_before_any_write(
    tmp_path: Path, pg_import_target: PostgresDatabase, capsys: pytest.CaptureFixture[str]
) -> None:
    src_path = tmp_path / "src.db"
    UserStore(SqliteDatabase(src_path)).create_user("user@example.com", "password12345")
    with sqlite3.connect(src_path) as raw:
        raw.execute("ALTER TABLE users ADD COLUMN legacy_flag INTEGER")

    rc = main(["--db", str(src_path), "import-to-postgres"])

    assert rc == 1
    err = capsys.readouterr().err
    # Pinned to the pre-write refusal's own wording, not just "users" and
    # "legacy_flag" in isolation — Postgres' own raw driver error for an
    # unknown INSERT column also happens to name both (`column
    # "legacy_flag" of relation "users" does not exist`), so a weaker
    # assertion would pass just as well on that failure mode, defeating
    # the point of this test (mutation target (d)).
    assert "refusing to import" in err
    assert "  users: legacy_flag" in err
    counts = _table_counts(pg_import_target)
    assert all(count == 0 for count in counts.values()), counts


def test_failure_mid_copy_leaves_target_empty(
    tmp_path: Path,
    pg_import_target: PostgresDatabase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    src_path = tmp_path / "src.db"
    UserStore(SqliteDatabase(src_path)).create_user("user@example.com", "password12345")

    import app.manage_import as manage_import

    real_copy_table = manage_import._copy_table

    def failing_copy_table(src_conn, dst_conn, table):
        if table == "llm_usage":
            raise RuntimeError("boom")
        return real_copy_table(src_conn, dst_conn, table)

    monkeypatch.setattr(manage_import, "_copy_table", failing_copy_table)

    rc = main(["--db", str(src_path), "import-to-postgres"])

    assert rc == 1
    counts = _table_counts(pg_import_target)
    assert all(count == 0 for count in counts.values()), counts
