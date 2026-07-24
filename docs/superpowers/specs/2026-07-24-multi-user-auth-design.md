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

The `auth:` config section holds `mode`, `ephemeral_secret`, and
`allow_additional_admins` (§7.1) — all read at startup and changeable
only on disk, never through the API.

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
                                           -- | 'abandoned' (swept, §6.6)
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
providers for free. A crash or a hung task can leave a row at
`'started'`; because the in-flight count for the concurrency caps is
derived from exactly those rows, such rows are not left to linger but
swept to `'abandoned'` by the startup sweep and staleness rule in §6.6.
They still count against the daily quota — they consumed a reservation.

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
  max_concurrent_llm_runs: 20  # server-wide, protects the machine
  llm_run_max_age: 900         # seconds; older 'started' rows are swept (§6.6)
  concurrency_reject_delay: 0.25   # seconds of backpressure before a 429 (§6.6)
  admin:                       # blast-radius ceiling for admins, config-only
    llm_checks_per_day: 500
    max_llm_document_chars: 200000
    concurrent_llm_runs: 5

tiers:
  basic:
    llm:
      tiers: [cheap, local]       # allowed LLM quality tiers
      providers: [ollama]         # allowed for direct provider selection
      models: all                 # or per-provider allowlists, see below
    limits:
      llm_checks_per_day: 20
      max_llm_document_chars: 20000
      concurrent_llm_runs: 3
    features: []
  premium:
    llm:
      tiers: all
      providers: all
      models: all
    limits:
      llm_checks_per_day: 200
      max_llm_document_chars: 100000
      concurrent_llm_runs: 5
    features: [custom_profiles, custom_domains]
