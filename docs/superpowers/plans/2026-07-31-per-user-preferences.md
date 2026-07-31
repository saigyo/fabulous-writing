# Per-User UI Preference Survival (B1, #34) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preferences (UI locale, collapse states, last document) survive per user in their own localStorage namespace — across logout, session expiry, and user switches — instead of being purged on every user change.

**Architecture:** Drop the zustand `persist` middleware from the app store and replace it with an explicit two-module persistence layer: `prefsStorage.ts` (pure localStorage I/O, no store dependency) and `prefsPersistence.ts` (atomic load-with-defaults, guarded write subscriber, boot wiring). The session token moves to its own key. One ordering invariant governs session transitions: bulk pref resets/loads happen only while the store's `user` is null.

**Tech Stack:** React 19 / TypeScript / Vite frontend; zustand (kept — only its `persist` middleware goes); vitest + happy-dom. No backend changes.

**Spec:** `docs/superpowers/specs/2026-07-31-per-user-preferences-design.md` — binding; read it before deviating from anything here.

## Global Constraints

- Frontend gates before every commit: `npm test -- --run` green and `npm run build` clean (both from `frontend/`).
- **Mutation-verify every guard test:** delete (or invert) the guard the test pins, watch the test fail, restore it. Each task's steps name the exact mutation.
- Storage format is the zustand-persist-compatible envelope `{"state": {...}, "version": 2}` under key `fabulous-writing-settings:<user.id>`; token under `fabulous-writing-token`; legacy key `fabulous-writing-settings` deleted once at boot, never read (clean break — nothing is migrated).
- Ordering invariant (spec): pref fields are only bulk-reset or bulk-loaded while `user` is null. On the way in, `loadUserPrefs(user.id)` runs before `setAuth(token, user)`; on the way out, `setAuth(null, null)` runs before `resetSessionState()`.
- The write subscriber never writes while `state.user` is null, and never on changes that touch no pref field.
- Never widen a wall-clock test bound.
- Every commit message ends with exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`

## File Structure

- Create `frontend/src/state/prefsStorage.ts` — localStorage I/O only: `Prefs` schema type, `PREF_KEYS`, `PREFS_VERSION`, token accessors, `readPrefs`/`writePrefs`, `deleteLegacyBlob`, `prefsKey`. Imports nothing from the store at runtime (breaks the would-be `store.ts` ↔ persistence cycle).
- Create `frontend/src/state/prefsStorage.test.ts`.
- Create `frontend/src/state/prefsPersistence.ts` — store-aware layer: `PREFS_DEFAULTS`, `loadUserPrefs`, `initPrefsPersistence` (legacy-key deletion + write subscriber). Imports both `store.ts` and `prefsStorage.ts`.
- Create `frontend/src/state/prefsPersistence.test.ts`.
- Modify `frontend/src/state/store.ts` — remove `persist` wrapper and `persistConfig`; initial `token` from `readToken()`; simplify `resetSessionState()`.
- Modify `frontend/src/auth/session.ts` — invariant ordering in `login`/`logout`/`expireSession`/`runRestore`; token key writes.
- Modify `frontend/src/main.tsx` — call `initPrefsPersistence()` at boot.
- Modify `frontend/src/state/store.test.ts` (drop `persistConfig` tests), `frontend/src/auth/session.test.ts` (stale comment; new B1 tests).
- Modify `docs/frontend-architecture.md` — replace the persist-middleware section.

---

### Task 1: `prefsStorage.ts` — pure localStorage I/O

**Files:**
- Create: `frontend/src/state/prefsStorage.ts`
- Test: `frontend/src/state/prefsStorage.test.ts`

**Interfaces:**
- Consumes: nothing project-internal except `type Locale` from `../i18n/messages`.
- Produces (used by Tasks 2–4): `interface Prefs`, `PREF_KEYS: readonly (keyof Prefs)[]`, `PREFS_VERSION = 2`, `prefsKey(userId: number): string`, `readToken(): string | null`, `writeToken(token: string): void`, `clearToken(): void`, `readPrefs(userId: number): Partial<Prefs> | null`, `writePrefs(userId: number, prefs: Prefs): void`, `deleteLegacyBlob(): void`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/state/prefsStorage.test.ts`:

