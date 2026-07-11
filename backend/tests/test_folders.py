import sqlite3
from pathlib import Path

import pytest

from app.core.models import Language
from app.services.documents import DocumentStore
from app.services.folders import FolderStore


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
