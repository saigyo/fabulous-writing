import sqlite3
from pathlib import Path

import pytest

from app.core.models import Language
from app.services.db.sqlite import SqliteDatabase, connect
from app.services.documents import DocumentStore
from app.services.folders import FolderStore, FolderDefaults, _SCHEMA

# Schema as it existed before the phase-3 per-folder defaults columns.
_SCHEMA_BEFORE_DEFAULTS = """
CREATE TABLE folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
INSERT INTO folders (name, created_at)
VALUES ('Old', '2026-01-01T00:00:00+00:00');
"""


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "test.db"


@pytest.fixture()
def store(db) -> FolderStore:
    DocumentStore(db)  # folders and documents share the DB in production
    return FolderStore(db)


def test_create_list_get(store):
    b = store.create_folder("blog", owner_id=1)
    a = store.create_folder("Apricot", owner_id=1)
    assert a.id != b.id and a.owner_id == 1 and a.created_at
    # Case-insensitive name ordering.
    assert [f.name for f in store.list_folders(owner_id=1)] == ["Apricot", "blog"]
    assert store.get_folder(a.id, owner_id=1) == a
    assert store.get_folder(9999, owner_id=1) is None


def test_duplicate_name_raises(store):
    store.create_folder("Blog", owner_id=1)
    with pytest.raises(ValueError, match="exists"):
        store.create_folder("Blog", owner_id=1)


def test_rename(store):
    a = store.create_folder("A", owner_id=1)
    store.create_folder("B", owner_id=1)
    renamed = store.rename_folder(a.id, "C", owner_id=1)
    assert renamed.name == "C"
    assert store.get_folder(a.id, owner_id=1).name == "C"
    assert store.rename_folder(9999, "X", owner_id=1) is None
    with pytest.raises(ValueError, match="exists"):
        store.rename_folder(a.id, "B", owner_id=1)


def test_delete_moves_members_to_ungrouped(db):
    docs = DocumentStore(db)
    folders = FolderStore(db)
    folder = folders.create_folder("Project", owner_id=1)
    inside = docs.create_document("In", Language.EN, folder_id=folder.id, owner_id=1)
    outside = docs.create_document("Out", Language.EN, owner_id=1)
    assert folders.delete_folder(folder.id, owner_id=1) is True
    assert docs.get_document(inside.id, owner_id=1).folder_id is None
    assert docs.get_document(outside.id, owner_id=1).folder_id is None
    assert docs.get_document(inside.id, owner_id=1) is not None  # never deleted
    assert folders.list_folders(owner_id=1) == []
    assert folders.delete_folder(folder.id, owner_id=1) is False


def test_open_twice_is_idempotent(db):
    FolderStore(db)
    store = FolderStore(db)
    assert store.list_folders(owner_id=1) == []


def test_connection_is_closed_after_use(db_path):
    # `with sqlite3.connect(...)` alone only manages the transaction; the
    # store must also close the connection or every operation leaks one.
    store = FolderStore(SqliteDatabase(db_path))  # sqlite-only: asserts sqlite3.ProgrammingError after close
    with store._connect() as conn:
        conn.execute("SELECT 1")
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_defaults_migration_idempotent(db_path):
    # A pre-phase-3 DB has only the four original columns.
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA_BEFORE_DEFAULTS)
    conn.commit()
    conn.close()
    FolderStore(SqliteDatabase(db_path))  # sqlite-only: hand-built legacy schema
    folder = FolderStore(SqliteDatabase(db_path)).list_folders(owner_id=1)[0]  # opening twice is safe
    assert folder.name == "Old"
    assert folder.default_language is None
    assert folder.default_profile_id is None
    assert folder.default_domain_ids is None
    assert folder.default_llm_provider is None
    assert folder.default_llm_model is None
    assert folder.default_llm_tier is None
    assert folder.default_llm_auto is None


