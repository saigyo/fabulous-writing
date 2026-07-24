# Multi-User Capability & Authentication — Design

**Date:** 2026-07-24
**Status:** Draft for review

## 1. Goal

Make Fabulous Writing usable by a limited number of users: user accounts, a
tier/permission system, ownership isolation of user data, and a local
username/password authentication that exercises the same code path a later
Supabase Auth integration will use. Deployment (Fly.io) and the Supabase
integration itself are separate follow-up projects.

## 2. Project decomposition

This spec covers sub-project 1 only. Each sub-project gets its own
spec → plan → implementation cycle:

1. **Multi-user foundation + local auth** (this spec): users, tiers,
   permissions, ownership scoping, local login, admin UI.
2. **Supabase Auth integration**: `SupabaseTokenVerifier` (JWKS/RS256),
   user provisioning/linking via `users.external_id`, invite policy.
3. **Fly.io deployment**: Dockerfile, volume + SQLite strategy, secrets,
   CORS/domain configuration.

## 3. Confirmed decisions

| Topic | Decision |
|---|---|
| Database | Stays SQLite (single file, later on a Fly volume). Supabase is auth-only. |
| Auth architecture | Pluggable token verifier behind one FastAPI dependency; Bearer JWT everywhere. |
| Local auth | Username/password against local `users` table; backend-issued HS256 JWT. |
| Tier ladder | Two tiers: `basic`, `premium`. Admin is a separate boolean flag, not a tier. |
| Tiers control | LLM access (quality tiers / providers / models), usage quotas, feature gating. |
| Enforcement style | Graceful degradation for LLM selection and quotas; hard errors only for forbidden actions. |
| Ownership | `documents`/`folders` strictly per-user. `profiles`/`domains` global built-ins (owner NULL, read-only for non-admins) + per-user private items. Rule YAMLs and provider config stay server-global. |
| Admin surface | Small admin UI page (list/create/edit users) + admin API. |
| SSE auth | Bearer header via fetch-based streaming. No tokens in URLs, ever. |

## 4. Architecture

### 4.1 Request authentication

Every `/api/*` request except `/api/health` and `POST /api/auth/login`
requires `Authorization: Bearer <JWT>`.

One FastAPI dependency resolves identity:

```
get_current_user(request) -> CurrentUser
  1. extract Bearer token (401 if missing/malformed)
  2. claims = TokenVerifier.verify(token)        # 401 on invalid/expired
  3. user = UserStore lookup (by claims subject) # 401 if unknown or inactive
  4. return CurrentUser(id, email, display_name, tier, is_admin)
```

`TokenVerifier` is a small protocol:

```python
class TokenVerifier(Protocol):
    def verify(self, token: str) -> TokenClaims: ...   # raises InvalidToken
```

Implementations:

- **`LocalTokenVerifier`** (built now): HS256. Claims: `sub` (user id as
  string), `exp` (24 h from issue), `iat`.
- **`SupabaseTokenVerifier`** (interface + config slot now, implementation
  in sub-project 2): RS256 via Supabase JWKS; maps the Supabase `sub` UUID
  to `users.external_id`.

**Algorithm pinning (binding):** each verifier decodes with an explicit
single-element `algorithms` list (`["HS256"]` resp. `["RS256"]`) and
rejects everything else — never `none`, never a foreign algorithm — and
validates `exp`/`iat`. A unit test asserts that a token signed with a
different algorithm is rejected (the classic `alg: none` / RS256→HS256
confusion bugs).

**Secret handling:** the HS256 secret comes from `FW_AUTH_SECRET` and must
be ≥ 32 characters (startup error otherwise). If unset, startup **fails**
— unless config sets `auth.ephemeral_secret: true` (the checked-in dev
`config.yaml` sets it; deployment configs must not), in which case a
random per-start secret is generated with a logged warning (tokens die on
restart — deliberately self-sabotaging outside dev).

Config selects the verifier: `auth.mode: local` (later: `supabase`). In
`supabase` mode, `POST /api/auth/login` and the `LocalTokenVerifier` are
fully disabled — a leaked `FW_AUTH_SECRET` must not forge tokens against a
Supabase-mode instance.

An admin-only dependency (`require_admin`) wraps `get_current_user` and
returns 403 for non-admins.

### 4.2 Token issuing (local mode only)

`POST /api/auth/login {email, password}`:
bcrypt-verify against `users.password_hash`; reject unknown email, wrong
password, or `is_active = 0` uniformly with 401 and a generic message (no
account enumeration). For unknown or inactive accounts, a bcrypt
comparison against a fixed dummy hash still runs so response timing does
not leak account existence. On success: `{token, user}` where `user` is
the same shape `/api/auth/me` returns.

