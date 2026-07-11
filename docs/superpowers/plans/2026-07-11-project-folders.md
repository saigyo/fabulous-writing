# Project Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapsible project folders in the document sidebar — folder CRUD, menu-based document moves, lossless folder deletion — on a `folders` table plus a nullable `folder_id` on documents.

**Architecture:** A new `FolderStore` beside `DocumentStore` (same SQLite DB, same store conventions); `documents` gains `folder_id` via the established `_migrate()` pattern and a `set_folder` method that (like `set_name`) never bumps `revision`. The flat `GET /api/documents` list keeps its shape — summaries gain `folder_id` — and the sidebar groups client-side. Folder mutations are backend-only (no buffering); `folder_id` never enters the autosave payload.

**Tech Stack:** Python 3.13 / FastAPI / sqlite3 / pydantic (backend, uv-managed, run from `backend/`); React 19 / TypeScript / zustand / vitest (frontend, run from `frontend/`).

**Spec:** `docs/superpowers/specs/2026-07-11-project-folders-design.md`

## Global Constraints

- The owner's live DB `backend/data/fabulous.db` must NEVER be touched by tests, scripts, or e2e runs. Tests use `tmp_path`; e2e uses a scratch DB and scratch ports (backend 8001, preview 4199); never kill the user's dev servers (:5173, :8000).
- Commits go directly on `main`; every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do not push (orchestrator pushes).
- Backend commands from `backend/` via `uv run …`; frontend from `frontend/` via `npm`/`npx`.
- Every user-visible string exists in ALL seven i18n catalogs: en, de, fr, es, it, ja, zh (`frontend/src/i18n/*.ts` + the `Messages` interface in `messages.ts`); the parity test enforces this.
- Folder names: trimmed, non-empty, **max 100 chars**, UNIQUE (DB constraint) → API: 422 empty/too long, 409 duplicate.
- `POST /api/documents/{id}/move` and `DocumentStore.set_folder` bump `updated_at` but NEVER bump `revision` (like `set_name`) — a move must not 409 an in-flight autosave.
- `folder_id` is NOT part of the autosave payload (`content`/`settings` of `PUT /api/documents/{id}`) and NOT in `DocumentStore._UPDATABLE`.
- Folder deletion nulls members' `folder_id` and deletes the folder row in ONE transaction; documents are never deleted.
- Folders sort by name case-insensitively (backend `COLLATE NOCASE`, frontend `localeCompare`); documents inside a folder keep the flat list's recency order.
- Frontend persistence: `docFoldersCollapsed: number[]` joins `partialize` additively — persist version stays 2, no migration change.
- The API always returns folder objects `{id, name, created_at}`, never bare strings (phase-3 defaults will add fields additively).
- Timestamps: `datetime.now(UTC).isoformat(timespec="seconds")` (existing `_utcnow`).

---

### Task 1: DocumentStore folder_id (migration + set_folder)

**Files:**
- Modify: `backend/app/services/documents.py`
- Test: extend `backend/tests/test_documents.py`

**Interfaces:**
- Consumes: existing `DocumentStore` internals (`_connect`, `_utcnow`, `_row_to_document`).
- Produces (used by Tasks 2–3):
  - `Document.folder_id: int | None = None` and `DocumentSummary.folder_id: int | None = None`
  - `create_document(..., folder_id: int | None = None)` keyword
  - `set_folder(document_id: int, folder_id: int | None) -> Document | None` — bumps `updated_at`, never `revision`; `None` if the document is missing
  - `_migrate(conn)` guarded by column name (pattern: `ProfileStore._migrate` in `backend/app/services/profiles.py:78`)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_documents.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `uv run pytest tests/test_documents.py -v -k "folder"`
Expected: FAIL — `create_document() got an unexpected keyword argument 'folder_id'` etc.

- [ ] **Step 3: Implement**

In `backend/app/services/documents.py`:

1. `_SCHEMA`: add `folder_id INTEGER,` after the `scorecard TEXT,` line (fresh DBs get it directly).
2. Models: add `folder_id: int | None = None` to `Document` (after `scorecard`) and to `DocumentSummary` (after `language`).
3. `_row_to_document`: add `folder_id=row["folder_id"],`.
4. `__init__`: after `conn.executescript(_SCHEMA)` add `self._migrate(conn)`, and add the method:

```python
    def _migrate(self, conn: sqlite3.Connection) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(documents)")}
        if "folder_id" not in columns:
            conn.execute("ALTER TABLE documents ADD COLUMN folder_id INTEGER")
```

5. `create_document`: add keyword `folder_id: int | None = None`; add `folder_id` to the INSERT column list and `folder_id,` to the VALUES tuple (keep column/value order aligned).
6. `list_documents`: SELECT becomes `"SELECT id, name, language, folder_id, updated_at FROM documents ..."` and the summary construction gains `folder_id=row["folder_id"],`.
7. New method after `set_name`:

```python
    def set_folder(
        self, document_id: int, folder_id: int | None
    ) -> Document | None:
        """Organizational move; like set_name it never bumps revision, so a
        sidebar move can never 409 an in-flight autosave. Last move wins."""
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE documents SET folder_id = ?, updated_at = ? WHERE id = ?",
                (folder_id, _utcnow(), document_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get_document(document_id)
```

Do NOT add `folder_id` to `_UPDATABLE`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_documents.py -v` then `uv run pytest -q`
Expected: all PASS, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/documents.py backend/tests/test_documents.py
git commit -m "feat: documents carry a nullable folder_id with revision-free moves"
```

---

### Task 2: FolderStore

**Files:**
- Create: `backend/app/services/folders.py`
- Test: `backend/tests/test_folders.py`

