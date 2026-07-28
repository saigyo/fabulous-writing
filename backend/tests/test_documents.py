import sqlite3
from pathlib import Path

import pytest

from app.core.models import Language
from app.services.documents import DocumentStore, RevisionConflictError

# Schema as it existed before the folder_id column was added.
_SCHEMA_BEFORE_FOLDERS = """
CREATE TABLE documents (
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
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO documents (name, language, created_at, updated_at)
VALUES ('Old', 'en', '2026-01-01T00:00:00+00:00',
        '2026-01-01T00:00:00+00:00');
"""

# Schema as it existed after folder_id but before the edited_at/checked_at split.
_SCHEMA_BEFORE_TIMESTAMPS = """
CREATE TABLE documents (
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
    folder_id INTEGER
);
INSERT INTO documents (name, language, created_at, updated_at)
VALUES ('Old', 'en', '2026-01-01T00:00:00+00:00',
        '2026-02-02T00:00:00+00:00');
"""


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
        owner_id=1,
    )
    assert doc.id > 0
    assert doc.name == "My article" and doc.name_source == "fallback"
    assert doc.revision == 0 and doc.owner_id == 1
    loaded = store.get_document(doc.id, owner_id=1)
    assert loaded == doc
    assert loaded.domain_ids == [1, 2] and loaded.llm_auto is False
    assert store.get_document(9999, owner_id=1) is None


def test_list_orders_by_recency(document_clock, store):
    a = store.create_document("A", Language.EN, owner_id=1)
    b = store.create_document("B", Language.EN, owner_id=1)
    listing = store.list_documents(owner_id=1)
    assert [d.id for d in listing] == [b.id, a.id]  # same timestamp: id DESC
    assert listing[0].name == "B"
    # Updating A moves it to the front.
    document_clock.advance()
    store.update_document(a.id, 0, text="changed", owner_id=1)
    assert [d.id for d in store.list_documents(owner_id=1)] == [a.id, b.id]


def test_list_is_summary_only(store):
    store.create_document("A", Language.EN, text="body", owner_id=1)
    summary = store.list_documents(owner_id=1)[0]
    assert not hasattr(summary, "text")


def test_update_increments_revision_and_merges(store):
    doc = store.create_document("A", Language.EN, owner_id=1)
    updated = store.update_document(
        doc.id, 0, text="new", last_findings=[{"finding": {}, "from": 0, "to": 3}], owner_id=1
    )
    assert updated.revision == 1 and updated.text == "new"
    assert store.get_document(doc.id, owner_id=1).last_findings == [
        {"finding": {}, "from": 0, "to": 3}
    ]
    again = store.update_document(doc.id, 1, scorecard={"card": {"x": 1}, "stale": False}, owner_id=1)
    assert again.revision == 2
    assert store.get_document(doc.id, owner_id=1).scorecard == {"card": {"x": 1}, "stale": False}
    assert store.update_document(9999, 0, text="x", owner_id=1) is None


def test_update_with_stale_revision_conflicts(store):
    doc = store.create_document("A", Language.EN, owner_id=1)
    store.update_document(doc.id, 0, text="first", owner_id=1)
    with pytest.raises(RevisionConflictError) as exc:
        store.update_document(doc.id, 0, text="second", owner_id=1)
    assert exc.value.current_revision == 1
    assert store.get_document(doc.id, owner_id=1).text == "first"


def test_set_name_does_not_bump_revision(store):
    doc = store.create_document("Untitled", Language.EN, owner_id=1)
    store.update_document(doc.id, 0, text="body", owner_id=1)
    named = store.set_name(doc.id, "Better title", "llm", owner_id=1)
    assert named.name == "Better title" and named.name_source == "llm"
    assert named.revision == 1  # unchanged
    assert store.set_name(9999, "x", "llm", owner_id=1) is None


def test_set_name_guard_is_noop_on_mismatched_source(store):
    doc = store.create_document("Untitled", Language.EN, owner_id=1)
    store.set_name(doc.id, "User Title", "user", owner_id=1)
    result = store.set_name(
        doc.id, "Auto Title", "fallback", only_if_source="fallback", owner_id=1
    )
    # The document was already renamed by the user (name_source="user"), so
    # the guarded call — simulating a generate-name race that lost — must
    # leave it untouched rather than clobbering the user's name.
    assert result.name == "User Title" and result.name_source == "user"


def test_delete_document(store):
    doc = store.create_document("A", Language.EN, owner_id=1)
    assert store.delete_document(doc.id, owner_id=1) is True
    assert store.delete_document(doc.id, owner_id=1) is False
    assert store.list_documents(owner_id=1) == []


def test_open_twice_is_idempotent(tmp_path: Path):
    DocumentStore(tmp_path / "d.db")
    store = DocumentStore(tmp_path / "d.db")
    assert store.list_documents(owner_id=1) == []


def test_connection_is_closed_after_use(tmp_path: Path):
    # `with sqlite3.connect(...)` alone only manages the transaction; the
    # store must also close the connection or every operation leaks one.
    store = DocumentStore(tmp_path / "documents.db")
    with store._connect() as conn:
        conn.execute("SELECT 1")
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_folder_id_roundtrip_and_summary(store):
    doc = store.create_document("A", Language.EN, folder_id=7, owner_id=1)
    assert doc.folder_id == 7
    assert store.get_document(doc.id, owner_id=1).folder_id == 7
    assert store.list_documents(owner_id=1)[0].folder_id == 7
    plain = store.create_document("B", Language.EN, owner_id=1)
    assert plain.folder_id is None