```

`models` is either `all` or a mapping `provider -> ordered list of allowed
models` (first entry = preferred substitute for degradation). A provider
absent from the mapping, but present in `providers`, allows all its models.
Numbers above are starting defaults, tunable in config without code changes.
Validation at load time: unknown LLM tier names, unknown feature names,
unknown provider names (in `llm.providers` and as `models` keys — a typo
must not silently narrow a policy), `models` keys not listed in
`providers`, non-positive limits (including a missing, null, or
non-positive `limits.admin.llm_checks_per_day` or any
`concurrent_llm_runs` / `max_concurrent_llm_runs` — there is no way to
express "no admin ceiling" or "unbounded concurrency"), and **empty
per-provider model allowlists** (an empty list would leave the degradation substitute in
§6.2 undefined; "no models" is expressed by omitting the provider from
`providers`) are config errors.

Admins bypass tier **policy** — LLM selection restrictions and feature
gates — but are **not unlimited**. They are subject to the global
`max_document_chars` and to a separate, deliberately generous
`limits.admin` ceiling with the same shape as a tier's `limits:` block.

**Why an admin ceiling exists, and why it lives only in config.** An
admin account is the highest-value target in the system: with unlimited
LLM spend, a stolen 24 h token could drain the provider budget long
before anyone notices. The ceiling bounds that blast radius. It is
therefore **config-only** — read from `config.yaml`/env at startup and
mutable through no API surface whatsoever, including the admin
endpoints. An attacker holding an admin session can raise a tier's limits
for other users but cannot lift their own ceiling without filesystem
access to the server, which is a different and much higher privilege.
This asymmetry is the whole point; any future "edit limits in the admin
UI" feature must keep `limits.admin` out of scope.

There is no "unlimited" value: `limits.admin.llm_checks_per_day` must be
a positive integer (config validation, §6.1) — an operator can raise it,
never disable it. When the deferred `tokens_per_day` dimension (§6.4)
lands, it applies to this ceiling too and bounds cost more tightly than
a run count can.

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

**Admins take exactly the same path**, with `limits.admin` (§6.1)
supplying the numbers instead of their tier's block — same transaction,
same commit condition, same ledger row. §5.3's "every LLM run" includes
admins, so the highest-privilege account is exempt from neither cost
visibility nor a spend ceiling. `/api/auth/me` reports the admin ceiling
as `limit`, so the UI shows the same indicator.

An admin reaching the ceiling is **logged at WARNING** (with user id and
the day's count): for a normal user, exhaustion is routine; for an
admin at a deliberately generous ceiling, it means a runaway loop or a
compromised account, and it should be visible in the logs rather than
silently degrading.

Quota exhaustion degrades, it does not fail: rules and terminology checkers
still run; the LLM phase is skipped and the scorecard/SSE reports
`quota_exhausted` (with limit and reset day). HTTP 429 is not used for
quota — an exhausted allowance is not retryable until tomorrow, so
degrading is the honest response. (429 *is* used for the transient
concurrency caps, §6.6.)
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

### 6.6 Concurrency limits

Daily quotas bound a user's total spend; they do **not** bound how fast it
is spent. A scripted client holding a valid token could fire its whole
day's allowance in parallel in one second — concentrating cost before
anyone can react, saturating the provider's rate limits so *other* users'
checks start failing, and pinning server memory with simultaneous jobs and
SSE queues. A human cannot click that fast: the editor supersedes an
in-flight check when a new one starts (`cancelCheck`), so real usage sits
at roughly one concurrent run per user, occasionally two or three with a
suggestion or rewrite alongside. That gap between human and bot behavior
is exactly what a concurrency cap turns into a defense.

Two caps, both enforced inside the same reservation transaction as the
quota (§6.4), evaluated before it commits:

- **Per user** (`concurrent_llm_runs` in each tier's `limits:` block, and
  in `limits.admin` — default 3 basic / 5 premium / 5 admin).
- **Server-wide** (`limits.max_concurrent_llm_runs`, default 20):
  protects the machine no matter how the load is spread across users. On
  a small Fly instance this, not the per-user cap, is the binding
  constraint once a handful of users are active.

**In-flight is already recorded:** a run's ledger row (§5.3) carries
`status = 'started'` from reservation until it ends, so the in-flight
count is a `COUNT(*)` over exactly those rows — no separate in-memory
registry that could drift from the DB or reset on restart.

This makes the previously-accepted stranded-row case load-bearing, so it
is no longer merely accepted: a row left at `'started'` by a crash would
otherwise consume a concurrency slot forever. Two mechanisms clear them:

1. **Startup sweep:** on boot, every row still at `'started'` is moved to
   `'abandoned'` — in a single-process deployment no such run can still be
   alive, since the process that owned it is gone. (This also makes the
   ledger's history honest rather than leaving perpetual `'started'`
   rows.)
2. **Staleness fallback:** rows older than `limits.llm_run_max_age`
   (default 15 minutes — comfortably beyond any provider timeout) are
   excluded from the in-flight count and swept to `'abandoned'`, covering
   a task that hangs without the process dying.

Abandoned runs keep counting toward the daily quota: they consumed a
reservation, and treating them as free would reopen the cancel-and-retry
loophole §5.3 closes.

**Behavior when a cap is hit:** unlike quota exhaustion, this is transient
and retryable, so it is the one place the API returns **429** — with a
`Retry-After` header — rather than degrading. Degrading would be wrong
here: nothing about the request is over its entitlement, the server is
simply busy right now. Legitimate UI flows effectively never see it.

**Backpressure delay:** the 429 is returned after a small fixed pause
(`limits.concurrency_reject_delay`, default 250 ms), so an over-eager
client is slowed in the loop rather than merely told "no" — the same
spirit as the failed-login backoff (§4.2). Two constraints keep it from
backfiring, and both are binding:

1. **The pause happens after the reservation transaction has rolled back,
   never inside it.** Sleeping while holding the transaction would block
   every other user's reservation for the duration — turning a
   politeness measure into a self-inflicted global stall.
2. **It stays small and fixed — it never escalates with repeated hits**,
   unlike the login backoff. The two cases are not symmetric: a login
   delay directly reduces an attacker's guess *rate*, because they need
   many sequential attempts to succeed. Here the caller is already
   rejected and no LLM run is started, so a longer delay does not reduce
   their success rate at all — it only makes them hold a server
   connection longer, adding to exactly the resource pressure the cap
   exists to relieve. A quarter second is enough to break a tight retry
   loop without becoming an amplification vector.

If bot traffic ever justifies more than this, the right escalation is a
per-user request-rate throttle (token bucket, rejecting immediately and
cheaply) or an edge rate limit at the deployment layer — not a longer
pause.

## 7. API surface

### 7.1 New endpoints

| Endpoint | Auth | Behavior |
|---|---|---|
| `POST /api/auth/login` | none | §4.2. 401 (generic) on any failure. |
| `GET /api/auth/me` | user | User + tier + `is_admin` + effective LLM policy + feature flags + quota status (`used_today`, `limit`; for admins the `limits.admin` ceiling, §6.1/§6.4) + size limits (global and tier, or the admin ceiling's). `used_today` is defined identically to `reserve_llm_run`'s count: *started* ledger rows for the UTC day, regardless of run completion (§5.3/§6.4) — no UI/backend drift. The frontend's single source of truth for gating. |
| `POST /api/auth/password` | user | Change own password; re-verifies current one. |
| `GET /api/admin/users` | admin | List users (no password hashes in responses — a dedicated response model, never the row). |
| `POST /api/admin/users` | admin | Create user: email, display name, initial password, tier, admin flag (subject to the admin-creation switch below). 422 on duplicate email/invalid input. |
| `PATCH /api/admin/users/{id}` | admin | Update tier / admin flag / active flag / display name / reset password. Admins cannot deactivate or de-admin themselves (409) — prevents lockout. Promotion to admin is subject to the switch below. |

No hard user delete in v1: deactivation preserves `owner_id` referential
integrity.

**Bootstrapping the first admin.** There is deliberately **no API path**
to create the first admin: an unauthenticated bootstrap endpoint is a
classic hole (it must either stay open forever or be disabled by a step
someone forgets). Instead the first admin is seeded at startup from the
`FW_ADMIN_EMAIL` / `FW_ADMIN_PASSWORD` environment variables, and only
while the `users` table is empty — full rules in §9 step 2, including the
fail-closed startup and the local-mode-only scoping. Two consequences
worth stating here, where the endpoints live:

- The seeding path is a **bootstrap, not an ongoing sync**: once any user
  exists the variables are ignored entirely, so they can never act as a
  standing password-reset backdoor. Changing the admin password
  afterwards goes through `POST /api/auth/password` like anyone else's.
- Losing the admin password is recovered with the operator CLI (§7.5),
  not by re-running the bootstrap — there is no email reset flow (§11).

**Admin-creation switch (`auth.allow_additional_admins`, default
`false`).** One admin account is all this deployment needs; every further
admin widens the blast radius of a compromise. While the switch is off:

- `POST /api/admin/users` rejects `is_admin: true` with **403**;
- `PATCH /api/admin/users/{id}` rejects a `false → true` transition of
  `is_admin` with **403**;
- **demotion stays allowed** (`true → false`) — it only ever reduces
  privilege — though it cannot be undone while the switch is off, and
  self-demotion remains blocked by the lockout rule above;
- the startup seeding of the *first* admin is unaffected: the switch
  governs the API, not the bootstrap.

Like the admin spend ceiling (§6.1), this is **config-only and mutable
through no API surface**, and that is the entire point: a stolen admin
session can do damage until the account is deactivated or its password
rotated, but it cannot mint a *second* admin account that survives that
response. It turns admin compromise from potentially permanent into
recoverable. Any future "manage settings in the admin UI" feature must
keep this switch — and `limits.admin` — out of scope.

A denied promotion attempt is logged at **WARNING** with actor and
target: with the switch off, a legitimate admin has no reason to try, so
the attempt is a compromise signal. If the DB is found to contain more
than one admin while the switch is off (legacy state, or the switch was
turned off after the fact), startup logs a warning and continues —
existing admins are not silently demoted.

**Admin audit trail:** every admin mutation (create user, tier/role/active
change, password reset) appends a row to `admin_audit`. Cheap now,
painful to retrofit once there is more than one admin:

```sql
CREATE TABLE admin_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   INTEGER,                -- admin performing the action;
                                       -- NULL = out-of-band operator CLI (§7.5)
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
  `resolve_llm_selection` (§6.2) → reservation, which decides quota
  (§6.4) and the concurrency caps (§6.6) in one transaction. Resolution
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
  remains unused on these paths (429 can still occur — the concurrency
  caps of §6.6 apply to every LLM-invoking endpoint alike).
