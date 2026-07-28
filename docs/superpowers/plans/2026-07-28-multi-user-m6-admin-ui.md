# M6 — Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin view as a fifth `activeView` — user table with list, create, edit tier/role/active, and password reset — over the existing M1 admin API, per spec §8 (`docs/superpowers/specs/2026-07-24-multi-user-auth-design.md`) and roadmap milestone M6.

**Architecture:** Frontend milestone following the existing view pattern exactly: `ActiveView` gains `'admin'`, the nav button renders only for `is_admin` users, the view is conditionally mounted like `rules`/`terminology`/`profiles` so a non-admin session never issues an `/api/admin/*` request. One small backend addition: `GET /api/admin/tiers` exposes the config-defined tier names the create/edit selects need (they exist nowhere else client-side).

**Tech Stack:** React 19 + TypeScript + zustand + vitest (frontend), FastAPI (one endpoint).

## Global Constraints

- Backend commands from `backend/` via `uv run …`; frontend commands from `frontend/`.
- The live database `backend/data/fabulous.db` is never read or written by tests; every backend test app uses `tmp_path`-based `Settings`.
- Never kill, restart, or start anything on ports 5173/8000. Never force-push, amend, or rebase published history.
- Gates before every commit: backend `uv run pytest -q` (parallel, ~29 s) with **zero warnings**; frontend `npx vitest run && npm run lint && npm run build`. rtk garbles `npm run lint` output — `npx oxlint` directly is authoritative. Bare `tsc --noEmit` checks zero files; `npm run build` (which runs `tsc -b`) is the type gate.
- Test-count expectations: backend 1,082 baseline + exactly the new tests this plan adds; frontend 480 baseline + exactly the new tests this plan adds. Any other delta is a lost test.
- Admin API security invariants must hold: `require_admin` stays attached to the **router** (never per-endpoint), no response ever carries password material, `auth.allow_additional_admins` and `limits.admin` stay config-only (no endpoint accepts them as input).
- XSS rules (spec §8, binding): no `dangerouslySetInnerHTML` anywhere, no dynamic `href`/`src` from user content.
- UI copy: impersonal register (current house style), i18n ×7 (`en de es fr it ja zh`) — every new key lands in `messages.ts` plus all seven catalogs in the same commit.
- Every commit message ends with exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`

## Design decisions (locked)

1. **`GET /api/admin/tiers` is the one backend addition.** The admin UI needs the assignable tier names; they are config-defined (`settings.tiers` keys, spec §6.1) and exposed nowhere client-reachable. An admin-router endpoint inherits `require_admin` by construction and is fetched only while the admin view is mounted — consistent with the no-403-noise rule. Recorded as a deviation from the roadmap's "frontend-only addition" line.
2. **Conditional mount, not `hidden`.** Spec §8 says "workspace hidden rather than unmounted", but as built only the editor workspace is hidden (its CodeMirror state must survive); `rules`/`terminology`/`profiles` are conditionally mounted (`App.tsx:78-80`). The admin view follows its true siblings — which also makes "queries run only when the view is active" structural: the mount effect *is* the fetch trigger.
3. **Render guard is `is_admin && activeView === 'admin'`.** Belt-and-braces: if an admin is demoted mid-session (a `refreshUser()` landing new `/me` data), the view unmounts instead of continuing to render with dead queries. `activeView` itself resets to `'editor'` on session turnover via `INITIAL_DATA` (store.ts) — no cross-user leak, no new code needed.
4. **UI mirrors the server guards it cannot replace.** Self-row `is_admin`/`is_active` controls disabled (server 409), admin-grant controls disabled while `allow_additional_admins` is false (server 403) with a hint, `ADMIN_MIN_PASSWORD_LENGTH = 12` pre-validated client-side (server 422) — mirroring the existing `MIN_PASSWORD_LENGTH = 8` pattern in `client.ts`. Demotion (`true → false`) stays enabled for non-self rows per spec §7.1.
5. **Errors follow the `useCrudError` house pattern** (generic formatted message from the thrown `HttpError`), exactly like `ProfilesView`.
6. **Generation guard is `sessionGeneration()`** (`auth/session.ts`), not `ProfilesView`'s `currentGeneration()` from `documents/autosave` — the admin view has no autosave coupling, and `App.tsx`'s domains fetch (App.tsx:113-117) is the precedent for pure session-turnover guarding. Deliberate, not drift.

---

### Task 1: Backend — `GET /api/admin/tiers`

**Files:**
- Modify: `backend/app/api/admin.py`
- Test: `backend/tests/test_admin_api.py`

**Interfaces:**
- Consumes: `request.app.state.settings.tiers: dict[str, TierSettings]` (existing).
- Produces: `GET /api/admin/tiers` → `200 list[str]` (admin-only; 403 via router dependency for non-admins). Task 2's `getAdminTiers()` calls it.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_admin_api.py`, following the module's existing app-construction and auth-header helpers (read the module first and reuse its fixtures/helpers verbatim — it already builds tmp_path apps and admin/non-admin headers for the other admin endpoints):

