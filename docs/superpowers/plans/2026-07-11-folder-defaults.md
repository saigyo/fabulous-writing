# Per-Folder Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Folders carry optional default settings (language, profile, domains, LLM choice, auto-flag) applied to documents created inside them via "New document here".

**Architecture:** Seven nullable columns on `folders` (typed, mirroring the `documents` settings columns) via the reserved idempotent `_migrate()` hook; a full-replace `PUT /api/folders/{id}/defaults` endpoint with profile⇒language validation; read-time pruning of dead profile/domain references in `GET /api/folders`; a pure client-side overlay `applyFolderDefaults` inside `createNewDocument`; a modal dialog opened from the folder ⋯ menu.

**Tech Stack:** Python 3.13 / FastAPI / sqlite3 / pydantic (backend, uv-managed, run from `backend/`); React 19 / TypeScript / zustand / vitest (frontend).

**Spec:** docs/superpowers/specs/2026-07-11-folder-defaults-design.md

## Global Constraints

- Defaults apply **on creation only** ("New document here"); moving a document into a folder never touches its settings; the top-level "+ New document" is unaffected.
- Each default is **individually optional**; NULL = unset (fall back to current header state). `default_domain_ids` distinguishes NULL (unset) from `[]` (set default of "no domains").
- Invariant: **profile default ⇒ language default**, and the profile must belong to that language (backend 422 + UI coupling).
- The LLM provider/model/tier triple is **one composite unit**: applied together, cleared together. Tier values are exactly `quality | balanced | cheap | local`.
- `PUT /api/folders/{id}/defaults` is a **full replace** (no PATCH merge). 404 unknown folder; 422 for the validation matrix.
- Pruning of dead `default_profile_id` / `default_domain_ids` entries is **read-time only** in `GET /api/folders`; the DB row is never modified by pruning.
- The owner's live DB `backend/data/fabulous.db` must never be touched by tests or e2e (scratch data only). The user's dev servers (frontend :5173, backend :8000) must never be killed or restarted.
- i18n: every new key goes into ALL seven catalogs (en/de/fr/es/it/ja/zh) + the `Messages` interface; the parity test enforces this.
- Commits go directly on `main`; every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Gates: backend `uv run pytest -q` (from `backend/`, zero warnings); frontend `npx vitest run && npx tsc --noEmit && npm run lint && npm run build` (from `frontend/`, oxlint zero warnings; the >500kB chunk advisory in build is pre-existing and acceptable).

---

### Task 1: FolderStore — defaults columns, migration, `set_defaults`

**Files:**
- Modify: `backend/app/services/folders.py`
- Test: `backend/tests/test_folders.py`

**Interfaces:**
- Consumes: existing `FolderStore` / `Folder` (see file), `Language` enum from `app.core.models` (`EN = "en"`, `DE = "de"`, …).
- Produces: `FolderDefaults` pydantic model (fields `default_language: Language | None`, `default_profile_id: int | None`, `default_domain_ids: list[int] | None`, `default_llm_provider: str | None`, `default_llm_model: str | None`, `default_llm_tier: str | None`, `default_llm_auto: bool | None`, all defaulting to None); `Folder` gains the same seven optional fields; `FolderStore.set_defaults(folder_id: int, defaults: FolderDefaults) -> Folder | None` (None = unknown folder; full replace). Task 2 imports `FolderDefaults` from this module.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_folders.py` (imports `sqlite3` — add `import sqlite3` at the top of the file; also extend the existing import to `from app.services.folders import FolderStore, FolderDefaults`):

```python
def test_defaults_migration_idempotent(db):
    # A pre-phase-3 DB has only the four original columns.
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL DEFAULT 1,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );
        INSERT INTO folders (name, created_at)
        VALUES ('Old', '2026-01-01T00:00:00+00:00');
        """
    )
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `uv run pytest tests/test_folders.py -q`
Expected: FAIL — `ImportError: cannot import name 'FolderDefaults'`.

- [ ] **Step 3: Implement**

In `backend/app/services/folders.py`:

Add imports at the top:

```python
import json
```

and

```python
from app.core.models import Language
```

Replace `_SCHEMA` with (new columns so fresh DBs need no ALTERs; `_migrate` covers pre-existing DBs):

```python
_SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
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
```

Add the defaults model directly below the schema, and extend `Folder`:

```python
class FolderDefaults(BaseModel):
    """Optional per-folder settings applied to documents created inside.

    NULL/None means "no default" (fall back to the header state at creation
    time). default_domain_ids distinguishes None (unset) from [] (a set
    default of "no domains").
    """

    default_language: Language | None = None
    default_profile_id: int | None = None
    default_domain_ids: list[int] | None = None
    default_llm_provider: str | None = None
    default_llm_model: str | None = None
    default_llm_tier: str | None = None
    default_llm_auto: bool | None = None


class Folder(FolderDefaults):
    id: int
    owner_id: int = 1
    name: str
    created_at: str
```

(The existing separate `class Folder(BaseModel)` is replaced by this inheritance — a `Folder` IS its defaults plus identity, and the API layer can do `FolderDefaults(**body.model_dump())` without duplication.)

Replace `_row_to_folder`:

```python
def _row_to_folder(row: sqlite3.Row) -> Folder:
    return Folder(
        id=row["id"],
        owner_id=row["owner_id"],
        name=row["name"],
        created_at=row["created_at"],
        default_language=(
            Language(row["default_language"]) if row["default_language"] else None
        ),
        default_profile_id=row["default_profile_id"],
        default_domain_ids=(
            json.loads(row["default_domain_ids"])
            if row["default_domain_ids"] is not None
            else None
        ),
        default_llm_provider=row["default_llm_provider"],
        default_llm_model=row["default_llm_model"],
        default_llm_tier=row["default_llm_tier"],
        default_llm_auto=(
            None if row["default_llm_auto"] is None else bool(row["default_llm_auto"])
        ),
    )
```

In `FolderStore.__init__`, call the migration after the schema:

```python
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)
```

Add `_migrate` and `set_defaults` methods to `FolderStore` (after `_connect`, matching the DocumentStore migration style):

```python
    def _migrate(self, conn: sqlite3.Connection) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(folders)")}
        for name, decl in (
            ("default_language", "TEXT"),
            ("default_profile_id", "INTEGER"),
            ("default_domain_ids", "TEXT"),
            ("default_llm_provider", "TEXT"),
            ("default_llm_model", "TEXT"),
            ("default_llm_tier", "TEXT"),
            ("default_llm_auto", "INTEGER"),
        ):
            if name not in columns:
                conn.execute(f"ALTER TABLE folders ADD COLUMN {name} {decl}")

    def set_defaults(
        self, folder_id: int, defaults: FolderDefaults
    ) -> Folder | None:
        """Full replace of the folder's defaults; None = unknown folder."""
        if self.get_folder(folder_id) is None:
            return None
        with self._connect() as conn:
            conn.execute(
                """UPDATE folders SET default_language = ?, default_profile_id = ?,
                   default_domain_ids = ?, default_llm_provider = ?,
                   default_llm_model = ?, default_llm_tier = ?, default_llm_auto = ?
                   WHERE id = ?""",
                (
                    defaults.default_language.value
                    if defaults.default_language
                    else None,
                    defaults.default_profile_id,
                    json.dumps(defaults.default_domain_ids)
                    if defaults.default_domain_ids is not None
                    else None,
                    defaults.default_llm_provider,
                    defaults.default_llm_model,
                    defaults.default_llm_tier,
                    None
                    if defaults.default_llm_auto is None
                    else int(defaults.default_llm_auto),
                    folder_id,
                ),
            )
        return self.get_folder(folder_id)
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `uv run pytest tests/test_folders.py -q`
Expected: PASS (all, including the pre-existing folder tests).

