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

- Branch `multi-user-m2-implementation`, branched from `main` at `d111691` —
  the squash-merge of PR #22, which carried this plan. All eleven tasks ship
  in **one** PR: Task 10 is where the pieces first have to fit together, and
  merging Tasks 1–8 ahead of it would commit assumptions it may invalidate.
- **At the Task 8 boundary**, before starting Task 9: run a cross-task review
  of Tasks 1–8 — aimed at the seams the per-task gates cannot see, chiefly the
  injection wiring, the three session-end paths, and the shared 401 handler
  both `request()` and the SSE reader depend on — then push, open the PR as a
  **draft**, and take one Copilot round on the partial branch. Tasks 9–11
  continue on the same branch and PR; mark it ready for review when Task 11 is
  done.
- Request a Copilot review at the end as well, and **resolve every review
  thread** — the `main` ruleset blocks merge while any thread is open. Copilot
  auto-review on push is **disabled**, so rounds are requested explicitly. A
  round reporting few or no findings means nothing unless the changed files
  were in its read set: check the "reviewed N out of M changed files" line.
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
- **One home per requirement.** Where a snippet and prose describe the same
  behaviour, the **snippet is canonical** and the prose explains only *why*.
  Seven rounds of review on this document kept finding the same defect shape:
  a fix landed in the prose and the snippet still said the old thing, or the
  reverse. Implementers transcribe snippets. If you change one, check whether
  prose nearby now disagrees.

## Decisions this plan makes

Recorded here because a reviewer should be able to challenge them without
reading the tasks:

1. **Persisted store: purge on user change, not namespace per user.** The spec
   allows either (§8, "namespaced by user id or purged on login/logout").
   Purging is simpler, keeps localStorage bounded on a shared browser, and has
   no failure mode where a stale namespace resurfaces. The cost is that
   per-user UI preferences do not survive a logout, which is acceptable for the
   six persisted keys involved. The *document* buffer is treated separately —
   see Task 3; purging it on expiry would turn an expired token into data loss.
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
5. **Component tests are adopted, reversing the 2026-07-12 "keep
   no-component-test convention" triage.** M2 adds the first components whose
   *behaviour* is security-relevant — the gate deciding not to render the app,
   the account menu not signing you out on a mistyped password — and neither
   property is expressible as a pure function without contorting the design.
   Task 7 Step 1 adds `@testing-library/react`; the LOGBOOK records the
   reversal so it reads as a decision rather than drift.
6. **A successful password change re-authenticates silently** rather than
   signing the user out. Task 2 makes their own token stale the instant the
   change succeeds; the client calls `login()` with the new password before
   showing the success message. Sessions on other devices are still evicted,
   which is the point of the revocation. The alternative — returning a fresh
   token from `POST /api/auth/password` — would amend spec §7.1's 204 and was
   not worth it for one caller.

## File Structure

| File | Responsibility |
|---|---|
| `backend/app/core/config.py` (modify) | `CorsSettings` + `Settings.cors`. |
| `backend/app/main.py` (modify) | CORS from settings; router-level auth dependency on the ten feature routers. |
| `backend/app/services/users.py` (modify) | `password_changed_at` column, written by `set_password`. |
| `backend/app/api/deps.py` (modify) | Reject a token issued before `password_changed_at`. |
| `backend/tests/conftest.py` (modify) | Shared `authed_client` fixture so ten test files stop hand-rolling tokens. |
| `frontend/src/state/store.ts` (modify) | Auth slice (`token`, `user`, `authStatus`, `sessionExpired`); persist purge on user change. |
| `frontend/src/documents/buffer.ts` (modify) | `ownerId` on `DocSnapshot`, so the document buffer can be cleared for a different user without destroying the owner's unsaved work. |
| `frontend/src/api/client.ts` (modify) | Bearer header in `request()`; `HttpError` gains an optional `code` parsed from the error body; `subscribeCheck` rewritten on `fetch` + `AbortController`. |
| `frontend/src/auth/LoginGate.tsx` (new) | Full-screen gate replacing the app shell while unauthenticated. |
| `frontend/src/auth/LoginForm.tsx` (new) | Email/password form, inline error handling. |
| `frontend/src/auth/AccountMenu.tsx` (new) | Header menu: change password, log out. |
| `frontend/src/auth/session.ts` (new) | `login()`, `logout()`, `expireSession()`, `restoreSession()` — the only writers of auth state. |
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
def test_cors_allows_only_the_configured_origin(tmp_path):
    # A deliberately NON-default origin. Testing with the default
    # http://localhost:5173 would pass against an implementation that simply
    # hard-codes that string in place of "*" and never reads settings.cors —
    # which is the entire point of this task.
    configured = "https://writing.example.test"
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        cors={"origins": [configured]},
    )
    client = TestClient(create_app(settings))

    def preflight(origin: str):
        return client.options(
            "/api/health",
            headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
        )

    assert preflight(configured).headers["access-control-allow-origin"] == configured
    # The default is denied when it is not the configured value — this is the
    # assertion a hard-coded implementation fails.
    assert "access-control-allow-origin" not in preflight("http://localhost:5173").headers
    assert "access-control-allow-origin" not in preflight("https://evil.example.com").headers
```

`test_health.py` builds `Settings` inline rather than via a helper
(`tests/test_health.py:18-19`); this follows that shape.

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
    origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
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
- `UserStore` has **no** `_migrate` method today (unlike `documents.py` and
  `folders.py`), so create one and call it from `__init__` immediately after
  `conn.executescript(_SCHEMA)`, using the shared `migrate_columns(conn,
  "users", [("password_changed_at", "TEXT")])` from `app/services/_sqlite.py`.
  This database already exists in the field, so a bare DDL change would not
  reach it;
- add `password_changed_at: str | None = None` to the `User` model and to
  `_row_to_user`;
- have `set_password` write `_utcnow()` into it in the same `UPDATE` —
  second granularity, the same as every other timestamp in this store.

  **This is load-bearing, and the obvious "more precise is safer" instinct is
  wrong here.** `issue_token` floors `iat` to the second
  (`int(issued.timestamp())`, `core/auth.py:173`). If `password_changed_at`
  carried sub-second precision, the token minted by the silent re-login in
  Task 8 would floor to *before* it and be rejected on its first use — a login
  loop. Verified: with `password_changed_at = …:06.628` a fresh token whose
  `iat` is `…:06` compares as older and is refused.

  Flooring both sides and comparing strictly gives the right answer on both
  sides of the change: a token minted two seconds earlier is rejected
  (`floor(t-2) < floor(t)`), and the replacement token minted in the same
  second is accepted (`floor(t) < floor(t)` is false).

  Residual, accepted: a token minted earlier in the *same second* as the change
  survives. The window is under one second and requires the attacker's token to
  have been issued in that second — a far better trade than a re-login that
  cannot succeed.

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
    # Mint the "before" token explicitly in the past rather than relying on
    # wall-clock ordering: iat is floored to the second, so a token minted in
    # the same second as the change would not be provably older.
    old = issue_token(user.id, SECRET, now=datetime.now(UTC) - timedelta(seconds=2))
    stale = {"Authorization": f"Bearer {old}"}
    assert client.get("/probe/user", headers=stale).status_code == 200
    store.set_password(user.id, "a replacement password")
    assert client.get("/probe/user", headers=stale).status_code == 401
    # The replacement token is minted at the recorded change timestamp, not at
    # "now" — this is the same-second equality case that makes Task 8's silent
    # re-login work, and minting at wall-clock time could drift into the next
    # second and stop exercising it. A regression to a sub-second
    # password_changed_at fails here.
    changed_at = datetime.fromisoformat(store.get_user(user.id).password_changed_at)
    fresh = issue_token(user.id, SECRET, now=changed_at)
    assert client.get(
        "/probe/user", headers={"Authorization": f"Bearer {fresh}"}
    ).status_code == 200
```

