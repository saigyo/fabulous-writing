import sqlite3
import time
from pathlib import Path

import pytest

from app.core.models import Language
from app.services.documents import DocumentStore, RevisionConflictError


@pytest.fixture()
def store(tmp_path: Path) -> DocumentStore:
    return DocumentStore(tmp_path / "test.db")


def test_create_and_get_document(store):
    doc = store.create_document(
        "My article",
        Language.DE,
        text="Hallo Welt.",
        profile_id=3,
        domain_ids=[1, 2],
        llm_tier="balanced",
        llm_auto=False,
    )
    assert doc.id > 0
    assert doc.name == "My article" and doc.name_source == "fallback"
    assert doc.revision == 0 and doc.owner_id == 1
    loaded = store.get_document(doc.id)
    assert loaded == doc
    assert loaded.domain_ids == [1, 2] and loaded.llm_auto is False
    assert store.get_document(9999) is None


def test_list_orders_by_recency(store):
    a = store.create_document("A", Language.EN)
    b = store.create_document("B", Language.EN)
    listing = store.list_documents()
    assert [d.id for d in listing] == [b.id, a.id]  # same timestamp: id DESC
    assert listing[0].name == "B"
    # Updating A moves it to the front.
    time.sleep(1.1)  # updated_at has second precision
    store.update_document(a.id, 0, text="changed")
    assert [d.id for d in store.list_documents()] == [a.id, b.id]


def test_list_is_summary_only(store):
    store.create_document("A", Language.EN, text="body")
    summary = store.list_documents()[0]
    assert not hasattr(summary, "text")


def test_update_increments_revision_and_merges(store):
    doc = store.create_document("A", Language.EN)
    updated = store.update_document(
        doc.id, 0, text="new", last_findings=[{"finding": {}, "from": 0, "to": 3}]
    )
    assert updated.revision == 1 and updated.text == "new"
    assert store.get_document(doc.id).last_findings == [
        {"finding": {}, "from": 0, "to": 3}
    ]
    again = store.update_document(doc.id, 1, scorecard={"card": {"x": 1}, "stale": False})
    assert again.revision == 2
    assert store.get_document(doc.id).scorecard == {"card": {"x": 1}, "stale": False}
    assert store.update_document(9999, 0, text="x") is None


def test_update_with_stale_revision_conflicts(store):
    doc = store.create_document("A", Language.EN)
    store.update_document(doc.id, 0, text="first")
    with pytest.raises(RevisionConflictError) as exc:
        store.update_document(doc.id, 0, text="second")
    assert exc.value.current_revision == 1
    assert store.get_document(doc.id).text == "first"


def test_set_name_does_not_bump_revision(store):
    doc = store.create_document("Untitled", Language.EN)
    store.update_document(doc.id, 0, text="body")
    named = store.set_name(doc.id, "Better title", "llm")
    assert named.name == "Better title" and named.name_source == "llm"
    assert named.revision == 1  # unchanged
    assert store.set_name(9999, "x", "llm") is None


def test_set_name_guard_is_noop_on_mismatched_source(store):
    doc = store.create_document("Untitled", Language.EN)
    store.set_name(doc.id, "User Title", "user")
    result = store.set_name(
        doc.id, "Auto Title", "fallback", only_if_source="fallback"
    )
    # The document was already renamed by the user (name_source="user"), so
    # the guarded call — simulating a generate-name race that lost — must
    # leave it untouched rather than clobbering the user's name.
    assert result.name == "User Title" and result.name_source == "user"


def test_delete_document(store):
    doc = store.create_document("A", Language.EN)
    assert store.delete_document(doc.id) is True
    assert store.delete_document(doc.id) is False
    assert store.list_documents() == []


def test_open_twice_is_idempotent(tmp_path: Path):
    DocumentStore(tmp_path / "d.db")
    store = DocumentStore(tmp_path / "d.db")
    assert store.list_documents() == []


def test_connection_is_closed_after_use(tmp_path: Path):
    # `with sqlite3.connect(...)` alone only manages the transaction; the
    # store must also close the connection or every operation leaks one.
    store = DocumentStore(tmp_path / "documents.db")
    with store._connect() as conn:
        conn.execute("SELECT 1")
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_folder_id_roundtrip_and_summary(store):
    doc = store.create_document("A", Language.EN, folder_id=7)
    assert doc.folder_id == 7
    assert store.get_document(doc.id).folder_id == 7
    assert store.list_documents()[0].folder_id == 7
    plain = store.create_document("B", Language.EN)
    assert plain.folder_id is None


def test_set_folder_bumps_updated_at_but_not_revision(store):
    doc = store.create_document("A", Language.EN)
    store.update_document(doc.id, 0, text="body")
    moved = store.set_folder(doc.id, 3)
    assert moved.folder_id == 3
    assert moved.revision == 1  # unchanged
    cleared = store.set_folder(doc.id, None)
    assert cleared.folder_id is None
    assert store.set_folder(9999, 1) is None


