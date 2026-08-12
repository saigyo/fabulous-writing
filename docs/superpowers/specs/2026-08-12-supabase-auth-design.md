# Supabase Auth Backend Design (B14 #55)

Hosted Supabase Auth as a configuration-selectable authentication backend.
The homegrown stack (bcrypt, HS256 tokens, `FW_AUTH_SECRET`, admin bootstrap
via `FW_ADMIN_EMAIL`/`FW_ADMIN_PASSWORD`) remains the default and is not
changed. The database stays SQLite in both modes (Supabase-hosted Postgres
is B15 #56).

## Scope

- `auth.mode: "supabase"` activates the hosted backend; `"local"` (default)
  keeps today's behavior byte for byte.
- Server-proxied architecture: the frontend talks only to our FastAPI in
  both modes. The backend speaks to Supabase's GoTrue via the official
  `supabase-auth` Python package; request verification is local (JWKS).
- Feature scope: login/logout/password change parity, plus password-reset
  emails and admin-triggered **invitation emails**. No public self-signup
  in any configuration.
- Deliverables include `docs/supabase-auth-setup.md` — the supabase.com
  dashboard walkthrough.

Out of scope: B15 (Postgres backend), bcrypt-hash migration tool (its own
follow-up backlog item), OAuth/social login, magic links, MFA, a setup-
wizard prompt for Supabase config, self-hosted Supabase.

## 1. Configuration and secrets

Files: `backend/app/core/config.py`, `backend/app/core/auth.py`,
`backend/app/main.py`.

- New nested model `SupabaseSettings` (`extra="forbid"`): `url: str` — the
  project URL, e.g. `https://abcdefgh.supabase.co`, not a secret. Wired as
  `AuthSettings.supabase: SupabaseSettings | None = None`.
- Startup validation, fail closed: `mode="supabase"` requires
  `auth.supabase.url` plus two **env-only** secrets —
  `FW_SUPABASE_PUBLISHABLE_KEY` (user-flow GoTrue calls) and
  `FW_SUPABASE_SECRET_KEY` (admin API only). Missing any of the three
  aborts startup with `AuthConfigError`.
- `FW_AUTH_SECRET` is resolved **only** in local mode; supabase mode
  neither requires nor reads it. `FW_ADMIN_EMAIL`/`FW_ADMIN_PASSWORD`
  keep their meaning in both modes (see §4).
- The secret key never reaches the browser, config files, DB, or logs.
  Unchanged rules: bcrypt work factor is not a knob;
  `auth.allow_additional_admins` and `limits.admin` stay config-only.
- Dependencies (`backend/pyproject.toml`): `supabase-auth>=2.31` (brings
  nothing new transitively beyond our stack) and the `pyjwt[crypto]` extra
  (ES256 support). `THIRD-PARTY-NOTICES.md` regenerated (the licenses CI
  job fails on drift).

## 2. Token verification seam

Files: `backend/app/core/auth.py` (or sibling `supabase_verify.py`),
`backend/app/main.py`, `backend/app/api/deps.py`.

- `app.state.token_verifier` is already the seam; `main.py` selects the
  implementation by mode.
- New `SupabaseTokenVerifier`: verifies bearer JWTs **locally** with
  PyJWT's `PyJWKClient` against
  `{auth.supabase.url}/auth/v1/.well-known/jwks.json` (cached ~10 min,
  refetch on unknown `kid`; fetched lazily on first use — a Supabase
  outage must not wedge container restarts, and requests fail closed with
  401 until the key set is reachable). Accepted algorithms: `ES256`,
  `RS256` — never HS256 in supabase mode (the project must use the
  asymmetric signing-keys system; the setup guide covers migrating off
  the legacy shared secret). Claims checked: signature, `exp`,
  `iss == {url}/auth/v1`, `aud == "authenticated"`.
- Per the pinned `TokenVerifier` contract (`core/auth.py`), the verifier
  resolves its subject UUID to the local row (`users.external_id`)
  **internally** and returns the local `users.id` with `epoch=None` —
  `api/deps.py` is not modified. Its reserved epoch-less fallback becomes
  live: a token whose `iat` predates the row's `password_changed_at` is
  rejected (401). Row re-read per request keeps instant deactivation
  working.
- **JIT shadow rows** (inside the verifier's resolution step): a verified
  token with no matching row creates one: `external_id=sub`, `email` from
  the token's `email` claim, `tier=default`, `is_admin=False`,
  `is_active=True` — this is how invited users materialize on first
  login. An email already owned by an *unlinked* local row adopts the
  subject (pre-Supabase account switching modes); an email owned by a row
  linked to a different subject fails closed.
- **Authorization stays local.** The SQLite `users` table is the sole
  authority for `is_admin`, `tier`, `is_active`. Supabase JWT claims,
  `app_metadata`, and `user_metadata` are never used for authorization
  decisions. `require_admin` stays attached to the admin router.

## 3. Auth routes (supabase mode)

File: `backend/app/api/auth.py`. All Supabase traffic goes through a
`SupabaseAuthGateway` service (§6). Routes marked *public* join the
`test_auth_enforcement` allowlist; every route below 404s in local mode
except where noted, and the local routes 404 in supabase mode (existing
`_require_local_mode` behavior, now a two-way mode dispatch).

| Route | Mode | Behavior |
|---|---|---|
| `POST /api/auth/login` *(public)* | both | Local: unchanged. Supabase: `LoginThrottle` applies first (same key), then gateway `sign_in`. Errors map to the same generic 401 (enumeration-resistant). |
| `POST /api/auth/refresh` *(public)* | supabase | Body `{refresh_token}` → gateway `refresh` → new `LoginResponse`. Invalid/revoked token → generic 401. |
| `POST /api/auth/logout` (bearer) | supabase | Revokes the caller's session refresh tokens (scope `local`); 204 always. Frontend still does local teardown regardless. |
| `POST /api/auth/password` (bearer) | both | Local: unchanged. Supabase: verify current password via gateway `sign_in`, then gateway `change_password`, then gateway `global_sign_out` **and** local `password_changed_at` bump — both eviction layers (M2 guarantee, see below). |
| `POST /api/auth/reset-request` *(public)* | supabase | Body `{email}` → gateway `send_reset_email`. Always 204 (enumeration-resistant). |
| `POST /api/auth/reset-confirm` *(public)* | supabase | Body `{token_hash, type: "recovery"\|"invite", new_password}` → gateway `confirm_with_token_hash`. Serves both password reset and invite acceptance. Password rules: min 8 (self-set), max 72 bytes. |

- `LoginResponse` gains `refresh_token: str | null` and
  `expires_at: int | null` (epoch seconds). Local mode returns nulls — no
  frontend behavior change there.
- **M2 guarantee in supabase mode:** password change (a) revokes all
  refresh tokens via admin `sign_out(scope="global")` and (b) sets local
  `password_changed_at`, so outstanding access tokens die immediately at
  our own verification layer regardless of their remaining TTL. Reset- and
  invite-confirm do the same.
- Supabase-unreachable errors map to a generic 503 (`"authentication
  service unavailable"`); GoTrue error bodies are logged server-side,
  never echoed to clients.
- `GET /api/health` gains
  `auth_features: {"password_reset": bool, "invites": bool}` — capability
  flags only (both true iff supabase mode), no provider names leak to the
  frontend; `invites` lets the admin form offer password-less creation.

## 4. Admin model, bootstrap, invitations

Files: `backend/app/services/seed_admin.py`, `backend/app/api/admin.py`.

- **Bootstrap:** with an empty users table, supabase-mode `seed_admin`
  creates the Supabase user via admin `create_user`
  (`FW_ADMIN_EMAIL`/`FW_ADMIN_PASSWORD`, `email_confirm=True`, password
  min 12 as today) plus the local admin shadow row. If the Supabase user
  already exists (re-run against an existing project), it links the
  existing UUID instead of failing. Once any user exists the env vars are
  inert, exactly as in local mode.
- **`POST /api/admin/users`:** with a `password` — direct admin
  `create_user` (email confirmed) + shadow row, as local parity. Without
  a `password` (supabase mode only) — **invitation**: admin
  `invite_user_by_email`; Supabase emails a link back to our origin with
  `token_hash` (`type=invite`); the shared set-password form completes
  it. Response marks the user `invited`. In local mode, omitting the
  password stays a 422 (unchanged).
- `allow_additional_admins` gating, self-deadmin/self-deactivate 409s,
  and `admin_audit` logging are unchanged; audit rows record invite vs.
  create.
- Admin-API calls are expected to succeed with the dashboard's public
  "allow new users to sign up" toggle **off** (service-key endpoints are
  not subject to it); verified empirically during implementation — if
  that assumption fails, the setup guide changes, never the API surface.

## 5. Frontend

Files: `frontend/src/auth/session.ts`, `LoginGate.tsx`, `LoginForm.tsx`,
`AccountMenu.tsx`, new `ResetPasswordForm.tsx`,
`frontend/src/api/client.ts`, `frontend/src/state/store.ts`,
`prefsStorage.ts`.

- Session becomes `{token, refreshToken?, expiresAt?}`; the optional
  fields persist alongside the token in `localStorage`. Absent (local
  mode) → behavior identical to today.
- When present, `session.ts` schedules a single-flight refresh
  (`POST /api/auth/refresh`) ~2 minutes before `expiresAt`;
  `restoreSession` refreshes first if the stored token is already stale.
  A failed refresh routes through the existing `expireSession` path
  (buffers preserved, "session expired" notice).
- Logout: fire-and-forget `POST /api/auth/logout`, then today's local
  teardown. Password change keeps the silent same-user re-login.
- `LoginForm` shows "Forgot password?" only when
  `auth_features.password_reset` is true (fetched from `/api/health`,
  which the anonymous state may call — it is already public). Submitting
  it calls `reset-request` and always shows the same neutral
  confirmation.
- `LoginGate` recognizes `token_hash` + `type` query parameters on load
  and renders `ResetPasswordForm` (set-new-password) in the anonymous
  state; the same form serves `recovery` and `invite`. On success it
  clears the URL parameters and returns to the sign-in form with a
  success notice (no auto-login: the confirm-time session was minted
  before `password_changed_at`, so the eviction fallback rightly rejects
  it — the user signs in with the new password).
- UI copy follows the informal register rule (Du/tu/tú) for all new
  strings.

## 6. Gateway service and testing

Files: new `backend/app/services/supabase_gateway.py`, tests under
`backend/tests/`.

- `SupabaseAuthGateway` wraps `supabase_auth`'s async clients
  (`AsyncGoTrueClient` with `persist_session=False`,
  `auto_refresh_token=False`, instantiated per call around a shared
  `httpx.AsyncClient`; `AsyncGoTrueAdminAPI` with the secret key).
  Methods: `sign_in`, `refresh`, `sign_out`, `change_password`,
  `send_reset_email`, `confirm_with_token_hash`, `create_user`,
  `invite_user`, `global_sign_out`, returning plain dataclasses — no
  library types leak past the service.
- Routes and `seed_admin` receive the gateway via `app.state`; tests
  inject a **fake gateway** (in-memory users, deterministic tokens). No
  test talks to a live Supabase instance or the network; the live-DB
  rule stays intact; `create_app()` is never called with default
  settings in tests.
- `SupabaseTokenVerifier` unit tests generate a local ES256 keypair,
  serve its JWKS from a static stub, and cover: valid token, expired,
  wrong `iss`, wrong `aud`, wrong signature, HS256 rejection, unknown
  `kid` refetch, `iat` predating `password_changed_at`.
- `test_auth_enforcement` allowlist grows by exactly the three new
  public routes (`refresh`, `reset-request`, `reset-confirm`); the walk
  itself is unchanged and keeps guarding everything else.
- Mode-dispatch tests: every supabase-only route 404s in local mode and
  vice versa; startup validation tests for the fail-closed config rules.
- Frontend: extend the existing fetch-mock patterns — refresh
  scheduling/single-flight, stale-restore refresh, reset/invite form
  flow, feature-flag gating of "Forgot password?".
- Mutation-verify every new guard test. Standard gates: `uv run pytest
  -q` green with zero warnings; frontend suite green.

## 7. supabase.com setup guide

New `docs/supabase-auth-setup.md`, linked from the README's deployment
section. Contents:

1. Create the project; note the project URL.
2. **JWT signing keys:** migrate off the legacy JWT secret and rotate to
   an asymmetric key (ES256 recommended) — required for local JWKS
   verification.
3. **API keys:** create a publishable key and a secret key; map to
   `FW_SUPABASE_PUBLISHABLE_KEY` / `FW_SUPABASE_SECRET_KEY`.
4. **Auth providers:** enable Email only; disable anonymous sign-ins;
   leave all OAuth providers off.
5. **Sign-up policy:** "Allow new users to sign up" **off**
   (invitation-only); email confirmations on.
6. **URL configuration:** Site URL = the deployment origin; add the same
   origin to redirect URLs (reset/invite links return there).
7. **SMTP:** configure custom SMTP for production — the built-in sender
   is rate-limited for development only.
8. Access-token TTL: default (1 h) is fine — revocation is enforced at
   our verification layer, not by TTL.
9. Container wiring: the `fabulous.env` lines (`FW_SUPABASE_*`) and the
   `config.yaml` stanza (`auth.mode`, `auth.supabase.url`).

Architecture docs (`docs/backend-architecture.md`,
`docs/frontend-architecture.md`) get matching sections.

## Issue closure

Its own milestone: branch + PR with Copilot review. The PR closes
`Closes #55.`
