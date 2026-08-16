# Invite/Reset Resilience Bundle Implementation Plan (B28+B29+B30+B31)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make supabase-mode invite/reset flows survive expired links (admin resend), GoTrue password-strength rejections and transient update failures (verify-once-retry-many), linked-identity OAuth sessions (per-session amr guard), and concurrent admin operations (per-email locks) — one PR closing #96, #97, #100, #101.

**Architecture:** Four interlocking changes around the shipped B14 code: one new claim guard in `SupabaseTokenVerifier`; a split of the gateway's atomic confirm into verify + retryable update with a distinct weak-password error; a resend endpoint that leans on GoTrue's actual re-invite semantics (probed); an `asyncio.Lock`-per-email table around the admin create/resend remote legs. Frontend keeps the reset form mounted across rejections and adds the admin resend action.

**Tech Stack:** FastAPI + supabase-auth (backend), React 19/TS + Vitest (frontend), B27 offline e2e stack (supabase CLI local stack + Mailpit).

**Spec:** `docs/superpowers/specs/2026-08-16-invite-reset-resilience-design.md` — its "Empirically verified GoTrue facts" section is ground truth; do not re-litigate it.

## Spec adaptation (flag at review, decided at plan time)

The spec's decision 1 says the resend action lives in the admin per-user "⋯ menu" — **no such menu exists**: `AdminView.tsx` user rows use inline cells (name input, tier select, checkboxes, reset-password cell). The resend action goes into the actions area of the reset-password cell (Task 7), preserving the decision's intent (available on every supabase-linked row, no pending tracking, backend answers precisely).

## Verified code/platform facts (pinned during planning — trust these)

1. Installed `supabase_auth.errors.AuthWeakPasswordError`: subclass of `AuthError`, constructor `(message, status, reasons: List[str])`, instance attr `.reasons`. The library's live mapping path is `error_code == "weak_password"` → `AuthWeakPasswordError(..., data["weak_password"].get("reasons", {}))` — note the `{}` default: **`.reasons` may be a dict** when GoTrue omits reasons; the gateway mapping must coerce non-list to `[]`.
2. GoTrue weak-password rejection body (probed): 422, `error_code: "weak_password"`, `weak_password: {"reasons": ["length"|"characters"|"pwned"]}`.
3. GoTrue re-invites pending identities (200, same UUID, fresh mail, old link → 403 `otp_expired`); invite on a confirmed identity → 422 `email_exists`. `verify_otp` burns the link regardless of what happens afterwards.
4. amr shapes: password grant → `[{"method": "password", "timestamp": …}]`; invite/recovery `verify_otp` → `[{"method": "otp", …}]`; refresh inherits.
5. ES256 token-mint sites in tests that the new amr guard affects: `backend/tests/test_supabase_auth.py::mint` (base claims, line ~236) and `backend/tests/test_auth_supabase_api.py::_mint_oauth_token` (line ~525; deliberately-rejected token — rejection reason may change from provider to amr, assertions still hold). `test_auth_core.py`'s HS256 mints are local-mode, unaffected.
6. Existing verifier claim guards end at the `app_metadata.provider` check (`backend/app/core/supabase_auth.py:210-211`); the amr guard inserts directly after it.
7. `backend/tests_e2e/` password literals that violate `lower_upper_letters_digits` (no uppercase): `conftest.py:71` (`e2e-admin-password-{runid}`), `test_invite.py:16` (`e2e-invitee-password-{runid}`), `test_invite.py:44` (`irrelevant-long-password-123`), `test_password_change.py:21-22` (`e2e-old/new-password-{runid}`), `test_reset.py:20-21` (`e2e-reset-old/new-{runid}-x`), `test_boot_and_login.py:32` (`definitely-wrong-password-x` — a wrong-password probe, never set remotely, but sweep it anyway for uniformity).
8. Frontend plumbing that already exists: `authFeatures.invites` in the store (used by `AdminView.tsx:27-59` as `invitesAvailable`); `HttpError` with `status`/`code` from `{detail: {code}}` via `extractErrorCode` (`api/client.ts:73-88`); `ResetPasswordForm.tsx` owns the confirm form with `mapResetError`; `AccountMenu.tsx` has `mapChangeError`.
9. `AdminUserCreated` (`backend/app/api/admin.py:85-91`) carries `invited: bool = False`; the create route's invite branch is `admin.py:218-274`, with-password branch from `:276`; PATCH-password dispatch near `:444`.

## Global Constraints

- Default gate: `uv run pytest -q` from `backend/` green with ZERO warnings, Docker/network-free. Frontend gate: `npm test -- --run` green + `tsc -b --noEmit` + oxlint clean. Single-file pytest runs use `-n0`, never `-p no:xdist`.
- Secrets/keys/tokens never logged or echoed; the retry token never appears in log output (assert via caplog in the route tests).
- `require_admin` stays attached to the admin router; no new Settings/env knobs; no public self-signup in any configuration.
- New UI strings: informal register (Du/tu/tú/你) in all 7 locales (en de fr es it ja zh); code comments in English only (`register.test.ts` scans raw source).
- No `dangerouslySetInnerHTML`; no dynamic `href`/`src` from user content.
- Mutation-verify every guard test (delete guard → covering test fails → restore).
- Never widen a wall-clock test bound. E2e additions live in `backend/tests_e2e/` only.
- Commits: one per task, trailer lines exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01JXiCFTQQmJeJt3MB8qZdGA`

---

### Task 1: B30 — amr claim guard in the verifier

**Files:**
- Modify: `backend/app/core/supabase_auth.py` (insert after the provider guard, `:210-211`)
- Test: `backend/tests/test_supabase_auth.py` (extend `mint` base claims + `test_bad_claims_rejected` matrix + two accept cases)

**Interfaces:**
- Consumes: existing `SupabaseTokenVerifier.verify`, `InvalidToken`, the `mint`/`verifier_setup` rig.
- Produces: `verify()` additionally rejects any token whose `amr` is missing, empty, or contains a method outside `{"password", "otp"}`. Later tasks rely on retry tokens (otp-minted) passing.

- [ ] **Step 1: Extend the mint rig and write the failing tests**

In `backend/tests/test_supabase_auth.py`, add to `mint`'s base `claims` dict (after `"app_metadata": …`):

```python
        "amr": [{"method": "password", "timestamp": int(time.time())}],
```

Extend the `test_bad_claims_rejected` parametrize list with:

```python
            {"amr": [{"method": "oauth", "timestamp": 0}]},       # OAuth session on a linked identity
            {"amr": [{"method": "sso/saml", "timestamp": 0}]},
            {"amr": [{"method": "magiclink", "timestamp": 0}]},
            {"amr": [{"method": "password", "timestamp": 0}, {"method": "oauth", "timestamp": 0}]},  # mixed
            {"amr": []},              # empty list fails closed
            {"amr": None},            # claim absent entirely (mint drops None values)
            {"amr": [{"note": "no method key"}]},
