# Multi-Document Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple persistent documents in the backend DB — each with its own settings and last check results — managed through a collapsible document sidebar, with debounced autosave, a write-through localStorage buffer, and LLM auto-naming.

**Architecture:** A new `documents` SQLite table (typed settings columns + opaque JSON check-state snapshots + optimistic `revision` guard) behind a `DocumentStore` service and `/api/documents` router, mirroring the existing `ProfileStore`/profiles-router patterns. The frontend keeps its single zustand store; the header state becomes a projection of the open document, synced by one debounced autosave engine that writes localStorage synchronously and the backend eventually.

**Tech Stack:** Python 3.13 / FastAPI / sqlite3 / pydantic (backend, uv-managed, run from `backend/`); React 19 / TypeScript / zustand / CodeMirror 6 / vitest (frontend, run from `frontend/`).

**Spec:** `docs/superpowers/specs/2026-07-10-documents-design.md`

## Global Constraints

- The owner's live DB `backend/data/fabulous.db` must NEVER be touched by tests, scripts, or e2e runs. Tests use `tmp_path`; e2e uses a scratch DB and its own scratch backend port.
- Never kill or restart the user's dev servers (frontend :5173, backend :8000).
- Commits go directly on `main`; every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Backend commands run from `backend/` via `uv run …`; frontend commands from `frontend/` via `npm …`.
- Every user-visible string exists in ALL seven i18n catalogs: en, de, fr, es, it, ja, zh (`frontend/src/i18n/*.ts` + the `Messages` interface in `messages.ts`).
- Tier names are exactly `quality | balanced | cheap | local`. Auto-naming uses the **cheap** tier.
- `name_source` values are exactly `fallback | llm | user`.
- Autosave debounce: **1500 ms**. Retry backoff: 2 s doubling to a 30 s cap.
- Auto-title trigger: text reaches **≥ 20 words** while `name_source == 'fallback'`, fired at most once per session per document.
- Fallback name: first **6** whitespace-split words joined by single spaces, truncated to **40** chars (CJK text has no spaces — the 40-char cap is what limits it). Title cleaning: first line only, wrapping quotes stripped, trailing `.,;:!?…` stripped, whitespace collapsed, truncated to **80** chars; empty result = failure.
- `PUT /api/documents/{id}` requires the client's base `revision`; mismatch → **409**. `revision` increments on every successful PUT. `generate-name` and its `set_name` store method must NOT bump `revision` (a bump would 409 the client's in-flight autosaves).
- Timestamps are ISO-8601 UTC strings from `datetime.now(UTC).isoformat()`.
- The scorecard DB column stores the wrapper `{"card": <Scorecard>, "stale": <bool>}` or NULL. `last_findings` stores `[{"finding": <Finding>, "from": int, "to": int}]`.

---

### Task 1: Backend DocumentStore

**Files:**
- Create: `backend/app/services/documents.py`
- Test: `backend/tests/test_documents.py`

**Interfaces:**
- Consumes: `app.core.models.Language` (existing enum).
- Produces (used by Tasks 2–3):
  - `class Document(BaseModel)` — fields: `id: int`, `owner_id: int`, `name: str`, `name_source: str`, `text: str`, `language: Language`, `profile_id: int | None`, `domain_ids: list[int]`, `llm_provider: str | None`, `llm_model: str | None`, `llm_tier: str | None`, `llm_auto: bool`, `last_findings: list[dict[str, Any]]`, `scorecard: dict[str, Any] | None`, `revision: int`, `created_at: str`, `updated_at: str`
  - `class DocumentSummary(BaseModel)` — `id: int`, `name: str`, `language: Language`, `updated_at: str`
  - `class RevisionConflictError(Exception)` with attribute `current_revision: int`
  - `DocumentStore(db_path: Path)` with methods:
    - `create_document(name: str, language: Language, *, name_source: str = "fallback", text: str = "", profile_id: int | None = None, domain_ids: list[int] | None = None, llm_provider: str | None = None, llm_model: str | None = None, llm_tier: str | None = None, llm_auto: bool = True, last_findings: list[dict] | None = None, scorecard: dict | None = None) -> Document`
    - `list_documents() -> list[DocumentSummary]` (ORDER BY `updated_at` DESC, `id` DESC)
    - `get_document(document_id: int) -> Document | None`
    - `update_document(document_id: int, base_revision: int, **fields) -> Document | None` — None if missing, raises `RevisionConflictError` if stale
    - `set_name(document_id: int, name: str, name_source: str) -> Document | None` — no revision bump
    - `delete_document(document_id: int) -> bool`

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_documents.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `uv run pytest tests/test_documents.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.documents'`

- [ ] **Step 3: Implement the store**

`backend/app/services/documents.py` (model on `ProfileStore` — same `_connect` contextmanager, same row-mapper style):

```python
import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.core.models import Language

_SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    name_source TEXT NOT NULL DEFAULT 'fallback',
    text TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL,
    profile_id INTEGER,
    domain_ids TEXT NOT NULL DEFAULT '[]',
    llm_provider TEXT,
    llm_model TEXT,
    llm_tier TEXT,
    llm_auto INTEGER NOT NULL DEFAULT 1,
    last_findings TEXT NOT NULL DEFAULT '[]',
    scorecard TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


class Document(BaseModel):
    id: int
    owner_id: int = 1
    name: str
    name_source: str = "fallback"
    text: str = ""
    language: Language
    profile_id: int | None = None
    domain_ids: list[int] = Field(default_factory=list)
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_tier: str | None = None
    llm_auto: bool = True
    last_findings: list[dict[str, Any]] = Field(default_factory=list)
    scorecard: dict[str, Any] | None = None
    revision: int = 0
    created_at: str
    updated_at: str


class DocumentSummary(BaseModel):
    id: int
    name: str
    language: Language
    updated_at: str


class RevisionConflictError(Exception):
    """The client's base revision is stale; the document changed elsewhere."""

    def __init__(self, current_revision: int) -> None:
        super().__init__(f"stale revision; server is at {current_revision}")
        self.current_revision = current_revision


def _utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _row_to_document(row: sqlite3.Row) -> Document:
    return Document(
        id=row["id"],
        owner_id=row["owner_id"],
        name=row["name"],
        name_source=row["name_source"],
        text=row["text"],
        language=Language(row["language"]),
        profile_id=row["profile_id"],
        domain_ids=json.loads(row["domain_ids"]),
        llm_provider=row["llm_provider"],
        llm_model=row["llm_model"],
        llm_tier=row["llm_tier"],
        llm_auto=bool(row["llm_auto"]),
        last_findings=json.loads(row["last_findings"]),
        scorecard=json.loads(row["scorecard"]) if row["scorecard"] else None,
        revision=row["revision"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class DocumentStore:
    """User documents with per-document settings and check-state snapshots."""

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

    def create_document(
        self,
        name: str,
        language: Language,
        *,
        name_source: str = "fallback",
        text: str = "",
        profile_id: int | None = None,
        domain_ids: list[int] | None = None,
        llm_provider: str | None = None,
        llm_model: str | None = None,
        llm_tier: str | None = None,
        llm_auto: bool = True,
        last_findings: list[dict[str, Any]] | None = None,
        scorecard: dict[str, Any] | None = None,
    ) -> Document:
        now = _utcnow()
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO documents
                   (name, name_source, text, language, profile_id, domain_ids,
                    llm_provider, llm_model, llm_tier, llm_auto, last_findings,
                    scorecard, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    name,
                    name_source,
                    text,
                    language.value,
                    profile_id,
                    json.dumps(domain_ids or []),
                    llm_provider,
                    llm_model,
                    llm_tier,
                    int(llm_auto),
                    json.dumps(last_findings or []),
                    json.dumps(scorecard) if scorecard is not None else None,
                    now,
                    now,
                ),
            )
            document_id = cursor.lastrowid
        assert document_id is not None
        document = self.get_document(document_id)
        assert document is not None
        return document

    def list_documents(self) -> list[DocumentSummary]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, name, language, updated_at FROM documents"
                " ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [
            DocumentSummary(
                id=row["id"],
                name=row["name"],
                language=Language(row["language"]),
                updated_at=row["updated_at"],
            )
            for row in rows
        ]

    def get_document(self, document_id: int) -> Document | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        return _row_to_document(row) if row else None

    _UPDATABLE = (
        "name",
        "name_source",
        "text",
        "language",
        "profile_id",
        "domain_ids",
        "llm_provider",
        "llm_model",
        "llm_tier",
        "llm_auto",
        "last_findings",
        "scorecard",
    )

    def update_document(
        self, document_id: int, base_revision: int, **fields: object
    ) -> Document | None:
        """Optimistic update: applies only if base_revision is current.

        Returns None for a missing document; raises RevisionConflictError
        when the document moved past base_revision.
        """
        current = self.get_document(document_id)
        if current is None:
            return None
        unknown = set(fields) - set(self._UPDATABLE)
        assert not unknown, f"not updatable: {unknown}"
        merged = current.model_copy(update=fields)
        now = _utcnow()
        with self._connect() as conn:
            cursor = conn.execute(
                """UPDATE documents SET name = ?, name_source = ?, text = ?,
                   language = ?, profile_id = ?, domain_ids = ?, llm_provider = ?,
                   llm_model = ?, llm_tier = ?, llm_auto = ?, last_findings = ?,
                   scorecard = ?, revision = revision + 1, updated_at = ?
                   WHERE id = ? AND revision = ?""",
                (
                    merged.name,
                    merged.name_source,
                    merged.text,
                    merged.language.value,
                    merged.profile_id,
                    json.dumps(merged.domain_ids),
                    merged.llm_provider,
                    merged.llm_model,
                    merged.llm_tier,
                    int(merged.llm_auto),
                    json.dumps(merged.last_findings),
                    json.dumps(merged.scorecard)
                    if merged.scorecard is not None
                    else None,
                    now,
                    document_id,
                    base_revision,
                ),
            )
        if cursor.rowcount == 0:
            latest = self.get_document(document_id)
            if latest is None:
                return None
            raise RevisionConflictError(latest.revision)
        return merged.model_copy(
            update={"revision": base_revision + 1, "updated_at": now}
        )

    def set_name(
        self, document_id: int, name: str, name_source: str
    ) -> Document | None:
        """Server-side naming; deliberately no revision bump, so it can never
        409 the client's in-flight autosaves."""
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE documents SET name = ?, name_source = ?, updated_at = ?"
                " WHERE id = ?",
                (name, name_source, _utcnow(), document_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get_document(document_id)

    def delete_document(self, document_id: int) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM documents WHERE id = ?", (document_id,)
            )
        return cursor.rowcount > 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_documents.py -v`