- [ ] **Step 5: Reject stale tokens**

`get_current_user` currently discards the token's claims after `verify()`
returns the user id. It now needs `iat` as well.

Change `TokenVerifier.verify` to return the id **and** the issue time, using an
explicit type rather than a bare tuple:

```python
@dataclass(frozen=True)
class VerifiedToken:
    user_id: int          # always the LOCAL users.id, in every auth mode
    issued_at: datetime   # tz-aware UTC
```

`LocalTokenVerifier.verify` builds it from the already-guarded numeric parse —
**do not hand `claims["iat"]` straight to `fromtimestamp`.** The current code
does `float(claims["iat"])` inside `try/except (TypeError, ValueError)` and
re-raises `InvalidToken`; that guard exists because M1 shipped a leak where a
crafted `iat` escaped as a raw `ValueError`/`TypeError` and became a 500 on the
auth path. `fromtimestamp` rejects a numeric *string* that `float()` accepts,
and an out-of-range value raises `OverflowError`, which is in neither the
existing tuple nor `PyJWTError`. Parse once and convert inside the same guard:

```python
        try:
            issued_at = datetime.fromtimestamp(float(claims["iat"]), UTC)
        except (TypeError, ValueError, OverflowError, OSError) as exc:
            raise InvalidToken("iat is not a usable timestamp") from exc
```

Keep the existing future-drift check against `issued_at`. Update the protocol and the
docstring that says it returns the local `users.id` — it still does, alongside
`iat`. Say in a comment why `iat` crosses this boundary: the request path, not
the verifier, owns the revocation policy, because a Supabase verifier will not
know about `password_changed_at`.

Then in `get_current_user`, after the user row is read:

```python
    if user.password_changed_at and verified.issued_at < datetime.fromisoformat(
        user.password_changed_at
    ):
        raise HTTPException(401, _UNAUTHENTICATED)
```

Both sides are tz-aware UTC — `issued_at` from `fromtimestamp(..., UTC)` and
`password_changed_at` from `_utcnow()` — and both are at second granularity,
which is what makes the strict `<` correct on both sides of a change (Step 3).
Getting this wrong in the obvious way (`int < datetime`) raises `TypeError` on
**every authenticated request**, so it is worth checking the types line up
before running anything. Reuse the same generic 401 — which failure occurred is
not the caller's business.

- [ ] **Step 6: Run the tests**

Run: `uv run pytest -q`
Expected: all pass, zero warnings. Existing `verify()` callers and tests in
`test_auth_core.py` will need updating for the changed return type — that is
expected churn, not a regression.

- [ ] **Step 7: Rehearse the migration on a copy of the live database**

```bash
# Task 2's commands run from backend/, so this path is backend-relative —
# "backend/data/..." would resolve to backend/backend/data/... and fail.
cp data/fabulous.db /tmp/fw-m2-rehearsal.db
```

Then open the copy with `UserStore(Path('/tmp/fw-m2-rehearsal.db'))` and check
two things. `get_user(1).password_changed_at is None` is necessary but
trivially true — `create_user` never sets it, so it would pass even if the
migration silently did nothing. Assert the column actually exists:

```python
import sqlite3
from pathlib import Path

rehearsal = Path("/tmp/fw-m2-rehearsal.db")
UserStore(rehearsal)                       # runs the migration
with sqlite3.connect(rehearsal) as conn:   # UserStore keeps its connection private
    cols = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
assert "password_changed_at" in cols
```

**Never point this at `backend/data/fabulous.db`.** Delete the copy afterwards.

Note the bootstrap admin also has `password_changed_at is None`, which is
correct: they have never *changed* a password, so no revocation point exists
and every token they hold stays valid until it expires.

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
- Modify: `frontend/src/state/store.ts` (auth fields, `INITIAL_DATA`,
  `resetSessionState()`), `frontend/src/documents/buffer.ts` (add `ownerId` to
  `DocSnapshot`), `frontend/src/documents/autosave.ts` (populate it in
  `collectSnapshot()`; the generation check on deferred writes),
  `frontend/src/documents/documents.ts` (`invalidateDocumentWork()`,
  `clearLegacyText()`, the generation check on `initDocuments`' post-`await`
  writes), `frontend/src/checking/controller.ts` (register
  `cancelInFlightCheck` through the injection setter — `cancelCheck()` lives
  here, at `:16`, and `session.ts` must not import this module),
  `frontend/src/api/client.ts` (`postLogin`, `getMe`,
  `setUnauthorizedHandler`)
- Create: `frontend/src/auth/session.ts`
- Test: `frontend/src/state/store.test.ts` (append),
  `frontend/src/auth/session.test.ts` (new),
  `frontend/src/documents/documents.test.ts` and
  `frontend/src/documents/autosave.test.ts` (the `ownerId` literals and the
  in-flight handoff cases)

This list and the `git add` in Step 7 must name the same files; they are the
same fact written twice, which is what the one-home constraint is about.

**Interfaces:**
- Produces: on the store, `token: string | null`, `user: MeResponse | null`,
  `authStatus: 'unknown' | 'anonymous' | 'authenticated'`,
  `sessionExpired: boolean`; `session.ts` exporting
  **`login(email, password): Promise<boolean>`** — `false` means the session
  changed while the request was in flight and the result was discarded —
  `logout()`, **`expireSession()`**, `restoreSession()`, and
  `sessionGeneration()`. Task 7's gate re-renders off `authStatus` and can
  ignore the return value; Task 8's silent re-authentication cannot.
- Consumes: `setUnauthorizedHandler(fn)` — which is defined and exported by
  `client.ts`, **not** by `session.ts`. `session.ts` registers `expireSession`
  through it at module load. Getting this backwards recreates the import cycle
  the injection exists to break; see the import-direction note below.

**Three ways a session ends, three functions.** `logout()` and
`expireSession()` differ in exactly one respect — what happens to the document
buffer — and conflating them destroys unsaved work, so they are separate
exports rather than one function with a flag. Task 4 calls `expireSession()`,
never `logout()`.

`MeResponse` is a **new frontend type** mirroring the backend's response —
`{ id: number; email: string; display_name: string | null; tier: string;
is_admin: boolean }` — declared in `client.ts` beside the other response types.
M4 and M5 extend this same type rather than adding a second one.

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
  sessionExpired: boolean
  restoreFailed: boolean