```

Add two accept-path tests to `TestSupabaseTokenVerifier`:

```python
    def test_otp_session_accepted(self, verifier_setup):
        # B29 retry tokens and invite/recovery confirm sessions are otp-minted.
        private, store, verifier = verifier_setup
        user = store.create_user("a@example.com", None, external_id="uuid-1")
        verified = verifier.verify(
            mint(private, amr=[{"method": "otp", "timestamp": int(time.time())}])
        )
        assert verified.user_id == user.id

    def test_multi_entry_email_flow_amr_accepted(self, verifier_setup):
        # A refreshed session can carry several inherited entries.
        private, store, verifier = verifier_setup
        user = store.create_user("a@example.com", None, external_id="uuid-1")
        verified = verifier.verify(
            mint(
                private,
                amr=[
                    {"method": "otp", "timestamp": 0},
                    {"method": "password", "timestamp": 1},
                ],
            )
        )
        assert verified.user_id == user.id
```

- [ ] **Step 2: Run to verify the new reject cases fail**

Run: `uv run pytest tests/test_supabase_auth.py -n0 -q` (from `backend/`)
Expected: the seven new reject parametrizations FAIL (no `InvalidToken` raised — the guard doesn't exist); the two accept tests PASS (nothing rejects them yet); pre-existing tests PASS (base claims now carry a legit amr, which the current verifier ignores).

- [ ] **Step 3: Implement the guard**

In `backend/app/core/supabase_auth.py`, directly after the `provider is not email` raise (`:211`):

```python
        # B30 (#100): the guards above pin the IDENTITY's origin --
        # app_metadata.provider is the FIRST provider ever linked, not the
        # method that authenticated THIS session. amr is the per-session
        # claim: GoTrue mints [{"method": "password"|"otp", ...}] for every
        # flow this app produces (password grant; invite/recovery confirm)
        # and refresh inherits the entries. Anything else -- oauth,
        # sso/saml, magiclink, or a token without amr -- is a session no
        # flow of this app can mint: fail closed, closing the runtime
        # window the startup OAuth lockout cannot see (provider enabled at
        # the dashboard between restarts) and the linked-identity case.
        amr = claims.get("amr")
        if not isinstance(amr, list) or not amr:
            raise InvalidToken("token carries no amr")
        for entry in amr:
            method = entry.get("method") if isinstance(entry, dict) else None
            if method not in ("password", "otp"):
                raise InvalidToken("session method is not an email flow")
```

- [ ] **Step 4: Run the file, then check the other mint site**

Run: `uv run pytest tests/test_supabase_auth.py -n0 -q` → all PASS.
Then: `uv run pytest tests/test_auth_supabase_api.py -n0 -q` → expected PASS (fact 5: `_mint_oauth_token` tokens are rejection-path tokens; if any test there minted a token expected to VERIFY, add the same legit `amr` entry to its claims — check the failure output before changing anything).

- [ ] **Step 5: Mutation-verify the guard**

Delete the `amr` guard block → `test_bad_claims_rejected[amr…]` cases must FAIL → restore → PASS. Record in the report.

- [ ] **Step 6: Full default gate**

From `backend/`: `uv run pytest -q` → green, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add backend/app/core/supabase_auth.py backend/tests/test_supabase_auth.py
git commit -m "feat(auth): per-session amr guard in the supabase verifier (B30, #100)"
```

---

### Task 2: Gateway — weak-password error + verify_token_hash split

**Files:**
- Modify: `backend/app/services/supabase_gateway.py`
- Test: `backend/tests/test_supabase_gateway.py`

**Interfaces:**
- Consumes: existing `_execute` error ladder, `_user_client`, `_to_session`, `change_password`.
- Produces (Task 3+ rely on these):
  - `class SupabaseWeakPasswordError(SupabaseAuthError)` with `reasons: list[str]`.
  - `async def verify_token_hash(self, token_hash: str, type_: str) -> SupabaseSession` — the `verify_otp` half only, no password update.
  - `change_password` (unchanged signature) now raises `SupabaseWeakPasswordError` on GoTrue strength rejections.
  - `confirm_with_token_hash` REMAINS in this task (Task 3 deletes it with the route switch).

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_supabase_gateway.py` (follow the file's existing MockTransport pattern and real-UUID convention):

```python
GOTRUE_WEAK_PASSWORD_BODY = {
    "code": 422,
    "error_code": "weak_password",
    "msg": "Password should be at least 6 characters.",
    "weak_password": {"reasons": ["length"]},
}


def test_change_password_maps_weak_password_with_reasons(...):
    # MockTransport: PUT /auth/v1/admin/users/{id} -> 422 GOTRUE_WEAK_PASSWORD_BODY
    with pytest.raises(SupabaseWeakPasswordError) as exc_info:
        run(gateway.change_password("11111111-1111-4111-8111-111111111111", "abc"))
    assert exc_info.value.reasons == ["length"]
    assert isinstance(exc_info.value, SupabaseAuthError)  # callers catching the base still work


def test_weak_password_reasons_coerced_to_list_when_absent(...):
    # Same, but body omits weak_password.reasons entirely: the supabase-auth
    # library then passes {} as reasons (verified fact 1) -- gateway must
    # coerce to [].
    ...
    assert exc_info.value.reasons == []


def test_verify_token_hash_returns_session_without_touching_password(...):
    # MockTransport: POST /auth/v1/verify -> 200 session body (reuse the
    # file's existing session fixture body). Assert the returned
    # SupabaseSession fields AND that no admin/users request was made
    # (record requests in the transport handler; the old
    # confirm_with_token_hash issued a PUT -- this must not).
```

- [ ] **Step 2: Run to verify they fail**

`uv run pytest tests/test_supabase_gateway.py -n0 -q` — FAIL: `SupabaseWeakPasswordError`/`verify_token_hash` undefined.

- [ ] **Step 3: Implement**

In `supabase_gateway.py`: import `AuthWeakPasswordError` from `supabase_auth.errors` next to the existing error imports. Below `SupabaseAuthError`:

```python
class SupabaseWeakPasswordError(SupabaseAuthError):
    """GoTrue rejected a password on strength grounds (error_code
    weak_password): dashboard length/character rules or leaked-password
    detection. `reasons` carries GoTrue's vocabulary (length, characters,
    pwned) and may be empty when GoTrue omits it."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("password rejected as too weak")
        self.reasons = reasons
```

In `_execute`'s ladder, add BEFORE the general `(AuthError, ValueError)` catch (order matters — `AuthWeakPasswordError` is an `AuthError` subclass):

```python
        except AuthWeakPasswordError as exc:
            # fact 1: exc.reasons may be a dict ({}) when GoTrue omits
            # reasons -- coerce anything non-list.
            reasons = exc.reasons if isinstance(exc.reasons, list) else []
            raise SupabaseWeakPasswordError(reasons) from exc
```

Add the method (next to `confirm_with_token_hash`, which stays for now):

```python
    async def verify_token_hash(self, token_hash: str, type_: str) -> SupabaseSession:
        """The verify_otp half of confirmation only: burns the one-time
        link and returns the verified session. The password update is the
        caller's separate, retryable step (B29, #97)."""

        async def call() -> SupabaseSession:
            async with self._user_client() as client:
                response = await client.verify_otp(
                    {"token_hash": token_hash, "type": type_}
                )
            return _to_session(response.session)

        return await self._execute("verify_token_hash", call())
