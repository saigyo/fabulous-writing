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