**Interfaces:**
- Consumes: Task 1's `documents.folder_id` column (delete nulls members); the store conventions of `backend/app/services/profiles.py`.
- Produces (used by Task 3):
  - `class Folder(BaseModel)`: `id: int`, `owner_id: int = 1`, `name: str`, `created_at: str`
  - `FolderStore(db_path: Path)` with:
    - `list_folders() -> list[Folder]` (ORDER BY name COLLATE NOCASE, id)
    - `get_folder(folder_id: int) -> Folder | None`
    - `create_folder(name: str) -> Folder` — raises `ValueError` on duplicate name
    - `rename_folder(folder_id: int, name: str) -> Folder | None` — `None` if missing, `ValueError` on duplicate
    - `delete_folder(folder_id: int) -> bool` — nulls members' `documents.folder_id` and deletes the row in ONE transaction

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_folders.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_folders.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.folders'`

- [ ] **Step 3: Implement**

`backend/app/services/folders.py`:

```python
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel

_SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
"""


class Folder(BaseModel):
    id: int
    owner_id: int = 1
    name: str
    created_at: str


def _utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _row_to_folder(row: sqlite3.Row) -> Folder:
    return Folder(
        id=row["id"],
        owner_id=row["owner_id"],
        name=row["name"],
        created_at=row["created_at"],
    )


class FolderStore:
    """Project folders grouping documents; name-only in this phase.

    Phase 3 (per-folder defaults) adds columns via an idempotent _migrate,
    like the profiles/documents stores.
    """

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # sqlite3's own context manager only wraps a transaction (commit or
        # rollback); this wrapper also closes the connection afterwards, so
        # `with self._connect() as conn:` cannot leak connections.
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def list_folders(self) -> list[Folder]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM folders ORDER BY name COLLATE NOCASE, id"
            ).fetchall()
        return [_row_to_folder(row) for row in rows]

    def get_folder(self, folder_id: int) -> Folder | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM folders WHERE id = ?", (folder_id,)
            ).fetchone()
        return _row_to_folder(row) if row else None

    def create_folder(self, name: str) -> Folder:
        try:
            with self._connect() as conn:
                cursor = conn.execute(
                    "INSERT INTO folders (name, created_at) VALUES (?, ?)",
                    (name, _utcnow()),
                )
                folder_id = cursor.lastrowid
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Folder '{name}' already exists") from exc
        assert folder_id is not None
        folder = self.get_folder(folder_id)
        assert folder is not None
        return folder

    def rename_folder(self, folder_id: int, name: str) -> Folder | None:
        if self.get_folder(folder_id) is None:
            return None
        try:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE folders SET name = ? WHERE id = ?",
                    (name, folder_id),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Folder '{name}' already exists") from exc
        return self.get_folder(folder_id)

    def delete_folder(self, folder_id: int) -> bool:
        """Folders never take documents with them: members drop back to the
        ungrouped list in the same transaction as the folder row's removal."""
        with self._connect() as conn:
            conn.execute(
                "UPDATE documents SET folder_id = NULL WHERE folder_id = ?",
                (folder_id,),
            )
            cursor = conn.execute(
                "DELETE FROM folders WHERE id = ?", (folder_id,)
            )
        return cursor.rowcount > 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_folders.py -v` then `uv run pytest -q`
Expected: all PASS, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/folders.py backend/tests/test_folders.py
git commit -m "feat: FolderStore with unique names and lossless delete"
```

---

### Task 3: Folders API + move endpoint + wiring

**Files:**
- Create: `backend/app/api/folders.py`
- Modify: `backend/app/api/documents.py` (create accepts `folder_id`; new move endpoint)
- Modify: `backend/app/main.py` (folder_store state + router)
- Test: `backend/tests/test_folders_api.py`, extend `backend/tests/test_documents_api.py`

**Interfaces:**
- Consumes: `FolderStore`/`Folder` (Task 2), `DocumentStore.set_folder` and `create_document(folder_id=...)` (Task 1).
- Produces (used by Tasks 4–5):
  - `GET /api/folders` → `list[Folder]`; `POST /api/folders` (201) body `{name}`; `PUT /api/folders/{id}` body `{name}`; `DELETE /api/folders/{id}` (204)
  - `POST /api/documents/{id}/move` body `{folder_id: int | null}` → `Document`
  - `POST /api/documents` accepts optional `folder_id` (422 if unknown)
  - `app.state.folder_store: FolderStore`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_folders_api.py`:

```python
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    return TestClient(create_app(settings))


def make_folder(client: TestClient, name: str = "Project") -> dict:
    response = client.post("/api/folders", json={"name": name})
    assert response.status_code == 201
    return response.json()


def test_create_and_list_sorted(client):
    make_folder(client, "beta")
    make_folder(client, "Alpha")
    names = [f["name"] for f in client.get("/api/folders").json()]
    assert names == ["Alpha", "beta"]


def test_create_validation(client):
    assert client.post("/api/folders", json={"name": "  "}).status_code == 422
    assert client.post("/api/folders", json={"name": "x" * 101}).status_code == 422
    make_folder(client, "Blog")
    assert client.post("/api/folders", json={"name": "Blog"}).status_code == 409


def test_rename(client):
    folder = make_folder(client, "Old")
    make_folder(client, "Taken")
    ok = client.put(f"/api/folders/{folder['id']}", json={"name": "New"})
    assert ok.status_code == 200 and ok.json()["name"] == "New"
    assert client.put(f"/api/folders/{folder['id']}", json={"name": "Taken"}).status_code == 409
    assert client.put(f"/api/folders/{folder['id']}", json={"name": ""}).status_code == 422
    assert client.put("/api/folders/9999", json={"name": "X"}).status_code == 404


def test_delete_keeps_documents(client):
    folder = make_folder(client)
    doc = client.post(
        "/api/documents",
        json={"name": "Doc", "language": "en", "folder_id": folder["id"]},
    ).json()
    assert doc["folder_id"] == folder["id"]
    assert client.delete(f"/api/folders/{folder['id']}").status_code == 204
    assert client.delete(f"/api/folders/{folder['id']}").status_code == 404
    survivor = client.get(f"/api/documents/{doc['id']}").json()
    assert survivor["folder_id"] is None
```

Append to `backend/tests/test_documents_api.py`:

