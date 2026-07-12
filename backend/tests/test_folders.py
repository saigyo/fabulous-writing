import sqlite3
from pathlib import Path

import pytest

from app.core.models import Language
from app.services.documents import DocumentStore
from app.services.folders import FolderStore, FolderDefaults

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
def db(tmp_path: Path) -> Path:
    return tmp_path / "test.db"


@pytest.fixture()
def store(db: Path) -> FolderStore:
    DocumentStore(db)  # folders and documents share the DB in production
    return FolderStore(db)


def test_create_list_get(store):
    b = store.create_folder("blog")
    a = store.create_folder("Apricot")
    assert a.id != b.id and a.owner_id == 1 and a.created_at
    # Case-insensitive name ordering.
    assert [f.name for f in store.list_folders()] == ["Apricot", "blog"]
    assert store.get_folder(a.id) == a
    assert store.get_folder(9999) is None


def test_duplicate_name_raises(store):
    store.create_folder("Blog")
    with pytest.raises(ValueError, match="exists"):
        store.create_folder("Blog")


def test_rename(store):
    a = store.create_folder("A")
    store.create_folder("B")
    renamed = store.rename_folder(a.id, "C")
    assert renamed.name == "C"
    assert store.get_folder(a.id).name == "C"
    assert store.rename_folder(9999, "X") is None
    with pytest.raises(ValueError, match="exists"):
        store.rename_folder(a.id, "B")


def test_delete_moves_members_to_ungrouped(db):
    docs = DocumentStore(db)
    folders = FolderStore(db)
    folder = folders.create_folder("Project")
    inside = docs.create_document("In", Language.EN, folder_id=folder.id)
    outside = docs.create_document("Out", Language.EN)
    assert folders.delete_folder(folder.id) is True
    assert docs.get_document(inside.id).folder_id is None
    assert docs.get_document(outside.id).folder_id is None
    assert docs.get_document(inside.id) is not None  # never deleted
    assert folders.list_folders() == []
    assert folders.delete_folder(folder.id) is False


def test_open_twice_is_idempotent(db):
    FolderStore(db)
    store = FolderStore(db)
    assert store.list_folders() == []


def test_connection_is_closed_after_use(db):
    # `with sqlite3.connect(...)` alone only manages the transaction; the
    # store must also close the connection or every operation leaks one.
    store = FolderStore(db)
    with store._connect() as conn:
        conn.execute("SELECT 1")
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_defaults_migration_idempotent(db):
    # A pre-phase-3 DB has only the four original columns.
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA_BEFORE_DEFAULTS)
    conn.commit()
    conn.close()
    FolderStore(db)  # migrates
    folder = FolderStore(db).list_folders()[0]  # opening twice is safe
    assert folder.name == "Old"
    assert folder.default_language is None
    assert folder.default_profile_id is None
    assert folder.default_domain_ids is None
    assert folder.default_llm_provider is None
    assert folder.default_llm_model is None
    assert folder.default_llm_tier is None
    assert folder.default_llm_auto is None


def test_set_defaults_roundtrip(store):
    f = store.create_folder("Blog")
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
    )
    assert updated.default_language is Language.DE
    assert updated.default_profile_id == 3
    assert updated.default_domain_ids == [1, 2]
    assert updated.default_llm_provider == "ollama"
    assert updated.default_llm_model == "llama3"
    assert updated.default_llm_tier == "cheap"
    assert updated.default_llm_auto is False
    # Persisted, not just echoed back.
    assert store.get_folder(f.id) == updated


def test_set_defaults_is_full_replace(store):
    f = store.create_folder("Blog")
    store.set_defaults(
        f.id,
        FolderDefaults(default_language=Language.DE, default_llm_auto=True),
    )
    partial = store.set_defaults(f.id, FolderDefaults(default_language=Language.EN))
    assert partial.default_language is Language.EN
    assert partial.default_llm_auto is None  # replaced away, not merged


def test_set_defaults_empty_domains_distinct_from_unset(store):
    f = store.create_folder("Blog")
    with_empty = store.set_defaults(f.id, FolderDefaults(default_domain_ids=[]))
    assert with_empty.default_domain_ids == []  # a SET default: "no domains"
    cleared = store.set_defaults(f.id, FolderDefaults())
    assert cleared.default_domain_ids is None  # unset
    assert store.set_defaults(9999, FolderDefaults()) is None


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


def test_nocase_index_rejects_case_duplicate_on_create(db):
    conn = sqlite3.connect(db)
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
    store = FolderStore(db)
    with pytest.raises(ValueError, match="exists"):
        store.create_folder("blog")


def test_nocase_index_rejects_case_duplicate_on_rename(db):
    conn = sqlite3.connect(db)
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
    store = FolderStore(db)
    blog = [f for f in store.list_folders() if f.name == "Blog"][0]
    with pytest.raises(ValueError, match="exists"):
        store.rename_folder(blog.id, "NOTES")


def test_nocase_index_migration_is_idempotent(db):
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA_CURRENT_FOLDERS)
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?, ?)",
        ("Blog", "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()
    FolderStore(db)
    store = FolderStore(db)  # opening twice must not fail on IF NOT EXISTS
    assert [f.name for f in store.list_folders()] == ["Blog"]


def test_legacy_case_duplicates_skip_index_with_warning(db, caplog):
    # A hand-built DB with pre-existing case-duplicates (created before the
    # NOCASE index existed) must still open; the index is skipped rather
    # than raising on creation, and both rows remain visible.
    conn = sqlite3.connect(db)
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
        store = FolderStore(db)
    assert "case-duplicate" in caplog.text
    names = sorted(f.name for f in store.list_folders())
    assert names == ["Blog", "blog"]
    conn = sqlite3.connect(db)
    index_row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index'"
        " AND name = 'idx_folders_name_nocase'"
    ).fetchone()
    conn.close()
    assert index_row is None