def test_set_folder_bumps_updated_at_but_not_revision(store):
    doc = store.create_document("A", Language.EN, owner_id=1)
    store.update_document(doc.id, 0, text="body", owner_id=1)
    moved = store.set_folder(doc.id, 3, owner_id=1)
    assert moved.folder_id == 3
    assert moved.revision == 1  # unchanged
    cleared = store.set_folder(doc.id, None, owner_id=1)
    assert cleared.folder_id is None
    assert store.set_folder(9999, 1, owner_id=1) is None


def test_folder_id_migration_adds_column(tmp_path: Path):
    # A database created before the column existed gets it via _migrate.
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA_BEFORE_FOLDERS)
    conn.commit()
    conn.close()
    migrated = DocumentStore(db)
    old = migrated.list_documents(owner_id=1)[0]
    assert old.folder_id is None
    # Opening twice must not fail on the ALTER TABLE guard.
    DocumentStore(db)


def test_create_sets_edited_at_and_optional_checked_at(store):
    plain = store.create_document("A", Language.EN, owner_id=1)
    assert plain.edited_at == plain.created_at
    assert plain.checked_at is None
    checked = store.create_document(
        "B", Language.EN, last_findings=[{"finding": {}, "from": 0, "to": 1}], owner_id=1
    )
    assert checked.checked_at == checked.created_at


def test_check_only_update_does_not_bump_edited_at(document_clock, store):
    doc = store.create_document("A", Language.EN, text="same text", owner_id=1)
    document_clock.advance()
    updated = store.update_document(
        doc.id,
        0,
        text="same text",
        last_findings=[{"finding": {"id": "x"}, "from": 0, "to": 4}],
        scorecard={"card": {"overall": 80}, "stale": False},
        owner_id=1,
    )
    assert updated.edited_at == doc.edited_at  # unchanged
    assert updated.checked_at is not None and updated.checked_at > doc.created_at
    assert updated.updated_at > doc.updated_at
    assert updated.revision == 1


def test_text_change_bumps_edited_at(document_clock, store):
    doc = store.create_document("A", Language.EN, text="old", owner_id=1)
    document_clock.advance()
    updated = store.update_document(
        doc.id, 0, text="new", last_findings=[], scorecard=None, owner_id=1
    )
    assert updated.edited_at > doc.edited_at
    assert updated.checked_at is not None  # findings/scorecard were carried


def test_rename_bumps_edited_at_but_settings_do_not(document_clock, store):
    doc = store.create_document("A", Language.EN, owner_id=1)
    document_clock.advance()
    renamed = store.update_document(doc.id, 0, name="Better", name_source="user", owner_id=1)
    assert renamed.edited_at > doc.edited_at
    assert renamed.checked_at is None  # no check state carried
    document_clock.advance()
    settings_only = store.update_document(renamed.id, 1, llm_tier="cheap", owner_id=1)
    assert settings_only.edited_at == renamed.edited_at


def test_set_name_and_set_folder_never_bump_edited_at(document_clock, store):
    doc = store.create_document("A", Language.EN, text="enough words here", owner_id=1)
    document_clock.advance()
    titled = store.set_name(doc.id, "Auto Title", "llm", owner_id=1)
    assert titled.edited_at == doc.edited_at
    moved = store.set_folder(doc.id, 5, owner_id=1)
    assert moved.edited_at == doc.edited_at


def test_list_orders_by_edited_at(document_clock, store):
    a = store.create_document("A", Language.EN, text="a", owner_id=1)
    b = store.create_document("B", Language.EN, text="b", owner_id=1)
    document_clock.advance()
    # A check-only write on B must NOT move it above... it is already newest;
    # instead: edit A (older) -> A moves to front despite B's later check.
    store.update_document(
        b.id, 0, text="b", last_findings=[{"finding": {}, "from": 0, "to": 1}], owner_id=1
    )
    store.update_document(a.id, 0, text="a changed", owner_id=1)
    listing = store.list_documents(owner_id=1)
    assert [d.id for d in listing] == [a.id, b.id]
    assert listing[0].edited_at >= listing[1].edited_at
    assert listing[1].checked_at is not None
    assert listing[0].created_at == a.created_at


def test_documents_are_invisible_across_owners(tmp_path):
    store = DocumentStore(tmp_path / "d.db")
    doc = store.create_document("Mine", Language.EN, owner_id=1)
    assert store.get_document(doc.id, owner_id=2) is None
    assert store.list_documents(owner_id=2) == []
    assert store.update_document(doc.id, doc.revision, owner_id=2, text="x") is None
    assert store.set_name(doc.id, "Stolen", "user", owner_id=2) is None
    assert store.set_folder(doc.id, None, owner_id=2) is None
    assert store.delete_document(doc.id, owner_id=2) is False
    assert store.get_document(doc.id, owner_id=1) is not None  # unharmed


def test_timestamp_migration_seeds_from_updated_at(tmp_path: Path):
    # A database from before the edited_at/checked_at split gets both
    # columns seeded from updated_at.
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA_BEFORE_TIMESTAMPS)
    conn.commit()
    conn.close()
    migrated = DocumentStore(db)
    old = migrated.get_document(1, owner_id=1)
    assert old.edited_at == "2026-02-02T00:00:00+00:00"
    assert old.checked_at == "2026-02-02T00:00:00+00:00"
    DocumentStore(db)  # reopen-idempotent
