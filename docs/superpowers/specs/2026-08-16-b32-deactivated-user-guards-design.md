# B32: Deactivated-User Guards for Reset and Resend Flows — Design

**Issue:** #106 (B32) · **Found by:** owner testing after PR #105
**Mode:** supabase auth mode only (`_require_supabase_mode` / mode checks already gate every touched route)

## Problem

Deactivation is local-only state (`users.is_active`); the Supabase identity stays
active. Three gaps follow:

1. `POST /api/auth/reset-request` forwards every email to GoTrue without
   consulting the local store — a deactivated user still receives a working
   reset mail.
2. On the reset-confirm **link leg**, the remote password rotates *before* the
   local `is_active` check fires — a deactivated account's Supabase credential
   is rotatable, and the user sees the misleading "link invalid or expired"
   error afterwards.
3. `POST /api/admin/users/{id}/resend-invite` checks `external_id` but not
   `is_active` — a deactivated pending invitee can be re-invited into a
   dead-end.

All three are fail-closed today (no session is ever issued; local authority
gates everything). This is hygiene: no avoidable mail, no unnecessary remote
rotation, honest error copy.

## Decision (owner-approved)

After a **verified** one-time link (or otp retry token), the submitter has
proven mailbox control — account state is no longer enumerable information at
that point. The confirm surface therefore answers honestly with a new 422 code
`account_inactive` instead of `invalid_or_expired_link`. The unauthenticated
`reset-request` surface stays strictly unenumerable (silent 204).

## Requirements

### R1 — `reset_request` (backend/app/api/auth.py)

After the existing throttle bookkeeping (`record_failure` still consumes a
slot — blocked/allowed behavior and timing stay indistinguishable), and before
the gateway call:

```python
user = store.get_by_email(body.email)
if user is not None and not user.is_active:
    return Response(status_code=204)
```

- Inactive local row → silent 204, **no** `send_reset_email` call, no mail.
- Unknown email or active row → unchanged flow (GoTrue no-ops unknown emails).
- `get_by_email` is a sync sqlite call invoked directly, consistent with
  `reset_confirm`'s direct `store.get_user` usage.
- No audit record (route is unauthenticated; none exists today).

### R2 — Reset-confirm link leg (backend/app/api/auth.py)

Restructure `reset_confirm`'s link leg so the existing-row lookup happens
immediately after `verify_token_hash` (the link burns either way — correct,
GoTrue semantics) and **before** `_update_password_or_retry_envelope`:

```python
existing_row = store.get_by_external_id(session.user_id)
inactive_row = existing_row
if inactive_row is None and session.email is not None:
    # Adoption edge: an unlinked local row that verify() would adopt by
    # email must also block rotation while inactive.
    inactive_row = store.get_by_email(session.email)
if inactive_row is not None and not inactive_row.is_active:
    raise HTTPException(422, {"code": "account_inactive"})
```

- No remote rotation for an inactive account; the one-time link is spent.
- `existing_row` (the `get_by_external_id` result, **not** the email-adopted
  fallback) keeps its current role unchanged: eviction bookkeeping after a
  successful rotation, and the `existing_row is None` JIT-eviction branch.
- New invitees with no local row proceed to JIT materialization as today.
- The post-verify defense-in-depth check splits its answer:
  `user is None` → `invalid_or_expired_link` (unchanged);
  `not user.is_active` → `account_inactive` (normally unreachable after the
  hoist; kept as defense in depth).

### R3 — Reset-confirm retry leg (backend/app/api/auth.py)

The retry leg already checks `is_active` before rotating. Split the combined
guard for symmetric honesty — order:

1. `user is None` → 422 `invalid_or_expired_link`
2. `not user.is_active` → 422 `account_inactive`
3. `user.external_id is None` → 422 `invalid_or_expired_link`

No behavioral change to rotation (already blocked); only the code returned for
the inactive case changes.

### R4 — `resend_invite` (backend/app/api/admin.py)

Admin surface, not enumeration-sensitive. After the 404 check and before the
`not_linked` check (and before any gateway call / email lock):

```python
if not user.is_active:
    raise HTTPException(422, {"code": "user_inactive"})
```

### R5 — Frontend

- `ResetPasswordForm` error mapping: `account_inactive` → new i18n key
  `resetAccountInactive`. English copy: "This account is deactivated — contact
  your admin." Informal register (Du/tu/tú/你) in all 7 locales
  (en de fr es it ja zh).
- `mapAdminError`: `user_inactive` → new i18n key `adminUserInactive`.
  English copy: "This account is deactivated." (The resend button is already
  disabled for inactive users since PR #105; the mapping covers the stale-tab
  race.)
- No other UI changes. `register.test.ts` picks the new strings up
  automatically.

## Non-requirements

- No new Settings/env knobs.
- No change to local auth mode (all touched paths are supabase-mode-gated).
- No change to the throttle tables or their exemption rules.
- No revocation of already-sent mails or already-burned links beyond the above.

## Testing

### Unit (backend/tests/test_auth_supabase_api.py + fakes)

Every guard mutation-verified (delete the guard, watch the test fail, restore).
The fake gateway's call counters prove the negative space:

1. `reset-request` for an inactive user → 204 AND `send_reset_email` never
   called (counter on the fake). Active user → still called. Unknown email →
   still called.
2. Link leg, linked inactive row → 422 `account_inactive`, `change_password`
   never called, link burned (a second confirm with the same hash → 422
   `invalid_or_expired_link`).
3. Link leg, adoption edge: unlinked inactive row matching the session email →
   422 `account_inactive`, no rotation.
4. Retry leg, inactive user → 422 `account_inactive`, no rotation.
5. Resend, inactive user → 422 `user_inactive`, `invite_user` never called.
6. Existing active-path tests stay green (no regression in the happy paths).

The fake gateway (`backend/tests/fakes_supabase.py`) gains a
`send_reset_calls` counter if it does not already expose one.

### Frontend (vitest)

- `account_inactive` envelope renders the `resetAccountInactive` copy in
  `ResetPasswordForm`.
- `mapAdminError` maps `user_inactive` → `adminUserInactive`.

### E2e (backend/tests_e2e/, B27 suite — workflow_dispatch job, not the
default gate)

One new test in `test_resilience.py`:

1. Invite a run-unique user, confirm, then deactivate via admin PATCH.
2. Record the deactivated user's Mailpit message count.
3. `POST /auth/reset-request` for the deactivated user → 204.
4. `POST /auth/reset-request` for an active control user; wait for the
   control's recovery mail (its arrival bounds the wait deterministically).
5. Assert the deactivated user's message count is unchanged — no mail.
6. Same test: admin `resend-invite` on the deactivated user → 422
   `user_inactive`.

## Global constraints (binding, unchanged)

- Live DB `backend/data/fabulous.db` never touched by tests; `tmp_path`
  Settings everywhere.
- `uv run pytest -q` (from `backend/`) green with zero warnings and stays
  Docker/network-free; frontend `npm test -- --run`, `tsc -b --noEmit`,
  oxlint clean. Single-file pytest `-n0`. E2e suite `-n0`.
- New UI strings: informal register, all 7 locales; code comments English.
- Secrets from env only; token values never logged.
- Branch + PR (`b32-deactivated-user-guards`), Copilot review, owner merges;
  LOGBOOK entry by PR number as last commit; commit trailers per repo
  convention. PR body: `Closes #106.`