```python
def test_create_document_with_unknown_folder_is_422(client):
    response = client.post(
        "/api/documents",
        json={"name": "Doc", "language": "en", "folder_id": 9999},
    )
    assert response.status_code == 422


def test_move_document_between_folders(client):
    folder = client.post("/api/folders", json={"name": "Target"}).json()
    doc = make_doc(client)
    moved = client.post(
        f"/api/documents/{doc['id']}/move", json={"folder_id": folder["id"]}
    )
    assert moved.status_code == 200
    assert moved.json()["folder_id"] == folder["id"]
    assert moved.json()["revision"] == doc["revision"]  # moves never bump
    assert client.get("/api/documents").json()[0]["folder_id"] == folder["id"]
    back = client.post(f"/api/documents/{doc['id']}/move", json={"folder_id": None})
    assert back.json()["folder_id"] is None
    assert client.post(
        f"/api/documents/{doc['id']}/move", json={"folder_id": 9999}
    ).status_code == 422
    assert client.post(
        "/api/documents/9999/move", json={"folder_id": None}
    ).status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_folders_api.py tests/test_documents_api.py -v`
Expected: FAIL — 404s for `/api/folders` and `/move`.

- [ ] **Step 3: Implement**

`backend/app/api/folders.py`:

```python
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from app.services.folders import Folder, FolderStore

router = APIRouter(prefix="/api", tags=["folders"])

_MAX_NAME = 100


class FolderPayload(BaseModel):
    name: str


def _store(request: Request) -> FolderStore:
    return request.app.state.folder_store


def _validated_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(422, "Folder name must not be empty")
    if len(name) > _MAX_NAME:
        raise HTTPException(422, f"Folder name must be at most {_MAX_NAME} characters")
    return name


@router.get("/folders")
def list_folders(request: Request) -> list[Folder]:
    return _store(request).list_folders()


@router.post("/folders", status_code=201)
def create_folder(request: Request, body: FolderPayload) -> Folder:
    try:
        return _store(request).create_folder(_validated_name(body.name))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.put("/folders/{folder_id}")
def rename_folder(request: Request, folder_id: int, body: FolderPayload) -> Folder:
    try:
        renamed = _store(request).rename_folder(folder_id, _validated_name(body.name))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if renamed is None:
        raise HTTPException(404, "Folder not found")
    return renamed


@router.delete("/folders/{folder_id}", status_code=204)
def delete_folder(request: Request, folder_id: int) -> Response:
    if not _store(request).delete_folder(folder_id):
        raise HTTPException(404, "Folder not found")
    return Response(status_code=204)
```

In `backend/app/api/documents.py`:

1. `DocumentCreate` gains `folder_id: int | None = None` (after `scorecard`).
2. In `create_document`, before the store call:

```python
    if body.folder_id is not None:
        if request.app.state.folder_store.get_folder(body.folder_id) is None:
            raise HTTPException(422, "Unknown folder")
```

   and pass `folder_id=body.folder_id,` to `store.create_document(...)`.
3. New endpoint after `delete_document`:

```python
class MoveRequest(BaseModel):
    folder_id: int | None


@router.post("/documents/{document_id}/move")
def move_document(
    request: Request, document_id: int, body: MoveRequest
) -> Document:
    if body.folder_id is not None:
        if request.app.state.folder_store.get_folder(body.folder_id) is None:
            raise HTTPException(422, "Unknown folder")
    moved = _store(request).set_folder(document_id, body.folder_id)
    if moved is None:
        raise HTTPException(404, "Document not found")
    return moved
```

(Place the `MoveRequest` model with the other request models at the top of the file.)

In `backend/app/main.py`, following the existing patterns exactly:

```python
from app.api.folders import router as folders_router     # with the api imports
from app.services.folders import FolderStore              # with the service imports

# in create_app(), AFTER the document_store line (documents table must exist
# before a folder delete can null members):
app.state.folder_store = FolderStore(settings.db_path)

# with the other include_router calls:
app.include_router(folders_router)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_folders_api.py tests/test_documents_api.py -v` then `uv run pytest -q`
Expected: all PASS, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/folders.py backend/app/api/documents.py backend/app/main.py backend/tests/test_folders_api.py backend/tests/test_documents_api.py
git commit -m "feat: folders CRUD API and revision-free document move endpoint"
```

---

### Task 4: Frontend client + store folder state

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/state/store.ts`
- Test: extend `frontend/src/state/store.test.ts`

