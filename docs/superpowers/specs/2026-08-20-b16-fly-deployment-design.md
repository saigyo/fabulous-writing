# B16: fly.io Deployment — Design

**Issue:** #57 · **Branch:** `b16-fly` · **Date:** 2026-08-20

## Problem

The app is fully containerized (B17: GHCR image, entrypoint, health
endpoint), hardened for reverse proxies (B21: `FW_TRUSTED_PROXIES`), and
can run stateless against hosted Supabase (B14 auth, B15 postgres, B36
least-privilege role with `manage_schema: false` + `init-db`). What is
missing is the fly.io layer itself: a committed machine definition, the
non-secret deployment config, the secrets runbook, and documented
first-deploy/update procedures — so a hosted demo instance can be stood
up from the repo with no undocumented steps.

## Settled decisions

- **Profile: hosted.** Supabase Auth (`auth.mode: supabase`) + Supabase
  Postgres via the `fabwriting_app` DML-only role with
  `manage_schema: false`. The machine is stateless — **no fly volume**.
  The self-contained SQLite profile is not targeted by B16.
- **Image: reuse, never rebuild.** The fly app runs the existing GHCR
  release image, pinned by tag in `fly.toml`
  (`ghcr.io/saigyo/fabulous-writing:0.5.0` at time of writing — v0.5.0
  was cut for this story; it is the first release containing B36's
  `manage_schema` key, without which the fly config cannot boot at all
  since `DatabaseSettings` is `extra="forbid"`). A release bump is a
  one-line, git-recorded `fly.toml` edit. No Dockerfile changes.
- **Providers: Anthropic only.** `ANTHROPIC_API_KEY` is the sole
  provider secret; `default_provider: claude`; the routing table pins
  all seven languages' remote tiers to Claude models. The local tier
  stays honestly on Ollama and reports "unavailable" with a reason in
  the UI (B24/B25 behavior) — no new hide-the-tier code.
- **Lifecycle: scale to zero.** `auto_stop_machines` +
  `min_machines_running = 0`. Costs pennies while idle; the first
  visitor after idle pays the model-loading cold start (measured during
  rollout, documented in the ops doc).
- **App name `fabulous-writing`** (URL `fabulous-writing.fly.dev`;
  availability confirmed at rollout, fallback agreed then), **region
  `fra`**.
- **Admin DSN never enters Fly.** Schema creation/migration (`init-db`)
  runs from the operator's machine against the admin DSN (B36 R5). No
  `release_command`, no admin credentials in fly secrets.

## Approaches considered

- **Committed `fly.toml` + config delivered via `[[files]]` (chosen):**
  everything declarative and in git; the machine stays stateless.
- **Config volume:** keeps wizard semantics but pins the app to one
  machine and adds mutable state — rejected, defeats the stateless
  profile.
- **Fly-specific image variant with baked config:** couples the generic
  GHCR image to one deployment and doubles the release surface —
  rejected.

## Requirements

### R1 — `deploy/fly/fly.toml`

New directory `deploy/fly/` holding the machine definition. All fly
commands in docs run with `-c deploy/fly/fly.toml` from the repo root.
Contents (exact values; comments in the file explain each):

- `app = "fabulous-writing"`, `primary_region = "fra"`.
- `[build] image = "ghcr.io/saigyo/fabulous-writing:0.5.0"` — the
  pinned release tag; deploying a new release = editing this line
  (git-recorded) and following the update runbook.
- `[[files]]` — `guest_path = "/fly/config.yaml"`,
  `local_path = "deploy/fly/config.yaml"` (R2). The path is outside the
  image's `/config` (which the entrypoint associates with the wizard
  flow); the entrypoint's env-file probe then looks at
  `/fly/fabulous.env`, which does not exist — correct, since all env
  comes from fly secrets (real environment always wins by design,
  B21).