def test_folder_id_migration_adds_column(tmp_path: Path):
    # A database created before the column existed gets it via _migrate.
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """CREATE TABLE documents (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               owner_id INTEGER NOT NULL DEFAULT 1,
               name TEXT NOT NULL,
               name_source TEXT NOT NULL DEFAULT 'fallback',
               text TEXT NOT NULL DEFAULT '',
               language TEXT NOT NULL,
               profile_id INTEGER,
               domain_ids TEXT NOT NULL DEFAULT '[]',
               llm_provider TEXT, llm_model TEXT, llm_tier TEXT,
               llm_auto INTEGER NOT NULL DEFAULT 1,
               last_findings TEXT NOT NULL DEFAULT '[]',
               scorecard TEXT,
               revision INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
           INSERT INTO documents (name, language, created_at, updated_at)
           VALUES ('Old', 'en', '2026-01-01T00:00:00+00:00',
                   '2026-01-01T00:00:00+00:00');"""
    )
    conn.commit()
    conn.close()
    migrated = DocumentStore(db)
    old = migrated.list_documents()[0]
    assert old.folder_id is None
    # Opening twice must not fail on the ALTER TABLE guard.
    DocumentStore(db)


def test_create_sets_edited_at_and_optional_checked_at(store):
    plain = store.create_document("A", Language.EN)
    assert plain.edited_at == plain.created_at
    assert plain.checked_at is None
    checked = store.create_document(
        "B", Language.EN, last_findings=[{"finding": {}, "from": 0, "to": 1}]
    )
    assert checked.checked_at == checked.created_at


def test_check_only_update_does_not_bump_edited_at(store):
    doc = store.create_document("A", Language.EN, text="same text")
    time.sleep(1.1)  # second-precision timestamps
    updated = store.update_document(
        doc.id,
        0,
        text="same text",
        last_findings=[{"finding": {"id": "x"}, "from": 0, "to": 4}],
        scorecard={"card": {"overall": 80}, "stale": False},
    )
    assert updated.edited_at == doc.edited_at  # unchanged
    assert updated.checked_at is not None and updated.checked_at > doc.created_at
    assert updated.updated_at > doc.updated_at
    assert updated.revision == 1


def test_text_change_bumps_edited_at(store):
    doc = store.create_document("A", Language.EN, text="old")
    time.sleep(1.1)
    updated = store.update_document(
        doc.id, 0, text="new", last_findings=[], scorecard=None
    )
    assert updated.edited_at > doc.edited_at
    assert updated.checked_at is not None  # findings/scorecard were carried


def test_rename_bumps_edited_at_but_settings_do_not(store):
    doc = store.create_document("A", Language.EN)
    time.sleep(1.1)
    renamed = store.update_document(doc.id, 0, name="Better", name_source="user")
    assert renamed.edited_at > doc.edited_at
    assert renamed.checked_at is None  # no check state carried
    time.sleep(1.1)
    settings_only = store.update_document(renamed.id, 1, llm_tier="cheap")
    assert settings_only.edited_at == renamed.edited_at


def test_set_name_and_set_folder_never_bump_edited_at(store):
    doc = store.create_document("A", Language.EN, text="enough words here")
    time.sleep(1.1)
    titled = store.set_name(doc.id, "Auto Title", "llm")
    assert titled.edited_at == doc.edited_at
    moved = store.set_folder(doc.id, 5)
    assert moved.edited_at == doc.edited_at


def test_list_orders_by_edited_at(store):
    a = store.create_document("A", Language.EN, text="a")
    b = store.create_document("B", Language.EN, text="b")
    time.sleep(1.1)
    # A check-only write on B must NOT move it above... it is already newest;
    # instead: edit A (older) -> A moves to front despite B's later check.
    store.update_document(
        b.id, 0, text="b", last_findings=[{"finding": {}, "from": 0, "to": 1}]
    )
    store.update_document(a.id, 0, text="a changed")
    listing = store.list_documents()
    assert [d.id for d in listing] == [a.id, b.id]
    assert listing[0].edited_at >= listing[1].edited_at
    assert listing[1].checked_at is not None
    assert listing[0].created_at == a.created_at


def test_timestamp_migration_seeds_from_updated_at(tmp_path: Path):
    # A database from before the edited_at/checked_at split gets both
    # columns seeded from updated_at.
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """CREATE TABLE documents (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               owner_id INTEGER NOT NULL DEFAULT 1,
               name TEXT NOT NULL,
               name_source TEXT NOT NULL DEFAULT 'fallback',
               text TEXT NOT NULL DEFAULT '',
               language TEXT NOT NULL,
               profile_id INTEGER,
               domain_ids TEXT NOT NULL DEFAULT '[]',
               llm_provider TEXT, llm_model TEXT, llm_tier TEXT,
               llm_auto INTEGER NOT NULL DEFAULT 1,
               last_findings TEXT NOT NULL DEFAULT '[]',
               scorecard TEXT,
               revision INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
               folder_id INTEGER);
           INSERT INTO documents (name, language, created_at, updated_at)
           VALUES ('Old', 'en', '2026-01-01T00:00:00+00:00',
                   '2026-02-02T00:00:00+00:00');"""
    )
    conn.commit()
    conn.close()
    migrated = DocumentStore(db)
    old = migrated.get_document(1)
    assert old.edited_at == "2026-02-02T00:00:00+00:00"
    assert old.checked_at == "2026-02-02T00:00:00+00:00"
    DocumentStore(db)  # reopen-idempotent