**Throttling:** a lightweight in-process throttle on failed logins per
(email, client IP) — exponential backoff after N consecutive failures
(e.g. 5), decaying over minutes; throttled attempts get the same generic
401. In-memory is acceptable (single-process deployment); documented as
non-distributed. Supabase replaces this in sub-project 2.

Passwords: bcrypt (via the `bcrypt` package). Minimum length 8 for
self-chosen passwords; 12 for admin-set ones (initial passwords, resets,
and `FW_ADMIN_PASSWORD`). `POST /api/auth/password {current, new}`
changes one's own password (re-verifies `current`).

No refresh tokens in v1: with 24 h expiry and a small user base, re-login
is acceptable. Supabase brings refresh semantics in sub-project 2.

## 5. Data model

### 5.1 New table: `users`

```sql
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id   TEXT UNIQUE,             -- Supabase sub; NULL until linked
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT,
    password_hash TEXT,                    -- NULL once Supabase-managed
    tier          TEXT NOT NULL DEFAULT 'basic',   -- 'basic' | 'premium'
    is_admin      INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
);
```

Tier and admin flag live here — the permission model never depends on the
external auth provider.

### 5.2 Ownership semantics

`owner_id` on a resource row means:

- **integer** — that user's private item;
- **NULL** — global built-in: visible to every user, mutable only by admins.

Per table:

- `documents`, `folders`: already have `owner_id INTEGER NOT NULL`
  (currently constant 1) — "never global" is a database invariant, not a
  convention. All queries gain `WHERE owner_id = ?`, and every store
  method touching these tables takes `owner_id` as a **required,
  non-defaulted** parameter, so a forgotten scope is a call-site error
  rather than a cross-tenant read.
- `profiles`, `domains`: gain a *nullable* `owner_id` column (NULL is the
  deliberate global marker here). List endpoints return global rows plus
  the caller's rows; create always as the caller (feature-gated, see
  §6.3); update/delete of a global row requires admin.
- `terms`: inherit ownership through their domain (no own column). The
  term endpoints take a bare term id, so **every term read/mutation must
  resolve the parent domain and check its ownership** — a term under
  another user's domain is 404, a term under a global domain is
  admin-mutable only. This check is part of the store API, not left to
  the router.
- Rule YAML files and LLM provider configuration: server-global, unchanged.

The folders NOCASE unique index becomes per-owner in effect: uniqueness
checks are scoped to the owner (see migration §9 for the index change).

### 5.3 New table: `llm_usage` (ledger)

```sql
CREATE TABLE llm_usage (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL,
    day            TEXT NOT NULL,          -- 'YYYY-MM-DD', UTC
    llm_tier       TEXT,                   -- effective tier; NULL for direct selection
    provider       TEXT NOT NULL,          -- effective provider
    model          TEXT NOT NULL,          -- effective model
    input_tokens   INTEGER,                -- NULL when the provider reports nothing
    output_tokens  INTEGER,
    check_id       TEXT NOT NULL
);
CREATE INDEX idx_llm_usage_user_day ON llm_usage(user_id, day);
```

A row is inserted when an LLM run starts (effective selection recorded);
token counts are filled in when the run completes, from the token usage the
providers already report. **Failed or cancelled runs keep their ledger
row** (their token columns record whatever was reported before the end) —
failures still spend quota, so cancel-and-retry loops cannot hit providers
for free. Record richly, limit simply: v1 enforces only one rule (§6.4),
but every future limit dimension (per LLM tier, per model, token-based) is
computable from this ledger without schema changes.

## 6. Tiers & permissions

### 6.1 Configuration

`config.yaml` gains:

```yaml
limits:                        # global, server-level (all users incl. admin)
  max_document_chars: 200000

tiers:
  basic:
    llm:
      tiers: [cheap, local]       # allowed LLM quality tiers
      providers: [ollama]         # allowed for direct provider selection
      models: all                 # or per-provider allowlists, see below
    limits:
      llm_checks_per_day: 20
      max_llm_document_chars: 20000
    features: []
  premium:
    llm:
      tiers: all
      providers: all
      models: all
    limits:
      llm_checks_per_day: 200
      max_llm_document_chars: 100000
    features: [custom_profiles, custom_domains]
```

`models` is either `all` or a mapping `provider -> ordered list of allowed
models` (first entry = preferred substitute for degradation). A provider
absent from the mapping, but present in `providers`, allows all its models.
Numbers above are starting defaults, tunable in config without code changes.
Validation at load time: unknown LLM tier names, unknown feature names, and
non-positive limits are config errors.

