# B27: Offline Supabase E2E Suite — Design

**Issue:** #94 (B27) · **Tests the surface shipped by:** B14 (#55, PR #95)
**Date:** 2026-08-15 · **Status:** approved design

## Goal

An automated end-to-end regression suite for the Supabase auth integration
that runs fully offline: the Supabase CLI local stack (Docker via colima)
provides GoTrue + Mailpit, the app runs as a real uvicorn scratch process,
and pytest drives the app's real HTTP surface — login, refresh, logout,
password change with M2 session eviction, admin invite acceptance, and
password reset — including the email link clicks, via Mailpit's REST API.
No hosted Supabase project, no real inbox, no internet.

The suite exists to catch the bug class unit tests structurally cannot:
real-server boot behavior (the `asyncio.run()`-inside-uvicorn `seed_admin`
crash found in live acceptance testing), real JWKS/ES256 verification
against a live GoTrue, real refresh-token rotation and revocation, and the
email template → token_hash → confirm contract.

## Decisions (settled during brainstorming)

1. **API-level only.** pytest + httpx against the backend; no browser.
   Frontend session logic remains covered by Vitest.
2. **Local opt-in + manual CI.** One wrapper command locally; a
   `workflow_dispatch`-only GitHub Actions job. Never part of PR checks;
   the default `uv run pytest -q` gate stays network- and Docker-free.
3. **Reuse the running stack.** The wrapper starts the supabase stack only
   if it is not already up and leaves it running; `--down` stops it.
   Isolation comes from per-run state, not container churn.
