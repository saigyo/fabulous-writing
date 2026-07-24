# Multi-User Capability & Authentication — Design

**Date:** 2026-07-24
**Status:** Draft for review

## 1. Goal

Make Fabulous Writing usable by a limited number of users: user accounts, a
tier/permission system, ownership isolation of user data, and a local
email/password authentication that exercises the same code path a later
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
| Local auth | Email/password against local `users` table; backend-issued HS256 JWT. There is no separate username — email is the login identifier. |
| Tier ladder | Two tiers: `basic`, `premium`. Admin is a separate boolean flag, not a tier. |
| Tiers control | LLM access (quality tiers / providers / models), usage quotas, feature gating. |
| Enforcement style | Graceful degradation for LLM selection and quotas; hard errors only for forbidden actions and the global size cap (413, §6.5). |
| Ownership | `documents`/`folders` strictly per-user. `profiles`/`domains` global built-ins (owner NULL, read-only for non-admins) + per-user private items. Rule YAMLs and provider config stay server-global. |
| Admin surface | Small admin UI page (list/create/edit users) + admin API. |
| SSE auth | Bearer header via fetch-based streaming. No tokens in URLs, ever. |

## 4. Architecture

### 4.1 Request authentication

Every `/api/*` request except `/api/health` and `POST /api/auth/login`
requires `Authorization: Bearer <JWT>`. (FastAPI's `/docs` and
`/openapi.json` live outside `/api/*` and remain public — they expose the
API schema only, no data; acceptable and deliberate.)

One FastAPI dependency resolves identity:

```
get_current_user(request) -> CurrentUser
  1. extract Bearer token (401 if missing/malformed)
  2. user_id = TokenVerifier.verify(token)       # 401 on invalid/expired
  3. user = UserStore lookup (by local user id)  # 401 if unknown or inactive
  4. return CurrentUser(id, email, display_name, tier, is_admin)
```

`TokenVerifier` is a small protocol whose contract is mode-independent:
**`verify` returns the local `users.id`** in every mode, so
`get_current_user` never changes lookup keys when the auth mode switches:

```python
class TokenVerifier(Protocol):
    def verify(self, token: str) -> int: ...
    # returns the LOCAL users.id; raises InvalidToken on any failure
```

The local verifier parses its own `sub` (the local id it issued). The
Supabase verifier performs the `sub`-UUID → `users.external_id` resolution
internally and **fails closed** (InvalidToken → 401) for a valid Supabase
token whose identity is not linked to a local user row.

Implementations:

- **`LocalTokenVerifier`** (built now): HS256. Claims: `sub` (user id as
  string), `exp` (24 h from issue), `iat`, `iss` and `aud` (both
  `"fabulous-writing"`, per the pinning rules below).
- **`SupabaseTokenVerifier`** (interface + config slot now, implementation
  in sub-project 2): RS256 via Supabase JWKS; maps the Supabase `sub` UUID
  to `users.external_id`.

**Algorithm and claim pinning (binding):** each verifier decodes with an
explicit single-element `algorithms` list (`["HS256"]` resp. `["RS256"]`)
and rejects everything else — never `none`, never a foreign algorithm —
and validates `exp`/`iat` **and** `iss`/`aud`. `exp`, `iss`, and `aud`
are strict; `iat` is required but rejected only when it lies more than a
60-second leeway window in the future — otherwise minor clock drift
between the API server and the token issuer (notably Supabase's signing
service later) would cause intermittent 401s. Local tokens are issued
with `iss: "fabulous-writing"` and `aud: "fabulous-writing"` and the
local verifier requires exactly those; the Supabase verifier must require
the project's issuer URL and Supabase's `aud` (`authenticated`), so a
token minted for a different project or environment is never accepted. A
unit test asserts that tokens with a different algorithm, issuer, or
audience are rejected (the classic `alg: none` / RS256→HS256 confusion
bugs, plus cross-environment token reuse).

**Secret handling (local mode only** — a `supabase`-mode instance neither
needs nor reads an HS256 secret, and must not fail over its absence**):**
the HS256 secret comes from `FW_AUTH_SECRET`, must be
≥ 32 characters (startup error otherwise), and must be generated randomly
— e.g. `openssl rand -base64 32` (length is the mechanical gate; the
random-generation requirement is documented in `config.example.yaml` and
the README, since entropy cannot be verified programmatically). If unset,
startup **fails** — unless config sets `auth.ephemeral_secret: true` (set
in the git-ignored local dev `config.yaml`, documented in the tracked
`config.example.yaml`; deployment configs must not set it), in which case
a random per-start secret is generated with a logged warning — which
states the fact, never the secret value (a credential must not land in
logs) — and tokens die on restart, deliberately self-sabotaging outside
dev.

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

