# Codebase Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the triaged cleanup (spec `docs/superpowers/specs/2026-07-12-codebase-cleanup-design.md`, addendum): fix the found correctness hazards, close the Critical test gap, remove duplication/dead code, and split the tangled modules — with browser-observable behavior identical except the three owner-sanctioned E-items.

**Architecture:** No new features. Backend: FastAPI routers over SQLite stores; frontend: React 19 + zustand + CodeMirror. Tasks are ordered fixes-first (with their tests), then backend clusters, then the big frontend structural split, then views, then additive tests.

**Tech Stack:** Python 3.13/uv/pytest; TypeScript/React/vitest/oxlint/vite.

## Global Constraints

- Browser-observable behavior is FROZEN except sanctioned items E1 (TerminologyView gains error messages), E2 (doc/folder menus switch from mouse-leave to outside-click dismissal), E3 (defaults-dialog profile select disabled during profile refetch).
- The owner's live DB `backend/data/fabulous.db` must NEVER be touched; migrations are rehearsed only against a COPY. The owner's dev servers (:5173, :8000) must never be killed or restarted.
- Backend gate (run from `backend/`): `uv run pytest -q` — all pass, zero warnings.
- Frontend gate (run from `frontend/`): `npx vitest run && npx tsc --noEmit && npm run lint && npm run build` — all pass (the >500kB chunk advisory in build is pre-existing and acceptable).
- This iteration works on the dedicated branch `codebase-cleanup` (NOT directly on main — owner-mandated deviation for this major undertaking); at the end the branch is pushed and a PR opened for an independent Copilot review. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Rule YAML / config file formats are frozen. API keys from environment only.
- HTTP error messages/status codes currently asserted by tests must stay byte-identical unless a task says otherwise.
- Controller note (not for implementers): dispatch agents sequentially, never more than one implementation agent at a time; ≤5 agents total; implementers/reviewers on sonnet (haiku for pure transcription), final review on fable.

---

### Task 1: Cancel in-flight checks on document switch (A1) + controller tests (B1a)

The Critical fix. An in-flight LLM check's SSE subscription survives a document switch; its late `scorecard`/`progress`/`error`/`done` callbacks then write document A's results into the store now bound to document B — and `flush()` persists them.

**Files:**
- Modify: `frontend/src/checking/controller.ts`
- Modify: `frontend/src/documents/documents.ts` (top of `hydrateFromDocument`, currently line 156)
- Test: `frontend/src/checking/controller.test.ts` (new)

**Interfaces:**
- Produces: `export function cancelCheck(): void` in `controller.ts` — unsubscribes, clears `currentCheckId`, resets `checkPhase`/`llmStartedAt`/`llmTokens` to idle. Task 10 later moves the call site file but not this function.

- [ ] **Step 1: Write the failing tests** — `frontend/src/checking/controller.test.ts`:

```typescript
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../state/store'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  postCheck: vi.fn(),
  subscribeCheck: vi.fn(),
}))
vi.mock('../editor/editorRef', () => ({
  getEditorView: () => ({
    state: { doc: { toString: () => docText, length: docText.length } },
    dispatch: (tx: unknown) => dispatched.push(tx),
  }),
}))
vi.mock('./routing', () => ({
  resolveModel: () => ({ ok: true, provider: 'fake', model: 'fake-model' }),
}))
vi.mock('../documents/autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../documents/autosave')>()),
  flush: vi.fn().mockResolvedValue(undefined),
}))

import { postCheck, subscribeCheck } from '../api/client'
import { cancelCheck, runCheck } from './controller'

let docText = 'Some text with issues.'
let dispatched: unknown[] = []

type SseCallbacks = Parameters<typeof subscribeCheck>[1]

function lastCallbacks(): SseCallbacks {
  const calls = vi.mocked(subscribeCheck).mock.calls
  return calls[calls.length - 1][1]
}

const scorecard = { overall: 80, dimensions: [] }

beforeEach(() => {
  vi.clearAllMocks()
  cancelCheck()
  docText = 'Some text with issues.'
  dispatched = []
  useStore.setState({ scorecard: null, scorecardStale: false, llmError: null })
  vi.mocked(postCheck).mockResolvedValue({
    check_id: 'c1',
    status: 'running',
    findings: [],
  } as never)
  vi.mocked(subscribeCheck).mockReturnValue(() => {})
})

describe('check controller', () => {
  it('applies a late scorecard to the same document', async () => {
    await runCheck(true)
    lastCallbacks().onScorecard(scorecard as never)
    expect(useStore.getState().scorecard).toEqual(scorecard)
    expect(useStore.getState().scorecardStale).toBe(false)
  })

  it('marks the scorecard stale when the text moved on', async () => {
    await runCheck(true)
    docText = 'Some text with issues. And more.'
    lastCallbacks().onScorecard(scorecard as never)
    expect(useStore.getState().scorecard).toEqual(scorecard)
    expect(useStore.getState().scorecardStale).toBe(true)
  })

  it('cancelCheck() unsubscribes and blocks all late SSE writes', async () => {
    const unsub = vi.fn()
    vi.mocked(subscribeCheck).mockReturnValue(unsub)
    await runCheck(true)
    const callbacks = lastCallbacks()
    cancelCheck()
    expect(unsub).toHaveBeenCalled()
    callbacks.onScorecard(scorecard as never)
    callbacks.onProgress(42)
    callbacks.onError('llm', 'boom')
    expect(useStore.getState().scorecard).toBeNull()
    expect(useStore.getState().llmTokens).toBeNull()
    expect(useStore.getState().llmError).toBeNull()
    expect(useStore.getState().checkPhase).toBe('idle')
  })

  it('a newer check supersedes the older one\'s late findings', async () => {
    await runCheck(true)
    const first = lastCallbacks()
    vi.mocked(postCheck).mockResolvedValue({
      check_id: 'c2',
      status: 'running',
      findings: [],
    } as never)
    await runCheck(true)
    dispatched = []
    first.onResult('llm', [])
    expect(dispatched).toHaveLength(0) // stale check's findings never dispatched
  })

  it('discards findings when the text changed since the check', async () => {
    await runCheck(true)
    dispatched = []
    docText = 'edited meanwhile'
    lastCallbacks().onResult('llm', [])
    expect(dispatched).toHaveLength(0)
  })
})
```