- `[env]`:
  - `FW_CONFIG_FILE = "/fly/config.yaml"`;
  - `FW_TRUSTED_PROXIES = "fdaa::/16,172.16.0.0/12"` — deliberate and
    justified: on fly,
    `internal_port` is reachable only through fly-proxy for public
    traffic (the service ports are the only public surface), and the
    remaining peers are the org's own 6PN private network — a
    single-operator org here. Fly-proxy connects from non-constant
    private (6PN) addresses, so an exact-IP list is not available.
    Plan-phase verification resolved this: the pinned uvicorn (0.52.1)
    splits `--forwarded-allow-ips` on commas and accepts CIDRs, so the
    shipped value is `"fdaa::/16,172.16.0.0/12"` (6PN IPv6 + RFC1918
    machine-local IPv4) — fly-private space only, never `*`. Every
    entry must be a VALID network (uvicorn silently demotes a
    malformed CIDR — e.g. `fdaa::/8`, host bits set — to a
    never-matching string literal; the R3 test guards entry validity
    offline). The B21
    docs' general warning against `*` stands for self-hosted setups;
    the ops doc states the fly-specific justification.
- `[http_service]`: `internal_port = 8000`, `force_https = true`,
  `auto_stop_machines = "stop"`, `auto_start_machines = true`,
  `min_machines_running = 0`.
- `[[http_service.checks]]`: `GET /api/health`, interval 30s, timeout
  5s, grace period 60s (model loading; tuned at rollout if measured
  startup demands it).
- `[[vm]]`: `size = "shared-cpu-2x"`, `memory = "2gb"` (spaCy/GiNZA
  stack headroom; verified at rollout, adjusted by follow-up commit if
  wrong).

`fly.toml` contains no secret and no secret-adjacent value.

### R2 — `deploy/fly/config.yaml`

The non-secret deployment config, loaded by the entrypoint via
`FW_CONFIG_FILE`. Keys:

- `environment: production`
- `database: { backend: postgres, manage_schema: false }` — the DSN
  lives exclusively in the `FW_DATABASE_URL` secret (app-role DSN).
- `auth: { mode: supabase, supabase: { url: https://<project-ref>.supabase.co } }`
  — the project URL is public knowledge, not a secret (B14); the real
  ref goes in at rollout time via a normal commit.
- `frontend: { dist_dir: /app/dist }` — single-origin serving.
- `cors: { origins: [] }` — no cross-origin callers exist.
- `providers: { default_provider: claude }`.
- `routing.languages`: the complete 7-language × 4-tier table (B24
  lesson: `RoutingSettings` overlays built-in defaults per language, so
  a partial table silently resurrects stale entries — the table must be
  complete). Remote tiers on the wizard's Anthropic column
  (`quality: claude-opus-5`, `balanced: claude-sonnet-5`,
  `cheap: claude-haiku-4-5` for every language); `local` stays on the
  built-in Ollama defaults, honest and unavailable.
- Nothing else: no `credits` overrides, no `extra_providers`, no keys
  that merely restate defaults.

### R3 — Config-validity test (CI gate)

New `backend/tests/test_fly_config.py` loading the repo's
`deploy/fly/config.yaml` through the real `Settings` model (path
resolved relative to the repo root from the test file; a missing
deploy tree is a hard FAILURE, not a skip — a skip would silently
disarm the gate). The backend CI workflow's `paths:` filters gain
`deploy/fly/**` so the gate also fires on artifact-only edits (the
runbook-mandated project-URL and image-tag commits). Pins:

- parses cleanly through `load_settings`/`Settings` (a future
  config-model rename that orphans the fly config fails CI, the exact
  failure mode that motivated release-before-B16);
- `database.backend == "postgres"` and `database.manage_schema is False`;
- `auth.mode == "supabase"` with a non-empty `https://` supabase URL;
- `cors.origins == []`;
- `frontend.dist_dir == Path("/app/dist")`;
- `providers.default_provider == "claude"`;
- every one of the seven languages routes `quality`/`balanced`/`cheap`
  to provider `claude`;
- a secret scan: the raw file text contains no value matching the
  known secret env names (`FW_AUTH_SECRET`, `FW_DATABASE_URL`,
  `FW_SUPABASE_SECRET_KEY`, `FW_SUPABASE_PUBLISHABLE_KEY`,
  `FW_ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`) nor any
  `postgresql://` DSN.

Every guard is mutation-verified per the standing rule (e.g. flip
`manage_schema` in a tmp copy → test must fail). `fly.toml` itself has
no offline validator; it is checked at rollout with
`fly config validate`.

### R4 — Ops doc `docs/fly-deployment.md`

The runbook, written so a reader with a fly account and the two
Supabase runbooks (`docs/postgres-setup.md`,
`docs/supabase-auth-setup.md`) already applied can deploy end to end:

1. **Prerequisites** — hosted Supabase project with B36 role migrations
   pushed and the app-role password set; `init-db` already run from the
   operator's machine under the admin DSN (exact commands, referencing
   the postgres-setup runbook rather than duplicating it); Anthropic
   API key; `flyctl` authenticated.
2. **First deploy** — `fly apps create fabulous-writing`; the
   `fly secrets set` block listing the six secrets **by name only**
   (`FW_DATABASE_URL` = app-role Supavisor DSN with the
   `fabwriting_app.<project-ref>` username form,
   `FW_SUPABASE_SECRET_KEY`, `FW_SUPABASE_PUBLISHABLE_KEY`,
   `FW_ADMIN_EMAIL`, `FW_ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`;
   `FW_AUTH_SECRET` is deliberately absent — it backs local-mode
   token signing only and is never read in `auth.mode: supabase`,
   documented as set-only-if-mode-flips);
   `fly deploy --ha=false -c deploy/fly/fly.toml` — `--ha=false` is
   mandatory on EVERY deploy: plain `fly deploy` creates two machines
   (Fly's HA default), violating the auth design's binding
   one-machine/one-worker precondition (per-process login throttle;
   the second process's startup sweep would mark the first's live
   usage runs abandoned) — followed by a machine-count verification
   (`fly machine list` must show exactly one); smoke checks (`/api/health`
   returns the release version; login; About dialog shows
   `0.5.0` / PostgreSQL (the release workflow strips the git tag's
   leading `v` for both the GHCR tag and `FW_APP_VERSION`); LLM check
   through Claude; local tier reports
   unavailable).
3. **Updating** — schema-changing releases: `init-db` first under the
   admin DSN (additive DDL, old release keeps serving), then bump the
   image tag in `fly.toml` (commit) and `fly deploy --ha=false -c
   deploy/fly/fly.toml`. Non-schema releases: tag bump + deploy only
   (same guarded command).
4. **Operational notes** — scale-to-zero semantics and the measured
   cold-start figure; the `FW_TRUSTED_PROXIES` CIDR-list
   justification (R1);
   logs via `fly logs` never contain secrets (names-only rule) — with
   the one known exception tracked as #118 (B39): libpq's connect
   diagnostics can echo a secret mis-pasted into a *field* of a valid
   DSN, so failed-connect logs are treated as potentially
   secret-bearing until B39 lands; the pre-"real traffic" checklist
   pointing at #118 (B39 DSN field-echo hardening) and #116 (B37
   CloudFront/WAF) as consciously-deferred items.

README gets a one-paragraph pointer ("Hosted deployment (fly.io)" →
the doc). `docs/backend-architecture.md` gains one sentence in the
deployment paragraph naming the fly layer.

### R5 — Rollout (part of this story, post-merge)

Executed together with Markus after the PR merges, following R4's
runbook exactly — the runbook is the deliverable under test:

- prerequisites: `supabase link` + `db push` of the B36 migrations to
  the hosted project, out-of-band app-role password, `init-db` under
  the hosted admin DSN (first real use of the B36 hosted-project path);
- app creation, secrets, `fly config validate`, deploy;
- smoke verification per R4 step 2, plus: cold-start measurement
  (stop → first request), login-throttle sanity (client IP visible in
  logs rather than fly-proxy's), and confirmation that a second deploy
  is a no-op rollover;
- every runbook deviation discovered during rollout is fixed in the
  doc in a follow-up commit before the story closes.

## Out of scope

- CI-driven deploys (manual `fly deploy` is the story; revisit with a
  later item if cadence demands it).
- Custom domain / TLS beyond `*.fly.dev`.
- CloudFront/WAF hardening — B37 (#116).
- DSN field-echo hardening — B39 (#118); flagged in the ops doc as a
  pre-production gate, not a demo gate.
- Hiding the Ollama tier from the UI (graceful unavailable is enough).
- SQLite-on-volume profile.

## Delivery

One PR (`b16-fly`, closes #57) through the usual pipeline: plan with
Opus review, subagent-driven execution, whole-branch final review,
Copilot rounds, LOGBOOK entry as last commit, owner rebase-merge. The
R5 rollout happens post-merge with any runbook corrections as a small
follow-up.