Expected: all PASS. Then run the whole suite: `uv run pytest -q` — no regressions, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/documents.py backend/tests/test_documents.py
git commit -m "feat: add DocumentStore with revision-guarded updates"
```

---

### Task 2: Documents CRUD API + app wiring

**Files:**
- Create: `backend/app/api/documents.py`
- Modify: `backend/app/main.py` (import + `app.state.document_store` + `include_router`)
- Test: `backend/tests/test_documents_api.py`

**Interfaces:**
- Consumes: `DocumentStore`, `Document`, `DocumentSummary`, `RevisionConflictError` from Task 1.
- Produces (used by Tasks 3–6):
  - `GET /api/documents` → `list[DocumentSummary]`
  - `POST /api/documents` (201) → `Document`; body `DocumentCreate`
  - `GET /api/documents/{id}` → `Document` (404 if missing)
  - `PUT /api/documents/{id}` → `Document`; body `DocumentUpdate{revision: int, name?: str, content?: {text, findings, scorecard}, settings?: {language, profile_id, domain_ids, llm_provider, llm_model, llm_tier, llm_auto}}`; 409 on stale revision, 404 if missing
  - `DELETE /api/documents/{id}` (204; 404 if missing)
  - `app.state.document_store: DocumentStore`

The nested `content` object makes the spec's "text+findings+scorecard always together" rule structural: a client cannot send text without also sending the findings snapshot.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_documents_api.py`:

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


def make_doc(client: TestClient, name: str = "Untitled", **extra) -> dict:
    response = client.post(
        "/api/documents", json={"name": name, "language": "en", **extra}
    )
    assert response.status_code == 201
    return response.json()


def test_create_returns_full_document(client):
    doc = make_doc(client, text="Hello there world.", llm_tier="cheap")
    assert doc["name"] == "Untitled" and doc["name_source"] == "fallback"
    assert doc["text"] == "Hello there world."
    assert doc["revision"] == 0 and doc["llm_tier"] == "cheap"


def test_list_is_recency_ordered_summaries(client):
    a = make_doc(client, name="A")
    b = make_doc(client, name="B")
    listing = client.get("/api/documents").json()
    assert [d["id"] for d in listing] == [b["id"], a["id"]]
    assert "text" not in listing[0] and "last_findings" not in listing[0]


def test_get_full_document_and_404(client):
    doc = make_doc(client)
    assert client.get(f"/api/documents/{doc['id']}").json()["id"] == doc["id"]
    assert client.get("/api/documents/9999").status_code == 404