- [ ] **Step 5: Run the full backend suite**

Run (from `backend/`): `uv run pytest -q`
Expected: PASS, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/folders.py backend/tests/test_folders.py
git commit -m "feat: folder defaults columns, migration and set_defaults in FolderStore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Folders API — `PUT /api/folders/{id}/defaults` + read-time pruning in GET

**Files:**
- Modify: `backend/app/api/folders.py`
- Test: `backend/tests/test_folders_api.py`

**Interfaces:**
- Consumes: `FolderDefaults`, `FolderStore.set_defaults` from Task 1; `request.app.state.profile_store` (has `get_profile(profile_id) -> Profile | None`; `Profile.language` is a `Language`); `request.app.state.terminology_store` (has `list_domains() -> list[Domain]`, `Domain.id: int`).
- Produces: `PUT /api/folders/{folder_id}/defaults` accepting the seven nullable fields, returning the updated `Folder`; `GET /api/folders` returning folders with dead `default_profile_id` / dead domain ids pruned (read-time only).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_folders_api.py` (add `from pathlib import Path` is already imported; also add `from app.services.folders import FolderStore` at the top):

```python
def make_profile(client: TestClient, language: str = "en", name: str = "P") -> dict:
    response = client.post(
        "/api/profiles", json={"language": language, "name": name}
    )
    assert response.status_code == 201
    return response.json()


def make_domain(client: TestClient, name: str = "Med") -> dict:
    response = client.post("/api/domains", json={"name": name})
    assert response.status_code == 201
    return response.json()


def test_defaults_roundtrip_and_full_replace(client):
    folder = make_folder(client)
    profile = make_profile(client, "en", "Blogging")
    domain = make_domain(client)
    full = {
        "default_language": "en",
        "default_profile_id": profile["id"],
        "default_domain_ids": [domain["id"]],
        "default_llm_provider": None,
        "default_llm_model": None,
        "default_llm_tier": "cheap",
        "default_llm_auto": False,
    }
    put = client.put(f"/api/folders/{folder['id']}/defaults", json=full)
    assert put.status_code == 200
    assert put.json()["default_profile_id"] == profile["id"]
    assert put.json()["default_llm_auto"] is False
    # GET serves the defaults on the folder objects.
    listed = client.get("/api/folders").json()[0]
    assert listed["default_language"] == "en"
    assert listed["default_domain_ids"] == [domain["id"]]
    # Full replace: an omitted field is cleared, not kept.
    put2 = client.put(
        f"/api/folders/{folder['id']}/defaults",
        json={"default_language": "en"},
    )
    assert put2.status_code == 200
    assert put2.json()["default_profile_id"] is None
    assert put2.json()["default_llm_tier"] is None


def test_defaults_validation_matrix(client):
    folder = make_folder(client)
    profile_en = make_profile(client, "en", "English only")
    url = f"/api/folders/{folder['id']}/defaults"
    # Profile default without a language default.
    assert (
        client.put(url, json={"default_profile_id": profile_en["id"]}).status_code
        == 422
    )
    # Unknown profile.
    assert (
        client.put(
            url, json={"default_language": "en", "default_profile_id": 99999}
        ).status_code
        == 422
    )
    # Profile of a different language than the language default.
    assert (
        client.put(
            url,
            json={"default_language": "de", "default_profile_id": profile_en["id"]},
        ).status_code
        == 422
    )
    # Unknown domain id.
    assert (
        client.put(url, json={"default_domain_ids": [99999]}).status_code == 422
    )
    # Invalid tier value (pydantic Literal).
    assert client.put(url, json={"default_llm_tier": "turbo"}).status_code == 422
    # Unknown folder.
    assert (
        client.put("/api/folders/9999/defaults", json={}).status_code == 404
    )
    # Empty body is a valid "clear all defaults".
    ok = client.put(url, json={})
    assert ok.status_code == 200
    assert ok.json()["default_language"] is None


def test_defaults_pruning_is_read_time_only(tmp_path: Path):
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    folder = make_folder(client)
    profile = make_profile(client, "de", "Kurzlebig")
    d1 = make_domain(client, "Keep")
    d2 = make_domain(client, "Drop")
    client.put(
        f"/api/folders/{folder['id']}/defaults",
        json={
            "default_language": "de",
            "default_profile_id": profile["id"],
            "default_domain_ids": [d1["id"], d2["id"]],
        },
    )
    assert client.delete(f"/api/profiles/{profile['id']}").status_code == 204
    assert client.delete(f"/api/domains/{d2['id']}").status_code == 204
    listed = client.get("/api/folders").json()[0]
    # Dead references pruned from the response; the language stays.
    assert listed["default_profile_id"] is None
    assert listed["default_language"] == "de"
    assert listed["default_domain_ids"] == [d1["id"]]
    # The DB row itself is untouched (read-time view, like documents GET).
    raw = FolderStore(settings.db_path).get_folder(folder["id"])
    assert raw.default_profile_id == profile["id"]
    assert raw.default_domain_ids == [d1["id"], d2["id"]]
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `uv run pytest tests/test_folders_api.py -q`
Expected: FAIL — the roundtrip test gets 404/405 from the missing `/defaults` route.

- [ ] **Step 3: Implement**

In `backend/app/api/folders.py`, extend the imports:

```python
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from app.core.models import Language
from app.services.folders import Folder, FolderDefaults, FolderStore
```

Add the payload model below `FolderPayload`:

```python
class FolderDefaultsPayload(BaseModel):
    """Complete new defaults state — a full replace, not a merge."""

    default_language: Language | None = None
    default_profile_id: int | None = None
    default_domain_ids: list[int] | None = None
    default_llm_provider: str | None = None
    default_llm_model: str | None = None
    default_llm_tier: Literal["quality", "balanced", "cheap", "local"] | None = None
    default_llm_auto: bool | None = None
```

Add a pruning helper and replace `list_folders`:

```python
def _pruned(request: Request, folder: Folder) -> Folder:
    """Read-time view without dead references (the row keeps its raw values,
    exactly like the documents GET prunes deleted profiles)."""
    update: dict[str, object] = {}
    if folder.default_profile_id is not None:
        profile_store = request.app.state.profile_store
        if profile_store.get_profile(folder.default_profile_id) is None:
            update["default_profile_id"] = None
    if folder.default_domain_ids:
        known = {d.id for d in request.app.state.terminology_store.list_domains()}
        kept = [i for i in folder.default_domain_ids if i in known]
        if len(kept) != len(folder.default_domain_ids):
            update["default_domain_ids"] = kept
    return folder.model_copy(update=update) if update else folder


@router.get("/folders")
def list_folders(request: Request) -> list[Folder]:
    return [_pruned(request, f) for f in _store(request).list_folders()]
```

Add the defaults endpoint after `rename_folder`:

```python
@router.put("/folders/{folder_id}/defaults")
def set_folder_defaults(
    request: Request, folder_id: int, body: FolderDefaultsPayload
) -> Folder:
    if body.default_profile_id is not None:
        if body.default_language is None:
            raise HTTPException(
                422, "A profile default requires a language default"
            )
        profile = request.app.state.profile_store.get_profile(
            body.default_profile_id
        )
        if profile is None:
            raise HTTPException(422, "Unknown profile")
        if profile.language != body.default_language:
            raise HTTPException(
                422, "The profile belongs to a different language"
            )
    if body.default_domain_ids:
        known = {d.id for d in request.app.state.terminology_store.list_domains()}
        unknown = [i for i in body.default_domain_ids if i not in known]
        if unknown:
            raise HTTPException(422, f"Unknown domain ids: {unknown}")
    updated = _store(request).set_defaults(
        folder_id, FolderDefaults(**body.model_dump())
    )
    if updated is None:
        raise HTTPException(404, "Folder not found")
    return updated
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `uv run pytest tests/test_folders_api.py -q`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run (from `backend/`): `uv run pytest -q`
Expected: PASS, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/folders.py backend/tests/test_folders_api.py
git commit -m "feat: PUT /api/folders/{id}/defaults with validation and read-time pruning

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — client types, `applyFolderDefaults` overlay, `saveFolderDefaults`

**Files:**
- Modify: `frontend/src/api/client.ts` (the `Folder` interface around line 294 and the folder API calls below it)
- Modify: `frontend/src/documents/documents.ts` (`createNewDocument` around line 316; new exports)
- Modify: `frontend/src/documents/documents.test.ts` (extend the `vi.mock('../api/client', …)` factory with `putFolderDefaults: vi.fn()`; new describe blocks)
- Modify: `frontend/src/documents/DocumentSidebar.test.tsx` (the `groupDocuments` folder literals gain a cast)

**Interfaces:**
- Consumes: existing `DocumentCreatePayload`, `currentSettings()`, `createNewDocument(folderId?)`, store fields `language/profileId/domainIds/provider/model/tier/llmAuto`, `setFolders`.
- Produces: `FolderDefaults` TS interface and `Folder extends FolderDefaults` in `client.ts`; `putFolderDefaults(id: number, defaults: FolderDefaults): Promise<Folder>`; `applyFolderDefaults(payload: DocumentCreatePayload, folder: Folder | undefined): DocumentCreatePayload` (pure, exported from `documents.ts`); `saveFolderDefaults(id: number, defaults: FolderDefaults): Promise<void>` (rethrows errors; Task 4's dialog catches them).

- [ ] **Step 1: Update client types and API call**

In `frontend/src/api/client.ts`, replace the `Folder` interface with:

```typescript
export interface FolderDefaults {
  default_language: Language | null
  default_profile_id: number | null
  default_domain_ids: number[] | null
  default_llm_provider: string | null
  default_llm_model: string | null
  default_llm_tier: Tier | null
  default_llm_auto: boolean | null
}

export interface Folder extends FolderDefaults {
  id: number
  name: string
  created_at: string
}
```

and add below `deleteFolder`:

```typescript
export const putFolderDefaults = (id: number, defaults: FolderDefaults) =>
  request<Folder>(`/api/folders/${id}/defaults`, {
    method: 'PUT',
    body: JSON.stringify(defaults),
  })
```

(`Language` and `Tier` are already imported in `client.ts`; verify and extend the import from `../types` if not.)

In `frontend/src/documents/DocumentSidebar.test.tsx`, the `groupDocuments` describe's folder literals no longer satisfy `Folder`; give them the same escape hatch the doc literals already use:

```typescript
  const folders = [
    { id: 1, name: 'Blog', created_at: '' },
    { id: 2, name: 'Work', created_at: '' },
  ] as never[]
```

(both usages `groupDocuments(docs, folders)` and `groupDocuments([], folders)` keep working).

- [ ] **Step 2: Write the failing tests for the overlay**

Append to `frontend/src/documents/documents.test.ts`. First extend the existing `vi.mock('../api/client', …)` factory with one line `putFolderDefaults: vi.fn(),` and the mocked-import list with `putFolderDefaults`. Then add (import `applyFolderDefaults` and `saveFolderDefaults` from `./documents`, and `type DocumentCreatePayload`, `type Folder` from `../api/client`):

```typescript
function folderWith(overrides: Partial<Folder>): Folder {
  return {
    id: 1,
    name: 'F',
    created_at: '',
    default_language: null,
    default_profile_id: null,
    default_domain_ids: null,
    default_llm_provider: null,
    default_llm_model: null,
    default_llm_tier: null,
    default_llm_auto: null,
    ...overrides,
  }
}

function basePayload(): DocumentCreatePayload {
  return {
    name: 'Untitled',
    language: 'en',
    profile_id: 7,
    domain_ids: [1, 2],
    llm_provider: null,
    llm_model: null,
    llm_tier: 'balanced',
    llm_auto: true,
  }
}

