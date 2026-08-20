# Deploying to fly.io

This deploys the app as a single stateless fly.io machine running the
released GHCR image, backed by a hosted Supabase project for both
Postgres and auth — no volume, no in-cluster database. Combined with
`min_machines_running = 0`, the machine scales to zero when idle, so cost
during a quiet demo period is close to nothing; you pay for the machine
only while it's actually serving traffic. Everything specific to this
deployment target lives in two committed files: `deploy/fly/fly.toml`
(the machine definition — image, secrets' *names*, networking, health
check) and `deploy/fly/config.yaml` (the app's own non-secret config,
delivered into the machine at boot). Both are guarded by
`backend/tests/test_fly_config.py`, so a config-schema change that would
orphan this deployment fails CI instead of failing at machine boot.

## 1. Prerequisites

- A hosted Supabase project with the B36 role migrations pushed and the
  `fabwriting_app` password set ([postgres-setup.md](postgres-setup.md),
  "Least-privilege application role").
- Schema initialized from your machine under the ADMIN DSN — the admin
  DSN never becomes a fly secret:

  ```bash
  cd backend
  read -rs FW_DATABASE_URL   # paste the admin DSN — no echo, no shell history
  export FW_DATABASE_URL
  uv run python -m app.manage init-db
  unset FW_DATABASE_URL
  ```

- Supabase Auth configured ([supabase-auth-setup.md](supabase-auth-setup.md));
  have the project URL, publishable key, and secret key at hand.
- An Anthropic API key; `flyctl` installed and authenticated.
- The GHCR image is public — `fly deploy` needs no registry auth. If it
  were ever flipped private, deploys would need registry credentials
  configured on fly first.

## 2. First deploy

Run every `fly` command below from the repo root, with `-c
deploy/fly/fly.toml` — `fly.toml`'s `[[files]] local_path` is resolved
relative to the working directory the command runs from, not relative
to `fly.toml` itself.

1. Set the real project URL in `deploy/fly/config.yaml`
   (`auth.supabase.url`) and commit.
2. `fly apps create fabulous-writing`
3. Set the secrets. Don't pass values on the `fly secrets set` command
   line — they would land in shell history and be visible as process
   arguments while `flyctl` runs. Instead, write the six `NAME=VALUE`
   lines (values from your password manager) to a scratch file
   **outside the repo**, import it from stdin, and delete it:

   ```bash
   umask 077                    # the scratch file must not be group/world-readable
   SECRETS_FILE=$(mktemp)
   # Put the six NAME=VALUE lines into "$SECRETS_FILE" (no quotes):
   #   FW_DATABASE_URL, FW_SUPABASE_SECRET_KEY,
   #   FW_SUPABASE_PUBLISHABLE_KEY, FW_ADMIN_EMAIL,
   #   FW_ADMIN_PASSWORD, ANTHROPIC_API_KEY
   fly secrets import -a fabulous-writing < "$SECRETS_FILE"
   rm "$SECRETS_FILE"
   ```

   `FW_DATABASE_URL` is the APP-ROLE Supavisor DSN with username form
   `fabwriting_app.<projectref>` ([postgres-setup.md](postgres-setup.md));
   the admin DSN must never be set here. `FW_ADMIN_PASSWORD` must be at
   least 12 characters — `seed_admin` validates against
   `ADMIN_SET_MIN_PASSWORD_LENGTH = 12` and a shorter value fails the
   first boot. `FW_AUTH_SECRET` is deliberately absent from this list:
   it backs local-mode token signing only and is never read in
   `auth.mode: supabase` (`main.py` resolves it only on the local
   branch) — set it only if this deployment ever flips to
   `auth.mode: local`.