**Interfaces:**
- Consumes: Task 3 endpoints; existing `request<T>` helper.
- Produces (used by Tasks 5–6):
  - `client.ts`: `interface Folder { id: number; name: string; created_at: string }`; `listFolders()`, `createFolder(name)`, `renameFolder(id, name)`, `deleteFolder(id)`, `moveDocument(id, folderId: number | null)` (POST `/api/documents/{id}/move`, returns `DocumentFull`); `DocumentSummary.folder_id: number | null`; `DocumentFull.folder_id: number | null`; `DocumentCreatePayload.folder_id?: number | null`
  - `store.ts`: `folders: Folder[]`, `setFolders(folders)`; `docFoldersCollapsed: number[]`, `toggleFolderCollapsed(id: number)`; `docFoldersCollapsed` added to `partialize` (version stays 2)

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/state/store.test.ts` (inside the existing `describe('document state', ...)` or as a sibling block, matching file style):

```typescript
describe('folder state', () => {
  it('setFolders stores and toggleFolderCollapsed round-trips', () => {
    useStore.getState().setFolders([
      { id: 1, name: 'Blog', created_at: '2026-07-11T00:00:00+00:00' },
    ])
    expect(useStore.getState().folders[0].name).toBe('Blog')
    useStore.getState().toggleFolderCollapsed(1)
    expect(useStore.getState().docFoldersCollapsed).toEqual([1])
    useStore.getState().toggleFolderCollapsed(2)
    expect(useStore.getState().docFoldersCollapsed).toEqual([1, 2])
    useStore.getState().toggleFolderCollapsed(1)
    expect(useStore.getState().docFoldersCollapsed).toEqual([2])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/state/store.test.ts`
Expected: FAIL — `setFolders` does not exist.

- [ ] **Step 3: Implement client additions**

In `frontend/src/api/client.ts`:

1. Add `folder_id: number | null` to `DocumentSummary` (after `language`) and to `DocumentFull` (after `scorecard`).
2. Add `folder_id?: number | null` to `DocumentCreatePayload`.
3. Add after the document functions:

```typescript
export interface Folder {
  id: number
  name: string
  created_at: string
}

export const listFolders = () => request<Folder[]>('/api/folders')
export const createFolder = (name: string) =>
  request<Folder>('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const renameFolder = (id: number, name: string) =>
  request<Folder>(`/api/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  })
export const deleteFolder = (id: number) =>
  request<void>(`/api/folders/${id}`, { method: 'DELETE' })
export const moveDocument = (id: number, folderId: number | null) =>
  request<DocumentFull>(`/api/documents/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ folder_id: folderId }),
  })
```

- [ ] **Step 4: Implement store additions**

In `frontend/src/state/store.ts`:

1. Import type: add `Folder` to the existing `../api/client` type import.
2. `AppState` fields (near the other document fields):

```typescript
  folders: Folder[]
  // Collapsed folder groups in the document sidebar (folder ids).
  docFoldersCollapsed: number[]

  setFolders: (folders: Folder[]) => void
  toggleFolderCollapsed: (id: number) => void
```

3. Initial values: `folders: [], docFoldersCollapsed: [],`
4. Actions (near `toggleDocSidebar`):

```typescript
      setFolders: (folders) => set({ folders }),
      toggleFolderCollapsed: (id) =>
        set((state) => ({
          docFoldersCollapsed: state.docFoldersCollapsed.includes(id)
            ? state.docFoldersCollapsed.filter((f) => f !== id)
            : [...state.docFoldersCollapsed, id],
        })),
```

5. `partialize`: add `docFoldersCollapsed: state.docFoldersCollapsed,` (additive — persist `version` stays 2, `migrate` unchanged, and the separately exported `persistConfig` test shim needs no change).

6. Fix the existing fixtures in `frontend/src/state/store.test.ts` and `frontend/src/documents/*.test.ts` that construct `DocumentSummary` objects: they now need `folder_id: null`. (TypeScript will point at every site; add the field.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run` and `npx tsc --noEmit` and `npm run lint`
Expected: all PASS (after fixing the fixtures), typecheck and lint clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/state/store.ts frontend/src/state/store.test.ts frontend/src/documents
git commit -m "feat: folder API client and store folder state with persisted collapse"
```

---

### Task 5: Folder lifecycle functions

**Files:**
- Modify: `frontend/src/documents/documents.ts`
- Test: extend `frontend/src/documents/documents.test.ts`

**Interfaces:**
- Consumes: Task 4 client functions and store fields; existing lifecycle internals (`summaryOf`, `currentSettings`, `flush`, `hydrateFromDocument`, `refreshDocuments`, `initDocuments`/`runInit`).
- Produces (used by Task 6):
  - `refreshFolders(): Promise<void>` — fetch + `setFolders`; on failure `setDocListError(true)`
  - `addFolder(name: string): Promise<void>` — trims; creates; inserts into store keeping name order; RETHROWS errors (the sidebar shows 409 inline)
  - `renameFolderById(id: number, name: string): Promise<void>` — trims; renames; updates store; rethrows
  - `removeFolder(id: number): Promise<void>` — deletes; then `refreshFolders()` + `refreshDocuments()` (members changed)
  - `moveDocumentToFolder(id: number, folderId: number | null): Promise<void>` — moves; updates the one summary in place
  - `createNewDocument(folderId?: number)` — existing function gains the optional target
- `runInit` additionally loads folders (`refreshFolders()` after the successful `listDocuments`).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/documents/documents.test.ts` (the file mocks `../api/client` via `importOriginal` — add `listFolders`, `createFolder`, `deleteFolder`, `moveDocument` to the mocked names, mirroring the existing entries; keep the `// @vitest-environment happy-dom` docblock):

```typescript
describe('folders', () => {
  it('moveDocumentToFolder updates the summary in place', async () => {
    useStore.getState().setDocuments([
      { ...summaryOf(doc(1)), folder_id: null },
      { ...summaryOf(doc(2)), folder_id: null },
    ])
    vi.mocked(moveDocument).mockResolvedValue(doc(2, { folder_id: 5 }))
    await moveDocumentToFolder(2, 5)
    const docs = useStore.getState().documents
    expect(docs.find((d) => d.id === 2)?.folder_id).toBe(5)
    expect(docs.find((d) => d.id === 1)?.folder_id).toBeNull()
    // Order untouched — moves never reorder recency.
    expect(docs.map((d) => d.id)).toEqual([1, 2])
  })

  it('removeFolder refreshes folders and documents', async () => {
    vi.mocked(deleteFolder).mockResolvedValue(undefined)
    vi.mocked(listFolders).mockResolvedValue([])
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(1))])
    await removeFolder(3)
    expect(deleteFolder).toHaveBeenCalledWith(3)
    expect(listFolders).toHaveBeenCalled()
    expect(listDocuments).toHaveBeenCalled()
  })

  it('addFolder inserts keeping name order and rethrows conflicts', async () => {
    useStore.getState().setFolders([
      { id: 1, name: 'alpha', created_at: '' },
      { id: 2, name: 'Zulu', created_at: '' },
    ])
    vi.mocked(createFolder).mockResolvedValue({ id: 3, name: 'Mango', created_at: '' })
    await addFolder('  Mango  ')
    expect(createFolder).toHaveBeenCalledWith('Mango')
    expect(useStore.getState().folders.map((f) => f.name)).toEqual([
      'alpha',
      'Mango',
      'Zulu',
    ])
    vi.mocked(createFolder).mockRejectedValue(new HttpError(409, 'dup'))
    await expect(addFolder('Mango')).rejects.toThrow('dup')
  })

  it('createNewDocument places the document in the given folder', async () => {
    useStore.getState().setDocMeta(null)
    vi.mocked(createDocument).mockResolvedValue(doc(9, { folder_id: 4 }))
    await createNewDocument(4)
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ folder_id: 4 }),
    )
    expect(useStore.getState().documents[0].folder_id).toBe(4)
  })
})
```

Note: the file's `doc(id, over)` helper builds a `DocumentFull` — it needs `folder_id: null` in its base object (Task 4 fixture fix), and `summaryOf` here refers to the test file's local summary builder; if the test file has none, build the summary literal inline `{ id, name, language, folder_id, updated_at }`. Adapt to what is actually in the file — the assertions are the contract.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/documents/documents.test.ts`
Expected: FAIL — `moveDocumentToFolder` etc. not exported.

- [ ] **Step 3: Implement**

In `frontend/src/documents/documents.ts`:

1. Extend the client import: `createFolder as apiCreateFolder, deleteFolder as apiDeleteFolder, renameFolder as apiRenameFolder, listFolders, moveDocument as apiMoveDocument, type Folder`.
2. `summaryOf` gains `folder_id: doc.folder_id,`.
3. New functions (after `refreshDocuments`):

```typescript
export async function refreshFolders(): Promise<void> {
  try {
    useStore.getState().setFolders(await listFolders())
  } catch {
    useStore.getState().setDocListError(true)
  }
}

function sortedByName(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

/** Create a folder. Errors are rethrown: the sidebar shows a 409 inline. */
export async function addFolder(name: string): Promise<void> {
  const folder = await apiCreateFolder(name.trim())
  const store = useStore.getState()
  store.setFolders(sortedByName([...store.folders, folder]))
}

export async function renameFolderById(id: number, name: string): Promise<void> {
  const renamed = await apiRenameFolder(id, name.trim())
  const store = useStore.getState()
  store.setFolders(
    sortedByName(store.folders.map((f) => (f.id === id ? renamed : f))),
  )
}

export async function removeFolder(id: number): Promise<void> {
  await apiDeleteFolder(id)
  // Members moved to ungrouped server-side; refresh both lists.
  await refreshFolders()
  await refreshDocuments()
}

export async function moveDocumentToFolder(
  id: number,
  folderId: number | null,
): Promise<void> {
  const moved = await apiMoveDocument(id, folderId)
  const store = useStore.getState()
  store.setDocuments(
    store.documents.map((d) =>
      d.id === id ? { ...d, folder_id: moved.folder_id } : d,
    ),
  )
}
```

4. `createNewDocument` gains the optional target:

```typescript
export async function createNewDocument(folderId?: number): Promise<void> {
  await flush()
  const state = useStore.getState()
  const doc = await apiCreateDocument({
    name: currentMessages().docUntitled,
    language: state.language,
    ...currentSettings(),
    ...(folderId !== undefined ? { folder_id: folderId } : {}),
  })
  useStore.getState().setDocuments([summaryOf(doc), ...state.documents])
  await hydrateFromDocument(doc)
}
```

5. In `runInit`, right after `useStore.getState().setDocListError(false)` (the successful list branch): add `await refreshFolders()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/documents/documents.test.ts` then `npx vitest run`, `npx tsc --noEmit`, `npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/documents/documents.ts frontend/src/documents/documents.test.ts
git commit -m "feat: folder lifecycle - create/rename/delete/move with in-place updates"
```

---

### Task 6: Sidebar folder groups + i18n + CSS

**Files:**
- Modify: `frontend/src/documents/DocumentSidebar.tsx`
- Modify: `frontend/src/App.css`
- Modify: `frontend/src/i18n/messages.ts` + all 7 catalogs (`en.ts de.ts fr.ts es.ts it.ts ja.ts zh.ts`)
- Test: extend `frontend/src/documents/DocumentSidebar.test.tsx`

**Interfaces:**
- Consumes: Task 5 lifecycle functions, Task 4 store fields, existing quiet-button styles (`.doc-new`, `.doc-sidebar-toggle`, `.doc-menu`).
- Produces: `groupDocuments(documents, folders)` exported pure helper; the folder UI.

- [ ] **Step 1: Write the failing helper test**

Append to `frontend/src/documents/DocumentSidebar.test.tsx`:

```typescript
import { groupDocuments } from './DocumentSidebar'

describe('groupDocuments', () => {
  const folders = [
    { id: 1, name: 'Blog', created_at: '' },
    { id: 2, name: 'Work', created_at: '' },
  ]
  const docs = [
    { id: 10, name: 'A', language: 'en', folder_id: 2, updated_at: '' },
    { id: 11, name: 'B', language: 'en', folder_id: null, updated_at: '' },
    { id: 12, name: 'C', language: 'en', folder_id: 1, updated_at: '' },
    { id: 13, name: 'D', language: 'en', folder_id: 99, updated_at: '' },
  ] as never[]

  it('groups by folder, keeps recency order, orphans go ungrouped', () => {
    const grouped = groupDocuments(docs, folders)
    expect(grouped.byFolder.get(1)?.map((d) => d.id)).toEqual([12])
    expect(grouped.byFolder.get(2)?.map((d) => d.id)).toEqual([10])
    // folder_id pointing at a vanished folder falls back to ungrouped.
    expect(grouped.ungrouped.map((d) => d.id)).toEqual([11, 13])
  })

  it('empty folders still appear (just created)', () => {
    const grouped = groupDocuments([], folders)
    expect(grouped.byFolder.get(1)).toEqual([])
    expect(grouped.byFolder.get(2)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/documents/DocumentSidebar.test.tsx`
Expected: FAIL — `groupDocuments` not exported.

- [ ] **Step 3: Add the i18n keys**

`frontend/src/i18n/messages.ts` — add to the `Messages` interface after the existing `doc*` keys:

```typescript
  folderNew: string
  folderNamePlaceholder: string
  folderRename: string
  folderDelete: string
  folderDeleteConfirm: (name: string) => string
  folderNewDocument: string
  folderMoveTo: string
  folderNone: string
  folderMenu: string
```

Catalog values (add to each locale file after its `doc*` keys, keeping the file's style):

| key | en | de |
|---|---|---|
| folderNew | `New folder` | `Neuer Ordner` |
| folderNamePlaceholder | `Folder name` | `Ordnername` |
| folderRename | `Rename` | `Umbenennen` |
| folderDelete | `Delete folder` | `Ordner löschen` |
| folderDeleteConfirm | `` (name) => `Delete folder "${name}"? Its documents will be kept and moved out of the folder.` `` | `` (name) => `Ordner "${name}" löschen? Die enthaltenen Dokumente bleiben erhalten und werden aus dem Ordner verschoben.` `` |
| folderNewDocument | `New document here` | `Neues Dokument hier` |
| folderMoveTo | `Move to folder` | `In Ordner verschieben` |
| folderNone | `No folder` | `Kein Ordner` |
| folderMenu | `Folder actions` | `Ordneraktionen` |

| key | fr | es |
|---|---|---|
| folderNew | `Nouveau dossier` | `Carpeta nueva` |
| folderNamePlaceholder | `Nom du dossier` | `Nombre de la carpeta` |
| folderRename | `Renommer` | `Renombrar` |
| folderDelete | `Supprimer le dossier` | `Eliminar carpeta` |
| folderDeleteConfirm | `` (name) => `Supprimer le dossier « ${name} » ? Ses documents seront conservés et sortis du dossier.` `` | `` (name) => `¿Eliminar la carpeta «${name}»? Sus documentos se conservarán y saldrán de la carpeta.` `` |
| folderNewDocument | `Nouveau document ici` | `Documento nuevo aquí` |
| folderMoveTo | `Déplacer vers un dossier` | `Mover a carpeta` |
| folderNone | `Aucun dossier` | `Sin carpeta` |
| folderMenu | `Actions du dossier` | `Acciones de carpeta` |

| key | it | ja | zh |
|---|---|---|---|
| folderNew | `Nuova cartella` | `新規フォルダ` | `新建文件夹` |
| folderNamePlaceholder | `Nome della cartella` | `フォルダ名` | `文件夹名称` |
| folderRename | `Rinomina` | `名前を変更` | `重命名` |
| folderDelete | `Elimina cartella` | `フォルダを削除` | `删除文件夹` |
| folderDeleteConfirm | `` (name) => `Eliminare la cartella "${name}"? I documenti saranno conservati e spostati fuori dalla cartella.` `` | `` (name) => `フォルダ「${name}」を削除しますか？中のドキュメントは保持され、フォルダの外に移動されます。` `` | `` (name) => `删除文件夹“${name}”？其中的文档将被保留并移出文件夹。` `` |
| folderNewDocument | `Nuovo documento qui` | `ここに新規ドキュメント` | `在此新建文档` |
| folderMoveTo | `Sposta in cartella` | `フォルダに移動` | `移动到文件夹` |
| folderNone | `Nessuna cartella` | `フォルダなし` | `无文件夹` |
| folderMenu | `Azioni cartella` | `フォルダ操作` | `文件夹操作` |

- [ ] **Step 4: Implement the sidebar**

Rework `frontend/src/documents/DocumentSidebar.tsx`. Keep `relativeTime`, `PanelIcon`, and the collapsed-early-return unchanged. New/changed parts:

```tsx
import { useState } from 'react'
import type { DocumentSummary, Folder } from '../api/client'
import { HttpError } from '../api/client'
import { useLocale, useMessages } from '../i18n'
import { useStore } from '../state/store'
import {
  addFolder,
  createNewDocument,
  initDocuments,
  moveDocumentToFolder,
  openDocument,
  removeDocument,
  removeFolder,
  renameDocument,
  renameFolderById,
} from './documents'

/** Group the recency-ordered flat list by folder. Documents whose folder_id
 * references a vanished folder are shown as ungrouped rather than hidden. */
// oxlint-disable-next-line react/only-export-components -- pure helper, unit-tested in isolation
export function groupDocuments(
  documents: DocumentSummary[],
  folders: Folder[],
): { byFolder: Map<number, DocumentSummary[]>; ungrouped: DocumentSummary[] } {
  const byFolder = new Map<number, DocumentSummary[]>(
    folders.map((f) => [f.id, []]),
  )
  const ungrouped: DocumentSummary[] = []
  for (const doc of documents) {
    const bucket = doc.folder_id !== null ? byFolder.get(doc.folder_id) : undefined
    if (bucket) bucket.push(doc)
    else ungrouped.push(doc)
  }
  return { byFolder, ungrouped }
}

function FolderPlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.5a2 2 0 0 1 2-2h2.6l1.4 1.6h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-7.6Z"
        stroke="currentColor"
      />
      <path d="M8 7.2v4M6 9.2h4" stroke="currentColor" />
    </svg>
  )
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={collapsed ? 'folder-chevron-icon collapsed' : 'folder-chevron-icon'}
    >
      <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
```

`DocumentSidebar` body (expanded branch) becomes:

```tsx
  const folders = useStore((s) => s.folders)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const grouped = groupDocuments(documents, folders)

  return (
    <aside className="doc-sidebar">
      <div className="doc-sidebar-head">
        <button className="doc-new" onClick={() => void createNewDocument()}>
          <span className="doc-new-icon" aria-hidden="true">
            +
          </span>
          {m.docNew}
        </button>
        <button
          className="doc-sidebar-toggle"
          title={m.folderNew}
          aria-label={m.folderNew}
          onClick={() => setCreatingFolder(true)}
        >
          <FolderPlusIcon />
        </button>
        <button
          className="doc-sidebar-toggle"
          title={m.docSidebarHide}
          aria-label={m.docSidebarHide}
          onClick={toggle}
        >
          <PanelIcon />
        </button>
      </div>
      {error && (
        <p className="doc-list-error">
          {m.docListError}{' '}
          <button onClick={() => void initDocuments()}>{m.docRetry}</button>
        </p>
      )}
      {creatingFolder && (
        <NewFolderInput onDone={() => setCreatingFolder(false)} />
      )}
      {folders.map((folder) => (
        <FolderGroup
          key={folder.id}
          folder={folder}
          documents={grouped.byFolder.get(folder.id) ?? []}
        />
      ))}
      {folders.length > 0 && grouped.ungrouped.length > 0 && (
        <hr className="doc-list-divider" />
      )}
      <ul className="doc-list">
        {grouped.ungrouped.map((doc) => (
          <DocumentItem key={doc.id} doc={doc} />
        ))}
      </ul>
    </aside>
  )
```

New components in the same file:

```tsx
function NewFolderInput({ onDone }: { onDone: () => void }) {
  const m = useMessages()
  const [conflict, setConflict] = useState(false)

  const commit = async (value: string) => {
    const name = value.trim()
    if (!name) {
      onDone()
      return
    }
    try {
      await addFolder(name)
      onDone()
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        setConflict(true) // keep the input open; the name is taken
      } else {
        useStore.getState().setDocListError(true)
        onDone()
      }
    }
  }

  return (
    <input
      className={conflict ? 'new-folder-input conflict' : 'new-folder-input'}
      placeholder={m.folderNamePlaceholder}
      autoFocus
      onChange={() => setConflict(false)}
      onBlur={(e) => void commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit(e.currentTarget.value)
        if (e.key === 'Escape') onDone()
      }}
    />
  )
}

function FolderGroup({
  folder,
  documents,
}: {
  folder: Folder
  documents: DocumentSummary[]
}) {
  const m = useMessages()
  const collapsed = useStore((s) => s.docFoldersCollapsed.includes(folder.id))
  const toggleCollapsed = useStore((s) => s.toggleFolderCollapsed)
  const holdsCurrent = useStore(
    (s) => s.docMeta !== null && documents.some((d) => d.id === s.docMeta!.id),
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const commitRename = (value: string) => {
    setRenaming(false)
    const name = value.trim()
    if (name && name !== folder.name) {
      renameFolderById(folder.id, name).catch(() => {
        useStore.getState().setDocListError(true)
      })
    }
  }

  return (
    <div className="folder-group">
      <div
        className={
          collapsed && holdsCurrent ? 'folder-head has-current' : 'folder-head'
        }
      >
        {renaming ? (
          <input
            className="doc-rename-input"
            defaultValue={folder.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(e.currentTarget.value)
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <button
            className="folder-toggle"
            onClick={() => toggleCollapsed(folder.id)}
          >
            <ChevronIcon collapsed={collapsed} />
            <span className="folder-name">{folder.name}</span>
          </button>
        )}
        <div className="doc-actions">
          <button
            className="doc-menu-button"
            aria-label={m.folderMenu}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="doc-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  void createNewDocument(folder.id)
                }}
              >
                {m.folderNewDocument}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setRenaming(true)
                }}
              >
                {m.folderRename}
              </button>
              <button
                className="doc-menu-delete"
                onClick={() => {
                  setMenuOpen(false)
                  if (window.confirm(m.folderDeleteConfirm(folder.name))) {
                    removeFolder(folder.id).catch(() => {
                      useStore.getState().setDocListError(true)
                    })
                  }
                }}
              >
                {m.folderDelete}
              </button>
            </div>
          )}
        </div>
      </div>
      {!collapsed && (
        <ul className="doc-list folder-docs">
          {documents.map((doc) => (
            <DocumentItem key={doc.id} doc={doc} />
          ))}
        </ul>
      )}
    </div>
  )
}
```

`DocumentItem` ⋯ menu gains the move section (inside the existing `doc-menu` div, between Rename and Delete; new local state `const [moving, setMoving] = useState(false)`, reset alongside `setMenuOpen`):

```tsx
            <button onClick={() => setMoving((open) => !open)}>
              {m.folderMoveTo} ▸
            </button>
            {moving && (
              <div className="doc-submenu">
                <button
                  disabled={doc.folder_id === null}
                  onClick={() => {
                    setMenuOpen(false)
                    setMoving(false)
                    void moveDocumentToFolder(doc.id, null)
                  }}
                >
                  {m.folderNone}
                </button>
                {useStore.getState().folders.map((folder) => (
                  <button
                    key={folder.id}
                    disabled={doc.folder_id === folder.id}
                    onClick={() => {
                      setMenuOpen(false)
                      setMoving(false)
                      void moveDocumentToFolder(doc.id, folder.id)
                    }}
                  >
                    {folder.name}
                  </button>
                ))}
              </div>
            )}