Admins bypass all tier restrictions and limits (global
`max_document_chars` still applies).

### 6.2 LLM selection policy — graceful degradation

The existing two-dimensional selection model is unchanged: quality tiers
(`quality`, `balanced`, `cheap`, `local`) resolve through the per-language
routing table; direct selection names a provider + model.

One pure function decides what actually runs:

```
resolve_llm_selection(policy, requested, language) -> EffectiveSelection
```

**Tier-based request** (requested quality tier T):
1. T allowed → use T.
2. Otherwise walk *down* the ladder `quality → balanced → cheap → local`
   from T; first allowed tier wins (Balanced degrades to Cheap for a
   basic user allowed `[cheap, local]`).
3. Nothing allowed below → walk *up*; nearest allowed tier above wins.
4. The effective tier resolves through the routing table as today. A
   granted quality tier implies its routed provider/model (the routing
   table is server-curated); the provider/model lists are not additionally
   consulted on this path.

**Direct request** (provider P, model M):
1. P allowed and M permitted → unchanged.
2. P allowed, M not on P's allowlist → degrade to the first model on P's
   allowlist.
3. P not allowed → fall back to tier routing at the user's best allowed
   quality tier for the document's language.

**Floor:** if a tier's `llm.tiers` and `llm.providers` are both empty, that
user tier has no LLM checking: the UI hides the LLM phase, the backend
skips LLM jobs.

**Degradation is visible, never silent:** check results and SSE events
carry an `effective_llm` block — requested vs. effective tier/provider/
model plus `degraded: bool` — so the UI can show e.g. "ran on Cheap
(Mistral Small) — Balanced requires Premium". Selecting a global profile
therefore never errors, regardless of what its LLM settings reference.

With degradation, 403 disappears from the normal LLM flow. 403 remains
only for genuinely forbidden *actions*: admin endpoints, feature-gated
creates.

### 6.3 Feature gating

Named feature flags, checked at the respective create endpoints:

- `custom_profiles` — may create own (private) profiles. Without it: 403
  on profile create; global profiles remain usable.
- `custom_domains` — may create own terminology domains (and terms within
  them). Without it: 403 on domain create; global domains and their terms
  remain usable read-only.

Editing/deleting one's *existing* private items stays allowed even if the
flag is later removed from the tier — the gate is on creation.

### 6.4 Quotas

v1 enforces exactly one rule, in one function
(`check_quota(user, limits) -> QuotaDecision`): the count of `llm_usage`
rows for (user, today-UTC) must be below `llm_checks_per_day`. The check
and the ledger insert happen in **one SQLite transaction**
(insert-then-count-and-roll-back-if-over), so concurrent check starts
cannot both slip under the limit (TOCTOU).

Quota exhaustion degrades, it does not fail: rules and terminology checkers
still run; the LLM phase is skipped and the scorecard/SSE reports
`quota_exhausted` (with limit and reset day). HTTP 429 is not used.

Future limit shapes (per LLM tier, per model, `tokens_per_day`) extend
`check_quota` and the config schema only; the ledger already records every
needed dimension. Stated constraint: token-based limits are enforced
*between* runs ("no further runs once exceeded"), never as mid-run cutoffs
— token cost is only known when a run finishes.

### 6.5 Document size limits

Two limits, two behaviors:

1. **Global cap** (`limits.max_document_chars`, applies to everyone):
   enforced wherever text enters — document create/save and check creation
   return **413** with a clear message when text exceeds it. A request-size
   middleware caps request bodies at 5 MB (comfortably above any legal
   payload under the char cap): oversized `Content-Length` is rejected
   before parsing, **and** the byte budget is enforced on the bytes
   actually read, so chunked/streamed requests without a `Content-Length`
   header cannot bypass the cap.
2. **Per-tier LLM cap** (`max_llm_document_chars`): exceeding it skips
   only the LLM phase — rules/terminology still run — and the scorecard/
   SSE reports `document_too_large` with the tier's limit, analogous to
   `quota_exhausted`. Characters are the pre-spend proxy for tokens:
   imprecise across languages, but enforceable before money is spent.

Existing documents larger than a later-tightened cap stay loadable and
rule-checkable; the caps gate new saves and the LLM phase, never access to
data.

## 7. API surface

### 7.1 New endpoints