4. **App under test is a real uvicorn subprocess** on `127.0.0.1:8001`
   (approach A). Not `TestClient` (would skip the server boot path), not a
   Docker-containerized app (container fidelity is B21/B26's concern).

## Verified platform facts (supabase CLI 2.114.0)

- The local stack supports the signing-keys system: `[auth]`
  `signing_keys_path` in `config.toml`, keys generated with
  `supabase gen signing-key --algorithm ES256`. Local GoTrue then serves a
  real JWKS at `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json` and
  mints ES256 tokens. **The production verifier runs unchanged.** The
  loopback-http exception in `resolve_supabase_credentials`
  (`backend/app/core/supabase_auth.py`) was added in B14 for exactly this.
- Mailpit is the local mail catcher (`[local_smtp]`, web/API port 54324).
- Per-service `enabled` toggles exist in `config.toml`; `supabase start
  -x` can exclude containers by name.
- Default ports 54320–54329 do not collide with the reserved dev ports
  (5173, 8000) or the scratch port 8001.

## Components

### 1. Stack definition: `supabase/` (repo root, committed)

`supabase/config.toml`, from `supabase init`, trimmed and pinned:

- `project_id = "fabulous-writing-e2e"`. Containers are named
  `supabase_<service>_fabulous-writing-e2e` by the CLI. **Convention
  deviation, accepted:** these are not `fwscratch`-prefixed because the
  CLI owns its naming. Compensating rule: the harness manages these
  containers exclusively through `supabase start` / `supabase stop` —
  never raw `docker` commands — so it can never touch foreign resources.
- Services: postgres, GoTrue, Kong (gateway at `http://127.0.0.1:54321`,
  auth under `/auth/v1`), Mailpit. Disabled via config: studio, storage,
  realtime, edge-runtime, analytics/logflare, pooler. Postgres remains
  fully usable — B15 (#56) re-enables what it needs; nothing in the
  harness assumes auth-only.
- `[auth]` mirrors production: `enable_signup = false` (invitation-only;
  also pins the B14-verified fact that admin invites are exempt from the
  signup toggle), `enable_refresh_token_rotation = true`,
  `signing_keys_path = "./signing_keys.json"`.
- `supabase/signing_keys.json` is **git-ignored**; the wrapper generates
  it on first run (`supabase gen signing-key --algorithm ES256`). A fresh
  key per checkout costs nothing and keeps key material out of git.
- `supabase/templates/` (committed): invite and recovery email templates
  carrying the production fragment contract from
  `docs/supabase-auth-setup.md`:
  `{{ .SiteURL }}/#token_hash={{ .TokenHash }}&type=invite` (resp.
  `type=recovery`), wired via `[auth.email.template.*]`. A regression in
  the documented template contract then breaks a test, not production.

### 2. Wrapper: `scripts/e2e-supabase.sh`

Single entry point; runs from repo root.

1. Pre-flight: `docker info` reachable (colima), `supabase` CLI present;
   fail with actionable messages otherwise.
2. Generate `supabase/signing_keys.json` if missing.
3. `supabase start` only if `supabase status` reports the stack down;
   leave the stack running afterwards.
4. Read the stack's URL and keys from `supabase status` machine-readable
   output; export as `FW_SUPABASE_PUBLISHABLE_KEY` (local anon key) and
   `FW_SUPABASE_SECRET_KEY` (local service-role key). The local keys are
   well-known dev defaults, but the no-secrets-in-logs rule still applies:
   values are exported, never echoed.
5. `cd backend && uv run pytest tests_e2e -q -n0` (extra args forwarded,
   e.g. `-k invite`). `-n0` is required: the backend `addopts` default is
   `-n auto`, and the e2e suite shares one app process (never
   `-p no:xdist`, per the standing rule).
6. `--down` flag: `supabase stop` and exit (no tests).

The wrapper never touches ports 5173/8000, never kills processes it did
not start, and manages supabase containers only via the CLI.

### 3. App-under-test fixture (pytest session scope, in `tests_e2e/`)

- Launches `uvicorn app.main:app` as a subprocess on `127.0.0.1:8001`
  with: tempfile SQLite DB and rules dir, `FW_CONFIG_FILE` pointing at
  the committed e2e config (`tests_e2e/e2e-config.yaml`: `auth.mode:
  supabase`, `supabase.url: http://127.0.0.1:54321`), per-run-unique
  bootstrap admin `FW_ADMIN_EMAIL=admin-<runid>@e2e.local` +
  `FW_ADMIN_PASSWORD`, and the two key vars passed through from the
  wrapper. `FW_AUTH_SECRET` is not set (supabase mode does not use it).
- Waits for `GET /api/health` with a bounded retry loop; on failure,
  surfaces the captured uvicorn stderr.
- Yields the base URL `http://127.0.0.1:8001`.
- Teardown: terminate its own subprocess PID only; verify 8001 is free.

Booting through real uvicorn exercises config load, credential
resolution, the OAuth provider-lockout probe against live GoTrue
settings, and `seed_admin` under a running event loop — the full
production startup path.

**Run identity:** a session-scoped `runid` (short random hex). All
identities created during a run are `<role>-<runid>@e2e.local` — the
GoTrue Postgres persists across runs of a reused stack, so uniqueness,
not cleanup, is the correctness mechanism. The bootstrap admin is also
per-run, keeping every run on the deterministic fresh-create seeding
path. A session-teardown fixture best-effort deletes the run's GoTrue
users via the admin API; tests never depend on that cleanup.

### 4. Mailpit client (small helper in `tests_e2e/`)

Thin httpx wrapper over Mailpit's REST API on port 54324: list/search
messages by recipient, fetch a message body, extract `token_hash` and
`type` from the templated link (same URL-fragment contract the frontend's
`readResetParams` parses). Bounded polling for mail arrival (a few
seconds), no fixed sleeps.

### 5. Test suite: `backend/tests_e2e/`

A separate directory beside `backend/tests/`, **not** collected by the
default gate: `uv run pytest -q` from `backend/` collects `tests/` only,
so the default gate stays structurally Docker-free — it cannot even see
these files. No marker gymnastics. The e2e suite runs single-process (no
xdist); tests within the suite share the session app but use distinct
run-unique identities.

Flow coverage (one file per flow area, ~15–20 tests):

| # | Flow | Asserts |
|---|------|---------|
| 1 | Boot & health | App up against live stack; `auth_features: {password_reset: true, invites: true}`; bootstrap admin usable (login proves seeding in both stores) |
| 2 | Login/session | Admin login → ES256 token verified via real JWKS → `/api/me`; wrong password → 401 |
| 3 | Refresh | Rotated pair works; consumed refresh token is rejected |
| 4 | Logout | Bearer logout; the session's refresh token is dead at GoTrue afterwards |
| 5 | Password change + M2 eviction | Two live sessions; change password in one → other session's access token rejected (epoch), its refresh rejected (global sign-out), old password dead, new password works |
| 6 | Invite acceptance | Admin create without password → 201 `invited: true` → Mailpit mail → `token_hash` → reset-confirm sets password → invitee login works |
| 7 | Password reset | Reset request → mail → confirm → pre-existing sessions evicted, new password works; rapid repeat requests trip the reset throttle (exact request count pinned from `reset_throttle`'s threshold at plan time; no wall-clock waits) |

Out of scope, deliberately: negative/adversarial token cases (bad
signatures, claim guards, provider guards, anonymous tokens) — pinned in
the unit suite with the fake/real-verifier rigs. This suite buys
integration truth, not case coverage. Also out of scope: browser flows
(Vitest owns frontend logic), load/perf, B15 database concerns.

### 6. CI: `.github/workflows/e2e-supabase.yml`

`workflow_dispatch` only (choose the branch when triggering). Ubuntu
runner: checkout → official supabase CLI setup action → `uv sync` →
run `scripts/e2e-supabase.sh` (cold stack: the reuse logic degrades to a
fresh start) → `supabase stop` in an `always()` cleanup step. Not wired
into PR checks.

## Constraints (binding, from the standing project rules)

- The default backend gate `uv run pytest -q` must remain green, warning-
  free, and unable to reach Docker or the network. `tests_e2e/` must be
  invisible to it.
- Live DB `backend/data/fabulous.db` untouched; ports 5173/8000 untouched;
  scratch app on 8001 only; kill own PIDs only.
- Secrets/keys via environment only; key values never in logs, repo, or
  test output. `signing_keys.json` git-ignored.
- The production verifier is not weakened for tests: ES256/RS256 via JWKS
  only. The loopback-http URL exception already shipped in B14 and is the
  only accommodation.
- No new Settings knobs for the harness; e2e configuration lives in the
  committed e2e config file + env.

## Open items to pin during implementation (not design risks)

- Exact machine-readable field names from `supabase status` for the API
  URL, anon key, and service-role key on CLI 2.114.0.
- Mailpit REST endpoint shapes (search vs. list; body encoding).
- Confirmation that local GoTrue's admin API accepts the service-role JWT
  for `invite_user_by_email` / `delete_user` identically to a hosted
  `sb_secret_` key (expected: yes; the gateway code path is identical).
- Which config.toml `enabled` toggles suffice vs. needing `supabase start
  -x` exclusions on 2.114.0.