```

(Use `const folders = useStore((s) => s.folders)` at the top of `DocumentItem` instead of `useStore.getState()` inside JSX — reactive and lint-clean.)

- [ ] **Step 5: Add the CSS**

Append to `frontend/src/App.css` after the existing doc-sidebar block, reusing the established variables:

```css
/* Folder groups in the document sidebar */
.folder-group {
  display: flex;
  flex-direction: column;
}
.folder-head {
  display: flex;
  align-items: center;
  border-radius: 6px;
}
.folder-head:hover {
  background: var(--accent-soft);
}
.folder-head.has-current .folder-name {
  color: var(--accent);
  font-weight: 600;
}
.folder-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.4rem;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text);
  font-size: 0.85rem;
}
.folder-chevron-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
  transition: transform 0.12s ease;
}
.folder-chevron-icon:not(.collapsed) {
  transform: rotate(90deg);
}
.folder-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-docs {
  padding-left: 0.9rem;
}
.folder-head .doc-menu-button {
  visibility: hidden;
}
.folder-head:hover .doc-menu-button {
  visibility: visible;
}
.doc-list-divider {
  margin: 0.3rem 0.4rem;
  border: none;
  border-top: 1px solid var(--border);
}
.new-folder-input {
  margin: 0 0.2rem;
  padding: 0.3rem 0.45rem;
  font-size: 0.85rem;
}
.new-folder-input.conflict {
  border-color: #e5484d;
}
.doc-submenu {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
  max-height: 12rem;
  overflow-y: auto;
}
.doc-submenu button:disabled {
  color: var(--text-dim);
  cursor: default;
}
```

(If `--accent` does not exist in `src/index.css`, use the accent color the `.doc-item.current` styling derives from — check and reuse; do not invent a new hex.)

- [ ] **Step 6: Run all gates**

Run: `npx vitest run` (incl. i18n parity), `npx tsc --noEmit`, `npm run lint`, `npm run build`
Expected: all PASS, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/documents/DocumentSidebar.tsx frontend/src/documents/DocumentSidebar.test.tsx frontend/src/App.css frontend/src/i18n/
git commit -m "feat: folder groups in the document sidebar with move submenu and inline create"
```