```

with initial values `null`, `null`, `'unknown'`, `false`, `false`, and a setter
`setAuth(token: string | null, user: MeResponse | null)` that sets the first
three consistently (`authStatus` derived: `'authenticated'` when both are
present, `'anonymous'` otherwise).

Two flags, two different rules, and they are not symmetric:

- **`setAuth` leaves `sessionExpired` untouched.** Only `expireSession()` sets
  it and only `login()` clears it, so a re-login after an expiry does not race
  the setter.
- **`setAuth` always clears `restoreFailed`.** Reaching a resolved auth state
  at all means the server answered, so the connection-failure branch is stale
  by definition. Without this the flag is set once and never cleared —
  `restoreSession()`'s success path only calls `setAuth`, so a later
  successful restore would still render the connection message.

Add `token` — and only `token` — to `partialize`. **Leave `version` at `2`.**
Adding a key to the `partialize` allowlist needs no migration (an older blob
simply lacks it, and `token: null` is the correct initial value), and a version
bump whose `migrate` branch is admittedly a pass-through buys a diff marker at
the cost of a branch that can never be exercised. Note the addition in the
comment above `persistConfig` instead.

**`resetSessionState()` resets the whole data half of the store, not just the
persisted blob.** Clearing `localStorage` alone leaves the in-memory fields
untouched and the middleware writes them straight back on the next state
change. Worse, most of the store is *not* persisted and is therefore invisible
to `persist.clearStorage()`: `tracked` (findings, each carrying the flagged
text), `scorecard`, `extraSuggestions`, `rewrites`, `documents` (titles),
`docMeta` and `folders` (names) all live only in memory. The store is
module-level and survives the gate swap, so the next account renders the
previous one's document list, folders and findings until async initialisation
replaces them — and indefinitely if that initialisation fails (`docListError`).

Enumerating the fields to reset would leave the next field someone adds
leaking, so do not enumerate. Extract the initial-state object literal inside
`create()` (`store.ts:202-245`) into an exported `INITIAL_DATA` const, have
`create()` spread it, and define:

```ts
export function resetSessionState(): void {
  useStore.persist.clearStorage()
  useStore.setState(INITIAL_DATA)   // shallow merge: the actions survive
}
```

`INITIAL_DATA` holds data fields only — not the actions, and not the five auth
fields added below (`token`, `user`, `authStatus`, `sessionExpired`,
`restoreFailed`), which every caller sets explicitly right afterwards. Declare
those outside the literal so the split is structural rather than a comment
someone has to remember to obey.

Test it by dirtying the store across the board — `tracked`, `documents`,
`folders`, `docMeta`, `scorecard`, `rewrites`, `uiLocale`, `currentDocId` —
calling `logout()`, and asserting each is back to its initial value.

Keep exporting the same `persistConfig` object reference — `store.test.ts`
asserts against it directly, as the comment above it explains.

- [ ] **Step 4: Write the failing session test**

Create `frontend/src/auth/session.test.ts` covering:

- `login()` stores the token and user returned by the API and flips
  `authStatus` to `'authenticated'`;
- `login()` with bad credentials leaves `authStatus` at `'anonymous'` and
  propagates the error to the caller rather than swallowing it (the form
  renders it inline);
- `logout()` clears token, user, the persisted settings blob **and the document
  buffer**, resets `checkPhase`, then sets `'anonymous'`;
- the 401/expiry path clears the settings blob but **keeps** the document
  buffer, so unsaved work survives signing back in;
- `login()` clears a document buffer belonging to a different `ownerId`, and
  keeps one belonging to the user signing in;
- **`login()` as the *same* user preserves the persisted settings** — this is
  the path Task 8's silent re-authentication takes after a password change, and
  purging there would reset locale, current document and collapse states for
  someone who never switched accounts;
- `login()` as a *different* user purges them, **including the runtime state
  the persisted blob does not own** — dirty `tracked`, `documents`, `folders`
  and `scorecard` first and assert the new user sees none of it;
- **`login()` returns `false` and commits nothing when `logout()` runs while
  `postLogin` is in flight** — assert the token, `user` and `authStatus` are
  those of the logged-out session, not the returned ones;
- **`logout()` and `expireSession()` both call `invalidateDocumentWork()`** so
  a save or `initDocuments()` that resolves afterwards writes nothing;
- **`logout()` clears `fabulous-writing-text`**, and so does a foreign or
  unowned login — the failed-legacy-migration handoff;
- a buffer with no `ownerId` (written by an older build) is cleared on login;
- `restoreSession()` with no token sets `'anonymous'` without calling the API;
- `restoreSession()` with a token the server rejects (401) calls
  `expireSession()` and sets `'anonymous'`;
- `restoreSession()` that fails with a **500 or a network error** keeps the
  token, leaves `authStatus` at `'unknown'` and sets `restoreFailed` — a
  backend hiccup must not log anyone out;
- **a later successful restore clears `restoreFailed`**, so the gate stops
  showing the connection branch;
- `restoreSession()` called twice concurrently issues **one** `/api/auth/me`
  request and both callers resolve (see the dedup requirement in Step 5).

Mock the api client module (`vi.mock('../api/client', ...)`), matching how
`controller.test.ts` does it.

- [ ] **Step 5: Implement the session actions**

Create `frontend/src/auth/session.ts`. It is the only module that writes auth
state; components call these functions rather than `setAuth` directly.

```ts
/** Bumped by every session transition. A completion that started under an
 *  older generation no longer speaks for anyone and must not commit. */
let generation = 0
export const sessionGeneration = (): number => generation

export async function login(email: string, password: string): Promise<boolean> {
  const startedAt = generation
  const previousUserId = useStore.getState().user?.id
  const { token, user } = await postLogin(email, password)
  // Someone logged out while this was in flight — drop the token on the floor
  // rather than signing a deliberately logged-out user back in.
  if (startedAt !== generation) return false
  generation++
  // Purge is for a *user change*, per Decision 1. Re-authenticating as the
  // same person — which Task 8 does silently after a password change — must
  // not wipe their locale, current document and collapse states.
  if (previousUserId !== user.id) resetSessionState()
  discardForeignBuffer(user.id)   // keeps this user's own unsaved work
  useStore.setState({ sessionExpired: false, restoreFailed: false })
  useStore.getState().setAuth(token, user)
  return true
}

/** Deliberate exit. The machine may be handed over, so nothing survives. */
export function logout(): void {
  generation++
  invalidateDocumentWork()   // first: pending saves must not write the buffer back
  cancelInFlightCheck()
  resetSessionState()
  clearSnapshot()
  clearLegacyText()
  useStore.getState().setAuth(null, null)
}

/** The token stopped working. The same user is almost certainly coming back,
 *  so the document buffer is deliberately left alone — it is the only copy of
 *  their unsaved text, and Task 6's notice promises it in seven languages. */
