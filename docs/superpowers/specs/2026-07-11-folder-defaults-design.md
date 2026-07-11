# Per-Folder Defaults — Design (Phase 3)

## Problem

Phase 2 (docs/superpowers/specs/2026-07-11-project-folders-design.md) gave
documents project folders and reserved room for this phase: folders should
carry default settings — in the spirit of Claude project instructions — so
a document created inside a folder starts with the folder's profile,
language, domains, LLM choice, and auto-flag instead of whatever the header
happens to show.

## Decisions (confirmed)

1. **Apply on creation only.** "New document here" (and any future
   create-in-folder path) applies the folder's defaults. Moving an existing
   document into a folder never touches its settings. The top-level
   "+ New document" is unaffected (current header state, as today).
2. **Partial per field.** Each default — language, profile, domains, LLM
   provider/model/tier, auto-flag — is individually optional. Unset fields
   fall back to today's behavior (current header state at creation time).
3. **Edit via dialog.** "Folder defaults…" in the folder's ⋯ menu opens a
   modal reusing the header's selector components, plus a "take from
   current document" convenience button.
4. **Profile requires language.** The profile default selector is enabled
   only when a language default is set and offers that language's profiles.
   Clearing the language default clears the profile default. Invariant
   (enforced by UI and backend): profile default ⇒ language default.
5. **Storage: typed nullable columns** on `folders`, mirroring how
   `documents` stores the same settings (not a JSON blob).

## Data model (backend)

`FolderStore._migrate()` — the idempotent hook phase 2 reserved — adds
seven nullable columns, each guarded by column-name check like the
existing migrations:

```sql
ALTER TABLE folders ADD COLUMN default_language TEXT;
ALTER TABLE folders ADD COLUMN default_profile_id INTEGER;
ALTER TABLE folders ADD COLUMN default_domain_ids TEXT;      -- JSON array or NULL
ALTER TABLE folders ADD COLUMN default_llm_provider TEXT;
ALTER TABLE folders ADD COLUMN default_llm_model TEXT;
ALTER TABLE folders ADD COLUMN default_llm_tier TEXT;
ALTER TABLE folders ADD COLUMN default_llm_auto INTEGER;     -- NULL/0/1 tri-state
```

NULL means "no default for this field". `default_domain_ids` is NULL
(unset) or a JSON int array (may be `[]`, which is a *set* default of
"no domains"). The `Folder` pydantic model gains matching optional fields:

```python
default_language: Language | None = None
default_profile_id: int | None = None
default_domain_ids: list[int] | None = None
default_llm_provider: str | None = None
default_llm_model: str | None = None
default_llm_tier: str | None = None
default_llm_auto: bool | None = None
```

