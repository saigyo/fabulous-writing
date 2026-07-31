# Per-User UI Preference Survival (B1, #34) — Design

**Item:** [B1 #34](https://github.com/saigyo/fabulous-writing/issues/34). M2 purges the
persisted settings blob on every user change; preferences (UI locale, collapse
states, last document) die with the session. This design makes them survive per
user: each account gets its own localStorage namespace, restored on its next
login — including after logout and session expiry.

**Approach (settled with Markus, 2026-07-31):** drop the zustand `persist`
middleware for this store and replace it with a small explicit persistence
module. The middleware writes to storage on *every* `setState`, which makes
every reset/switch/rehydrate sequence ordering-critical — three distinct
clobber traps were identified during design (writing the reset into the
departing user's namespace, writing it into the incoming user's namespace
before reading it, and the leak documented in the issue itself). The explicit
layer makes all of them impossible by construction. zustand itself, the store
shape, all actions and consumers are untouched.

Two further decisions from the same session:

- **Preferences survive deliberate logout.** Logout clears the token and
  in-memory state only; the per-user blob stays. (The old "machine may be
  handed over, so nothing survives" guarantee is deliberately narrowed to
  session/token/in-memory state — preference blobs contain no document
  content and no credentials.)
- **Clean-break migration.** The legacy single blob (which mixed the token
  with the last user's preferences) is deleted once at boot. Everyone signs
  in again once; preferences reset to defaults once. Nothing is migrated.

## localStorage layout

| Key | Content | Lifecycle |
| --- | --- | --- |
| `fabulous-writing-token` | Raw session token string | Written by login; read at boot and retained (not rewritten) during session restore; removed by logout and expiry |
| `fabulous-writing-settings:<user.id>` | One preference blob per user | Written by the subscriber while that user is signed in; never deleted by the app |
| `fabulous-writing-settings` (legacy) | Old mixed blob | Deleted once at module init; never read |

The per-user blob uses the zustand-persist-compatible envelope
`{"state": {...}, "version": 2}`. This keeps future schema migrations a small
version switch on read, and leaves a return to the middleware possible without
a storage-format migration. Version starts at 2 (continuing the old blob's
numbering so the number never moves backwards); there are no legacy versions
to migrate — a blob with `version !== 2` or unparseable JSON is discarded and
defaults apply.

**Persisted fields** (unchanged set, minus `token`):
`uiLocale`, `lastProfileByLanguage`, `rulesCollapsed`, `currentDocId`,
`docSidebarCollapsed`, `docFoldersCollapsed`.

## The persistence layer — `prefsStorage.ts` + `prefsPersistence.ts`

Two modules under `frontend/src/state/` own every localStorage access for
the store. `prefsStorage.ts` is pure I/O with no runtime store dependency —
token accessors, `readPrefs`/`writePrefs` (envelope handling plus per-field
runtime validation, since localStorage is user-editable), legacy-key
deletion. It exists as a separate module so `store.ts` can read the boot
token without an import cycle. `prefsPersistence.ts` is the store-aware
layer: `PREFS_DEFAULTS`, `loadUserPrefs`, the write subscriber, and
`initPrefsPersistence()` (called once from `main.tsx` at boot). Three
operations:

### 1. `loadUserPrefs(userId: number): void`

Called when auth resolves to a user (fresh login with a *different* user, or
boot-time session restore). Synchronously reads
`fabulous-writing-settings:<userId>` and applies

```ts
useStore.setState({ ...PREFS_DEFAULTS, ...storedState })
```

in one call. Reset-to-defaults and hydration are a single atomic step: a user
with no blob gets exactly the defaults — the previous user's in-memory values
cannot survive into the new namespace (the leak documented in #34).

`PREFS_DEFAULTS` is the six persisted fields' slice of the existing
`INITIAL_DATA` (`uiLocale: null`, `lastProfileByLanguage: {}`,
`rulesCollapsed: []`, `currentDocId: null`, `docSidebarCollapsed: false`,
`docFoldersCollapsed: []`), exported so the subscriber, the loader, and tests
share one definition.

### 2. The write subscriber

Registered once by `initPrefsPersistence()` (main.tsx, boot) via
`useStore.subscribe`. On each state change it:

- returns immediately unless at least one of the six persisted fields changed
  identity (all six only change via their setters, so reference comparison is
  exact — and it keeps high-frequency transient updates like `docWords`/
  `docChars` from touching localStorage on every keystroke);
- returns unless `state.user` is non-null (nothing is ever written while
  logged out — the login gate cannot pollute any namespace);
- writes the six fields, enveloped, to `fabulous-writing-settings:<user.id>`
  with the id taken from the *current* state at write time — a write can
  never land in another user's namespace.

### 3. Token accessors

`readToken(): string | null`, `writeToken(token)`, `clearToken()` — a thin
wrapper over the `fabulous-writing-token` key. The store's initial `token`
value becomes `readToken()` (today it arrives via blob rehydration).

localStorage failures (quota, privacy mode) are swallowed exactly as the
middleware swallowed them: reads fall back to defaults/null, writes are
best-effort.

## Store changes — `frontend/src/state/store.ts`

- Remove the `persist(...)` wrapper and the `persistConfig` export (its
  `migrate` is dead code under fresh per-user keys; the version switch lives
  in the new module when it is ever needed).
- `useStore = create<AppState>()((set) => ({...}))` — plain store; initial
  `token: readToken()`.
- `resetSessionState()` loses its `clearStorage()` call and the ordering-
  hazard comment that existed to defend it: it becomes a pure in-memory reset
  (`useStore.setState(INITIAL_DATA)`). Storage is never touched by session
  transitions except the token key.
- `INITIAL_DATA` keeps its role and its "every data field except the six auth
  fields" contract, unchanged.

## Session-transition semantics — `frontend/src/auth/session.ts`

**Ordering invariant (the one rule the module cannot enforce alone):**
*pref fields are only bulk-reset or bulk-loaded while `user` is null.* The
subscriber's `user`-non-null guard then turns every hazardous write into a
non-write:

- **On the way in**, `loadUserPrefs(user.id)` runs *before* `setAuth(token,
  user)` makes the user visible. While prefs load, `user` is still null, so
  the subscriber stays silent; once `setAuth` lands, the just-loaded values
  are already in place and no pref field changes, so no write fires.
- **On the way out**, `setAuth(null, null)` runs *before*
  `resetSessionState()`. Today both `logout()` and `expireSession()` reset
  first and null the user after — under the subscriber, that order would
  write the reset defaults into the departing user's namespace, destroying
  the preferences this feature promises survive. Both functions are reordered
  accordingly (`sessionExpired` and the auth fields are excluded from
  `INITIAL_DATA`, so the reset cannot un-set them regardless of order).

Violations fail safe in one direction (a too-early `setAuth` on login writes
the *loaded* values, not another user's) and are caught by tests in the other
(a too-late `setAuth` on logout overwrites the blob with defaults — pinned by
the logout-survival test below).

- **`login()` — user change** (`previousUserId !== user.id`; in practice the
  login form only renders while anonymous, so `user` is already null — the
  branch still starts with `setAuth(null, null)` so the invariant holds for
  any future caller): `setAuth(null, null)` → `resetSessionState()` →
  `loadUserPrefs(user.id)`, then today's tail unchanged —
  `discardForeignBuffer(user.id)` (which stays *outside* the branch,
  unconditional on every login, exactly as today), `writeToken(token)`,
  `sessionExpired`/`restoreFailed` clearing, `setAuth(token, user)`,
  `bumpAuthGeneration()`.
- **`login()` — same user** (silent re-login after password change): exactly
  today's path plus `writeToken(token)`. No reset, no prefs reload — the
  user's live preferences stay as they are.
- **`logout()` / `expireSession()`:** as today, plus `clearToken()`, with
  `setAuth(null, null)` moved before `resetSessionState()` per the invariant;
  the reset no longer touches storage, so the user's blob survives.
  Everything else (generation bump, `invalidateDocumentWork`, buffer
  handling, `sessionExpired`) is unchanged.
- **`runRestore()` (boot):** after `getMe()` succeeds and the generation
  guard passes: `loadUserPrefs(user.id)` → `setAuth(token, user)`.
  `refreshUser()` is unchanged — it only re-fetches `/me` for quota display
  and must not reload prefs.
- **Boot sequence:** `main.tsx` calls `initPrefsPersistence()` (deletes the
  legacy key, registers the subscriber); store creation reads the token key
  → `LoginGate`'s mount effect calls `restoreSession()` as today, which
  retains the stored token without rewriting it.

Not in scope, unchanged by design: `discardForeignBuffer` and the document
snapshot buffer (already per-owner), `documents.ts`'s stale-`currentDocId`
fallback (already covers a restored id that no longer exists), cross-tab
synchronization (not provided today either), and the backend (no API changes).

## Error handling

- Unparseable or wrong-version blob → treated as absent; defaults apply; the
  next preference change overwrites it with a valid blob.
- Malformed field *values* inside a current-version blob (localStorage is
  user-editable — e.g. `docFoldersCollapsed: null` would crash `.includes`
  consumers): each field is runtime-validated (locale membership against
  `LOCALES`, scalar types, record value types, array element types); an
  invalid field is treated as absent and its default applies.
- localStorage unavailable/full → app runs with in-memory preferences only,
  as it does today under the middleware.
- A restore that fails (network, non-401) keeps today's behavior; prefs load
  only on a *successful* auth resolution.

## Testing

Frontend only (`npm test -- --run`, plus `npm run build`), following the
existing store/session test patterns. Every guard below is mutation-verified
(delete the guard, watch the test fail, restore):

**Module unit tests** (`prefsStorage.test.ts`, `prefsPersistence.test.ts`):
- load with an existing blob applies stored values over defaults;
- load with no blob resets all six fields to `PREFS_DEFAULTS` even when the
  in-memory state holds another user's values (the #34 leak, pinned);
- load with corrupt JSON / wrong version falls back to defaults;
- malformed field values (wrong runtime types, unknown locale) are dropped
  individually while valid sibling fields load;
- subscriber writes to the signed-in user's key, envelope format
  `{state, version: 2}`;
- subscriber does not write while `user` is null;
- subscriber does not write when only non-persisted fields change;
- token accessors round-trip and clear.

**Session-level tests** (extend `session.test.ts` /
`session.integration.test.ts`):
- A→B→A round-trip: A's preferences restored intact after B's session, and
  B (no blob) saw pure defaults — both survival and non-leakage;
- logout leaves the departing user's blob in storage **with its pre-logout
  values** (not merely the key existing — this pins the reset-after-`setAuth`
  ordering; a reset that runs while the user is still visible overwrites the
  blob with defaults and fails this test); next login restores it;
- session expiry likewise;
- same-user silent re-login preserves live in-memory preferences and does not
  re-read the blob;
- ordering invariant (load-before-`setAuth` direction): a test subscriber
  captures the preference fields at the exact transition where `user` first
  becomes non-null and asserts the stored values are already in place —
  end-state assertions cannot pin this (a reversed order produces the same
  final blob), only the transition capture fails on reordering;
- boot deletes the legacy `fabulous-writing-settings` key and restores the
  session from the token key.

**Adjusted existing tests:** `store.test.ts`'s persistence tests move off the
removed `persistConfig` export onto the module's exports; auth tests that
seeded a token via the old blob seed the token key instead.