---

### Task 7: E2E verification + docs + logbook

**Files:**
- Modify: `docs/backend-architecture.md` (folders table/store/API, move endpoint)
- Modify: `docs/frontend-architecture.md` (folder state, grouping, sidebar sections)
- Modify: `docs/LOGBOOK.md` (run `date '+%Y-%m-%d'` first — never copy dates from existing entries)
- Scratch only (never committed): e2e script + scratch DB under the session scratchpad

**Interfaces:** none produced; proves the whole branch and records it.

- [ ] **Step 1: Full-stack e2e on a scratch stack**

Constraints: never touch `backend/data/fabulous.db`; never kill the user's dev servers (:5173/:8000); kill only your own PIDs. Reuse the launcher pattern from the previous e2e (scratchpad `task8-backend.py`): backend on 127.0.0.1:8001 launched from `backend/` with `PYTHONPATH=<abs path to backend>` (plain `uv run python script.py` puts the script's dir on sys.path, not backend/), scratch `VITE_API_URL=http://127.0.0.1:8001 npm run build`, then `npx vite preview --port 4199 --strictPort`. After building, grep the dist assets for `8001` before starting preview. NOTE: vite preview binds IPv6 — drive `http://localhost:4199`, not `127.0.0.1`. Playwright via absolute import of `frontend/node_modules/playwright-core/index.mjs` with `executablePath` pointing at an installed chromium under `~/Library/Caches/ms-playwright/` (check the directory; the pinned default may be missing). Class selectors only; handle `window.confirm` via `page.on('dialog')`.