The LLM provider/model/tier triple is one composite unit: the dialog
treats it as a single selector (like the header's `LlmSelector`); either
the triple describes a selection or the whole LLM default is unset.
The backend stores the three columns as given — it does not enforce
intra-triple consistency (same as `documents`, where the header selector
is the source of the shape).

Since the folders API already returns folder objects (phase-2 decision),
the new fields are additive for clients.

## API

One new endpoint in `backend/app/api/folders.py`:

| Endpoint | Behavior |
|---|---|
| `PUT /api/folders/{id}/defaults` | Body carries all seven fields, each nullable. The body is the complete new defaults state — full replace, no PATCH merge. Returns the folder object. |

Validation (422 with detail message):

- profile default set while language default is null,
- `default_profile_id` unknown, or its profile belongs to a different
  language than `default_language`,
- any id in `default_domain_ids` unknown.

404 for an unknown folder. Folder create/rename/delete are untouched
(create starts with all defaults NULL).

`GET /api/folders` now serves the defaults on each folder object, with
**read-time pruning** (same philosophy as the documents GET pruning dead
`profile_id`s): if `default_profile_id` no longer resolves to an existing
profile, it is omitted from the response (the language default stays);
unknown ids in `default_domain_ids` are dropped from the returned list.
The DB row is not modified — pruning is read-time only.

## Apply semantics (frontend, creation only)

`createNewDocument(folderId)` in `src/documents/documents.ts` builds the
create payload as today from the current header state, then overlays the
folder's set defaults on top — each field only if non-null:

- `default_language` → `language`
- `default_profile_id` → `profile_id`
- `default_domain_ids` → `domain_ids`
- LLM triple (applied together when any of provider/model/tier is set) →
  `llm_provider`/`llm_model`/`llm_tier`
- `default_llm_auto` → `llm_auto`

The folder objects are already in the store, so this is pure client-side
payload construction; `POST /api/documents` does not change. After
creation the editor hydrates from the returned document as usual, so the
header immediately shows the folder-defaulted values.

## Frontend

**Dialog** (new component `src/documents/FolderDefaultsDialog.tsx`,
opened from a new "Folder defaults…" entry in the folder ⋯ menu in
`DocumentSidebar.tsx`):

- Language select with a "— no default —" empty option at the top.
- Profile select, disabled until a language default is chosen; offers that
  language's profiles (fetched via the existing `getProfiles(language)`),
  also with an empty option. Clearing/changing language clears the profile
  selection (changing to a different language resets it to "no default").
- Domain multi-select (same component pattern as the header's
  `DomainMultiSelect`), with an explicit distinction between "no default"
  (unset) and "default: no domains" (`[]`).
- LLM selector (same semantics as the header's `LlmSelector`), with a
  "no default" state.
- Auto-flag tri-state: no default / on / off.
- "Take from current document" button fills all fields from the current
  header state in one click (auto-flag becomes an explicit on/off, domains
  become a set list).
- Save calls `PUT /api/folders/{id}/defaults`, refreshes folders, closes.
  Cancel discards. Network errors show inline in the dialog; 422 is not
  reachable through the constrained UI but also shows inline (defense in
  depth).

**No folder-row badge.** The ⋯ menu entry is the only entry point; the
dialog itself shows the current state. (A subtle indicator can come later
if wanted.)

**Store** (`src/state/store.ts`): the `Folder` type gains the seven
optional fields. No new persisted UI state (the dialog is transient).

**Lifecycle** (`src/documents/documents.ts`): a
`saveFolderDefaults(id, defaults)` function calling the new endpoint and
updating the folder in place; the overlay logic in `createNewDocument`
as an exported pure helper (e.g. `applyFolderDefaults(payload, folder)`)
so it is unit-testable in isolation.

**i18n** (×7: en/de/fr/es/it/ja/zh): `folderDefaults` (menu entry +
dialog title), `folderDefaultsNone` ("no default" option label),
`folderDefaultsTakeCurrent`, `folderDefaultsAutoOn`,
`folderDefaultsAutoOff`, `folderDefaultsSave`, `folderDefaultsCancel`
(reuse existing generic keys where present), `folderDefaultsError`.
Exact key set may shrink where existing keys fit; the parity test keeps
all seven catalogs complete.

## Error handling

- Save failures (network) keep the dialog open with an inline error; the
  folder list is not refreshed on failure.
- A folder deleted while its defaults dialog is open: save returns 404 →
  inline error naming the folder as gone; closing refreshes folders.
- Dead references created later (profile/domain deleted after being set
  as a default) are handled by read-time pruning in `GET /api/folders`;
  the overlay in `createNewDocument` therefore never sees them.

## Testing

- **Backend unit (`test_folders.py`):** migration idempotence (pre-phase-3
  DB gains the columns; opening twice is safe); defaults set/replace/clear
  roundtrip; NULL vs `[]` domain semantics preserved.
- **Backend API:** PUT defaults success + full 422 matrix (profile without
  language, cross-language profile, unknown profile, unknown domain id);
  404 unknown folder; GET pruning after deleting the referenced profile /
  a referenced domain (language survives profile pruning).
- **Frontend (vitest):** `applyFolderDefaults` overlay (partial defaults
  override exactly the set fields; LLM triple applied as a unit; `[]`
  domains override; all-unset folder is a no-op); dialog coupling rule
  (language cleared/changed → profile cleared); "take from current"
  fills from header state; i18n parity.
- **E2E (headless, scratch stack — never the live DB):** create folder →
  set defaults (language + profile + one domain) → "New document here" →
  the new document carries the defaults while "+ New document" carries
  the header state → delete the profile → reload → folder defaults served
  pruned and document creation still works.

## Out of scope

- Applying defaults on move-in; propagating default changes to existing
  documents; per-folder default *text* templates; folder-level check
  scheduling; folder-row badge for "has defaults".