def test_put_content_and_settings(client):
    doc = make_doc(client)
    response = client.put(
        f"/api/documents/{doc['id']}",
        json={
            "revision": 0,
            "content": {
                "text": "New body.",
                "findings": [{"finding": {"id": "x"}, "from": 0, "to": 3}],
                "scorecard": {"card": {"overall": 80}, "stale": False},
            },
            "settings": {
                "language": "de",
                "profile_id": None,
                "domain_ids": [2],
                "llm_provider": None,
                "llm_model": None,
                "llm_tier": "local",
                "llm_auto": False,
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["revision"] == 1 and body["text"] == "New body."
    assert body["language"] == "de" and body["llm_tier"] == "local"
    assert body["last_findings"][0]["from"] == 0
    assert body["scorecard"]["stale"] is False


def test_put_stale_revision_409(client):
    doc = make_doc(client)
    ok = {"revision": 0, "content": {"text": "a", "findings": [], "scorecard": None}}
    assert client.put(f"/api/documents/{doc['id']}", json=ok).status_code == 200
    stale = client.put(f"/api/documents/{doc['id']}", json=ok)
    assert stale.status_code == 409
    assert client.put("/api/documents/9999", json=ok).status_code == 404


def test_rename_sets_user_source(client):
    doc = make_doc(client)
    body = client.put(
        f"/api/documents/{doc['id']}", json={"revision": 0, "name": "Mine"}
    ).json()
    assert body["name"] == "Mine" and body["name_source"] == "user"
    assert body["revision"] == 1


def test_delete(client):
    doc = make_doc(client)
    assert client.delete(f"/api/documents/{doc['id']}").status_code == 204
    assert client.delete(f"/api/documents/{doc['id']}").status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_documents_api.py -v`
Expected: FAIL — 404s everywhere (`/api/documents` not mounted yet).

- [ ] **Step 3: Implement router and wiring**

`backend/app/api/documents.py`:

```python
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.core.models import Language
from app.services.documents import (
    Document,
    DocumentStore,
    DocumentSummary,
    RevisionConflictError,
)

router = APIRouter(prefix="/api", tags=["documents"])

Tier = Literal["quality", "balanced", "cheap", "local"]


class DocumentCreate(BaseModel):
    name: str
    language: Language
    # 'llm' is server-assigned only; recovered copies are created as 'user'.
    name_source: Literal["fallback", "user"] = "fallback"
    text: str = ""
    profile_id: int | None = None
    domain_ids: list[int] = Field(default_factory=list)
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_tier: Tier | None = None
    llm_auto: bool = True
    findings: list[dict[str, Any]] = Field(default_factory=list)
    scorecard: dict[str, Any] | None = None


class DocumentContent(BaseModel):
    # Text and its check-state snapshot travel together by construction, so
    # the stored findings can never describe a different text.
    text: str
    findings: list[dict[str, Any]] = Field(default_factory=list)
    scorecard: dict[str, Any] | None = None


class DocumentSettings(BaseModel):
    language: Language
    profile_id: int | None
    domain_ids: list[int]
    llm_provider: str | None
    llm_model: str | None
    llm_tier: Tier | None
    llm_auto: bool


class DocumentUpdate(BaseModel):
    revision: int
    name: str | None = None
    content: DocumentContent | None = None
    settings: DocumentSettings | None = None


def _store(request: Request) -> DocumentStore:
    return request.app.state.document_store


@router.get("/documents")
def list_documents(request: Request) -> list[DocumentSummary]:
    return _store(request).list_documents()


@router.post("/documents", status_code=201)
def create_document(request: Request, body: DocumentCreate) -> Document:
    if not body.name.strip():
        raise HTTPException(422, "Document name must not be empty")
    return _store(request).create_document(
        body.name.strip(),
        body.language,
        name_source=body.name_source,
        text=body.text,
        profile_id=body.profile_id,
        domain_ids=body.domain_ids,
        llm_provider=body.llm_provider,
        llm_model=body.llm_model,
        llm_tier=body.llm_tier,
        llm_auto=body.llm_auto,
        last_findings=body.findings,
        scorecard=body.scorecard,
    )


@router.get("/documents/{document_id}")
def get_document(request: Request, document_id: int) -> Document:
    document = _store(request).get_document(document_id)
    if document is None:
        raise HTTPException(404, "Document not found")
    return document


@router.put("/documents/{document_id}")
def update_document(
    request: Request, document_id: int, body: DocumentUpdate
) -> Document:
    fields: dict[str, object] = {}
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(422, "Document name must not be empty")
        fields["name"] = body.name.strip()
        fields["name_source"] = "user"
    if body.content is not None:
        fields["text"] = body.content.text
        fields["last_findings"] = body.content.findings
        fields["scorecard"] = body.content.scorecard
    if body.settings is not None:
        fields["language"] = body.settings.language
        fields["profile_id"] = body.settings.profile_id
        fields["domain_ids"] = body.settings.domain_ids
        fields["llm_provider"] = body.settings.llm_provider
        fields["llm_model"] = body.settings.llm_model
        fields["llm_tier"] = body.settings.llm_tier
        fields["llm_auto"] = body.settings.llm_auto
    try:
        updated = _store(request).update_document(
            document_id, body.revision, **fields
        )
    except RevisionConflictError as exc:
        raise HTTPException(
            409, f"Stale revision; server is at {exc.current_revision}"
        ) from exc
    if updated is None:
        raise HTTPException(404, "Document not found")
    return updated


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(request: Request, document_id: int) -> Response:
    if not _store(request).delete_document(document_id):
        raise HTTPException(404, "Document not found")
    return Response(status_code=204)
```

`backend/app/main.py` — three additions, following the existing lines exactly:

```python
from app.api.documents import router as documents_router      # with the other api imports
from app.services.documents import DocumentStore               # with the other service imports

# in create_app(), next to the other stores:
app.state.document_store = DocumentStore(settings.db_path)

# with the other include_router calls:
app.include_router(documents_router)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_documents_api.py tests/test_documents.py -v` then `uv run pytest -q`
Expected: all PASS, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/documents.py backend/app/main.py backend/tests/test_documents_api.py
git commit -m "feat: add /api/documents CRUD with revision-guarded autosave endpoint"
```

---

### Task 3: LLM auto-naming (title prompt + generate-name endpoint)

**Files:**
- Create: `backend/app/services/naming.py`
- Modify: `backend/app/checkers/llm/prompts.py` (add `build_title_prompt`)
- Modify: `backend/app/api/documents.py` (add `generate-name` endpoint)
- Test: `backend/tests/test_naming.py`, extend `backend/tests/test_documents_api.py`

**Interfaces:**
- Consumes: `_LANGUAGE_NAMES` (existing dict in `prompts.py`), `settings.routing.languages` (dict `lang -> tier -> RoutingEntry(provider, model)`), `request.app.state.provider_factory(name, model) -> LLMProvider`, `DocumentStore.set_name` from Task 1.
- Produces (used by Task 5's frontend trigger):
  - `POST /api/documents/{id}/generate-name` → `Document` (404 if missing; no-op returning the document unchanged when `name_source != 'fallback'`)
  - `app.services.naming.clean_title(raw: str) -> str | None`
  - `app.services.naming.fallback_name(text: str) -> str | None`
  - `app.checkers.llm.prompts.build_title_prompt(text: str, language: Language) -> tuple[str, str]`

- [ ] **Step 1: Write the failing unit tests**

`backend/tests/test_naming.py`:

```python
from app.checkers.llm.prompts import build_title_prompt
from app.core.models import Language
from app.services.naming import clean_title, fallback_name


class TestCleanTitle:
    def test_strips_quotes_trailing_punctuation_and_whitespace(self):
        assert clean_title('  "Great Title."  ') == "Great Title"
        assert clean_title("«Titre génial !»") == "Titre génial"
        assert clean_title("„Guter Titel“…") == "Guter Titel"

    def test_takes_first_line_and_collapses_whitespace(self):
        assert clean_title("A  Good\nTitle explanation below") == "A Good"

    def test_caps_at_80_chars(self):
        assert len(clean_title("x" * 200)) == 80

    def test_empty_is_none(self):
        assert clean_title("") is None
        assert clean_title('"."') is None


class TestFallbackName:
    def test_first_six_words(self):
        assert (
            fallback_name("The quick brown fox jumps over the lazy dog")
            == "The quick brown fox jumps over"
        )

    def test_collapses_whitespace(self):
        assert fallback_name("# Hello\n\n  world  ") == "# Hello world"

    def test_caps_at_40_chars_for_cjk(self):
        assert len(fallback_name("あ" * 100)) == 40

    def test_empty_is_none(self):
        assert fallback_name("   ") is None


class TestTitlePrompt:
    def test_prompt_names_language_and_carries_text(self):
        system, user = build_title_prompt("My document body.", Language.DE)
        assert "German" in system or "Deutsch" in system
        assert "8 words" in system
        assert "My document body." in user

    def test_user_text_is_truncated(self):
        _, user = build_title_prompt("y" * 5000, Language.EN)
        assert len(user) < 1200
```

Extend `backend/tests/test_documents_api.py` (append; `FakeProvider` comes from `app.checkers.llm.provider` and returns its canned response; give the app a stub factory exactly like `tests/test_suggestions_api.py` does):

```python
from app.checkers.llm.provider import FakeProvider


def with_provider(client: TestClient, response: str | None) -> None:
    """Route every provider request to a fake; None simulates provider failure."""
    if response is None:
        def failing(name=None, model=None):
            raise RuntimeError("provider unavailable")
        client.app.state.provider_factory = failing
    else:
        client.app.state.provider_factory = (
            lambda name=None, model=None: FakeProvider(response=response)
        )


def test_generate_name_titles_fallback_document(client):
    doc = make_doc(client, text="A long enough body about widget assembly.")
    with_provider(client, '"Widget Assembly Guide."')
    body = client.post(f"/api/documents/{doc['id']}/generate-name").json()
    assert body["name"] == "Widget Assembly Guide"
    assert body["name_source"] == "llm"
    assert body["revision"] == doc["revision"]  # naming never bumps revision


def test_generate_name_failure_falls_back_to_first_words(client):
    doc = make_doc(client, text="alpha beta gamma delta epsilon zeta eta")
    with_provider(client, None)
    body = client.post(f"/api/documents/{doc['id']}/generate-name").json()
    assert body["name"] == "alpha beta gamma delta epsilon zeta"
    assert body["name_source"] == "fallback"


def test_generate_name_noop_when_named(client):
    doc = make_doc(client, text="some body text here")
    client.put(f"/api/documents/{doc['id']}", json={"revision": 0, "name": "Mine"})
    with_provider(client, "Ignored Title")
    body = client.post(f"/api/documents/{doc['id']}/generate-name").json()
    assert body["name"] == "Mine" and body["name_source"] == "user"


def test_generate_name_empty_text_keeps_name(client):
    doc = make_doc(client, name="Untitled", text="")
    with_provider(client, "Ignored")
    body = client.post(f"/api/documents/{doc['id']}/generate-name").json()
    assert body["name"] == "Untitled" and body["name_source"] == "fallback"
    assert client.post("/api/documents/9999/generate-name").status_code == 404
```

Note the empty-text case: the endpoint must not call the LLM at all for empty text (nothing to title), so the canned "Ignored" response proves the short-circuit.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_naming.py tests/test_documents_api.py -v`
Expected: FAIL — `ImportError` for `app.services.naming` / `build_title_prompt`, 404 for the endpoint.

- [ ] **Step 3: Implement**

`backend/app/services/naming.py`:

```python
"""Document title helpers: LLM-title cleaning and first-words fallback."""

_QUOTES = "\"'«»„“”‘’‹›「」『』"
_TRAILING = ".,;:!?…。、"


def clean_title(raw: str) -> str | None:
    """Normalize an LLM title reply; None when nothing usable remains."""
    line = raw.strip().splitlines()[0] if raw.strip() else ""
    line = " ".join(line.split())
    line = line.strip(_QUOTES).strip()
    line = line.rstrip(_TRAILING).strip()
    return line[:80] or None


def fallback_name(text: str) -> str | None:
    """First six words, capped at 40 chars (the cap limits spaceless CJK)."""
    words = text.split()
    if not words:
        return None
    return " ".join(words[:6])[:40].strip() or None
```

In `backend/app/checkers/llm/prompts.py` add (reusing the module's existing `_LANGUAGE_NAMES` dict):

```python
_TITLE_SYSTEM_TEMPLATE = (
    "You create document titles. Reply with the title only - no quotes, no "
    "trailing punctuation, no explanation. The title must be at most 8 words "
    "and written in {language}."
)


def build_title_prompt(text: str, language: Language) -> tuple[str, str]:
    system = _TITLE_SYSTEM_TEMPLATE.format(language=_LANGUAGE_NAMES[language])
    user = f"Create a title for this document:\n\n{text[:1000]}"
    return system, user
```

In `backend/app/api/documents.py` add the endpoint (imports: `build_title_prompt` from `app.checkers.llm.prompts`, `clean_title, fallback_name` from `app.services.naming`):

```python
@router.post("/documents/{document_id}/generate-name")
async def generate_name(request: Request, document_id: int) -> Document:
    store = _store(request)
    document = store.get_document(document_id)
    if document is None:
        raise HTTPException(404, "Document not found")
    if document.name_source != "fallback":
        return document  # titled or user-named: never auto-touched again

    title: str | None = None
    entry = (
        request.app.state.settings.routing.languages.get(
            document.language.value, {}
        ).get("cheap")
    )
    if entry is not None and document.text.strip():
        try:
            provider = request.app.state.provider_factory(
                entry.provider, entry.model
            )
            system, user = build_title_prompt(document.text, document.language)
            title = clean_title(await provider.generate(system, user))
        except Exception:
            title = None  # silent per spec; the fallback below still applies

    if title:
        named = store.set_name(document_id, title, "llm")
    else:
        fallback = fallback_name(document.text)
        if fallback is None:
            return document  # empty text: keep the localized Untitled
        named = store.set_name(document_id, fallback, "fallback")
    assert named is not None
    return named
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_naming.py tests/test_documents_api.py -v` then `uv run pytest -q`
Expected: all PASS, no new warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/naming.py backend/app/checkers/llm/prompts.py backend/app/api/documents.py backend/tests/test_naming.py backend/tests/test_documents_api.py
git commit -m "feat: LLM document auto-naming via cheap tier with first-words fallback"
```

---

### Task 4: Frontend API client + store extensions

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/state/store.ts`
- Test: extend `frontend/src/state/store.test.ts` (follow its existing conventions)

**Interfaces:**
- Consumes: backend endpoints from Tasks 2–3; existing `request<T>` helper, `Finding`, `Scorecard`, `Tier`, `Language` types.
- Produces (used by Tasks 5–7):
  - `client.ts`: `class HttpError extends Error { status: number }` (thrown by `request` on non-ok responses); types `DocumentSummary`, `SavedFinding`, `ScorecardSnapshot`, `DocumentFull`, `DocumentCreatePayload`, `DocumentContentPayload`, `DocumentSettingsPayload`, `DocumentUpdatePayload`; functions `listDocuments()`, `getDocument(id)`, `createDocument(payload)`, `updateDocument(id, payload)`, `deleteDocument(id)`, `generateDocumentName(id)`
  - `store.ts`: state `documents: DocumentSummary[]`, `docMeta: DocMeta | null`, `currentDocId: number | null` (persisted), `docSidebarCollapsed: boolean` (persisted), `docListError: boolean`; type `DocMeta = { id: number; name: string; nameSource: 'fallback' | 'llm' | 'user'; revision: number }`; actions `setDocuments`, `setDocMeta` (also mirrors `currentDocId`), `patchDocMeta`, `touchDocument(id, name?)`, `toggleDocSidebar`, `setDocListError`
  - persist version bumped to **2**; `partialize` drops `language, domainIds, provider, model, tier, llmAuto` (now per-document) and adds `currentDocId, docSidebarCollapsed`

- [ ] **Step 1: Write the failing store tests**

Append to `frontend/src/state/store.test.ts` (adapt setup lines to the file's existing style — it already resets the store between tests):

```typescript
describe('document state', () => {
  it('setDocMeta mirrors currentDocId and patchDocMeta merges', () => {
    useStore.getState().setDocMeta({ id: 7, name: 'A', nameSource: 'fallback', revision: 0 })
    expect(useStore.getState().currentDocId).toBe(7)
    useStore.getState().patchDocMeta({ revision: 3 })
    expect(useStore.getState().docMeta).toEqual({ id: 7, name: 'A', nameSource: 'fallback', revision: 3 })
    useStore.getState().setDocMeta(null)
    expect(useStore.getState().currentDocId).toBeNull()
  })

  it('touchDocument moves the entry to the front and renames it', () => {
    useStore.getState().setDocuments([
      { id: 1, name: 'One', language: 'en', updated_at: '2026-07-10T00:00:00+00:00' },
      { id: 2, name: 'Two', language: 'en', updated_at: '2026-07-10T00:00:00+00:00' },
    ])
    useStore.getState().touchDocument(2, 'Renamed')
    const docs = useStore.getState().documents
    expect(docs.map((d) => d.id)).toEqual([2, 1])
    expect(docs[0].name).toBe('Renamed')
    // Unknown ids are a no-op.
    useStore.getState().touchDocument(99)
    expect(useStore.getState().documents.map((d) => d.id)).toEqual([2, 1])
  })

  it('persist v1 -> v2 migration keeps old blobs loadable', () => {
    // The migrate function must accept a v1 blob (which still contains the
    // now-transient settings keys) without throwing.
    const persistOptions = (useStore as any).persist.getOptions()
    const migrated = persistOptions.migrate(
      { language: 'de', provider: 'ollama', uiLocale: 'de', rulesCollapsed: [] },
      1,
    )
    expect(migrated.uiLocale).toBe('de')
    expect(persistOptions.version).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/state/store.test.ts`
Expected: FAIL — `setDocMeta` etc. do not exist.

- [ ] **Step 3: Implement client additions**

In `frontend/src/api/client.ts`, replace the `request` error branch with a typed error and add the document API (import `Scorecard`, `Tier` from `../types` — both already exported there):

```typescript
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
```

```typescript
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `${init?.method ?? 'GET'} ${path} failed: ${response.status}`,
    )
  }
```

```typescript
export interface DocumentSummary {
  id: number
  name: string
  language: Language
  updated_at: string
}

export interface SavedFinding {
  finding: Finding
  from: number
  to: number
}

export interface ScorecardSnapshot {
  card: Scorecard
  stale: boolean
}

export type NameSource = 'fallback' | 'llm' | 'user'

export interface DocumentFull {
  id: number
  owner_id: number
  name: string
  name_source: NameSource
  text: string
  language: Language
  profile_id: number | null
  domain_ids: number[]
  llm_provider: string | null
  llm_model: string | null
  llm_tier: Tier | null
  llm_auto: boolean
  last_findings: SavedFinding[]
  scorecard: ScorecardSnapshot | null
  revision: number
  created_at: string
  updated_at: string
}

export interface DocumentSettingsPayload {
  language: Language
  profile_id: number | null
  domain_ids: number[]
  llm_provider: string | null
  llm_model: string | null
  llm_tier: Tier | null
  llm_auto: boolean
}

export interface DocumentContentPayload {
  text: string
  findings: SavedFinding[]
  scorecard: ScorecardSnapshot | null
}

export interface DocumentCreatePayload extends Partial<DocumentSettingsPayload> {
  name: string
  language: Language
  name_source?: 'fallback' | 'user'
  text?: string
  findings?: SavedFinding[]
  scorecard?: ScorecardSnapshot | null
}

export interface DocumentUpdatePayload {
  revision: number
  name?: string
  content?: DocumentContentPayload
  settings?: DocumentSettingsPayload
}

export const listDocuments = () => request<DocumentSummary[]>('/api/documents')
export const getDocument = (id: number) =>
  request<DocumentFull>(`/api/documents/${id}`)
export const createDocument = (payload: DocumentCreatePayload) =>
  request<DocumentFull>('/api/documents', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
export const updateDocument = (id: number, payload: DocumentUpdatePayload) =>
  request<DocumentFull>(`/api/documents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
export const deleteDocument = (id: number) =>
  request<void>(`/api/documents/${id}`, { method: 'DELETE' })
export const generateDocumentName = (id: number) =>
  request<DocumentFull>(`/api/documents/${id}/generate-name`, { method: 'POST' })
```

- [ ] **Step 4: Implement store additions**

In `frontend/src/state/store.ts`:

Add to imports: `import type { DocumentSummary, HeldBackSuggestion, NameSource } from '../api/client'`.

Add the type and state fields (in `AppState`):

```typescript
export interface DocMeta {
  id: number
  name: string
  nameSource: NameSource
  revision: number
}
```

```typescript
  documents: DocumentSummary[]
  docMeta: DocMeta | null
  // Persisted so a reload reopens the same document; docMeta is runtime-only.
  currentDocId: number | null
  docSidebarCollapsed: boolean
  docListError: boolean

  setDocuments: (documents: DocumentSummary[]) => void
  setDocMeta: (docMeta: DocMeta | null) => void
  patchDocMeta: (patch: Partial<DocMeta>) => void
  touchDocument: (id: number, name?: string) => void
  toggleDocSidebar: () => void
  setDocListError: (docListError: boolean) => void
```

Initial values (with the other initials): `documents: [], docMeta: null, currentDocId: null, docSidebarCollapsed: false, docListError: false,`

Actions:

```typescript
      setDocuments: (documents) => set({ documents }),
      setDocMeta: (docMeta) =>
        set({ docMeta, currentDocId: docMeta ? docMeta.id : null }),
      patchDocMeta: (patch) =>
        set((state) =>
          state.docMeta ? { docMeta: { ...state.docMeta, ...patch } } : {},
        ),
      touchDocument: (id, name) =>
        set((state) => {
          const entry = state.documents.find((d) => d.id === id)
          if (!entry) return {}
          const touched = {
            ...entry,
            name: name ?? entry.name,
            updated_at: new Date().toISOString(),
          }
          return {
            documents: [touched, ...state.documents.filter((d) => d.id !== id)],
          }
        }),
      toggleDocSidebar: () =>
        set((state) => ({ docSidebarCollapsed: !state.docSidebarCollapsed })),
      setDocListError: (docListError) => set({ docListError }),
```

Persistence — bump `version` to `2`, extend `migrate`, shrink `partialize`:

```typescript
      version: 2,
      // v0 predates tiers: those users had explicitly chosen provider/model,
      // so they stay pinned rather than silently switching models.
      // v1 -> v2: header settings moved into per-document storage; stale keys
      // in old blobs are harmless extras and rehydrate transiently (the
      // legacy-document migration in documents.ts still reads them once).
      migrate: (persisted, version) =>
        version === 0
          ? { ...(persisted as object), tier: null }
          : (persisted as object),
      partialize: (state) => ({
        uiLocale: state.uiLocale,
        lastProfileByLanguage: state.lastProfileByLanguage,
        rulesCollapsed: state.rulesCollapsed,
        currentDocId: state.currentDocId,
        docSidebarCollapsed: state.docSidebarCollapsed,
      }),
```

(Deliberate: `language/domainIds/provider/model/tier/llmAuto` leave `partialize` — they now belong to the open document. A v1 blob still rehydrates them into memory once, which the legacy migration in Task 6 uses.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/state/store.test.ts` then `npx vitest run` and `npx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/state/store.ts frontend/src/state/store.test.ts
git commit -m "feat: document API client, store document state, persist v2"
```

---

### Task 5: Snapshot buffer + autosave engine + auto-title trigger

**Files:**
- Create: `frontend/src/documents/buffer.ts`
- Create: `frontend/src/documents/autosave.ts`
- Test: `frontend/src/documents/autosave.test.ts`

**Interfaces:**
- Consumes: Task 4's client functions/types and store fields; `getEditorView()` from `../editor/editorRef`; `wordCount` from `../scoring/score`.
- Produces (used by Tasks 6–7):
  - `buffer.ts`: `interface DocSnapshot { docId: number; revision: number; dirty: boolean; name: string; text: string; findings: SavedFinding[]; scorecard: ScorecardSnapshot | null; settings: DocumentSettingsPayload }`, `writeSnapshot(s)`, `readSnapshot(): DocSnapshot | null`, `clearSnapshot()`
  - `autosave.ts`: `noteChange()`, `flush(): Promise<void>`, `collectSnapshot(): DocSnapshot | null`, `beginHydration()`, `endHydration()`, `setConflictHandler(h: (s: DocSnapshot) => Promise<void>)`, `resetAutosaveForTests()`
  - Behavior: `noteChange` writes the buffer synchronously and debounces `flush` by 1500 ms; `flush` PUTs content+settings, updates `docMeta.revision`, marks the buffer clean, bumps the list entry, and triggers the auto-title check; network errors retry with 2 s→30 s backoff; 409/404 invoke the conflict handler; a save in flight queues exactly one follow-up.

- [ ] **Step 1: Write the failing tests**

`frontend/src/documents/autosave.test.ts` — mock the client module and the editor ref; use fake timers:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../api/client'
import { useStore } from '../state/store'
import { readSnapshot, writeSnapshot, clearSnapshot } from './buffer'
import {
  beginHydration,
  endHydration,
  flush,
  noteChange,
  resetAutosaveForTests,
  setConflictHandler,
} from './autosave'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  updateDocument: vi.fn(),
  generateDocumentName: vi.fn(),
}))
vi.mock('../editor/editorRef', () => ({
  getEditorView: () => ({ state: { doc: { toString: () => docText } } }),
}))

import { generateDocumentName, updateDocument } from '../api/client'

let docText = 'hello world'

function seedStore(): void {
  useStore.getState().setDocMeta({ id: 5, name: 'Doc', nameSource: 'user', revision: 2 })
  useStore.getState().setDocuments([
    { id: 5, name: 'Doc', language: 'en', updated_at: '2026-07-10T00:00:00+00:00' },
  ])
}

function serverDoc(revision: number) {
  return { id: 5, revision, name: 'Doc', name_source: 'user' }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetAutosaveForTests()
  clearSnapshot()
  docText = 'hello world'
  seedStore()
  vi.mocked(updateDocument).mockResolvedValue(serverDoc(3) as never)
  vi.mocked(generateDocumentName).mockResolvedValue(serverDoc(3) as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('autosave', () => {
  it('noteChange writes a dirty snapshot synchronously and debounces the PUT', async () => {
    noteChange()
    expect(readSnapshot()?.dirty).toBe(true)
    expect(readSnapshot()?.text).toBe('hello world')
    expect(updateDocument).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(updateDocument).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateDocument).mock.calls[0][1].revision).toBe(2)
    // Success: buffer clean, revision advanced.
    expect(readSnapshot()?.dirty).toBe(false)
    expect(useStore.getState().docMeta?.revision).toBe(3)
  })

  it('rapid noteChange calls collapse into one PUT', async () => {
    noteChange()
    await vi.advanceTimersByTimeAsync(500)
    noteChange()
    await vi.advanceTimersByTimeAsync(1500)
    expect(updateDocument).toHaveBeenCalledTimes(1)
  })

  it('hydration suppresses noteChange', () => {
    beginHydration()
    noteChange()
    endHydration()
    expect(readSnapshot()).toBeNull()
  })

  it('network failure keeps the buffer dirty and retries with backoff', async () => {
    vi.mocked(updateDocument).mockRejectedValueOnce(new TypeError('offline'))
    await flush()
    expect(readSnapshot()?.dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(2000) // first retry
    expect(updateDocument).toHaveBeenCalledTimes(2)
    expect(readSnapshot()?.dirty).toBe(false)
  })

  it('409 routes to the conflict handler instead of retrying', async () => {
    const onConflict = vi.fn().mockResolvedValue(undefined)
    setConflictHandler(onConflict)
    vi.mocked(updateDocument).mockRejectedValueOnce(new HttpError(409, 'stale'))
    await flush()
    expect(onConflict).toHaveBeenCalledTimes(1)
    expect(onConflict.mock.calls[0][0].docId).toBe(5)
    await vi.advanceTimersByTimeAsync(60000)
    expect(updateDocument).toHaveBeenCalledTimes(1) // no retry loop
  })

  it('generates a title once when a fallback-named doc passes 20 words', async () => {
    useStore.getState().patchDocMeta({ nameSource: 'fallback' })
    docText = Array.from({ length: 21 }, (_, i) => `w${i}`).join(' ')
    vi.mocked(generateDocumentName).mockResolvedValue({
      ...serverDoc(3),
      name: 'Generated Title',
      name_source: 'llm',
    } as never)
    await flush()
    expect(generateDocumentName).toHaveBeenCalledTimes(1)
    expect(useStore.getState().docMeta?.name).toBe('Generated Title')
    expect(useStore.getState().documents[0].name).toBe('Generated Title')
    await flush()
    expect(generateDocumentName).toHaveBeenCalledTimes(1) // once per session
  })

  it('does not title short or already-named documents', async () => {
    docText = 'only four words here'
    useStore.getState().patchDocMeta({ nameSource: 'fallback' })
    await flush()
    docText = Array.from({ length: 25 }, (_, i) => `w${i}`).join(' ')
    useStore.getState().patchDocMeta({ nameSource: 'user' })
    await flush()
    expect(generateDocumentName).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/documents/autosave.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement buffer**

`frontend/src/documents/buffer.ts`:

```typescript
import type {
  DocumentSettingsPayload,
  SavedFinding,
  ScorecardSnapshot,
} from '../api/client'

const BUFFER_KEY = 'fabulous-writing-doc-buffer'

/**
 * Write-through cache of the current document. localStorage is never the
 * source of truth — it only bridges network failures and tab closes until
 * the backend confirms the write (dirty=false).
 */
export interface DocSnapshot {
  docId: number
  revision: number
  dirty: boolean
  name: string
  text: string
  findings: SavedFinding[]
  scorecard: ScorecardSnapshot | null
  settings: DocumentSettingsPayload
}

export function writeSnapshot(snapshot: DocSnapshot): void {
  localStorage.setItem(BUFFER_KEY, JSON.stringify(snapshot))
}

export function readSnapshot(): DocSnapshot | null {
  const raw = localStorage.getItem(BUFFER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as DocSnapshot
  } catch {
    return null
  }
}

export function clearSnapshot(): void {
  localStorage.removeItem(BUFFER_KEY)
}
```

- [ ] **Step 4: Implement autosave**

`frontend/src/documents/autosave.ts`:

```typescript
import {
  generateDocumentName,
  HttpError,
  updateDocument,
} from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { wordCount } from '../scoring/score'
import { useStore } from '../state/store'
import { writeSnapshot, type DocSnapshot } from './buffer'

const DEBOUNCE_MS = 1500
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 30000
const TITLE_WORD_THRESHOLD = 20

let timer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = RETRY_BASE_MS
let saving = false
let pending = false
let hydrating = false
// Injected by documents.ts (avoids a module cycle): resolves a 409/404 by
// preserving the stale snapshot as a recovered copy.
let onConflict: ((snapshot: DocSnapshot) => Promise<void>) | null = null
const titleAttempted = new Set<number>()

export function setConflictHandler(
  handler: (snapshot: DocSnapshot) => Promise<void>,
): void {
  onConflict = handler
}

/** Suppress autosave while a document is being loaded into the editor. */
export function beginHydration(): void {
  hydrating = true
}

export function endHydration(): void {
  hydrating = false
}

export function resetAutosaveForTests(): void {
  if (timer) clearTimeout(timer)
  if (retryTimer) clearTimeout(retryTimer)
  timer = retryTimer = null
  retryDelay = RETRY_BASE_MS
  saving = pending = hydrating = false
  onConflict = null
  titleAttempted.clear()
}

/** Assemble the current document's full state from editor + store. */
export function collectSnapshot(): DocSnapshot | null {
  const state = useStore.getState()
  const view = getEditorView()
  if (!view || !state.docMeta) return null
  return {
    docId: state.docMeta.id,
    revision: state.docMeta.revision,
    dirty: true,
    name: state.docMeta.name,
    text: view.state.doc.toString(),
    findings: state.tracked.map((t) => ({
      finding: {
        ...t.finding,
        span: { ...t.finding.span, start: t.from, end: t.to },
      },
      from: t.from,
      to: t.to,
    })),
    scorecard: state.scorecard
      ? { card: state.scorecard, stale: state.scorecardStale }
      : null,
    settings: {
      language: state.language,
      profile_id: state.profileId,
      domain_ids: state.domainIds,
      llm_provider: state.tier === null ? state.provider : null,
      llm_model: state.tier === null ? state.model : null,
      llm_tier: state.tier,
      llm_auto: state.llmAuto,
    },
  }
}

/** Editor/settings changed: buffer synchronously, save debounced. */
export function noteChange(): void {
  if (hydrating) return
  const snapshot = collectSnapshot()
  if (!snapshot) return
  writeSnapshot(snapshot)
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flush(), DEBOUNCE_MS)
}

/** Save now (document switch, completed check, beforeunload). */
export async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (saving) {
    pending = true
    return
  }
  const snapshot = collectSnapshot()
  if (!snapshot) return
  writeSnapshot(snapshot)
  await push(snapshot)
}

async function push(snapshot: DocSnapshot): Promise<void> {
  saving = true
  try {
    const updated = await updateDocument(snapshot.docId, {
      revision: snapshot.revision,
      content: {
        text: snapshot.text,
        findings: snapshot.findings,
        scorecard: snapshot.scorecard,
      },
      settings: snapshot.settings,
    })
    retryDelay = RETRY_BASE_MS
    const store = useStore.getState()
    if (store.docMeta?.id === snapshot.docId) {
      store.patchDocMeta({ revision: updated.revision })
      writeSnapshot({ ...snapshot, revision: updated.revision, dirty: false })
      store.touchDocument(snapshot.docId)
    }
    await maybeGenerateTitle(snapshot)
  } catch (error) {
    if (
      error instanceof HttpError &&
      (error.status === 409 || error.status === 404)
    ) {
      await onConflict?.(snapshot)
    } else {
      scheduleRetry()
    }
  } finally {
    saving = false
    if (pending) {
      pending = false
      void flush()
    }
  }
}

function scheduleRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flush()
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
}

/** Fire the one-shot LLM titling once a fallback-named doc has enough text. */
async function maybeGenerateTitle(snapshot: DocSnapshot): Promise<void> {
  const meta = useStore.getState().docMeta
  if (!meta || meta.id !== snapshot.docId) return
  if (meta.nameSource !== 'fallback') return
  if (titleAttempted.has(meta.id)) return
  if (wordCount(snapshot.text) < TITLE_WORD_THRESHOLD) return
  titleAttempted.add(meta.id)
  try {
    const doc = await generateDocumentName(meta.id)
    const store = useStore.getState()
    if (store.docMeta?.id === doc.id) {
      store.patchDocMeta({ name: doc.name, nameSource: doc.name_source })
    }
    store.touchDocument(doc.id, doc.name)
  } catch {
    // Silent per spec; a later session may retry.
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/documents/autosave.test.ts` then `npx vitest run` and `npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/documents/buffer.ts frontend/src/documents/autosave.ts frontend/src/documents/autosave.test.ts
git commit -m "feat: write-through autosave engine with retry, conflict handoff, auto-title"
```

---

### Task 6: Document lifecycle + editor/controller integration

**Files:**
- Create: `frontend/src/documents/documents.ts`
- Modify: `frontend/src/editor/Editor.tsx` (drop localStorage text; wire `noteChange`)
- Modify: `frontend/src/App.tsx` (startup init; flush on view switch; profile-apply suppression)
- Modify: `frontend/src/checking/controller.ts` (flush after completed checks)
- Test: `frontend/src/documents/documents.test.ts`

**Interfaces:**
- Consumes: Tasks 4–5 exports; `setFindingsEffect` from `../editor/findings`; `currentMessages` from `../i18n`; `applyProfileToHeader` semantics (untouched).
- Produces (used by Task 7):
  - `documents.ts`: `initDocuments(): Promise<void>`, `openDocument(id: number): Promise<void>`, `createNewDocument(): Promise<void>`, `renameDocument(id: number, name: string): Promise<void>`, `removeDocument(id: number): Promise<void>`, `refreshDocuments(): Promise<void>`, `consumeProfileApplySuppression(): boolean`, `fallbackName(text: string): string | null`
- Key behaviors: hydration replaces editor text + restored findings in ONE CodeMirror transaction; buffer marked clean after open; startup = dirty replay → list fetch → legacy migration → open persisted/most-recent/create; 409/404 recovery = keep local as `«Name» (recovered)` copy, server version wins in place; backend-down startup = hydrate from buffer, `docListError` set, flush retry loop keeps trying.

- [ ] **Step 1: Write the failing tests**

`frontend/src/documents/documents.test.ts` — mock the client and editor layers; test the pure-ish orchestration:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, type DocumentFull } from '../api/client'
import { useStore } from '../state/store'
import { clearSnapshot, readSnapshot, writeSnapshot } from './buffer'
import { resetAutosaveForTests } from './autosave'
import {
  consumeProfileApplySuppression,
  fallbackName,
  initDocuments,
  openDocument,
  removeDocument,
} from './documents'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
}))
vi.mock('../editor/editorRef', () => ({
  getEditorView: () => fakeView,
}))

import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from '../api/client'

const dispatched: unknown[] = []
const fakeView = {
  state: { doc: { toString: () => 'view text', length: 9 } },
  dispatch: (tr: unknown) => dispatched.push(tr),
}

function doc(id: number, over: Partial<DocumentFull> = {}): DocumentFull {
  return {
    id,
    owner_id: 1,
    name: `Doc ${id}`,
    name_source: 'fallback',
    text: 'stored text',
    language: 'de',
    profile_id: 4,
    domain_ids: [1],
    llm_provider: null,
    llm_model: null,
    llm_tier: 'balanced',
    llm_auto: true,
    last_findings: [],
    scorecard: { card: { overall: 70 } as never, stale: true },
    revision: 5,
    created_at: '2026-07-10T00:00:00+00:00',
    updated_at: '2026-07-10T00:00:00+00:00',
    ...over,
  }
}

function summaryOf(d: DocumentFull) {
  return { id: d.id, name: d.name, language: d.language, updated_at: d.updated_at }
}

beforeEach(() => {
  resetAutosaveForTests()
  clearSnapshot()
  dispatched.length = 0
  localStorage.clear()
  useStore.getState().setDocMeta(null)
  useStore.getState().setDocuments([])
})

afterEach(() => vi.clearAllMocks())

describe('openDocument', () => {
  it('hydrates settings, meta, scorecard and suppresses profile apply on language switch', async () => {
    useStore.setState({ language: 'en' })
    vi.mocked(getDocument).mockResolvedValue(doc(3))
    await openDocument(3)
    const s = useStore.getState()
    expect(s.language).toBe('de')
    expect(s.tier).toBe('balanced')
    expect(s.profileId).toBe(4)
    expect(s.lastProfileByLanguage.de).toBe(4)
    expect(s.docMeta).toEqual({ id: 3, name: 'Doc 3', nameSource: 'fallback', revision: 5 })
    expect(s.scorecard).toEqual({ overall: 70 })
    expect(s.scorecardStale).toBe(true)
    expect(consumeProfileApplySuppression()).toBe(true)
    expect(consumeProfileApplySuppression()).toBe(false) // one-shot
    expect(readSnapshot()?.dirty).toBe(false)
    expect(dispatched.length).toBe(1) // text + findings in one transaction
  })

  it('does not arm suppression when the language is unchanged', async () => {
    useStore.setState({ language: 'de' })
    vi.mocked(getDocument).mockResolvedValue(doc(3))
    await openDocument(3)
    expect(consumeProfileApplySuppression()).toBe(false)
  })
})

describe('initDocuments', () => {
  it('replays a dirty snapshot before opening', async () => {
    writeSnapshot({
      docId: 3,
      revision: 5,
      dirty: true,
      name: 'Doc 3',
      text: 'buffered',
      findings: [],
      scorecard: null,
      settings: {
        language: 'de',
        profile_id: null,
        domain_ids: [],
        llm_provider: null,
        llm_model: null,
        llm_tier: 'balanced',
        llm_auto: true,
      },
    })
    vi.mocked(updateDocument).mockResolvedValue(doc(3, { revision: 6 }))
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(3))])
    vi.mocked(getDocument).mockResolvedValue(doc(3, { revision: 6 }))
    useStore.setState({ currentDocId: 3 })
    await initDocuments()
    expect(updateDocument).toHaveBeenCalledWith(3, expect.objectContaining({ revision: 5 }))
    expect(useStore.getState().docMeta?.revision).toBe(6)
  })

  it('migrates the legacy localStorage text when the backend is empty', async () => {
    localStorage.setItem('fabulous-writing-text', 'old legacy words here')
    vi.mocked(listDocuments).mockResolvedValue([])
    vi.mocked(createDocument).mockResolvedValue(doc(1, { name: 'old legacy words here' }))
    await initDocuments()
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'old legacy words here', name: 'old legacy words here' }),
    )
    expect(localStorage.getItem('fabulous-writing-text')).toBeNull()
  })

  it('creates a fresh document when backend and legacy storage are empty', async () => {
    vi.mocked(listDocuments).mockResolvedValue([])
    vi.mocked(createDocument).mockResolvedValue(doc(1, { text: '' }))
    await initDocuments()
    expect(createDocument).toHaveBeenCalledTimes(1)
    expect(useStore.getState().docMeta?.id).toBe(1)
  })

  it('falls back to the buffered document and flags the list on backend failure', async () => {
    writeSnapshot({
      docId: 9, revision: 1, dirty: true, name: 'Buffered',
      text: 'offline text', findings: [], scorecard: null,
      settings: {
        language: 'en', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: 'cheap', llm_auto: true,
      },
    })
    vi.mocked(updateDocument).mockRejectedValue(new TypeError('offline'))
    vi.mocked(listDocuments).mockRejectedValue(new TypeError('offline'))
    await initDocuments()
    expect(useStore.getState().docListError).toBe(true)
    expect(useStore.getState().docMeta?.id).toBe(9)
    expect(readSnapshot()?.dirty).toBe(true) // still awaiting sync
  })

  it('recovers a conflicted replay as a new user-named document', async () => {
    writeSnapshot({
      docId: 3, revision: 4, dirty: true, name: 'Doc 3',
      text: 'diverged text', findings: [], scorecard: null,
      settings: {
        language: 'de', profile_id: null, domain_ids: [],
        llm_provider: null, llm_model: null, llm_tier: 'balanced', llm_auto: true,
      },
    })
    vi.mocked(updateDocument).mockRejectedValue(new HttpError(409, 'stale'))
    vi.mocked(createDocument).mockResolvedValue(doc(11, { name: 'Doc 3 (recovered)', name_source: 'user' }))
    vi.mocked(listDocuments).mockResolvedValue([summaryOf(doc(11)), summaryOf(doc(3))])
    vi.mocked(getDocument).mockResolvedValue(doc(3))
    useStore.setState({ currentDocId: 3 })
    await initDocuments()
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'diverged text',
        name_source: 'user',
        name: expect.stringContaining('recovered'),
      }),
    )
    // The server version of the original wins in place.
    expect(useStore.getState().docMeta?.id).toBe(3)
  })
})

describe('removeDocument', () => {
  it('opens the most recent remaining document when deleting the current one', async () => {
    useStore.getState().setDocuments([summaryOf(doc(1)), summaryOf(doc(2))])
    useStore.getState().setDocMeta({ id: 1, name: 'Doc 1', nameSource: 'user', revision: 0 })
    vi.mocked(deleteDocument).mockResolvedValue(undefined)
    vi.mocked(getDocument).mockResolvedValue(doc(2))
    await removeDocument(1)
    expect(useStore.getState().docMeta?.id).toBe(2)
    expect(useStore.getState().documents.map((d) => d.id)).toEqual([2])
  })
})

describe('fallbackName', () => {
  it('mirrors the backend rule', () => {
    expect(fallbackName('a b c d e f g h')).toBe('a b c d e f')
    expect(fallbackName('   ')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/documents/documents.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the lifecycle module**

`frontend/src/documents/documents.ts`:

```typescript
import {
  createDocument as apiCreateDocument,
  deleteDocument as apiDeleteDocument,
  getDocument,
  HttpError,
  listDocuments,
  updateDocument,
  type DocumentFull,
  type DocumentSummary,
} from '../api/client'
import { getEditorView } from '../editor/editorRef'
import { setFindingsEffect } from '../editor/findings'
import { currentMessages } from '../i18n'
import { useStore } from '../state/store'
import {
  beginHydration,
  collectSnapshot,
  endHydration,
  flush,
  setConflictHandler,
} from './autosave'
import {
  clearSnapshot,
  readSnapshot,
  writeSnapshot,
  type DocSnapshot,
} from './buffer'

const LEGACY_TEXT_KEY = 'fabulous-writing-text'

// One-shot flag: opening a document that switches the language must not let
// the Header's profile effect overwrite the document's own LLM settings.
let suppressProfileApply = false

export function consumeProfileApplySuppression(): boolean {
  const value = suppressProfileApply
  suppressProfileApply = false
  return value
}

/** Mirrors the backend rule in app/services/naming.py. */
export function fallbackName(text: string): string | null {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  return words.slice(0, 6).join(' ').slice(0, 40).trim() || null
}

function summaryOf(doc: DocumentFull): DocumentSummary {
  return {
    id: doc.id,
    name: doc.name,
    language: doc.language,
    updated_at: doc.updated_at,
  }
}

function currentSettings() {
  const state = useStore.getState()
  return {
    profile_id: state.profileId,
    domain_ids: state.domainIds,
    llm_provider: state.tier === null ? state.provider : null,
    llm_model: state.tier === null ? state.model : null,
    llm_tier: state.tier,
    llm_auto: state.llmAuto,
  }
}

/** Load a document into store + editor. The editor change and the restored
 * findings ride ONE transaction, so spans apply to the new text. */
function hydrateFromDocument(doc: DocumentFull): void {
  beginHydration()
  try {
    const store = useStore.getState()
    suppressProfileApply = doc.language !== store.language
    useStore.setState({
      language: doc.language,
      domainIds: doc.domain_ids,
      provider: doc.llm_provider ?? store.provider,
      model: doc.llm_model,
      tier: doc.llm_tier,
      llmAuto: doc.llm_auto,
      profileId: doc.profile_id,
      ...(doc.profile_id !== null
        ? {
            lastProfileByLanguage: {
              ...store.lastProfileByLanguage,
              [doc.language]: doc.profile_id,
            },
          }
        : {}),
    })
    useStore.getState().setDocMeta({
      id: doc.id,
      name: doc.name,
      nameSource: doc.name_source,
      revision: doc.revision,
    })
    const view = getEditorView()
    if (view) {
      const findings = doc.last_findings.map((saved) => ({
        ...saved.finding,
        span: { ...saved.finding.span, start: saved.from, end: saved.to },
      }))
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc.text },
        effects: setFindingsEffect.of(findings),
      })
    }
    if (doc.scorecard) {
      useStore.getState().setScorecard(doc.scorecard.card)
      if (doc.scorecard.stale) useStore.getState().markScorecardStale()
    } else {
      useStore.getState().clearScorecard()
    }
    const snapshot = collectSnapshot()
    if (snapshot) writeSnapshot({ ...snapshot, dirty: false })
  } finally {
    endHydration()
  }
}

/** Offline path: bring the buffered document up without a backend. */
function hydrateFromBuffer(snapshot: DocSnapshot): void {
  hydrateFromDocument({
    id: snapshot.docId,
    owner_id: 1,
    name: snapshot.name,
    name_source: 'user', // conservative: no auto-titling while offline
    text: snapshot.text,
    language: snapshot.settings.language,
    profile_id: snapshot.settings.profile_id,
    domain_ids: snapshot.settings.domain_ids,
    llm_provider: snapshot.settings.llm_provider,
    llm_model: snapshot.settings.llm_model,
    llm_tier: snapshot.settings.llm_tier,
    llm_auto: snapshot.settings.llm_auto,
    last_findings: snapshot.findings,
    scorecard: snapshot.scorecard,
    revision: snapshot.revision,
    created_at: '',
    updated_at: '',
  })
  // hydrate marked the buffer clean; restore the dirty truth so the retry
  // loop keeps pushing it.
  writeSnapshot(snapshot)
}

export async function refreshDocuments(): Promise<void> {
  try {
    useStore.getState().setDocuments(await listDocuments())
    useStore.getState().setDocListError(false)
  } catch {
    useStore.getState().setDocListError(true)
  }
}

export async function openDocument(id: number): Promise<void> {
  await flush()
  const doc = await getDocument(id)
  hydrateFromDocument(doc)
}

export async function createNewDocument(): Promise<void> {
  await flush()
  const state = useStore.getState()
  const doc = await apiCreateDocument({
    name: currentMessages().docUntitled,
    language: state.language,
    ...currentSettings(),
  })
  useStore.getState().setDocuments([summaryOf(doc), ...state.documents])
  hydrateFromDocument(doc)
}

export async function renameDocument(id: number, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  const meta = useStore.getState().docMeta
  // The open document's revision is known; other documents need a fetch.
  const revision =
    meta?.id === id ? meta.revision : (await getDocument(id)).revision
  const updated = await updateDocument(id, { revision, name: trimmed })
  const store = useStore.getState()
  if (store.docMeta?.id === id) {
    store.patchDocMeta({
      name: updated.name,
      nameSource: updated.name_source,
      revision: updated.revision,
    })
  }
  store.touchDocument(id, updated.name)
}

export async function removeDocument(id: number): Promise<void> {
  await apiDeleteDocument(id)
  const store = useStore.getState()
  const remaining = store.documents.filter((d) => d.id !== id)
  store.setDocuments(remaining)
  if (store.docMeta?.id !== id) return
  if (remaining.length > 0) {
    const doc = await getDocument(remaining[0].id)
    hydrateFromDocument(doc)
  } else {
    useStore.getState().setDocMeta(null)
    await createNewDocument()
  }
}

/** 409/404 resolution: the local snapshot becomes a recovered copy; the
 * server version wins in place. Lossless, deterministic, no dialogs. */
async function recoverSnapshot(snapshot: DocSnapshot): Promise<void> {
  const copy = await apiCreateDocument({
    name: currentMessages().docRecovered(snapshot.name),
    name_source: 'user',
    language: snapshot.settings.language,
    text: snapshot.text,
    findings: snapshot.findings,
    scorecard: snapshot.scorecard,
    ...snapshot.settings,
  })
  clearSnapshot()
  await refreshDocuments()
  if (useStore.getState().docMeta?.id !== snapshot.docId) return
  try {
    const original = await getDocument(snapshot.docId)
    hydrateFromDocument(original)
  } catch {
    // The original is gone server-side; the recovered copy takes over.
    hydrateFromDocument(copy)
  }
}

/** App startup: replay dirty buffer, fetch list, migrate legacy text,
 * open the last-open (or most recent) document. */
export async function initDocuments(): Promise<void> {
  setConflictHandler(recoverSnapshot)
  const buffered = readSnapshot()
  if (buffered?.dirty) {
    try {
      const updated = await updateDocument(buffered.docId, {
        revision: buffered.revision,
        content: {
          text: buffered.text,
          findings: buffered.findings,
          scorecard: buffered.scorecard,
        },
        settings: buffered.settings,
      })
      writeSnapshot({ ...buffered, revision: updated.revision, dirty: false })
    } catch (error) {
      if (
        error instanceof HttpError &&
        (error.status === 409 || error.status === 404)
      ) {
        await recoverSnapshot(buffered)
      }
      // Other failures: backend down; the offline path below takes over.
    }
  }

  let documents: DocumentSummary[]
  try {
    documents = await listDocuments()
  } catch {
    useStore.getState().setDocListError(true)
    const snapshot = readSnapshot()
    if (snapshot) hydrateFromBuffer(snapshot)
    return
  }
  useStore.getState().setDocListError(false)

  if (documents.length === 0) {
    const legacy = localStorage.getItem(LEGACY_TEXT_KEY)
    localStorage.removeItem(LEGACY_TEXT_KEY)
    if (legacy?.trim()) {
      const state = useStore.getState()
      const doc = await apiCreateDocument({
        name: fallbackName(legacy) ?? currentMessages().docUntitled,
        language: state.language,
        text: legacy,
        ...currentSettings(),
      })
      useStore.getState().setDocuments([summaryOf(doc)])
      hydrateFromDocument(doc)
      return
    }
    await createNewDocument()
    return
  }

  localStorage.removeItem(LEGACY_TEXT_KEY)
  useStore.getState().setDocuments(documents)
  const persistedId = useStore.getState().currentDocId
  const target = documents.find((d) => d.id === persistedId) ?? documents[0]
  const doc = await getDocument(target.id)
  hydrateFromDocument(doc)
}
```

- [ ] **Step 4: Wire editor, app, and controller**

`frontend/src/editor/Editor.tsx` — remove `TEXT_STORAGE_KEY`, `DEFAULT_TEXT`, the localStorage read/write, and the initial `runCheck` (content now arrives via `openDocument`, whose transaction schedules the fast check):

```typescript
// imports: add
import { flush, noteChange } from '../documents/autosave'
```

```typescript
    const view = new EditorView({
      doc: '',
      parent: container.current!,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        findingsField,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            noteChange()
            scheduler.onInput()
            const store = useStore.getState()
            store.setDocWords(wordCount(update.state.doc.toString()))
            store.markScorecardStale()
          }
          const field = update.state.field(findingsField)
          const previous = update.startState.field(findingsField)
          if (field !== previous) {
            useStore.getState().setTracked(field.items, field.selectedId)
          }
        }),
        // ... domEventHandlers unchanged
      ],
    })
    setEditorView(view)
    useStore.getState().setDocWords(wordCount(view.state.doc.toString()))

    const onBeforeUnload = () => void flush()
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      scheduler.dispose()
      setEditorView(null)
      view.destroy()
    }