| Endpoint | Auth | Behavior |
|---|---|---|
| `POST /api/auth/login` | none | §4.2. 401 (generic) on any failure. |
| `GET /api/auth/me` | user | User + tier + `is_admin` + effective LLM policy + feature flags + quota status (`used_today`, `limit`) + size limits (global and tier). The frontend's single source of truth for gating. |
| `POST /api/auth/password` | user | Change own password; re-verifies current one. |
| `GET /api/admin/users` | admin | List users (no password hashes in responses — a dedicated response model, never the row). |
| `POST /api/admin/users` | admin | Create user: email, display name, initial password, tier, admin flag. 422 on duplicate email/invalid input. |
| `PATCH /api/admin/users/{id}` | admin | Update tier / admin flag / active flag / display name / reset password. Admins cannot deactivate or de-admin themselves (409) — prevents lockout. |

No hard user delete in v1: deactivation preserves `owner_id` referential
integrity.

**Admin audit trail:** every admin mutation (create user, tier/role/active
change, password reset) appends a row to a small `admin_audit` table
(actor user id, target user id, field, old → new value where sensible —
never password material — and timestamp). Cheap now, painful to retrofit
once there is more than one admin.

### 7.2 Changes to existing endpoints

- All existing `/api/*` endpoints require authentication.
- Store queries are owner-scoped. Requesting another user's resource
  returns **404** (indistinguishable from nonexistent — no existence
  leak). Mutating a global (owner NULL) profile/domain as non-admin: 403.
- `/api/routing` and `/api/providers` responses gain a per-entry
  `allowed: bool` computed for the caller, alongside the existing
  `available`/`reason` — the UI distinguishes "not on your plan" from
  "not configured on the server".
- Check jobs (`POST /api/checks`, `GET /api/checks/{id}`, SSE events)
  remember their owner; polling or subscribing to another user's check is
  404. LLM phase start applies, in order: size cap (§6.5) → quota (§6.4)
  → `resolve_llm_selection` (§6.2), then records to the ledger.
- **Every LLM-invoking endpoint goes through the same gate** — not just
  checks. `POST /api/suggestions` and document name generation also
  accept provider/model parameters and call the provider factory today;
  un-gated they would bypass tier policy and quota entirely. Provider
  acquisition is therefore centralized behind one function
  (`get_effective_provider(user, requested, language)`) that applies
  quota + `resolve_llm_selection` and writes the ledger row; no route
  reaches `provider_factory` directly. (Suggestion/name-generation runs
  count toward the same `llm_checks_per_day` in v1 — one quota, no
  separate bucket.)
- Error semantics overall: **401** unauthenticated / bad token, **403**
  forbidden action, **404** not yours / nonexistent, **413** over the
  global size cap, **422** validation (unchanged), **429** unused.

### 7.3 SSE authentication

`EventSource` cannot set headers, so the SSE client in
`frontend/src/api/client.ts` switches to a `fetch()`-based stream reader:
`Authorization: Bearer` header like every other call, `text/event-stream`
parsed from the response `ReadableStream` (~30 lines, both ends ours; our
streams are one-shot and short-lived, so `EventSource` auto-reconnect is
not a loss). Cancellation uses `AbortController`, integrating with the
existing `cancelCheck()` machinery.

**Principle (binding for future work): tokens never appear in URLs.** Query
strings persist in server/proxy/edge access logs; a logged bearer token is
a credential at rest in infrastructure we don't control. If a future
feature genuinely needs a URL credential (e.g. a download link), it mints a
single-use, seconds-lived ticket — never the session token.

### 7.4 CORS

`allow_origins` tightens from `*` to a configured list,
default `["http://localhost:5173"]` (config: `cors.origins`).

## 8. Frontend

- **Auth slice** (zustand, persisted): token, user, policy from
  `/api/auth/me`. The API client attaches the Bearer header to every
  request; any 401 response clears auth state and shows the login view.
- **Login view**: email/password form, error states, i18n ×7 like all UI.
- **Admin view** (visible only when `is_admin`): user table — list,
  create, edit tier/role/active, reset password.
- **Gating**: selectors grey out disallowed quality tiers / providers /
  models using the `/me` policy and the `allowed` flags, with a "requires
  Premium"-style hint, visually distinct from "not configured". The check
  status area shows degradation notes from `effective_llm`, and
  `quota_exhausted` / `document_too_large` skip notices. A modest
  used/limit quota indicator sits near the LLM controls. The editor's
  character count marks the tier LLM threshold and the global cap
  distinctly.
- **User-switch hygiene**: the *entire* persisted store (the existing
  `fabulous-writing-settings` blob, not only the auth slice) is namespaced
  by user id or purged on login/logout — a stale `currentDocId` or any
  future content-bearing persisted field must not survive into another
  user's session on a shared browser.