The module has its own `build()`/`client` fixture and `admin_headers` helper (top of `test_admin_api.py`) — use those for the admin side, exactly as the module's other tests do. For the non-admin side add one import: `from tests.conftest import second_user_headers`. For a tiers-configured app, mirror the construction in the existing `test_configured_names_replace_defaults` (same module, ~line 320) — it builds settings with a custom `tiers` block and is the model to copy. The three tests (adapt the fixture/helper spelling to the module's own once read):

```python
class TestListTiers:
    def test_returns_config_tier_names(self, tmp_path):
        # settings/client construction copied from test_configured_names_replace_defaults
        response = client.get("/api/admin/tiers", headers=admin)
        assert response.status_code == 200
        assert response.json() == list(settings.tiers)

    def test_defaults_when_no_tiers_configured(self, client, admin_headers):
        assert client.get("/api/admin/tiers", headers=admin_headers).json() == ["basic", "premium"]

    def test_non_admin_is_403(self, client):
        second = second_user_headers(client)
        assert client.get("/api/admin/tiers", headers=second).status_code == 403
```

(The bodies are the contract; the fixture spellings must match what the module actually defines — read it first.)

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_admin_api.py -q -k "ListTiers"`
Expected: 3 FAIL with 404 (route does not exist yet; the 403 test fails because FastAPI returns 404/405 before the dependency would run — any failure is fine as long as it fails).

- [ ] **Step 3: Implement**

In `backend/app/api/admin.py`, extract the known-tiers expression into a helper and add the endpoint:

```python
def _known_tiers(request: Request) -> tuple[str, ...]:
    """Tier names are config-defined (spec §6.1). With no tiers block the
    spec's two default names (§5.1) remain assignable — policy is
    unrestricted for everyone in that state anyway."""
    return tuple(request.app.state.settings.tiers) or ("basic", "premium")
```

Change `_validate_tier_name` to use it (moving its docstring up into `_known_tiers`, keeping the 422 message identical):

```python
def _validate_tier_name(request: Request, tier: str) -> None:
    known = _known_tiers(request)
    if tier not in known:
        raise HTTPException(422, f"unknown tier '{tier}': must be one of {list(known)}")
```

Add after `list_users`:

```python
@router.get("/tiers")
def list_tiers(request: Request) -> list[str]:
    """The tier names assignable through create/patch — the admin UI's
    select options. Names only; tier limits/policy stay config-internal."""
    return list(_known_tiers(request))
```

- [ ] **Step 4: Run the module, then the full suite**

Run: `uv run pytest tests/test_admin_api.py -q` then `uv run pytest -q`
Expected: module green; full suite 1,085 passed (1,082 + 3), zero warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/admin.py backend/tests/test_admin_api.py
git commit -m "feat(admin): expose assignable tier names at GET /api/admin/tiers (M6)"
```

---

### Task 2: API client — admin types and functions

**Files:**
- Modify: `frontend/src/api/client.ts`
- Test: `frontend/src/api/client.test.ts`

**Interfaces:**
- Consumes: existing `request<T>(path, init)` helper and `HttpError`.
- Produces (used by Tasks 4–5):
  - `interface AdminUser { id: number; email: string; display_name: string | null; tier: string; is_admin: boolean; is_active: boolean; created_at: string; external_id: string | null; password_changed_at: string | null }`
  - `interface AdminUserCreate { email: string; password: string; display_name?: string; tier: string; is_admin: boolean }`
  - `interface AdminUserPatch { display_name?: string | null; tier?: string; is_admin?: boolean; is_active?: boolean; password?: string }`
  - `getAdminUsers(): Promise<AdminUser[]>`, `getAdminTiers(): Promise<string[]>`, `postAdminUser(body: AdminUserCreate): Promise<AdminUser>`, `patchAdminUser(id: number, patch: AdminUserPatch): Promise<AdminUser>`
  - `ADMIN_MIN_PASSWORD_LENGTH = 12`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/api/client.test.ts`. The file's reusable idioms are its `jsonResponse()` helper and `vi.spyOn(globalThis, 'fetch').mockResolvedValue(...)` with assertions on `fetchMock.mock.calls[0]` — see the `request()` headers describe block. It imports `{ beforeEach, describe, expect, it, vi }` (no `test` in scope). Four tests:

```typescript
describe('admin endpoints', () => {
  it('getAdminUsers GETs /api/admin/users with the bearer header', async () => {
    // fetch mock via jsonResponse([]), token in the store, then:
    await getAdminUsers()
    // assert fetchMock.mock.calls[0]: path ends '/api/admin/users', no
    // method override (GET), headers carry Authorization: Bearer <token>.
  })

  it('postAdminUser POSTs the create payload', async () => {
    await postAdminUser({ email: 'a@b.c', password: 'p'.repeat(12), tier: 'basic', is_admin: false })
    // assert method 'POST' and JSON.parse(body) deep-equals the payload
  })

  it('patchAdminUser PATCHes the given fields only', async () => {
    await patchAdminUser(7, { tier: 'premium' })
    // assert path ends '/api/admin/users/7', method 'PATCH', body '{"tier":"premium"}'
  })

  it('admin password floor mirrors the backend', () => {
    expect(ADMIN_MIN_PASSWORD_LENGTH).toBe(12)
  })
})
```

Flesh the comments into real assertions with those idioms — concrete paths/methods/bodies/headers, not merely "was called".

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/api/client.test.ts`
Expected: FAIL — the four names are not exported.