describe('applyFolderDefaults', () => {
  it('no folder or no defaults: payload unchanged', () => {
    expect(applyFolderDefaults(basePayload(), undefined)).toEqual(basePayload())
    expect(applyFolderDefaults(basePayload(), folderWith({}))).toEqual(
      basePayload(),
    )
  })

  it('overrides exactly the set fields', () => {
    const folder = folderWith({
      default_language: 'en',
      default_profile_id: 42,
      default_llm_auto: false,
    })
    const out = applyFolderDefaults(basePayload(), folder)
    expect(out.language).toBe('en')
    expect(out.profile_id).toBe(42)
    expect(out.llm_auto).toBe(false)
    // Unset defaults leave the header values alone.
    expect(out.domain_ids).toEqual([1, 2])
    expect(out.llm_tier).toBe('balanced')
  })

  it('a language default without a profile default clears a cross-language header profile', () => {
    // Header is en with profile 7; the folder pins de but no profile. The en
    // profile must not leak onto a de document.
    const out = applyFolderDefaults(
      basePayload(),
      folderWith({ default_language: 'de' }),
    )
    expect(out.language).toBe('de')
    expect(out.profile_id).toBeNull()
  })

  it('a language default equal to the header language keeps the header profile', () => {
    const out = applyFolderDefaults(
      basePayload(),
      folderWith({ default_language: 'en' }),
    )
    expect(out.profile_id).toBe(7)
  })

  it('empty domains default overrides ([] is set, not unset)', () => {
    const out = applyFolderDefaults(
      basePayload(),
      folderWith({ default_domain_ids: [] }),
    )
    expect(out.domain_ids).toEqual([])
  })

  it('the LLM triple applies as one unit (tier default)', () => {
    const header: DocumentCreatePayload = {
      ...basePayload(),
      llm_provider: 'ollama',
      llm_model: 'llama3',
      llm_tier: null,
    }
    const out = applyFolderDefaults(
      header,
      folderWith({ default_llm_tier: 'cheap' }),
    )
    expect(out.llm_tier).toBe('cheap')
    expect(out.llm_provider).toBeNull()
    expect(out.llm_model).toBeNull()
  })

  it('the LLM triple applies as one unit (pinned default)', () => {
    const out = applyFolderDefaults(
      basePayload(),
      folderWith({
        default_llm_provider: 'openai',
        default_llm_model: 'gpt-4o',
        default_llm_tier: null,
      }),
    )
    expect(out.llm_provider).toBe('openai')
    expect(out.llm_model).toBe('gpt-4o')
    expect(out.llm_tier).toBeNull()
  })
})