```

- [ ] **Step 4: Run to verify green**

`uv run pytest tests/test_supabase_gateway.py -n0 -q` → PASS. Then the full gate: `uv run pytest -q` → green, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/supabase_gateway.py backend/tests/test_supabase_gateway.py
git commit -m "feat(gateway): SupabaseWeakPasswordError + verify_token_hash split (B29, #97)"
```

---

### Task 3: B29 — verify-once-retry-many confirm route

**Files:**
- Modify: `backend/app/api/auth.py` (`ResetConfirm` model `:420-423`, `reset_confirm` route `:730-…`)
- Modify: `backend/app/services/supabase_gateway.py` (DELETE `confirm_with_token_hash`)
- Modify: `backend/tests/fakes_supabase.py` (`FakeSupabaseGateway`)
- Test: `backend/tests/test_auth_supabase_api.py`

**Interfaces:**
- Consumes: Task 2's `verify_token_hash`, `change_password`, `SupabaseWeakPasswordError`; Task 1's amr-guarded verifier.
- Produces: `POST /api/auth/reset-confirm` accepts `{token_hash, type, new_password}` OR `{retry_token, new_password}`; failure envelopes `422 {"code": "password_weak", "reasons": [...], "retry_token": "..."}` and `503 {"code": "update_failed", "retry_token": "..."}`; 204 + M2 eviction on success. Frontend (Task 6) consumes exactly these shapes.

- [ ] **Step 1: Update the fake gateway**

