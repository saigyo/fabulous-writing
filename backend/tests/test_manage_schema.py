"""database.manage_schema=False: stores verify instead of DDL (B36 spec R2/R3)."""

from pathlib import Path

import pytest

from app.core.config import Settings
from app.main import create_app
from app.services.db.sqlite import SqliteDatabase
from app.services.documents import DocumentStore


def _settings(tmp_path: Path, manage_schema: bool) -> Settings:
    return Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        database={"backend": "sqlite", "manage_schema": manage_schema},
    )


def test_manage_schema_parses_and_defaults_true(tmp_path: Path) -> None:
    assert _settings(tmp_path, True).database.manage_schema is True
    assert Settings(db_path=tmp_path / "d.db").database.manage_schema is True


def test_empty_database_fails_verification_instead_of_creating(tmp_path: Path) -> None:
    # If the constructor ran DDL despite manage_schema=False, verification
    # would pass and this test would fail — one test pins both skip + check.
    db = SqliteDatabase(tmp_path / "empty.db")
    with pytest.raises(RuntimeError, match="init-db"):
        DocumentStore(db, manage_schema=False)


def test_initialized_database_passes_verification(tmp_path: Path) -> None:
    path = tmp_path / "ok.db"
    DocumentStore(SqliteDatabase(path))  # default: creates the schema
    DocumentStore(SqliteDatabase(path), manage_schema=False)  # verifies


def test_verification_names_missing_column_and_remedy(tmp_path: Path) -> None:
    path = tmp_path / "stale.db"
    DocumentStore(SqliteDatabase(path))
    db = SqliteDatabase(path)
    with db.connect() as conn:
        conn.execute("ALTER TABLE documents DROP COLUMN checked_at")
    with pytest.raises(RuntimeError) as exc:
        DocumentStore(db, manage_schema=False)
    assert "checked_at" in str(exc.value)
    assert "init-db" in str(exc.value)
    assert "FW_DATABASE_URL" in str(exc.value)


def test_create_app_honors_manage_schema_false(tmp_path: Path) -> None:
    # Pins the main.py plumbing: the flag must reach the stores.
    with pytest.raises(RuntimeError, match="init-db"):
        create_app(_settings(tmp_path, False))


# One table per store: dropping it must surface through create_app with
# manage_schema=False, which distinguishes every main.py plumbing site —
# a missing manage_schema= kwarg on any single store ships green otherwise
# (the guard-rules-need-a-directory-sweep failure shape). Whole tables,
# not columns: several migrated columns sit under partial indexes, and
# SQLite refuses to DROP an indexed column.
_STORE_TABLES = ["users", "folders", "documents", "domains", "profiles", "llm_usage"]


@pytest.mark.parametrize("table", _STORE_TABLES)
def test_each_store_construction_site_passes_the_flag(tmp_path: Path, table: str) -> None:
    settings = _settings(tmp_path, True)
    create_app(settings)  # creates the full schema (and seeds)
    db = SqliteDatabase(settings.db_path)
    with db.connect() as conn:
        conn.execute(f"DROP TABLE {table}")
    with pytest.raises(RuntimeError, match=f"table '{table}' is missing"):
        create_app(_settings(tmp_path, False))
