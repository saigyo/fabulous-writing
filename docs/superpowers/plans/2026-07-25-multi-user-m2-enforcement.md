# Multi-User M2 — Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require authentication on every `/api/*` endpoint, tighten CORS, and
ship the frontend that satisfies it — auth state, a full-screen login gate, a
Bearer header on every request, a `fetch()`-based SSE reader, and an account
menu — so `main` stays a working application after the merge.

**Architecture:** Backend enforcement is a router-level
`dependencies=[Depends(get_current_user)]`, matching the pattern `admin.py`
already uses, so an endpoint added later inherits the check by construction.
The frontend gains an auth slice on the existing zustand store, a gate above
the app shell that keeps mount-time fetches from firing while unauthenticated,
and one central place where the Bearer header is attached. Password changes
gain session revocation via a `password_changed_at` column compared against the
token's `iat`.

**Tech Stack:** Python 3.13, FastAPI, SQLite, pydantic v2, pytest (backend);
React 19, TypeScript, Vite, zustand, vitest (frontend). Backend commands run
from `backend/` via `uv run`; frontend from `frontend/` via `npm`/`npx`.

Spec: `docs/superpowers/specs/2026-07-24-multi-user-auth-design.md` (§7.2,
§7.3, §7.4, §8).
Roadmap: `docs/superpowers/plans/2026-07-25-multi-user-roadmap.md` (M2).
Prior milestone: M1 (`e7f19ec..7abc259`) built every auth primitive and applied
them to nothing.

---

## Global Constraints

- Branch `multi-user-enforcement`, branched from `main` at `7abc259`. This plan
  is the branch's first commit; implementation follows on the same branch and
  ships in **one** PR. Request a Copilot review at the end and **resolve every
  review thread** — the `main` ruleset blocks merge while any thread is open.
  Copilot auto-review on push is currently **disabled**, so review rounds are
  requested explicitly rather than firing per push.