export function expireSession(): void {
  generation++
  invalidateDocumentWork()   // the buffer survives; the work that rewrites it must not
  cancelInFlightCheck()
  resetSessionState()
  useStore.setState({ sessionExpired: true })
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
  } catch (error) {
    // Only an authentication rejection ends the session. A 500 or a dropped
    // connection during startup must NOT discard a perfectly good token —
    // that would turn a backend hiccup into a logout, and the spec scopes
    // auth-clearing to 401 alone.
    if (error instanceof HttpError && error.status === 401) {
      expireSession()
      return
    }
    useStore.setState({ restoreFailed: true })   // authStatus stays 'unknown'
  }
}
```

`restoreFailed` is why `authStatus` has an `'unknown'` state at all. Without
this branch the gate renders nothing forever on a transient failure — a blank
screen with no way forward. `LoginGate` (Task 7) renders a short
"cannot reach the server" message and a retry button that calls
`restoreSession()` again; a successful retry clears the flag.

`cancelInFlightCheck()` aborts a running check's subscription — and only that.
`checkPhase`, `llmStartedAt` and `llmTokens` are part of `INITIAL_DATA`, so
`resetSessionState()` already restores them; a second helper writing the same
three fields is how the two drift apart. The cancellation still has to happen,
because the store survives the gate swap and a check that was running when the
token expired would otherwise leave the Check button disabled after signing
back in. **Do not import `controller.ts` to get `cancelCheck()`** — see the
import-direction note below.

`discardForeignBuffer(userId)` calls `clearSnapshot()` unless the stored
snapshot's `ownerId` equals `userId`, and in that same foreign-or-unowned
branch also calls `clearLegacyText()` — which removes `LEGACY_TEXT_KEY` and is
exported from `documents.ts`, the module that owns the constant. The
legacy-key paragraph below says why that key needs clearing at all.

**`restoreSession()` must be idempotent while in flight.** Hold the in-flight
promise in a module-level variable and return it if a restore is already
running, clearing it when it settles. `<StrictMode>` double-invokes mount
effects, so the gate in Task 7 would otherwise issue two concurrent
`/api/auth/me` requests — but the dedup belongs here, with the function, so
every caller benefits and Task 3's own test can pass.

**Import direction, stated so it does not become a cycle.** Task 4 makes
`client.ts` need to clear auth on a 401, and `session.ts` already imports
`postLogin`/`getMe` from `client.ts`. `client.ts` must therefore **not** import
`session.ts`. Use the injection idiom this codebase already uses for exactly
this problem — `autosave.ts:30-37`'s `setConflictHandler`, commented "Injected
by documents.ts (avoids a module cycle)":

```ts
// client.ts
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn }
```

`session.ts` registers `expireSession` at module load. Apply the same idiom for
`cancelInFlightCheck()` rather than importing `controller.ts`.

`resetSessionState()` runs on **logout**, on **expiry**, and on a login that
**changes the user** — not on every login. It carries login at all because
logout is not guaranteed to have happened: a token can simply expire and the
next person signs in on the same browser, and a previous user's `currentDocId`,
`lastProfileByLanguage` and collapse states must not follow them. But
re-authenticating as the *same* person must leave those alone, which is what
Task 8's silent re-login does after a password change.

**There is a second localStorage key, and it is the one that actually matters.**
`fabulous-writing-doc-buffer` (`documents/buffer.ts`) is a write-through cache
of the *whole current document* — `text`, name, findings, scorecard — written
by `noteChange()` on every keystroke, before any network call. It is not part
of the zustand blob, so `persist.clearStorage()` does not touch it. Leaving it
alone would let one user's unsaved document text be restored into the next
user's session on a shared browser, which is exactly what spec §8 forbids
("any future content-bearing persisted field must not survive into another
user's session").

It cannot simply be purged alongside the settings, though: that same buffer is
what preserves unsaved work across a session expiry, and destroying it would
turn an expired token into data loss. The three paths differ:

| Path | Settings blob | Document buffer |
|---|---|---|
| Explicit **log out** | cleared | **cleared** — deliberate exit, and the machine may be handed over |
| **401 / session expiry** | cleared | **kept** — the same user is almost certainly coming back |
| **Login** | cleared **only on a user change** | cleared **only if it belongs to someone else** |

**And a third content-bearing key, which nothing currently clears.**
`LEGACY_TEXT_KEY = 'fabulous-writing-text'` (`documents.ts:23`) is the
pre-multi-document editor buffer. It is removed after a successful migration
but **deliberately kept when the legacy import cannot reach the backend**
(`documents.ts:193-211`) — so it survives exactly in the situation where nobody
has looked at it, and a later account with no documents would import the
previous user's text.

It carries no owner marker, so it can only be treated as unowned — which is
why `logout()` and `discardForeignBuffer()` above both clear it. Test the
failed-migration handoff: leave the key in place, log out, log in as another
user, and assert the text does not appear.

To make that last row decidable, add **`ownerId?: number`** to `DocSnapshot` —
optional-property syntax, not `ownerId: number | undefined`, which TypeScript
still treats as *required* and would break the existing object literals exactly
as described below. A snapshot written by an older build has no `ownerId`; treat
that as unknown and clear it — failing safe costs one unsaved buffer once,
while failing open leaks text across accounts.

**`ownerId` is the id of the signed-in user, not the document's owner.**
`DocumentFull` already carries an `owner_id` (`client.ts:222`) which M2
hardcodes to `1`. Sourcing the snapshot's field from *that* would clear the
buffer on their own login for every user whose id is not 1, and retain a
stranger's buffer for user 1 — the exact inverse of the intent. The value is
`useStore.getState().user?.id`.

`collectSnapshot()` (`autosave.ts:149-181`) is the only place a `DocSnapshot`
is constructed — every other write spreads an existing one — so that is the
single place to populate the field. When `user` is null, `collectSnapshot()`
returns `null` as it already does for a missing `docMeta`.

Making the field required would break `tsc --noEmit` at roughly seven
object-literal `writeSnapshot({…})` calls across `documents.test.ts` and
`autosave.test.ts`; declaring it optional avoids that churn, and the
clear-if-not-mine rule already treats `undefined` as "not mine".

**Clearing storage is not enough: pending document work can write it back.**
`clearSnapshot()` removes the buffer, but `autosave.ts` keeps a debounce timer,
a retry timer and an `inFlight` promise whose completions call
`writeSnapshot()` (`:146`, `:172`), and `documents.ts` holds `initInFlight`
work that writes or hydrates after `await` points (`:133-160`). A retry or an
in-flight push that lands *after* logout — or after the next user's
`discardForeignBuffer()` — recreates the previous user's document text, and a
stale `initInFlight` promise can be reused by the next mount.

So the session actions must invalidate that work, not merely clear its output.
Add a module-level session generation to the document layer: an exported
`invalidateDocumentWork()` that cancels the debounce and retry timers (there is
already `cancelRetry()`, `autosave.ts:222`) and bumps a counter. Every deferred
write — the autosave push completion, the retry, `initDocuments`' post-`await`
writes — captures the counter when it starts and no-ops if it has changed.

Test the handoff with work genuinely in flight: start a save, log out before it
resolves, and assert nothing is written afterwards; and start
`initDocuments()`, log out mid-flight, log in as another user, and assert the
first user's content never appears.

Add `postLogin` and `getMe` to the api client as ordinary `request()` calls.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/auth src/state`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/state/store.ts src/state/store.test.ts src/auth src/api/client.ts \
        src/checking/controller.ts \
        src/documents/buffer.ts src/documents/autosave.ts \
        src/documents/autosave.test.ts src/documents/documents.ts \
        src/documents/documents.test.ts
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
- Modify: `frontend/src/api/client.ts`, `frontend/src/state/store.ts`,
  `frontend/src/auth/session.ts`
- Test: `frontend/src/api/client.test.ts` (new)

**Interfaces:**
- Produces: every `request()` call carries `Authorization: Bearer <token>` when
  a token exists; a 401 from anything other than the login endpoint clears auth
  state; `HttpError` keeps `status` and `message` and **gains
  `readonly code?: string`**, parsed from an object `detail` in the error body.
  Task 8 depends on that field to tell a wrong current password from a
  password-policy failure — both are 422.
- Produces: `setUnauthorizedHandler(fn)`, exported from this module.

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
- a 401 from a normal endpoint calls `expireSession()` and **does not** clear
  the document buffer (assert `readSnapshot()` still returns the snapshot);
- a 401 from `POST /api/auth/login` does **not** clear auth state and the
  `HttpError` reaches the caller — otherwise a wrong password would trigger a
  state-clearing loop;
- a 401 from `POST /api/auth/password` **does** clear auth state — after
  Task 8 that endpoint's 401 can only mean the bearer token was rejected, so
  it must flow through `expireSession()` like any other endpoint's;
- a **429** does not clear auth state — it is transient (spec §8);
- a 500 does not clear auth state;
- **a delayed 401 carrying a token that is no longer the current one does not
  clear auth state** — start a request, expire the session, log in again, then
  let the first request's 401 land, and assert the *new* token survives.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/api/client.test.ts`
Expected: FAIL — no header is attached and no 401 branch exists.

- [ ] **Step 3: Implement**

