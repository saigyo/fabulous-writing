# Invite/Reset Resilience Bundle — Design (B28+B29+B30+B31)

**Issues:** #96 (B28 invite resend) · #97 (B29 verify-once-retry-many) ·
#100 (B30 amr guard) · #101 (B31 per-email serialization)
**Builds on:** B14 (#55, PR #95) supabase auth mode · B27 (#94, PR #103)
offline e2e suite
**Date:** 2026-08-16 · **Status:** approved design

## Goal

Make the supabase-mode invite and reset flows survive their real failure
modes — expired links, GoTrue password-strength rejections (including
leaked-password detection), transient update failures, linked-identity
OAuth sessions, and concurrent admin operations — so that enabling the
Supabase advisor's leaked-password recommendation becomes safe, and no
failure path ends in "manual dashboard surgery".

One branch, one PR, closes all four issues.

## Decisions (settled during brainstorming)

1. **Resend UI**: the action lives in every supabase-linked user's
   existing admin ⋯ menu; the backend answers precisely (204 sent / 422
   already-active). No local pending-state tracking, no schema change —
   GoTrue is the pending-state authority.
2. **Weak-password copy**: reason-mapped messages (length / characters /
   pwned) + generic fallback, informal register, all 7 locales.
3. **One bundle PR** for all four issues.
4. **Retry-leg identity via the existing verifier** (not a parallel
   lightweight JWT path): keeps the single-choke-point invariant; JIT
   materialization on a retry that fails again is acceptable (the row
   mirrors an already-confirmed GoTrue identity).

## Empirically verified GoTrue facts (probed live on the B27 stack, CLI 2.114.0)

These settle mechanism choices; do not re-litigate them:

1. **Re-inviting a pending identity works**: `POST /auth/v1/invite` for an
   existing pending (invited, never signed-in) email → 200, **same UUID**,
   a fresh mail is delivered, and the previous invite link is invalidated
   (old `token_hash` → 403 `otp_expired`). The "GoTrue rejects re-invites"
   premise in #96 was wrong — the actual resend blocker is the app's own
   local duplicate pre-check. No delete-and-relink, no `generate_link`.
2. **Invite on a confirmed identity** → 422 `error_code: "email_exists"` —
   the authoritative "already accepted" signal.
3. **amr shapes**: password grant → `[{"method": "password", "timestamp": …}]`;
   invite AND recovery `verify_otp` sessions → `[{"method": "otp", …}]`;
   refreshed sessions inherit the original entries. `aal` is `aal1`
   throughout our flows.
4. **Weak-password rejection on the admin update**
   (`PUT /auth/v1/admin/users/{id}`) → 422, `error_code: "weak_password"`,
   `msg` prose, and `weak_password.reasons` (list; observed `["length"]`;
   GoTrue's reason vocabulary: `length`, `characters`, `pwned`).
5. **After a failed update, the verified identity remains updatable**: a
   retry of the admin update with an acceptable password succeeds and the
   user can then log in with it. `verify_otp` burns the link regardless of
   update outcome (fact 1's 403 on reuse).
6. **Pending invitees have local rows**: the B14 admin invite path creates
   the local row at invite time (`external_id` set, no hash), so a
   resend endpoint can target `/api/admin/users/{id}`.

## Components

### 1. B30 — per-session authentication-method guard (verifier)

`SupabaseTokenVerifier.verify()` (`backend/app/core/supabase_auth.py`)
gains one guard after the existing claim checks (`is_anonymous`, `role`,
`app_metadata.provider`):

- The payload must carry a **non-empty `amr` array**, and **every** entry's
  `method` must be in `{"password", "otp"}`. Anything else — `oauth`,
  `sso/saml`, `magiclink`, missing or empty `amr` — raises `InvalidToken`,
  warning-logged like the other guards (issuer only, never token content).
- Fail-closed rationale: the startup OAuth lockout already prevents
  enabled providers at boot; this closes the runtime window (provider
  enabled at the dashboard mid-flight) and the linked-identity case
  (email-first account later linked to OAuth would pass the
  first-provider check on an OAuth session).
- All legitimate flows pass (fact 3), including B29 retry tokens
  (otp-minted) and refreshed sessions (inherit).

One choke point covers login, refresh, reset-confirm, and the retry leg —
no other call sites change.

### 2. B29 — verify-once-retry-many confirm flow

**Gateway restructuring** (`backend/app/services/supabase_gateway.py`):

- `confirm_with_token_hash(token_hash, type_, new_password)` is replaced
  by `verify_token_hash(token_hash, type_) -> SupabaseSession` (the
  `verify_otp` half only). The update half reuses the existing
  `change_password(user_id, new_password)`.
- New exception `SupabaseWeakPasswordError(SupabaseAuthError)` carrying
  `reasons: list[str]`, raised when GoTrue rejects a password on strength
  grounds (fact 4). The gateway's error mapping splits it out of the
  generic `SupabaseAuthError` for `change_password` (all password-setting
  callers benefit: confirm, account change, admin create/patch). Exact
  library surface (`AuthWeakPasswordError` and its reasons attribute) is
  pinned at plan time against the installed `supabase-auth` version.

**Route** (`POST /api/auth/reset-confirm`, `backend/app/api/auth.py`) —
accepts exactly one of two bodies (rejects both-or-neither with 422):

- `{token_hash, type, new_password}` — the **link leg**.
- `{retry_token, new_password}` — the **retry leg** (`retry_token` max
  length 8192 like `RefreshRequest.refresh_token`).

Link leg: app-side password pre-validation (unchanged, min 8) →
`verify_token_hash` (burns the link; invalid/expired → 422
`invalid_or_expired_link` as today) → password update via
`change_password(session.user_id, new_password)`:

- **Weak-password rejection** → **422
  `{"code": "password_weak", "reasons": [...], "retry_token": <access token>}`**.
- **`SupabaseUnavailableError` after a successful verify** → **503
  `{"code": "update_failed", "retry_token": <access token>}`** — covers
  the PR #95 round-8 transient case (confirmed invitee, no password, dead
  link). Plain `SupabaseAuthError` (non-weak) after verify maps the same
  way: the identity is confirmed, the link is burned, retrying is the only
  useful direction.
- No eviction on failure legs — the password has not changed.

Retry leg: `retry_token` goes through
`app.state.token_verifier.verify()` via `run_in_threadpool` — full claim
guards (including the new amr guard) and normal JIT semantics → load the
local row (active check as today) → its `external_id` is the update
target → `change_password(external_id, new_password)` → same failure
envelopes (the same retry token remains usable; it stays valid until its
natural TTL).

Success (either leg): unchanged M2 ordering — the existing hoisted
eviction bookkeeping for a pre-existing row, `mark_password_changed`
(backdated) + best-effort `global_sign_out`, then 204. Invariants pinned
by tests:

- The route never returns a session in any branch — the retry token
  authorizes the password update only and can never be exchanged into an
  app session (the post-success backdated-iat eviction kills it for
  API-auth purposes).
- The retry envelope's `retry_token` is never logged.

**Sequencing note**: on the link leg, eviction bookkeeping stays keyed to
the *verified* subject exactly as shipped in B14; the restructure must not
reorder verify → update → evict → 204 into anything that loses the
"completed remote rotation always evicts locally" property.

### 3. B28 — invite resend

**Endpoint**: `POST /api/admin/users/{id}/resend-invite` (admin router,
`require_admin`, supabase mode only — local mode 404 like the other
supabase-only routes):

- Target row must exist and have `external_id` — else 422
  `{"code": "not_linked"}` (same guard shape as admin PATCH password).
- Calls `gateway.invite_user(row.email)` (fact 1: GoTrue re-invites
  pending identities and refreshes the link).
- 200 from GoTrue → **204**. GoTrue `email_exists` (fact 2) → **422
  `{"code": "already_active"}`** — the invitee has accepted since; honest
  admin feedback instead of a phantom resend. `SupabaseUnavailableError`
  → 503.
- Audit-logged like create/invite (`field="invite_resend"`).
- Runs under the B31 email lock.

**Create-response honesty**: `AdminUserCreated` gains
`invite_emailed: bool = False`. Fresh invite → `invited=True,
invite_emailed=True`; the reconciliation path (stale pending identity
linked, **no** new mail sent) → `invited=True, invite_emailed=False`.
The admin UI copy distinguishes "invitation sent" from "existing pending
invitation linked — use resend to issue a fresh link".

### 4. B31 — per-email serialization

New small module (e.g. `backend/app/core/email_locks.py`): an
`EmailLocks` class holding `asyncio.Lock`s keyed by lowercased email,
with the bounded-map hygiene of `LoginThrottle` (entry TTL + cap;
lock entries are evictable only when unheld). Single-process assumption
documented on the class, same as the throttle's.

Held (async context manager) around the **entire supabase branch** of:
admin create — both invite and with-password paths, including the
pre-check, remote create/invite, reconciliation + credential rotation,
and local link/insert — and the resend endpoint's remote call. This
serializes the #101 credential race and create-vs-resend interleavings.
Local mode is untouched (no remote leg, `UserStore` is already
transactional).

### 5. Frontend

- **Reset/invite form** (`frontend/src/auth/LoginGate.tsx` area): on 422
  `password_weak` or 503 `update_failed` the form stays mounted, stores
  `retry_token`, shows the reason-mapped message, and resubmits via the
  retry leg (`{retry_token, new_password}`). Reasons map to messages:
  `length` → too short (per GoTrue's rules), `characters` → required
  character classes missing, `pwned` → this password appears in known
  breach data, else → generic "too weak". `update_failed` → "could not
  save yet — try again" retaining the form.
- **Account menu password change + admin create/patch**: when the new
  weak-password error surfaces there, show the same reason-mapped
  messages instead of the generic failure copy.
- **Admin view** (`frontend/src/admin/AdminView.tsx`): "resend
  invitation" entry in the existing per-user ⋯ menu for rows with a
  supabase link, gated by `auth_features.invites`; toasts for
  204 → "invitation sent", `already_active` → "already accepted".
  Create-flow copy uses `invite_emailed` (§3).
- **i18n**: ~6 new keys × 7 locales (en de fr es it ja zh), informal
  register (Du/tu/tú/你), `register.test.ts` conventions (English code
  comments only).

### 6. Tests

**Unit (default gate, `backend/tests/`):**

- Verifier amr matrix on the real-verifier rig (ES256-signed claims):
  reject `oauth`, `sso/saml`, `magiclink`, mixed legit+oauth, missing
  `amr`, empty `amr`; accept `password`, `otp`, multi-entry legit,
  refresh-inherited shapes. Mutation-verify the guard.
- Gateway: `verify_token_hash` split, `SupabaseWeakPasswordError` mapping
  (MockTransport with GoTrue's 422 weak_password body), reasons
  passthrough.
- Confirm route: link leg weak → envelope shape (code, reasons,
  retry_token present); 503 envelope; retry leg success → 204 + eviction
  ordering; retry leg repeated weak → envelope again; both-or-neither
  body → 422; never-returns-a-session pin (all branches).
- Resend endpoint matrix: pending → 204 + audit row; `email_exists` →
  `already_active`; unlinked → `not_linked`; local mode → 404; gateway
  down → 503.
- `AdminUserCreated.invite_emailed` on fresh-invite vs reconciliation.
- `EmailLocks`: concurrent same-email creates serialize (deterministic
  interleave via a blocking fake gateway); distinct emails do not; TTL/cap
  hygiene; lock released on exception.
- `FakeSupabaseGateway` grows: weak-password injection for
  `change_password`, invite call counting per email, `verify_token_hash`
  semantics (burn on use), `email_exists` behavior for confirmed fakes.
- Frontend Vitest: retry-leg form state machine, reason mapping, resend
  menu action + toasts, `invite_emailed` copy switch; register test
  covers the new keys.

**E2E (B27 suite, `backend/tests_e2e/`):**

- Resend flow: invite → resend → second mail in Mailpit, old
  `token_hash` → 422 `invalid_or_expired_link` via the app, new one
  accepts, invitee logs in.
- Weak-password retry flow: enabled by setting
  `password_requirements = "lower_upper_letters_digits"` in
  `supabase/config.toml` — an all-lowercase ≥8-char password then passes
  the app's own pre-validation but fails GoTrue → real 422
  `password_weak` envelope → retry with a compliant password via
  `retry_token` → 204 → login works. Config comment documents this
  deliberate deviation from the hosted default ("" = none): it exists to
  exercise the retry leg, which is exactly the class of GoTrue-side
  strength setting B29 makes safe. Side effect to handle: the existing
  e2e passwords (`e2e-old-password-<runid>` etc.) are lowercase+digits
  only and would now be rejected by GoTrue in every remote
  password-setting flow — the plan phase sweeps all `tests_e2e/`
  passwords to `lower_upper_letters_digits`-compliant values.
- amr presence assert added to the existing token-claims e2e test (cheap
  pin that local GoTrue keeps minting `amr`).

### 7. Docs / ops

- `docs/supabase-auth-setup.md`: §4 boundary note promoted (per-session
  `amr` validation, not just first-provider); invite-resend paragraph
  (§ providers/invites); new "enabling leaked password protection"
  subsection — after this ships, the advisor's recommendation is safe to
  follow; the enablement itself is a dashboard step (operator's call),
  and the retry flow is what makes its rejections recoverable.
- `docs/backend-architecture.md` + `docs/frontend-architecture.md`
  updated per convention; LOGBOOK entry last on the branch.
- Issue-closing: separate `Closes #96.` `Closes #97.` `Closes #100.`
  `Closes #101.` lines in the PR body.

## Constraints (binding, standing project rules apply throughout)

- No public self-signup in any configuration; the resend endpoint is
  admin-gated and mode-guarded.
- Secrets/keys env-only; retry tokens and key values never logged.
- The default `uv run pytest -q` gate stays Docker/network-free and
  warning-free; e2e extensions live in `tests_e2e/` only.
- `require_admin` stays attached to the admin router; no new
  Settings/env knobs (the lock table and retry flow are unconditional
  behavior).
- Frontend XSS rules; informal register for all new UI strings.
- Never widen a wall-clock test bound; mutation-verify every guard test.

## Out of scope

- Enabling leaked-password protection itself (operator dashboard step,
  after merge).
- Multi-process lock coordination (single-process deployment assumption,
  documented — same as `LoginThrottle`).
- Invite-expiry countdown/visibility in the admin UI, and any local
  pending-state schema (GoTrue stays the authority).
- B15 (hosted Postgres) concerns.

## Open items to pin at plan time (not design risks)

- `supabase-auth` library surface for the weak-password error
  (`AuthWeakPasswordError`? attribute carrying reasons?) on the installed
  version — the gateway mapping transcribes from that.
- Exact GoTrue reason strings for `characters` (probe if the message
  mapping needs it beyond the three known values).
- `tests_e2e/` password sweep for `lower_upper_letters_digits`
  compliance (§6).
- Whether the admin ⋯ menu currently exists for user rows in AdminView
  (B14 added per-user actions; plan confirms the exact insertion point).