```typescript
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearToken,
  prefsKey,
  readPrefs,
  readToken,
  writePrefs,
  writeToken,
  type Prefs,
} from './prefsStorage'

beforeEach(() => {
  localStorage.clear()
})

const prefs: Prefs = {
  uiLocale: 'de',
  lastProfileByLanguage: { en: 3 },
  rulesCollapsed: ['style'],
  currentDocId: 7,
  docSidebarCollapsed: true,
  docFoldersCollapsed: [1, 2],
}

describe('token accessors', () => {
  it('round-trips under the token key and clears', () => {
    expect(readToken()).toBeNull()
    writeToken('tok')
    expect(localStorage.getItem('fabulous-writing-token')).toBe('tok')
    expect(readToken()).toBe('tok')
    clearToken()
    expect(readToken()).toBeNull()
  })
})

describe('readPrefs / writePrefs', () => {
  it('round-trips a blob in the zustand-persist envelope', () => {
    writePrefs(1, prefs)
    expect(JSON.parse(localStorage.getItem(prefsKey(1))!)).toEqual({
      state: prefs,
      version: 2,
    })
    expect(readPrefs(1)).toEqual(prefs)
  })

  it('keeps namespaces separate per user id', () => {
    writePrefs(1, prefs)
    expect(readPrefs(2)).toBeNull()
  })

  it('returns null for a missing blob', () => {
    expect(readPrefs(1)).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    localStorage.setItem(prefsKey(1), '{not json')
    expect(readPrefs(1)).toBeNull()
  })

  it('returns null for a wrong version', () => {
    localStorage.setItem(
      prefsKey(1),
      JSON.stringify({ state: prefs, version: 3 }),
    )
    expect(readPrefs(1)).toBeNull()
  })

  it('returns null for an envelope without a state object', () => {
    localStorage.setItem(prefsKey(1), JSON.stringify({ version: 2 }))
    expect(readPrefs(1)).toBeNull()
  })

  it('drops unknown keys instead of smuggling them into the store', () => {
    localStorage.setItem(
      prefsKey(1),
      JSON.stringify({ state: { uiLocale: 'de', token: 'evil' }, version: 2 }),
    )
    expect(readPrefs(1)).toEqual({ uiLocale: 'de' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npm test -- --run src/state/prefsStorage.test.ts`
Expected: FAIL — module `./prefsStorage` does not exist.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/state/prefsStorage.ts`:

```typescript
import type { Locale } from '../i18n/messages'

/** The persisted-preferences schema (B1, #34). Deliberately declared
 * standalone rather than derived from the store type: this is a storage
 * contract — changing it is a schema change and must be a conscious
 * decision (bump PREFS_VERSION and add a read-side migration when the
 * shape changes incompatibly). */
export interface Prefs {
  uiLocale: Locale | null
  lastProfileByLanguage: Record<string, number>
  rulesCollapsed: string[]
  currentDocId: number | null
  docSidebarCollapsed: boolean
  docFoldersCollapsed: number[]
}

export const PREF_KEYS = [
  'uiLocale',
  'lastProfileByLanguage',
  'rulesCollapsed',
  'currentDocId',
  'docSidebarCollapsed',
  'docFoldersCollapsed',
] as const satisfies readonly (keyof Prefs)[]

// Continues the legacy blob's numbering (it retired at v2) so the version
// number never moves backwards. There are no older versions to migrate:
// any other version is discarded and defaults apply.
export const PREFS_VERSION = 2

const TOKEN_KEY = 'fabulous-writing-token'
// The pre-B1 single blob that mixed the token with the last user's
// preferences. Deleted once at boot (see prefsPersistence.ts), never read.
const LEGACY_KEY = 'fabulous-writing-settings'

export const prefsKey = (userId: number): string =>
  `fabulous-writing-settings:${userId}`

// All accessors swallow storage failures (quota, privacy mode) exactly as
// the persist middleware did: reads fall back to null, writes are
// best-effort — the app then runs with in-memory state only.

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function writeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Without storage the session just won't survive a reload.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing to clear if storage itself is unavailable.
  }
}

export function deleteLegacyBlob(): void {
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // Best-effort; an unremovable legacy key is never read anyway.
  }
}

/** Returns the stored preference fields for the user, or null when absent,
 * unparseable, or not the current schema version — callers treat all three
 * identically (defaults apply; the next write replaces the blob). Unknown
 * keys are dropped so a blob can never smuggle extra fields into the
 * store. */
export function readPrefs(userId: number): Partial<Prefs> | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(prefsKey(userId))
  } catch {
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const envelope = parsed as { version?: unknown; state?: unknown }
  if (envelope.version !== PREFS_VERSION) return null
  if (typeof envelope.state !== 'object' || envelope.state === null) return null
  const state = envelope.state as Record<string, unknown>
  const prefs: Partial<Prefs> = {}
  for (const key of PREF_KEYS) {
    if (key in state) {
      ;(prefs as Record<string, unknown>)[key] = state[key]
    }
  }
  return prefs
}

/** zustand-persist-compatible envelope: {"state": {...}, "version": 2} —
 * keeps a future return to the middleware possible without a storage-format
 * migration. */