In `backend/tests/fakes_supabase.py`, `FakeSupabaseGateway`:
- Replace `confirm_with_token_hash` with `verify_token_hash(token_hash, type_)`: consumes the hash from `valid_token_hashes` (burn: remove on use; unknown/reused → raise `SupabaseAuthError`), returns the session it would have returned before, WITHOUT touching the password.
- `change_password(user_id, new_password)`: honor a new attribute `weak_password_reasons: list[str] | None = None` — when set, raise `SupabaseWeakPasswordError(self.weak_password_reasons)`; and a new `fail_change_password_once: bool = False` — when True, raise `SupabaseUnavailableError` once then reset the flag (transient-failure modeling). Keep recording successful password sets as before.
- Add `invite_calls: dict[str, int]` incremented by `invite_user` per email (Task 5's tests consume it).
- The fake verifier (`FakeSupabaseVerifier`) is claim-agnostic — no change.

- [ ] **Step 2: Write the failing route tests**

In `backend/tests/test_auth_supabase_api.py` (use the existing `_build_supabase_app` rig; new test class):

```python
class TestResetConfirmRetryFlow:
    def test_weak_password_returns_envelope_and_link_is_burned(self, ...):
        # register user + token_hash in the fake; set
        # gateway.weak_password_reasons = ["pwned"]
        r = client.post("/api/auth/reset-confirm", json={
            "token_hash": "TH", "type": "recovery", "new_password": "x" * 12})
        assert r.status_code == 422
        detail = r.json()["detail"]
        assert detail["code"] == "password_weak"
        assert detail["reasons"] == ["pwned"]
        retry_token = detail["retry_token"]
        assert retry_token  # a real session access token from the fake
        # the link is burned: replaying the token_hash leg now 422s
        r2 = client.post("/api/auth/reset-confirm", json={
            "token_hash": "TH", "type": "recovery", "new_password": "x" * 12})
        assert r2.status_code == 422
        assert r2.json()["detail"]["code"] == "invalid_or_expired_link"

    def test_retry_leg_succeeds_and_evicts(self, ...):
        # weak first attempt -> envelope; clear weak_password_reasons;
        # retry with {"retry_token": ..., "new_password": ...} -> 204;
        # assert password set at the fake, mark_password_changed bumped
        # (token_epoch/password_changed_at on the row), global_sign_out
        # recorded -- mirror the file's existing eviction assertions.

    def test_retry_leg_weak_again_returns_envelope_again(self, ...):
        # keep weak_password_reasons set; retry leg -> 422 password_weak
        # with a retry_token again (same token acceptable).

    def test_transient_update_failure_returns_503_envelope(self, ...):
        # fail_change_password_once = True; link leg -> 503, detail code
        # "update_failed", retry_token present; then retry leg -> 204.

    def test_both_legs_in_one_body_rejected(self, ...):
        # token_hash+type+retry_token together -> 422 (pydantic validation)

    def test_neither_leg_rejected(self, ...):
        # only new_password -> 422

    def test_partial_link_leg_rejected(self, ...):
        # token_hash without type -> 422

    def test_no_branch_ever_returns_a_session(self, ...):
        # for each branch exercised above, assert the response body never
        # contains a "token" or "refresh_token" key (the retry token rides
        # only inside detail on failure envelopes; 204s have no body).

    def test_retry_token_never_logged(self, caplog, ...):
        # run the weak + retry flow under caplog at WARNING; assert the
        # retry token value appears in no log record.

    def test_garbage_retry_token_rejected(self, ...):
        # {"retry_token": "not-a-jwt", "new_password": "x"*12} -> 422
        # invalid_or_expired_link (fake verifier rejects unknown tokens).
```

Also update the existing confirm-flow tests that stub `confirm_with_token_hash` to the new fake surface (`verify_token_hash` + recorded `change_password`) — behavior-equivalent, assertions unchanged.

- [ ] **Step 3: Run to verify the new tests fail**

`uv run pytest tests/test_auth_supabase_api.py -n0 -q` — new tests FAIL (route still single-leg).

- [ ] **Step 4: Implement the route**

In `backend/app/api/auth.py` — replace `ResetConfirm` (`:420-423`):

```python
class ResetConfirm(BaseModel):
    """Either the one-time link leg (token_hash + type) or the retry leg
    (retry_token from a previous failure envelope). Exactly one."""

    token_hash: str | None = Field(default=None, max_length=1024)
    type: Literal["recovery", "invite"] | None = None
    retry_token: str | None = Field(default=None, max_length=8192)
    new_password: str

    @model_validator(mode="after")
    def _exactly_one_leg(self) -> "ResetConfirm":
        has_link_part = self.token_hash is not None or self.type is not None
        complete_link = self.token_hash is not None and self.type is not None
        has_retry = self.retry_token is not None
        if has_retry == has_link_part or (has_link_part and not complete_link):
            raise ValueError("provide either token_hash+type or retry_token")
        return self
```

(`model_validator` import already exists in the file's pydantic imports — verify; add if absent.)

Two helpers above the route:

```python
async def _update_password_or_retry_envelope(
    app, supabase_user_id: str, new_password: str, retry_token: str
) -> None:
    """The retryable update leg. The caller holds a session whose identity
    is already confirmed; ANY failure here must hand back a retry token --
    the one-time link is spent, so retrying is the only useful direction
    (spec §2; PR #95 round 8 for the transient case)."""
    try:
        await app.state.supabase_gateway.change_password(
            supabase_user_id, new_password
        )
    except SupabaseWeakPasswordError as exc:
        raise HTTPException(
            422,
            {
                "code": "password_weak",
                "reasons": exc.reasons,
                "retry_token": retry_token,
            },
        ) from None
    except (SupabaseAuthError, SupabaseUnavailableError):
        raise HTTPException(
            503, {"code": "update_failed", "retry_token": retry_token}
        ) from None


async def _finish_confirmed_rotation(app, store, local_id: int, access_token: str) -> None:
    """M2 eviction after a completed remote rotation: unchanged ordering
    from B14 -- mark (backdated) locally, then best-effort global
    sign-out. Also kills the retry token for API-auth purposes (its iat
    predates the mark's backdated cutoff)."""
    store.mark_password_changed(local_id)
    try:
        await app.state.supabase_gateway.global_sign_out(access_token)
    except (SupabaseAuthError, SupabaseUnavailableError):
        logger.warning(
            "supabase global_sign_out unavailable after reset-confirm"
            " eviction for user %s",
            local_id,
        )
```

Replace the `reset_confirm` route body: keep `_require_supabase_mode` + the existing password pre-validation block verbatim, then:

```python
    gateway = app.state.supabase_gateway
    store = app.state.user_store

    if body.retry_token is not None:
        # RETRY LEG: full claim guards (incl. amr) + normal JIT semantics.
        # Materializing a row on a retry that fails again is harmless --
        # it mirrors an identity verify_otp already confirmed.
        try:
            verified = await run_in_threadpool(
                app.state.token_verifier.verify, body.retry_token
            )
        except InvalidToken:
            raise HTTPException(422, {"code": "invalid_or_expired_link"}) from None
        user = store.get_user(verified.user_id)
        if user is None or not user.is_active or user.external_id is None:
            raise HTTPException(422, {"code": "invalid_or_expired_link"})
        await _update_password_or_retry_envelope(
            app, user.external_id, body.new_password, body.retry_token
        )
        await _finish_confirmed_rotation(app, store, user.id, body.retry_token)
        return Response(status_code=204)

    # LINK LEG: verify_otp burns the link; every failure AFTER a
    # successful verify returns a retry envelope instead of stranding a
    # confirmed identity behind a dead link.
    try:
        session = await gateway.verify_token_hash(body.token_hash, body.type)
    except SupabaseAuthError:
        raise HTTPException(422, {"code": "invalid_or_expired_link"}) from None
    except SupabaseUnavailableError:
        raise HTTPException(503, "Authentication service unavailable") from None
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
    try:
        verified = await run_in_threadpool(
            app.state.token_verifier.verify, session.access_token
        )
    except InvalidToken:
        raise HTTPException(422, {"code": "invalid_or_expired_link"}) from None
    user = store.get_user(verified.user_id)
    if user is None or not user.is_active:
        raise HTTPException(422, {"code": "invalid_or_expired_link"})
    return Response(status_code=204)
```

Preserve the original route's explanatory comments where they still apply (eviction rationale, JIT-materialization note) — they are load-bearing documentation; adapt, don't discard. Import `SupabaseWeakPasswordError` next to the existing gateway-error imports. Delete `confirm_with_token_hash` from `supabase_gateway.py`.

- [ ] **Step 5: Run to green**

`uv run pytest tests/test_auth_supabase_api.py tests/test_supabase_gateway.py -n0 -q` → PASS. Full gate: `uv run pytest -q` → green, zero warnings.

- [ ] **Step 6: Mutation-verify**

Delete the `_finish_confirmed_rotation` call on the retry leg → `test_retry_leg_succeeds_and_evicts` must FAIL → restore → PASS. Record in the report.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/auth.py backend/app/services/supabase_gateway.py backend/tests/fakes_supabase.py backend/tests/test_auth_supabase_api.py
git commit -m "feat(auth): verify-once-retry-many reset/invite confirm (B29, #97)"
```

---

### Task 4: B31 — EmailLocks

**Files:**
- Create: `backend/app/core/email_locks.py`
- Modify: `backend/app/main.py` (construct `app.state.email_locks` unconditionally, next to the throttle constructions)
- Test: `backend/tests/test_email_locks.py`

**Interfaces:**
- Consumes: nothing project-specific.
- Produces: `class EmailLocks` with `acquire(email: str)` async context manager; `app.state.email_locks`. Task 5 wraps admin create/resend in it.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_email_locks.py`:

```python
"""EmailLocks (B31, #101): per-email serialization for admin user flows."""

import asyncio

import pytest

from app.core.email_locks import _ENTRY_TTL_SECONDS, _MAX_ENTRIES, EmailLocks


async def test_same_email_serializes():
    locks = EmailLocks()
    order: list[str] = []

    async def worker(tag: str, hold: float) -> None:
        async with locks.acquire("User@Example.com" if tag == "a" else "user@example.com"):
            order.append(f"{tag}-in")
            await asyncio.sleep(hold)
            order.append(f"{tag}-out")

    await asyncio.gather(worker("a", 0.05), worker("b", 0))
    # normalization makes these the SAME lock: no interleaving possible
    assert order == ["a-in", "a-out", "b-in", "b-out"]


async def test_different_emails_do_not_serialize():
    locks = EmailLocks()
    started = asyncio.Event()
    release = asyncio.Event()

    async def holder() -> None:
        async with locks.acquire("a@example.com"):
            started.set()
            await release.wait()

    async def other() -> None:
        await started.wait()
        async with locks.acquire("b@example.com"):
            release.set()  # only reachable if b's lock is independent

    await asyncio.wait_for(asyncio.gather(holder(), other()), timeout=2)


async def test_lock_released_on_exception():
    locks = EmailLocks()
    with pytest.raises(RuntimeError):
        async with locks.acquire("a@example.com"):
            raise RuntimeError("boom")
    async with locks.acquire("a@example.com"):  # must not deadlock
        pass


async def test_expired_unheld_entries_are_pruned(monkeypatch):
    locks = EmailLocks()
    async with locks.acquire("old@example.com"):
        pass
    # age the entry past TTL, then touch another email to trigger pruning
    key = "old@example.com"
    lock, ts = locks._locks[key]
    locks._locks[key] = (lock, ts - _ENTRY_TTL_SECONDS - 1)
    async with locks.acquire("new@example.com"):
        pass
    assert key not in locks._locks


async def test_cap_never_evicts_a_held_lock():
    locks = EmailLocks()
    async with locks.acquire("held@example.com"):
        for i in range(_MAX_ENTRIES + 5):
            async with locks.acquire(f"u{i}@example.com"):
                pass
        assert "held@example.com" in locks._locks
```

(`asyncio_mode = "auto"` is set in pyproject — plain async tests work.)

- [ ] **Step 2: Run to verify failure**

`uv run pytest tests/test_email_locks.py -n0 -q` — FAIL (module missing).

- [ ] **Step 3: Implement**

`backend/app/core/email_locks.py`:

```python
"""Per-email asyncio locks serializing admin user-creation flows (B31, #101).

Two concurrent admin requests for the SAME email can interleave the
pre-check -> remote create/reconcile (+credential rotation) -> local link
sequence so that one request's 201 reports a password the other request
has already rotated away. Serializing per normalized email removes the
race. Single-process deployment assumption, exactly like LoginThrottle's;
multi-process coordination is explicitly out of scope (spec §4).

Bounded-map hygiene mirrors the throttle: entries expire after
_ENTRY_TTL_SECONDS and the table is capped at _MAX_ENTRIES -- but a HELD
lock is never evicted, because losing it would let a concurrent request
run unserialized (correctness beats the cap; held locks are bounded by
in-flight requests anyway).
"""

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

_ENTRY_TTL_SECONDS = 900.0
_MAX_ENTRIES = 1024


class EmailLocks:
    def __init__(self) -> None:
        self._locks: dict[str, tuple[asyncio.Lock, float]] = {}

    def _prune(self, now: float) -> None:
        expired = [
            key
            for key, (lock, touched) in self._locks.items()
            if now - touched > _ENTRY_TTL_SECONDS and not lock.locked()
        ]
        for key in expired:
            del self._locks[key]
        if len(self._locks) > _MAX_ENTRIES:
            for key, (lock, _touched) in sorted(
                self._locks.items(), key=lambda item: item[1][1]
            ):
                if len(self._locks) <= _MAX_ENTRIES:
                    break
                if not lock.locked():
                    del self._locks[key]

    @asynccontextmanager
    async def acquire(self, email: str) -> AsyncIterator[None]:
        key = email.strip().lower()
        now = time.monotonic()
        self._prune(now)
        entry = self._locks.get(key)
        lock = entry[0] if entry is not None else asyncio.Lock()
        self._locks[key] = (lock, now)
        async with lock:
            yield
```

In `backend/app/main.py`, next to the existing throttle constructions (`reset_throttle` etc.), add unconditionally (used only by supabase paths, but constructing it always keeps admin.py free of None-checks):

```python
    app.state.email_locks = EmailLocks()
```

with the import alongside the other `app.core` imports.

- [ ] **Step 4: Run to green + gate**

`uv run pytest tests/test_email_locks.py -n0 -q` → PASS. `uv run pytest -q` → green, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add backend/app/core/email_locks.py backend/app/main.py backend/tests/test_email_locks.py
git commit -m "feat(core): bounded per-email lock table (B31, #101)"
```

---

### Task 5: B28 — resend endpoint, invite_emailed, locks applied

**Files:**
- Modify: `backend/app/api/admin.py` (resend route; `AdminUserCreated`; lock around both supabase create branches)
- Test: `backend/tests/test_auth_supabase_api.py` (or the admin-api test module the existing supabase admin-create tests live in — follow the file that already tests the invite/reconciliation paths)

**Interfaces:**
- Consumes: Task 4's `app.state.email_locks`; the fake's `invite_calls` counter (Task 3); GoTrue facts 3 (re-invite semantics).
- Produces: `POST /api/admin/users/{user_id}/resend-invite` → 204 | 422 `{"code": "already_active"}` | 422 `{"code": "not_linked"}` | 404 (local mode / unknown id) | 503; `AdminUserCreated.invite_emailed: bool`. Frontend Task 7 consumes both.

- [ ] **Step 1: Write the failing tests**

In the module holding the existing supabase admin-create tests:

```python
class TestResendInvite:
    def test_pending_invitee_resend_204_and_audited(self, ...):
        # create via invite path -> row with external_id; resend:
        r = client.post(f"/api/admin/users/{row_id}/resend-invite", headers=admin)
        assert r.status_code == 204
        assert gateway.invite_calls[email] == 2  # original + resend
        # audit row recorded with field == "invite_resend"

    def test_confirmed_identity_maps_to_already_active(self, ...):
        # fake: invite_user raises SupabaseAuthError for this email
        # (model GoTrue's email_exists on confirmed identities)
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "already_active"

    def test_unlinked_row_rejected(self, ...):
        # local-created row (external_id None) -> 422 not_linked

    def test_local_mode_404(self, ...):
        # plain local-mode app: route -> 404

    def test_unknown_user_404(self, ...):

    def test_non_admin_403(self, ...):
        # second non-admin user's bearer -> 403 (require_admin)

    def test_gateway_down_503(self, ...):


class TestWeakPasswordSurfacesInAdminRoutes:
    def test_patch_password_weak_returns_reasons_envelope(self, ...):
        # fake: weak_password_reasons = ["length"]; admin PATCH
        # {"password": ...} on a linked user -> 422, detail
        # {"code": "password_weak", "reasons": ["length"]} (no retry_token:
        # the admin just resubmits the form; nothing is burned).

    def test_create_with_password_weak_returns_reasons_envelope(self, ...):
        # fake weak on create-with-password's rotation/create leg -> 422
        # {"code": "password_weak", "reasons": [...]}; no local row created.


class TestInviteEmailedFlag:
    def test_fresh_invite_reports_emailed(self, ...):
        # normal invite create -> 201, invited True, invite_emailed True

    def test_reconciliation_reports_no_email(self, ...):
        # fake set up so invite_user raises duplicate and
        # get_user_by_email returns invite_pending=True (the existing
        # reconciliation test rig) -> 201, invited True, invite_emailed False

    def test_local_mode_create_defaults_false(self, ...):
        # local create-with-password -> invited False, invite_emailed False


class TestEmailLockSerialization:
    async def test_concurrent_same_email_creates_serialize(self, ...):
        # Deterministic interleave: fake gateway's invite_user blocks on an
        # asyncio.Event for the FIRST caller. Fire two concurrent create
        # requests (httpx.AsyncClient against the app, or asyncio.gather on
        # the route coroutine per the file's existing async patterns).
        # Assert: the second request does NOT reach the gateway before the
        # first completes (record call order in the fake), and exactly one
        # 201 + one 422 duplicate_email results.
```

- [ ] **Step 2: Run to verify failure**

Targeted file with `-n0 -q` — FAIL (route/field missing).

- [ ] **Step 3: Implement**

`AdminUserCreated` gains:

```python
    # Like `invited`: an event of THIS call. True only when this request
    # caused a fresh invitation email; the reconciliation path links a
    # stale pending identity WITHOUT sending mail (B28, #96) and must not
    # imply otherwise.
    invite_emailed: bool = False
```

Invite branch: set `invite_emailed=True` on the fresh-`invite_user` path; on the reconciliation path (`existing_identity.invite_pending` accepted) leave it `False`. Return `AdminUserCreated(**user.model_dump(), invited=True, invite_emailed=fresh)` where `fresh` is a local bool.

In the supabase PATCH-password dispatch (`admin.py` ~`:444`) and the create-with-password branch: catch `SupabaseWeakPasswordError` BEFORE the generic `SupabaseAuthError` handling and raise `HTTPException(422, {"code": "password_weak", "reasons": exc.reasons})` — no retry token (nothing is burned; the admin resubmits). Import it next to the other gateway-error imports.

Wrap BOTH supabase create branches (invite and with-password — from the `existing = store.get_by_email(...)` pre-check through the local insert/adopt and audit) in:

```python
        async with request.app.state.email_locks.acquire(body.email):
```

(the local-mode branch stays outside the lock).

Resend route (after the create route):

```python
@router.post("/users/{user_id}/resend-invite", status_code=204)
async def resend_invite(
    request: Request, user_id: int, actor: CurrentUser = Depends(require_admin)
) -> Response:
    """Re-issue a pending invitation (B28, #96). GoTrue is the pending-state
    authority: re-inviting a pending identity re-sends and invalidates the
    old link; a confirmed identity is rejected with email_exists, which
    maps to already_active here -- no local pending tracking."""
    if request.app.state.settings.auth.mode != "supabase":
        raise HTTPException(404, "Not found")
    store = _store(request)
    user = store.get_user(user_id)
    if user is None:
        raise HTTPException(404, "Not found")
    if user.external_id is None:
        raise HTTPException(422, {"code": "not_linked"})
    gateway = request.app.state.supabase_gateway
    async with request.app.state.email_locks.acquire(user.email):
        try:
            await gateway.invite_user(user.email)
        except SupabaseAuthError as exc:
            raise HTTPException(422, {"code": "already_active"}) from exc
        except SupabaseUnavailableError as exc:
            raise HTTPException(503, "Authentication service unavailable") from exc
    store.record_audit(
        actor_id=actor.id,
        target_id=user.id,
        field="invite_resend",
        new_value=user.email,
    )
    return Response(status_code=204)
```

- [ ] **Step 4: Run to green + gate + mutation**

Targeted files `-n0 -q` → PASS; full gate green, zero warnings. Mutation-verify the lock: remove the `async with … email_locks.acquire(...)` from the create path → `test_concurrent_same_email_creates_serialize` must FAIL → restore → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/admin.py backend/tests/
git commit -m "feat(admin): invite resend + invite_emailed honesty + per-email locks (B28 B31, #96 #101)"
```

---

### Task 6: Frontend — client plumbing + retrying reset form + i18n

**Files:**
- Modify: `frontend/src/api/client.ts` (`HttpError`, `extractErrorCode` → detail extraction, `postResetRetry`, `postResendInvite`)
- Create: `frontend/src/auth/weakPassword.ts` (shared reason→message mapper)
- Modify: `frontend/src/auth/ResetPasswordForm.tsx`
- Modify: `frontend/src/i18n/messages.ts` + all 7 locale files
- Test: `frontend/src/auth/ResetPasswordForm.test.tsx`, `frontend/src/i18n/i18n.test.ts` (key parity is automatic)

**Interfaces:**
- Consumes: Task 3's envelope shapes.
- Produces: `HttpError` gains `readonly retryToken?: string` and `readonly reasons?: string[]`; `postResetRetry(retryToken: string, newPassword: string): Promise<void>`; `postResendInvite(id: number): Promise<void>`; `mapWeakPasswordReasons(reasons: string[] | undefined, m: Messages): string`; new message keys (below). Task 7 reuses the mapper and `postResendInvite`.

- [ ] **Step 1: Write the failing tests**

`ResetPasswordForm.test.tsx` additions (follow the file's existing render/mocking style):

```
- password_weak (reasons ["pwned"]) response: form STAYS mounted, error
  shows m.pwWeakPwned, and the NEXT submit calls postResetRetry with the
  envelope's retry_token and the new password (postResetConfirm NOT
  called a second time).
- update_failed 503 envelope: error shows m.resetUpdateFailedRetry; next
  submit uses postResetRetry.
- retry that fails weak again (reasons ["characters"]): stays in retry
  mode, shows m.pwWeakCharacters.
- retry that returns 422 invalid_or_expired_link: shows m.resetLinkInvalid
  (dead end, request a new link).
- reasons priority when several present: pwned > characters > length >
  generic (assert with reasons ["length","pwned"] -> m.pwWeakPwned).
- success on retry: same success panel as the link leg.
```

- [ ] **Step 2: Run to verify failure**

`npm test -- --run src/auth/ResetPasswordForm.test.tsx` — FAIL (new keys/functions missing).

- [ ] **Step 3: Implement client.ts**

Extend the error extraction (replacing `extractErrorCode`'s single-value return):

```ts
interface ErrorDetail {
  code?: string
  retryToken?: string
  reasons?: string[]
}

async function extractErrorDetail(response: Response): Promise<ErrorDetail> {
  try {
    const body: unknown = JSON.parse(await response.text())
    const detail = (body as { detail?: unknown } | null)?.detail
    if (detail === null || typeof detail !== 'object') return {}
    const d = detail as { code?: unknown; retry_token?: unknown; reasons?: unknown }
    return {
      code: typeof d.code === 'string' ? d.code : undefined,
      retryToken: typeof d.retry_token === 'string' ? d.retry_token : undefined,
      reasons: Array.isArray(d.reasons)
        ? d.reasons.filter((r): r is string => typeof r === 'string')
        : undefined,
    }
  } catch {
    return {}
  }
}
```

`HttpError` gains the two readonly fields (constructor takes the `ErrorDetail`); the `request()` throw site passes the full detail. Existing `err.code` consumers are untouched.

New API functions next to `postResetConfirm` (same `keepSessionOn401` treatment):

```ts
export const postResetRetry = (retryToken: string, newPassword: string) =>
  requestWithOptions<void>('/api/auth/reset-confirm', {
    method: 'POST',
    body: JSON.stringify({ retry_token: retryToken, new_password: newPassword }),
  }, { keepSessionOn401: true })

export const postResendInvite = (id: number) =>
  request<void>(`/api/admin/users/${id}/resend-invite`, { method: 'POST' })
```

(match `postResetConfirm`'s actual invocation shape — headers/body handling — verbatim.)

- [ ] **Step 4: Implement the mapper + form**

`frontend/src/auth/weakPassword.ts`:

```ts
import type { Messages } from '../i18n'

// GoTrue's weak_password reason vocabulary. Priority: the most actionable
// message wins when several reasons arrive -- a breached password must be
// said out loud even if it is also too short.
export function mapWeakPasswordReasons(reasons: string[] | undefined, m: Messages): string {
  if (reasons?.includes('pwned')) return m.pwWeakPwned
  if (reasons?.includes('characters')) return m.pwWeakCharacters
  if (reasons?.includes('length')) return m.pwWeakLength
  return m.pwWeakGeneric
}
```

`ResetPasswordForm.tsx`: add `const [retryToken, setRetryToken] = useState<string | null>(null)`. In `mapResetError`, before the existing checks:

```ts
    if (err.code === 'password_weak') return mapWeakPasswordReasons(err.reasons, m)
    if (err.code === 'update_failed') return m.resetUpdateFailedRetry
```

In `handleSubmit`, capture the retry token and route the call:

```ts
    const call = retryToken
      ? postResetRetry(retryToken, password)
      : postResetConfirm(tokenHash, type, password)
    call
      .then(() => setSuccess(true))
      .catch((err: unknown) => {
        if (err instanceof HttpError && err.retryToken) setRetryToken(err.retryToken)
        setError(mapResetError(err, m))
      })
      .finally(() => setPending(false))
```

- [ ] **Step 5: Add the i18n keys**

`messages.ts` interface + all 7 locales (informal register; en+de below verbatim, fr/es/it/ja/zh translated to match — `i18n.test.ts` enforces key parity, `register.test.ts` the register):

```ts
// en
pwWeakLength: 'This password is too short for the security rules — pick a longer one.',
pwWeakCharacters: 'Mix upper- and lowercase letters and digits to make this password stronger.',
pwWeakPwned: 'This password appears in known data breaches — please pick a different one.',
pwWeakGeneric: 'This password is too weak — pick a stronger one.',
resetUpdateFailedRetry: "Saving didn't work yet — please try again.",
// de
pwWeakLength: 'Dieses Passwort ist für die Sicherheitsregeln zu kurz — wähle ein längeres.',
pwWeakCharacters: 'Mische Groß- und Kleinbuchstaben und Ziffern, um das Passwort stärker zu machen.',
pwWeakPwned: 'Dieses Passwort taucht in bekannten Datenlecks auf — bitte wähle ein anderes.',
pwWeakGeneric: 'Dieses Passwort ist zu schwach — wähle ein stärkeres.',
resetUpdateFailedRetry: 'Das Speichern hat noch nicht geklappt — versuch es bitte erneut.',
```

(The three admin keys land in Task 7 with their consumers.)

- [ ] **Step 6: Run the frontend gates**

`npm test -- --run` → green; `npx tsc -b --noEmit` → clean; oxlint clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/auth/ frontend/src/i18n/
git commit -m "feat(frontend): retrying reset form + weak-password reasons (B29, #97)"
```

---

### Task 7: Frontend — AccountMenu reasons + AdminView resend/invite_emailed

**Files:**
- Modify: `frontend/src/auth/AccountMenu.tsx` (`mapChangeError`)
- Modify: `frontend/src/admin/AdminView.tsx` (resend button in the reset cell; create-flow copy)
- Modify: `frontend/src/i18n/messages.ts` + 7 locales (four keys)
- Test: `frontend/src/auth/AccountMenu.test.tsx`, `frontend/src/admin/AdminView.test.tsx` (follow existing patterns)

**Interfaces:**
- Consumes: Task 6's `mapWeakPasswordReasons`, `postResendInvite`, `HttpError.reasons`; Task 5's endpoint + `invite_emailed`.
- Produces: user-visible resend + honest weak-password/create messaging.

- [ ] **Step 1: Write the failing tests**

```
AccountMenu: a password change rejected with code password_weak and
  reasons ["pwned"] shows m.pwWeakPwned (not the generic
  passwordChangeFailed).
AdminView: with authFeatures.invites=true, every non-self user row shows
  the m.adminResendInvite button; clicking it calls postResendInvite(id)
  and surfaces m.adminResendSent on 204; a 422 already_active response
  surfaces m.adminResendAlreadyActive; with invites=false (local mode)
  the button is absent.
AdminView create: a 201 with invited=true, invite_emailed=false shows
  m.adminInviteLinkedNoEmail; invited=true + invite_emailed=true keeps
  the existing invite-success message.
AdminView PATCH password / create-with-password rejected with
  password_weak + reasons: the fail banner shows the mapped reason
  message (wire mapWeakPasswordReasons into AdminView's error mapping
  the same way AccountMenu does).
```

- [ ] **Step 2: Run to verify failure, then implement**

`AccountMenu.tsx` `mapChangeError` — before its fallback:

```ts
    if (err.code === 'password_weak') return mapWeakPasswordReasons(err.reasons, m)
```

`AdminView.tsx`:
- `UserRow` gains props it needs (`invitesAvailable`, an `onResend(user): Promise<void>` handler owned by the parent, following the `onSave` pattern with the same banner/`run()` machinery). In the reset cell (`admin-reset`), for non-self rows when `invitesAvailable`, render after the reset button:

```tsx
            <button
              className="admin-resend"
              disabled={resendPending}
              onClick={() => void resendInvite()}
            >
              {m.adminResendInvite}
            </button>
```

with a `resendPending` state mirroring `resetPending`'s double-click guard, and `resendInvite()` calling the parent handler; the parent maps success → `m.adminResendSent` via the existing ok-banner mechanism and `HttpError.code === 'already_active'` → `m.adminResendAlreadyActive` via the fail banner.
- Create flow: where the current code surfaces the invite success message, branch on `response.invite_emailed === false` → `m.adminInviteLinkedNoEmail`. Update the `postAdminUser` return type in `client.ts` to `AdminUser & { invited?: boolean; invite_emailed?: boolean }`.

- [ ] **Step 3: Add the four i18n keys (7 locales; en+de verbatim)**

```ts
// en
adminResendInvite: 'Resend invitation',
adminResendSent: 'Invitation sent again.',
adminResendAlreadyActive: 'This account is already active — no invitation needed.',
adminInviteLinkedNoEmail: 'Linked an existing pending invitation — no new email was sent. Use "Resend invitation" for a fresh link.',
// de
adminResendInvite: 'Einladung erneut senden',
adminResendSent: 'Einladung erneut gesendet.',
adminResendAlreadyActive: 'Dieses Konto ist bereits aktiv — keine Einladung nötig.',
adminInviteLinkedNoEmail: 'Bestehende offene Einladung verknüpft — es wurde keine neue E-Mail gesendet. Nutze „Einladung erneut senden" für einen frischen Link.',
```

- [ ] **Step 4: Run the frontend gates**

`npm test -- --run` → green; `npx tsc -b --noEmit` → clean; oxlint clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/auth/AccountMenu.tsx frontend/src/admin/ frontend/src/api/client.ts frontend/src/i18n/ frontend/src/auth/AccountMenu.test.tsx
git commit -m "feat(frontend): admin invite resend + honest weak-password copy (B28, #96)"
```

---

### Task 8: E2E — resilience flows on the B27 stack

**Files:**
- Modify: `supabase/config.toml` (`[auth.email]` gains `password_requirements`)
- Modify: `backend/tests_e2e/conftest.py`, `test_invite.py`, `test_password_change.py`, `test_reset.py`, `test_boot_and_login.py` (password sweep + amr assert)
- Create: `backend/tests_e2e/test_resilience.py`

**Interfaces:**
- Consumes: everything above, live; the B27 harness fixtures (`app_url`, `admin_creds`, `runid`, `mailpit`) and helpers.
- Produces: live regression coverage for resend + retry flows.

- [ ] **Step 1: Config + password sweep**

In `supabase/config.toml` `[auth.email]`, under `enable_signup = true`:

```toml
# Deliberate deviation from the hosted default ("" = none): a strength
# rule GoTrue enforces but the app's own >=8 pre-validation does not lets
# the e2e suite reach the real weak_password rejection and exercise the
# B29 retry leg -- exactly the class of GoTrue-side setting B29 makes
# safe to enable. All e2e passwords must therefore mix upper- and
# lowercase letters and digits.
password_requirements = "lower_upper_letters_digits"
```

Sweep the password literals (fact 7) to compliant values, keeping their runid suffixes (runid supplies digits; add an uppercase letter):

- `conftest.py:71` → `f"E2e-Admin-Password-{runid}"`
- `test_invite.py:16` → `f"E2e-Invitee-Password-{runid}"`
- `test_invite.py:44` → `"Irrelevant-Long-Password-123"`
- `test_password_change.py:21-22` → `f"E2e-Old-Password-{runid}"` / `f"E2e-New-Password-{runid}"`
- `test_reset.py:20-21` → `f"E2e-Reset-Old-{runid}-1x"` / `f"E2e-Reset-New-{runid}-1x"`
- `test_boot_and_login.py:32` → `"Definitely-Wrong-Password-1x"`

- [ ] **Step 2: amr assert**

In `test_boot_and_login.py::test_session_token_is_es256_with_kid`, after the header asserts:

```python
    payload = jwt.decode(session["token"], options={"verify_signature": False})
    assert payload["amr"], "GoTrue stopped minting amr — the B30 guard would reject everything"
    assert all(entry["method"] in ("password", "otp") for entry in payload["amr"])
```

- [ ] **Step 3: Write `test_resilience.py`**

```python
"""B28+B29 flows against the live stack: invite resend and the
verify-once-retry-many weak-password recovery.

The weak_password rejection is reachable because supabase/config.toml sets
password_requirements = "lower_upper_letters_digits": an all-lowercase
>=8-char password passes the app's own pre-validation but fails GoTrue.
"""

import httpx

from .helpers import TIMEOUT, admin_create_user, bearer, login


def test_invite_resend_end_to_end(app_url, admin_creds, runid, mailpit):
    email = f"resendee-{runid}@e2e.local"
    password = f"E2e-Resendee-Password-{runid}"

    admin = login(app_url, *admin_creds)
    created = admin_create_user(app_url, admin["token"], email)
    assert created["invited"] is True
    assert created["invite_emailed"] is True

    first_mail = mailpit.wait_for_message(email)
    old_hash, _ = mailpit.extract_token(first_mail["HTML"])

    resend = httpx.post(
        f"{app_url}/api/admin/users/{created['id']}/resend-invite",
        headers=bearer(admin["token"]),
        timeout=TIMEOUT,
    )
    assert resend.status_code == 204

    second_mail = mailpit.wait_for_message(email, min_count=2)
    new_hash, link_type = mailpit.extract_token(second_mail["HTML"])
    assert link_type == "invite" and new_hash != old_hash

    # the resend invalidated the first link (GoTrue rotates the token)
    burned = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": old_hash, "type": "invite", "new_password": password},
        timeout=TIMEOUT,
    )
    assert burned.status_code == 422
    assert burned.json()["detail"]["code"] == "invalid_or_expired_link"

    fresh = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": new_hash, "type": "invite", "new_password": password},
        timeout=TIMEOUT,
    )
    assert fresh.status_code == 204
    assert login(app_url, email, password)["user"]["email"] == email

    # resend for the now-active account is answered honestly
    again = httpx.post(
        f"{app_url}/api/admin/users/{created['id']}/resend-invite",
        headers=bearer(admin["token"]),
        timeout=TIMEOUT,
    )
    assert again.status_code == 422
    assert again.json()["detail"]["code"] == "already_active"


def test_weak_password_retry_end_to_end(app_url, admin_creds, runid, mailpit):
    email = f"weakling-{runid}@e2e.local"
    weak = f"weakpassword{runid}"          # >=8, all lowercase+digits: app passes, GoTrue rejects
    strong = f"E2e-Strong-Password-{runid}"

    admin = login(app_url, *admin_creds)
    admin_create_user(app_url, admin["token"], email)
    message = mailpit.wait_for_message(email)
    token_hash, _ = mailpit.extract_token(message["HTML"])

    rejected = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": token_hash, "type": "invite", "new_password": weak},
        timeout=TIMEOUT,
    )
    assert rejected.status_code == 422
    detail = rejected.json()["detail"]
    assert detail["code"] == "password_weak"
    assert "characters" in detail["reasons"]
    retry_token = detail["retry_token"]

    # the link is burned -- but the retry token carries the flow forward
    retried = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"retry_token": retry_token, "new_password": strong},
        timeout=TIMEOUT,
    )
    assert retried.status_code == 204
    assert login(app_url, email, strong)["user"]["email"] == email
```

`Mailpit.wait_for_message` needs the `min_count: int = 1` parameter (extend `mailpit.py`: wait until `len(messages) >= min_count`, return `messages[0]` — newest first, as probed).

- [ ] **Step 4: Run live**

`scripts/e2e-supabase.sh --down` then `scripts/e2e-supabase.sh` (config changed → cold start required). Expected: all previous tests + 2 new + the extended claims test = 15 passing. Then `scripts/e2e-supabase.sh --down`.

- [ ] **Step 5: Default gate**

From `backend/`: `uv run pytest -q` → green, zero warnings (e2e stays invisible).

- [ ] **Step 6: Commit**

```bash
git add supabase/config.toml backend/tests_e2e/
git commit -m "test(e2e): invite-resend + weak-password-retry live flows (B28 B29, #96 #97)"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/supabase-auth-setup.md` (§4 boundary promotion; invite-resend paragraph; new leaked-password subsection)
- Modify: `docs/backend-architecture.md`, `docs/frontend-architecture.md`

**Interfaces:** describes Tasks 1–8; changes no behavior.

- [ ] **Step 1: supabase-auth-setup.md**

- §4 (provider boundary): promote the claim — the verifier now validates the CURRENT session's authentication method (`amr` ⊆ {password, otp}) per request, not just the identity's first provider; the startup lockout remains the config-level gate, the amr guard closes the between-restarts window.
- Invites section: add a paragraph — expired invitations are re-issued from the admin view ("Resend invitation"); resending invalidates the previous link; an already-accepted account is reported as such.
- New subsection "Enabling leaked password protection": with the retry flow shipped, a GoTrue-side strength or breach rejection no longer burns the link — the form keeps the session and retries. Enabling the advisor's recommendation (dashboard, Pro plan) is now safe; describe where the toggle lives and that rejections surface with honest reasons.

- [ ] **Step 2: architecture docs**

- `backend-architecture.md`: extend the supabase-auth section — amr guard (with the first-provider vs current-session distinction), the two-leg confirm flow + envelopes + retry-token lifecycle (minted pre-rotation, dead post-rotation via the backdated mark), resend semantics (GoTrue authority), `EmailLocks` (bounded, held-locks-never-evicted, single-process assumption).
- `frontend-architecture.md`: the reset form's retry state machine, the shared weak-password reason mapper, the admin resend action + `invite_emailed` copy branch.

- [ ] **Step 3: Gates**

From `backend/`: `uv run pytest -q` green, zero warnings. Frontend untouched in this task — no frontend gate needed.

- [ ] **Step 4: Commit**

```bash
git add docs/supabase-auth-setup.md docs/backend-architecture.md docs/frontend-architecture.md
git commit -m "docs: amr boundary, retry flow, invite resend, email locks (B28-B31)"
```

---

## Post-plan (session-level, not tasks)

- LOGBOOK entry last on the branch; PR with separate `Closes #96.` `Closes #97.` `Closes #100.` `Closes #101.` lines; Copilot review + watcher; e2e workflow dispatch on the branch (registration exists on main — dispatch with `--ref b28-b31-invite-reset-resilience`).
- Post-merge (operator): enable leaked password protection in the dashboard when desired.