describe('saveFolderDefaults', () => {
  it('updates the folder in place in the store', async () => {
    const before = folderWith({ id: 5, name: 'Blog' })
    const other = folderWith({ id: 6, name: 'Work' })
    useStore.setState({ folders: [before, other] })
    const after = folderWith({ id: 5, name: 'Blog', default_language: 'de' })
    vi.mocked(putFolderDefaults).mockResolvedValue(after)
    await saveFolderDefaults(5, after)
    expect(useStore.getState().folders).toEqual([after, other])
  })

  it('rethrows failures without touching the store', async () => {
    const folder = folderWith({ id: 5 })
    useStore.setState({ folders: [folder] })
    vi.mocked(putFolderDefaults).mockRejectedValue(new HttpError(404, 'gone'))
    await expect(saveFolderDefaults(5, folder)).rejects.toThrow()
    expect(useStore.getState().folders).toEqual([folder])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/documents/documents.test.ts`
Expected: FAIL — `applyFolderDefaults` / `saveFolderDefaults` not exported.

- [ ] **Step 4: Implement in `documents.ts`**

Extend the client import at the top of `frontend/src/documents/documents.ts` with `putFolderDefaults` and `type DocumentCreatePayload, type FolderDefaults`.

Add after `sortedByName` (near the other folder functions):

```typescript
/** Overlay a folder's set defaults on a document-create payload. Unset
 * (null) defaults leave the header-derived values alone. Creation-time
 * only: moves never touch settings. */
export function applyFolderDefaults(
  payload: DocumentCreatePayload,
  folder: Folder | undefined,
): DocumentCreatePayload {
  if (!folder) return payload
  const out = { ...payload }
  if (folder.default_language !== null) {
    if (
      folder.default_language !== payload.language &&
      folder.default_profile_id === null
    ) {
      // The header profile belongs to the header language; it must not
      // leak onto a document created in a different default language.
      out.profile_id = null
    }
    out.language = folder.default_language
  }
  if (folder.default_profile_id !== null)
    out.profile_id = folder.default_profile_id
  if (folder.default_domain_ids !== null)
    out.domain_ids = folder.default_domain_ids
  const llmSet =
    folder.default_llm_provider !== null ||
    folder.default_llm_model !== null ||
    folder.default_llm_tier !== null
  if (llmSet) {
    // One composite unit, mirroring the header selector's pin-vs-tier model.
    out.llm_provider = folder.default_llm_provider
    out.llm_model = folder.default_llm_model
    out.llm_tier = folder.default_llm_tier
  }
  if (folder.default_llm_auto !== null) out.llm_auto = folder.default_llm_auto
  return out
}

/** Persist a folder's defaults (full replace) and update it in place.
 * Errors are rethrown: the defaults dialog shows them inline. */
export async function saveFolderDefaults(
  id: number,
  defaults: FolderDefaults,
): Promise<void> {
  const updated = await putFolderDefaults(id, defaults)
  const store = useStore.getState()
  store.setFolders(store.folders.map((f) => (f.id === id ? updated : f)))
}
```

Replace `createNewDocument` with:

```typescript
export async function createNewDocument(folderId?: number): Promise<void> {
  await flush()
  const state = useStore.getState()
  const base: DocumentCreatePayload = {
    name: currentMessages().docUntitled,
    language: state.language,
    ...currentSettings(),
    ...(folderId !== undefined ? { folder_id: folderId } : {}),
  }
  const folder =
    folderId !== undefined
      ? state.folders.find((f) => f.id === folderId)
      : undefined
  const doc = await apiCreateDocument(applyFolderDefaults(base, folder))
  useStore.getState().setDocuments([summaryOf(doc), ...state.documents])
  await hydrateFromDocument(doc)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `frontend/`): `npx vitest run src/documents/`
Expected: PASS (including the pre-existing documents/sidebar tests).

- [ ] **Step 6: Run the frontend gates**

Run (from `frontend/`): `npx vitest run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all PASS, zero lint warnings (build's >500kB chunk advisory is pre-existing).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/documents/documents.ts frontend/src/documents/documents.test.ts frontend/src/documents/DocumentSidebar.test.tsx
git commit -m "feat: apply folder defaults when creating documents in a folder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: FolderDefaultsDialog + ⋯-menu entry + CSS + i18n

**Files:**
- Create: `frontend/src/documents/FolderDefaultsDialog.tsx`
- Test: `frontend/src/documents/FolderDefaultsDialog.test.ts` (pure helpers only, matching the codebase's no-component-test convention)
- Modify: `frontend/src/documents/DocumentSidebar.tsx` (FolderGroup menu + dialog mount)
- Modify: `frontend/src/App.css` (dialog styles at the end of the file)
- Modify: `frontend/src/i18n/messages.ts` + all seven catalogs `frontend/src/i18n/{en,de,fr,es,it,ja,zh}.ts`

**Interfaces:**
- Consumes: `saveFolderDefaults` (Task 3), `getProfiles(language)` from `../api/client`, store fields `languages/domains` and header state, `languageLabel(info, m)` from `../languages`, `TIERS`/`Tier` from `../types`, existing message functions `m.tierName(tier)` and `m.tierPinnedOption(model)`.
- Produces: `FolderDefaultsDialog({ folder, onClose })` component; pure exported helpers `withLanguageDefault(draft, language)` and `defaultsFromHeader(state)`. Stable e2e class names: `.folder-defaults-dialog`, `.fd-language`, `.fd-profile`, `.fd-domains-set`, `.fd-domain-list`, `.fd-llm`, `.fd-auto`, `.fd-take-current`, `.fd-save`, `.fd-cancel`, `.fd-error`.

- [ ] **Step 1: Add the i18n keys**

`frontend/src/i18n/messages.ts` — append to the `Messages` interface after `folderMenu: string`:

```typescript
  folderDefaults: string
  folderDefaultsNone: string
  folderDefaultsTakeCurrent: string
  folderDefaultsAuto: string
  folderDefaultsAutoOn: string
  folderDefaultsAutoOff: string
  folderDefaultsSave: string
  folderDefaultsCancel: string
  folderDefaultsError: string
```

Catalog entries (append after each catalog's `folderMenu` line):

`en.ts`:
```typescript
  folderDefaults: 'Folder defaults',
  folderDefaultsNone: '— no default —',
  folderDefaultsTakeCurrent: 'Take from current document',
  folderDefaultsAuto: 'Auto-check',
  folderDefaultsAutoOn: 'On',
  folderDefaultsAutoOff: 'Off',
  folderDefaultsSave: 'Save',
  folderDefaultsCancel: 'Cancel',
  folderDefaultsError: 'Saving folder defaults failed.',
```

`de.ts`:
```typescript
  folderDefaults: 'Ordner-Standardwerte',
  folderDefaultsNone: '— kein Standard —',
  folderDefaultsTakeCurrent: 'Vom aktuellen Dokument übernehmen',
  folderDefaultsAuto: 'Auto-Prüfung',
  folderDefaultsAutoOn: 'An',
  folderDefaultsAutoOff: 'Aus',
  folderDefaultsSave: 'Speichern',
  folderDefaultsCancel: 'Abbrechen',
  folderDefaultsError: 'Speichern der Ordner-Standardwerte fehlgeschlagen.',
```

`fr.ts`:
```typescript
  folderDefaults: 'Valeurs par défaut du dossier',
  folderDefaultsNone: '— aucun défaut —',
  folderDefaultsTakeCurrent: 'Reprendre du document actuel',
  folderDefaultsAuto: 'Vérification auto',
  folderDefaultsAutoOn: 'Activée',
  folderDefaultsAutoOff: 'Désactivée',
  folderDefaultsSave: 'Enregistrer',
  folderDefaultsCancel: 'Annuler',
  folderDefaultsError: "Échec de l'enregistrement des valeurs par défaut du dossier.",
```

`es.ts`:
```typescript
  folderDefaults: 'Valores predeterminados de la carpeta',
  folderDefaultsNone: '— sin valor predeterminado —',
  folderDefaultsTakeCurrent: 'Tomar del documento actual',
  folderDefaultsAuto: 'Comprobación automática',
  folderDefaultsAutoOn: 'Activada',
  folderDefaultsAutoOff: 'Desactivada',
  folderDefaultsSave: 'Guardar',
  folderDefaultsCancel: 'Cancelar',
  folderDefaultsError: 'No se pudieron guardar los valores predeterminados de la carpeta.',
```

`it.ts`:
```typescript
  folderDefaults: 'Impostazioni predefinite della cartella',
  folderDefaultsNone: '— nessun valore predefinito —',
  folderDefaultsTakeCurrent: 'Prendi dal documento corrente',
  folderDefaultsAuto: 'Controllo automatico',
  folderDefaultsAutoOn: 'Attivo',
  folderDefaultsAutoOff: 'Disattivo',
  folderDefaultsSave: 'Salva',
  folderDefaultsCancel: 'Annulla',
  folderDefaultsError: 'Salvataggio delle impostazioni predefinite della cartella non riuscito.',
```

`ja.ts`:
```typescript
  folderDefaults: 'フォルダーの既定値',
  folderDefaultsNone: '— 既定値なし —',
  folderDefaultsTakeCurrent: '現在のドキュメントから取得',
  folderDefaultsAuto: '自動チェック',
  folderDefaultsAutoOn: 'オン',
  folderDefaultsAutoOff: 'オフ',
  folderDefaultsSave: '保存',
  folderDefaultsCancel: 'キャンセル',
  folderDefaultsError: 'フォルダーの既定値の保存に失敗しました。',
```

`zh.ts`:
```typescript
  folderDefaults: '文件夹默认设置',
  folderDefaultsNone: '— 无默认值 —',
  folderDefaultsTakeCurrent: '从当前文档获取',
  folderDefaultsAuto: '自动检查',
  folderDefaultsAutoOn: '开',
  folderDefaultsAutoOff: '关',
  folderDefaultsSave: '保存',
  folderDefaultsCancel: '取消',
  folderDefaultsError: '保存文件夹默认设置失败。',
```

Run (from `frontend/`): `npx vitest run src/i18n` — the parity test must PASS.

- [ ] **Step 2: Write the failing tests for the pure helpers**

Create `frontend/src/documents/FolderDefaultsDialog.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { FolderDefaults } from '../api/client'
import { defaultsFromHeader, withLanguageDefault } from './FolderDefaultsDialog'

const empty: FolderDefaults = {
  default_language: null,
  default_profile_id: null,
  default_domain_ids: null,
  default_llm_provider: null,
  default_llm_model: null,
  default_llm_tier: null,
  default_llm_auto: null,
}

describe('withLanguageDefault', () => {
  it('changing the language drops the profile default', () => {
    const draft = { ...empty, default_language: 'en', default_profile_id: 3 } as FolderDefaults
    expect(withLanguageDefault(draft, 'de').default_profile_id).toBeNull()
    expect(withLanguageDefault(draft, 'de').default_language).toBe('de')
  })

  it('clearing the language drops the profile default', () => {
    const draft = { ...empty, default_language: 'en', default_profile_id: 3 } as FolderDefaults
    expect(withLanguageDefault(draft, null).default_profile_id).toBeNull()
    expect(withLanguageDefault(draft, null).default_language).toBeNull()
  })

  it('re-selecting the same language keeps the profile default', () => {
    const draft = { ...empty, default_language: 'en', default_profile_id: 3 } as FolderDefaults
    expect(withLanguageDefault(draft, 'en').default_profile_id).toBe(3)
  })
})

describe('defaultsFromHeader', () => {
  it('tier mode: tier set, pin fields null', () => {
    const d = defaultsFromHeader({
      language: 'de',
      profileId: 9,
      domainIds: [4],
      provider: 'ollama',
      model: 'llama3',
      tier: 'cheap',
      llmAuto: false,
    })
    expect(d).toEqual({
      default_language: 'de',
      default_profile_id: 9,
      default_domain_ids: [4],
      default_llm_provider: null,
      default_llm_model: null,
      default_llm_tier: 'cheap',
      default_llm_auto: false,
    })
  })

  it('pinned mode: provider/model set, tier null', () => {
    const d = defaultsFromHeader({
      language: 'en',
      profileId: null,
      domainIds: [],
      provider: 'openai',
      model: 'gpt-4o',
      tier: null,
      llmAuto: true,
    })
    expect(d.default_llm_provider).toBe('openai')
    expect(d.default_llm_model).toBe('gpt-4o')
    expect(d.default_llm_tier).toBeNull()
    expect(d.default_domain_ids).toEqual([])
  })
})
```

Run (from `frontend/`): `npx vitest run src/documents/FolderDefaultsDialog.test.ts`
Expected: FAIL — module `./FolderDefaultsDialog` does not exist.

- [ ] **Step 3: Create the dialog component**

Create `frontend/src/documents/FolderDefaultsDialog.tsx`:

```tsx
import { useEffect, useState } from 'react'
import {
  getProfiles,
  type Folder,
  type FolderDefaults,
} from '../api/client'
import { useMessages } from '../i18n'
import { languageLabel } from '../languages'
import { useStore } from '../state/store'
import { TIERS, type Language, type Profile, type Tier } from '../types'
import { saveFolderDefaults } from './documents'

/** New draft with the language default changed; a language change always
 * drops the profile default (profiles are per-language). */
// oxlint-disable-next-line react/only-export-components -- pure helper, unit-tested in isolation
export function withLanguageDefault(
  draft: FolderDefaults,
  language: Language | null,
): FolderDefaults {
  return {
    ...draft,
    default_language: language,
    default_profile_id:
      draft.default_language === language ? draft.default_profile_id : null,
  }
}

/** Snapshot of the header selection as folder defaults ("take from current"). */
// oxlint-disable-next-line react/only-export-components -- pure helper, unit-tested in isolation
export function defaultsFromHeader(s: {
  language: Language
  profileId: number | null
  domainIds: number[]
  provider: string
  model: string | null
  tier: Tier | null
  llmAuto: boolean
}): FolderDefaults {
  return {
    default_language: s.language,
    default_profile_id: s.profileId,
    default_domain_ids: [...s.domainIds],
    default_llm_provider: s.tier === null ? s.provider : null,
    default_llm_model: s.tier === null ? s.model : null,
    default_llm_tier: s.tier,
    default_llm_auto: s.llmAuto,
  }
}

function defaultsOf(folder: Folder): FolderDefaults {
  return {
    default_language: folder.default_language,
    default_profile_id: folder.default_profile_id,
    default_domain_ids: folder.default_domain_ids,
    default_llm_provider: folder.default_llm_provider,
    default_llm_model: folder.default_llm_model,
    default_llm_tier: folder.default_llm_tier,
    default_llm_auto: folder.default_llm_auto,
  }
}

export function FolderDefaultsDialog({
  folder,
  onClose,
}: {
  folder: Folder
  onClose: () => void
}) {
  const m = useMessages()
  const languages = useStore((s) => s.languages)
  const domains = useStore((s) => s.domains)
  const [draft, setDraft] = useState<FolderDefaults>(() => defaultsOf(folder))
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)

  const lang = draft.default_language
  useEffect(() => {
    if (lang === null) {
      setProfiles([])
      return
    }
    let cancelled = false
    getProfiles(lang)
      .then((list) => {
        if (!cancelled) setProfiles(list)
      })
      .catch(() => {
        if (!cancelled) setProfiles([])
      })
    return () => {
      cancelled = true
    }
  }, [lang])

  // Pins enter the draft only via "take from current" (mirroring the header
  // selector, where pinning lives in the Advanced panel).
  const pinned =
    draft.default_llm_tier === null && draft.default_llm_provider !== null
  const llmValue = pinned ? 'pinned' : (draft.default_llm_tier ?? 'none')
  const domainIds = draft.default_domain_ids

  const toggleDomain = (id: number) => {
    const current = domainIds ?? []
    setDraft({
      ...draft,
      default_domain_ids: current.includes(id)
        ? current.filter((d) => d !== id)
        : [...current, id],
    })
  }

  const save = async () => {
    setSaving(true)
    setError(false)
    try {
      await saveFolderDefaults(folder.id, draft)
      onClose()
    } catch {
      setError(true)
      setSaving(false)
    }
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="folder-defaults-dialog">
        <h2>
          {m.folderDefaults}: {folder.name}
        </h2>
        <label>
          {m.language}
          <select
            className="fd-language"
            value={lang ?? 'none'}
            onChange={(e) =>
              setDraft(
                withLanguageDefault(
                  draft,
                  e.target.value === 'none'
                    ? null
                    : (e.target.value as Language),
                ),
              )
            }
          >
            <option value="none">{m.folderDefaultsNone}</option>
            {languages.map((info) => (
              <option key={info.code} value={info.code}>
                {languageLabel(info, m)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.profile}
          <select
            className="fd-profile"
            disabled={lang === null}
            value={draft.default_profile_id ?? 'none'}
            onChange={(e) =>
              setDraft({
                ...draft,
                default_profile_id:
                  e.target.value === 'none' ? null : Number(e.target.value),
              })
            }
          >
            <option value="none">{m.folderDefaultsNone}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="fd-domains-toggle">
          <input
            type="checkbox"
            className="fd-domains-set"
            checked={domainIds !== null}
            onChange={(e) =>
              setDraft({
                ...draft,
                default_domain_ids: e.target.checked ? [] : null,
              })
            }
          />
          {m.domain}
        </label>
        {domainIds !== null && (
          <div className="fd-domain-list">
            {domains.map((domain) => (
              <label key={domain.id}>
                <input
                  type="checkbox"
                  checked={domainIds.includes(domain.id)}
                  onChange={() => toggleDomain(domain.id)}
                />
                {domain.name}
              </label>
            ))}
            {domains.length === 0 && <span className="dim">{m.domainNone}</span>}
          </div>
        )}
        <label>
          {m.llm}
          <select
            className="fd-llm"
            value={llmValue}
            onChange={(e) => {
              const value = e.target.value
              if (value === 'pinned') return
              setDraft({
                ...draft,
                default_llm_provider: null,
                default_llm_model: null,
                default_llm_tier: value === 'none' ? null : (value as Tier),
              })
            }}
          >
            <option value="none">{m.folderDefaultsNone}</option>
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {m.tierName(tier)}
              </option>
            ))}
            {pinned && (
              <option value="pinned">
                {m.tierPinnedOption(
                  draft.default_llm_model ?? draft.default_llm_provider ?? '',
                )}
              </option>
            )}
          </select>
        </label>
        <label>
          {m.folderDefaultsAuto}
          <select
            className="fd-auto"
            value={
              draft.default_llm_auto === null
                ? 'none'
                : draft.default_llm_auto
                  ? 'on'
                  : 'off'
            }
            onChange={(e) =>
              setDraft({
                ...draft,
                default_llm_auto:
                  e.target.value === 'none' ? null : e.target.value === 'on',
              })
            }
          >
            <option value="none">{m.folderDefaultsNone}</option>
            <option value="on">{m.folderDefaultsAutoOn}</option>
            <option value="off">{m.folderDefaultsAutoOff}</option>
          </select>
        </label>
        {error && <p className="fd-error">{m.folderDefaultsError}</p>}
        <div className="fd-buttons">
          <button
            className="fd-take-current"
            onClick={() => setDraft(defaultsFromHeader(useStore.getState()))}
          >
            {m.folderDefaultsTakeCurrent}
          </button>
          <span className="fd-spacer" />
          <button className="fd-cancel" onClick={onClose}>
            {m.folderDefaultsCancel}
          </button>
          <button
            className="fd-save"
            disabled={saving}
            onClick={() => void save()}
          >
            {m.folderDefaultsSave}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run (from `frontend/`): `npx vitest run src/documents/FolderDefaultsDialog.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the menu entry and mount**

In `frontend/src/documents/DocumentSidebar.tsx`:

- Add the import: `import { FolderDefaultsDialog } from './FolderDefaultsDialog'`
- In `FolderGroup`, add state next to `renaming`: `const [defaultsOpen, setDefaultsOpen] = useState(false)`
- In the folder ⋯ menu, insert between the "New document here" button and the "Rename" button:

```tsx
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setDefaultsOpen(true)
                }}
              >
                {m.folderDefaults}
              </button>
```

- At the end of the `.folder-group` div (after the `{!collapsed && (…)}` block, before the closing `</div>`):

```tsx
      {defaultsOpen && (
        <FolderDefaultsDialog
          folder={folder}
          onClose={() => setDefaultsOpen(false)}
        />
      )}
```

- [ ] **Step 6: Add the dialog CSS**

Append to `frontend/src/App.css`:

```css
/* Folder-defaults dialog */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.folder-defaults-dialog {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  width: 340px;
  max-height: 80vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.folder-defaults-dialog h2 {
  font-size: 0.95rem;
  margin: 0 0 0.25rem;
  color: var(--text);
}
.folder-defaults-dialog label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.8rem;
  color: var(--text-dim);
}
.folder-defaults-dialog select {
  font-size: 0.85rem;
}
.folder-defaults-dialog .fd-domains-toggle {
  flex-direction: row;
  align-items: center;
  gap: 0.35rem;
}
.fd-domain-list {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding-left: 1.2rem;
}
.folder-defaults-dialog .fd-domain-list label {
  flex-direction: row;
  align-items: center;
  gap: 0.35rem;
}
.fd-buttons {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
  align-items: center;
}
.fd-spacer {
  flex: 1;
}
.fd-error {
  color: #e5484d;
  font-size: 0.8rem;
  margin: 0;
}
```

- [ ] **Step 7: Run the frontend gates**

Run (from `frontend/`): `npx vitest run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all PASS, zero lint warnings.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/documents/FolderDefaultsDialog.tsx frontend/src/documents/FolderDefaultsDialog.test.ts frontend/src/documents/DocumentSidebar.tsx frontend/src/App.css frontend/src/i18n/
git commit -m "feat: folder-defaults dialog in the sidebar folder menu

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: E2E acceptance (scratch stack — never the live DB)

**Files:**
- Create (scratchpad, NOT committed): `SCRATCHPAD/task5-backend.py`, `SCRATCHPAD/task5-e2e.mjs` where `SCRATCHPAD` is the session scratchpad directory.

**Interfaces:**
- Consumes: the full feature from Tasks 1–4; the dialog's stable class names from Task 4.

**Proven scratch-stack recipe (follow exactly; deviations have burned hours before):**

1. Scratch backend on **127.0.0.1:8001** with a temp DB — `SCRATCHPAD/task5-backend.py`:

```python
import tempfile
from pathlib import Path

import uvicorn

from app.core.config import Settings
from app.main import create_app

tmp = Path(tempfile.mkdtemp(prefix="fabulous-e2e-"))
settings = Settings(db_path=tmp / "e2e.db", rules_dir=Path("rules"))
app = create_app(settings)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8001)
```

Launch (from `backend/`, background):
`PYTHONPATH=/Users/markus/IdeaProjects/fabulous-writing/backend uv run python SCRATCHPAD/task5-backend.py`
(`uv run python script.py` puts the *script's* directory on `sys.path`, not the cwd — the explicit `PYTHONPATH` is mandatory.)

2. Frontend build against the scratch backend (from `frontend/`):
`VITE_API_URL=http://127.0.0.1:8001 npm run build`
then **verify before serving**: `grep -rl "8001" dist/assets | head -1` must print a file. THEN:
`npx vite preview --port 4199 --strictPort` (background).

3. Drive `http://localhost:4199` (the preview binds IPv6; `localhost` resolves, `127.0.0.1` does not).

4. Playwright in `SCRATCHPAD/task5-e2e.mjs`: absolute import of `/Users/markus/IdeaProjects/fabulous-writing/frontend/node_modules/playwright-core/index.mjs`, launch chromium with the explicit `executablePath` found via `ls ~/Library/Caches/ms-playwright/ | grep chromium_headless_shell` (1223 is installed; the pinned 1228 is NOT). Class selectors only (UI locale varies); `page.on('dialog', d => d.accept())` for confirms.

- [ ] **Step 1: Write the e2e script**

`SCRATCHPAD/task5-e2e.mjs` — flow and assertions (settings assertions go through the scratch API, which is locale-proof):

```javascript
import { chromium } from '/Users/markus/IdeaProjects/fabulous-writing/frontend/node_modules/playwright-core/index.mjs'

const API = 'http://127.0.0.1:8001'
const APP = 'http://localhost:4199'
const EXEC = process.env.CHROMIUM_PATH // set from the ls lookup before running

const api = async (path, init) => {
  const res = await fetch(`${API}${path}`, init)
  if (!res.ok && res.status !== 404) throw new Error(`${path}: ${res.status}`)
  return res.status === 204 ? null : res.json()
}

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`)
  if (!cond) failures++
}

const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage()
page.on('dialog', (d) => void d.accept())
await page.goto(APP)
await page.waitForSelector('.doc-sidebar')

// 1. Create a folder via the ⊞ ghost icon (2nd toggle button in the head row).
await page.locator('.doc-sidebar-head .doc-sidebar-toggle').first().click()
await page.locator('.new-folder-input').fill('Projekt')
await page.keyboard.press('Enter')
await page.waitForSelector('.folder-group')

// 2. Open the folder menu → Folder defaults (2nd menu entry).
await page.locator('.folder-head').hover()
await page.locator('.folder-head .doc-menu-button').click()
await page.locator('.folder-head .doc-menu button').nth(1).click()
await page.waitForSelector('.folder-defaults-dialog')

// 3. Set language de + that language's standard profile, save.
await page.locator('.fd-language').selectOption('de')
await page.waitForFunction(
  () => document.querySelectorAll('.fd-profile option').length > 1,
)
const profileValue = await page
  .locator('.fd-profile option')
  .nth(1)
  .getAttribute('value')
await page.locator('.fd-profile').selectOption(profileValue)
await page.locator('.fd-save').click()
await page.waitForSelector('.folder-defaults-dialog', { state: 'detached' })

const [folder] = await api('/api/folders')
check('defaults persisted', folder.default_language === 'de')
check('profile default persisted', folder.default_profile_id !== null)

// 4. "New document here" (1st folder-menu entry) applies the defaults.
await page.locator('.folder-head').hover()
await page.locator('.folder-head .doc-menu-button').click()
await page.locator('.folder-head .doc-menu button').nth(0).click()
await page.waitForFunction(
  () => document.querySelectorAll('.folder-docs .doc-item').length === 1,
)
let docs = await api('/api/documents')
const inFolder = docs.find((d) => d.folder_id === folder.id)
const folderDoc = await api(`/api/documents/${inFolder.id}`)
check('folder doc got default language', folderDoc.language === 'de')
check(
  'folder doc got default profile',
  folderDoc.profile_id === folder.default_profile_id,
)

// 5. "+ New document" (ungrouped) keeps the header state. The header now
// shows de (the open folder doc); that IS the header state — assert the
// ungrouped doc matches the header, not the folder profile.
await page.locator('.doc-new').click()
await page.waitForFunction(
  (n) => document.querySelectorAll('.doc-item').length === n,
  3, // folder doc + ungrouped new doc + the initial startup doc
)
docs = await api('/api/documents')
const ungrouped = docs.filter((d) => d.folder_id === null)
check('ungrouped doc created', ungrouped.length === 2)

// 6. Read-time pruning: delete the profile, folders GET serves it pruned.
await api(`/api/profiles/${folder.default_profile_id}`, { method: 'DELETE' })
const [pruned] = await api('/api/folders')
check('dead profile pruned', pruned.default_profile_id === null)
check('language default survives pruning', pruned.default_language === 'de')

// 7. Reload: creating in the folder still works with the pruned defaults.
await page.reload()
await page.waitForSelector('.folder-group')
await page.locator('.folder-head').hover()
await page.locator('.folder-head .doc-menu-button').click()
await page.locator('.folder-head .doc-menu button').nth(0).click()
await page.waitForFunction(
  () => document.querySelectorAll('.folder-docs .doc-item').length === 2,
)
docs = await api('/api/documents')
const second = docs.filter((d) => d.folder_id === folder.id)
check('creation works after pruning', second.length === 2)
const secondFull = await api(
  `/api/documents/${second.map((d) => d.id).sort((a, b) => b - a)[0]}`,
)
check('pruned profile not applied', secondFull.profile_id === null)
check('language default still applied', secondFull.language === 'de')

await browser.close()
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
```

- [ ] **Step 2: Run the stack and the script**

In order: scratch backend (background, wait for `curl -s http://127.0.0.1:8001/api/health` to return ok) → `VITE_API_URL=… npm run build` → grep dist for 8001 → `npx vite preview --port 4199 --strictPort` (background) → `CHROMIUM_PATH=$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-mac/headless_shell | head -1) node SCRATCHPAD/task5-e2e.mjs`.

Expected: `ALL PASS`, exit 0.

- [ ] **Step 3: Tear down and rebuild the dist**

Kill ONLY the two background processes started here (stored PIDs — never the user's :5173/:8000 servers). Then rebuild the production dist without the scratch API URL (from `frontend/`): `npm run build`.

- [ ] **Step 4: Record the e2e result**

No commit (scratch files stay in the scratchpad). Report the assertion list and results to the orchestrator in the task report.

---

### Task 6: Architecture docs

**Files:**
- Modify: `docs/backend-architecture.md` (folders section)
- Modify: `docs/frontend-architecture.md` (documents/sidebar section)

- [ ] **Step 1: Update `docs/backend-architecture.md`**

In the folders/FolderStore section, document: the seven nullable defaults columns and the idempotent `_migrate`; `FolderDefaults` model and `Folder(FolderDefaults)` inheritance; `set_defaults` full-replace semantics; `PUT /api/folders/{id}/defaults` with the 422 matrix (profile⇒language, cross-language profile, unknown profile/domain) and 404; read-time pruning in `GET /api/folders` (row never modified). Match the file's existing tone and depth.

- [ ] **Step 2: Update `docs/frontend-architecture.md`**

In the documents section, document: `applyFolderDefaults` overlay in `createNewDocument` (creation-only; cross-language header-profile clearing; LLM triple as a unit; NULL vs `[]` domains), `saveFolderDefaults`, and `FolderDefaultsDialog` (⋯-menu entry, profile-requires-language coupling, "take from current", pins enter only via take-from-current). Match the file's existing tone and depth.

- [ ] **Step 3: Commit**

```bash
git add docs/backend-architecture.md docs/frontend-architecture.md
git commit -m "docs: architecture notes for per-folder defaults

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