```

(Note: the hydration transaction fires `docChanged`, but `noteChange` is suppressed by `beginHydration`; the scheduler still sees the input and schedules the fast check — that re-checks restored documents automatically, replacing restored rule findings with fresh identical ones while restored LLM findings survive via `mergeFindingsEffect`.)

`frontend/src/App.tsx`:

```typescript
// imports: add
import { flush } from './documents/autosave'
import { consumeProfileApplySuppression, initDocuments } from './documents/documents'
import { DocumentSidebar } from './documents/DocumentSidebar'
```

In `App()` add startup + view-switch effects and mount the sidebar (`DocumentSidebar` arrives in Task 7 — for THIS task, mount nothing; only add the effects; the import above is added in Task 7):

```typescript
export default function App() {
  const activeView = useStore((s) => s.activeView)

  useEffect(() => {
    // Startup: replay dirty buffer, load the document list, open the last
    // document. Runs once; StrictMode double-invocation is tolerated because
    // a clean replay is a no-op and hydration is idempotent.
    void initDocuments()
  }, [])

  useEffect(() => {
    // Leaving the editor view is a natural save point.
    if (activeView !== 'editor') void flush()
  }, [activeView])
  // ... rest unchanged
```

In `Header()`'s profile effect, one line changes — the `selectProfile` call honors suppression:

```typescript
        const suppressed = consumeProfileApplySuppression()
        if (chosen) s.selectProfile(chosen, isSwitch && !suppressed)
```

(`consumeProfileApplySuppression` must be called INSIDE the `.then`, right before `selectProfile`, so the one-shot flag is consumed by exactly the fetch that follows a document open.)

Also: settings changes must autosave. At the end of `Header()`'s render-level handlers nothing changes — instead add ONE store subscription effect in `App()`:

```typescript
  useEffect(() => {
    // Per-document settings autosave: any change to the header selection
    // fields buffers + debounces a save, exactly like typing does.
    let previous = useStore.getState()
    return useStore.subscribe((state) => {
      const changed =
        state.language !== previous.language ||
        state.domainIds !== previous.domainIds ||
        state.provider !== previous.provider ||
        state.model !== previous.model ||
        state.tier !== previous.tier ||
        state.llmAuto !== previous.llmAuto ||
        state.profileId !== previous.profileId
      previous = state
      if (changed && state.docMeta) noteChange()
    })
  }, [])
```

(import `noteChange` from `./documents/autosave`; `noteChange` is hydration-suppressed, so document opens don't echo a save.)

`frontend/src/checking/controller.ts` — completed checks save immediately (spec decision 3):

```typescript
// import at top
import { flush } from '../documents/autosave'
```

After the fast-findings application (`applyFindings(text, ['rule', 'terminology'], …)` line): add `void flush()` on the next line.
Inside `onResult` after `applyFindings(text, ['llm'], findings)`: add `void flush()`.
Inside `onScorecard`, after the stale-marking block: add `void flush()`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/documents/documents.test.ts`, then the full gates: `npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`
Expected: all PASS, zero lint warnings.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/documents/documents.ts frontend/src/documents/documents.test.ts frontend/src/editor/Editor.tsx frontend/src/App.tsx frontend/src/checking/controller.ts
git commit -m "feat: document lifecycle - open/create/rename/delete, startup replay, legacy migration"
```

Note: this task references `m.docUntitled` and `m.docRecovered(name)` which land in Task 7's i18n step. To keep THIS task green, add the two keys for all 7 locales in this task already (see Task 7 Step 3 for the exact translations — take `docUntitled` and `docRecovered` from that table) and let Task 7 add the remaining keys. `currentMessages` comes from `../i18n` (already exported; the existing `vetMessage.ts` uses it the same way).

---

### Task 7: Document sidebar UI + i18n

**Files:**
- Create: `frontend/src/documents/DocumentSidebar.tsx`
- Modify: `frontend/src/App.tsx` (mount sidebar in workspace)
- Modify: `frontend/src/App.css` (sidebar styles)
- Modify: `frontend/src/i18n/messages.ts` + all 7 catalogs (`en.ts de.ts fr.ts es.ts it.ts ja.ts zh.ts`)
- Test: `frontend/src/documents/DocumentSidebar.test.tsx` (via `@testing-library/react` if present in devDeps — check `package.json`; if it is absent, test the pure `relativeTime` helper instead and rely on the Task 8 e2e for interaction coverage)

**Interfaces:**
- Consumes: Task 6 lifecycle functions, store document state, `useMessages()`/`useLocale()` from `../i18n`.
- Produces: `DocumentSidebar` React component; `relativeTime(iso: string, locale: string, now?: number): string` exported from `DocumentSidebar.tsx`.

- [ ] **Step 1: Write the failing test for relativeTime**

In `frontend/src/documents/DocumentSidebar.test.tsx`:

```typescript
import { describe, expect, it } from 'vitest'
import { relativeTime } from './DocumentSidebar'

describe('relativeTime', () => {
  const now = Date.parse('2026-07-10T12:00:00+00:00')
  it('renders minutes, hours and days in the given locale', () => {
    expect(relativeTime('2026-07-10T11:58:00+00:00', 'en', now)).toMatch(/minute/)
    expect(relativeTime('2026-07-10T09:00:00+00:00', 'en', now)).toMatch(/hour/)
    expect(relativeTime('2026-07-07T12:00:00+00:00', 'de', now)).toMatch(/Tag/)
  })
  it('clamps future timestamps (clock skew) to "now"', () => {
    expect(relativeTime('2026-07-10T12:00:30+00:00', 'en', now)).toBe(
      relativeTime('2026-07-10T12:00:00+00:00', 'en', now),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/documents/DocumentSidebar.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Add the i18n keys**

In `frontend/src/i18n/messages.ts` add to the `Messages` interface (grouped after the existing view keys):

```typescript
  docNew: string
  docUntitled: string
  docRecovered: (name: string) => string
  docRename: string
  docDelete: string
  docDeleteConfirm: (name: string) => string
  docListError: string
  docRetry: string
  docSidebarShow: string
  docSidebarHide: string
  docMenu: string
```

Catalog values (each locale file gets its column; keep the surrounding style of each file):

| key | en | de | fr | es | it | ja | zh |
|---|---|---|---|---|---|---|---|
| docNew | `New document` | `Neues Dokument` | `Nouveau document` | `Documento nuevo` | `Nuovo documento` | `新規ドキュメント` | `新建文档` |
| docUntitled | `Untitled` | `Ohne Titel` | `Sans titre` | `Sin título` | `Senza titolo` | `無題` | `无标题` |
| docRecovered | `` (name) => `${name} (recovered)` `` | `` `${name} (wiederhergestellt)` `` | `` `${name} (récupéré)` `` | `` `${name} (recuperado)` `` | `` `${name} (recuperato)` `` | `` `${name}（復元）` `` | `` `${name}（已恢复）` `` |
| docRename | `Rename` | `Umbenennen` | `Renommer` | `Renombrar` | `Rinomina` | `名前を変更` | `重命名` |
| docDelete | `Delete` | `Löschen` | `Supprimer` | `Eliminar` | `Elimina` | `削除` | `删除` |
| docDeleteConfirm | `` (name) => `Delete "${name}"? This cannot be undone.` `` | `` `"${name}" löschen? Das kann nicht rückgängig gemacht werden.` `` | `` `Supprimer « ${name} » ? Cette action est irréversible.` `` | `` `¿Eliminar «${name}»? Esta acción no se puede deshacer.` `` | `` `Eliminare "${name}"? L'operazione non può essere annullata.` `` | `` `「${name}」を削除しますか？この操作は取り消せません。` `` | `` `删除“${name}”？此操作无法撤销。` `` |
| docListError | `Could not load documents.` | `Dokumente konnten nicht geladen werden.` | `Impossible de charger les documents.` | `No se pudieron cargar los documentos.` | `Impossibile caricare i documenti.` | `ドキュメントを読み込めませんでした。` | `无法加载文档。` |
| docRetry | `Retry` | `Erneut versuchen` | `Réessayer` | `Reintentar` | `Riprova` | `再試行` | `重试` |
| docSidebarShow | `Show documents` | `Dokumente anzeigen` | `Afficher les documents` | `Mostrar documentos` | `Mostra documenti` | `ドキュメントを表示` | `显示文档` |
| docSidebarHide | `Hide documents` | `Dokumente ausblenden` | `Masquer les documents` | `Ocultar documentos` | `Nascondi documenti` | `ドキュメントを非表示` | `隐藏文档` |
| docMenu | `Document actions` | `Dokumentaktionen` | `Actions du document` | `Acciones del documento` | `Azioni documento` | `ドキュメント操作` | `文档操作` |

(If Task 6 already added `docUntitled`/`docRecovered`, add only the rest.) The i18n test suite (`i18n.test.ts`) enforces key parity across locales — run it.

- [ ] **Step 4: Implement the sidebar**

`frontend/src/documents/DocumentSidebar.tsx`:

```tsx
import { useState } from 'react'
import type { DocumentSummary } from '../api/client'
import { useLocale, useMessages } from '../i18n'
import { useStore } from '../state/store'
import {
  createNewDocument,
  initDocuments,
  openDocument,
  removeDocument,
  renameDocument,
} from './documents'

/** "2 hours ago" in the UI locale; future stamps clamp to now. */
export function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.min(0, Math.round((Date.parse(iso) - now) / 60000))
  if (minutes > -60) return rtf.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours > -24) return rtf.format(hours, 'hour')
  return rtf.format(Math.round(hours / 24), 'day')
}

export function DocumentSidebar() {
  const m = useMessages()
  const collapsed = useStore((s) => s.docSidebarCollapsed)
  const toggle = useStore((s) => s.toggleDocSidebar)
  const documents = useStore((s) => s.documents)
  const error = useStore((s) => s.docListError)

  if (collapsed) {
    return (
      <aside className="doc-sidebar collapsed">
        <button
          className="doc-sidebar-toggle"
          title={m.docSidebarShow}
          aria-label={m.docSidebarShow}
          onClick={toggle}
        >
          ▸
        </button>
      </aside>
    )
  }
  return (
    <aside className="doc-sidebar">
      <div className="doc-sidebar-head">
        <button className="doc-new" onClick={() => void createNewDocument()}>
          + {m.docNew}
        </button>
        <button
          className="doc-sidebar-toggle"
          title={m.docSidebarHide}
          aria-label={m.docSidebarHide}
          onClick={toggle}
        >
          ◂
        </button>
      </div>
      {error && (
        <p className="doc-list-error">
          {m.docListError}{' '}
          <button onClick={() => void initDocuments()}>{m.docRetry}</button>
        </p>
      )}
      <ul className="doc-list">
        {documents.map((doc) => (
          <DocumentItem key={doc.id} doc={doc} />
        ))}
      </ul>
    </aside>
  )
}

function DocumentItem({ doc }: { doc: DocumentSummary }) {
  const m = useMessages()
  const locale = useLocale()
  const isCurrent = useStore((s) => s.docMeta?.id === doc.id)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const commitRename = (value: string) => {
    setRenaming(false)
    if (value.trim() && value.trim() !== doc.name) {
      void renameDocument(doc.id, value)
    }
  }

  return (
    <li className={isCurrent ? 'doc-item current' : 'doc-item'}>
      {renaming ? (
        <input
          className="doc-rename-input"
          defaultValue={doc.name}
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
          className="doc-open"
          onClick={() => {
            if (!isCurrent) void openDocument(doc.id)
          }}
        >
          <span className="doc-name">{doc.name}</span>
          <span className="doc-time">{relativeTime(doc.updated_at, locale)}</span>
        </button>
      )}
      <div className="doc-actions">
        <button
          className="doc-menu-button"
          aria-label={m.docMenu}
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="doc-menu" onMouseLeave={() => setMenuOpen(false)}>
            <button
              onClick={() => {
                setMenuOpen(false)
                setRenaming(true)
              }}
            >
              {m.docRename}
            </button>
            <button
              className="doc-menu-delete"
              onClick={() => {
                setMenuOpen(false)
                if (window.confirm(m.docDeleteConfirm(doc.name))) {
                  void removeDocument(doc.id)
                }
              }}
            >
              {m.docDelete}
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
```

Mount it in `frontend/src/App.tsx` (import from Task 6's note; place it as the workspace's first child):

```tsx
      <main className="workspace" hidden={activeView !== 'editor'}>
        <DocumentSidebar />
        <div className="editor-area">
```

- [ ] **Step 5: Add the CSS**

Append to `frontend/src/App.css` (match the file's existing custom-property/color usage — inspect neighboring rules and reuse its grays/accent variables where they exist):

```css
/* Document sidebar (editor view) */
.doc-sidebar {
  width: 220px;
  flex: 0 0 220px;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.6rem 0.4rem;
  border-right: 1px solid #e5e7eb;
  overflow-y: auto;
}
.doc-sidebar.collapsed {
  width: auto;
  flex: 0 0 auto;
  padding: 0.6rem 0.2rem;
}
.doc-sidebar-head {
  display: flex;
  gap: 0.3rem;
  align-items: center;
}
.doc-new {
  flex: 1;
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  font-weight: 600;
}
.doc-sidebar-toggle {
  padding: 0.3rem 0.45rem;
  border-radius: 6px;
}
.doc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.doc-item {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 6px;
}
.doc-item.current {
  background: rgba(99, 102, 241, 0.12);
}
.doc-item:hover {
  background: rgba(99, 102, 241, 0.06);
}
.doc-open {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  text-align: left;
  padding: 0.35rem 0.5rem;
  background: none;
  border: none;
  cursor: pointer;
}
.doc-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
}
.doc-time {
  font-size: 0.7rem;
  color: #6b7280;
}
.doc-actions {
  position: relative;
}
.doc-menu-button {
  visibility: hidden;
  padding: 0.2rem 0.4rem;
  background: none;
  border: none;
  cursor: pointer;
}
.doc-item:hover .doc-menu-button,
.doc-item.current .doc-menu-button {
  visibility: visible;
}
.doc-menu {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 8rem;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.doc-menu button {
  text-align: left;
  padding: 0.4rem 0.7rem;
  background: none;
  border: none;
  cursor: pointer;
}
.doc-menu button:hover {
  background: rgba(99, 102, 241, 0.08);
}
.doc-menu-delete {
  color: #b91c1c;
}
.doc-rename-input {
  flex: 1;
  margin: 0.2rem 0.3rem;
  padding: 0.25rem 0.4rem;
  font-size: 0.85rem;
}
.doc-list-error {
  margin: 0;
  padding: 0.3rem 0.5rem;
  font-size: 0.78rem;
  color: #b91c1c;
}
```

- [ ] **Step 6: Run all gates**

Run: `npx vitest run` (includes `i18n.test.ts` key parity), `npx tsc --noEmit`, `npm run lint`, `npm run build`
Expected: all PASS, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/documents/DocumentSidebar.tsx frontend/src/documents/DocumentSidebar.test.tsx frontend/src/App.tsx frontend/src/App.css frontend/src/i18n/
git commit -m "feat: collapsible document sidebar with rename/delete and recency list"
```

---

### Task 8: End-to-end verification + docs + logbook

**Files:**
- Modify: `docs/backend-architecture.md` (documents table, DocumentStore, /api/documents, naming)
- Modify: `docs/frontend-architecture.md` (documents module, autosave/buffer, sidebar, persist v2)
- Modify: `docs/LOGBOOK.md` (append entry; run `date '+%Y-%m-%d'` first — never extrapolate dates)
- Scratch only (never committed): e2e script + scratch DB under the session scratchpad directory

**Interfaces:** none produced; this task proves the whole branch and records it.

- [ ] **Step 1: Full-stack e2e against a scratch backend**

Never touch `backend/data/fabulous.db` and never kill/restart the user's dev servers (:5173/:8000). Build an isolated stack:

1. Scratch backend (from `backend/`), port **8001**, scratch DB in the scratchpad dir:

```bash
uv run python - <<'EOF' &
import tempfile, pathlib, uvicorn
from app.core.config import Settings
from app.main import create_app

db = pathlib.Path(tempfile.mkdtemp(prefix="fab-e2e-")) / "e2e.db"
app = create_app(Settings(db_path=db))
uvicorn.run(app, host="127.0.0.1", port=8001)
EOF
```

2. Scratch frontend build wired to it (from `frontend/`): `VITE_API_URL=http://127.0.0.1:8001 npm run build` then `npx vite preview --port 4199 &` (kill both processes when done).

3. Headless Playwright script in the scratchpad (import `playwright-core` via absolute path `frontend/node_modules/playwright-core/index.mjs`, class-only selectors — UI may be German), driving `http://127.0.0.1:4199`:
   - Fresh load → exactly one document exists (auto-created), sidebar shows it.
   - Type ~25 words containing rule triggers (e.g. repeated "very very") → fast findings appear; wait > 2 s → PUT persisted (poll `GET http://127.0.0.1:8001/api/documents` until `updated_at` moves).
   - Auto-title: after the save, the sidebar name changes from "Untitled"/localized to the first-words fallback (the scratch backend has no LLM key for the cheap tier → gemini fails → first-words). Assert name no longer equals the untitled label.
   - Reload the page → same document opens with text AND findings restored in the sidebar (assert finding count > 0 before any new check completes, i.e. immediately after `domcontentloaded`).
   - Create a second document → sidebar shows 2, new one active and empty. Switch back to the first → text restored.
   - Rename the first via the ⋯ menu → name sticks after reload. Delete the second → list shrinks, first becomes active.
   - Screenshot the final state to the scratchpad and inspect it.

4. Kill the scratch uvicorn + vite preview processes; the scratch DB dir may stay (it's in the session scratchpad).

Expected: every assertion passes; paste the script's PASS summary into the task report.

- [ ] **Step 2: Update architecture docs**

`docs/backend-architecture.md`: add a "Documents" section describing the `documents` table (all columns incl. `revision`, `owner_id` future-users note, JSON snapshot columns), `DocumentStore` (optimistic locking semantics, `set_name` no-bump rationale), the five CRUD endpoints + `generate-name` (cheap-tier resolution from `settings.routing`, clean_title/fallback_name rules), and the naming module. Follow the file's existing section style.

`docs/frontend-architecture.md`: add a "Documents" section — `src/documents/` module map (buffer/autosave/documents/DocumentSidebar), the write-through buffer + dirty replay + 409 recovered-copy flow, per-document header settings + profile-apply suppression, persist v2 partialize contents, and what remains in localStorage (uiLocale, rulesCollapsed, currentDocId, docSidebarCollapsed, the buffer). Follow the file's existing section style.

- [ ] **Step 3: Logbook entry**

Run `date '+%Y-%m-%d'`. Append to `docs/LOGBOOK.md` under that date: feature summary (multi-document management), the commit list of Tasks 1–7, test counts, and the e2e verification result.

- [ ] **Step 4: Run both full suites one last time**

From `backend/`: `uv run pytest -q` — all pass, zero warnings.
From `frontend/`: `npx vitest run && npx tsc --noEmit && npm run lint && npm run build` — all pass, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add docs/backend-architecture.md docs/frontend-architecture.md docs/LOGBOOK.md
git commit -m "docs: document multi-document architecture and log the feature"
```

---

## Self-Review Notes (already applied)

- Spec coverage: schema+store (T1), CRUD+409 (T2), auto-naming incl. no-revision-bump and empty-text short-circuit (T3), client+store+persist v2 (T4), buffer+autosave+backoff+title trigger (T5), lifecycle+migration+replay+recovery+editor/controller wiring incl. beforeunload and view-switch flush (T6), sidebar UI+i18n ×7 (T7), e2e+docs (T8).
- The `m.docUntitled`/`m.docRecovered` forward reference from Task 6 to Task 7 is resolved by the explicit note at the end of Task 6 (add those two keys early, from Task 7's table).
- Type consistency: `DocSnapshot`, `DocMeta`, `DocumentFull`, `SavedFinding`, `ScorecardSnapshot` names match across Tasks 4–7; store action names (`setDocMeta`, `patchDocMeta`, `touchDocument`) match between definition (T4) and use (T5–T7).
- `revision` semantics consistent: create=0, PUT increments, `set_name`/`generate-name` never bumps (asserted in T1 and T3 tests; relied on by T5's autosave).
