# Runtime Hardening + Update Story Design (B21 #78, B26 #86)

Companion issues, one branch/PR. Five runtime-robustness gaps deferred from
B17 (#58) plus the stale-`latest` update story found after v0.2.0.

## Scope

- B21 #78: entrypoint env-file path, malformed env-line handling,
  reverse-proxy opt-in, wizard rerun prefill edge, `fabulous.sh serve`
  port pre-check.
- B26 #86: auto-pull in `fabulous.sh serve`, README "Updating" note.

Out of scope: fly.io deployment itself (B16 #57), a wizard prompt for any
of the new knobs, pulling in `fabulous.sh setup`.

## 1. Entrypoint env-file path + parser hardening

File: `docker/entrypoint.sh`.

- `ENV_FILE="${FW_ENV_FILE:-$(dirname "$CONFIG_FILE")/fabulous.env}"` —
  derived from the config file's directory by default, so relocating
  `FW_CONFIG_FILE` (B16/fly.io) carries the secrets file along;
  `FW_ENV_FILE` overrides independently. An empty `FW_ENV_FILE` falls back
  to the derived default (same `:-` semantics the config path already
  uses).
- Parser hardening, in the read loop:
  - Strip one trailing carriage return from each line before any other
    handling (`line=${line%$'\r'}` equivalent in POSIX sh:
    `line=${line%"$(printf '\r')"}`), so a Windows-side CRLF edit does not
    leave `\r` in the last value byte.
  - Validate the key against POSIX name syntax
    (`[A-Za-z_][A-Za-z0-9_]*`) before `export`. A line that fails (no
    `=`, empty key, invalid characters — e.g. `foo bar=x`) is **fatal**:
    print `"$ENV_FILE line N is not KEY=VALUE"` to stderr and `exit 78`
    (EX_CONFIG, matching the existing missing-config exit). The message
    names the file and line number only — never the line content, which
    may hold a mis-pasted secret. Skipping silently is not acceptable: a
    dropped secrets line surfaces later as an opaque auth failure.
- Unchanged: comments/blank lines skipped, real environment variables win
  over file values.

## 2. Reverse-proxy opt-in

Files: `docker/entrypoint.sh`, `backend/app/api/auth.py` (comment only),
`README.md`.

- New env var `FW_TRUSTED_PROXIES`: comma-separated proxy IPs/CIDRs, or
  `*`. When set and non-empty, the entrypoint appends
  `--proxy-headers --forwarded-allow-ips "$FW_TRUSTED_PROXIES"` to the
  uvicorn exec. Unset or empty = today's invocation, byte for byte.
- Semantics are uvicorn's: X-Forwarded-For is honored only when the
  connecting peer is on the trusted list, so `request.client.host` — and
  with it the login-throttle key — becomes the real client IP behind a
  trusted proxy, while spoofing from untrusted peers keeps failing.
  No app-code change.
- Update the deliberate-ignore comment at `_throttle_key`
  (`backend/app/api/auth.py:368`) to name `FW_TRUSTED_PROXIES` as the
  supported opt-in instead of pointing at "sub-project 3".
- README troubleshooting gains a "Behind a reverse proxy" bullet:
  set `FW_TRUSTED_PROXIES` to the proxy's address (as seen by the
  container) or the login throttle treats all clients as one.
- Not a Settings/config knob — deployment-level concern, stays at the
  deployment layer (`docker run -e`, fly.io secrets/env).

## 3. Wizard rerun prefill edge

File: `backend/app/setup_wizard.py` (line 310).

- `rerun = bool(existing_env) or bool(existing_config)`.
- With `fabulous.env` deleted but `config.yaml` surviving: re-run banner
  shows, provider/model/URL prefills come back from the config; the
  env-derived prefills (admin email, API key) are genuinely gone and
  prompt fresh; a new `FW_AUTH_SECRET` is generated (its only copy lived
  in the deleted file).
- No behavior change for the existing cases (both files present, neither
  present).

## 4. `fabulous.sh serve`: port pre-check + auto-pull

File: `fabulous.sh` (serve branch only; `setup` unchanged).

Order: **port pre-check → pull → version print → run**.

- **Port pre-check** (B21.5): if `nc` is available, probe
  `nc -z localhost "$PORT"`; if something is listening, refuse with
  `exit 75` and a message naming the port and the remedy
  (`FW_PORT=9090 ./fabulous.sh serve`). Without `nc`, skip the check
  silently — no new hard dependency; the README troubleshooting bullet
  still covers the collision. Rationale: with some Docker backends
  (colima), publishing an already-taken host port does not fail — the
  container serves healthily while `localhost:$PORT` is answered by the
  squatter.
- **Auto-pull** (B26.1): `docker pull "$IMAGE"` before `docker run` — a
  no-op when current, an automatic update when stale, tag validation for
  pinned versions. On pull failure, print a warning ("could not check for
  updates — serving the local image if present") and continue, so an
  offline host still serves the cached image.
- **Version print**: after the pull, read
  `docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}'`
  and print `Serving Fabulous Writing <version>`; if the label is empty
  or inspect fails (image absent after failed pull, local dev build),
  print nothing and let `docker run` produce the natural error.

## 5. README "Updating" note

File: `README.md`, quickstart section (B26.2).

Short "Updating" subsection:

- `./fabulous.sh serve` checks for updates on every start (auto-pull).
- Plain-docker users: `docker pull ghcr.io/saigyo/fabulous-writing:latest`.
- Image updates never touch the `fabulous-config`/`fabulous-data`
  volumes.
- Checking the local image version:
  `docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' ghcr.io/saigyo/fabulous-writing:latest`;
  the running app reports its version at `/api/health`.

## Testing

Shell behavior is tested in the normal backend pytest gate by running the
real scripts with stub executables on a prepended `PATH` — no Docker, no
network. Stubs record their argv (and selected env) to files under
`tmp_path`; assertions read those files.

- New `backend/tests/test_entrypoint_sh.py` (stub `uvicorn`):
  - env file values exported; pre-set real environment variables win
  - `FW_ENV_FILE` override honored; empty override falls back
  - default env-file path follows `dirname(FW_CONFIG_FILE)`
  - trailing CRLF stripped from values
  - malformed line (`foo bar=x`) → exit 78, stderr names file and line
    number, does NOT echo the line content, uvicorn never invoked
  - `FW_TRUSTED_PROXIES` set → `--proxy-headers --forwarded-allow-ips`
    present with the value; unset → both flags absent
- New `backend/tests/test_fabulous_sh.py` (stub `docker`, `nc`):
  - port busy (`nc` exits 0) → refusal message naming port + `FW_PORT`,
    exit 75, no docker invocation recorded
  - port free → `docker pull` recorded before `docker run`
  - pull failure → warning printed, `docker run` still invoked
  - version label present → `Serving Fabulous Writing <v>` printed;
    empty label → no version line
  - `nc` absent from stub PATH → check skipped, serve proceeds
- `backend/tests/test_setup_wizard.py`: rerun-edge unit test —
  `config.yaml` present, `fabulous.env` absent → re-run mode, provider
  prefilled from config, fresh secret generated.

Mutation-verify each new guard test (delete the guard, watch the test
fail, restore). Standard gates: `uv run pytest -q` green with zero
warnings; frontend untouched.

## Issue closure

The PR closes both: `Closes #78.` `Closes #86.`