- Error semantics overall: **401** unauthenticated / bad token, **403**
  forbidden action, **404** not yours / nonexistent, **413** over the
  global size cap, **422** validation (unchanged), **429** concurrency
  cap reached (§6.6, with `Retry-After`; never for daily quota, which
  degrades instead).

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

### 7.5 Operator CLI (out-of-band recovery)

A forgotten admin password must not be a dead end, and it must not be
recovered by leaving a reset backdoor in the running application. A small
management CLI — `uv run python -m app.manage <command>`, executed on the
server (locally, or via `fly ssh console` after deployment) — provides
the recovery paths:

| Command | Purpose |
|---|---|
| `list-users` | id, email, tier, admin flag, active flag — to find the account to fix. |
| `set-password <email>` | Set a new password (bcrypt), same strength rules as §4.2. Local mode only — see below. |
| `make-admin <email>` | Grant admin, and reactivate the account if it was deactivated. |

**Why a CLI rather than an env-var reset or a recovery endpoint.** Both
alternatives leave a standing hole: an env var that resets a password on
boot is a permanent backdoor for anyone who ever reads the environment,
and it silently re-resets on every restart if left in place; an
unauthenticated recovery endpoint is exposed to the whole internet for
the sake of a once-a-year need. The CLI requires shell access to the
machine, which is a strictly higher privilege than any web session and
one that already implies full control of the database — so it adds **no
new attack surface** while removing the temptation to build one.

