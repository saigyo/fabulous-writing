# B32 Deactivated-User Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deactivated users no longer receive reset mail, cannot have their remote Supabase credential rotated, and get honest error copy on every surface (spec: `docs/superpowers/specs/2026-08-16-b32-deactivated-user-guards-design.md`, issue #106).

**Architecture:** Three server-side guards in the existing supabase-mode routes — a silent skip in `reset_request`, a pre-rotation `is_active` hoist in `reset_confirm`'s link leg (plus a symmetric honest-code split on the retry leg), and an honest 422 in `resend_invite` — with two new error codes (`account_inactive`, `user_inactive`) mapped in the frontend and one e2e absence test.

**Tech Stack:** FastAPI + SQLite backend (uv, run from `backend/`), React 19/TS/Vite frontend (npm, `frontend/`), B27 supabase e2e stack (`scripts/e2e-supabase.sh`).

## Global Constraints

- The live database `backend/data/fabulous.db` is NEVER read or written by tests; every test uses the existing `tmp_path`-based fixtures.
- Backend gate: `uv run pytest -q` from `backend/`, green with ZERO warnings, Docker/network-free. Single-file runs use `-n0` (never `-p no:xdist`).
- Frontend gate: `npm test -- --run`, `npx tsc -b --noEmit`, `npx oxlint` — all clean, from `frontend/`.
- Every guard test is mutation-verified: comment the guard out, watch the test fail, restore by REVERTING THE EDIT in the editor — never `git checkout <file>` (it can wipe unrelated uncommitted work).
- New UI strings use the informal register (Du/tu/tú/你) in all 7 locales (en de fr es it ja zh); `register.test.ts` scans raw source automatically. Code comments in English.
- Error codes verbatim: `account_inactive` (reset-confirm, both legs), `user_inactive` (resend-invite). Existing codes (`invalid_or_expired_link`, `already_active`, `not_linked`, `password_weak`, `update_failed`) unchanged.
- The unauthenticated `reset-request` surface stays unenumerable: inactive skip returns the identical 204 and still consumes a throttle slot.
- Secrets from env only; never log token values. No new Settings/env knobs.
- Commits end with the two repo trailers (`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01JXiCFTQQmJeJt3MB8qZdGA`).
- E2e suite (Task 5) is NOT part of the default gate; it runs only via `scripts/e2e-supabase.sh` against the local supabase stack (containers managed exclusively via `supabase start`/`supabase stop`; never touch ports 5173/8000).

---

### Task 1: `reset_request` silent skip for inactive users

**Files:**
- Modify: `backend/app/api/auth.py` (function `reset_request`, ~line 730)
- Test: `backend/tests/test_auth_supabase_api.py` (class `TestResetRequest`, ~line 300)

**Interfaces:**
- Consumes: `UserStore.get_by_email(email) -> User | None` (exists, `backend/app/services/users.py:184`, COLLATE NOCASE + strip); `FakeSupabaseGateway.reset_emails` list (exists).
- Produces: no new interfaces.

- [ ] **Step 1: Write the failing tests** — append to `TestResetRequest`:

```python
    def test_inactive_local_user_silent_204_without_gateway_call(self, supabase_app):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        app.state.user_store.update_user(body["user"]["id"], is_active=False)
        before = list(fake.reset_emails)
        resp = client.post("/api/auth/reset-request", json={"email": EMAIL})
        assert resp.status_code == 204
        # The unenumerable contract: same 204, but no mail was requested.
        assert fake.reset_emails == before

    def test_active_local_user_still_mails(self, supabase_app):
        app, fake = supabase_app
        client, _body = _login_ok(app, fake)
        resp = client.post("/api/auth/reset-request", json={"email": EMAIL})
        assert resp.status_code == 204
        assert EMAIL in fake.reset_emails
```

(The unknown-email case is already pinned by `test_always_204_including_unknown_email` — do not duplicate it.)

- [ ] **Step 2: Run to verify the first fails, the second passes**

Run (from `backend/`): `uv run pytest tests/test_auth_supabase_api.py::TestResetRequest -n0 -q`
Expected: `test_inactive_local_user_silent_204_without_gateway_call` FAILS (`fake.reset_emails` gained an entry); `test_active_local_user_still_mails` PASSES (pins current behavior).