Adjust the `scorecard` literal to the real `Scorecard` type in `frontend/src/types.ts` if its required fields differ — check that type first and use a minimal valid value.

- [ ] **Step 2: Run and watch them fail**: `npx vitest run src/checking/controller.test.ts` — the cancel test fails with "cancelCheck is not exported" (the others may pass; that's fine, they pin existing behavior).

- [ ] **Step 3: Implement `cancelCheck` in `controller.ts`** (after the module-level `let unsubscribe ...` declarations):

```typescript
/** Drop any in-flight check: closes the SSE subscription so late results
 * cannot land on a different document (they would be autosaved onto it). */
export function cancelCheck(): void {
  unsubscribe?.()
  unsubscribe = null
  currentCheckId = null
  useStore.setState({ checkPhase: 'idle', llmStartedAt: null, llmTokens: null })
}
```

- [ ] **Step 4: Call it on document switch** — in `frontend/src/documents/documents.ts`, add to the imports `import { cancelCheck } from '../checking/controller'` and make the first line of `hydrateFromDocument`:

```typescript
async function hydrateFromDocument(doc: DocumentFull): Promise<void> {
  cancelCheck() // any in-flight check belongs to the outgoing document
  await replayOrphanedSnapshot(doc.id)
  ...
```

- [ ] **Step 5: Run the tests**: `npx vitest run src/checking/controller.test.ts` then the full frontend gate. All green.
- [ ] **Step 6: Commit** — `fix(checking): cancel in-flight check on document switch; cover controller with tests`

### Task 2: suggest.ts tests (B1b)

Tests only; no production change.

**Files:**
- Test: `frontend/src/checking/suggest.test.ts` (new)

**Interfaces:** Consumes `fetchSuggestions`, `llmActionPending` from `./suggest`. The store fields involved: `suggestPendingId`, `rewritePendingId`, per-finding caches via `setSuggestError`/`setExtraSuggestions`/`setSuggestHeldBack`/`setSuggestAdvice` — read `frontend/src/state/store.ts` for their state shape (`suggestErrors`, `extraSuggestions`, `suggestHeldBack`, `suggestAdvice` maps or similar) and assert on the store state after the call.

- [ ] **Step 1: Write the tests.** Mock `../api/client` (`postSuggestions`), `../editor/editorRef` (a `getEditorView` returning a `findingsField`-bearing state — mock `../editor/findings` too so `view.state.field(findingsField)` returns `{ items: [{ finding: { id: 'f1', message: 'msg', rule_id: null }, from: 0, to: 4 }] }`), and `./routing` (`resolveModel` ok). Cover:
  1. A clean result populates suggestions and clears held-back (`postSuggestions` resolves `{ suggestions: ['better'], rejected: [], held_back: [], advice: [], original: 'orig' }`).
  2. A vetoed result (`suggestions: [], rejected: ['bad'], held_back: ['maybe']`) sets the error message and held-back list, and does NOT populate suggestions.
  3. Advice is stored independently of the veto outcome.
  4. While `suggestPendingId` is set in the store, a second `fetchSuggestions` call returns without calling `postSuggestions` again.
  Use the same file skeleton as Task 1's test (happy-dom pragma, vi.mock before imports).
- [ ] **Step 2: Run, watch each assert against real behavior** (they should pass immediately — they pin existing behavior; verify each can fail by temporarily flipping one expected value, then restore).
- [ ] **Step 3: Full frontend gate; commit** — `test(checking): cover suggest veto/held-back/pending gating`

### Task 3: Frontend-core small fixes (A3, D4, D5, D6)

**Files:**
- Modify: `frontend/src/App.tsx` (line ~110), `frontend/src/checking/scheduler.ts`, `frontend/src/checking/scheduler.test.ts`, `frontend/src/state/store.ts` (lines 344-373), `frontend/src/documents/documents.ts` (`hydrateFromBuffer`, `hydrateFromDocument` signature), `frontend/src/state/store.test.ts` (only if imports change)

**Interfaces:**
- Produces: `hydrateFromDocument(doc: HydrateSource)` where `HydrateSource = Omit<DocumentFull, 'owner_id' | 'created_at' | 'updated_at' | 'edited_at' | 'checked_at' | 'folder_id'>` (exported from documents.ts). All existing `DocumentFull` call sites still typecheck (structural subtype).

- [ ] **Step 1 (A3): stranded suppression flag.** In `App.tsx`, the Header language effect's `.catch(() => {})` (line 110) never consumes the one-shot flag set by `hydrateFromDocument`, so a failed `getProfiles` strands it and mis-suppresses the next legitimate profile apply. Change to:

```typescript
      .catch(() => {
        // A failed fetch must still consume the one-shot suppression, or it
        // would strand and wrongly suppress the NEXT legitimate apply.
        consumeProfileApplySuppression()
      })
```

Add `consumeProfileApplySuppression` to the existing import from `./documents/documents` (App.tsx already imports `applyHeaderProfileSelection` — extend that import).

- [ ] **Step 2 (D4): remove dead `checkNow`.** Delete the `checkNow: () => void` member from `CheckScheduler` and its implementation in `scheduler.ts` (lines 11, 38-41); delete the test case exercising `checkNow` in `scheduler.test.ts`. Verify no other references: `grep -rn "checkNow" frontend/src` must return nothing.

- [ ] **Step 3 (D5): one persist config.** In `store.ts`, hoist a single shared options object and use it in both places — replace lines 344-364's inline literal fields and the trailing duplicate (lines 368-373) with:

```typescript
// Persist options shared with tests: zustand v5 gives tests no handle on the
// inline options, so the SAME object is exported (never a copy — a copy can
// silently drift from what the store actually runs).
export const persistConfig = {
  name: 'fabulous-writing-settings',
  version: 2,
  // v0 predates tiers: those users had explicitly chosen provider/model,
  // so they stay pinned rather than silently switching models.
  // v1 -> v2: header settings moved into per-document storage; stale keys
  // in old blobs are harmless extras and rehydrate transiently (the
  // legacy-document migration in documents.ts still reads them once).
  migrate: (persisted: unknown, version: number): unknown =>
    version === 0
      ? { ...(persisted as object), tier: null }
      : (persisted as object),
  partialize: (state: StoreState) => ({
    uiLocale: state.uiLocale,
    lastProfileByLanguage: state.lastProfileByLanguage,
    rulesCollapsed: state.rulesCollapsed,
    currentDocId: state.currentDocId,
    docSidebarCollapsed: state.docSidebarCollapsed,
    docFoldersCollapsed: state.docFoldersCollapsed,
  }),
}
```

and pass `persistConfig` as the second argument of `persist(...)`. Use the store's actual state type name in `partialize` (check the existing type alias near the top of store.ts; if the inline version had no explicit parameter type, keep it untyped). Keep the exported name `persistConfig` so `store.test.ts` imports unchanged; the test now exercises the real migrate.

- [ ] **Step 4 (D6): narrow the offline hydrate.** In `documents.ts`: define and export near `hydrateFromDocument`:

```typescript
/** The fields hydration actually consumes — the offline path must not have
 * to fabricate owner ids or timestamps it doesn't have. */
export type HydrateSource = Omit<
  DocumentFull,
  'owner_id' | 'created_at' | 'updated_at' | 'edited_at' | 'checked_at' | 'folder_id'
>
```

Change `hydrateFromDocument(doc: DocumentFull)` to `hydrateFromDocument(doc: HydrateSource)`, and delete the `owner_id: 1`, `created_at: ''`, `updated_at: ''`, `edited_at: ''`, `checked_at: null`, `folder_id: null` lines from `hydrateFromBuffer`'s literal.

- [ ] **Step 5: gates.** `npx vitest run && npx tsc --noEmit && npm run lint && npm run build`. All green (store.test's migration test must still pass — now against the real object).
- [ ] **Step 6: Commit** — `fix(frontend): consume stranded profile-apply suppression; drop dead checkNow; unify persist config; narrow offline hydrate`

### Task 4: Folder-defaults correctness cluster (A2 backend, A5 + E3 dialog)

**Files:**
- Modify: `backend/app/api/folders.py` (rename_folder line 73-80, set_folder_defaults line 106-111)
- Modify: `frontend/src/documents/FolderDefaultsDialog.tsx`
- Test: `backend/tests/test_folders_api.py` (or wherever the existing folder-router tests live — find with `grep -rl "folders/defaults\|set_folder_defaults\|/folders" backend/tests`; add to the existing file)

- [ ] **Step 1: Failing backend test.** In the folder-API test file, add: create a profile + a folder; set the folder's defaults to that profile (with matching language default); delete the profile via the profile store/API; then (a) `PUT /api/folders/{id}` rename → response's `default_profile_id` must be `None`; (b) same for a stale domain id in `default_domain_ids` after deleting the domain. Follow the file's existing fixture style (TestClient + seeded stores).
- [ ] **Step 2: Run it, watch it fail** (raw row echoes the dangling id).
- [ ] **Step 3: Fix** — route both endpoints' returns through the existing `_pruned`:

```python
    return _pruned(request, renamed)
```

in `rename_folder`, and

```python
    return _pruned(request, updated)
```

in `set_folder_defaults`.

- [ ] **Step 4: backend gate** — `uv run pytest -q`. If an existing test asserted the raw echo, that test encoded the bug: update it to expect the pruned response and say so in the commit message.
- [ ] **Step 5 (A5 + E3): dialog fixes.** In `FolderDefaultsDialog.tsx`:
  - A5: the folder was deleted while the dialog was open → save 404s → the folder list is stale after close. Change `save`'s catch (line 119-122) to:

```typescript
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        // Folder vanished meanwhile: the list is stale; drop it from view.
        void refreshFolders()
      }
      setError(true)
      setSaving(false)
    }
```

  with `import { HttpError } from '../api/client'` and `refreshFolders` imported from `./documents`.
  - E3 (sanctioned): add `const [profilesLoading, setProfilesLoading] = useState(false)` — set `true` before `getProfiles(lang)` in the effect, `false` in both `.then` and `.catch` (only when not cancelled); change the profile select's `disabled={lang === null}` to `disabled={lang === null || profilesLoading}`.
- [ ] **Step 6: frontend gate; commit** — `fix(folders): prune dangling defaults from rename/set-defaults responses; dialog 404 refresh + refetch guard`

### Task 5: Backend logging + dead seeding conditionals + shared env-key map (A4, D2, D9)

**Files:**
- Modify: `backend/app/api/documents.py` (generate_name, line ~192), `backend/app/api/checks.py` (line ~121), `backend/app/api/providers.py` (4 except sites), `backend/app/api/routing.py`, `backend/app/core/config.py`, `backend/app/services/seed_profiles.py`

- [ ] **Step 1 (A4):** add module loggers and warning logs at every swallow site. Pattern per file: `import logging` … `logger = logging.getLogger(__name__)` at module top, then:
  - `documents.py` generate_name except: `logger.warning("auto-title generation failed for document %s", document_id, exc_info=True)` before `title = None`.
  - `checks.py` LLM-task except: `logger.warning("llm check failed (provider %s): %s", provider.name, error)` before the `checker_error` emit.
  - `providers.py`: in `_ollama_entry`'s except: `logger.info("ollama discovery failed: %s", exc)` (bind `except Exception as exc:`); same pattern (`logger.info`, provider name, exc) in `_openai_compat_entry`, `_claude_entry`, `_bedrock_entry`.
  - `routing.py` `_provider_status` ollama except: `logger.info("ollama ping failed: %s", exc)`.
  Log levels: `warning` where a user-visible feature degraded (title, check), `info` for expected-absent providers. NEVER log document text, prompts, or key values.
- [ ] **Step 2 (D2):** in `seed_profiles.py` delete lines 10-11 (`EXAMPLE_LANGUAGES` / `BLOG_LANGUAGES`) and the two conditions using them: drop `and language in EXAMPLE_LANGUAGES` from the seed-examples condition (line ~174) and unwrap the `if language in BLOG_LANGUAGES:` block (line ~198) so the Blog profile seeds unconditionally (dedent its body). Both sets equal `set(Language)`, so behavior is identical. Verify: `grep -rn "EXAMPLE_LANGUAGES\|BLOG_LANGUAGES" backend` returns nothing.
- [ ] **Step 3 (D9):** move the `name -> env key` map to config so the three per-provider surfaces share one source: in `core/config.py` add near `BUILTIN_PROVIDERS`/`TIERS`:

```python
# Env variable per built-in API provider (extras derive theirs by name:
# <NAME>_API_KEY). Shared by the providers and routing routers.
BUILTIN_ENV_KEYS = {
    "claude": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "mistral": "MISTRAL_API_KEY",
}
```

In `routing.py` delete the local `_BUILTIN_ENV_KEYS` and import `BUILTIN_ENV_KEYS` from `app.core.config` (adjust the two uses). In `providers.py`, replace the hardcoded `"OPENAI_API_KEY"` / `"MISTRAL_API_KEY"` arguments in `list_providers` with `BUILTIN_ENV_KEYS["openai"]` / `BUILTIN_ENV_KEYS["mistral"]`, and `"ANTHROPIC_API_KEY"` in `_claude_entry` with `BUILTIN_ENV_KEYS["claude"]`.
- [ ] **Step 4: backend gate** (`uv run pytest -q`) — zero warnings; logging is additive so nothing changes.
- [ ] **Step 5: Commit** — `refactor(backend): log swallowed failures; drop dead seeding conditionals; single provider env-key map`

### Task 6: Shared name validation + term non-empty check (D1)

**Files:**
- Create: `backend/app/api/validation.py`
- Modify: `backend/app/api/documents.py` (2 sites), `backend/app/api/profiles.py` (2 sites), `backend/app/api/folders.py` (`_validated_name`), `backend/app/api/terminology.py` (create_term, update_term)
- Test: the existing terminology API test file (find via `grep -rl "create_term\|/terms" backend/tests`)

**Interfaces:**
- Produces: `validate_name(raw: str, *, message: str, max_len: int | None = None) -> str` — strips, raises `HTTPException(422, message)` when empty, enforces optional max length with the folder router's existing message text.

- [ ] **Step 1: Failing test:** POST a term with `preferred: "   "` → expect 422 `"Preferred term must not be empty"`; PUT an existing term with `preferred: ""` → 422 as well (a `None` preferred still means "unchanged" and stays 200).
- [ ] **Step 2: Watch both fail** (currently 201/200).
- [ ] **Step 3: Implement** `backend/app/api/validation.py`:

```python
from fastapi import HTTPException


def validate_name(raw: str, *, message: str, max_len: int | None = None) -> str:
    """Shared name guard: strip, reject empty, optionally cap the length.

    The message is per-entity ("Document name must not be empty", ...) so
    existing client-visible 422 texts stay byte-identical.
    """
    name = raw.strip()
    if not name:
        raise HTTPException(422, message)
    if max_len is not None and len(name) > max_len:
        raise HTTPException(422, f"Folder name must be at most {max_len} characters")
    return name
```

Replace the four copy-pasted guards, preserving each exact message: `documents.py` create (line 78) and update (121) → `validate_name(body.name, message="Document name must not be empty")` (use the return value where `.strip()` was used); `profiles.py` create (65) and update (94) → `"Profile name must not be empty"` (update also keeps the `is_standard` rename check comparing against the validated name); `folders.py` `_validated_name` body → `return validate_name(raw, message="Folder name must not be empty", max_len=_MAX_NAME)`. In `terminology.py`: `create_term` validates `preferred=validate_name(body.preferred, message="Preferred term must not be empty")`; `update_term` validates only when `body.preferred is not None`.
- [ ] **Step 4: backend gate.** The generic max-len message hardcodes "Folder" — acceptable since only folders pass `max_len`; note it in the docstring (already done above).
- [ ] **Step 5: Commit** — `refactor(api): shared validate_name; backend guard for empty preferred terms`

### Task 7: Shared SQLite helpers + folders collation migration + DDL fixture dedup (C2, A7, B3)

**Files:**
- Create: `backend/app/services/_sqlite.py`
- Modify: `backend/app/services/documents.py`, `folders.py`, `profiles.py`, `terminology.py`
- Modify: tests with inline old-schema DDL — `backend/tests/test_documents.py` (lines ~145, ~252), `test_folders.py` (~84), `test_profiles.py` (~213)
- Test: `backend/tests/test_folders.py` (new migration cases)

**Interfaces:**
- Produces: `connect(db_path: Path) -> Iterator[sqlite3.Connection]` (contextmanager) and `migrate_columns(conn: sqlite3.Connection, table: str, columns: Sequence[tuple[str, str]]) -> None` in `_sqlite.py`.

- [ ] **Step 1 (C2): implement `_sqlite.py`:**

```python
"""Shared SQLite plumbing for the service stores (one DB file, four stores)."""

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def connect(db_path: Path) -> Iterator[sqlite3.Connection]:
    # sqlite3's own context manager only wraps a transaction (commit or
    # rollback); this wrapper also closes the connection afterwards, so
    # `with connect(...) as conn:` cannot leak connections.
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def migrate_columns(
    conn: sqlite3.Connection, table: str, columns: Sequence[tuple[str, str]]
) -> None:
    """Add any missing columns (name, declaration). Pre-existing databases
    lack columns added in later iterations; guarded by name, idempotent."""
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    for name, decl in columns:
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
```

In each of the four stores: delete the local `_connect` method and replace every `self._connect()` with `_sqlite.connect(self.db_path)` via a one-line delegate to keep call sites unchanged:

```python
    def _connect(self) -> Iterator[sqlite3.Connection]:
        return connect(self.db_path)
```

Wait — the delegate must keep the contextmanager typing; simplest faithful form (use exactly this):

```python
    from app.services._sqlite import connect  # module-level import

    def _connect(self):  # thin delegate; the shared helper carries the docs
        return connect(self.db_path)
```

(`connect(...)` already returns a context manager, so `with self._connect() as conn:` behaves identically.) Rewrite the three `_migrate` bodies onto `migrate_columns`: documents keeps its two follow-up `UPDATE documents SET ... = updated_at` statements (run them only when the respective column was missing — check membership BEFORE calling migrate_columns, e.g. compute `missing = {...}` first); folders passes its 7-tuple list; profiles passes `[("llm_tier", "TEXT"), ("packs_on", "TEXT NOT NULL DEFAULT '[]'")]`.
- [ ] **Step 2: backend gate** — all existing migration tests must pass unchanged (they build old-schema DBs and verify the migrated shape).
- [ ] **Step 3 (A7): failing migration test** in `test_folders.py`: build a pre-existing DB with the current schema and two folders 'Blog' and 'Notes'; re-open the store; assert `create_folder('blog')` raises `ValueError` (case-insensitive duplicate now rejected) and `rename_folder` to 'NOTES' when 'Notes' exists (other id) raises too. Also an idempotency case: opening the store twice is fine. And a duplicates-present case: a hand-built DB containing BOTH 'Blog' and 'blog' must still open (migration skipped, warning logged) and `list_folders` still returns both.
- [ ] **Step 4: implement A7** in `FolderStore._migrate` (after the column loop):

```python
        # Names are ordered case-insensitively but were historically UNIQUE
        # case-sensitively; enforce NOCASE uniqueness via an index (an inline
        # constraint can't be altered without a table rebuild). Skipped —
        # with a warning — if legacy data already holds case-duplicates.
        duplicates = conn.execute(
            "SELECT name FROM folders GROUP BY lower(name) HAVING count(*) > 1"
        ).fetchall()
        if duplicates:
            logger.warning(
                "folders table has case-duplicate names %s; "
                "skipping NOCASE unique index",
                [row[0] for row in duplicates],
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_name_nocase "
                "ON folders(name COLLATE NOCASE)"
            )
```

with `import logging` / `logger = logging.getLogger(__name__)` at module top. The live-DB rehearsal (controller already scanned a copy: 2 folders, no duplicates) must be repeated by the implementer: copy `backend/data/fabulous.db` to a temp dir, `FolderStore(copy_path)`, assert the index exists (`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_folders_name_nocase'`), then DELETE the copy. Never open the original.
- [ ] **Step 5 (B3):** hoist each duplicated inline old-schema DDL into a module-level constant in its test file (e.g. `_SCHEMA_BEFORE_FOLDERS`, `_SCHEMA_BEFORE_TIMESTAMPS` in `test_documents.py`); the two near-identical copies at lines ~145/~252 differ deliberately (different missing columns) — keep two constants if they genuinely differ, one if not. Same treatment in `test_folders.py` and `test_profiles.py`.
- [ ] **Step 6: backend gate; commit** — `refactor(services): shared sqlite connect/migrate helpers; case-insensitive folder-name uniqueness; dedupe test DDL fixtures`

### Task 8: LLM provider HTTP skeleton (C3)

Ollama and OpenAI-compat duplicate the whole request/streaming/progress shape. Extract a shared httpx skeleton; the SDK-based Claude/Bedrock providers stay as they are (their shape similarity is superficial — different transports).

**Files:**
- Create: `backend/app/checkers/llm/_http_chat.py`
- Modify: `backend/app/checkers/llm/ollama.py`, `backend/app/checkers/llm/openai_compat.py`
- Tests: existing `backend/tests/test_openai_compat.py` and the Ollama provider tests (locate via `grep -rl "OllamaProvider" backend/tests`) must pass unchanged — they define behavior.

**Interfaces:**
- Produces `HttpChatProvider` base class. Subclasses supply `_client()`, `_chat_path`, `_response_text(data)`, `_stream_events(line)`.

- [ ] **Step 1: implement `_http_chat.py`:**

```python
"""Shared skeleton for HTTP chat-completion providers (Ollama, OpenAI-compat).

Both speak "POST a {model, stream, messages} payload; non-streaming returns
one JSON body; streaming yields lines". Subclasses supply the endpoint path,
the response/line parsers, and the configured httpx client.
"""

from abc import ABC, abstractmethod
from collections.abc import Iterable

import httpx

from .provider import ProgressCallback

# One parsed streaming line: ("content", text) appends and counts progress,
# ("tokens", n) reports an exact token count, ("done", "") ends the stream.
StreamEvent = tuple[str, str | int]


class HttpChatProvider(ABC):
    model: str

    @abstractmethod
    def _client(self) -> httpx.AsyncClient: ...

    @property
    @abstractmethod
    def _chat_path(self) -> str: ...

    @abstractmethod
    def _response_text(self, data: dict) -> str:
        """Extract the message text from a non-streaming response body."""

    @abstractmethod
    def _stream_events(self, line: str) -> Iterable[StreamEvent]:
        """Parse one streamed line into events (may yield nothing)."""

    def _payload(self, system: str, user: str, stream: bool) -> dict:
        return {
            "model": self.model,
            "stream": stream,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> str:
        payload = self._payload(system, user, stream=on_progress is not None)
        if on_progress is not None:
            return await self._generate_streaming(payload, on_progress)
        async with self._client() as client:
            response = await client.post(self._chat_path, json=payload)
            response.raise_for_status()
            return self._response_text(response.json())

    async def _generate_streaming(
        self, payload: dict, on_progress: ProgressCallback
    ) -> str:
        parts: list[str] = []
        async with self._client() as client:
            async with client.stream("POST", self._chat_path, json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    done = False
                    for kind, value in self._stream_events(line):
                        if kind == "content":
                            parts.append(str(value))
                            on_progress(len(parts))
                        elif kind == "tokens":
                            on_progress(int(value))
                        elif kind == "done":
                            done = True
                    if done:
                        break
        return "".join(parts)
```

- [ ] **Step 2: rebase `OllamaProvider`** on it — keep `__init__`, `name`, `list_models` as-is; delete `generate`/`_generate_streaming`; add:

```python
    _chat_path = "/api/chat"

    def _response_text(self, data: dict) -> str:
        return data["message"]["content"]

    def _stream_events(self, line: str) -> Iterable[StreamEvent]:
        # Ollama streams one NDJSON object per generated token; every parsed
        # line appends (even empty content), matching the pre-refactor
        # progress counting exactly.
        if not line.strip():
            return
        data = json.loads(line)
        yield ("content", data.get("message", {}).get("content", ""))
```

(`class OllamaProvider(HttpChatProvider):` — note `_chat_path` as a plain class attribute satisfies the abstract property; if the type checker objects, use the `@property` form.)
- [ ] **Step 3: rebase `OpenAICompatProvider`** likewise: `_chat_path = "/chat/completions"`, `_response_text` returns `data["choices"][0]["message"]["content"]`, and:

```python
    def _stream_events(self, line: str) -> Iterable[StreamEvent]:
        # SSE: one `data: {json}` line per chunk, `data: [DONE]` terminates.
        # Progress is chunk-counted (≈ tokens); a final usage chunk, when
        # present, corrects it to the exact output-token count.
        if not line.startswith("data: "):
            return
        data = line[len("data: ") :]
        if data.strip() == "[DONE]":
            yield ("done", "")
            return
        chunk = json.loads(data)
        usage = chunk.get("usage")
        if usage and usage.get("completion_tokens") is not None:
            yield ("tokens", usage["completion_tokens"])
            return
        choices = chunk.get("choices") or []
        content = choices[0].get("delta", {}).get("content") if choices else None
        if content:
            yield ("content", content)
```

- [ ] **Step 4: backend gate.** The provider tests pin request payloads, streaming accumulation, and progress counts — they must pass with ZERO test edits. If one fails, the skeleton diverged: fix the skeleton, not the test.
- [ ] **Step 5: Commit** — `refactor(llm): shared HTTP chat skeleton for ollama/openai-compat providers`

### Task 9: JSON extractor merge + RuleSpec.scope comment (D3, D7)

**Files:**
- Modify: `backend/app/checkers/llm/checker.py` (lines 28-57), `backend/app/checkers/rules/loader.py` (line 53)

- [ ] **Step 1 (D3):** replace the twin functions with one core:

```python
def _extract_json(response: str, open_ch: str, close_ch: str, expected: type) -> Any:
    """Extract a JSON value from an LLM response, tolerating fences and prose."""
    candidates = [response, _CODE_FENCE.sub("", response).strip()]
    start, end = response.find(open_ch), response.rfind(close_ch)
    if start != -1 and end > start:
        candidates.append(response[start : end + 1])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, expected):
            return data
    return None


def extract_json_array(response: str) -> list | None:
    return _extract_json(response, "[", "]", list)


def extract_json_object(response: str) -> dict | None:
    return _extract_json(response, "{", "}", dict)
```

(add `Any` to the existing `typing` import). Keep both public names — tests and callers import them.
- [ ] **Step 2 (D7):** annotate the dead-but-reserved field in `loader.py`:

```python
    # occurrence — `scope` is reserved: "sentence" is today's only value and
    # the engine always sentence-splits; widening it (paragraph/document)
    # would go here.
    scope: Literal["sentence"] = "sentence"
```

(replace the current bare `# occurrence` comment above those fields appropriately — keep `token`/`count`/`min`/`max` under the `# occurrence` group.)
- [ ] **Step 3: backend gate; commit** — `refactor(llm): single JSON extraction core; document reserved rule scope field`

### Task 10: Split documents.ts (C1)

Pure internal reorganization — NO behavior or export-semantics change beyond module paths. The 570-line file becomes four focused modules; the suppression flag moves next to its logic.

**Files:**
- Create: `frontend/src/documents/profileApply.ts`, `frontend/src/documents/list.ts`, `frontend/src/documents/folders.ts`, `frontend/src/documents/hydration.ts`, `frontend/src/documents/settings.ts`
- Modify: `frontend/src/documents/documents.ts`, `frontend/src/documents/autosave.ts` (settings block), `frontend/src/App.tsx`, `frontend/src/documents/DocumentSidebar.tsx`, `frontend/src/documents/FolderDefaultsDialog.tsx`, `frontend/src/documents/documents.test.ts` (imports only)

**Interfaces (module map — bodies move verbatim from documents.ts unless stated):**
- `profileApply.ts`: the `suppressProfileApply` flag, `consumeProfileApplySuppression`, `applyHeaderProfileSelection` (documents.ts lines 40-74, incl. their doc comments) plus a new setter used by hydration: `export function setProfileApplySuppressed(value: boolean): void { suppressProfileApply = value }`.
- `settings.ts`: new shared store→payload mapping, replacing BOTH `currentSettings()` (documents.ts:96-106) and the inline settings block in `collectSnapshot` (autosave.ts:81-89):

```typescript
import type { DocumentSettingsPayload } from '../api/client'
import type { Language, Tier } from '../types'

/** The document-settings payload as derived from header state — the single
 * mapping used by autosave snapshots and document creation alike. */
export function settingsPayload(s: {
  language: Language
  profileId: number | null
  domainIds: number[]
  provider: string
  model: string | null
  tier: Tier | null
  llmAuto: boolean
}): DocumentSettingsPayload {
  return {
    language: s.language,
    profile_id: s.profileId,
    domain_ids: s.domainIds,
    llm_provider: s.tier === null ? s.provider : null,
    llm_model: s.tier === null ? s.model : null,
    llm_tier: s.tier,
    llm_auto: s.llmAuto,
  }
}
```

  In autosave.ts `collectSnapshot`, the settings block becomes `settings: settingsPayload(state)`. In documents.ts, `currentSettings()` is deleted; its two call sites (`createNewDocument` base payload, `runInit` legacy create) use `...settingsPayload(state)` — note `settingsPayload` includes `language`, which those payloads also set explicitly to the same `state.language`; drop the now-redundant explicit `language:` field from both literals. Verify `DocumentSettingsPayload`'s exact field set in `api/client.ts` first; if it has no `language` field, keep `currentSettings`-style omission via destructuring instead — behavior must be byte-identical.
- `list.ts`: `refreshDocuments`, `refreshFolders` (documents.ts:238-253), `summaryOf` (83-94), `sortedByName` (255-259). Exported as needed.
- `folders.ts`: `applyFolderDefaults`, `saveFolderDefaults`, `addFolder`, `renameFolderById` (261-323). Imports from `./list`.
- `hydration.ts`: `skipRecoveryHydrate`, `replayOrphanedSnapshot`, `hydrateFromDocument` (+ `HydrateSource` type from Task 3), `hydrateFromBuffer`, `recoverSnapshot` (108-236, 427-474). Uses `setProfileApplySuppressed(doc.language !== store.language)` in place of the direct flag assignment; imports `cancelCheck`, autosave functions, buffer, `list.ts`.
- `documents.ts` keeps: `LEGACY_TEXT_KEY`, `fallbackName`, `removeFolder`, `moveDocumentToFolder` (they need `refreshDocuments`), `openDocument`, `createNewDocument`, `renameDocument`, `removeDocument`, `initDocuments`/`runInit`, and RE-EXPORTS for everything that moved (`export { applyFolderDefaults, saveFolderDefaults, addFolder, renameFolderById } from './folders'` etc.) so external imports keep working — then update the actual consumers (App.tsx → `./documents/profileApply`; DocumentSidebar.tsx / FolderDefaultsDialog.tsx → `./folders`, `./list`; documents.test.ts to the new specific modules) and DELETE the re-exports again, leaving documents.ts exporting only what it defines. No transitional re-exports may survive the task.

- [ ] **Step 1:** create the five new modules, moving code verbatim (docstrings/comments travel along); update all imports repo-wide (`grep -rn "from './documents'\|from '../documents/documents'" frontend/src`).
- [ ] **Step 2:** full frontend gate — `npx vitest run && npx tsc --noEmit && npm run lint && npm run build`. documents.test.ts must pass with only import-path edits; if an assertion breaks, the move changed behavior — stop and fix the move, not the test.
- [ ] **Step 3:** grep-verify no cycles were introduced where forbidden: `folders.ts`/`list.ts` must not import from `./documents` or `./hydration`.
- [ ] **Step 4: Commit** — `refactor(documents): split documents.ts into profileApply/list/folders/hydration/settings modules`

### Task 11: View hooks — shared CRUD error + outside-click dismissal (E1, E2)

Both sanctioned behavior changes live here, plus the pure dedup.

**Files:**
- Create: `frontend/src/hooks/useCrudError.ts`, `frontend/src/hooks/useDismissOnOutsideClick.ts`
- Modify: `frontend/src/profiles/ProfilesView.tsx`, `frontend/src/rules/RulesView.tsx`, `frontend/src/terminology/TerminologyView.tsx`, `frontend/src/header/DomainMultiSelect.tsx`, `frontend/src/header/LlmSelector.tsx`, `frontend/src/documents/DocumentSidebar.tsx`
- Modify: `frontend/src/i18n/messages.ts` + all 7 catalogs (`en de es fr it ja zh`): new key `changeFailed: (error: string) => string` (EN: `` (error) => `Change failed: ${error}` ``; translate in the other six matching each catalog's tone; JA/ZH translate the phrase, not the error text).
- Test: `frontend/src/i18n/i18n.test.ts` (parity test picks the new key up automatically — just run it)

**Interfaces:**

```typescript
// hooks/useCrudError.ts
import { useState } from 'react'

/** Shared mutation wrapper for CRUD views: formats a thrown error via the
 * given message fn, clears it on the next success. */
export function useCrudError(format: (message: string) => string) {
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(format(e instanceof Error ? e.message : String(e)))
    }
  }
  return { error, run }
}
```

```typescript
// hooks/useDismissOnOutsideClick.ts
import { useEffect, type RefObject } from 'react'

/** Close a popover/menu on any mousedown outside `ref` while `open`. */
export function useDismissOnOutsideClick(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return
    function onClickOutside(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) onDismiss()
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open, ref, onDismiss])
}
```

- [ ] **Step 1 (E1):** ProfilesView: replace `reportError` + the four try/catch shapes with `const { error, run } = useCrudError(m.profileChangeFailed)`; each mutation becomes `await run(async () => { ...existing body without try/catch/setError... })` — the success-path `setError(null)` calls disappear (run handles it); the exact error strings are unchanged. RulesView: same, replacing its inline duplicate. TerminologyView: add `const { error, run } = useCrudError(m.changeFailed)`; wrap the bodies of `addDomain`, `removeDomain`, `saveRename`, and (passing `run` down or lifting) `TermTable`'s `addTerm`, `saveEdit`, and the `deleteTerm(...).then(onChanged)` call (`await run(async () => { await deleteTerm(term.id); onChanged() })`); render `{error && <p className="crud-error">{error}</p>}` at the top of `.terminology` (add a minimal `.crud-error` style in App.css matching the existing error-text pattern — find `.profiles-view` / `.fd-error` styles and copy their color treatment). TermTable needs the error surface too: simplest is lifting `useCrudError` to `TerminologyView` and passing `run` as a prop to `TermTable`.
- [ ] **Step 2 (E2):** header components: replace both inline outside-click effects with the hook (pure dedup, zero behavior change). DocumentSidebar: in `FolderGroup` and `DocumentItem`, add a `menuRef = useRef<HTMLDivElement>(null)` on the `.doc-actions` div, use `useDismissOnOutsideClick(menuRef, menuOpen, close)` where `close` sets `menuOpen` false (and `moving` false in DocumentItem — keep it a stable `useCallback`), and REMOVE the `onMouseLeave` handlers from both `.doc-menu` divs. Sanctioned visible change: menus now stay open until an outside click.
- [ ] **Step 3:** i18n: add `changeFailed` to `messages.ts` and all 7 catalogs.
- [ ] **Step 4:** full frontend gate (i18n parity test enforces the catalogs).
- [ ] **Step 5: Commit** — `refactor(views): shared crud-error + outside-click hooks; terminology error surface; unified menu dismissal`

### Task 12: Extract sidebar pure helpers (C4)

Mechanical moves following the established sibling-module pattern (termTable.ts / catalog.ts / profile.ts). Components themselves stay put.

**Files:**
- Create: `frontend/src/documents/documentTime.ts`, `frontend/src/documents/grouping.ts`, `frontend/src/sidebar/findingList.ts`
- Modify: `frontend/src/documents/DocumentSidebar.tsx`, `frontend/src/sidebar/Sidebar.tsx`, `frontend/src/documents/DocumentSidebar.test.tsx` (imports)

- [ ] **Step 1:** move `relativeTime` and `absoluteTime` (DocumentSidebar.tsx lines 19-39, with their doc comments, dropping the now-unneeded `oxlint-disable` lines) to a new `documents/documentTime.ts`, and `groupDocuments` (lines 41-58) to a new `documents/grouping.ts`. Update imports in `DocumentSidebar.tsx` and `DocumentSidebar.test.tsx`.
- [ ] **Step 2:** move `withCurrentSpans` and `truncate` (Sidebar.tsx lines 428-437) to `sidebar/findingList.ts`, exported; import them in Sidebar.tsx.
- [ ] **Step 3:** full frontend gate; verify `npm run lint` reports no `react/only-export-components` suppressions left in DocumentSidebar.tsx (`grep -c "oxlint-disable" frontend/src/documents/DocumentSidebar.tsx` → 0).
- [ ] **Step 4: Commit** — `refactor(views): extract pure sidebar helpers to sibling modules`

### Task 13: Anchoring boundary tests (B2)

Additive tests against `backend/app/checkers/llm/anchoring.py` (unchanged production code).

**Files:**
- Test: `backend/tests/test_anchoring.py`

- [ ] **Step 1: add the cases:**

```python
def test_three_way_ambiguity_prefers_context_match() -> None:
    text = "It was very cold. He felt very tired. She was very sad indeed."
    span = anchor(text, "very", context_before="He felt ")
    assert span is not None
    assert span.start == text.index("very", text.index("He"))  # the middle one


def test_whitespace_tolerant_with_multiple_occurrences() -> None:
    text = "the quick\nbrown fox ran. Later the quick brown fox slept."
    span = anchor(text, "quick brown fox", context_before="Later the ")
    assert span is not None
    assert span.start == text.index("quick", 20)


def test_fuzzy_near_miss_below_threshold_returns_none() -> None:
    # Shares many characters but stays under the 0.8 ratio for every window.
    text = "The committee approved the annual budget yesterday."
    assert anchor(text, "The komitee rejekted the anual budgit tomorow??") is None


def test_fuzzy_refine_window_trims_to_quote() -> None:
    text = "xxA colour-ful paintingzz hangs there."
    span = anchor(text, "A colorful painting")
    assert span is not None
    # The refined window must start at (or within 2 chars of) the real phrase,
    # not at the raw window position.
    assert abs(span.start - text.index("A colour")) <= 2
    assert "painting" in span.text
```

- [ ] **Step 2:** run `uv run pytest tests/test_anchoring.py -v`. These pin EXISTING behavior — if one fails, first verify by hand (Python REPL) what `anchor()` actually returns for that input and adjust the assertion to the true current behavior (this is characterization, not a bug hunt); only escalate if the true behavior is outright wrong (e.g. picks an occurrence contradicting the context).
- [ ] **Step 3:** full backend gate; commit — `test(anchoring): pin ambiguity, whitespace-tolerant, and fuzzy boundary behavior`

### Task 14: Docs, baseline re-run, wrap-up

**Files:**
- Modify: `docs/backend-architecture.md`, `docs/frontend-architecture.md` (module split, shared helpers, provider skeleton, hooks, logging, NOCASE index), `docs/LOGBOOK.md` (dated entry — run `date '+%Y-%m-%d'` first — with commit pointers)

- [ ] **Step 1:** update both architecture docs to reflect: documents.ts module split (new file map), shared `_sqlite.py`, `validation.py`, `_http_chat.py`, the two hooks, backend logging, the folders NOCASE unique index, `cancelCheck` in the check flow.
- [ ] **Step 2:** append the LOGBOOK entry.
- [ ] **Step 3:** re-run BOTH full gates one final time.
- [ ] **Step 4 (controller-level):** re-run the Phase-0 e2e baseline (`.superpowers/sdd/baseline/`, per its README) against a fresh scratch stack — all checks must pass as before the refactor (E2's menu-dismissal change may require updating the baseline script IF it drives menus via hover-out; check the script and adjust in the same commit as documented in the baseline README).
- [ ] **Step 5:** commit docs — `docs: architecture + logbook for cleanup iteration` — then final whole-branch review (fable), push the `codebase-cleanup` branch, open a PR against main for the independent Copilot review, and report CI.