4. `fly config validate -c deploy/fly/fly.toml`
5. `fly deploy --ha=false -c deploy/fly/fly.toml`

   `--ha=false` is NOT optional: plain `fly deploy` creates TWO
   machines (Fly's high-availability default), and this backend has a
   binding one-machine/one-worker precondition (multi-user-auth design,
   fly.io sub-project) — the login throttle is per-process, and a
   second process booting would mark the first one's live usage runs
   `'abandoned'`, corrupting the ledger. Horizontal scaling first
   requires shared-state replacements for both mechanisms.
6. Verify exactly one machine exists: `fly machine list -a
   fabulous-writing` must show a single machine. If a second one ever
   appears, remove it before serving traffic: `fly machine stop <id>`
   followed by `fly machine destroy <id>` (`destroy` refuses a running
   machine unless forced).
7. Smoke checks: `GET https://fabulous-writing.fly.dev/api/health`
   returns the pinned release version; log in; About dialog shows the
   version and "PostgreSQL"; run an LLM check (Claude); the local tier
   reports unavailable — expected, there is no Ollama on fly.

## 3. Updating

- Schema-changing release: run `init-db` under the admin DSN FIRST
  (additive DDL — the old release keeps serving), then bump the image
  tag in `deploy/fly/fly.toml` (commit) and `fly deploy --ha=false -c
  deploy/fly/fly.toml`.
- Non-schema release: tag bump + deploy only.
- Every deploy keeps `--ha=false` (see step 5 above); re-check the
  machine count after deploying.

## 4. Operational notes

**Scale-to-zero.** With `min_machines_running = 0` and
`auto_stop_machines = "stop"`, the machine stops entirely once idle and
`auto_start_machines` brings it back on the next request. That first
request pays a cold start dominated by model loading (spaCy/GiNZA
pipelines) rather than by fly's own machine-start time; the health
check's `grace_period` is set generously for this reason. The actual
figure will be measured at first rollout and the grace period tuned
by follow-up commit if needed.

**`FW_TRUSTED_PROXIES="fdaa::/16,172.16.0.0/12"`.** Forwarded headers
are trusted at all because the login throttle keys on the caller's real
IP, and behind fly-proxy every request otherwise arrives as the proxy's
own address, collapsing every visitor into one throttle bucket. These
two ranges are fly's own private networking, not a guess: `fdaa::/16`
is fly's 6PN IPv6 range, and `172.16.0.0/12` is the RFC1918 block fly
machines draw their machine-local IPv4 addresses from. Public internet
traffic reaches the app's `internal_port` only by passing through
fly-proxy — it cannot present an address in either range on its own —
so trusting these CIDRs specifically doesn't open the throttle to
spoofing from outside. This is also why the value is a CIDR list and
not `"*"`: the B21 warning (see the README's reverse-proxy
troubleshooting section) stands here as everywhere else — `"*"` trusts
every peer's `X-Forwarded-For` unconditionally, while the CIDR form
limits that trust to addresses only fly's own infrastructure can hold.

**The delivered config file is root-owned.** `fly.toml`'s `[[files]]`
entry writes `deploy/fly/config.yaml` into the machine at
`/fly/config.yaml` as root; the app itself runs as the unprivileged
`fabulous` user and only ever reads that file at startup. A root-owned,
app-readable config file is the expected shape here, not a permission
bug to "fix" during rollout.

**Logs never carry secret values.** `fly logs` streams whatever the app
itself logs, and every error path in this codebase that touches a
secret-bearing value (a malformed `FW_DATABASE_URL`, a Supabase auth
failure) names the offending variable only, never its value — the same
standing rule the rest of the app's error handling follows. One known
exception is tracked as #118 (B39): a password mis-pasted into a
*field* of an otherwise valid DSN can still be echoed by libpq's
connect diagnostics — until that lands, treat logs from a failed
database connect as potentially secret-bearing.

**Before real (non-demo) traffic.** Two hardening items are open and
consciously deferred past this first deployment: #118 (B39, DSN
field-echo hardening) and #116 (B37, CloudFront/WAF in front of the
fly endpoint). Revisit both before pointing this deployment at anything
beyond a demo audience.