Script flow (assert each step):
1. Fresh load → one auto-created document, no folders.
2. Click the folder-plus button → `.new-folder-input` appears → type a name, Enter → `.folder-group` renders with the name.
3. Folder ⋯ menu → "New document here" (first `.doc-menu button`) → a new document appears inside `.folder-docs`, editor switches to it (empty).
4. Move: open the ungrouped document's ⋯ menu → move-to button → submenu → click the folder → document moves into the folder group; ungrouped list empties; divider disappears.
5. Collapse the folder (`.folder-toggle`) → `.folder-docs` gone; reload → still collapsed (persisted) and grouping intact.
6. Expand; delete the folder via its menu (accept the confirm) → folder gone, both documents in the ungrouped list, total document count unchanged (nothing lost — verify against `GET http://127.0.0.1:8001/api/documents`).
7. Duplicate-name check: create folder "X", then try creating another "X" → input stays open with `.conflict` class.
8. Screenshot the final expanded state; view it yourself.

Kill your scratch processes afterwards (stored PIDs).

- [ ] **Step 2: Both full suites**

From `backend/`: `uv run pytest -q` — all pass, zero warnings.
From `frontend/`: `npx vitest run && npx tsc --noEmit && npm run lint && npm run build` — all pass, zero warnings.

- [ ] **Step 3: Architecture docs**