- **Every commit message ends with these two trailers, verbatim:**

  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
  ```

  M1 merged 12 commits without them because the plan's own commit snippets
  omitted them. Every `git commit` in this plan includes them; do not drop them.
- **M2 does not scope data by owner.** `documents.owner_id` is hardcoded to `1`
  and nothing filters by caller. After this milestone every endpoint requires a
  logged-in user, and every logged-in user still sees the same data. Owner
  scoping, the 404-not-403 semantics, and the global-built-ins model are **M3**.
  Do not start them here — "apply auth to every router" is complete when the
  dependency is in place and anonymous access is refused, not when data is
  partitioned.
- The live database `backend/data/fabulous.db` is never read or written by
  tests, and `create_app()` is never called with default settings — that path
  *is* the live database. Every test passes `tmp_path`-based settings.
- Secrets come from the environment only. Never write them to the repository,
  the database, or a log line.
- `GET /api/health` and `POST /api/auth/login` stay public. Everything else
  under `/api/*` requires authentication.
- Tokens never appear in URLs (spec §7.3, binding). The SSE stream carries its
  credential in the `Authorization` header, which is the whole reason
  `EventSource` is being replaced.
- Gates before opening the PR: from `backend/`, `uv run pytest -q` passes with
  **zero warnings**; from `frontend/`, `npx vitest run && npx tsc --noEmit &&
  npm run lint && npm run build` all pass.
- A plain `uv run pytest` goes through a filtering proxy that hides FAILED
  lines. Use `rtk proxy uv run pytest -q` when you need the true list.

## Decisions this plan makes

Recorded here because a reviewer should be able to challenge them without
reading the tasks:

1. **Persisted store: purge on user change, not namespace per user.** The spec
   allows either (§8, "namespaced by user id or purged on login/logout").
   Purging is simpler, keeps localStorage bounded on a shared browser, and has
   no failure mode where a stale namespace resurfaces. The cost is that
   per-user UI preferences do not survive a logout, which is acceptable for the
   six persisted keys involved.
2. **Frontend before backend.** Tasks 3–8 build auth state, the Bearer header,
   the SSE reader, the gate and the account menu while the backend still allows
   anonymous access; Tasks 9–10 then enforce. The app therefore works at every
   commit, and enforcement is a switch-flip against a client that is already
   ready. The reverse order would leave the branch unusable in dev for several
   tasks.
3. **Session revocation on password change** (Task 2) is folded into M2 by the
   owner's decision on 2026-07-25. M1 shipped with `is_active=False` as the only
   revocation lever, so a password change did not evict a stolen session for up
   to 24 h. The timestamp is written inside `UserStore.set_password`, which
   means all three callers — self-service, admin reset, operator CLI — get it
   without separate changes.
4. **CORS becomes config-driven** (`cors.origins`, default
   `["http://localhost:5173"]`) per spec §7.4, following `AuthSettings`' shape.

## File Structure

| File | Responsibility |
|---|---|
| `backend/app/core/config.py` (modify) | `CorsSettings` + `Settings.cors`. |
| `backend/app/main.py` (modify) | CORS from settings; router-level auth dependency on the ten feature routers. |
| `backend/app/services/users.py` (modify) | `password_changed_at` column, written by `set_password`. |
| `backend/app/api/deps.py` (modify) | Reject a token issued before `password_changed_at`. |
| `backend/tests/conftest.py` (modify) | Shared `authed_client` fixture so ten test files stop hand-rolling tokens. |
| `frontend/src/state/store.ts` (modify) | Auth slice (`token`, `user`, `authStatus`); persist purge on user change. |
| `frontend/src/api/client.ts` (modify) | Bearer header in `request()`; `HttpError` unchanged in shape; `subscribeCheck` rewritten on `fetch` + `AbortController`. |
| `frontend/src/auth/LoginGate.tsx` (new) | Full-screen gate replacing the app shell while unauthenticated. |
| `frontend/src/auth/LoginForm.tsx` (new) | Email/password form, inline error handling. |
| `frontend/src/auth/AccountMenu.tsx` (new) | Header menu: change password, log out. |
| `frontend/src/auth/session.ts` (new) | `login()`, `logout()`, `loadMe()` — the only writers of auth state. |
| `frontend/src/i18n/messages.ts` + 7 locale files (modify) | Auth strings. |
| `frontend/src/App.tsx` (modify) | Mount-time fetches deferred until authenticated; account menu in the header. |
| `frontend/src/main.tsx` (modify) | `<LoginGate>` wraps `<App/>`. |

---

### Task 1: CORS from configuration

**Files:**
- Modify: `backend/app/core/config.py`, `backend/app/main.py`,
  `backend/config.example.yaml`
- Test: `backend/tests/test_health.py` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `CorsSettings(origins: list[str])` on `Settings.cors`, default
  `["http://localhost:5173"]`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_health.py`:

```python
def test_cors_allows_the_configured_origin_only(tmp_path):
    app = create_app(_settings(tmp_path))
    client = TestClient(app)
    allowed = client.options(
        "/api/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    denied = client.options(
        "/api/health",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert "access-control-allow-origin" not in denied.headers
```

Use whatever helper the file already has for building `Settings` with
`tmp_path`; if it builds them inline, follow that shape instead of adding a
helper.

- [ ] **Step 2: Run it and watch it fail**

Run: `uv run pytest tests/test_health.py -q`
Expected: FAIL — with `allow_origins=["*"]` the second assertion fails, because
a wildcard origin is echoed for every origin.

- [ ] **Step 3: Add the config section**

In `backend/app/core/config.py`, next to `AuthSettings`:

```python
class CorsSettings(BaseModel):
    # Browsers only. The API is also reachable by non-browser clients, which
    # CORS does not constrain — this narrows which *web origins* may call it.
    origins: list[str] = ["http://localhost:5173"]
```

and on `Settings`:

```python
    cors: CorsSettings = Field(default_factory=CorsSettings)
```

- [ ] **Step 4: Use it**

In `backend/app/main.py`, replace the middleware block:

```python
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors.origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
```

Leave `allow_credentials` unset. Bearer-header auth does not need CORS
credentials mode, and enabling it alongside a permissive origin list is a
common mistake — add a one-line comment saying so.

- [ ] **Step 5: Document it**

In `backend/config.example.yaml`, add a `cors:` block near `auth:`, in the
file's existing comment style, stating the default and that it is the list of
browser origins permitted to call the API.

- [ ] **Step 6: Run the tests**

Run: `uv run pytest -q`
Expected: all pass, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add app/core/config.py app/main.py config.example.yaml tests/test_health.py
git commit -m "$(cat <<'EOF'
feat(cors): drive allowed origins from configuration

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 2: Session revocation on password change

**Files:**
- Modify: `backend/app/services/users.py`, `backend/app/api/deps.py`
- Test: `backend/tests/test_users_store.py`, `backend/tests/test_auth_api.py`

**Interfaces:**
- Consumes: `UserStore`, `get_current_user` from M1.
- Produces: `users.password_changed_at` (TEXT, nullable); `User.password_changed_at`;
  `get_current_user` rejects a token whose `iat` predates it.

**Why this exists:** M1 left `is_active=False` as the only way to revoke a
session. Changing a password because it was stolen did not evict the attacker
for up to 24 h. This closes that without adding token state.

- [ ] **Step 1: Write the failing store test**

Append to `backend/tests/test_users_store.py`:

```python
def test_set_password_records_when_it_changed(store):
    user = store.create_user("ada@example.com", "old password here")
    assert store.get_user(user.id).password_changed_at is None
    assert store.set_password(user.id, "new password here") is True
    changed = store.get_user(user.id).password_changed_at
    assert changed  # ISO 8601 UTC, same convention as created_at
```

- [ ] **Step 2: Run it and watch it fail**

Run: `uv run pytest tests/test_users_store.py -q`
Expected: FAIL — `User` has no `password_changed_at`.

- [ ] **Step 3: Add the column and write it**

In `backend/app/services/users.py`:

- add `password_changed_at TEXT` to the `users` DDL in `_SCHEMA`;
- add a `migrate_columns` call for existing databases, matching how
  `documents.py` and `folders.py` phase columns in — this database already
  exists in the field, so a bare DDL change would not reach it;
- add `password_changed_at: str | None = None` to the `User` model and to
  `_row_to_user`;
- have `set_password` write `_utcnow()` into it in the same `UPDATE`.

Do **not** set it in `create_user`: a brand-new account has never had a
password *changed*, and `None` is the honest value. The comparison in Step 5
treats `None` as "no revocation point".

- [ ] **Step 4: Write the failing dependency test**

Append to `backend/tests/test_auth_api.py`, using the existing `probe` fixture:

```python
def test_changing_the_password_invalidates_tokens_issued_before_it(probe):
    store = probe.state.user_store
    user = store.create_user("ada@example.com", "correct horse battery")
    client = TestClient(probe)
    headers = auth(user.id)
    assert client.get("/probe/user", headers=headers).status_code == 200
    store.set_password(user.id, "a replacement password")
    assert client.get("/probe/user", headers=headers).status_code == 401
    # A token issued after the change still works.
    assert client.get("/probe/user", headers=auth(user.id)).status_code == 200
```

- [ ] **Step 5: Reject stale tokens**

`get_current_user` currently discards the token's claims after `verify()`
returns the user id. It now needs `iat` as well.

Change `TokenVerifier.verify` to return the id **and** the issue time. Update
the protocol, `LocalTokenVerifier`, and the docstring that says it returns the
local `users.id` — it still does, alongside `iat`. Pick a small explicit
return type rather than a bare tuple, and say in a comment why `iat` crosses
this boundary: the request path, not the verifier, owns the revocation policy,
because a Supabase verifier will not know about `password_changed_at`.

Then in `get_current_user`, after the user row is read:

```python
    if user.password_changed_at and issued_at < _parse_utc(user.password_changed_at):
        raise HTTPException(401, _UNAUTHENTICATED)
```

Compare in UTC. `password_changed_at` is written by `_utcnow()`, which is
timezone-aware ISO 8601, so parse it with `datetime.fromisoformat`. Reuse the
same generic 401 — which failure occurred is not the caller's business.

- [ ] **Step 6: Run the tests**

Run: `uv run pytest -q`
Expected: all pass, zero warnings. Existing `verify()` callers and tests in
`test_auth_core.py` will need updating for the changed return type — that is
expected churn, not a regression.

- [ ] **Step 7: Rehearse the migration on a copy of the live database**

```bash
cp backend/data/fabulous.db /tmp/fw-m2-rehearsal.db
```

Then open the copy with `UserStore(Path('/tmp/fw-m2-rehearsal.db'))` and assert
`get_user(1)` returns a user with `password_changed_at is None`. **Never point
this at `backend/data/fabulous.db`.** Delete the copy afterwards.

- [ ] **Step 8: Commit**

```bash
git add app/services/users.py app/api/deps.py app/core/auth.py \
        tests/test_users_store.py tests/test_auth_api.py tests/test_auth_core.py
git commit -m "$(cat <<'EOF'
feat(auth): evict sessions issued before a password change

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 3: Frontend auth state and session actions

**Files:**
- Modify: `frontend/src/state/store.ts`
- Create: `frontend/src/auth/session.ts`
- Test: `frontend/src/state/store.test.ts` (append),
  `frontend/src/auth/session.test.ts` (new)

**Interfaces:**
- Produces: on the store, `token: string | null`, `user: MeResponse | null`,
  `authStatus: 'unknown' | 'anonymous' | 'authenticated'`,
  `sessionExpired: boolean`; `session.ts` exporting `login(email, password)`,
  `logout()`, `restoreSession()`.
- `MeResponse` is a **new frontend type** mirroring the backend's response —
  `{ id: number; email: string; display_name: string | null; tier: string;
  is_admin: boolean }` — declared in `client.ts` beside the other response
  types. M4 and M5 extend this same type rather than adding a second one.

**Design note:** `authStatus` starts at `'unknown'` rather than `'anonymous'`
so the gate can render nothing (not a login form) during the initial
`/api/auth/me` round-trip. Flashing a login form at an already-authenticated
user on every reload is the defect this state exists to prevent.

- [ ] **Step 1: Write the failing store test**

Append to `frontend/src/state/store.test.ts`:

```ts
it('persists the token but never the user object', () => {
  const persisted = persistConfig.partialize({
    ...useStore.getState(),
    token: 'a-token',
    user: { id: 1, email: 'ada@example.com', tier: 'basic', is_admin: false },
  } as never) as Record<string, unknown>
  expect(persisted.token).toBe('a-token')
  expect(persisted.user).toBeUndefined()
})
```

The user object is re-fetched from `/api/auth/me` on every load, so persisting
it would only create a second source of truth that can go stale — for instance
showing a tier or admin flag the server has since changed.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/state/store.test.ts`
Expected: FAIL — `token` is not part of the persisted shape.

- [ ] **Step 3: Add the auth fields**

In `frontend/src/state/store.ts`, add to `AppState`:

```ts
  token: string | null
  user: MeResponse | null
  authStatus: 'unknown' | 'anonymous' | 'authenticated'
```

with initial values `null`, `null`, `'unknown'`, and a setter
`setAuth(token: string | null, user: MeResponse | null)` that sets all three
consistently (`authStatus` derived: `'authenticated'` when both are present,
`'anonymous'` otherwise).

Add `token` — and only `token` — to `partialize`. Bump `version` to `3` and
extend `migrate` with a branch that drops any pre-existing auth-ish keys; a
blob written by an older build has none, so the branch is a pass-through that
exists to make the version bump explicit rather than silent.

Keep exporting the same `persistConfig` object reference — `store.test.ts`
asserts against it directly, as the comment above it explains.

- [ ] **Step 4: Write the failing session test**

Create `frontend/src/auth/session.test.ts` covering:

- `login()` stores the token and user returned by the API and flips
  `authStatus` to `'authenticated'`;
- `login()` with bad credentials leaves `authStatus` at `'anonymous'` and
  propagates the error to the caller rather than swallowing it (the form
  renders it inline);
- `logout()` clears token, user, **and the persisted settings blob**, then sets
  `'anonymous'`;
- `restoreSession()` with no token sets `'anonymous'` without calling the API;
- `restoreSession()` with a token that the server rejects (401) clears state
  and sets `'anonymous'`.

Mock the api client module (`vi.mock('../api/client', ...)`), matching how
`controller.test.ts` does it.

- [ ] **Step 5: Implement the session actions**

Create `frontend/src/auth/session.ts`. It is the only module that writes auth
state; components call these functions rather than `setAuth` directly.

```ts
export async function login(email: string, password: string): Promise<void> {
  const { token, user } = await postLogin(email, password)
  purgePersistedSettings()
  useStore.getState().setAuth(token, user)
}

export function logout(): void {
  purgePersistedSettings()
  useStore.getState().setAuth(null, null)
}

export async function restoreSession(): Promise<void> {
  const token = useStore.getState().token
  if (!token) {
    useStore.getState().setAuth(null, null)
    return
  }
  try {
    useStore.getState().setAuth(token, await getMe())
  } catch {
    useStore.getState().setAuth(null, null)
  }
}
```

`purgePersistedSettings()` clears the persisted blob so a previous user's
`currentDocId`, `lastProfileByLanguage` and collapse states do not leak into
the next session on a shared browser. Purge on **login** as well as logout:
logout is not guaranteed to have happened — a token can simply expire, and the
next person may log in on the same browser.

Note that clearing must not fight the persist middleware, which re-writes on
the next state change. Clear via zustand's `persist` API
(`useStore.persist.clearStorage()`) rather than touching `localStorage`
directly, and reset the in-memory fields the blob owns in the same action.

Add `postLogin` and `getMe` to the api client as ordinary `request()` calls.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/auth src/state`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/state/store.ts src/state/store.test.ts src/auth src/api/client.ts
git commit -m "$(cat <<'EOF'
feat(auth): frontend auth state and session actions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 4: Bearer header and 401 handling in the API client

**Files:**
- Modify: `frontend/src/api/client.ts`
- Test: `frontend/src/api/client.test.ts` (new)

**Interfaces:**
- Produces: every `request()` call carries `Authorization: Bearer <token>` when
  a token exists; a 401 from anything other than the login endpoint clears auth
  state; `HttpError` keeps its existing `{ status, message }` shape.

**The trap to avoid:** `request()` currently does

```ts
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
```

so a caller-supplied `init.headers` **replaces** `Content-Type` rather than
merging. Build the header object explicitly instead of relying on the spread,
or the Bearer header will silently drop `Content-Type` on POSTs.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/api/client.test.ts`, stubbing `globalThis.fetch`:

- a request made while a token is in the store sends
  `Authorization: Bearer <token>` **and** still sends
  `Content-Type: application/json`;
- a request made with no token sends no `Authorization` header;
- a 401 from a normal endpoint clears auth state;
- a 401 from `POST /api/auth/login` does **not** clear auth state and the
  `HttpError` reaches the caller — otherwise a wrong password would trigger a
  state-clearing loop;
- a **429** does not clear auth state — it is transient (spec §8);
- a 500 does not clear auth state.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/api/client.test.ts`
Expected: FAIL — no header is attached and no 401 branch exists.

- [ ] **Step 3: Implement**

In `request()`: read the token from the store, build headers explicitly, and
add the 401 branch. Express the login exemption as a property of the call, not
by string-matching the path at the point of failure — pass an option through
`request()` (e.g. `{ anonymous: true }`) that `postLogin` sets, so a future
endpoint that also must not clear state opts in explicitly rather than being
special-cased by URL.

Clearing state on 401 must go through the same `session.logout()` used
everywhere else, so the persisted blob is purged on this path too. Set
`sessionExpired: true` on this path only — a user who was thrown out mid-session
should be told why, whereas someone who chose "Log out" should not see an
error. `login()` clears the flag on success.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts src/api/client.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): attach the bearer token and handle 401 centrally

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 5: fetch-based SSE reader

**Files:**
- Modify: `frontend/src/api/client.ts`, `frontend/package.json`
- Test: `frontend/src/api/sse.test.ts` (new)

**Interfaces:**
- Consumes: `eventsource-parser` (new dependency).
- Produces: `subscribeCheck(checkId, handlers) => () => void` — **the same
  signature it has today**, so `checking/controller.ts` needs no change.

**Framing comes from the library; the lifecycle is ours.** `EventSource` cannot
send an `Authorization` header, which is why it goes — but it also gave us
framing, event dispatch and cancellation for free, and those now have to come
from somewhere. Spec §7.3 records the evaluation: `eventsource-parser` (MIT,
zero runtime dependencies, actively maintained) handles the generic, fiddly
half — frames split across chunks, `\r\n` vs `\n`, multi-line `data:`, comment
lines, the leading space that must be stripped. The fuller clients
(`@microsoft/fetch-event-source`, `eventsource-client`) were rejected because
both reconnect automatically, which is wrong for one-shot streams, and
`eventsource-client` treats only HTTP 204 as terminal — a 401 from an expired
token would produce a silent reconnect loop our central 401 handler never sees.

**What remains ours is the risky part of this task**, so treat the contract
below as binding. `controller.ts` depends on it:

- five event names: `checker_result`, `llm_progress`, `scorecard`,
  `checker_error`, `done`;
- `done` closes the stream and calls `handlers.onDone()`;
- **a network error is treated exactly like completion** — today's `onerror`
  closes and calls `onDone()`, surfacing nothing to the caller. Preserve that;
  a check that silently stops is the current behaviour and changing it here
  would be a second change wearing the same commit.
- the returned function is called **unconditionally and repeatedly** —
  `cancelCheck()` calls it, and `runCheck()` calls it again at the start of
  every new check. It must be idempotent and must never throw.

- [ ] **Step 1: Add the dependency**

Run from `frontend/`:

```bash
npm install eventsource-parser
```

Expected: a `dependencies` entry and a `package-lock.json` update. Note that
this repo pins install-script approvals in `package.json`'s `allowScripts`;
`eventsource-parser` has no install script and no runtime dependencies, so
nothing should need approving — say so in your report if `npm` disagrees.

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/api/sse.test.ts`. Stub `globalThis.fetch` to return a
`Response` whose `body` is a `ReadableStream` you push chunks into, so you can
control framing precisely. Cover:

- each of the five events dispatches to the right handler with parsed data;
- an event split across two chunks mid-frame is assembled correctly;
- `done` calls `onDone()` **exactly once** and stops reading;
- the unsubscribe function aborts the fetch, and calling it twice does not
  throw;
- a stream that ends without `done` calls `onDone()` (the network-error path),
  and does **not** call it a second time if `done` had already arrived;
- the request carries the `Authorization` header.

Do **not** re-test the library's own framing edge cases (`\r\n` separators,
multi-line `data:`, leading-space stripping, comment lines). Those are
`eventsource-parser`'s contract, covered by its own suite; asserting them here
would be testing the dependency rather than our code. The split-chunk case
stays because it verifies *we* feed the parser incrementally rather than
assuming whole frames.

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/api/sse.test.ts`
Expected: FAIL — `subscribeCheck` still constructs an `EventSource`.

- [ ] **Step 4: Implement**

Replace `subscribeCheck` with a `fetch()` + `AbortController` reader that feeds
chunks to the library's parser. Shape:

```ts
import { createParser, type EventSourceMessage } from 'eventsource-parser'

export function subscribeCheck(
  checkId: string,
  handlers: CheckEventHandlers,
): () => void {
  const controller = new AbortController()
  void readEvents(checkId, handlers, controller.signal)
  return () => controller.abort()
}
```

`readEvents` opens the request with the Bearer header and
`Accept: text/event-stream`, creates a parser with an `onEvent` callback that
dispatches on `event.event` to the five handlers, then reads `response.body`
through a `TextDecoder` and calls `parser.feed(chunk)` for each chunk.

Three things are yours to get right, and each has a test above:

1. **Settle exactly once.** `done` calls `onDone()`; so does an ended or failed
   stream. Guard with a flag so a `done` frame immediately followed by
   end-of-stream does not fire it twice.
2. **`AbortError` is the normal cancellation path**, not a failure — it must
   not surface as an error, and after an abort `onDone()` should not fire
   (`cancelCheck()` already resets the store itself).
3. **Any other error ends in `onDone()`**, matching today's semantics where a
   network error is indistinguishable from completion.

`AbortController` does not exist anywhere in this codebase yet; this is new
code, not a refactor.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/api src/checking`
Expected: PASS — including `controller.test.ts`, which mocks `subscribeCheck`
at the module level and therefore must be unaffected.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/api/client.ts src/api/sse.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): read check events over fetch so SSE can carry a bearer token

Framing via eventsource-parser; the one-shot lifecycle stays ours. See
spec 7.3 for why the fuller SSE clients were rejected.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 6: Auth strings in all seven locales

**Files:**
- Modify: `frontend/src/i18n/messages.ts` and `en.ts`, `de.ts`, `fr.ts`,
  `es.ts`, `it.ts`, `ja.ts`, `zh.ts`
- Test: `frontend/src/i18n/i18n.test.ts` (runs unchanged; it enforces parity)

The strings are written out below rather than left as "add auth strings",
because translation is a judgment call, not a mechanical one — the phrasing,
formality and typography below were chosen against the existing catalogs, and
an implementer should transcribe them, not invent them.

Conventions they follow, taken from the current files: flat camelCase keys
grouped under a comment header; parameterized messages are functions so each
language controls word order; sentences take a full stop, buttons and labels do
not; ellipsis is attached with no space (`checking: 'Checking…'`, `de: 'Prüft…'`);
locale-native quotes and punctuation (`fr` « » with narrow spaces, `es` ¿ ?,
`ja` 。, `zh` 。).

**Two formality choices worth a second opinion** — flag them in your report and
change them if the owner prefers otherwise: Spanish uses the *usted* form
(`Vuelva a intentarlo`), and Japanese uses ログイン/ログアウト rather than
サインイン, which is the more common register in Japanese software.

- [ ] **Step 1: Extend the `Messages` interface**

In `frontend/src/i18n/messages.ts`, add under a new `// Authentication`
comment header:

```ts
  // Authentication
  signInTitle: string
  signInEmail: string
  signInPassword: string
  signInSubmit: string
  signInPending: string
  signInInvalid: string
  signInFailed: string
  sessionExpired: string
  accountMenu: string
  accountChangePassword: string
  accountLogOut: string
  passwordCurrent: string
  passwordNew: string
  passwordConfirm: string
  passwordSubmit: string
  passwordCancel: string
  passwordMismatch: string
  passwordTooShort: (min: number) => string
  passwordCurrentWrong: string
  passwordChanged: string
  passwordFailed: string
```

- [ ] **Step 2: Add the catalogs**

Append to each locale file, before the closing brace:

`en.ts`

```ts
  // Authentication
  signInTitle: 'Sign in',
  signInEmail: 'Email',
  signInPassword: 'Password',
  signInSubmit: 'Sign in',
  signInPending: 'Signing in…',
  signInInvalid: 'Wrong email or password.',
  signInFailed: 'Sign-in failed. Please try again.',
  sessionExpired: 'Your session has ended. Please sign in again.',
  accountMenu: 'Account',
  accountChangePassword: 'Change password',
  accountLogOut: 'Log out',
  passwordCurrent: 'Current password',
  passwordNew: 'New password',
  passwordConfirm: 'Confirm new password',
  passwordSubmit: 'Change password',
  passwordCancel: 'Cancel',
  passwordMismatch: 'The new passwords do not match.',
  passwordTooShort: (min) => `The new password must be at least ${min} characters.`,
  passwordCurrentWrong: 'The current password is not correct.',
  passwordChanged: 'Password changed.',
  passwordFailed: 'Changing the password failed.',
```

`de.ts`

```ts
  // Authentifizierung
  signInTitle: 'Anmelden',
  signInEmail: 'E-Mail',
  signInPassword: 'Passwort',
  signInSubmit: 'Anmelden',
  signInPending: 'Meldet an…',
  signInInvalid: 'E-Mail oder Passwort ist falsch.',
  signInFailed: 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.',
  sessionExpired: 'Die Sitzung ist beendet. Bitte erneut anmelden.',
  accountMenu: 'Konto',
  accountChangePassword: 'Passwort ändern',
  accountLogOut: 'Abmelden',
  passwordCurrent: 'Aktuelles Passwort',
  passwordNew: 'Neues Passwort',
  passwordConfirm: 'Neues Passwort bestätigen',
  passwordSubmit: 'Passwort ändern',
  passwordCancel: 'Abbrechen',
  passwordMismatch: 'Die neuen Passwörter stimmen nicht überein.',
  passwordTooShort: (min) => `Das neue Passwort muss mindestens ${min} Zeichen lang sein.`,
  passwordCurrentWrong: 'Das aktuelle Passwort ist nicht korrekt.',
  passwordChanged: 'Passwort geändert.',
  passwordFailed: 'Ändern des Passworts fehlgeschlagen.',
```

`fr.ts`

```ts
  // Authentification
  signInTitle: 'Connexion',
  signInEmail: 'E-mail',
  signInPassword: 'Mot de passe',
  signInSubmit: 'Se connecter',
  signInPending: 'Connexion…',
  signInInvalid: 'E-mail ou mot de passe incorrect.',
  signInFailed: 'Échec de la connexion. Veuillez réessayer.',
  sessionExpired: 'Votre session a pris fin. Veuillez vous reconnecter.',
  accountMenu: 'Compte',
  accountChangePassword: 'Changer le mot de passe',
  accountLogOut: 'Se déconnecter',
  passwordCurrent: 'Mot de passe actuel',
  passwordNew: 'Nouveau mot de passe',
  passwordConfirm: 'Confirmer le nouveau mot de passe',
  passwordSubmit: 'Changer le mot de passe',
  passwordCancel: 'Annuler',
  passwordMismatch: 'Les nouveaux mots de passe ne correspondent pas.',
  passwordTooShort: (min) =>
    `Le nouveau mot de passe doit comporter au moins ${min} caractères.`,
  passwordCurrentWrong: 'Le mot de passe actuel est incorrect.',
  passwordChanged: 'Mot de passe modifié.',
  passwordFailed: 'Échec de la modification du mot de passe.',
```

`es.ts`

```ts
  // Autenticación
  signInTitle: 'Iniciar sesión',
  signInEmail: 'Correo electrónico',
  signInPassword: 'Contraseña',
  signInSubmit: 'Iniciar sesión',
  signInPending: 'Iniciando sesión…',
  signInInvalid: 'Correo electrónico o contraseña incorrectos.',
  signInFailed: 'No se pudo iniciar sesión. Vuelva a intentarlo.',
  sessionExpired: 'La sesión ha finalizado. Inicie sesión de nuevo.',
  accountMenu: 'Cuenta',
  accountChangePassword: 'Cambiar contraseña',
  accountLogOut: 'Cerrar sesión',
  passwordCurrent: 'Contraseña actual',
  passwordNew: 'Nueva contraseña',
  passwordConfirm: 'Confirmar nueva contraseña',
  passwordSubmit: 'Cambiar contraseña',
  passwordCancel: 'Cancelar',
  passwordMismatch: 'Las nuevas contraseñas no coinciden.',
  passwordTooShort: (min) => `La nueva contraseña debe tener al menos ${min} caracteres.`,
  passwordCurrentWrong: 'La contraseña actual no es correcta.',
  passwordChanged: 'Contraseña cambiada.',
  passwordFailed: 'No se pudo cambiar la contraseña.',
```

`it.ts`

```ts
  // Autenticazione
  signInTitle: 'Accedi',
  signInEmail: 'E-mail',
  signInPassword: 'Password',
  signInSubmit: 'Accedi',
  signInPending: 'Accesso in corso…',
  signInInvalid: 'E-mail o password non corretti.',
  signInFailed: 'Accesso non riuscito. Riprova.',
  sessionExpired: 'La sessione è terminata. Effettua di nuovo l’accesso.',
  accountMenu: 'Account',
  accountChangePassword: 'Cambia password',
  accountLogOut: 'Esci',
  passwordCurrent: 'Password attuale',
  passwordNew: 'Nuova password',
  passwordConfirm: 'Conferma nuova password',
  passwordSubmit: 'Cambia password',
  passwordCancel: 'Annulla',
  passwordMismatch: 'Le nuove password non coincidono.',
  passwordTooShort: (min) => `La nuova password deve contenere almeno ${min} caratteri.`,
  passwordCurrentWrong: 'La password attuale non è corretta.',
  passwordChanged: 'Password modificata.',
  passwordFailed: 'Modifica della password non riuscita.',
```

`ja.ts`

```ts
  // 認証
  signInTitle: 'ログイン',
  signInEmail: 'メールアドレス',
  signInPassword: 'パスワード',
  signInSubmit: 'ログイン',
  signInPending: 'ログインしています…',
  signInInvalid: 'メールアドレスまたはパスワードが正しくありません。',
  signInFailed: 'ログインに失敗しました。もう一度お試しください。',
  sessionExpired: 'セッションが終了しました。もう一度ログインしてください。',
  accountMenu: 'アカウント',
  accountChangePassword: 'パスワードを変更',
  accountLogOut: 'ログアウト',
  passwordCurrent: '現在のパスワード',
  passwordNew: '新しいパスワード',
  passwordConfirm: '新しいパスワード（確認）',
  passwordSubmit: 'パスワードを変更',
  passwordCancel: 'キャンセル',
  passwordMismatch: '新しいパスワードが一致しません。',
  passwordTooShort: (min) => `新しいパスワードは${min}文字以上で入力してください。`,
  passwordCurrentWrong: '現在のパスワードが正しくありません。',
  passwordChanged: 'パスワードを変更しました。',
  passwordFailed: 'パスワードの変更に失敗しました。',
```

`zh.ts`

```ts
  // 身份验证
  signInTitle: '登录',
  signInEmail: '邮箱',
  signInPassword: '密码',
  signInSubmit: '登录',
  signInPending: '正在登录…',
  signInInvalid: '邮箱或密码不正确。',
  signInFailed: '登录失败，请重试。',
  sessionExpired: '会话已结束，请重新登录。',
  accountMenu: '账户',
  accountChangePassword: '修改密码',
  accountLogOut: '退出登录',
  passwordCurrent: '当前密码',
  passwordNew: '新密码',
  passwordConfirm: '确认新密码',
  passwordSubmit: '修改密码',
  passwordCancel: '取消',
  passwordMismatch: '两次输入的新密码不一致。',
  passwordTooShort: (min) => `新密码至少需要 ${min} 个字符。`,
  passwordCurrentWrong: '当前密码不正确。',
  passwordChanged: '密码已修改。',
  passwordFailed: '修改密码失败。',
```

The parity test fails if any locale is missing a key, which is the check that
this task is complete.
Keep the wording plain and short — these are UI strings, not documentation.

- [ ] **Step 3: Run the parity test**

Run: `npx vitest run src/i18n`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/i18n
git commit -m "$(cat <<'EOF'
feat(i18n): auth strings for the login gate and account menu

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 7: Login gate

**Files:**
- Create: `frontend/src/auth/LoginGate.tsx`, `frontend/src/auth/LoginForm.tsx`
- Modify: `frontend/src/main.tsx`, `frontend/src/App.tsx`
- Test: `frontend/src/auth/LoginGate.test.tsx` (new)

**Interfaces:**
- Consumes: `authStatus`, `restoreSession()`, `login()` from Task 3.
- Produces: `<LoginGate>{children}</LoginGate>`.

**The sequencing hazard, and why the gate must wrap rather than sit beside the
app:** `App.tsx`'s `useEffect` calls `initDocuments()` on mount, and `Header()`
fetches providers, domains, languages and routing on mount. Both fire the
instant the component mounts. If the gate renders `<App/>` while
unauthenticated — or if `App` is mounted and merely hidden — those effects run
and produce a burst of 401s. `LoginGate` must not render its children at all
until `authStatus === 'authenticated'`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/auth/LoginGate.test.tsx`:

- while `authStatus` is `'unknown'`, children are **not** rendered and no login
  form is shown;
- when `sessionExpired` is set, the gate shows the session-expired notice above
  the form; after a plain log-out it does not;
- while `'anonymous'`, the login form is shown and children are **not**
  rendered;
- while `'authenticated'`, children are rendered and the form is not;
- submitting valid credentials calls `login()`;
- a rejected `login()` renders the invalid-credentials message and leaves the
  form visible.

Assert children are absent via a sentinel child element, so the test pins
"not rendered" rather than "not visible".

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/auth/LoginGate.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

`LoginGate` calls `restoreSession()` once on mount and switches on
`authStatus`: render nothing while `'unknown'`, `<LoginForm/>` while
`'anonymous'`, `children` while `'authenticated'`.

`LoginForm` is a controlled email/password form that calls `login()` on submit,
shows the invalid-credentials message for an `HttpError` with status 401 and
the generic failure message otherwise, disables the submit button while in
flight, and uses the i18n keys from Task 6. It is a full-screen layout — the
unauthenticated user must not see the editor chrome, document sidebar or nav
(spec §8).

In `main.tsx`, wrap: `<StrictMode><LoginGate><App /></LoginGate></StrictMode>`.

Check whether `App.tsx`'s mount effects need any further guard once the gate is
in place. If the gate genuinely never renders `App` unauthenticated they do
not, and adding a second guard would be redundant — verify rather than assume,
and say which you found in your report.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth src/main.tsx src/App.tsx
git commit -m "$(cat <<'EOF'
feat(auth): full-screen login gate above the app shell

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 8: Account menu

**Files:**
- Create: `frontend/src/auth/AccountMenu.tsx`
- Modify: `frontend/src/App.tsx` (the in-file `Header`)
- Test: `frontend/src/auth/AccountMenu.test.tsx` (new)

**Interfaces:**
- Consumes: `user` from the store, `logout()` from Task 3, `postPasswordChange`
  on the api client.

Without this, `POST /api/auth/password` and logging out have no entry point in
the UI at all.

- [ ] **Step 1: Write the failing test**

Cover: the signed-in email is shown; the menu offers change-password and
log-out; log-out calls `logout()`; a successful password change shows the
success message; a 401 from the change endpoint (wrong current password) shows
the invalid-credentials message **without** logging the user out — the client's
401 branch from Task 4 must be exempted for this call the same way login is,
or changing a password with one typo throws the user out of the app.

That last case is the one worth writing first; it is the non-obvious
interaction between this task and Task 4.

- [ ] **Step 2: Run it and watch it fail**
- [ ] **Step 3: Implement**

`AccountMenu` renders the user's email and a small menu, following whatever
pattern the existing header selectors use rather than inventing a new one.
Mount it in `Header()` alongside the other global controls.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth src/App.tsx src/api/client.ts
git commit -m "$(cat <<'EOF'
feat(auth): account menu with password change and log out

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 9: Shared authenticated test client

**Files:**
- Modify: `backend/tests/conftest.py`
- Test: exercised by Task 10; no test of its own.

**Interfaces:**
- Produces: a fixture that yields a `TestClient` whose requests already carry a
  valid bearer token for a seeded user, plus a way to get a second user's
  client for tests that need two identities.

Ten test files currently build their own `TestClient(create_app(...))` with no
shared fixture and send no `Authorization` header. Task 10 turns every one of
those requests into a 401 unless they are updated. Doing that ten different
ways is how a subtly wrong edit slips through, so build the shared fixture
first.

- [ ] **Step 1: Write the fixture**

Add to `backend/tests/conftest.py` a fixture that builds the app with
`tmp_path` settings and returns a client with the header pre-attached
(`TestClient(app, headers=...)` applies it to every request, which is cleaner
than editing hundreds of call sites).

The bootstrap admin is seeded as id 1 by `seed_admin`; use it rather than
creating another user, so the fixture matches what the app actually does at
startup.

- [ ] **Step 2: Prove it works on one file**

Convert `backend/tests/test_languages_api.py` — the smallest of the ten — to
the fixture, ahead of enforcement. It must still pass, since an ignored
`Authorization` header changes nothing while the router is open.

Run: `uv run pytest tests/test_languages_api.py -q`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/conftest.py tests/test_languages_api.py
git commit -m "$(cat <<'EOF'
test(auth): shared authenticated client fixture

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 10: Enforce authentication on every feature router

**Files:**
- Modify: `backend/app/main.py`
- Modify: the nine remaining API test files
- Test: `backend/tests/test_auth_enforcement.py` (new)

**Interfaces:**
- Consumes: `get_current_user` (M1), the fixture from Task 9.

This is the switch-flip. The frontend has been ready since Task 8.

- [ ] **Step 1: Write the failing enforcement test**

Create `backend/tests/test_auth_enforcement.py`. Rather than listing endpoints
by hand — a list that silently rots as routes are added — walk the app's own
route table and assert that every route under `/api/` requires authentication,
with an explicit allowlist of the two public ones:

```python
PUBLIC = {("/api/health", "GET"), ("/api/auth/login", "POST")}
```

For each remaining route, issue an unauthenticated request and assert **401**.
Use a path that satisfies any parameters (`{id}` → `1`); a 404 or 422 from a
nonexistent id would mean the request got past auth, so assert specifically on
401 rather than "not 200".

This test is the real deliverable of the task: it fails the moment someone adds
an unauthenticated route.

- [ ] **Step 2: Run it and watch it fail**

Run: `uv run pytest tests/test_auth_enforcement.py -q`
Expected: FAIL — most routes answer 200.

- [ ] **Step 3: Apply the dependency**

In `backend/app/main.py`, register the ten feature routers with a router-level
dependency, matching how `admin_router` already carries `require_admin`:

```python
    protected = [
        terminology_router, checks_router, languages_router, rules_router,
        providers_router, suggestions_router, documents_router,
        folders_router, profiles_router, routing_router,
    ]
    for router in protected:
        app.include_router(router, dependencies=[Depends(get_current_user)])
```

Attaching at inclusion rather than editing ten router files keeps the policy in
one readable place, and a router added to `main.py` without the dependency is
visible in the diff. Add a comment saying that, and that `auth_router` is
excluded because `POST /auth/login` must stay public while its own endpoints
declare `get_current_user` individually.

- [ ] **Step 4: Update the nine remaining test files**

Convert them to the Task 9 fixture. Work file by file, running each as you go:

`test_check_api.py`, `test_documents_api.py`, `test_folders_api.py`,
`test_profiles_api.py`, `test_providers_api.py`, `test_routing_api.py`,
`test_rules_api.py`, `test_terminology_api.py`, `test_suggestions_api.py`
(if present — confirm the file list against the directory rather than trusting
this list).

`test_health.py` needs no change; health stays public.

Watch for tests that construct their own app to pass unusual settings — those
need the header attached, not the fixture wholesale.

- [ ] **Step 5: Run the full suite**

Run: `rtk proxy uv run pytest -q`
Expected: all pass, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add app/main.py tests/
git commit -m "$(cat <<'EOF'
feat(auth): require authentication on every feature router

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 11: End-to-end verification, documentation and PR

**Files:**
- Modify: `docs/backend-architecture.md`, `docs/frontend-architecture.md`,
  `docs/LOGBOOK.md`, `README.md`

- [ ] **Step 1: Audit the XSS defenses the spec makes binding**

M2 is the milestone that puts a bearer token in `localStorage`, which is what
turns any successful XSS into account theft. Spec §8 therefore makes two client
rules binding, and this is the point to verify them rather than assume:

1. **No user-supplied or LLM-generated content is rendered as raw HTML.** Grep
   the frontend for `dangerouslySetInnerHTML` and for any HTML-string
   assignment (`innerHTML`). Findings, suggestions, messages, document names
   and terminology all carry text that ultimately came from a user or a model.
2. **No dynamic `href`/`src` built from user or LLM content** without scheme
   validation — a `javascript:` URL in an attribute is the same hole by another
   route.

Report what you searched for and what you found. If the audit is clean, say so
explicitly; if it turns up a real occurrence, fix it in this task and note it —
do not defer it to the docs step.

(The third and fourth parts of that spec section — a strict Content-Security-Policy
and dependency hygiene — belong to the deployment sub-project and the existing
dependabot setup respectively, not to M2.)

- [ ] **Step 2: Run both gates**

From `backend/`: `rtk proxy uv run pytest -q` — all green, zero warnings.
From `frontend/`: `npx vitest run && npx tsc --noEmit && npm run lint && npm run build`.

- [ ] **Step 3: Verify by running the application**

Start the backend against a **scratch** database (never
`backend/data/fabulous.db`) with `FW_AUTH_SECRET`, `FW_ADMIN_EMAIL` and
`FW_ADMIN_PASSWORD` set, and the frontend dev server on a port that is **not**
5173 if one is already running — the owner runs their own servers on 8000 and
5173 and those must never be touched. Record the PIDs you start and kill only
those.

Confirm, and report what you observed rather than that it "worked":

1. loading the app unauthenticated shows the login gate and **no** editor
   chrome, and the network panel shows no `/api/*` calls other than
   `/api/auth/me`;
2. a wrong password shows the inline error and does not clear the form into a
   loop;
3. a correct password loads the editor and documents;
4. a check runs to completion — this exercises the new SSE reader end to end,
   which no unit test does;
5. cancelling a check mid-run stops it and leaves the UI in idle;
6. changing the password via the account menu succeeds, and the session
   survives it or requires a fresh login — say which, and confirm it matches
   Task 2's revocation behaviour;
7. logging out returns to the gate and clears the persisted blob.

- [ ] **Step 4: Update the architecture docs**

Record in `docs/backend-architecture.md`: CORS is config-driven; every feature
router carries a router-level auth dependency; `password_changed_at` and how it
revokes sessions. In `docs/frontend-architecture.md`: the auth slice, the gate,
where the Bearer header is attached, the fetch-based SSE reader and why
`EventSource` was replaced, and the purge-on-user-change rule.

State explicitly that data is **not** owner-scoped yet and that M3 does it.

- [ ] **Step 5: Update the README**

The Quick start's environment variables are unchanged, but the app now requires
a login. Say so, and that the bootstrap admin credentials are what to sign in
with the first time.

- [ ] **Step 6: Append the LOGBOOK entry**

Run `date '+%Y-%m-%d'` first and use exactly that. Record what M2 delivered,
the commit range, the before/after test counts for both suites, and that
ownership scoping is still M3.

- [ ] **Step 7: Commit, push, open the PR**

```bash
git add docs README.md
git commit -m "$(cat <<'EOF'
docs: record the M2 enforcement milestone

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
git push -u origin multi-user-enforcement
```

Open the PR describing: what is enforced, that the frontend ships with it, the
revocation change, and — prominently — that **data is not yet owner-scoped**,
so a reviewer does not read a missing ownership filter as a defect. Request a
Copilot review and resolve every thread.
