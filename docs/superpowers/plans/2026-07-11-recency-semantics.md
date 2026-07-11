# Recency Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The document sidebar orders by a new `edited_at` that only moves on real text changes or user renames — checks, settings changes, moves, and auto-titling stop reordering the list.

**Architecture:** Two new columns on `documents` (`edited_at`, nullable `checked_at`) with conditional bumps computed inside the existing optimistic `update_document`; ordering switches to `edited_at DESC, id DESC`. The frontend replaces the local-reorder `touchDocument` with `patchDocumentSummary`, which merges server-returned fields and re-sorts with the same comparator — no entry moves without a server-provided timestamp change.

**Tech Stack:** Python 3.13 / FastAPI / sqlite3 / pydantic (backend, uv-managed, run from `backend/`); React 19 / TypeScript / zustand / vitest (frontend, run from `frontend/`).

**Spec:** `docs/superpowers/specs/2026-07-11-recency-semantics-design.md`

## Global Constraints

- Live DB `backend/data/fabulous.db` NEVER touched by tests/e2e (tmp_path / scratch DB; scratch ports 8001/4199; never kill the user's dev servers :5173/:8000).
- Commits directly on `main`, messages ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; do not push (orchestrator pushes).
- `edited_at` bumps ONLY when: a PUT's `text` differs from the stored text, or a PUT's `name` differs from the stored name. `checked_at` bumps when a PUT carries `last_findings`/`scorecard` (or a create does). `set_name`/`set_folder` bump neither (only `updated_at`). `updated_at`/`revision` behavior unchanged everywhere.
- Migration seeds BOTH new columns from `updated_at`; reopen-idempotent; fresh DBs get the columns from `_SCHEMA`.
- Ordering: backend `ORDER BY edited_at DESC, id DESC`; frontend comparator identical (`edited_at` ISO strings compare lexicographically — backend always emits the same `+00:00` format).
- `DocumentSummary` (backend + frontend) gains `created_at: str`, `edited_at: str`, `checked_at: str | None`, keeping `updated_at`.
- The sidebar's relative time shows `edited_at`.
- Timestamps via existing `_utcnow()` (`isoformat(timespec="seconds")`).

---

### Task 1: Backend — columns, conditional bumps, ordering

**Files:**
- Modify: `backend/app/services/documents.py`
- Test: extend `backend/tests/test_documents.py`, extend `backend/tests/test_documents_api.py`

**Interfaces:**
- Consumes: existing `DocumentStore` internals (`_connect`, `_utcnow`, `_migrate`, `_row_to_document`).
- Produces (used by Task 2): `Document.edited_at: str`, `Document.checked_at: str | None`; `DocumentSummary.created_at: str`, `.edited_at: str`, `.checked_at: str | None` (plus existing fields); list ordering by `edited_at DESC, id DESC`. No API-layer code changes needed — routers return these models as-is.

- [ ] **Step 1: Write the failing store tests**

Append to `backend/tests/test_documents.py`:

```python
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
```

`time` is not imported yet in the file's newer sections — the file already imports `time` (check the top; if absent, add `import time`).

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `uv run pytest tests/test_documents.py -v -k "edited_at or checked_at or timestamp_migration or orders_by_edited"`
Expected: FAIL — `Document` has no field `edited_at`, etc.

- [ ] **Step 3: Implement in `backend/app/services/documents.py`**

1. `_SCHEMA`: after `folder_id INTEGER,` add:

```sql
    edited_at TEXT NOT NULL,
    checked_at TEXT,
```

(Place BEFORE `revision INTEGER ...` to keep the timestamp block together; column order is free — INSERTs name their columns.)

2. `Document` model: after `folder_id` add `edited_at: str` and `checked_at: str | None = None`. `DocumentSummary` becomes:

```python
class DocumentSummary(BaseModel):
    id: int
    name: str
    language: Language
    folder_id: int | None = None
    created_at: str
    edited_at: str
    checked_at: str | None = None
    updated_at: str
```

3. `_row_to_document`: add `edited_at=row["edited_at"], checked_at=row["checked_at"],`.

4. `_migrate`: append:

```python
        if "edited_at" not in columns:
            conn.execute("ALTER TABLE documents ADD COLUMN edited_at TEXT")
            conn.execute("UPDATE documents SET edited_at = updated_at")
        if "checked_at" not in columns:
            conn.execute("ALTER TABLE documents ADD COLUMN checked_at TEXT")
            conn.execute("UPDATE documents SET checked_at = updated_at")
```

5. `create_document`: add `edited_at` and `checked_at` to the INSERT columns and values:

```python
                    now,                    # edited_at = created_at
                    now if (last_findings or scorecard is not None) else None,
```

(with matching column names `edited_at, checked_at` in the column list; keep alignment).

6. `update_document`: after `merged = current.model_copy(update=fields)` and `now = _utcnow()`, compute the conditional bumps and carry them through SQL and the returned model:

```python
        text_changed = "text" in fields and fields["text"] != current.text
        name_changed = "name" in fields and fields["name"] != current.name
        edited_at = now if (text_changed or name_changed) else current.edited_at
        carries_check_state = "last_findings" in fields or "scorecard" in fields
        checked_at = now if carries_check_state else current.checked_at
```

Add `edited_at = ?, checked_at = ?` to the UPDATE's SET clause (before `revision = revision + 1`) with `edited_at, checked_at` inserted at the matching position in the params tuple, and extend the final return:

```python
        return merged.model_copy(
            update={
                "revision": base_revision + 1,
                "updated_at": now,
                "edited_at": edited_at,
                "checked_at": checked_at,
            }
        )
```

7. `list_documents`: SELECT becomes
`"SELECT id, name, language, folder_id, created_at, edited_at, checked_at, updated_at FROM documents ORDER BY edited_at DESC, id DESC"`
and the summary construction gains the three new fields.

8. `set_name` / `set_folder`: NO change (they only touch `updated_at` — the tests prove `edited_at` stays put).

- [ ] **Step 4: Write the failing API test and run everything**

Append to `backend/tests/test_documents_api.py`:

```python
def test_summaries_expose_timestamps_and_order_by_edited(client):
    import time

    a = make_doc(client, name="A")
    b = make_doc(client, name="B")
    time.sleep(1.1)  # second-precision timestamps: the edit must be later
    # A check-style save on B (same text, findings only)...
    client.put(
        f"/api/documents/{b['id']}",
        json={
            "revision": 0,
            "content": {"text": "", "findings": [{"finding": {}, "from": 0, "to": 0}], "scorecard": None},
        },
    )
    # ...then a real edit on A.
    client.put(
        f"/api/documents/{a['id']}",
        json={"revision": 0, "content": {"text": "real edit", "findings": [], "scorecard": None}},
    )
    listing = client.get("/api/documents").json()
    assert [d["id"] for d in listing] == [a["id"], b["id"]]
    first = listing[0]
    assert {"created_at", "edited_at", "checked_at", "updated_at"} <= set(first)
```

Run: `uv run pytest tests/test_documents.py tests/test_documents_api.py -v` then `uv run pytest -q`
Expected: all PASS, zero new warnings. (Note: the API test relies on same-second writes ordering by `id DESC` fallback only when `edited_at` ties — A's edit is the only real edit, so A leads regardless.)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/documents.py backend/tests/test_documents.py backend/tests/test_documents_api.py
git commit -m "feat: edited_at/checked_at split - checks no longer count as edits"
```

---

### Task 2: Frontend — patchDocumentSummary replaces touchDocument

**Files:**
- Modify: `frontend/src/api/client.ts` (types)
- Modify: `frontend/src/state/store.ts` (action swap)
- Modify: `frontend/src/documents/autosave.ts` (two call sites)
- Modify: `frontend/src/documents/documents.ts` (summaryOf + renameDocument)
- Modify: `frontend/src/documents/DocumentSidebar.tsx` (relativeTime source)
- Test: extend `frontend/src/state/store.test.ts`; fix fixtures across `frontend/src/state/store.test.ts`, `frontend/src/documents/documents.test.ts`, `frontend/src/documents/autosave.test.ts`, `frontend/src/documents/DocumentSidebar.test.tsx` (tsc enumerates every site)

**Interfaces:**
- Consumes: Task 1's response fields (`edited_at`, `checked_at` on documents; summaries with `created_at`/`edited_at`/`checked_at`).
- Produces: store action `patchDocumentSummary(id: number, patch: Partial<DocumentSummary>): void` — merges into the matching summary (unknown id = no-op) and re-sorts by `edited_at DESC, id DESC`. `touchDocument` is REMOVED.

- [ ] **Step 1: Write the failing store tests**

In `frontend/src/state/store.test.ts`, REPLACE the existing `touchDocument` test ("touchDocument moves the entry to the front and renames it") with:

```typescript
  it('patchDocumentSummary merges and re-sorts by edited_at', () => {
    useStore.getState().setDocuments([
      summary(2, 'Two', '2026-07-11T10:00:00+00:00'),
      summary(1, 'One', '2026-07-11T09:00:00+00:00'),
    ])
    // Patch without edited_at: name updates, order unchanged.
    useStore.getState().patchDocumentSummary(1, { name: 'Renamed' })
    let docs = useStore.getState().documents
    expect(docs.map((d) => d.id)).toEqual([2, 1])
    expect(docs[1].name).toBe('Renamed')
    // Bumped edited_at moves the entry to the front.
    useStore.getState().patchDocumentSummary(1, { edited_at: '2026-07-11T11:00:00+00:00' })
    docs = useStore.getState().documents
    expect(docs.map((d) => d.id)).toEqual([1, 2])
    // Unknown id is a no-op.
    useStore.getState().patchDocumentSummary(99, { name: 'X' })
    expect(useStore.getState().documents.map((d) => d.id)).toEqual([1, 2])
  })

  it('patchDocumentSummary breaks edited_at ties by id desc', () => {
    useStore.getState().setDocuments([
      summary(3, 'C', '2026-07-11T10:00:00+00:00'),
      summary(1, 'A', '2026-07-11T10:00:00+00:00'),
    ])
    useStore.getState().patchDocumentSummary(1, { edited_at: '2026-07-11T10:00:00+00:00' })
    expect(useStore.getState().documents.map((d) => d.id)).toEqual([3, 1])
  })
```

with a local helper in the test file (adapt to its existing fixture style):

```typescript
const summary = (id: number, name: string, edited_at: string) => ({
  id,
  name,
  language: 'en' as const,
  folder_id: null,
  created_at: '2026-07-11T08:00:00+00:00',
  edited_at,
  checked_at: null,
  updated_at: edited_at,
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/state/store.test.ts`
Expected: FAIL — `patchDocumentSummary` does not exist.

- [ ] **Step 3: Implement**

1. `frontend/src/api/client.ts` — `DocumentSummary` gains `created_at: string`, `edited_at: string`, `checked_at: string | null` (keep `updated_at`); `DocumentFull` gains `edited_at: string` and `checked_at: string | null` (after `revision`).

2. `frontend/src/state/store.ts` — remove `touchDocument` (interface, implementation); add:

```typescript
  patchDocumentSummary: (id: number, patch: Partial<DocumentSummary>) => void
```

```typescript
      // Merge server-returned fields into one summary and re-sort. Entries
      // only move when the server bumped edited_at — the client never fakes
      // recency locally.
      patchDocumentSummary: (id, patch) =>
        set((state) => {
          if (!state.documents.some((d) => d.id === id)) return {}
          const documents = state.documents
            .map((d) => (d.id === id ? { ...d, ...patch } : d))
            .sort(
              (a, b) =>
                b.edited_at.localeCompare(a.edited_at) || b.id - a.id,
            )
          return { documents }
        }),
```

3. `frontend/src/documents/autosave.ts`:
   - Push-success site (`store.touchDocument(snapshot.docId)`) becomes:

```typescript
      store.patchDocumentSummary(snapshot.docId, {
        edited_at: updated.edited_at,
        checked_at: updated.checked_at,
      })
```

   - `maybeGenerateTitle` site (`store.touchDocument(doc.id, doc.name)`) becomes `useStore.getState().patchDocumentSummary(doc.id, { name: doc.name })` (title changes never reorder).

4. `frontend/src/documents/documents.ts`:
   - `summaryOf` gains `created_at: doc.created_at, edited_at: doc.edited_at, checked_at: doc.checked_at,`.
   - `renameDocument`'s `store.touchDocument(id, updated.name)` becomes:

```typescript
  store.patchDocumentSummary(id, {
    name: updated.name,
    edited_at: updated.edited_at,
  })
```

   - `hydrateFromBuffer`'s synthetic `DocumentFull` gains `edited_at: snapshot ... ` — use `created_at: ''`-style placeholders consistent with the existing synthetic: `edited_at: ''`, `checked_at: null`.

5. `frontend/src/documents/DocumentSidebar.tsx` — the item time becomes `relativeTime(doc.edited_at, locale)`.

6. Fixtures: `npx tsc --noEmit` enumerates every DocumentSummary/DocumentFull literal missing the new fields (documents.test.ts `doc()` builder and summary literals, autosave.test.ts seed, DocumentSidebar.test.tsx groupDocuments docs which use `as never[]` — those may not need changes, check). Add `created_at`/`edited_at`/`checked_at` values; in tests that assert reorder-on-save behavior, give coherent edited_at values.

- [ ] **Step 4: Run all gates**

Run: `npx vitest run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all PASS, zero warnings. Pay attention to documents.test.ts's move test ("Order untouched — moves never reorder recency") — it must still pass since `moveDocumentToFolder` doesn't call `patchDocumentSummary` with `edited_at`... it calls `setDocuments(map(...))` directly, untouched by this task. Verify no test still references `touchDocument`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/state/store.ts frontend/src/documents frontend/src/state/store.test.ts
git commit -m "feat: sidebar orders by edited_at - saves without edits no longer reorder"
```

---

### Task 3: E2E acceptance + docs + logbook

**Files:**
- Modify: `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `docs/LOGBOOK.md` (run `date '+%Y-%m-%d'` first)
- Scratch only: e2e script + scratch DB under the session scratchpad

**Interfaces:** none produced; proves the acceptance case and records the change.

- [ ] **Step 1: E2E on a scratch stack**

Constraints and known gotchas (all proven in prior e2e runs): never touch `backend/data/fabulous.db`; never kill :5173/:8000 (kill only your own PIDs); scratch backend on 127.0.0.1:8001 launched with `PYTHONPATH=/Users/markus/IdeaProjects/fabulous-writing/backend` (the launcher script from earlier sessions is in the scratchpad as `task8-backend.py`); `VITE_API_URL=http://127.0.0.1:8001 npm run build`, grep dist assets for `8001` before `npx vite preview --port 4199 --strictPort`; drive `http://localhost:4199` (preview binds IPv6); Playwright via absolute import of `frontend/node_modules/playwright-core/index.mjs` with explicit `executablePath` from `~/Library/Caches/ms-playwright/`; class selectors only.

The acceptance flow (assert each step):
1. Create two documents A and B via the API (POST, distinct texts ≥ 5 words with a rule trigger like "very very"), B created second → list order [B, A].
2. Load the app → sidebar shows [B, A]. Open A (click its `.doc-open`).
3. Wait ~4 s (auto fast check ~1 s after hydration + autosave debounce 1.5 s + margin), then poll the API: A's `revision` may have increased (check-save) but its `edited_at` must be UNCHANGED and `GET /api/documents` order must still be [B, A]. Reload the page → sidebar still [B, A]. **This is the bug being fixed — assert hard.**
4. Type a word into the editor (A is open), wait for the save (~3 s), assert the API now orders [A, B] and A's `edited_at` moved; the sidebar shows [A, B] without reload (patchDocumentSummary re-sort).
5. Screenshot; view it yourself.
Kill your scratch processes (stored PIDs).

- [ ] **Step 2: Full suites**

From `backend/`: `uv run pytest -q`. From `frontend/`: `npx vitest run && npx tsc --noEmit && npm run lint && npm run build`. All green, zero warnings.

- [ ] **Step 3: Docs + logbook**

`docs/backend-architecture.md`: in the Documents section, document the three-timestamp model (`edited_at` ordering semantics + exact bump rules, `checked_at` nullable, `updated_at` demoted to technical), the migration seeding, and that `set_name`/`set_folder` never bump `edited_at`. Update any sentence claiming ordering rides `updated_at`.

`docs/frontend-architecture.md`: replace the `touchDocument` description with `patchDocumentSummary` (server-authoritative reordering), note `relativeTime` now shows `edited_at`, and update the recency wording in the folder-groups section if it references `updated_at`.

`docs/LOGBOOK.md`: dated entry — problem (check-induced reordering), semantics table, commit list, e2e acceptance outcome.

- [ ] **Step 4: Commit**

```bash
git add docs/backend-architecture.md docs/frontend-architecture.md docs/LOGBOOK.md
git commit -m "docs: document the edited_at recency semantics"
```

---

## Self-Review Notes (already applied)

- Spec coverage: columns/bumps/ordering/migration (T1), summary fields exposed via models with API test (T1 Step 4), frontend types/action-swap/call-sites/relativeTime (T2), acceptance e2e + docs (T3). Spec's "createNewDocument/migration/recovery prepend as today" needs no change — `setDocuments([summaryOf(doc), ...])` prepends and the fresh `edited_at` is genuinely newest; subsequent `patchDocumentSummary` sorts consistently.
- Type consistency: `patchDocumentSummary(id, patch)` matches between T2 store definition and the autosave/documents call sites; `edited_at: str` / `checked_at: str | None` consistent backend↔frontend (`string | null`).
- The frontend comparator uses `localeCompare` on ISO strings — safe because the backend emits a single fixed format (`isoformat(timespec="seconds")`, always `+00:00`), so lexicographic order == chronological order; ties break by `id DESC` exactly like the SQL.
- Placeholder scan: none.