Rules that make it safe and honest:

- **Passwords are never taken from argv** (they would land in shell
  history and in `ps` output for every other process on the box): the CLI
  prompts, or reads a single line from stdin.
- **Every mutation writes an `admin_audit` row** with `actor_id NULL`,
  meaning "out-of-band operator action" — an admin password that changes
  without any admin session is exactly the event the audit trail should
  not be blind to.
- **The CLI is deliberately not bound by `auth.allow_additional_admins`**
  (§7.1). That switch exists to stop a *remote, stolen session* from
  minting a persistent second admin; an operator at the machine's shell
  is on the other side of that boundary and is precisely who must be able
  to restore access.
- It operates on the configured database directly and requires no running
  server, so it also works when the app will not start.

**Applicability once Supabase Auth arrives (sub-project 2).** The three
commands do not age alike, because authentication moves out while
authorization stays:

- `list-users` and `make-admin` **remain the recovery tools in both
  modes**: tier, `is_admin` and `is_active` live in our `users` table
  regardless of who verifies the token, so "I locked myself out of admin"
  is still fixed here and nowhere else.
- `set-password` is **local-mode-only and refuses to run in
  `supabase` mode**, pointing at Supabase's own reset flow instead. The
  refusal is deliberate rather than a silent no-op: in `supabase` mode
  nothing reads `password_hash`, so writing one would appear to succeed
  while changing nothing — and worse, it would plant a dormant credential
  that becomes live the moment someone sets `auth.mode: local` again.

Commands for linking a Supabase identity to a local row belong to
sub-project 2, under the no-auto-adopt-by-email constraint in §11.

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
  simultaneous starts at limit−1 admit exactly one),
  cancelled-run-keeps-ledger-row, and the admin ceiling (an admin is
  denied at `limits.admin.llm_checks_per_day` with a WARNING logged, and
  no admin endpoint can raise it — the value comes only from config);
  concurrency caps (a user at `concurrent_llm_runs` gets 429 with
  `Retry-After` while a second user is unaffected; the server-wide cap
  binds across users; a finished run frees its slot; the backpressure
  pause delays only the rejection and does not block a concurrent
  reservation by another user — i.e. it happens outside the transaction; the startup sweep
  and the staleness rule move stale `'started'` rows to `'abandoned'` so
  slots cannot leak, while those rows still count against the day); ledger completeness (a reserved row
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
  `skipped` reason for quota/size/floor denials, never 403 — a 429 from
  the concurrency cap is a separate, legitimate outcome); admin runs are admitted with the
  admin ceiling in place of their tier's limits, still writing ledger
  rows; startup seeders
  create only `owner_id IS NULL` rows on a fresh multi-user DB; admin
  endpoint tests incl. self-lockout prevention, audit rows written, and
  the admin-creation switch (with `allow_additional_admins: false`,
  creating an admin and promoting a user both give 403 with a WARNING
  logged, while demotion still succeeds; with it `true`, both are
  permitted — and no endpoint can change the switch itself); operator CLI
  (`set-password` lets the account log in again and writes an audit row
  with `actor_id NULL`; `make-admin` reactivates a deactivated account
  and works even with `allow_additional_admins: false`; no command
  accepts a password as an argv argument; `set-password` refuses under
  `auth.mode: supabase` and leaves `password_hash` untouched);
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