- **XSS constraint (binding)**: no user-supplied or LLM-generated content
  is ever rendered as raw HTML — no `dangerouslySetInnerHTML` on
  findings, suggestions, messages, or names, anywhere. With a bearer
  token in localStorage (matching Supabase Auth's own default), an XSS
  sink is the one thing that turns into account theft; this constraint is
  what keeps the storage choice sound. Logout clears client state only —
  a captured token stays valid until `exp` (24 h); accepted as a
  conscious tradeoff of the stateless design at this user scale.

## 9. Migration & rollout

All migrations follow the house rules: additive, idempotent
(`IF NOT EXISTS` / guarded backfills), rehearsed on a copy of the live DB
before ever touching it; the live `backend/data/fabulous.db` is never used
in tests.

1. Create `users` (§5.1) and `llm_usage` (§5.3).
2. Seed the admin account from `FW_ADMIN_EMAIL` / `FW_ADMIN_PASSWORD` env
   vars — only when `users` is empty. The admin gets id 1, so existing
   `documents`/`folders` rows (`owner_id = 1`) already belong to it.
   Startup fails with a clear error if the table is empty and the
   variables are unset (an unauthenticatable instance is useless).
3. Add `owner_id` to `profiles` and `domains`. Backfill: profile rows
   carrying a seed marker → NULL (global); domains whose names match the
   seed set defined in `app/services/seed.py` → NULL (domains have no seed
   markers, so name-match is the identifying rule — a renamed seed domain
   stays private to the admin, which is acceptable); all other existing
   rows → 1. The name-match backfill runs **exactly once** — only in the
   migration step that adds the `owner_id` column, against the pre-auth
   single-owner DB — never as a recurring rule that could misclassify a
   future user's domain sharing a seed name.
3a. Create `admin_audit` (§7.1).
4. Folder name uniqueness becomes per-owner: replace the global NOCASE
   unique index with `UNIQUE (owner_id, name COLLATE NOCASE)` semantics
   (partial index for non-NULL owners; same duplicate pre-scan +
   skip-with-warning pattern as the original NOCASE migration). Same
   pattern for any other per-user name-unique resources (profiles,
   domains).

## 10. Testing

- **Backend**: login/token unit tests (success, wrong password, unknown
  email, inactive user, expired/garbage token, wrong-algorithm token
  rejected, login throttle kicks in); `resolve_llm_selection` exhaustive
  table tests (every tier×policy path incl. floor and walk-up); quota
  tests incl. UTC day rollover, transactional concurrency (two
  simultaneous starts at limit−1 admit exactly one), and
  cancelled-run-keeps-ledger-row; the suggestions/name-generation
  endpoints hit the same gate (a basic user cannot obtain a premium
  provider through them); size-limit tests (413 path, LLM skip path, and
  a chunked body without Content-Length is capped); ownership isolation
  (user A cannot read/mutate B's items; non-admin cannot mutate globals;
  term mutation checks the parent domain's owner; cross-user check
  polling is 404); admin endpoint tests incl. self-lockout prevention and
  audit rows written; migration tests against a pre-auth schema fixture
  (admin seeding, owner backfill, per-owner uniqueness).
- **Frontend**: vitest for the auth slice, 401-clears-auth behavior, and
  the fetch-based SSE reader; the usual `tsc`/lint/build gates.
- **E2E**: the scratch-stack script gains a login step; a two-user
  isolation smoke test (admin creates a basic user; each sees only their
  own documents; basic user sees degradation note on a Balanced-tier
  profile).

## 11. Out of scope (this sub-project)

- Supabase verifier implementation, user provisioning, invite flows
  (sub-project 2; only the `TokenVerifier` interface and `auth.mode`
  config slot land now). **Binding constraints on that future work,
  because the interface is defined here:** linking a Supabase identity to
  a local user row is an explicit admin action (or an admin-approved
  first-login confirmation) — a Supabase-supplied email must **never**
  auto-adopt an existing local row, especially not an admin one
  (email-match linking would allow privilege takeover via a
  attacker-registered Supabase account). And in `auth.mode: supabase`,
  local login and `LocalTokenVerifier` are disabled entirely (§4.1).
- Fly.io deployment (sub-project 3). Binding precondition: the instance
  must not be publicly reachable before the deployment sub-project has
  addressed HTTPS, CORS reconfiguration, and production secrets.
- Email flows of any kind (password reset is admin-driven).
- Refresh tokens and token revocation (a captured token lives ≤ 24 h;
  Supabase brings refresh semantics). v1 *does* include the lightweight
  login throttle (§4.2); distributed/robust rate limiting comes with
  Supabase.
- Per-user API keys for LLM providers.
- Hard user deletion / data export.
