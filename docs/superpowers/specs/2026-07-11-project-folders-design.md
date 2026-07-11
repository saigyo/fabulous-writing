# Project Folders for Documents — Design (Phase 2)

## Problem

Phase 1 (docs/superpowers/specs/2026-07-10-documents-design.md) gave the app
multiple persistent documents in a flat, recency-ordered sidebar list. Users
organizing many documents need project folders — like projects in the Claude
app — to group related documents, without losing the flat list's simplicity
for ungrouped work.

## Decisions (confirmed)

1. **Sidebar model:** folders render as collapsible groups containing their
   documents; ungrouped documents stay in a flat list below a subtle divider.
   One home per document — no duplication.
2. **Folder data:** name only in this phase. Flat — no nesting.
3. **Assignment:** menu-based. A document's ⋯ menu gains "Move to folder ▸"
   (submenu: folder names + "No folder"). A folder's ⋯ menu has "New document
   here". The top "+ New document" keeps creating ungrouped documents. Drag &
   drop is a later polish, not in scope.
4. **Folder deletion:** never deletes documents — members drop back to the
   ungrouped list (`folder_id` nulled) in the same transaction. The confirm
   dialog states this.
5. **Folder creation:** a new-folder ghost icon button (folder-plus SVG, same
   quiet style as the panel toggle) in the sidebar header row. The new folder
   appears immediately with an inline name input (like rename); Escape
   cancels creation, Enter/blur commits.
6. **API shape:** flat `GET /api/documents` list unchanged in structure —
   summaries gain a `folder_id` field; the sidebar groups client-side (as
   pre-decided in phase 1). Folders get their own small CRUD.

## Phase 3 outlook (binding for this design)

Per-folder defaults (e.g. profile/language applied to documents created
inside a folder, in the spirit of Claude project instructions) arrive in an
upcoming phase. This design must not paint that in a corner:

- The folders table grows columns via the established idempotent
  `_migrate()` pattern.
- The API always returns folder **objects** (never bare name strings), so
  new fields are additive for clients.
- "New document here" already funnels through one code path
  (`createNewDocument`-with-folder), which phase 3 extends to apply folder
  defaults.

## Data model (backend)

New table beside `documents` in `fabulous.db`, owned by `FolderStore`
(`backend/app/services/folders.py`), following the store conventions
(`_connect()` contextmanager that closes, idempotent `_migrate()` where
needed):

```sql
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 1,   -- future users table FK
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL               -- ISO-8601 UTC
);
```

`documents` gains `folder_id INTEGER` (nullable, no SQL FK constraint —
consistency is enforced by the stores) via `DocumentStore._migrate()`:
`ALTER TABLE documents ADD COLUMN folder_id INTEGER`, guarded by column
name like the profiles migrations.

- Folder names: non-empty after trim, unique (DB constraint), capped at
  100 chars.
- Deleting a folder runs `UPDATE documents SET folder_id = NULL WHERE
  folder_id = ?` and `DELETE FROM folders WHERE id = ?` in one transaction.
- `Document` / `DocumentSummary` models gain `folder_id: int | None = None`.

## API

New router `backend/app/api/folders.py` plus one addition to the documents
router:

| Endpoint | Behavior |
|---|---|
| `GET /api/folders` | All folders, ordered by name (case-insensitive). Returns folder objects `{id, name, created_at}`. |
| `POST /api/folders` | Create; 422 empty name, 409 duplicate. Returns the folder. |
| `PUT /api/folders/{id}` | Rename; 404/422/409 as above. Returns the folder. |
| `DELETE /api/folders/{id}` | 204; nulls members' `folder_id` first (same transaction). 404 if missing. |
| `POST /api/documents/{id}/move` | Body `{folder_id: int \| null}`. Sets the document's folder. 404 unknown document, 422 unknown folder_id. Bumps `updated_at`, does NOT bump `revision` (like `set_name`): a move never touches content, so it can never 409 an in-flight autosave; last move wins. Returns the document. |

`POST /api/documents` (create) accepts an optional `folder_id` (validated
like move) for "New document here".

`folder_id` is deliberately NOT part of the autosave payload
(`content`/`settings` in `PUT /api/documents/{id}`): autosave can never
clobber a sidebar move, and a move needs no revision.

