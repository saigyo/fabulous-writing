# Multi-Document Management — Design

## Problem

The app has exactly one implicit document: its text lives in browser
localStorage (`Editor.tsx`), the header settings (language, profile, domains,
LLM provider/model/tier, auto-check) are global zustand-persisted state, and
check results die on reload. Users need multiple persistent documents that can
be created, listed, renamed, and deleted — with each document remembering its
own settings and its last check results so the sidebar repopulates instantly
on reopening.

## Decisions (confirmed)

1. **Persistence:** documents live in the backend SQLite DB
   (`backend/data/fabulous.db`), managed by a new `DocumentStore` following
   the `ProfileStore` conventions. Approach A: typed columns for settings,
   opaque JSON for check-state snapshots.
2. **Saving:** debounced autosave (~1.5s after last change), flushed on
   document switch, view switch, and `beforeunload`. No save button.
3. **Check results:** persisted after every completed check (immediate save),
   together with the text they belong to — text and findings are always
   written in the same PUT so they cannot disagree.
4. **Auto-naming:** the LLM titles a document through the **cheap tier**
   regardless of the document's own provider settings. Generated **once**
   when the text first passes the threshold; after that only manual rename
   changes the name. First-words fallback when the LLM call fails.
5. **Migration:** on first load after the feature ships, an existing
   localStorage text becomes document #1 silently (with the current persisted
   settings); the localStorage text key is then retired.
6. **Sidebar scope:** the collapsible document list appears in the editor
   view only. Rules/terminology/profiles views are unchanged.
7. **Offline resilience:** a write-through localStorage buffer for the
   *current document only*, with dirty-replay on startup and a `revision`
   guard against cross-browser clobbering (details below).
8. **Multi-user later:** `owner_id INTEGER NOT NULL DEFAULT 1` now; a users
   table and FK arrive in a later phase as a plain migration.
9. **Project folders later:** no schema prep now. Phase 2 adds a `folders`
   table plus an idempotent `ALTER TABLE documents ADD COLUMN folder_id`
   (the established `_migrate()` pattern). Documents will point at folders;
   the sidebar list endpoint can grow folder grouping without a new shape.

## Data model (backend)

New table in `fabulous.db`, owned by `DocumentStore`
(`backend/app/services/documents.py`), same conventions as `ProfileStore`:
`_connect()` contextmanager that closes the connection, idempotent
`_migrate()`.

```sql
CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 1,      -- future users table FK
    name TEXT NOT NULL,
    name_source TEXT NOT NULL DEFAULT 'fallback',  -- 'fallback'|'llm'|'user'
    text TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL,
    profile_id INTEGER,                        -- nullable; profile may vanish
    domain_ids TEXT NOT NULL DEFAULT '[]',     -- JSON int array (as profiles)
    llm_provider TEXT,                         -- NULL = tier mode
    llm_model TEXT,
    llm_tier TEXT,
    llm_auto INTEGER NOT NULL DEFAULT 1,
    last_findings TEXT NOT NULL DEFAULT '[]',  -- JSON snapshot (see below)
    scorecard TEXT,                            -- JSON or NULL
    revision INTEGER NOT NULL DEFAULT 0,       -- optimistic-concurrency guard
    created_at TEXT NOT NULL,                  -- ISO-8601 UTC
    updated_at TEXT NOT NULL                   -- drives recency ordering
);
```

- `name_source` carries the title lifecycle: `fallback` (Untitled or
  first-words; LLM titling still allowed) → `llm` (titled once, frozen) →
  `user` (renamed; never auto-touched again).
- `last_findings` stores plain `Finding` objects plus their current absolute
  span positions against the stored text — no frontend-internal wrapper
  types — so a future normalization into a findings table (history/reporting)
  maps to clean columns. Shape: `[{"finding": <Finding>, "from": int,
  "to": int}]`.
- Deletion is a hard `DELETE` (confirm dialog in the UI).
- Recency ordering = `ORDER BY updated_at DESC`; every update bumps
  `updated_at`.

## API

New router `backend/app/api/documents.py`, mounted like the existing routers.

| Endpoint | Behavior |
|---|---|
| `GET /api/documents` | Sidebar list: `id, name, language, updated_at` only (no text/findings), ordered by `updated_at DESC`. |
| `POST /api/documents` | Create with initial settings (from current header state) and optional initial text. Returns the full document. |
| `GET /api/documents/{id}` | Full document: text, settings, `last_findings`, `scorecard`, `revision`, name fields. |
| `PUT /api/documents/{id}` | Partial update — the autosave endpoint. Accepts any subset of: text+findings+scorecard (always together), settings fields, `name` (rename sets `name_source='user'`). Requires the client's base `revision`; on match, applies, increments `revision`, bumps `updated_at`, returns the new revision. On mismatch → **409** with the current server revision. |
| `DELETE /api/documents/{id}` | Hard delete. 404 if missing. |
| `POST /api/documents/{id}/generate-name` | Runs the title prompt through the cheap tier. Acts only if `name_source == 'fallback'`; otherwise no-op returning the current name. On success stores the title, sets `name_source='llm'`. On LLM failure keeps the fallback name and `name_source='fallback'` (a later call may retry). |