def test_set_defaults_roundtrip(store):
    f = store.create_folder("Blog", owner_id=1)
    updated = store.set_defaults(
        f.id,
        FolderDefaults(
            default_language=Language.DE,
            default_profile_id=3,
            default_domain_ids=[1, 2],
            default_llm_provider="ollama",
            default_llm_model="llama3",
            default_llm_tier="cheap",
            default_llm_auto=False,
        ),
        owner_id=1,
    )
    assert updated.default_language is Language.DE
    assert updated.default_profile_id == 3
    assert updated.default_domain_ids == [1, 2]
    assert updated.default_llm_provider == "ollama"
    assert updated.default_llm_model == "llama3"
    assert updated.default_llm_tier == "cheap"
    assert updated.default_llm_auto is False
    # Persisted, not just echoed back.
    assert store.get_folder(f.id, owner_id=1) == updated


def test_set_defaults_is_full_replace(store):
    f = store.create_folder("Blog", owner_id=1)
    store.set_defaults(
        f.id,
        FolderDefaults(default_language=Language.DE, default_llm_auto=True),
        owner_id=1,
    )
    partial = store.set_defaults(f.id, FolderDefaults(default_language=Language.EN), owner_id=1)
    assert partial.default_language is Language.EN
    assert partial.default_llm_auto is None  # replaced away, not merged


def test_set_defaults_empty_domains_distinct_from_unset(store):
    f = store.create_folder("Blog", owner_id=1)
    with_empty = store.set_defaults(f.id, FolderDefaults(default_domain_ids=[]), owner_id=1)
    assert with_empty.default_domain_ids == []  # a SET default: "no domains"
    cleared = store.set_defaults(f.id, FolderDefaults(), owner_id=1)
    assert cleared.default_domain_ids is None  # unset
    assert store.set_defaults(9999, FolderDefaults(), owner_id=1) is None


# -- A7: case-insensitive name uniqueness -----------------------------------

_SCHEMA_CURRENT_FOLDERS = """
CREATE TABLE folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    default_language TEXT,
    default_profile_id INTEGER,
    default_domain_ids TEXT,
    default_llm_provider TEXT,
    default_llm_model TEXT,
    default_llm_tier TEXT,
    default_llm_auto INTEGER
);
"""


def test_lower_name_index_rejects_case_duplicate_on_create(db_path):
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA_CURRENT_FOLDERS)
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?, ?)",
        ("Blog", "2026-01-01T00:00:00+00:00"),
    )
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?, ?)",
        ("Notes", "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()
    store = FolderStore(SqliteDatabase(db_path))  # sqlite-only: hand-built legacy schema
    with pytest.raises(ValueError, match="exists"):
        store.create_folder("blog", owner_id=1)


def test_lower_name_index_rejects_case_duplicate_on_rename(db_path):
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA_CURRENT_FOLDERS)
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?, ?)",
        ("Blog", "2026-01-01T00:00:00+00:00"),
    )
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?, ?)",
        ("Notes", "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()
    store = FolderStore(SqliteDatabase(db_path))  # sqlite-only: hand-built legacy schema
    blog = [f for f in store.list_folders(owner_id=1) if f.name == "Blog"][0]
    with pytest.raises(ValueError, match="exists"):
        store.rename_folder(blog.id, "NOTES", owner_id=1)


def test_lower_name_index_migration_is_idempotent(db_path):
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA_CURRENT_FOLDERS)
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?, ?)",
        ("Blog", "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()
    FolderStore(SqliteDatabase(db_path))  # sqlite-only: hand-built legacy schema
    store = FolderStore(SqliteDatabase(db_path))  # opening twice must not fail on IF NOT EXISTS
    assert [f.name for f in store.list_folders(owner_id=1)] == ["Blog"]


def test_legacy_case_duplicates_skip_index_with_warning(db_path, caplog):
    # A hand-built DB with pre-existing case-duplicates (created before the
    # LOWER(name) index existed) must still open; the index is skipped rather
    # than raising on creation, and both rows remain visible.
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA_CURRENT_FOLDERS)
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?, ?)",
        ("Blog", "2026-01-01T00:00:00+00:00"),
    )
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?, ?)",
        ("blog", "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()
    with caplog.at_level("WARNING"):
        store = FolderStore(SqliteDatabase(db_path))  # sqlite-only: hand-built legacy schema
    assert "case-duplicate" in caplog.text
    names = sorted(f.name for f in store.list_folders(owner_id=1))
    assert names == ["Blog", "blog"]
    conn = sqlite3.connect(db_path)
    index_row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index'"
        " AND name = 'idx_folders_owner_name'"
    ).fetchone()
    conn.close()
    assert index_row is None