**`HttpError` must carry the server's error code, or Task 8's mapping cannot
work.** Today `request()` discards the response body entirely and `HttpError`
exposes only `status` and `message` (`client.ts:20-38`), so every 422 looks
identical to a caller. Task 8 needs to tell `wrong_current_password` from
`password_too_short`. Extend the error path: on a non-OK response, attempt to
parse the JSON body, and if `detail` is an object with a string `code`, put it
on the error as `readonly code?: string`. Wrap the parse — an error body is not
guaranteed to be JSON, and a failure to parse one must not replace the real
status with a parse error.

In `request()`: read the token from the store, build headers explicitly, and
add the 401 branch. Express the exemption as a property of the call, not by
string-matching the path at the point of failure — pass an option through
`request()` that the exempt callers set, so a future endpoint that also must
not clear state opts in explicitly rather than being special-cased by URL.

**Name the option `{ keepSessionOn401: true }`, not `{ anonymous: true }`.**
It has exactly one effect: skip the clear-auth branch when the response is 401.
It must **never** influence header construction — a flag called `anonymous`
invites an implementation that strips the `Authorization` header.

**`postLogin` is its only caller.** An earlier draft exempted
`postPasswordChange` too, which was wrong: `POST /api/auth/password` can return
401 from *either* `get_current_user` (the session is dead) or the
current-password check (`app/api/auth.py:340`), and a status code cannot tell
them apart. Exempting it would leave a genuinely expired session believing it
was still authenticated, showing "current password is not correct" for a token
that no longer works. Task 8 removes the ambiguity at the source instead — see
its Step 3 — so that endpoint's 401 means one thing and flows through
`expireSession()` like any other.

Clearing state on 401 goes through **`session.expireSession()`** — not
`logout()`, which would delete the document buffer and destroy unsaved work.
`client.ts` reaches it through the `setUnauthorizedHandler` injection from
Task 3, not by importing `session.ts`.

**Scope the 401 to the token that produced it.** The app fires several requests
in parallel on mount and the check stream outlives them, so a 401 can arrive
long after the request that earned it. Once the first 401 has shown the gate
and the user has signed back in, a straggler from the dead token would call
`expireSession()` again and throw away the *fresh* token — logging the user
straight back out with no explanation. Capture the token the request was sent
with, and clear only if `useStore.getState().token` is still that same value
when the response arrives. Put the check inside the shared handler both callers
use, so Task 5's stream — which passes the token it opened with — inherits it
rather than growing a second copy.

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
- **a multi-byte character split across a chunk boundary survives intact** —
  encode a payload containing e.g. `„Größe"` or `日本語`, cut the byte array
  mid-character, push the halves as separate chunks, and assert the handler
  receives the original string with no U+FFFD. This is the test that fails
  against a per-chunk `decoder.decode(chunk)`;
- `done` calls `onDone()` **exactly once** and stops reading;
- the unsubscribe function aborts the fetch, and calling it twice does not
  throw;
- a stream that ends without `done` calls `onDone()` (the network-error path),
  and does **not** call it a second time if `done` had already arrived;
- **a 401 response to the stream calls `expireSession()` and `onDone()` exactly
  once** — the case the spec rejected a whole library over;
- a 401 on a stream opened with a token that is **no longer** the current one
  calls `onDone()` but **not** `expireSession()` — same delayed-response guard
  as Task 4, reached through the same shared handler;
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
and feeds each decoded chunk to `parser.feed()`.

**Decode with `{ stream: true }`, and flush at the end.** A `ReadableStream`
splits on byte boundaries, not code points, so a multi-byte character can
straddle two chunks. `decoder.decode(chunk)` called independently per chunk
replaces the split character with U+FFFD *before* the parser ever sees it —
silently corrupting text. This app is not hypothetically multilingual: findings
and error messages carry German, French, Japanese and Chinese content, so the
corruption would be routine rather than exotic.

```ts
const decoder = new TextDecoder()
// ... per chunk:
parser.feed(decoder.decode(chunk, { stream: true }))
// ... after the loop:
parser.feed(decoder.decode())   // flush any trailing partial sequence
```

Four things are yours to get right, and each has a test above:

1. **A non-OK response is not a fetch error.** `fetch` resolves happily for a
   401, so without an explicit check the reader would parse the JSON error body
   as an event stream, emit nothing, reach end-of-stream and call `onDone()` —
   the check stops silently while the app still believes the session is valid.
   That is *precisely* the failure spec §7.3 cites when rejecting
   `eventsource-client`; reproducing it here by omission would be absurd.
   Before reading the body: if `!response.ok`, route the status through the
   same handling `request()` uses in Task 4 (so a 401 reaches
   `expireSession()`), then settle. Build the request headers with Task 4's
   helper rather than assembling a second copy.
2. **Settle exactly once.** `done` calls `onDone()`; so does an ended or failed
   stream, and so does the non-OK path above. Guard with a flag so a `done`
   frame immediately followed by end-of-stream does not fire it twice.
3. **`AbortError` is the normal cancellation path**, not a failure — it must
   not surface as an error, and after an abort `onDone()` should not fire
   (`cancelCheck()` already resets the store itself).
4. **Every other error still ends in `onDone()`.** Today a network error is
   indistinguishable from completion, and this milestone deliberately keeps
   that. Rule 1 is the single exception, added because a 401 must reach the
   session handler — do not read it as a general move toward surfacing stream
   errors.

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
  connectionFailed: string
  connectionRetry: string
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
  sessionExpired:
    'Your session has ended. Please sign in again — unsaved changes have been kept.',
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
  connectionFailed: 'Cannot reach the server.',
  connectionRetry: 'Try again',
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
  sessionExpired:
    'Die Sitzung ist beendet. Bitte erneut anmelden — ungespeicherte Änderungen bleiben erhalten.',
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
  connectionFailed: 'Der Server ist nicht erreichbar.',
  connectionRetry: 'Erneut versuchen',
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
  sessionExpired:
    'Votre session a pris fin. Veuillez vous reconnecter — les modifications non enregistrées ont été conservées.',
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
  connectionFailed: 'Le serveur est injoignable.',
  connectionRetry: 'Réessayer',
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
  sessionExpired:
    'La sesión ha finalizado. Inicie sesión de nuevo: los cambios sin guardar se han conservado.',
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
  connectionFailed: 'No se puede conectar con el servidor.',
  connectionRetry: 'Reintentar',
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
  sessionExpired:
    'La sessione è terminata. Effettua di nuovo l’accesso: le modifiche non salvate sono state conservate.',
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
  connectionFailed: 'Impossibile raggiungere il server.',
  connectionRetry: 'Riprova',
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
  sessionExpired:
    'セッションが終了しました。もう一度ログインしてください。未保存の変更は保持されています。',
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
  connectionFailed: 'サーバーに接続できません。',
  connectionRetry: '再試行',
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
  sessionExpired: '会话已结束，请重新登录。未保存的更改已保留。',
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
  connectionFailed: '无法连接到服务器。',
  connectionRetry: '重试',
