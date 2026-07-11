# Document Recency Semantics — Design

## Problem

The sidebar orders documents by `updated_at`, which means "last write", not
"last edit". Opening a document triggers the automatic fast check; the fresh
results carry new finding ids, the autosave's no-op suppression sees changed
content and PUTs, `updated_at` bumps — and the merely-opened document jumps
to the top of the list. Checks, settings tweaks, auto-titling, and moves all
reorder the list even though the user never touched the text.

## Decision (confirmed)

Split the timestamps; **ordering rides an `edited_at` that only moves when
the user actually changes the document**. A sorting widget
(created/edited/checked) was considered and deliberately deferred — the
schema and API prepare for it so it becomes a purely frontend addition
later.

## Timestamp semantics

| Column | Bumps when | Used for |
|---|---|---|
| `edited_at` | The document's **text** changes (backend compares the PUT's text against the stored text), or the user **renames** it (PUT `name`). | Sidebar ordering (`ORDER BY edited_at DESC, id DESC`) and the relative time shown per item. |
| `checked_at` | Check state is stored: any `content` PUT (findings + scorecard travel with text), or a create that carries findings. Nullable — NULL means "never checked". | Not user-facing yet; recorded for the deferred sorting widget. |
| `updated_at` | Any write, as today (technical last-write timestamp). | Debugging/sync only; no longer drives anything user-facing. |
| `created_at` | Unchanged. | Already stored; exposed in summaries for the deferred widget. |

Explicit non-bumpers of `edited_at`: check-result refreshes, settings
changes, folder moves (`set_folder`), auto-titling and first-words fallback
(`set_name`), revision changes. This also resolves the folder spec's noted
tension ("move bumps updated_at" vs "moves never reorder") — moves now
genuinely never reorder.

## Backend

- `documents` gains `edited_at TEXT NOT NULL` and `checked_at TEXT`
  (nullable) via the established guarded `_migrate()`; existing rows seed
  both from `updated_at` (best available approximation).
- `create_document`: `edited_at = created_at`; `checked_at` set to the same
  timestamp only when the create carries findings or a scorecard (recovered
  copies), else NULL.
- `update_document`: inside the existing optimistic update, computed against
  the `current` row it already reads — `edited_at = now` if a `text` field
  differs from the stored text OR a `name` field differs from the stored
  name; `checked_at = now` if the PUT carries `last_findings`/`scorecard`.
  `updated_at`/`revision` behavior unchanged.
- `set_name` and `set_folder`: keep bumping only `updated_at` (never
  `edited_at`), unchanged signatures.
- `list_documents`: `ORDER BY edited_at DESC, id DESC`; `DocumentSummary`
  gains `edited_at: str`, `checked_at: str | None`, `created_at: str`
  (keeping `updated_at` for compatibility). `Document` gains the same two
  new fields.

## Frontend

- `DocumentSummary`/`DocumentFull` types mirror the new fields.
- The store's `touchDocument(id, name?)` — which moves an entry to the front
  and fakes `updated_at` locally — is **replaced** by
  `patchDocumentSummary(id, patch: Partial<DocumentSummary>)`, which merges
  fields into the matching summary and re-sorts the list by
  `edited_at DESC, id DESC` (one shared comparator, same as the backend).
  No entry ever moves without a server-provided timestamp change.
- Call sites (all pass fields from the server response they already hold):
  - autosave push success → `patchDocumentSummary(id, {edited_at, checked_at, revision-irrelevant fields omitted})` — reorders only if the server bumped `edited_at` (i.e. the text really changed);
  - `renameDocument` → patch `name` + `edited_at`;
  - `maybeGenerateTitle` → patch `name` only (no reorder);
  - `moveDocumentToFolder` → patch `folder_id` only (unchanged behavior);
  - `createNewDocument`/migration/recovery → prepend as today (a fresh
    `edited_at` sorts them to the top naturally).
- The sidebar's `relativeTime` reads `edited_at`.
- `openDocument` needs no special casing: opening writes nothing, and the
  post-open auto-check's PUT no longer bumps `edited_at`.

## Error handling

No new error paths: the timestamp logic lives inside existing write paths
and cannot fail independently. A 409/404 on a PUT behaves exactly as today.

## Testing

- **Backend unit:** migration seeds both columns from `updated_at` and is
  reopen-idempotent; create sets `edited_at == created_at` and NULL/non-NULL
  `checked_at` per payload; update with identical text + new findings bumps
  `checked_at` and `updated_at` but NOT `edited_at`; update with changed
  text bumps all three; rename via update bumps `edited_at`; `set_name`/
  `set_folder` leave `edited_at` untouched; list orders by `edited_at`.
- **Backend API:** summaries carry the three new fields; ordering follows
  `edited_at` when `updated_at` disagrees.
- **Frontend (vitest):** `patchDocumentSummary` merge + re-sort semantics
  (bumped `edited_at` moves an entry up; patch without `edited_at` keeps
  order); autosave/rename/title call sites patch instead of touch.
- **E2E (scratch stack) — the acceptance case:** with two documents, open
  the older one, type nothing, wait for the auto-check and its save to
  land, reload → the list order is UNCHANGED. Then type a word in the open
  document, wait for the save → it moves to the top.

## Out of scope

- The sorting widget (deferred; schema/API now ready), exposing
  `checked_at` in the UI, any change to revision/conflict semantics.