`docs/backend-architecture.md`: extend the Documents section (or add a Folders subsection alongside it): folders table schema, FolderStore (unique names, lossless delete transaction), `/api/folders` CRUD semantics (422/409/404), the move endpoint and why it never bumps `revision` (same rationale as `set_name`), `folder_id` on create, and the phase-3 note (defaults arrive as added columns; API returns objects). Follow the file's existing style.

`docs/frontend-architecture.md`: extend the Documents section: `folders`/`docFoldersCollapsed` store state (collapse persisted, additive to persist v2), lifecycle functions, `groupDocuments` (orphaned `folder_id` → ungrouped), sidebar structure (folder groups → divider → ungrouped), and that `folder_id` never rides the autosave payload.

- [ ] **Step 4: Logbook**

Run `date '+%Y-%m-%d'`; append the feature entry under that date: summary, commit list (Tasks 1–6, from `git log --oneline`), test counts, e2e result.

- [ ] **Step 5: Commit**

```bash
git add docs/backend-architecture.md docs/frontend-architecture.md docs/LOGBOOK.md
git commit -m "docs: document project folders and log the feature"
```

---

## Self-Review Notes (already applied)

- Spec coverage: schema+store moves (T1), FolderStore+lossless delete (T2), CRUD+move+create-in-folder API (T3), client+store+persisted collapse (T4), lifecycle incl. runInit folder fetch and in-place move (T5), sidebar groups+inline create+move submenu+divider+has-current accent+i18n ×9 keys ×7 locales (T6), e2e+docs (T7). Spec's error handling: 409 inline via `NewFolderInput.conflict`, network → `setDocListError`, move-422 recovery is covered by `removeFolder`-style refresh (a failed move rejects and the document stays put — matching "a failed move leaves the document where it was"; the stale-submenu refresh happens on the next `refreshFolders`).
- Type consistency: `Folder {id, name, created_at}` (client) vs backend `Folder {id, owner_id, name, created_at}` — extra backend field is fine (clients ignore it); store/lifecycle/sidebar all use the client type. `moveDocumentToFolder(id, folderId)` naming consistent across T5/T6. `groupDocuments` return shape consistent between test (T6 Step 1) and implementation (T6 Step 4).
- Placeholder scan: none.
- Plan-level note for the executor: Task 4 Step 6 (fixture fixes) intentionally spans test files of Tasks 5–6's areas; TypeScript enumerates every site, so it cannot be missed.