- [ ] **Step 3: Implement the guard** — in `reset_request`, after the `app.state.reset_throttle.record_failure(key)` line and before the `try:` block around `send_reset_email`:

```python
    user = app.state.user_store.get_by_email(body.email)
    if user is not None and not user.is_active:
        # B32 (#106): deactivation is local-only state -- without this,
        # GoTrue would mail the still-active REMOTE identity a working
        # link. Same 204, and the throttle slot above is already spent:
        # silence stays indistinguishable from delivery.
        return Response(status_code=204)
```

- [ ] **Step 4: Run to verify both pass**

Run: `uv run pytest tests/test_auth_supabase_api.py::TestResetRequest -n0 -q`
Expected: all TestResetRequest tests PASS.

- [ ] **Step 5: Mutation-verify** — comment out the two new guard lines (`if user is not None...return`), re-run Step 4's command, expect the new test to FAIL, then restore the lines by editing them back in (not via git).

- [ ] **Step 6: Run the full backend gate**

Run: `uv run pytest -q`
Expected: green, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/auth.py backend/tests/test_auth_supabase_api.py
git commit -m "feat(auth): skip reset mail for deactivated users (B32, #106)"
```

---

### Task 2: reset-confirm — pre-rotation hoist (link leg) + honest split (both legs)

**Files:**
- Modify: `backend/app/api/auth.py` (function `reset_confirm`, ~lines 804-901)
- Test: `backend/tests/test_auth_supabase_api.py` (class `TestResetConfirm`, ~line 320)

**Interfaces:**
- Consumes: `store.get_by_external_id(uuid) -> User | None`, `store.get_by_email(email) -> User | None`, `SupabaseSession.email: str | None`; fake knobs `valid_token_hashes`, `weak_password_reasons`, `stored_password(email)` (all exist).
- Produces: 422 `{"code": "account_inactive"}` on both confirm legs for a known-but-inactive account — Task 4's frontend maps it.

- [ ] **Step 1: Write the failing tests** — append to `TestResetConfirm`:

```python
    def test_linked_inactive_row_422_account_inactive_no_rotation(self, supabase_app):
        app, fake = supabase_app
        uuid = fake.register_user(EMAIL, PASSWORD, uuid=UUID)
        client = TestClient(app)
        login = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
        app.state.user_store.update_user(login.json()["user"]["id"], is_active=False)
        fake.valid_token_hashes["inactive-hash"] = (uuid, EMAIL)
        resp = client.post(
            "/api/auth/reset-confirm",
            json={
                "token_hash": "inactive-hash", "type": "recovery",
                "new_password": "Another-new-pw-1",
            },
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "account_inactive"
        # The remote credential did NOT rotate.
        assert fake.stored_password(EMAIL) == PASSWORD
        # The one-time link is spent either way (verify_otp burned it).
        again = client.post(
            "/api/auth/reset-confirm",
            json={
                "token_hash": "inactive-hash", "type": "recovery",
                "new_password": "Another-new-pw-1",
            },
        )
        assert again.json()["detail"]["code"] == "invalid_or_expired_link"

    def test_unlinked_inactive_row_by_email_422_account_inactive_no_rotation(self, supabase_app):
        # Adoption edge: a local row with a matching email but no
        # external_id would be adopted by verify() -- while inactive it
        # must block rotation the same way, and must NOT get linked.
        app, fake = supabase_app
        row = app.state.user_store.create_user("dormant@example.com")
        app.state.user_store.update_user(row.id, is_active=False)
        fake.valid_token_hashes["adopt-hash"] = ("fake-uuid-dormant-1", "dormant@example.com")
        client = TestClient(app)
        resp = client.post(
            "/api/auth/reset-confirm",
            json={
                "token_hash": "adopt-hash", "type": "invite",
                "new_password": "Invitee-pw-123",
            },
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "account_inactive"
        # Materialized by the fake's verify_otp with an empty password and
        # never rotated past it.
        assert fake.stored_password("dormant@example.com") == ""
        assert app.state.user_store.get_user(row.id).external_id is None

    def test_retry_leg_inactive_user_422_account_inactive_no_rotation(self, supabase_app):
        app, fake = supabase_app
        uuid = fake.register_user(EMAIL, PASSWORD, uuid=UUID)
        client = TestClient(app)
        login = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
        user_id = login.json()["user"]["id"]
        fake.valid_token_hashes["retry-hash"] = (uuid, EMAIL)
        fake.weak_password_reasons = ["length"]
        first = client.post(
            "/api/auth/reset-confirm",
            json={
                "token_hash": "retry-hash", "type": "recovery",
                "new_password": "Weak-but-long-pw1",
            },
        )
        assert first.status_code == 422
        retry_token = first.json()["detail"]["retry_token"]
        fake.weak_password_reasons = None
        app.state.user_store.update_user(user_id, is_active=False)
        resp = client.post(
            "/api/auth/reset-confirm",
            json={"retry_token": retry_token, "new_password": "Strong-new-pw-12"},
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "account_inactive"
        assert fake.stored_password(EMAIL) == PASSWORD
```

- [ ] **Step 2: Run to verify all three fail**

Run: `uv run pytest tests/test_auth_supabase_api.py::TestResetConfirm tests/test_auth_supabase_api.py::TestResetConfirmRetryFlow -n0 -q` — the three new tests FAIL (first two rotate the password / return 204 or wrong code; the third returns `invalid_or_expired_link`). Note: single-file selection MUST carry `-n0`.

- [ ] **Step 3: Implement — link leg.** In `reset_confirm`, replace the current post-verify block

```python
    await _update_password_or_retry_envelope(
        app, session.user_id, body.new_password, session.access_token
    )
    # Rotation is complete; eviction bookkeeping keyed to the EXISTING row
    # (lookup only, never JIT) exactly as B14 shipped it, and it runs
    # BEFORE the verifier call so it survives a verification failure.
    existing_row = store.get_by_external_id(session.user_id)
    if existing_row is not None:
        await _finish_confirmed_rotation(
            app, store, existing_row.id, session.access_token
        )
```

with:

```python
    # B32 (#106): resolve the local row BEFORE any remote rotation -- a
    # deactivated account's Supabase credential must not be rotatable.
    # The link is already spent (verify_otp burned it -- correct), and the
    # submitter has proven mailbox control, so the honest account_inactive
    # answer gives an enumeration attacker nothing.
    existing_row = store.get_by_external_id(session.user_id)
    inactive_row = existing_row
    if inactive_row is None and session.email is not None:
        # Adoption edge: an unlinked local row that verify() would adopt
        # by email must block rotation the same way while inactive. A row
        # linked to a DIFFERENT external_id is deliberately excluded --
        # verify() refuses to adopt those, and this surface must not
        # report another account's state.
        candidate = store.get_by_email(session.email)
        if candidate is not None and candidate.external_id is None:
            inactive_row = candidate
    if inactive_row is not None and not inactive_row.is_active:
        raise HTTPException(422, {"code": "account_inactive"})
    await _update_password_or_retry_envelope(
        app, session.user_id, body.new_password, session.access_token
    )
    # Rotation is complete; eviction bookkeeping keyed to the EXISTING row
    # (lookup only, never JIT -- never the email-adopted fallback) exactly
    # as B14 shipped it, and it runs BEFORE the verifier call so it
    # survives a verification failure.
    if existing_row is not None:
        await _finish_confirmed_rotation(
            app, store, existing_row.id, session.access_token
        )
```

- [ ] **Step 4: Implement — post-verify split (link leg).** Replace

```python
    user = store.get_user(verified.user_id)
    if user is None or not user.is_active:
        raise HTTPException(422, {"code": "invalid_or_expired_link"})
```

with:

```python
    user = store.get_user(verified.user_id)
    if user is None:
        raise HTTPException(422, {"code": "invalid_or_expired_link"})
    if not user.is_active:
        # Defense in depth: normally unreachable after the pre-rotation
        # hoist above; kept so a future restructure cannot reopen the gap.
        raise HTTPException(422, {"code": "account_inactive"})
```

- [ ] **Step 5: Implement — retry-leg split.** Replace

```python
        user = store.get_user(verified.user_id)
        if user is None or not user.is_active or user.external_id is None:
            raise HTTPException(422, {"code": "invalid_or_expired_link"})
```

with:

```python
        user = store.get_user(verified.user_id)
        if user is None:
            raise HTTPException(422, {"code": "invalid_or_expired_link"})
        if not user.is_active:
            # Known account, verified otp session: honest answer (B32).
            raise HTTPException(422, {"code": "account_inactive"})
        if user.external_id is None:
            raise HTTPException(422, {"code": "invalid_or_expired_link"})
```

- [ ] **Step 6: Run to verify all pass**

Run: `uv run pytest tests/test_auth_supabase_api.py -n0 -q`
Expected: whole file green (existing confirm/retry tests must not regress).

- [ ] **Step 7: Mutation-verify** — one at a time: (a) comment out the link leg's `if inactive_row is not None...raise` pair → the first two new tests FAIL; (b) restore, then comment the retry leg's `if not user.is_active...raise` → the third FAILS; restore. Re-run Step 6 green after restoration.

- [ ] **Step 8: Full backend gate**

Run: `uv run pytest -q`
Expected: green, zero warnings.

- [ ] **Step 9: Commit**

```bash
git add backend/app/api/auth.py backend/tests/test_auth_supabase_api.py
git commit -m "feat(auth): block remote rotation for deactivated accounts, honest account_inactive (B32, #106)"
```

---

### Task 3: `resend_invite` honest `user_inactive` 422

**Files:**
- Modify: `backend/app/api/admin.py` (function `resend_invite`, ~line 393)
- Test: `backend/tests/test_auth_supabase_api.py` (class `TestResendInvite`, ~line 1742)

**Interfaces:**
- Consumes: `fake.invite_calls: dict[str, int]` counter (exists); `TestResendInvite._invite` helper (exists).
- Produces: 422 `{"code": "user_inactive"}` — Task 4's `mapAdminError` maps it; Task 5's e2e asserts it live.

- [ ] **Step 1: Write the failing test** — append to `TestResendInvite`:

```python
    def test_inactive_user_422_user_inactive_without_gateway_call(self, supabase_app):
        app, fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        created = self._invite(client, headers, email="dormant-invitee@example.com")
        app.state.user_store.update_user(created["id"], is_active=False)
        calls_before = fake.invite_calls["dormant-invitee@example.com"]

        resp = client.post(
            f"/api/admin/users/{created['id']}/resend-invite", headers=headers,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "user_inactive"
        assert fake.invite_calls["dormant-invitee@example.com"] == calls_before
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_auth_supabase_api.py::TestResendInvite -n0 -q`
Expected: the new test FAILS (currently 204, counter bumped).

- [ ] **Step 3: Implement** — in `resend_invite`, between the `user is None` 404 check and the `user.external_id is None` check:

```python
    if not user.is_active:
        # B32 (#106): a deactivated invitee must not be re-invited into a
        # dead-end. Admin-only surface -- the honest answer is fine here.
        raise HTTPException(422, {"code": "user_inactive"})
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_auth_supabase_api.py::TestResendInvite -n0 -q`
Expected: all PASS.

- [ ] **Step 5: Mutation-verify** — comment the guard out, re-run, expect the new test to FAIL; restore by editing back.

- [ ] **Step 6: Full backend gate**

Run: `uv run pytest -q`
Expected: green, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/admin.py backend/tests/test_auth_supabase_api.py
git commit -m "feat(admin): reject invite resend for deactivated users (B32, #106)"
```

---

### Task 4: Frontend mappings + i18n

**Files:**
- Modify: `frontend/src/i18n/messages.ts` (add two keys to the `Messages` type, next to `resetLinkInvalid` / `adminResendAlreadyActive`)
- Modify: `frontend/src/i18n/{en,de,fr,es,it,ja,zh}.ts`
- Modify: `frontend/src/auth/ResetPasswordForm.tsx` (function `mapResetError`, ~line 21)
- Modify: `frontend/src/admin/AdminView.tsx` (function `mapAdminError`, ~line 22)
- Test: `frontend/src/auth/ResetPasswordForm.test.tsx`, `frontend/src/admin/AdminView.test.tsx`

**Interfaces:**
- Consumes: backend codes `account_inactive` (Task 2) and `user_inactive` (Task 3); `HttpError` with `.code` (exists).
- Produces: i18n keys `resetAccountInactive`, `adminUserInactive` (exact names — Task 6's docs reference them).

- [ ] **Step 1: Write the failing tests.**

In `ResetPasswordForm.test.tsx` (mirror the file's existing rejection tests — `postResetConfirm` is already `vi.mock`ed):

```tsx
  it('an account_inactive rejection shows the deactivated-account message', async () => {
    vi.mocked(postResetConfirm).mockRejectedValueOnce(
      new HttpError(422, 'POST /api/auth/reset-confirm failed: 422', 'account_inactive'),
    )
    render(<ResetPasswordForm tokenHash="tok" type="recovery" onDone={() => {}} />)
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(en.resetNewPassword), 'newpassword1')
    await u.type(screen.getByLabelText(en.resetRepeatPassword), 'newpassword1')
    await u.click(screen.getByRole('button', { name: en.resetSubmit }))
    await screen.findByText(en.resetAccountInactive)
  })
```

In `AdminView.test.tsx`: copy the structure of the existing test `a 422 already_active resend response surfaces adminResendAlreadyActive` (~line 722) into a sibling test named `a 422 user_inactive resend response surfaces adminUserInactive`, changing only the rejected `HttpError`'s code to `'user_inactive'` and the final assertion to `await screen.findByText(en.adminUserInactive)`. (This exercises the stale-tab race: the row still renders as active, the server already knows better.)

- [ ] **Step 2: Run to verify they fail to compile/pass**

Run (from `frontend/`): `npm test -- --run`
Expected: FAIL — `en.resetAccountInactive` / `en.adminUserInactive` do not exist yet.

- [ ] **Step 3: Add the i18n keys.** In `messages.ts` add to the `Messages` type:

```ts
  resetAccountInactive: string
  adminUserInactive: string
```

Locale values (place `resetAccountInactive` beside `resetLinkInvalid`, `adminUserInactive` beside `adminResendAlreadyActive`):

- `en.ts`: `resetAccountInactive: 'This account is deactivated — contact your admin.',` · `adminUserInactive: 'This account is deactivated.',`
- `de.ts`: `resetAccountInactive: 'Dieses Konto ist deaktiviert — wende dich an deinen Admin.',` · `adminUserInactive: 'Dieses Konto ist deaktiviert.',`
- `fr.ts`: `resetAccountInactive: 'Ce compte est désactivé — contacte ton admin.',` · `adminUserInactive: 'Ce compte est désactivé.',`
- `es.ts`: `resetAccountInactive: 'Esta cuenta está desactivada — contacta a tu admin.',` · `adminUserInactive: 'Esta cuenta está desactivada.',`
- `it.ts`: `resetAccountInactive: 'Questo account è disattivato — contatta il tuo admin.',` · `adminUserInactive: 'Questo account è disattivato.',`
- `ja.ts`: `resetAccountInactive: 'このアカウントは無効化されています。管理者に連絡してください。',` · `adminUserInactive: 'このアカウントは無効化されています。',`
- `zh.ts`: `resetAccountInactive: '此账户已被停用——请联系管理员。',` · `adminUserInactive: '此账户已被停用。',` (the catalog's existing terminology is 账户, clause separator ——; do not use 账号)

(French file convention: apostrophes inside single-quoted strings must be the typographic ’ U+2019 — the strings above contain none, keep it that way.)

- [ ] **Step 4: Add the mappings.**

`mapResetError` — insert after the `invalid_or_expired_link` line:

```ts
    if (err.code === 'account_inactive') return m.resetAccountInactive
```

Also update the comment above `mapResetError` (`ResetPasswordForm.tsx:15-17`): it says "only the two codes reset-confirm can actually raise are handled specifically" — the count is stale; reword to "the codes reset-confirm can actually raise" without a number.

`mapAdminError` — insert before the fallback return:

```ts
  if (err instanceof HttpError && err.code === 'user_inactive') {
    return m.adminUserInactive
  }
```

- [ ] **Step 5: Run the full frontend gate**

Run: `npm test -- --run && npx tsc -b --noEmit && npx oxlint`
Expected: all green (the register scan in `register.test.ts` validates the new strings automatically).

- [ ] **Step 6: Mutation-verify** — comment out the `account_inactive` line in `mapResetError`, run `npm test -- --run`, expect the new ResetPasswordForm test to FAIL (falls to `passwordFailed`); restore. Same for the `user_inactive` branch in `mapAdminError` vs. the new AdminView test.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/i18n frontend/src/auth/ResetPasswordForm.tsx frontend/src/auth/ResetPasswordForm.test.tsx frontend/src/admin/AdminView.tsx frontend/src/admin/AdminView.test.tsx
git commit -m "feat(frontend): map account_inactive and user_inactive to honest copy (B32, #106)"
```

---

### Task 5: E2e coverage (B27 suite)

**Files:**
- Modify: `backend/tests_e2e/mailpit.py` (add `count_messages`)
- Modify: `backend/tests_e2e/test_resilience.py` (new test + mail-budget docstring update)

**Interfaces:**
- Consumes: fixtures `app_url`, `admin_creds`, `runid`, `mailpit` (exist in `backend/tests_e2e/conftest.py`); helpers `login`, `bearer`, `admin_create_user`, `TIMEOUT` (exist); routes from Tasks 1 and 3.
- Produces: `Mailpit.count_messages(to: str) -> int`.

**Precondition:** the supabase stack is running (`scripts/e2e-supabase.sh` starts it if down). This task is skipped entirely if Docker/colima is unavailable — note it in the report and leave the test written; CI's workflow_dispatch job covers it.

- [ ] **Step 1: Add the Mailpit helper** — in `mailpit.py`, below `wait_for_message`:

```python
    def count_messages(self, to: str) -> int:
        """Current number of messages addressed to `to` -- the absence
        half of an assertion pair: capture before, compare after a
        deterministic bound (a later mail's arrival) has passed.
        limit=200 keeps the page size above anything a test run can
        accumulate (Mailpit's default page is 50 -- len() over a capped
        page would silently undercount)."""
        resp = httpx.get(
            f"{self._base}/api/v1/search",
            params={"query": f"to:{to}", "limit": 200},
            timeout=10,
        )
        resp.raise_for_status()
        return len(resp.json().get("messages", []))
```

- [ ] **Step 2: Write the e2e test** — append to `test_resilience.py`:

```python
def test_deactivated_user_reset_and_resend_guards(app_url, admin_creds, runid, mailpit):
    """B32 (#106): a deactivated user's mailbox stays silent on
    reset-request, and resend-invite answers user_inactive. The admin's
    own recovery mail is the control: its ARRIVAL bounds the wait, so no
    sleep has to guess at delivery time (the sleep below only clears
    GoTrue's per-address max_frequency)."""
    email = f"dormant-{runid}@e2e.local"
    password = f"E2e-Dormant-Password-{runid}"
    admin_email = admin_creds[0]

    admin = login(app_url, *admin_creds)
    created = admin_create_user(app_url, admin["token"], email)
    message = mailpit.wait_for_message(email)
    token_hash, _ = mailpit.extract_token(message["HTML"])
    confirm = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": token_hash, "type": "invite", "new_password": password},
        timeout=TIMEOUT,
    )
    assert confirm.status_code == 204

    deact = httpx.patch(
        f"{app_url}/api/admin/users/{created['id']}",
        json={"is_active": False},
        headers=bearer(admin["token"]),
        timeout=TIMEOUT,
    )
    assert deact.status_code == 200

    # Clear GoTrue's per-address max_frequency (1 s): without this the
    # dormant mailbox could stay empty even with the guard REMOVED
    # (GoTrue itself suppressing the mail), passing the test vacuously.
    time.sleep(1.5)

    dormant_before = mailpit.count_messages(email)
    admin_before = mailpit.count_messages(admin_email)
    resp = httpx.post(
        f"{app_url}/api/auth/reset-request", json={"email": email}, timeout=TIMEOUT
    )
    assert resp.status_code == 204
    resp = httpx.post(
        f"{app_url}/api/auth/reset-request", json={"email": admin_email}, timeout=TIMEOUT
    )
    assert resp.status_code == 204

    # The control mail (admin recovery) arriving proves GoTrue processed
    # requests issued AFTER the dormant one -- the dormant mailbox result
    # below is therefore final, not just not-yet-delivered.
    mailpit.wait_for_message(admin_email, min_count=admin_before + 1)
    assert mailpit.count_messages(email) == dormant_before

    resend = httpx.post(
        f"{app_url}/api/admin/users/{created['id']}/resend-invite",
        headers=bearer(admin["token"]),
        timeout=TIMEOUT,
    )
    assert resend.status_code == 422
    assert resend.json()["detail"]["code"] == "user_inactive"
```

- [ ] **Step 3: Update the module docstring's mail-budget note** — change `these tests add ~3 mails per run` to `these tests add ~5 mails per run` (this test adds the dormant invite + the admin recovery control).

- [ ] **Step 4: Run the e2e suite**

Run (from repo root): `scripts/e2e-supabase.sh`
(The wrapper IS the pytest invocation — `exec uv run pytest tests_e2e -q "$@" -n0` — starting the stack first if it is down. Pass no extra args; never add xdist flags.)
Expected: all tests PASS, including the two pre-existing resilience tests.

- [ ] **Step 5: Verify the default gate is still stack-free**

Run (from `backend/`): `uv run pytest -q`
Expected: green, zero warnings, no Docker required (testpaths pin already enforces this; this run just proves no accidental import leak).

- [ ] **Step 6: Commit**

```bash
git add backend/tests_e2e/mailpit.py backend/tests_e2e/test_resilience.py
git commit -m "test(e2e): deactivated-user reset silence and resend guard (B32, #106)"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/backend-architecture.md` (supabase auth / reset-confirm section)
- Modify: `docs/frontend-architecture.md` (error-mapping / i18n section)
- Modify: `docs/supabase-auth-setup.md` (reset-flow behavior notes)

**Interfaces:** consumes the shipped behavior of Tasks 1-4 (codes `account_inactive`, `user_inactive`; keys `resetAccountInactive`, `adminUserInactive`).

- [ ] **Step 1: backend-architecture.md** — in the section describing the reset/confirm flow, add a short paragraph (match surrounding prose style):

> Deactivated users (B32, #106): `reset-request` consults the local store and silently skips the gateway call for an inactive account (same 204, throttle slot still spent — the surface stays unenumerable). On `reset-confirm`, both legs resolve the local row *before* any remote rotation — the link still burns, but an inactive account's Supabase credential is never rotated, and the response is an honest 422 `account_inactive` (post-mailbox-proof, so nothing is enumerable). Deliberate residual: because the guard fires before rotation, the burned link's verify_otp session is never globally signed out — its GoTrue refresh token lives to natural expiry, fail-closed at our layer (every local surface rejects inactive rows). `resend-invite` rejects inactive targets with 422 `user_inactive` before calling GoTrue.

Also update the resend-invite error-code enumeration (~line 1445, currently naming `already_active`/`not_linked`) to include `user_inactive`.

- [ ] **Step 2: frontend-architecture.md** — three anchors, not one:
  - ~line 1270 (`mapResetError`'s handled-code enumeration): add `account_inactive` → `resetAccountInactive` to the list of specially-handled codes.
  - ~line 1657: the claim that resend "falls through `mapAdminError` … though resend itself never returns that code" is false after Task 3 — reword: resend can now return `user_inactive`, which `mapAdminError` maps to `adminUserInactive` (stale-tab race; the button is already disabled for rows known inactive).
  - ~line 1660: the resend-button gating description (`invitesAvailable && user.external_id !== null`) is stale since PR #105 — add the `!user.is_active` disable to the description while in the file.

- [ ] **Step 3: supabase-auth-setup.md** — where the guide describes the reset flow's behavior, add a sentence: deactivating a user in the app also stops reset mails for that address and blocks credential rotation via already-issued links; the remote GoTrue identity itself stays active (deactivation is app-local state).

- [ ] **Step 4: Verify docs build nothing to run** — proofread the three diffs; confirm no stale line numbers or code references.

- [ ] **Step 5: Commit**

```bash
git add docs/backend-architecture.md docs/frontend-architecture.md docs/supabase-auth-setup.md
git commit -m "docs: deactivated-user guard semantics (B32, #106)"
```

---

## Post-plan (session-level, not tasks)

Handled by the controlling session after Task 6, per repo convention — an executing subagent stops at Task 6:

1. Final whole-branch review (subagent-driven-development's final reviewer), fix wave if needed.
2. Push `b32-deactivated-user-guards`; open the PR with body ending in its own line `Closes #106.` plus the standard generation footer.
3. Request Copilot review; spawn a synchronous background watcher for its completion; reply to and resolve EVERY thread (check the read set — Copilot samples).
4. Dispatch the e2e workflow pre-merge: `gh workflow run e2e-supabase.yml --ref b32-deactivated-user-guards` (registration lives on main; any branch may be the dispatch ref).
5. LOGBOOK entry by PR number as the LAST commit on the branch before merge; owner merges (rebase-merge).