**Client IP derivation (binding):** in v1 (no proxy in front) the client
IP is `request.client.host` — forwarded headers are **ignored**.
`X-Forwarded-For`/`Forwarded` must only ever be honored when the direct
peer is on an explicitly configured trusted-proxy list (uvicorn
`--forwarded-allow-ips` / ProxyHeadersMiddleware with the proxy's
address), which the Fly.io deployment (sub-project 3) will configure.
Trusting forwarded headers unconditionally would let an attacker mint
fresh spoofed IPs per request and bypass the throttle entirely; ignoring
them behind a proxy would collapse all clients to the proxy IP (the email
dimension keeps that failure contained to per-account backoff, but the
deployment must still set the trusted list).

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
    created_at    TEXT NOT NULL          -- ISO 8601 UTC ('…T…+00:00'), as in existing tables
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
  non-defaulted** parameter (a Python-signature guarantee), so a
  forgotten scope is a call-site error rather than a cross-tenant read.
  Honest caveat: both columns carry a legacy `DEFAULT 1`, so SQL alone
  would not catch a missing owner on INSERT — the `folders` rebuild in
  §9.5 drops that default; `documents` needs no rebuild and keeps it, so
  its guarantee rests on the store API signature.
- `profiles`, `domains`: gain a *nullable* `owner_id` column (NULL is the
  deliberate global marker here). List endpoints return global rows plus
  the caller's rows; create always as the caller (feature-gated, see
  §6.3); update/delete of a global row requires admin. The **startup
  seeders** (`seed_profiles`, `seed_terminology`, which run on every app
  start) are the one exception to create-as-the-caller: they maintain the
  global set exclusively — their presence checks (e.g. "does this
  language have a Standard profile?", "are there any domains?") query
  only `owner_id IS NULL` rows, and everything they create is written
  with `owner_id NULL`. A fresh multi-user install therefore gets its
  built-ins global, not owned by user 1.
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
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL,
    day                TEXT NOT NULL,      -- 'YYYY-MM-DD', UTC; the indexed quota key
    created_at         TEXT NOT NULL,      -- ISO 8601 UTC, reservation time
    status             TEXT NOT NULL,      -- 'started' → 'completed' | 'failed' | 'cancelled'
    llm_tier           TEXT,               -- effective quality tier whenever the effective
                                           -- selection came via tier routing (incl. the
                                           -- direct-request fallback in §6.2); NULL only for
                                           -- a genuinely direct effective selection
    provider           TEXT NOT NULL,      -- effective provider
    model              TEXT NOT NULL,      -- effective model
    requested_tier     TEXT,               -- what the profile/folder/request asked for;
    requested_provider TEXT,               -- NULL where that dimension was not requested.
    requested_model    TEXT,               -- Degradation = requested_* ≠ effective (§6.2)
    text_chars         INTEGER NOT NULL,   -- pre-run size proxy, known at reservation
    input_tokens       INTEGER,            -- NULL when the provider reports nothing
    output_tokens      INTEGER,
    source             TEXT NOT NULL,      -- 'check' | 'suggestion' | 'name'
    run_id             TEXT NOT NULL       -- correlation id: the natural id where one exists
                                           -- (check id); callers without one (name generation)
                                           -- mint a UUID
);
CREATE INDEX idx_llm_usage_user_day ON llm_usage(user_id, day);
```

**Why these columns exist from run one.** Adding a *table* later is cheap;
adding a *column* to a table already accumulating rows leaves a permanent
hole in the history, because nothing can backfill what was never written.
The four beyond bare metering each answer a question that only has an
answer if recorded from the start: `created_at` (time-of-day patterns and
correlating a cost spike with an incident — `day` alone cannot);
`status` (the spec deliberately keeps failed and cancelled rows, so
without it a burned-tokens failure is indistinguishable from a clean run);
`requested_*` (how often a user tier hits its ceiling — the tier-tuning
and upsell signal; the value is already computed for the `effective_llm`
UI block and would otherwise be discarded); `text_chars` (the only cost
proxy for a run that dies before any provider reports tokens).

The ledger covers **every** LLM-invoking endpoint (§7.2), not only checks —
hence the source-agnostic `run_id` (not `check_id`) plus a `source` column
so future per-feature limits or cost analysis need no schema change.

A row is inserted with `status = 'started'` when an LLM run starts
(effective and requested selection plus `text_chars` recorded); the token
counts and the terminal `status` are written when the run ends. **Failed
or cancelled runs keep their ledger row** (`status = 'failed'` /
`'cancelled'`, token columns holding whatever was reported before the
end) — failures still spend quota, so cancel-and-retry loops cannot hit
providers for free. A process crash can leave a row at `'started'`
forever; that is accepted (it still counted against quota, which is the
conservative direction) and such rows are simply reported as `started` in
any analysis.

Record richly, limit simply: v1 enforces only one rule (§6.4), but every
future limit dimension (per LLM tier, per model, token-based) is
computable from this ledger without schema changes.

**Deliberately deferred:** a general user-activity audit (logins,
document/profile/domain CRUD). That is a *new table* — trivially added
later, with only unwritten history lost, which is worth little at this
user scale where the server log and `updated_at` fields cover the
practical questions. It is also kept **separate** from `llm_usage` when it
does arrive: the ledger sits on the quota hot path (an indexed count
inside the reservation transaction), and mixing high-volume, low-value
activity rows into that table would make rate limiting scan noise.

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
Validation at load time: unknown LLM tier names, unknown feature names,
unknown provider names (in `llm.providers` and as `models` keys — a typo
must not silently narrow a policy), `models` keys not listed in
`providers`, non-positive limits, and **empty per-provider model
allowlists** (an empty list would leave the degradation substitute in
§6.2 undefined; "no models" is expressed by omitting the provider from
`providers`) are config errors.

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
4. If `llm.tiers` is empty but `llm.providers` is not (a direct-only
   policy), a tier-based request degrades exactly like rule 3 of the
   direct path below: first provider in `llm.providers` with its first
   allowlisted model — or, under `models: all`, that provider's
   configured default model. (Without this rule the case would be
   undefined: it is not the floor, which requires *both* lists empty.)
5. The effective tier (when one was selected) resolves through the
   routing table as today. A granted quality tier implies its routed
   provider/model (the routing table is server-curated); the
   provider/model lists are not additionally consulted on this path.

**Direct request** (provider P, model M):
1. P allowed and M permitted → unchanged.
2. P allowed, M not on P's allowlist → degrade to the first model on P's
   allowlist.
3. P not allowed → fall back to tier routing at the user's best allowed
   quality tier for the document's language. If `llm.tiers` is empty
   (a direct-only policy), degrade instead to the first provider in
   `llm.providers` with its first allowlisted model — or, under
   `models: all`, that provider's configured default model. If
   `llm.providers` is also empty, the floor case below applies.

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

v1 enforces exactly one rule, in one function —
`reserve_llm_run(user, limits, requested, effective, text_chars, source,
run_id) -> QuotaDecision` (everything the reservation row records is a
parameter; §5.3's NOT NULL columns are unreachable from `(user, limits)`
alone) — inside **one SQLite transaction** so
concurrent starts cannot both slip under the limit (TOCTOU). Stated
precisely to avoid an off-by-one: insert the reservation row, then count
this user's rows for today-UTC *including the one just inserted*;
**commit iff `count <= llm_checks_per_day`, else roll back** (the run is
denied). A user with a limit of 20 therefore gets exactly 20 runs per UTC
day.

**Admins take the same insert path with the commit condition skipped**:
their runs are always admitted but still recorded — §5.3's "every LLM
run" includes admins, so the highest-privilege account is not exempt from
cost visibility. `/api/auth/me` reports `limit: null` for admins and the
UI hides the quota indicator.

Quota exhaustion degrades, it does not fail: rules and terminology checkers
still run; the LLM phase is skipped and the scorecard/SSE reports
`quota_exhausted` (with limit and reset day). HTTP 429 is not used.
(Endpoints whose entire product is LLM output degrade differently — see
§7.2.)

Future limit shapes (per LLM tier, per model, `tokens_per_day`) extend
`reserve_llm_run` and the config schema only; the ledger already records every
needed dimension. Stated constraint: token-based limits are enforced
*between* runs ("no further runs once exceeded"), never as mid-run cutoffs
— token cost is only known when a run finishes.

### 6.5 Document size limits

Two limits, two behaviors:

1. **Global cap** (`limits.max_document_chars`, applies to everyone):
   enforced wherever text enters — document create/save and check creation
   return **413** with a clear message when text exceeds it. A request-size
   middleware caps request bodies at a byte budget **derived from the char
   cap** — `max(5 MB, 4 × max_document_chars + 1 MB)` (UTF-8 worst case
   plus JSON overhead) — so tuning `max_document_chars` upward can never
   silently create a state where legal payloads are rejected by a stale
   fixed byte limit. Oversized `Content-Length` is rejected before
   parsing, **and** the byte budget is enforced on the bytes actually
   read, so chunked/streamed requests without a `Content-Length` header
   cannot bypass the cap. Middleware order: `CORSMiddleware` sits
   outermost, so a 413 still carries CORS headers and is readable by the
   browser instead of surfacing as an opaque network error.
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
| `GET /api/auth/me` | user | User + tier + `is_admin` + effective LLM policy + feature flags + quota status (`used_today`, `limit`; `limit: null` for admins, §6.4) + size limits (global and tier). `used_today` is defined identically to `reserve_llm_run`'s count: *started* ledger rows for the UTC day, regardless of run completion (§5.3/§6.4) — no UI/backend drift. The frontend's single source of truth for gating. |
| `POST /api/auth/password` | user | Change own password; re-verifies current one. |
| `GET /api/admin/users` | admin | List users (no password hashes in responses — a dedicated response model, never the row). |
| `POST /api/admin/users` | admin | Create user: email, display name, initial password, tier, admin flag. 422 on duplicate email/invalid input. |
| `PATCH /api/admin/users/{id}` | admin | Update tier / admin flag / active flag / display name / reset password. Admins cannot deactivate or de-admin themselves (409) — prevents lockout. |

No hard user delete in v1: deactivation preserves `owner_id` referential
integrity.

**Admin audit trail:** every admin mutation (create user, tier/role/active
change, password reset) appends a row to `admin_audit`. Cheap now,
painful to retrofit once there is more than one admin:

```sql
CREATE TABLE admin_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   INTEGER NOT NULL,       -- admin performing the action
    target_id  INTEGER NOT NULL,       -- user acted upon
    field      TEXT NOT NULL,          -- 'created'|'tier'|'is_admin'|'is_active'|'display_name'|'password'
    old_value  TEXT,                   -- NULL for 'created' and 'password' (never password material)
    new_value  TEXT,                   -- NULL for 'password'
    created_at TEXT NOT NULL           -- ISO 8601 UTC
);
```

### 7.2 Changes to existing endpoints

- All existing `/api/*` endpoints require authentication.
- Store queries are owner-scoped. Requesting another user's resource
  returns **404** (indistinguishable from nonexistent — no existence
  leak). Mutating a global (owner NULL) profile/domain as non-admin: 403.
- Profile and domain responses include an `is_global: bool` field (derived
  from `owner_id IS NULL`) so the client can distinguish a user's private
  item from a global built-in — including when they share a `name`
  (per-owner uniqueness does not span the global set) — and render
  read-only vs. edit/delete affordances correctly.
- `/api/routing` and `/api/providers` responses gain a per-entry
  `allowed: bool` computed for the caller, alongside the existing
  `available`/`reason` — the UI distinguishes "not on your plan" from
  "not configured on the server". Semantics: on `/api/providers`,
  `allowed` means *allowed for direct selection* (`llm.providers`) — a
  provider outside that list can still legitimately serve a routed
  quality-tier run (§6.2 rule 5); on `/api/routing`, each quality tier's
  `allowed` comes from `llm.tiers`.
- Check jobs (`POST /api/checks`, `GET /api/checks/{id}`, SSE events)
  remember their owner; polling or subscribing to another user's check is
  404. LLM phase start applies, in order: size cap (§6.5) →
  `resolve_llm_selection` (§6.2) → quota reservation (§6.4). Resolution
  runs first because the quota check *is* the transactional insert of the
  reservation ledger row (§5.3), and that row records the effective
  provider/model — so the order preserves both TOCTOU safety and the
  ledger's NOT NULL columns.
- **Every LLM-invoking endpoint goes through the same gate** — not just
  checks. `POST /api/suggestions` (which accepts provider/model
  parameters) and document name generation (which accepts none — it
  hard-selects the cheap route) both reach the provider factory directly
  today; un-gated they would bypass tier policy and quota entirely.
  Provider acquisition is therefore centralized behind one function
  (`get_effective_provider(user, requested, language, text)`) applying
  the same order as checks — size cap (§6.5) → `resolve_llm_selection`
  (§6.2) → quota reservation (§6.4) — and no route reaches
  `provider_factory` directly. All runs count toward the same
  `llm_checks_per_day` (one quota, no separate bucket).
- **Degradation for LLM-only endpoints:** "skip the LLM phase, rules
  still run" is meaningless where the LLM output *is* the product. When
  the gate denies (quota exhausted, text over the tier cap, no-LLM
  floor), `POST /api/suggestions` returns **200** with an empty
  suggestion list and a machine-readable `skipped` reason using the same
  codes as the scorecard (`quota_exhausted`, `document_too_large`,
  `llm_unavailable`), which the UI surfaces like the check-status notes;
  name generation silently uses its existing local fallback naming. 403
  and 429 remain unused on these paths.
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

Auth never breaks preflight: `CORSMiddleware` wraps the app ahead of
routing, so browser `OPTIONS` preflight requests are answered by the
middleware before any auth dependency runs — preflight requires no token.
(A test asserts that an unauthenticated `OPTIONS` to an authenticated
route returns the CORS preflight response, not 401.)

## 8. Frontend

- **Auth slice** (zustand, persisted): token, user, policy from
  `/api/auth/me`. The API client attaches the Bearer header to every
  request; any 401 response clears auth state and shows the login view —
  **except** from `POST /api/auth/login` itself, whose 401 is the
  bad-credentials signal the login form handles inline (otherwise a wrong
  password would trigger a state-clearing loop).
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
- **XSS defense-in-depth (binding)**: with a bearer token in localStorage
  (matching Supabase Auth's own default), any successful XSS is account
  theft — so the defense is layered, not a single rule. (1) No
  user-supplied or LLM-generated content is ever rendered as raw HTML —
  no `dangerouslySetInnerHTML` on findings, suggestions, messages, or
  names, anywhere. (2) No dynamic `href`/`src` from user or LLM content
  without scheme validation (no `javascript:` URLs). (3) The production
  deployment (sub-project 3) must serve the frontend with a strict
  Content-Security-Policy (`default-src 'self'`, no inline scripts,
  `connect-src` limited to the API origin) — recorded here as a binding
  requirement on that sub-project. (4) Dependency hygiene stays covered
  by the existing dependabot + CI setup. Logout clears client state only
  — a captured token stays valid until `exp` (24 h); accepted as a
  conscious tradeoff of the stateless design at this user scale. The
  emergency lever for a compromised account is **admin deactivation**,
  which bites on the very next request because `get_current_user`
  re-reads the user row per request (§4.1) — effectively immediate
  revocation without token state.

## 9. Migration & rollout

All migrations follow the house rules: idempotent (`IF NOT EXISTS` /
guarded backfills / rebuild-only-if-old-shape), rehearsed on a copy of
the live DB before ever touching it; the live `backend/data/fabulous.db`
is never used in tests. Additive where possible — but this iteration
**necessarily includes guarded table rebuilds** (step 5): `folders.name`
carries an *inline* `UNIQUE` and `profiles` a table-level
`UNIQUE(language, name)`, both enforcing global cross-owner uniqueness,
and SQLite cannot drop such constraints without the documented 12-step
table rebuild. Purely index-level changes cannot deliver per-owner
uniqueness here.

1. Create `users` (§5.1) and `llm_usage` (§5.3).
2. Seed the admin account from `FW_ADMIN_EMAIL` / `FW_ADMIN_PASSWORD` env
   vars — only when `users` is empty. The admin gets id 1, so existing
   `documents`/`folders` rows (`owner_id = 1`) already belong to it.
   Startup fails with a clear error if the table is empty and the
   variables are unset (an unauthenticatable instance is useless). This
   seeding-and-failure behavior is **local-mode-only** (`auth.mode:
   local`); in `supabase` mode local login is disabled and bootstrapping
   an empty instance is handled by sub-project 2's provisioning/linking
   design.
3. Add `owner_id` to `profiles` and `domains`. Backfill to NULL (global)
   by **name-match against the seed sets** — for *both* tables, because
   neither has per-row seed markers (`profile_seed_markers` records only
   *that a language was seeded*, keyed by language — not which rows are
   seeds):
   - profiles: rows with `is_standard = 1`, plus rows whose
     `(language, name)` matches the seed set of
     `backend/app/services/seed_profiles.py` for a language present in
     `profile_seed_markers`;
   - domains: rows whose names match the seed set defined in
     `backend/app/services/seed.py`.
   All other existing rows → 1. Acknowledged risk for both tables alike:
   a pre-existing user item occupying a seed name becomes global — at
   migration time every row belongs to the admin, so the misclassification
   is confined to the admin's own items and is acceptable. The name-match
   backfill runs **exactly once** — only in the migration step that adds
   the `owner_id` column, against the pre-auth single-owner DB — never as
   a recurring rule.
4. Create `admin_audit` (§7.1).
5. Name uniqueness becomes per-owner. Table by table:
   - **`folders`** (rebuild required — inline `UNIQUE` on `name`): 12-step
     rebuild to a schema without the inline constraint and without the
     legacy `DEFAULT 1` on `owner_id`; uniqueness then comes from one
     unique index `(owner_id, name COLLATE NOCASE)` (`owner_id` is
     NOT NULL here, so no partial form is needed).
   - **`profiles`** (rebuild required — table-level
     `UNIQUE(language, name)`): 12-step rebuild dropping that constraint;
     then **two partial unique indexes** that keep the `language`
     dimension — it is load-bearing, since the global built-ins repeat
     names per language (`Standard` × 7) and a user may hold the same
     profile name in several languages:
     `(owner_id, language, name COLLATE NOCASE) WHERE owner_id IS NOT NULL`
     and `(language, name COLLATE NOCASE) WHERE owner_id IS NULL`.
   - **`domains`** (no rebuild — no existing unique constraint): **two
     partial unique indexes**, `(owner_id, name COLLATE NOCASE) WHERE
     owner_id IS NOT NULL` and `(name COLLATE NOCASE) WHERE owner_id IS
     NULL`. Two are needed because SQLite treats NULLs as distinct in
     unique indexes — a single composite index would let duplicate global
     names pass.
   Every index creation is preceded by the duplicate pre-scan +
   skip-with-warning pattern from the original NOCASE migration —
   explicitly including `domains`, which never had a uniqueness guarantee
   and may legally hold duplicates today. Rebuilds are guarded (run only
   when the old shape is detected) to stay idempotent.

## 10. Testing

- **Backend**: login/token unit tests (success, wrong password, unknown
  email, inactive user, expired/garbage token, wrong-algorithm token
  rejected, login throttle kicks in); `resolve_llm_selection` exhaustive
  table tests (every tier×policy path incl. floor and walk-up); quota
  tests incl. UTC day rollover, transactional concurrency (two
  simultaneous starts at limit−1 admit exactly one), and
  cancelled-run-keeps-ledger-row; ledger completeness (a reserved row
  carries `created_at`, `text_chars`, `status = 'started'` and both the
  requested and effective selection; the terminal status and token counts
  land on completion, failure, and cancellation alike); the suggestions/name-generation
  endpoints hit the same gate (a basic user cannot obtain a premium
  provider through them); size-limit tests (413 path, LLM skip path, and
  a chunked body without Content-Length is capped); ownership isolation
  (user A cannot read/mutate B's items; non-admin cannot mutate globals;
  term mutation checks the parent domain's owner; cross-user check
  polling is 404); the `resolve_llm_selection` table includes the
  direct-only-policy cell (tier-based request under `llm.tiers: []`, §6.2
  rule 4); suggestions degradation (denied gate returns 200 with a
  `skipped` reason, never 403/429); admin runs are admitted with the
  commit condition skipped but still write ledger rows; startup seeders
  create only `owner_id IS NULL` rows on a fresh multi-user DB; admin
  endpoint tests incl. self-lockout prevention and audit rows written;
  migration tests against a pre-auth schema fixture (admin seeding, owner
  backfill incl. the profiles name-match rule, the guarded
  `folders`/`profiles` rebuilds preserving every row and dropping the old
  constraints, per-owner uniqueness incl. the global-set partial
  indexes).
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
- A general user-activity audit log (logins, CRUD) and any ledger
  retention/pruning policy — both are additive later; the rationale for
  deferring them, and for keeping such a log separate from `llm_usage`,
  is in §5.3.