- [ ] **Step 3: Implement**

In `frontend/src/api/client.ts`, after the auth section (near `postPasswordChange`):

```typescript
/** Mirrors backend/app/services/users.py User — no password material, ever
 * (token_epoch is excluded server-side). */
export interface AdminUser {
  id: number
  email: string
  display_name: string | null
  tier: string
  is_admin: boolean
  is_active: boolean
  created_at: string
  external_id: string | null
  password_changed_at: string | null
}

export interface AdminUserCreate {
  email: string
  password: string
  display_name?: string
  tier: string
  is_admin: boolean
}

/** PATCH semantics (backend/app/api/admin.py UserPatch): only submitted
 * fields change; display_name: null explicitly clears the name; password
 * present = reset. Callers send exactly the fields they mean. */
export interface AdminUserPatch {
  display_name?: string | null
  tier?: string
  is_admin?: boolean
  is_active?: boolean
  password?: string
}

// The server's ADMIN_SET_MIN_PASSWORD_LENGTH (backend/app/core/auth.py) is
// 12 and no endpoint exposes it — hardcoded here like MIN_PASSWORD_LENGTH
// above, so admin forms pre-validate before sending.
export const ADMIN_MIN_PASSWORD_LENGTH = 12

export const getAdminUsers = () => request<AdminUser[]>('/api/admin/users')

export const getAdminTiers = () => request<string[]>('/api/admin/tiers')

export const postAdminUser = (body: AdminUserCreate) =>
  request<AdminUser>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const patchAdminUser = (id: number, patch: AdminUserPatch) =>
  request<AdminUser>(`/api/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
```

- [ ] **Step 4: Run the frontend gates**

Run: `npx vitest run && npm run build` (and `npx oxlint` directly)
Expected: all green, 480 + 4 = 484 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "feat(admin-ui): typed admin API client (M6)"
```

---

### Task 3: Fifth view — store, nav gating, and the no-fetch guarantee

**Files:**
- Modify: `frontend/src/state/store.ts` (the `ActiveView` type only)
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/admin/AdminView.tsx` (placeholder shell this task; Task 4 fills it)
- Modify: `frontend/src/i18n/messages.ts` + all seven catalogs (`en de es fr it ja zh`): key `viewAdmin`
- Test: create `frontend/src/App.admin-gate.test.tsx`; extend `frontend/src/state/store.test.ts`

**Interfaces:**
- Consumes: `useStore` (`activeView`, `setActiveView`, `user`), `useMessages`.
- Produces: `ActiveView = 'editor' | 'rules' | 'terminology' | 'profiles' | 'admin'`; `<AdminView />` mounted only when `activeView === 'admin' && user?.is_admin`; nav button `m.viewAdmin` rendered only when `user?.is_admin`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/App.admin-gate.test.tsx` — its own file, precedent `App.domains-guard.test.tsx`. Note that NO existing test renders the default `<App />` export (existing files render `Header` only): rendering `App` fires `initDocuments()`, CodeMirror, and the sidebars, so this file must mock `./documents/documents`, `./editor/Editor`, `./documents/DocumentSidebar`, and `./sidebar/Sidebar` (trivial stubs), and mock `./api/client` with the `importOriginal`-spread form (see `App.test.tsx` top) extended with `getAdminUsers`/`getAdminTiers` mocks. Two tests:

```typescript
it('admin nav button renders only for admins', () => {
  // render <App /> with a non-admin user via setAuth: no button labeled 'Admin';
  // re-render with is_admin: true: the button appears
})

it('non-admin session issues no /api/admin request even if activeView is forced to admin', () => {
  // seed a non-admin user, setActiveView('admin'), render <App />;
  // assert mocked getAdminUsers/getAdminTiers were never called and no
  // admin view content is in the document (the is_admin render guard).
})
```

In `frontend/src/state/store.test.ts` — this is a **regression pin**, not new runtime behavior (`resetSessionState` already resets every `INITIAL_DATA` field; vitest strips types without checking, so it can go green against today's store):

```typescript
it('activeView accepts admin and resets to editor on session reset', () => {
  useStore.getState().setActiveView('admin')
  expect(useStore.getState().activeView).toBe('admin')
  resetSessionState()
  expect(useStore.getState().activeView).toBe('editor')
})
```

- [ ] **Step 2: Run to verify the RED phase honestly**

Run: `npx vitest run src/App.admin-gate.test.tsx` — the two App tests FAIL (no admin button, no AdminView). The store test is type-gated instead: before implementing, run `npm run build` and confirm it FAILS on `setActiveView('admin')` (not assignable to `ActiveView`) — that build failure is this test's RED. After Step 3, mutation-verify the pin once: temporarily remove `'admin'` from the `ActiveView` union again and confirm `npm run build` fails while the vitest run of the store file still passes — which is exactly why the union change is guarded by the build, and the reset behavior by the test.

- [ ] **Step 3: Implement**

`frontend/src/state/store.ts`:

```typescript
export type ActiveView = 'editor' | 'rules' | 'terminology' | 'profiles' | 'admin'
```

`frontend/src/admin/AdminView.tsx` (shell; Task 4 replaces the body):

```tsx
import { useMessages } from '../i18n'

export function AdminView() {
  const m = useMessages()
  return (
    <div className="admin-view">
      <h2>{m.adminUsersTitle}</h2>
    </div>
  )
}
```

(`adminUsersTitle` is added in this task's i18n step below so the shell compiles; Task 4 adds the remaining keys.)

`frontend/src/App.tsx` — import `AdminView`, read the user in `App`, and:

```tsx
const isAdmin = useStore((s) => s.user?.is_admin ?? false)
```

after the profiles line (App.tsx:80):

```tsx
{activeView === 'admin' && isAdmin && <AdminView />}
```

and in `Header`'s `view-switch` nav after the profiles button, following the sibling buttons exactly:

```tsx
{(store.user?.is_admin ?? false) && (
  <button
    className={store.activeView === 'admin' ? 'active' : ''}
    onClick={() => store.setActiveView('admin')}
  >
    {m.viewAdmin}
  </button>
)}
```

`frontend/src/i18n/messages.ts` — add to the type, next to the other `view*` keys:

```typescript
viewAdmin: string
adminUsersTitle: string
```

Catalog values (place next to `viewProfiles` / the other `view*` entries in each file):

| locale | `viewAdmin` | `adminUsersTitle` |
|---|---|---|
| en | `'Admin'` | `'User management'` |
| de | `'Admin'` | `'Benutzerverwaltung'` |
| es | `'Admin'` | `'Gestión de usuarios'` |
| fr | `'Admin'` | `'Gestion des utilisateurs'` |
| it | `'Admin'` | `'Gestione utenti'` |
| ja | `'管理'` | `'ユーザー管理'` |
| zh | `'管理'` | `'用户管理'` |

- [ ] **Step 4: Run the gates**

Run: `npx vitest run && npm run build` (plus `npx oxlint`)
Expected: green, 484 + 3 = 487 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/store.ts frontend/src/App.tsx frontend/src/admin/AdminView.tsx frontend/src/i18n/ frontend/src/App.admin-gate.test.tsx frontend/src/state/store.test.ts
git commit -m "feat(admin-ui): admin as fifth activeView, gated on is_admin (M6)"
```

---

### Task 4: Admin view — user table and create form

**Files:**
- Modify: `frontend/src/admin/AdminView.tsx` (replace the Task 3 shell)
- Modify: `frontend/src/i18n/messages.ts` + all seven catalogs
- Modify: `frontend/src/App.css` (minimal styles)
- Test: create `frontend/src/admin/AdminView.test.tsx`

**Interfaces:**
- Consumes: Task 2's client functions/types; `sessionGeneration()` from `../auth/session`; `useCrudError`; `useMessages`; `useStore` (`user` for `allow_additional_admins` and self-id).
- Produces: the mounted view lists users and creates users; Task 5 adds row editing to this same file (its `UserRow` slot is the `<tr>` body).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/admin/AdminView.test.tsx`. Mock `../api/client` with the `importOriginal`-spread form (`App.test.tsx` top shows it: `async (importOriginal) => ({ ...(await importOriginal<…>()), getAdminUsers: vi.fn(), … })`) so `HttpError` and `ADMIN_MIN_PASSWORD_LENGTH` stay real while the four admin functions are mocks; seed the store with an admin user (`is_admin: true`, `allow_additional_admins` true/false per test) the way `App.test.tsx` seeds `setAuth`. Tests:

```typescript
test('mount fetches users and tiers, renders one row per user', async () => {})
test('load failure shows adminLoadFailed and no rows', async () => {})
test('create submits the form payload and appends the returned user', async () => {})
test('create pre-validates the 12-char password floor without calling the API', async () => {})
test('create failure (422 duplicate email) surfaces the formatted error', async () => {})
test('admin checkbox in the create form is disabled with a hint while allow_additional_admins is false', () => {})
```

Each body drives the real component via `@testing-library/react` (`render`, `screen`, `fireEvent`/`userEvent`, `findBy*` for the async loads) and asserts on the DOM plus the mock call arguments. The 422 test rejects `postAdminUser` with `new HttpError(422, 'POST /api/admin/users failed: 422')` and expects the `adminChangeFailed`-formatted text visible.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/admin/AdminView.test.tsx`
Expected: FAIL — the shell renders no table, no form.

- [ ] **Step 3: Implement the view**

Replace `frontend/src/admin/AdminView.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import {
  ADMIN_MIN_PASSWORD_LENGTH,
  getAdminTiers,
  getAdminUsers,
  postAdminUser,
  type AdminUser,
} from '../api/client'
import { sessionGeneration } from '../auth/session'
import { useCrudError } from '../hooks/useCrudError'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'

export function AdminView() {
  const me = useStore((s) => s.user)
  const m = useMessages()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [tiers, setTiers] = useState<string[]>([])
  const { error, run, fail } = useCrudError(m.adminChangeFailed)

  // Mounted only while the view is active and the user is an admin
  // (App.tsx render guard), so these are the only /api/admin requests the
  // session ever issues — spec §8's no-403-noise rule is structural.
  useEffect(() => {
    const gen = sessionGeneration()
    getAdminUsers()
      .then((list) => { if (sessionGeneration() === gen) setUsers(list) })
      .catch(() => { if (sessionGeneration() === gen) fail(m.adminLoadFailed) })
    getAdminTiers()
      .then((list) => { if (sessionGeneration() === gen) setTiers(list) })
      .catch(() => { if (sessionGeneration() === gen) setTiers([]) })
    // Mount-once by design: the view remounts per activation, which is
    // exactly the refetch cadence the spec wants. (The repo lints with
    // oxlint, which has no exhaustive-deps rule — no directive needed;
    // App.tsx's own mount effects carry none either.)
  }, [])

  const allowMoreAdmins = me?.allow_additional_admins ?? false

  return (
    <div className="admin-view">
      <h2>{m.adminUsersTitle}</h2>
      {error && <p className="admin-error" role="alert">{error}</p>}
      <CreateForm
        tiers={tiers}
        allowMoreAdmins={allowMoreAdmins}
        onCreated={(user) => setUsers((current) => [...current, user])}
        run={run}
        fail={fail}
      />
      <table className="admin-users">
        <thead>
          <tr>
            <th>{m.adminEmail}</th>
            <th>{m.adminDisplayName}</th>
            <th>{m.adminTier}</th>
            <th>{m.adminIsAdmin}</th>
            <th>{m.adminIsActive}</th>
            <th>{m.adminResetPassword}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                {user.email}
                {user.id === me?.id && <span className="admin-self"> {m.adminSelf}</span>}
              </td>
              <td>{user.display_name ?? ''}</td>
              <td>{user.tier}</td>
              <td>{user.is_admin ? '✓' : ''}</td>
              <td>{user.is_active ? '✓' : ''}</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface CreateFormProps {
  tiers: string[]
  allowMoreAdmins: boolean
  onCreated: (user: AdminUser) => void
  run: (action: () => Promise<void>) => Promise<void>
  fail: (message: string) => void
}

function CreateForm({ tiers, allowMoreAdmins, onCreated, run, fail }: CreateFormProps) {
  const m = useMessages()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [tier, setTier] = useState('basic')
  const [isAdmin, setIsAdmin] = useState(false)

  // Config-defined tiers arrive async and need not contain 'basic' — snap
  // the selection to a real option once the catalog lands (spec §6.1: tier
  // names are whatever the config says).
  useEffect(() => {
    if (tiers.length > 0 && !tiers.includes(tier)) setTier(tiers[0])
  }, [tiers, tier])

  async function create() {
    if (!email.trim() || !password) return
    if (password.length < ADMIN_MIN_PASSWORD_LENGTH) {
      // Reuses the existing parameterized key (AccountMenu precedent) —
      // no second hardcoded-floor message to drift.
      fail(m.passwordTooShort(ADMIN_MIN_PASSWORD_LENGTH))
      return
    }
    const gen = sessionGeneration()
    await run(async () => {
      const created = await postAdminUser({
        email: email.trim(),
        password,
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        tier,
        is_admin: isAdmin,
      })
      if (sessionGeneration() !== gen) return // session ended: do not write
      setEmail('')
      setDisplayName('')
      setPassword('')
      setIsAdmin(false)
      onCreated(created)
    })
  }

  return (
    <div className="admin-create">
      <input
        type="email"
        value={email}
        placeholder={m.adminEmail}
        aria-label={m.adminEmail}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        value={displayName}
        placeholder={m.adminDisplayName}
        aria-label={m.adminDisplayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <input
        type="password"
        value={password}
        placeholder={m.adminPassword}
        aria-label={m.adminPassword}
        onChange={(e) => setPassword(e.target.value)}
      />
      <select value={tier} aria-label={m.adminTier} onChange={(e) => setTier(e.target.value)}>
        {(tiers.length ? tiers : ['basic', 'premium']).map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
      <label title={allowMoreAdmins ? undefined : m.adminGrantDisabledHint}>
        <input
          type="checkbox"
          checked={isAdmin}
          disabled={!allowMoreAdmins}
          onChange={(e) => setIsAdmin(e.target.checked)}
        />
        {m.adminIsAdmin}
      </label>
      <button onClick={() => void create()} disabled={!email.trim() || !password}>
        {m.adminCreate}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: i18n keys**

`messages.ts` additions (next to the Task 3 keys):

```typescript
adminCreate: string
adminEmail: string
adminDisplayName: string
adminPassword: string
adminTier: string
adminIsAdmin: string
adminIsActive: string
adminResetPassword: string
adminSelf: string
adminLoadFailed: string
adminGrantDisabledHint: string
adminChangeFailed: (error: string) => string
```

(No `adminPasswordTooShort`: the existing `passwordTooShort(min)` is called with `ADMIN_MIN_PASSWORD_LENGTH` instead.)

Catalog values:

| key | en | de |
|---|---|---|
| adminCreate | `'Create user'` | `'Benutzer anlegen'` |
| adminEmail | `'Email'` | `'E-Mail'` |
| adminDisplayName | `'Display name'` | `'Anzeigename'` |
| adminPassword | `'Initial password'` | `'Anfangspasswort'` |
| adminTier | `'Tier'` | `'Stufe'` |
| adminIsAdmin | `'Admin'` | `'Admin'` |
| adminIsActive | `'Active'` | `'Aktiv'` |
| adminResetPassword | `'Reset password'` | `'Passwort zurücksetzen'` |
| adminSelf | `'(this account)'` | `'(dieses Konto)'` |
| adminLoadFailed | `'Loading users failed.'` | `'Benutzer konnten nicht geladen werden.'` |
| adminGrantDisabledHint | `'Creating additional admins is disabled.'` | `'Das Anlegen weiterer Admins ist deaktiviert.'` |
| adminChangeFailed | ``(error) => `Change failed: ${error}` `` | ``(error) => `Änderung fehlgeschlagen: ${error}` `` |

| key | es | fr |
|---|---|---|
| adminCreate | `'Crear usuario'` | `'Créer un utilisateur'` |
| adminEmail | `'Correo electrónico'` | `'E-mail'` |
| adminDisplayName | `'Nombre visible'` | `"Nom d'affichage"` |
| adminPassword | `'Contraseña inicial'` | `'Mot de passe initial'` |
| adminTier | `'Nivel'` | `'Niveau'` |
| adminIsAdmin | `'Admin'` | `'Admin'` |
| adminIsActive | `'Activo'` | `'Actif'` |
| adminResetPassword | `'Restablecer contraseña'` | `'Réinitialiser le mot de passe'` |
| adminSelf | `'(esta cuenta)'` | `'(ce compte)'` |
| adminLoadFailed | `'No se pudieron cargar los usuarios.'` | `'Échec du chargement des utilisateurs.'` |
| adminGrantDisabledHint | `'La creación de administradores adicionales está desactivada.'` | `"La création d'administrateurs supplémentaires est désactivée."` |
| adminChangeFailed | ``(error) => `Error al cambiar: ${error}` `` | ``(error) => `Échec de la modification : ${error}` `` |

| key | it | ja | zh |
|---|---|---|---|
| adminCreate | `'Crea utente'` | `'ユーザーを作成'` | `'创建用户'` |
| adminEmail | `'E-mail'` | `'メールアドレス'` | `'电子邮件'` |
| adminDisplayName | `'Nome visualizzato'` | `'表示名'` | `'显示名称'` |
| adminPassword | `'Password iniziale'` | `'初期パスワード'` | `'初始密码'` |
| adminTier | `'Livello'` | `'ティア'` | `'层级'` |
| adminIsAdmin | `'Admin'` | `'管理者'` | `'管理员'` |
| adminIsActive | `'Attivo'` | `'有効'` | `'启用'` |
| adminResetPassword | `'Reimposta password'` | `'パスワードをリセット'` | `'重置密码'` |
| adminSelf | `'(questo account)'` | `'（このアカウント）'` | `'（此账户）'` |
| adminLoadFailed | `'Caricamento utenti non riuscito.'` | `'ユーザーを読み込めませんでした。'` | `'无法加载用户。'` |
| adminGrantDisabledHint | `'La creazione di ulteriori admin è disattivata.'` | `'追加の管理者の作成は無効になっています。'` | `'已禁用创建其他管理员。'` |
| adminChangeFailed | ``(error) => `Modifica non riuscita: ${error}` `` | ``(error) => `変更に失敗しました: ${error}` `` | ``(error) => `更改失败：${error}` `` |

`App.css` additions — follow the sibling views' spacing conventions; keep it minimal:

```css
.admin-view { padding: 1rem 1.5rem; overflow-y: auto; }
.admin-create { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
.admin-users { border-collapse: collapse; }
.admin-users th, .admin-users td { padding: 0.3rem 0.75rem; text-align: left; border-bottom: 1px solid #ddd; }
.admin-error { color: #e5484d; }
.admin-self { opacity: 0.6; }
```

(`App.css` defines no color variables — literals are the house style; `#e5484d` matches `.profiles-error`. Read the sibling `.profiles-*` rules and keep the same conventions.)

- [ ] **Step 5: Run the gates**

Run: `npx vitest run && npm run build` (plus `npx oxlint`)
Expected: green, 487 + 6 = 493 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/admin/ frontend/src/i18n/ frontend/src/App.css
git commit -m "feat(admin-ui): user table and create form (M6)"
```

---

### Task 5: Row editing — tier, flags, display name, password reset

**Files:**
- Modify: `frontend/src/admin/AdminView.tsx`
- Modify: `docs/frontend-architecture.md` (admin view section)
- Test: `frontend/src/admin/AdminView.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 4's component and `patchAdminUser`/`AdminUserPatch`.
- Produces: the finished M6 view.

- [ ] **Step 1: Write the failing tests**

Append to `AdminView.test.tsx`:

```typescript
test('changing a row tier PATCHes {tier} and updates the row', async () => {})
test('deactivating another user PATCHes {is_active:false}', async () => {})
test('own row admin and active controls are disabled', async () => {})
test('promote control is disabled while allow_additional_admins is false, demotion stays enabled', async () => {})
test('password reset sends {password} after the 12-char pre-check', async () => {})
test('display name edit PATCHes {display_name}, clearing it sends null', async () => {})
```

Real bodies with the Task 4 arrangement; assert exact `patchAdminUser` call arguments (id + minimal patch object) and DOM updates from the mocked response.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/admin/AdminView.test.tsx`
Expected: the six new tests FAIL (rows are read-only so far).

- [ ] **Step 3: Implement**

In `AdminView.tsx`, replace the read-only `<tr>` body with a `UserRow` component in the same file, and add a `save` helper next to the load effect in `AdminView`:

```tsx
  // Returns whether the change actually committed: run() swallows the
  // rejection into the error banner, so callers that must react to the
  // outcome (password reset clearing its field) need this signal.
  async function save(user: AdminUser, patch: AdminUserPatch): Promise<boolean> {
    const gen = sessionGeneration()
    let committed = false
    await run(async () => {
      const updated = await patchAdminUser(user.id, patch)
      if (sessionGeneration() !== gen) return // session ended: do not write
      setUsers((current) => current.map((u) => (u.id === updated.id ? updated : u)))
      committed = true
    })
    return committed
  }
```

(`patchAdminUser` and `AdminUserPatch` join the imports from `../api/client`; `fail` is passed down to `UserRow` for the password pre-check.) Table body becomes:

```tsx
          {users.map((user) => (
            <UserRow
              // display_name folded into the key (ProfilesView precedent):
              // the row's name input is local state seeded from the prop, so
              // a server-side change must remount the row to resync it.
              key={`${user.id}:${user.display_name ?? ''}`}
              user={user}
              isSelf={user.id === me?.id}
              tiers={tiers}
              allowMoreAdmins={allowMoreAdmins}
              onSave={save}
              fail={fail}
            />
          ))}
```

`UserRow`, in the same file:

```tsx
interface UserRowProps {
  user: AdminUser
  isSelf: boolean
  tiers: string[]
  allowMoreAdmins: boolean
  onSave: (user: AdminUser, patch: AdminUserPatch) => Promise<boolean>
  fail: (message: string) => void
}

function UserRow({ user, isSelf, tiers, allowMoreAdmins, onSave, fail }: UserRowProps) {
  const m = useMessages()
  const [name, setName] = useState(user.display_name ?? '')
  const [newPassword, setNewPassword] = useState('')

  // The disabled states mirror server guards the UI cannot replace:
  // self-demotion/self-deactivation 409 (admin.py lockout rule) and
  // promotion 403 while auth.allow_additional_admins is off. Demotion of
  // OTHER admins stays enabled — it only ever reduces privilege.
  const adminToggleDisabled = isSelf || (!user.is_admin && !allowMoreAdmins)

  function saveName() {
    const trimmed = name.trim()
    if (trimmed === (user.display_name ?? '')) return
    void onSave(user, { display_name: trimmed === '' ? null : trimmed })
  }

  async function resetPassword() {
    if (newPassword.length < ADMIN_MIN_PASSWORD_LENGTH) {
      fail(m.passwordTooShort(ADMIN_MIN_PASSWORD_LENGTH))
      return
    }
    // Clear only on a committed reset: run() swallows failures into the
    // error banner, so a failed PATCH must leave the typed password in
    // place rather than wiping it under the error message.
    if (await onSave(user, { password: newPassword })) setNewPassword('')
  }

  return (
    <tr className={user.is_active ? '' : 'admin-inactive'}>
      <td>
        {user.email}
        {isSelf && <span className="admin-self"> {m.adminSelf}</span>}
      </td>
      <td>
        <input
          value={name}
          aria-label={`${m.adminDisplayName}: ${user.email}`}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
        />
      </td>
      <td>
        <select
          value={user.tier}
          aria-label={`${m.adminTier}: ${user.email}`}
          onChange={(e) => void onSave(user, { tier: e.target.value })}
        >
          {/* A user can sit on a tier no longer in config — keep it as an
              option or the controlled select silently shows the wrong one. */}
          {(tiers.includes(user.tier) ? tiers : [user.tier, ...tiers]).map((tierName) => (
            <option key={tierName} value={tierName}>{tierName}</option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="checkbox"
          checked={user.is_admin}
          disabled={adminToggleDisabled}
          aria-label={`${m.adminIsAdmin}: ${user.email}`}
          title={!isSelf && !user.is_admin && !allowMoreAdmins ? m.adminGrantDisabledHint : undefined}
          onChange={(e) => void onSave(user, { is_admin: e.target.checked })}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={user.is_active}
          disabled={isSelf}
          aria-label={`${m.adminIsActive}: ${user.email}`}
          onChange={(e) => void onSave(user, { is_active: e.target.checked })}
        />
      </td>
      <td className="admin-reset">
        <input
          type="password"
          value={newPassword}
          placeholder={m.adminPassword}
          aria-label={`${m.adminResetPassword}: ${user.email}`}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <button disabled={!newPassword} onClick={() => void resetPassword()}>
          {m.adminResetPassword}
        </button>
      </td>
    </tr>
  )
}
```

`App.css` addition:

```css
.admin-inactive td { opacity: 0.55; }
.admin-reset { white-space: nowrap; }
```

- [ ] **Step 4: Update the architecture doc**

In `docs/frontend-architecture.md`, add an "Admin view (M6)" subsection where the other views are described: fifth `activeView` conditionally mounted behind `is_admin && activeView === 'admin'` (so non-admin sessions issue zero `/api/admin/*` requests), data from `getAdminUsers`/`getAdminTiers` on mount with `sessionGeneration` guards, UI mirrors of the server guards (self-409, promotion-403 with hint, 12-char floor), errors via `useCrudError` house pattern.

- [ ] **Step 5: Run the gates**

Run: `npx vitest run && npm run build` (plus `npx oxlint`)
Expected: green, 493 + 6 = 499 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/admin/ frontend/src/App.css docs/frontend-architecture.md
git commit -m "feat(admin-ui): row editing with mirrored server guards (M6)"
```

---

## Completion (controller, not a task)

After the final review: verify one end-to-end mutation against a scratch backend if practical, create the PR, update `docs/LOGBOOK.md` (entry referenced by PR number: M6 admin UI, the one backend addition, final test counts) and flip the roadmap's M6 row to done with the PR number. LOGBOOK "Next" pointer moves to the first backlog follow-up (B5+B7) or sub-project 2, per the owner.