```

The parity test fails if any locale is missing a key, which is the check that
this task is complete.

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

- [ ] **Step 1: Add component-testing infrastructure**

Tasks 7 and 8 are the first tests in this repo that mount React. There is no
`@testing-library/*` today, and the sole existing `.test.tsx`
(`DocumentSidebar.test.tsx`) imports no component — it tests pure functions.

**This reverses a deliberate decision.** On 2026-07-12 the owner triaged
"keep no-component-test convention". It is being reversed on purpose, because
M2 adds the first components whose *behaviour* is security-relevant: the gate
deciding not to render the app, and the account menu not logging you out on a
mistyped password. Record the reversal in the LOGBOOK entry (Task 11) so a
future reader sees a decision rather than drift.

Run from `frontend/`:

```bash
npm install -D @testing-library/react @testing-library/user-event
```

`happy-dom` is already a devDependency, and `vite.config.ts` sets no global
`environment` — DOM-needing files opt in per file. **Every new `.tsx` test file
starts with the docblock**, exactly as `documents.test.ts:1` does:

```ts
// @vitest-environment happy-dom
```

Check whether `@testing-library/react` needs an entry in `package.json`'s
`allowScripts` (this repo pins install-script approvals); report what `npm`
said either way.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/auth/LoginGate.test.tsx`:

- while `authStatus` is `'unknown'`, children are **not** rendered and no login
  form is shown;
- when `sessionExpired` is set, the gate shows the session-expired notice above
  the form; after a plain log-out it does not;
- when `restoreFailed` is set, the gate shows the connection message and a
  retry button rather than the login form or a blank screen, and the button
  calls `restoreSession()` again;
- while `'anonymous'`, the login form is shown and children are **not**
  rendered;
- while `'authenticated'`, children are rendered and the form is not;
- submitting valid credentials calls `login()`;
- **under `<StrictMode>`, mounting the gate issues exactly one `/api/auth/me`
  request** — wrap the render in `<StrictMode>` in this test specifically, so
  the double-invocation is exercised rather than assumed away;
- a rejected `login()` renders the invalid-credentials message and leaves the
  form visible.

Assert children are absent via a sentinel child element, so the test pins
"not rendered" rather than "not visible".

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/auth/LoginGate.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Implement**

`LoginGate` calls `restoreSession()` on mount and switches on `authStatus`:
render nothing while `'unknown'`, `<LoginForm/>` while `'anonymous'`,
`children` while `'authenticated'` — plus the `restoreFailed` branch above.

**`main.tsx` keeps `<StrictMode>`, which double-invokes mount effects in
development**, so a plain empty-dependency effect fires `restoreSession()`
twice. Task 3 already made `restoreSession()` idempotent while in flight for
exactly this reason, so the gate needs no guard of its own — the test below
confirms the two layers actually compose.

This codebase has been bitten by StrictMode before and solves it the same way:
`Header()` compares a `prevLanguage` ref rather than consuming a boolean,
precisely so the double invocation stays correct (`App.tsx:97-105`).

`LoginForm` is a controlled email/password form that calls `login()` on submit,
shows the invalid-credentials message for an `HttpError` with status 401 and
the generic failure message otherwise, disables the submit button while in
flight (showing `signInPending`), and uses the i18n keys from Task 6.

**Design — settled, transcribe it rather than deciding.** Reviewed against
rendered alternatives on 2026-07-25; a split-panel/landing-page treatment was
considered and deferred to a later UI polish phase (see the roadmap backlog).

- Full-viewport container, `background: var(--panel)`, contents centred both
  axes. The unauthenticated user must see no editor chrome, document sidebar
  or nav at all (spec §8).
- A single card: `background: var(--bg)`, `1px solid var(--border)`,
  `border-radius: 10px`, `padding: 1.2rem`, `width: 18rem`, column flex with
  `gap: 0.55rem`, `box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08)`.
- The wordmark sits at the top of the card. It is currently inline JSX in
  `Header()` (`App.tsx:123-125`) and not exported, so copying it is how the two
  drift — extract a `<Wordmark/>` component and use it in both places:
  `Fabulous <span className="accent">Writing</span>`, here at `1.25rem` /
  weight 700.
- Two labelled inputs — email (`type="email"`, `autoComplete="username"`) and
  password (`type="password"`, `autoComplete="current-password"`) — labels at
  `0.7rem` in `var(--text-dim)`, inputs 30px tall with the app's standard
  `1px solid var(--border)` / `6px` radius.
- Submit button spans the card width: `background: var(--accent)`, white text,
  weight 600, 30px tall, no border.
- The error message renders **above** the submit button and reuses the app's
  existing boxed-error idiom rather than a new colour — `color: #e5484d`,
  `border: 1px solid #e5484d55`, `border-radius: 6px`, matching `.llm-error`.
  Do not introduce an error token; the codebase uses this literal throughout.
- The `sessionExpired` notice, when set, renders in the same position and
  styling as the error.

In `main.tsx`, wrap: `<StrictMode><LoginGate><App /></LoginGate></StrictMode>`.

Check whether `App.tsx`'s mount effects need any further guard once the gate is
in place. If the gate genuinely never renders `App` unauthenticated they do
not, and adding a second guard would be redundant — verify rather than assume,
and say which you found in your report.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/auth src/main.tsx src/App.tsx src/App.css
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
- Consumes: `user` from the store, `logout()` and `login()` from Task 3.
- Modifies: `backend/app/api/auth.py` — `change_password`'s failure codes, see
  below. This is the one backend change in this task.
- Produces: `postPasswordChange(current: string, next: string): Promise<void>`
  on the api client — `POST /api/auth/password` with body **`{ current, new: next }`**
  (the server's field is literally `new`, `app/api/auth.py:269-272`), 204 →
  `undefined`. It does **not** set `keepSessionOn401`: after the change below,
  a 401 from this endpoint genuinely means the session is dead.
- Produces: `MIN_PASSWORD_LENGTH = 8` alongside it. The server's
  `SELF_MIN_PASSWORD_LENGTH` is 8 (`core/auth.py:59`) and no endpoint exposes
  it, so the client hardcodes it.

**Backend change: make the endpoint's failures distinguishable.** Today
`change_password` raises `401 "Current password is incorrect"`
(`app/api/auth.py:340`) — the same status `get_current_user` raises for a dead
session — and a `422` whose message covers both "too short" and bcrypt's
72-byte ceiling (`validate_password` enforces both). A client cannot act
correctly on either. Two failures that need different responses must not share
a status with no discriminator.

Change it so the endpoint returns:

| Condition | Status | `detail` |
|---|---|---|
| bearer token rejected | **401** | unchanged, raised by `get_current_user` |
| current password wrong | **422** | `{"code": "wrong_current_password"}` |
| new password too short | **422** | `{"code": "password_too_short"}` |
| new password over 72 bytes | **422** | `{"code": "password_too_long"}` |

Wrong-current-password is a validation failure of the submitted body, not a
failure to authenticate the request — the bearer token authenticated fine — so
422 is the honest code and matches spec §7.2's "422 validation".

Update the M1 tests in `tests/test_auth_api.py` that assert the old 401 and the
old string detail; the frontend never displays server messages, so the `code`
is purely for branching.

**Add an API test for each of the three codes**, including
`password_too_long` — send a password over 72 UTF-8 bytes (a multibyte string
makes the byte-vs-character distinction real) and assert
`detail["code"] == "password_too_long"`. Without it the newest discriminator is
the one nothing verifies: the frontend's "unrecognised code" branch cannot tell
you what the server actually emits, so the code could be renamed or dropped
with both suites green.

The client maps `wrong_current_password` → `passwordCurrentWrong`,
`password_too_short` → `passwordTooShort(8)`, `password_too_long` → the
generic `passwordFailed`, and any unrecognised code → `passwordFailed`.
**Do not map bare status 422 to "too short"** — that is actively misleading for
a multibyte password that tripped the byte ceiling.

**When the silent re-login fails, run the expiry path — do not just show an
error.** `postLogin` deliberately bypasses central 401 handling (Task 4), so
nothing else will correct the state: the password change has already revoked
the current token, and leaving the store `authenticated` means every
subsequent request 401s while the UI insists the user is signed in. On a failed
re-authentication, call `expireSession()` so the gate takes over with the
session-expired notice — the password *was* changed, and signing in again with
the new one is the honest next step.

Without this, `POST /api/auth/password` and logging out have no entry point in
the UI at all.

- [ ] **Step 1: Write the failing test**

Cover:

- the signed-in email is shown, and the menu offers change-password and log-out;
- log-out calls `logout()`;
- the change request carries the `Authorization` header;
- a 422 `wrong_current_password` shows `passwordCurrentWrong` and does **not**
  log the user out;
- a 422 `password_too_short` shows `passwordTooShort`, and the form
  pre-validates against `MIN_PASSWORD_LENGTH` so the common case never reaches
  the server;
- a 422 with an unrecognised code shows the generic `passwordFailed`;
- **a 401 from this endpoint ends the session** — it can now only mean the
  bearer token was rejected;
- mismatched new/confirm shows `passwordMismatch` and sends no request;
- **a successful change leaves the user signed in** — see below;
- **when the silent re-login itself fails, `expireSession()` runs** and the
  store does not stay `authenticated` holding a token the change just revoked;
- reopening the menu after each dismissal path shows the menu, not the
  password form.

The 401 case is the one worth writing first; it is the non-obvious interaction
between this task and Task 4.

**A successful password change would otherwise sign the user out.** Task 2
makes `get_current_user` reject any token issued before `password_changed_at`,
and `POST /api/auth/password` returns 204 without issuing a new one — so the
caller's own token is stale the moment it succeeds, and the very next request
hits Task 4's 401 branch. The user would see "Password changed." followed
immediately by "Your session has ended."

Resolution (owner's decision, 2026-07-25): **the client re-authenticates
silently.** On 204, call `login(currentUserEmail, newPassword)` before showing
`passwordChanged`. The form already holds the new password, no backend or spec
change is needed, and sessions on *other* devices still get evicted — which is
the entire point of the revocation. The failure path is above: `expireSession()`,
not an error message.

**Guard the completion against a session that changed underneath it — at both
await points.** The popover stays dismissible while the request is in flight,
so a user can dismiss it, reopen the menu and log out; the original handler
still receives its 204 and calls `login()`, signing a deliberately logged-out
user back in. Checking only after the password request resolves is not enough,
because `login()` commits auth *after* its own await — a logout during the
silent re-login window slips through the same hole one step later.

Use Task 3's session generation, not the user id: logging out and back in as
the same person must also abandon the completion, and an id comparison cannot
see that. Read `sessionGeneration()` before sending, compare it after the 204,
and rely on `login()`'s own guard for the second window — it returns `false`
when the session moved while `postLogin` was in flight, having discarded the
token rather than committing it. Show `passwordChanged` only when it returns
`true`; otherwise abandon the completion silently — no re-login, no success
message, no error, because the session it belonged to is gone.

Test both windows: log out while the password request is pending, and log out
while the silent `login()` is pending.

- [ ] **Step 2: Run it and watch it fail**
- [ ] **Step 3: Implement**

**Design — settled, transcribe it rather than deciding.** Reviewed against
rendered alternatives on 2026-07-25. A full email-address trigger was rejected
because it squeezes the Domain selector out of an already-tight header. A modal
for the password form was deferred to a later UI polish phase (roadmap B3):
a scrim already exists — `FolderDefaultsDialog` renders `.dialog-overlay`
(`App.css:1719`) with backdrop-click dismissal — but focus trap, Escape and
scroll lock do not, and three short fields did not justify building them here.

**Trigger** — last element inside `.header-controls`, after the Check button:

- a circular badge, `height`/`width` = `var(--control-h)` (26px),
  `border-radius: 999px`;
- `background: var(--accent-soft)`, `color: var(--accent)`,
  `1px solid var(--accent)`, `font-size: 0.72rem`, weight 700;
- content is the **uppercase first character of the email**;
- it needs an accessible name — use the `accountMenu` key, since the visible
  content is a single letter.

**Menu** — the existing popover recipe, copied from `.doc-menu` so it inherits
the app's look and behaviour rather than starting a second idiom:
`position: absolute; right: 0; top: calc(100% + 6px); z-index: 20;`
`min-width: 11rem; background: var(--bg); border: 1px solid var(--border);`
`border-radius: 8px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.15);` column flex.
Its anchor gets `position: relative`.

- First row: the **full** email address, non-interactive, `0.75rem`,
  `var(--text-dim)`, separated by `1px solid var(--border)`. This is what pays
  for the badge hiding the identity.
- Then two buttons — `accountChangePassword`, `accountLogOut` — left-aligned,
  `padding: 0.4rem 0.7rem`, borderless, `background: var(--accent-soft)` on
  hover, exactly as `.doc-menu button` does.

**Password form** — replaces the menu's contents *in the same popover*, which
widens to about `15rem`. Three labelled password inputs (`passwordCurrent`,
`passwordNew`, `passwordConfirm`; `autoComplete="current-password"` and
`autoComplete="new-password"` — **camelCase**, since React's typed DOM prop is
`autoComplete` and the lowercase spelling fails `tsc --noEmit`), then a
right-aligned action row: a quiet Cancel button
(`1px solid var(--border)`, `var(--bg)`) and the accent-filled submit. Result
messages use the same boxed idiom as the login gate — `#e5484d` with
`1px solid #e5484d55` for failures, `var(--text-dim)` for `passwordChanged`.

**Dismissal — use what exists.** `useDismissOnOutsideClick(ref, open, onDismiss)`
(`frontend/src/hooks/useDismissOnOutsideClick.ts`) handles mousedown-outside and
is what `DocumentSidebar` already uses. Use it. It does **not** handle Escape;
adding Escape is in scope for this task, since a password form the keyboard
cannot dismiss is worse than one that closes on a stray click.

**Every dismissal path must reset the popover to its menu view** — outside
click, Escape, choosing an item, and logging out. `DocumentSidebar` gets this
right today (`closeMenu` resets `moving`, `:322-325`); follow that shape rather
than tracking the sub-view in a way each path has to remember to clear. A test
per dismissal path is listed above.

**Where the CSS goes:** append to `frontend/src/App.css` with the other
component styles — this repo keeps one stylesheet, and a new `auth.css` would
be the only exception. Class prefixes: `.account-badge`, `.account-menu`,
`.account-who`, `.account-password-panel`; the gate uses `.login-gate`,
`.login-card`, `.login-form`, `.login-error`.

Mount it in `Header()` as the final child of `.header-controls`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth src/App.tsx src/App.css src/api/client.ts \
        ../backend/app/api/auth.py ../backend/tests/test_auth_api.py
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
- Produces **two** helpers, because a single whole-client fixture does not fit
  most of the files Task 10 must convert:
  - `authed_client(tmp_path)` — builds the app with plain `tmp_path` settings
    and returns a `TestClient` with the header pre-attached. Fits
    `test_documents_api.py`, `test_folders_api.py`, `test_languages_api.py`.
  - `auth_headers(client) -> dict[str, str]` — POSTs to `/api/auth/login` with
    `conftest.TEST_ADMIN_EMAIL` / `TEST_ADMIN_PASSWORD` and returns the Bearer
    header, for the seven files that must build their own app. This is the
    idiom `test_admin_api.py:24-29` already uses; obtaining the token through a
    real login rather than calling `issue_token` directly keeps the tests
    honest about the path a client actually takes.

  The seven that need `auth_headers` rather than the fixture, because they pass
  their own settings: `test_check_api.py` (five apps — `rules_dir`,
  `seed_terminology=False`, a recording provider, custom `NlpSettings`),
  `test_routing_api.py` and `test_providers_api.py` (monkeypatched env plus
  `ProviderSettings`), `test_rules_api.py` (real rules dir),
  `test_profiles_api.py`, `test_terminology_api.py`, `test_suggestions_api.py`.

  Do **not** add a second-user fixture: no M2 test needs two identities, and an
  unused fixture is churn that M3 can add when ownership makes it real.

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

- [ ] **Step 2: Prove both helpers work, on one file each**

Convert `backend/tests/test_languages_api.py` to `authed_client`, and
`backend/tests/test_routing_api.py` to `auth_headers` — one of each, ahead of
enforcement, so the harder shape is proven before Task 10 depends on it.
Converting only a simple file would hide the mismatch until nine files were in
flight. Both must still pass, since an ignored `Authorization` header changes
nothing while the routers are open.

Run: `uv run pytest tests/test_languages_api.py tests/test_routing_api.py -q`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/conftest.py tests/test_languages_api.py tests/test_routing_api.py
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

This file needs its own **unauthenticated** client — Task 9's `authed_client`
is the wrong tool, and there is no shared `client` fixture in `conftest.py`
(the ones by that name in other modules are module-local, so borrowing the name
gives "fixture 'client' not found"). Define one here, with `tmp_path` settings
so it never reaches the live database:

```python
@pytest.fixture()
def anon_client(tmp_path):
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    return TestClient(create_app(settings))
```

Use it for both the route walk and the preflight test below.

For each remaining route, issue an unauthenticated request and assert **401**.
Substitute `1` for every `{param}` segment (routes use `{check_id}`, `{document_id}`, `{domain_id}`, `{term_id}`, `{profile_id}`, `{folder_id}` — there is no `{id}`); a 404 or 422 from a
nonexistent id would mean the request got past auth, so assert specifically on
401 rather than "not 200".

This test is the real deliverable of the task: it fails the moment someone adds
an unauthenticated route.

Add the preflight test spec §7.4 requires, which Task 1's could not provide —
it used `/api/health`, which stays public and therefore can never regress:

```python
def test_preflight_to_an_authenticated_route_is_not_401(anon_client):
    response = anon_client.options(
        "/api/documents",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            # The header the Bearer client actually triggers a preflight for.
            # Without it this test passes even if allow_headers stops permitting
            # Authorization — while every authenticated browser request fails.
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "authorization" in response.headers["access-control-allow-headers"].lower()
```

`CORSMiddleware` wraps the app ahead of routing, so it answers preflight before
any auth dependency runs. This test is what proves that ordering did not
silently change.

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

Bring up a scratch stack. The owner runs their own servers on **8000** and
**5173**; never touch those, record the PIDs you start, and kill only those.

The repo already documents a working recipe in
`frontend/scripts/capture-screenshots.mjs:20-25` — follow it: backend on
**8001**, frontend via `vite preview --port 4199`, and
`VITE_API_URL=http://127.0.0.1:8001` so the client talks to the scratch
backend rather than the owner's.

**Task 1 makes this stricter than it used to be.** With `cors.origins`
defaulting to `["http://localhost:5173"]`, a frontend on 4199 has its
preflights refused and every call fails for a reason that looks nothing like
CORS from the UI. Point the scratch backend at a scratch **`config.yaml`**
whose `cors.origins` lists the frontend origin you actually use.

It must be a YAML file: `load_settings()` reads YAML only
(`app/core/config.py:195-221`) and Task 1 adds no environment overlay for
CORS, so there is no `FW_CORS_*` variable to reach for.

Start it against a **scratch** database (never `backend/data/fabulous.db`) with
`FW_AUTH_SECRET`, `FW_ADMIN_EMAIL` and `FW_ADMIN_PASSWORD` set.

Confirm, and report what you observed rather than that it "worked":

1. loading the app unauthenticated shows the login gate and **no** editor
   chrome. With no stored token the network panel shows **zero** `/api/*`
   calls (`restoreSession()` returns without calling the API); with a stale
   token it shows exactly one, `/api/auth/me`;
2. a wrong password shows the inline error and does not clear the form into a
   loop;
3. a correct password loads the editor and documents;
4. a check runs to completion — this exercises the new SSE reader end to end,
   which no unit test does;
5. cancelling a check mid-run stops it and leaves the UI in idle;
6. changing the password via the account menu succeeds **and leaves you signed
   in** (Task 8 re-authenticates silently), while the old password no longer
   works on a fresh sign-in;
7. logging out returns to the gate and clears the persisted blob.

- [ ] **Step 4: Fix the screenshot script, which this milestone breaks**

`frontend/scripts/capture-screenshots.mjs` is a real repo entry point
(`npm run screenshots`, and the README's images come from it). Its `api()`
helper sends no `Authorization` header (`:65-74`), and it drives the UI with
`page.goto` (`:179`) — so after Task 10 every staging call 401s, and after
Task 7 the browser lands on the login gate instead of the editor.

Log it in: `POST /api/auth/login` with the scratch stack's `FW_ADMIN_*`, and
drive the login form before the first screenshot.

**Attaching the header in `api()` is not enough** — the script has other direct
`fetch` calls that bypass it: `makeFolder()` (`:90-95`) and the requests that
temporarily switch and then restore the EN Standard profile (`:76-88`). After
Task 10 the folder staging 401s outright, and a restore that runs without auth
leaves the seeded Standard profile modified — a scratch stack's leftovers, but
confusing ones. Route every request through one authenticated helper rather
than patching `api()` alone.

Verify by running it against the scratch stack and looking at the output.

- [ ] **Step 5: Update the architecture docs**

Record in `docs/backend-architecture.md`: CORS is config-driven; every feature
router carries a router-level auth dependency; `password_changed_at` and how it
revokes sessions.

Also update two documents this milestone invalidates:

- **The roadmap's Cross-milestone interfaces block** fixes
  `TokenVerifier.verify(token: str) -> int` so later milestones can rely on it
  without reading this plan. Task 2 changes that return type to
  `VerifiedToken`; update the roadmap or the guarantee is stale for M3–M6.
- **Spec §5.1's `users` table** does not list `password_changed_at`. Add it,
  with a line on why it exists.
- **Spec §4.1** carries the verifier contract in two places — the numbered
  request-authentication flow (`user_id = TokenVerifier.verify(token)`) and the
  protocol itself (`def verify(self, token: str) -> int: ...`), plus the
  sentence "**`verify` returns the local `users.id`** in every mode". Task 2
  changes that return type to `VerifiedToken`. Update all three, keeping the
  local-id guarantee explicit — it is still true, and it is the guarantee the
  future Supabase implementation is written against. Leaving the spec
  contradicting the code would mislead exactly the reader it exists for.

Record in `docs/frontend-architecture.md`: the auth slice, the gate, where the
Bearer header is attached, the fetch-based SSE reader and why `EventSource` was
replaced, and the purge-on-user-change rule.

State explicitly that data is **not** owner-scoped yet and that M3 does it.

- [ ] **Step 6: Update the README**

The Quick start's environment variables are unchanged, but the app now requires
a login. Say so, and that the bootstrap admin credentials are what to sign in
with the first time.

- [ ] **Step 7: Append the LOGBOOK entry**

Run `date '+%Y-%m-%d'` first and use exactly that. Record what M2 delivered,
the commit range, the before/after test counts for both suites, and that
ownership scoping is still M3.

- [ ] **Step 8: Commit, push, open the PR**

```bash
git add docs README.md frontend/scripts/capture-screenshots.mjs
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
