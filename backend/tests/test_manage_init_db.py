"""init-db: explicit schema creation/migration under an admin DSN (B36 R4)."""

import sqlite3
from pathlib import Path

import pytest

from app.manage import main


def _config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, manage_schema: bool) -> Path:
    db_path = tmp_path / "app.db"
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        f"db_path: {db_path}\n"
        f"rules_dir: {tmp_path / 'rules'}\n"
        "database:\n"
        "  backend: sqlite\n"
        f"  manage_schema: {str(manage_schema).lower()}\n"
    )
    monkeypatch.setenv("FW_CONFIG_FILE", str(cfg))
    return db_path


def _tables(db_path: Path) -> set[str]:
    # closing(): sqlite3's context manager scopes the TRANSACTION only —
    # without it every call leaks a connection into the zero-warnings gate
    # (same trap documented at tests/test_documents.py:159).
    from contextlib import closing

    with closing(sqlite3.connect(db_path)) as conn:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        return {r[0] for r in rows}


def test_init_db_creates_schema(tmp_path, monkeypatch) -> None:
    db_path = _config(tmp_path, monkeypatch, manage_schema=True)
    assert main(["init-db"]) == 0
    assert {"users", "documents", "folders", "domains", "terms",
            "profiles", "llm_usage"} <= _tables(db_path)


def test_init_db_is_idempotent(tmp_path, monkeypatch) -> None:
    _config(tmp_path, monkeypatch, manage_schema=True)
    assert main(["init-db"]) == 0
    assert main(["init-db"]) == 0


def test_init_db_forces_ddl_despite_manage_schema_false(tmp_path, monkeypatch) -> None:
    # init-db's whole purpose is DDL; config must not disable it (spec R4).
    db_path = _config(tmp_path, monkeypatch, manage_schema=False)
    assert main(["init-db"]) == 0
    assert "users" in _tables(db_path)


def test_manage_commands_honor_manage_schema_false(tmp_path, monkeypatch) -> None:
    # Task 1 plumbing seen end-to-end: a regular command against an empty
    # database with manage_schema=false must fail verification, not
    # silently create the schema.
    _config(tmp_path, monkeypatch, manage_schema=False)
    with pytest.raises(RuntimeError, match="init-db"):
        main(["list-users"])


def test_init_db_respects_db_override(tmp_path, monkeypatch) -> None:
    _config(tmp_path, monkeypatch, manage_schema=True)
    other = tmp_path / "other.db"
    assert main(["--db", str(other), "init-db"]) == 0
    assert "users" in _tables(other)