Last-write-wins within a matching revision; no merge machinery.

## Auto-naming

- Trigger (frontend): when a document with `name_source == 'fallback'` first
  reaches ≥ 20 words, fire `generate-name` once per session per document.
- Fallback name: first ~6 words of the text (trimmed, single-spaced), or the
  localized "Untitled" while empty.
- The title prompt asks the cheap tier for a short (≤ 8 words) title in the
  document's language, returning plain text (stripped of quotes/trailing
  punctuation).

## Frontend: store and sync

- Store additions: `documents: DocumentSummary[]`, `currentDocId: number |
  null`, plus actions `openDocument`, `createDocument`, `renameDocument`,
  `deleteDocument`, `refreshDocuments`.
- **Opening a document** hydrates the existing header/editor state from it
  (language, profileId, domainIds, provider/model/tier, llmAuto), sets the
  editor text, and restores `tracked` findings + scorecard into the sidebar.
  Spans are absolute positions against the saved text, valid immediately.
- **Header settings become per-document:** changing a header selector edits
  the open document (autosaved like text). localStorage keeps only true UI
  preferences: `uiLocale`, `rulesCollapsed`, sidebar collapsed state, and
  `currentDocId` (reload reopens the same document). The zustand persist
  `partialize` shrinks accordingly (persist version bump + migrate).
- **New document** inherits the current header settings; text empty, name
  localized "Untitled".
- **Autosave:** one debounced writer (~1.5s) PUTs text + current mapped
  findings + scorecard in one request; settings changes ride the same writer.
  Flushes on document switch, view switch, `beforeunload`. A completed check
  triggers an immediate save.

## Offline resilience (write-through buffer)

Scope: the current document only. localStorage is a cache, never the source
of truth; the list and all other documents are backend-only.

- Every autosave writes the full snapshot (text, findings, scorecard,
  settings, name, base revision, dirty flag) to localStorage synchronously,
  then PUTs to the backend debounced.
- PUT success clears the dirty flag and records the new revision. PUT failure
  (network/server) leaves the snapshot dirty and retries with backoff while
  the tab lives; typing continues unaffected.
- On app startup, a dirty snapshot is replayed to the backend before the
  document opens.
- Replay/PUT answered with **409** (another browser advanced the document):
  the local snapshot is preserved losslessly as a **new document** named
  `«Name» (recovered)` (`name_source='user'`), and the server version wins in
  place. Deterministic, no merge UI. If the document was deleted server-side
  (404 on replay), the same recovery applies.

## Migration from single-document localStorage

On startup: if `GET /api/documents` returns zero documents AND the legacy
text key exists in localStorage → `POST /api/documents` with that text and
the currently persisted settings, open it, then delete the legacy key. The
document gets the first-words fallback name and auto-titles later per the
normal rule. If documents already exist, the legacy key is ignored and
removed.

## Document sidebar UI (editor view only)

- Collapsible left panel in the editor view: **+ New Document** button on
  top, then the recency-ordered list (name + relative time, e.g. "2h ago").
- Current document highlighted. Hover reveals a ⋯ menu per item: **Rename**
  (inline edit) and **Delete** (confirm dialog).
- Collapse toggle in the panel header; collapsed state persisted in
  localStorage.
- All strings via the existing i18n catalogs (×7: en/de/fr/es/it/ja/zh),
  including "Untitled", "New Document", rename/delete labels, confirm text,
  the "(recovered)" suffix, and relative-time forms.

## Error handling

- Backend down at startup: the editor opens with the buffered current
  document from the localStorage cache, editing continues, and the dirty
  snapshot syncs once the retry loop reaches the backend; the document list
  shows an error state with retry.
- `generate-name` failures are silent (fallback name stays; retried on a
  later threshold crossing in a new session).
- Deleting the currently open document opens the most recent remaining
  document, or a fresh empty one if none remain.
- Opening a document whose `profile_id` no longer exists: settings load
  minus the profile (profileId null); everything else applies.

## Testing

- **Backend unit (`test_documents.py`):** DocumentStore CRUD, `_migrate()`
  idempotence (open twice), connection-close regression (as
  `test_profiles.py::test_connection_is_closed_after_use`), name_source
  transitions, revision increment/mismatch, recency ordering.
- **Backend API:** CRUD roundtrips; PUT with stale revision → 409 with
  current revision; rename sets `name_source='user'`; generate-name with
  `FakeProvider` (success → `llm`, failure → stays `fallback`, non-fallback →
  no-op); list omits text/findings.
- **Frontend (vitest):** store actions, autosave debounce/flush, dirty-flag
  lifecycle, 409 → recovered-copy flow, migration-on-first-load logic,
  persist version migration.
- **E2E (headless, stubbed or scratch backend DB — never the owner's live
  `backend/data/fabulous.db`; scripts create and clean up scratch data):**
  create → type → auto-title fires → check → switch to another document and
  back → text, findings, and scorecard repopulate.

## Out of scope (later phases)

- Project folders (phase 2), user accounts/auth, finding history and
  reporting, document search, concurrent-edit merging, sharing.