## Frontend

**Store** (`src/state/store.ts`):
- `folders: Folder[]` (`{id, name, created_at}`), `setFolders`.
- `docFoldersCollapsed: number[]` + `toggleFolderCollapsed(id)` — persisted
  (added to `partialize`; additive, no persist version bump).
- `DocumentSummary` type gains `folder_id: number | null`.

**Lifecycle** (`src/documents/documents.ts`):
- `refreshFolders()` (rides `initDocuments` and folder mutations).
- `createFolder(name)`, `renameFolder(id, name)`, `deleteFolder(id)`
  (delete refreshes both folders and documents — members changed).
- `moveDocument(id, folderId)` — calls the move endpoint, updates the
  summary in place (no full refresh needed).
- `createNewDocument(folderId?: number)` — existing function gains the
  optional folder target ("New document here").

**Sidebar** (`src/documents/DocumentSidebar.tsx`):
- Header row: + New document · new-folder ghost icon (folder-plus SVG) ·
  panel toggle.
- Folder groups sorted by name (case-insensitive, locale-aware via
  `localeCompare`), each: chevron (rotates when collapsed), name, hover ⋯
  menu (New document here / Rename / Delete-with-confirm). Documents inside
  recency-ordered (the flat list's order, filtered).
- Ungrouped documents below a subtle divider (divider only shown when both
  sections are non-empty).
- Document ⋯ menu gains "Move to folder ▸" submenu: all folders + "No
  folder"; the entry for the document's current location is disabled.
- New-folder flow: an inline name input appears at the top of the folder
  section; Enter/blur commits (trimmed, non-empty), Escape cancels. On 409
  (duplicate name) the input stays open with the error styling used by the
  existing list error text.
- A collapsed folder containing the CURRENT document renders its name with
  the current-document accent so the open document stays locatable.
- Empty folders render (they were just created); no placeholder text needed.

**Edge behavior:**
- Deleting the current document still opens the most recent remaining
  document overall (flat recency list, unchanged).
- Deleting a folder never closes the open document; its `folder_id` just
  becomes null (the summary moves to ungrouped on the refresh).
- Renaming/moving never reorders the recency underlying the groups.

**i18n** (×7: en/de/fr/es/it/ja/zh): `folderNew` (tooltip/aria for the
icon), `folderNamePlaceholder`, `folderRename`, `folderDelete`,
`folderDeleteConfirm(name)` (must state documents are kept),
`folderNewDocument`, `folderMoveTo`, `folderNone`, `folderMenu` (aria).

## Error handling

- Folder API failures during mutations surface via the existing
  `docListError` + retry mechanism where the list becomes inconsistent
  (delete/move); pure create/rename failures show inline at the input (409)
  or fall back to `docListError` (network).
- `POST /api/documents/{id}/move` with a folder deleted meanwhile → 422;
  the frontend refreshes folders + documents (the stale submenu entry
  disappears).
- Offline: folder mutations are backend-only (no localStorage buffering) —
  the buffer stays scoped to the current document's content, as in phase 1.
  A failed move leaves the document where it was.

## Testing

- **Backend unit (`test_folders.py`):** FolderStore CRUD, unique-name
  violation, delete-nulls-members transactionality, open-twice idempotence,
  connection-close regression; DocumentStore `folder_id` migration
  idempotence (old DB without the column gets it).
- **Backend API:** folders CRUD roundtrips incl. 409/422/404; move endpoint
  (success, null, unknown folder 422, no revision bump — asserted); create
  document with `folder_id`; list summaries carry `folder_id`.
- **Frontend (vitest):** grouping/sorting logic, collapse-state persistence
  (partialize), move updates the summary in place, folder lifecycle
  functions with mocked client, i18n parity.
- **E2E (headless, scratch stack — never the live DB):** create folder →
  inline-name it → "New document here" → move another document in via the
  submenu → collapse the folder → reload → grouping and collapsed state
  persist → delete the folder (confirm) → both documents in ungrouped, none
  lost.

## Out of scope

- Folder nesting, drag & drop, per-folder defaults (phase 3), folder
  sharing/ownership beyond `owner_id`, cross-folder search.