export function writePrefs(userId: number, prefs: Prefs): void {
  try {
    localStorage.setItem(
      prefsKey(userId),
      JSON.stringify({ state: prefs, version: PREFS_VERSION }),
    )
  } catch {
    // Best-effort, matching the middleware's behavior under quota/privacy.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/state/prefsStorage.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Mutation-verify the guards**

1. In `readPrefs`, change `envelope.version !== PREFS_VERSION` to `false` → the wrong-version test must fail. Restore.
2. In `readPrefs`, replace the `PREF_KEYS` filter loop with `return state as Partial<Prefs>` → the unknown-keys test must fail. Restore.
3. Re-run: `npm test -- --run src/state/prefsStorage.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/prefsStorage.ts frontend/src/state/prefsStorage.test.ts
git commit -m "feat(state): prefsStorage — per-user pref blobs and token key I/O (B1, #34)"
```
(with the two mandatory trailer lines from Global Constraints)

---

### Task 2: `prefsPersistence.ts` — loader, write subscriber, boot wiring

**Files:**
- Create: `frontend/src/state/prefsPersistence.ts`
- Test: `frontend/src/state/prefsPersistence.test.ts`

**Interfaces:**
- Consumes: `INITIAL_DATA`, `useStore` from `./store` (both already exported); Task 1's `prefsStorage` exports.
- Produces (used by Tasks 3–4): `PREFS_DEFAULTS: Prefs`, `loadUserPrefs(userId: number): void`, `initPrefsPersistence(): void` (idempotent).

**Note:** in this task the module is still inert — nothing calls it yet. Wiring into boot and session flow is Task 3. The store still carries the persist middleware until Task 3; that coexistence is harmless in tests (the middleware writes the legacy key, this module reads/writes only namespaced keys).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/state/prefsPersistence.test.ts`:

```typescript
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import {
  initPrefsPersistence,
  loadUserPrefs,
  PREFS_DEFAULTS,
} from './prefsPersistence'
import { prefsKey, writePrefs } from './prefsStorage'
import { useStore } from './store'

function user(id: number): MeResponse {
  return {
    id,
    email: `user${id}@example.com`,
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
    usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
    limits: {
      max_document_chars: 200000,
      max_llm_document_chars: 200000,
      concurrent_llm_runs: 5,
    },
    allow_additional_admins: false,
  }
}

initPrefsPersistence()

beforeEach(() => {
  localStorage.clear()
  useStore.setState({
    ...PREFS_DEFAULTS,
    token: null,
    user: null,
    authStatus: 'anonymous',
  })
})

describe('loadUserPrefs', () => {
  it('applies stored values over defaults', () => {
    writePrefs(1, {
      ...PREFS_DEFAULTS,
      uiLocale: 'de',
      currentDocId: 7,
      docFoldersCollapsed: [3],
    })
    loadUserPrefs(1)
    const state = useStore.getState()
    expect(state.uiLocale).toBe('de')
    expect(state.currentDocId).toBe(7)
    expect(state.docFoldersCollapsed).toEqual([3])
    expect(state.docSidebarCollapsed).toBe(false)
  })

  it("resets to defaults for a user with no blob even when memory holds another user's values (the #34 leak)", () => {
    useStore.setState({
      uiLocale: 'de',
      currentDocId: 42,
      docSidebarCollapsed: true,
      rulesCollapsed: ['style'],
    })
    loadUserPrefs(2)
    const state = useStore.getState()
    expect(state.uiLocale).toBeNull()
    expect(state.currentDocId).toBeNull()
    expect(state.docSidebarCollapsed).toBe(false)
    expect(state.rulesCollapsed).toEqual([])
  })

  it('merges a partial blob over defaults (fields absent from storage reset)', () => {
    useStore.setState({ docSidebarCollapsed: true })
    localStorage.setItem(
      prefsKey(1),
      JSON.stringify({ state: { uiLocale: 'fr' }, version: 2 }),
    )
    loadUserPrefs(1)
    expect(useStore.getState().uiLocale).toBe('fr')
    expect(useStore.getState().docSidebarCollapsed).toBe(false)
  })
})

describe('write subscriber', () => {
  it("writes pref changes to the signed-in user's namespace, envelope format, six fields only", () => {
    useStore.getState().setAuth('tok', user(1))
    useStore.getState().setUiLocale('fr')
    const blob = JSON.parse(localStorage.getItem(prefsKey(1))!)
    expect(blob.version).toBe(2)
    expect(blob.state.uiLocale).toBe('fr')
    // Exactly the six pref fields — never token, never user.
    expect(Object.keys(blob.state).sort()).toEqual([
      'currentDocId',
      'docFoldersCollapsed',
      'docSidebarCollapsed',
      'lastProfileByLanguage',
      'rulesCollapsed',
      'uiLocale',
    ])
  })

  it('does not write while logged out', () => {
    useStore.getState().setUiLocale('fr')
    // Assert on the namespaced keys, not localStorage.length: until Task 3
    // lands, the still-installed persist middleware writes the legacy key
    // on every setState, and after Task 3 other tests may share storage.
    expect(localStorage.getItem(prefsKey(1))).toBeNull()
    expect(localStorage.getItem(prefsKey(2))).toBeNull()
  })

  it('does not write when only non-persisted fields change', () => {
    useStore.getState().setAuth('tok', user(1))
    localStorage.removeItem(prefsKey(1))
    useStore.getState().setDocWords(50)
    useStore.getState().setCheckPhase('fast')
    useStore.getState().setLanguage('de')
    expect(localStorage.getItem(prefsKey(1))).toBeNull()
  })
})

describe('boot wiring', () => {
  it('initPrefsPersistence deletes the legacy pre-B1 blob', async () => {
    vi.resetModules()
    localStorage.setItem(
      'fabulous-writing-settings',
      '{"state":{"uiLocale":"de"},"version":2}',
    )
    const fresh = await import('./prefsPersistence')
    fresh.initPrefsPersistence()
    expect(localStorage.getItem('fabulous-writing-settings')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/state/prefsPersistence.test.ts`
Expected: FAIL — module `./prefsPersistence` does not exist.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/state/prefsPersistence.ts`:

```typescript
import {
  deleteLegacyBlob,
  PREF_KEYS,
  readPrefs,
  writePrefs,
  type Prefs,
} from './prefsStorage'
import { INITIAL_DATA, useStore } from './store'

/** The six persisted fields' slice of INITIAL_DATA — the single defaults
 * definition shared by the loader, the tests, and (via spread) every
 * load. */
export const PREFS_DEFAULTS: Prefs = {
  uiLocale: INITIAL_DATA.uiLocale,
  // Collection fields are copied, not aliased: INITIAL_DATA is the baseline
  // every resetSessionState() restores from, and sharing its object
  // identities here would let one future in-place mutation corrupt that
  // baseline for every user.
  lastProfileByLanguage: { ...INITIAL_DATA.lastProfileByLanguage },
  rulesCollapsed: [...INITIAL_DATA.rulesCollapsed],
  currentDocId: INITIAL_DATA.currentDocId,
  docSidebarCollapsed: INITIAL_DATA.docSidebarCollapsed,
  docFoldersCollapsed: [...INITIAL_DATA.docFoldersCollapsed],
}

const pick = (state: Prefs): Prefs => ({
  uiLocale: state.uiLocale,
  lastProfileByLanguage: state.lastProfileByLanguage,
  rulesCollapsed: state.rulesCollapsed,
  currentDocId: state.currentDocId,
  docSidebarCollapsed: state.docSidebarCollapsed,
  docFoldersCollapsed: state.docFoldersCollapsed,
})

/** Applies the user's stored preferences over the declared defaults in ONE
 * atomic setState. Reset and hydration being a single step is what makes
 * the #34 leak impossible: a user with no blob gets exactly the defaults,
 * never the previous user's in-memory values. Must run while the store's
 * `user` is still null (the ordering invariant — see session.ts) so the
 * write subscriber below stays silent. */
export function loadUserPrefs(userId: number): void {
  useStore.setState({ ...PREFS_DEFAULTS, ...readPrefs(userId) })
}

let initialized = false

/** Boot wiring, called once from main.tsx (idempotent for tests): deletes
 * the legacy pre-B1 blob (clean break — never read) and registers the
 * write subscriber. */
export function initPrefsPersistence(): void {
  if (initialized) return
  initialized = true
  deleteLegacyBlob()
  useStore.subscribe((state, prev) => {
    // Reference comparison is exact: pref fields only change via their
    // setters, which always produce new values. Skipping unchanged states
    // keeps high-frequency transient updates (docWords/docChars on every
    // keystroke) away from localStorage.
    if (PREF_KEYS.every((key) => state[key] === prev[key])) return
    // Never write while logged out: the login gate cannot pollute any
    // namespace, and session-teardown resets (which run after
    // setAuth(null, null) per the ordering invariant) land nowhere.
    if (!state.user) return
    writePrefs(state.user.id, pick(state))
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/state/prefsPersistence.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Mutation-verify the guards**

1. In `loadUserPrefs`, change the setState to `useStore.setState({ ...readPrefs(userId) })` (drop the defaults spread) → the #34-leak test must fail. Restore.
2. In the subscriber, delete the `if (!state.user) return` line → the does-not-write-while-logged-out test must fail. (It fails with a `TypeError` on `state.user.id`, and the cascade takes most of the file with it — that satisfies this gate, but note the *behavioral* consequence the guard exists for, a teardown reset landing in the departing user's namespace, is only genuinely pinned by Task 4's logout-survival test.) Restore.
3. In the subscriber, delete the `PREF_KEYS.every(...)` early return → the non-persisted-fields test must fail. Restore.
4. Re-run: `npm test -- --run src/state/prefsPersistence.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/prefsPersistence.ts frontend/src/state/prefsPersistence.test.ts
git commit -m "feat(state): prefsPersistence — atomic per-user pref load and guarded write subscriber (B1, #34)"
```
(with the two mandatory trailer lines)

---

### Task 3: The switchover — store, session ordering, boot

This is one coherent task: removing the middleware, re-ordering the session transitions, and wiring boot interlock — splitting them would leave non-working intermediate states.

**Files:**
- Modify: `frontend/src/state/store.ts` (imports, `persistConfig` block, store creation, `resetSessionState`)
- Modify: `frontend/src/auth/session.ts` (`login`, `logout`, `expireSession`, `runRestore`, imports)
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/state/store.test.ts` (remove two `persistConfig` tests)
- Modify: `frontend/src/auth/session.test.ts` (stale header comment; two adjusted expectations)

**Interfaces:**
- Consumes: Task 1's `readToken`/`writeToken`/`clearToken`; Task 2's `loadUserPrefs`/`initPrefsPersistence`.
- Produces: the final shapes of `login`/`logout`/`expireSession`/`restoreSession` that Task 4's acceptance tests exercise; `resetSessionState()` as a pure in-memory reset.

- [ ] **Step 1: Write the failing test (token-key wiring)**

In `frontend/src/auth/session.test.ts`, add to the existing `describe('login', ...)` block:

```typescript
  it('persists the token under the token key; logout removes it', async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', user: user(1) })
    await login('a@example.com', 'pw')
    expect(localStorage.getItem('fabulous-writing-token')).toBe('tok')
    logout()
    expect(localStorage.getItem('fabulous-writing-token')).toBeNull()
  })
```

And to `describe('expireSession', ...)`:

```typescript
  it('removes the token key', () => {
    localStorage.setItem('fabulous-writing-token', 'tok')
    useStore.setState({ token: 'tok', user: user(1), authStatus: 'authenticated' })
    expireSession()
    expect(localStorage.getItem('fabulous-writing-token')).toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/auth/session.test.ts`
Expected: the two new tests FAIL (token key never written/removed); all existing tests still PASS.

- [ ] **Step 3: `store.ts` — remove the middleware**

In `frontend/src/state/store.ts`:

1. Replace the two imports
   ```typescript
   import { create } from 'zustand'
   import { persist } from 'zustand/middleware'
   ```
   with
   ```typescript
   import { create } from 'zustand'
   import { readToken } from './prefsStorage'
   ```
2. Delete the entire `persistConfig` block (the `// Persist options shared with tests...` comment through the closing `}` of `export const persistConfig = {...}`).
3. Replace the store creation wrapper: change
   ```typescript
   export const useStore = create<AppState>()(
     persist(
       (set) => ({
         ...INITIAL_DATA,
         token: null,
         ...
       }),
       persistConfig,
     ),
   )
   ```
   to
   ```typescript
   export const useStore = create<AppState>()((set) => ({
     ...INITIAL_DATA,
     // The only field initialised from storage: the token must be readable
     // before we know who the user is, so it lives in its own key
     // (prefsStorage.ts) rather than any per-user preference blob.
     token: readToken(),
     ...
   }))
   ```
   (everything between `token:` and the final `}))` — the other five auth
   fields and all actions — is unchanged.)
4. Replace `resetSessionState` (function body AND its doc comment, including
   the long `// Order matters...` inner comment) with:
   ```typescript
   /** Resets the whole data half of the store — not just the formerly
    * persisted slice. Most of the store (tracked findings, documents,
    * folders, scorecard, ...) is invisible to storage; left alone it would
    * survive a gate swap and render the previous account's data. Called on
    * logout, on session expiry, and on a login that changes the user — see
    * session.ts for which. Storage is untouched: per-user preference blobs
    * survive every session transition by design (B1, #34), and the write
    * subscriber (prefsPersistence.ts) ignores this reset because every
    * caller nulls the user first — the ordering invariant documented in
    * session.ts. */
   export function resetSessionState(): void {
     useStore.setState(INITIAL_DATA) // shallow merge: the actions survive
   }
   ```

- [ ] **Step 4: `session.ts` — invariant ordering and token wiring**

In `frontend/src/auth/session.ts` (note: the before/after snippets below sit
at markdown list-nesting depth — the file's real indentation is 4 spaces
inside function bodies; match the file, not the snippet, when doing
literal-string edits):

1. Add imports:
   ```typescript
   import { loadUserPrefs } from '../state/prefsPersistence'
   import { clearToken, writeToken } from '../state/prefsStorage'
   ```
2. Replace `login()`'s body after the generation guard — change
   ```typescript
     generation++
     // Purge is for a *user change*, per Decision 1. ...
     if (previousUserId !== user.id) resetSessionState()
     discardForeignBuffer(user.id)   // keeps this user's own unsaved work
     useStore.setState({ sessionExpired: false, restoreFailed: false })
     useStore.getState().setAuth(token, user)
   ```
   to
   ```typescript
     generation++
     // A *user change* purges in-memory state and swaps preference
     // namespaces; a same-user re-login (the silent re-auth after a
     // password change, auth/AccountMenu.tsx) must not touch the user's
     // live preferences at all.
     if (previousUserId !== user.id) {
       // Ordering invariant (B1, #34): bulk pref resets/loads happen only
       // while the store's user is null, so the write subscriber
       // (prefsPersistence.ts) cannot commit them to any namespace. In
       // practice user is already null here — the login form only renders
       // while anonymous — but the explicit setAuth keeps the invariant
       // caller-proof.
       useStore.getState().setAuth(null, null)
       resetSessionState()
       loadUserPrefs(user.id)
     }
     discardForeignBuffer(user.id)   // keeps this user's own unsaved work
     writeToken(token)
     useStore.setState({ sessionExpired: false, restoreFailed: false })
     useStore.getState().setAuth(token, user)
   ```
   (the trailing `bumpAuthGeneration()` call and its comment stay unchanged.)
3. Replace `logout()` with:
   ```typescript
   /** Deliberate exit. The session dies — token and all in-memory state —
    * but the user's preference blob survives by design (B1, #34): it holds
    * no document content and no credentials, and is restored on their next
    * login. */
   export function logout(): void {
     generation++
     invalidateDocumentWork()   // first: pending saves must not write the buffer back
     cancelInFlightCheck()
     clearToken()
     // Ordering invariant (B1, #34): null the user BEFORE
     // resetSessionState(), or the write subscriber would commit the reset
     // defaults into the departing user's namespace — destroying the
     // preferences that must survive this logout.
     useStore.getState().setAuth(null, null)
     resetSessionState()
     clearSnapshot()
     clearLegacyText()
   }
   ```
4. Replace `expireSession()` with:
   ```typescript
   /** The token stopped working. The same user is almost certainly coming
    *  back, so the document buffer is deliberately left alone — it is the
    *  only copy of their unsaved text. Their preference blob survives too
    *  (B1, #34). */
   export function expireSession(): void {
     generation++
     invalidateDocumentWork()   // the buffer survives; the work that rewrites it must not
     cancelInFlightCheck()
     clearToken()
     // Same ordering invariant as logout(): user null before the reset.
     useStore.getState().setAuth(null, null)
     resetSessionState()
     useStore.setState({ sessionExpired: true })
   }
   ```
5. In `runRestore()`'s success path, change
   ```typescript
       const user = await getMe()
       if (startedAt !== generation) return
       useStore.getState().setAuth(token, user)
   ```
   to
   ```typescript
       const user = await getMe()
       if (startedAt !== generation) return
       // Ordering invariant (B1, #34): load the restored user's preferences
       // before setAuth makes them visible — while user is still null the
       // write subscriber stays silent, and once setAuth lands the loaded
       // values are already in place, so no write fires.
       loadUserPrefs(user.id)
       useStore.getState().setAuth(token, user)
   ```
   (`refreshUser()` is deliberately untouched: it only re-fetches `/me` for
   quota display and must not reload preferences.)

- [ ] **Step 5: `main.tsx` — boot wiring**

Replace `frontend/src/main.tsx` with:

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LoginGate } from './auth/LoginGate.tsx'
import { initPrefsPersistence } from './state/prefsPersistence.ts'

initPrefsPersistence()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoginGate>
      <App />
    </LoginGate>
  </StrictMode>,
)
```

- [ ] **Step 6: Adjust the affected tests**

1. `frontend/src/state/store.test.ts`: remove `persistConfig` from the
   import (line 6 becomes `import { resetSessionState, useStore } from './store'`)
   and delete the two tests
   `'persist v1 -> v2 migration keeps old blobs loadable'` and
   `'persists the token but never the user object'` (their replacement
   coverage is Task 1's version/envelope tests and Task 2's
   six-fields-only subscriber test).
2. `frontend/src/auth/session.test.ts`: replace the stale header comment
   (lines 2–6, about `useStore.persist.clearStorage()` needing `window`)
   with:
   ```typescript
   // The session flow reads and writes real localStorage keys — the token
   // key and the per-user preference blobs (prefsStorage.ts) — which the
   // default "node" test environment has no window/localStorage for.
   ```
3. `frontend/src/auth/session.test.ts`: two existing test names still say
   "persisted settings blob" (`logout` and `expireSession` describes) —
   their in-memory assertions remain valid; update only the names:
   `'clears token, user, the persisted settings blob and the document buffer, resets checkPhase, and sets anonymous'`
   → `'clears token, user, in-memory settings and the document buffer, resets checkPhase, and sets anonymous'`;
   `'clears the settings blob but keeps the document buffer'`
   → `'clears in-memory settings but keeps the document buffer'`.

- [ ] **Step 7: Run the full frontend suite and build**

Run (from `frontend/`): `npm test -- --run` then `npm run build`
Expected: everything PASSES (including Step 1's two new tests and the untouched `session.integration.test.ts`, `LoginGate.test.tsx`, `AccountMenu.test.tsx`, `App*.test.tsx`); build clean. If an unrelated test trips on the removed middleware, fix the test's storage seeding to use the new keys — never re-add the middleware.

Then verify the boot wiring is actually in place — no test covers `main.tsx`
(it is outside the test tree), so a skipped Step 5 would leave all tests
green while the app silently persists nothing:

Run: `grep -q "initPrefsPersistence()" src/main.tsx && echo WIRED`
Expected: `WIRED`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/state/store.ts frontend/src/auth/session.ts frontend/src/main.tsx frontend/src/state/store.test.ts frontend/src/auth/session.test.ts
git commit -m "feat(auth,state): per-user pref namespaces — drop persist middleware, token key, ordering invariant (B1, #34)"
```
(with the two mandatory trailer lines)

---

### Task 4: B1 acceptance tests — survival, round-trip, ordering pins

**Files:**
- Modify: `frontend/src/auth/session.test.ts` (new describe block + imports)

**Interfaces:**
- Consumes: everything from Tasks 1–3; no new production code — any failure here is a Task 3 bug to fix in place.

- [ ] **Step 1: Wire the subscriber into the test file**

In `frontend/src/auth/session.test.ts`, extend the imports and initialise the
persistence layer at module scope (the real `main.tsx` does the same at
boot):

```typescript
import { initPrefsPersistence, PREFS_DEFAULTS } from '../state/prefsPersistence'
import { readPrefs, readToken, writePrefs } from '../state/prefsStorage'

initPrefsPersistence()
```

(Place the call directly after the import block, before the `user()` helper.)

- [ ] **Step 2: Write the failing-or-passing acceptance tests**

Add a new top-level describe block:

```typescript
describe('per-user preference survival (B1, #34)', () => {
  it("restores the incoming user's stored preferences on login (load runs before setAuth)", async () => {
    writePrefs(2, { ...PREFS_DEFAULTS, uiLocale: 'fr', currentDocId: 9 })
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', user: user(2) })
    await login('b@example.com', 'pw')
    expect(useStore.getState().uiLocale).toBe('fr')
    expect(useStore.getState().currentDocId).toBe(9)
  })

  it("restoreSession loads the restored user's preferences", async () => {
    writePrefs(1, { ...PREFS_DEFAULTS, uiLocale: 'fr' })
    useStore.setState({ token: 'tok', authStatus: 'unknown' })
    vi.mocked(getMe).mockResolvedValue(user(1))
    await restoreSession()
    expect(useStore.getState().uiLocale).toBe('fr')
  })

  it("keeps the departing user's blob values across logout and restores them on re-login", async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', user: user(1) })
    await login('a@example.com', 'pw')
    useStore.getState().setUiLocale('de')   // subscriber writes user 1's blob
    logout()
    // The blob still holds the pre-logout values — a reset that ran while
    // the user was still visible would have overwritten it with defaults.
    expect(readPrefs(1)?.uiLocale).toBe('de')
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok2', user: user(1) })
    await login('a@example.com', 'pw')
    expect(useStore.getState().uiLocale).toBe('de')
  })

  it('preferences survive session expiry', async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', user: user(1) })
    await login('a@example.com', 'pw')
    useStore.getState().setUiLocale('de')
    expireSession()
    expect(readPrefs(1)?.uiLocale).toBe('de')
  })

  it("A→B→A: A's preferences survive B's session and B never sees A's values", async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tokA', user: user(1) })
    await login('a@example.com', 'pw')
    useStore.getState().setUiLocale('de')
    useStore.getState().toggleDocSidebar()   // docSidebarCollapsed: true
    logout()

    vi.mocked(postLogin).mockResolvedValue({ token: 'tokB', user: user(2) })
    await login('b@example.com', 'pw')
    // The #34 leak, end to end: B has no blob and must see pure defaults.
    expect(useStore.getState().uiLocale).toBeNull()
    expect(useStore.getState().docSidebarCollapsed).toBe(false)
    useStore.getState().setUiLocale('es')
    logout()

    vi.mocked(postLogin).mockResolvedValue({ token: 'tokA2', user: user(1) })
    await login('a@example.com', 'pw')
    const state = useStore.getState()
    expect(state.uiLocale).toBe('de')
    expect(state.docSidebarCollapsed).toBe(true)
    // B's own choices ended up in B's namespace, not A's.
    expect(readPrefs(2)?.uiLocale).toBe('es')
  })

  it("the incoming user's preferences are already loaded when the user becomes visible", async () => {
    // Pins the load-before-setAuth direction of the ordering invariant
    // directly: it is defense-in-depth (no in-process code path observes
    // the gap today), so no behavioral test can catch a reordering — this
    // subscriber can. If user becomes visible while prefs still hold
    // defaults, the invariant is broken even though login()'s end state
    // looks correct.
    writePrefs(2, { ...PREFS_DEFAULTS, uiLocale: 'fr', currentDocId: 9 })
    const seenAtUserVisible: (string | null)[] = []
    const unsub = useStore.subscribe((state, prev) => {
      if (state.user && !prev.user) seenAtUserVisible.push(state.uiLocale)
    })
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', user: user(2) })
    await login('b@example.com', 'pw')
    unsub()
    expect(seenAtUserVisible).toEqual(['fr'])
  })

  it('same-user silent re-login neither resets nor re-reads the blob', async () => {
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok', user: user(1) })
    await login('a@example.com', 'pw')
    useStore.getState().setUiLocale('de')
    // Stale blob on purpose: if the re-login re-read storage, uiLocale
    // would flip to 'it'; if it reset, uiLocale would flip to null.
    writePrefs(1, { ...PREFS_DEFAULTS, uiLocale: 'it' })
    vi.mocked(postLogin).mockResolvedValue({ token: 'tok2', user: user(1) })
    await login('a@example.com', 'pw')
    expect(useStore.getState().uiLocale).toBe('de')
  })

  it('restoreSession authenticates from the token key value present at boot', async () => {
    // The store field is seeded here directly; the boot-time read itself
    // (token: readToken() at store creation) is covered in
    // prefsPersistence.test.ts via a fresh module import.
    useStore.setState({ token: 'tok', authStatus: 'unknown' })
    vi.mocked(getMe).mockResolvedValue(user(1))
    await restoreSession()
    expect(useStore.getState().authStatus).toBe('authenticated')
    expect(readToken()).toBeNull() // restore does not re-write the key
  })
})
```

Also add to `frontend/src/state/prefsPersistence.test.ts`'s `boot wiring`
describe (the fresh-module boot-read test promised above):

```typescript
  it('the store boots with the token from the token key', async () => {
    vi.resetModules()
    localStorage.setItem('fabulous-writing-token', 'boot-tok')
    const { useStore: freshStore } = await import('./store')
    expect(freshStore.getState().token).toBe('boot-tok')
  })
```

- [ ] **Step 3: Run the tests**

Run: `npm test -- --run src/auth/session.test.ts src/state/prefsPersistence.test.ts`
Expected: PASS. If any acceptance test fails, the bug is in Task 3's ordering — fix `session.ts`/`store.ts`, never weaken the test.

- [ ] **Step 4: Mutation-verify the ordering invariant (both directions)**

1. In `logout()`, move `useStore.getState().setAuth(null, null)` to AFTER
   `resetSessionState()` → the logout-survival test and the A→B→A test must
   fail (blob overwritten with defaults). Restore.
2. In `login()`, move the load after `setAuth` while keeping its guard —
   i.e. delete `loadUserPrefs(user.id)` from the user-change branch and add
   `if (previousUserId !== user.id) loadUserPrefs(user.id)` directly after
   `useStore.getState().setAuth(token, user)` (re-guarding isolates the
   ordering; an unguarded move would also fail the same-user re-login test
   for an unrelated reason) → the already-loaded-when-user-becomes-visible
   test must fail (`seenAtUserVisible` captures `null` instead of `'fr'`);
   the restores-on-login test still passes — that is the fail-safe
   direction and expected. Restore.
3. In `expireSession()`, delete `clearToken()` → the expireSession
   removes-the-token-key test (Task 3) must fail. Restore.
4. Re-run: `npm test -- --run src/auth/session.test.ts` → PASS.

- [ ] **Step 5: Full suite + build**

Run: `npm test -- --run` then `npm run build`
Expected: all PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/auth/session.test.ts frontend/src/state/prefsPersistence.test.ts
git commit -m "test(auth): B1 acceptance — survival across logout/expiry, A→B→A round-trip, ordering pins (#34)"
```
(with the two mandatory trailer lines)

---

### Task 5: Architecture docs

**Files:**
- Modify: `docs/frontend-architecture.md`

**Interfaces:** none — documentation only. (The LOGBOOK entry is appended at
PR time per the logbook convention, not in this plan.)

- [ ] **Step 1: Update the persistence documentation**

In `docs/frontend-architecture.md`:

1. Line ~9: change `- **zustand** for application state (one store, a small persisted slice);`
   to `- **zustand** for application state (one store; a small per-user preference slice is persisted by an explicit layer, not the persist middleware);`.
2. In the source-tree listing, add under `src/state/`:
   ```
   │   ├── prefsStorage.ts        # localStorage I/O: per-user pref blobs, token key, legacy-key cleanup
   │   ├── prefsPersistence.ts    # PREFS_DEFAULTS, loadUserPrefs, write subscriber (initPrefsPersistence)
   ```
3. Replace the section describing `persistConfig` / the persist middleware
   (the paragraphs around former lines 121–136, starting "The `persist`
   middleware is configured from one exported object…") with prose covering,
   in this order:
   - the three-key layout (token key `fabulous-writing-token`; per-user
     blobs `fabulous-writing-settings:<user.id>` in the
     zustand-persist-compatible envelope `{"state": {...}, "version": 2}`;
     legacy `fabulous-writing-settings` deleted once at boot, never read);
   - the six persisted fields and that `token`/`user` are never part of a
     preference blob (`user` still re-fetched via `/api/auth/me` on load);
   - `loadUserPrefs` as one atomic defaults+blob `setState` and why that
     kills the #34 leak;
   - the write subscriber's two guards (pref-field identity change; `user`
     non-null);
   - the ordering invariant and which session.ts call sites carry it
     (`login` user-change branch, `logout`, `expireSession`, `runRestore`);
   - preference survival semantics: blobs survive logout, expiry, and user
     switches; only the token dies with the session.
4. Update the auth-field line (~101): `token` is "persisted in its own key
   (`prefsStorage.ts`), read once at store creation" rather than "persisted,
   see below".
5. Two further stale sites that name-based greps miss (found by plan
   review):
   - line ~879: "what persist v2 keeps globally" — rewrite as "what the
     per-user preference blob keeps" and add the missing
     `docFoldersCollapsed` to the field list;
   - lines ~1062–1067: the paragraph claiming `resetSessionState()` "clears
     the persisted zustand blob … then lets the caller's own `setAuth()`
     write the new session's values back in" — both halves are now false
     (the blob survives; `setAuth(null, null)` runs *before* the reset).
     Rewrite it to describe the ordering invariant.
6. Search the document for remaining references to `persistConfig`,
   `partialize`, or the persist middleware and update each (the cluster
   around former lines 118–136 plus the two sites above are the known
   hits; verify none are left).

- [ ] **Step 2: Verify no stale references remain**

Run: `grep -nE "persistConfig|persist middleware|partialize|persist v2|persisted zustand blob|clearStorage" docs/frontend-architecture.md`
Expected: no hits (or only the sentence explaining the middleware was
replaced).

- [ ] **Step 3: Gates and commit**

Run (from `frontend/`): `npm test -- --run` and `npm run build` (unchanged
code — this confirms a clean tree before the docs commit).

```bash
git add docs/frontend-architecture.md
git commit -m "docs(frontend): per-user preference persistence layer replaces persist middleware (B1, #34)"
```
(with the two mandatory trailer lines)