def test_postgres_case_duplicates_skip_index_with_warning(pg_database, caplog):
    # The Postgres sibling of test_legacy_case_duplicates_skip_index_with_
    # warning above: exercises the portable GROUP BY pre-scan's PG grammar
    # (bare-column-under-lower() GROUP BY raises GroupingError on PG unless
    # aggregated). Hand-built shape, no store constructed yet.
    with pg_database.connect() as conn:
        conn.executescript(_SCHEMA)
        conn.execute(
            "INSERT INTO folders (owner_id, name, created_at) VALUES (?, ?, ?)",
            (1, "Blog", "2026-01-01T00:00:00+00:00"),
        )
        conn.execute(
            "INSERT INTO folders (owner_id, name, created_at) VALUES (?, ?, ?)",
            (1, "blog", "2026-01-01T00:00:00+00:00"),
        )
    with caplog.at_level("WARNING"):
        store = FolderStore(pg_database)
    assert "case-duplicate" in caplog.text
    names = sorted(f.name for f in store.list_folders(owner_id=1))
    assert names == ["Blog", "blog"]
    with pg_database.connect() as conn:
        index_row = conn.execute(
            "SELECT indexname FROM pg_indexes"
            " WHERE indexname = 'idx_folders_owner_name'"
            " AND schemaname = current_schema()"
        ).fetchone()
    assert index_row is None


def test_folders_are_invisible_across_owners_and_names_are_per_owner(db):
    store = FolderStore(db)
    folder = store.create_folder("Projects", owner_id=1)
    assert store.get_folder(folder.id, owner_id=2) is None
    assert store.list_folders(owner_id=2) == []
    assert store.rename_folder(folder.id, "X", owner_id=2) is None
    assert store.delete_folder(folder.id, owner_id=2) is False
    # Per-owner uniqueness: owner 2 may reuse owner 1's name...
    store.create_folder("Projects", owner_id=2)
    # ...but not their own, case-insensitively.
    with pytest.raises(ValueError):
        store.create_folder("projects", owner_id=2)


def test_folder_rebuild_drops_inline_unique_and_default(tmp_path):
    FolderStore(SqliteDatabase(tmp_path / "f.db"))  # sqlite-only: reads sqlite_master
    with connect(tmp_path / "f.db") as conn:
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='folders'"
        ).fetchone()[0]
        assert "UNIQUE" not in sql.upper()
        assert "DEFAULT 1" not in sql
        index_names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
    assert "idx_folders_owner_name" in index_names


def test_folder_rebuild_migrates_a_legacy_table(tmp_path):
    # Build the pre-M3 shape by hand, then let FolderStore migrate it.
    legacy_db = tmp_path / "legacy.db"
    with connect(legacy_db) as conn:
        conn.execute(
            """CREATE TABLE folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER NOT NULL DEFAULT 1,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            )"""
        )
        conn.execute(
            "INSERT INTO folders (name, created_at) VALUES ('Kept', '2026-01-01T00:00:00+00:00')"
        )
    store = FolderStore(SqliteDatabase(legacy_db))  # sqlite-only: hand-built legacy schema
    kept = store.list_folders(owner_id=1)
    assert [f.name for f in kept] == ["Kept"]
    # Idempotent: a second open must not rebuild again or fail.
    FolderStore(SqliteDatabase(legacy_db))  # sqlite-only: hand-built legacy schema
    assert [f.name for f in store.list_folders(owner_id=1)] == ["Kept"]


def test_delete_folder_only_unfiles_the_owners_documents(db):
    # delete_folder's documents UPDATE must carry the owner scope too:
    # ids are per-table counters, so another owner's folder can share the
    # numeric id and their documents must not be unfiled by our delete.
    docs = DocumentStore(db)
    folders = FolderStore(db)
    mine = folders.create_folder("Mine", owner_id=1)
    doc = docs.create_document("Doc", Language.EN, owner_id=2)
    docs.set_folder(doc.id, mine.id, owner_id=2)  # same numeric id, owner 2
    folders.delete_folder(mine.id, owner_id=1)
    assert docs.get_document(doc.id, owner_id=2).folder_id == mine.id
