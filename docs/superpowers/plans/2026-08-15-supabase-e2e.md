# B27 Offline Supabase E2E Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in, fully offline e2e regression suite that boots the real backend (uvicorn) against a Supabase CLI local stack (GoTrue + Mailpit via Docker/colima) and drives login, refresh, logout, password change with eviction, admin invite acceptance, and password reset — including email-link extraction via Mailpit's REST API.

**Architecture:** A committed `supabase/` stack definition (config.toml + email templates), a `scripts/e2e-supabase.sh` wrapper (start-if-down, env plumbing, pytest invocation), and `backend/tests_e2e/` (uvicorn session fixture + Mailpit client + one file per flow). The default `uv run pytest -q` gate cannot see `tests_e2e/` (`testpaths = ["tests"]` is already pinned in `backend/pyproject.toml`). A `workflow_dispatch`-only GitHub Actions job runs the same wrapper.

**Tech Stack:** supabase CLI ≥ 2.114.0, Docker (colima locally / native on ubuntu CI), pytest + httpx (sync client), bash.

**Spec:** `docs/superpowers/specs/2026-08-15-supabase-e2e-design.md`

## Empirically verified platform facts (probed on CLI 2.114.0 — trust these over docs)

These were all verified against a live local stack during planning; implementers should not re-litigate them:

1. `supabase gen signing-key --algorithm ES256` emits a **single JWK object** to stdout, but `signing_keys_path` requires a **JSON array**. Moreover (Task 1 discovery): once `config.toml` declares `signing_keys_path`, the gen command reads the declared file before writing and hard-errors if it is absent — the working recipe is to pre-seed the file with `[]` and run `gen signing-key --algorithm ES256 --yes`, whereupon the CLI writes the declared file itself as a proper array.
2. Path bases in `config.toml` **differ per key** (yes, really): `signing_keys_path = "./signing_keys.json"` resolves relative to the `supabase/` directory (file lives at `supabase/signing_keys.json`), while `content_path = "./supabase/templates/invite.html"` resolves relative to the **project root** (file lives at `supabase/templates/invite.html`).
3. `supabase status -o env` emits exactly these fields (among others): `API_URL` (`http://127.0.0.1:54321`), `PUBLISHABLE_KEY` (`sb_publishable_…`), `SECRET_KEY` (`sb_secret_…`), `SERVICE_ROLE_KEY` (legacy JWT), `MAILPIT_URL` (`http://127.0.0.1:54324`).
4. Local GoTrue **rejects `sb_secret_…` as a Bearer admin credential** (`bad_jwt`; the hosted platform gateway translates it, local Kong does not). Admin calls need the legacy `SERVICE_ROLE_KEY` JWT. `sb_publishable_…` works fine for user-flow headers. Hence: `FW_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY`, `FW_SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY`.
5. With `[auth] enable_signup = false` + `[auth.email] enable_signup = true`, admin invites work (HTTP 200) and `GET /auth/v1/settings` advertises exactly `['email']` as enabled external providers — so the app's startup OAuth lockout passes.
6. Session tokens from the local stack satisfy every production-verifier requirement: `alg=ES256` with `kid`, `iss=http://127.0.0.1:54321/auth/v1`, `aud=authenticated`, `role=authenticated`, `app_metadata.provider=email`, `is_anonymous=false`. JWKS is served at `/auth/v1/.well-known/jwks.json`.
7. Mailpit REST: `GET {MAILPIT_URL}/api/v1/search?query=to:<email>` → `{"messages":[{"ID":…,"Subject":…,"To":[{"Address":…}]}]}`; `GET {MAILPIT_URL}/api/v1/message/{ID}` → `{"HTML": …}`. The templated link fragment parses with regex `#token_hash=([^&"]+)&type=(\w+)`.
8. The full chain invite → mail → `token_hash` → `POST /auth/v1/verify` → session → set password → password-grant login was verified live.
9. **colima only shares `$HOME` into its VM.** Bind-mounting files from outside (e.g. `/private/tmp`) silently yields empty root-owned directories in the container. The repo lives under `$HOME`, so this only matters if someone relocates the checkout — the wrapper does not need to handle it, but the architecture doc should mention it.
10. Trimmed as below, the running containers are exactly: `supabase_auth_*`, `supabase_db_*`, `supabase_inbucket_*` (Mailpit), `supabase_kong_*`, `supabase_rest_*`.

## Global Constraints

- The default gate `uv run pytest -q` (from `backend/`) stays green, warning-free, network- and Docker-free. `tests_e2e/` must never be collected by it (`testpaths = ["tests"]` already guarantees this — do not touch `testpaths`).
- Never touch ports 5173/8000 or the live DB `backend/data/fabulous.db`. The scratch app uses `127.0.0.1:8001` only. Kill only PIDs you started.
- Supabase containers are managed exclusively via `supabase start` / `supabase stop` — never raw `docker` commands against them.
- Key values via environment only; never echoed, logged, committed, or asserted on. Key NAMES may appear. `supabase/signing_keys.json` is git-ignored.
- The production verifier is not modified. No new `Settings` knobs.
- E2E pytest runs with `-n0` (single process; the repo default `addopts` is `-n auto`). Never `-p no:xdist`.
- Test passwords are ≥ 16 characters (clears every password floor in the app).
- All identities created by a run are `<role>-<runid>@e2e.local`. Never use real-looking domains.
- New shell scripts: `set -euo pipefail`, executable bit set.
- Commits: one per task, message trailer per repo convention (Co-Authored-By + Claude-Session lines, as in `git log`).

---

### Task 1: Supabase stack definition

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/templates/invite.html`
- Create: `supabase/templates/recovery.html`
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Produces: a `supabase start`-able stack from the repo root; GoTrue at `http://127.0.0.1:54321/auth/v1`, Mailpit at `http://127.0.0.1:54324`. Later tasks rely on the URLs, the email-only provider set, `refresh_token_reuse_interval = 0`, and the template link shape.

- [ ] **Step 1: Write `supabase/config.toml`**

```toml
# Supabase CLI local stack for the offline e2e suite (B27, #94).
# Managed exclusively via `supabase start` / `supabase stop` from the repo
# root — never via raw docker commands. Container names:
# supabase_<service>_fabulous-writing-e2e.
project_id = "fabulous-writing-e2e"

[api]
enabled = true
port = 54321
schemas = ["public"]

[db]
port = 54322
shadow_port = 54320
major_version = 17

[studio]
enabled = false

[realtime]
enabled = false

[storage]
enabled = false

[edge_runtime]
enabled = false

[analytics]
enabled = false

# Mailpit: captures all mail the stack would send; REST API on this port.
[local_smtp]
enabled = true
port = 54324

[auth]
enabled = true
# Only the fragment contract of the links matters; the host is never
# dereferenced by the API-level suite.
site_url = "http://localhost:5173"
jwt_expiry = 3600
# NOTE: resolved relative to the supabase/ directory (file lives at
# supabase/signing_keys.json), UNLIKE content_path below which is
# project-root-relative. Both verified on CLI 2.114.0.
signing_keys_path = "./signing_keys.json"
enable_refresh_token_rotation = true
# Hosted default is 10 s; 0 makes a consumed refresh token rejectable
# immediately, so the rotation test needs no wall-clock wait.
refresh_token_reuse_interval = 0
# Mirror production: project-wide signups off (invitation-only). Admin
# invites are exempt — verified against this local stack.
enable_signup = false

# GoTrue's default IP rate limits (30 sign-ins / 5 min) are sized for
# humans, not a test suite: one run issues ~16 password grants (incl. the
# internal current-password verification inside the change-password route),
# so two back-to-back runs would trip 429s that surface as fake 401
# regressions. email_sent is NOT settable here — the CLI only exports it
# with a real SMTP config, so GoTrue's default (30 mails/hour) applies;
# see the Mailpit client's timeout message.
[auth.rate_limit]
sign_in_sign_ups = 1000
token_verifications = 1000
token_refresh = 1000

[auth.email]
# The email provider itself stays enabled: the app's provider claim guard
# and the startup lockout both require 'email' as the only enabled provider.
enable_signup = true
double_confirm_changes = true
enable_confirmations = false
secure_password_change = false
max_frequency = "1s"

# Templates carry the production fragment contract documented in
# docs/supabase-auth-setup.md. content_path is PROJECT-ROOT-relative.
[auth.email.template.invite]
subject = "You are invited"
content_path = "./supabase/templates/invite.html"

[auth.email.template.recovery]
subject = "Reset your password"
content_path = "./supabase/templates/recovery.html"
```

If `supabase start` later rejects `major_version = 17`, align it with what `supabase init` generates on the installed CLI — the value must match the CLI's supported postgres image.

- [ ] **Step 2: Write the two templates**

`supabase/templates/invite.html`:
```html
<p><a href="{{ .SiteURL }}/#token_hash={{ .TokenHash }}&type=invite">Accept the invitation</a></p>
```

`supabase/templates/recovery.html`:
```html
<p><a href="{{ .SiteURL }}/#token_hash={{ .TokenHash }}&type=recovery">Reset your password</a></p>
```

- [ ] **Step 3: Git-ignore the generated artifacts**

Append to the repo-root `.gitignore`:
```
supabase/signing_keys.json
supabase/.temp/
```

- [ ] **Step 4: Generate a signing key and start the stack (live verification)**

From the repo root (recipe as executed in Task 1 — with `signing_keys_path`
declared, the CLI reads the declared file before writing and errors if
absent, so pre-seed an empty array and let it write the file itself):
```bash
echo '[]' > supabase/signing_keys.json
supabase gen signing-key --algorithm ES256 --yes >/dev/null
supabase start >/dev/null
```
Expected: stack starts; final line is a JSON blob including `"API_URL":"http://127.0.0.1:54321"`.

- [ ] **Step 5: Verify JWKS, provider set, and container list**

```bash
curl -s http://127.0.0.1:54321/auth/v1/.well-known/jwks.json | python3 -c "import json,sys; ks=json.load(sys.stdin)['keys']; assert any(k.get('alg')=='ES256' and k.get('kid') for k in ks), ks; print('JWKS OK')"
PUB=$(supabase status -o env | grep '^PUBLISHABLE_KEY=' | cut -d= -f2)
curl -s http://127.0.0.1:54321/auth/v1/settings -H "apikey: $PUB" | python3 -c "import json,sys; ext=json.load(sys.stdin)['external']; en=sorted(k for k,v in ext.items() if v); assert en==['email'], en; print('providers OK')"
docker ps --format '{{.Names}}' | grep fabulous-writing-e2e | sort
```
Expected: `JWKS OK`, `providers OK`, and exactly `supabase_auth_…`, `supabase_db_…`, `supabase_inbucket_…`, `supabase_kong_…`, `supabase_rest_…`.

- [ ] **Step 6: Stop the stack and confirm a clean tree**

```bash
supabase stop
git status --short   # must show ONLY the intended new/modified files
```
`supabase/signing_keys.json` and `supabase/.temp/` must NOT appear (ignored).

- [ ] **Step 7: Commit**

```bash
git add supabase/config.toml supabase/templates .gitignore
git commit -m "feat(e2e): supabase CLI local stack definition (B27, #94)"
```

---

### Task 2: Wrapper script `scripts/e2e-supabase.sh` (+ default-gate structural tests)

**Files:**
- Create: `scripts/e2e-supabase.sh`
- Test: `backend/tests/test_e2e_supabase_sh.py` (default gate — no Docker, structural only)

**Interfaces:**
- Consumes: the Task 1 stack definition.
- Produces: env contract for `tests_e2e/` — `FW_SUPABASE_E2E_API_URL`, `FW_SUPABASE_E2E_MAILPIT_URL`, `FW_SUPABASE_PUBLISHABLE_KEY`, `FW_SUPABASE_SECRET_KEY` exported; then `uv run pytest tests_e2e -q -n0 "$@"` from `backend/`.

- [ ] **Step 1: Write the failing structural tests**

`backend/tests/test_e2e_supabase_sh.py`:
```python
"""Structural guards for scripts/e2e-supabase.sh.

These run in the default gate, so they must not need Docker, the supabase
CLI, or the network: they pin the script's contract, not its behavior.
"""

import os
import re
import subprocess
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "e2e-supabase.sh"


def test_default_gate_cannot_collect_the_e2e_suite():
    """The entire Docker-free guarantee of `uv run pytest -q` hangs on
    testpaths — pin it so a config edit cannot silently widen the gate."""
    cfg = tomllib.loads(
        (REPO_ROOT / "backend" / "pyproject.toml").read_text(encoding="utf-8")
    )
    assert cfg["tool"]["pytest"]["ini_options"]["testpaths"] == ["tests"]


def test_script_exists_and_is_executable():
    assert SCRIPT.is_file()
    assert SCRIPT.stat().st_mode & 0o111, "script must be executable"


def test_script_passes_bash_syntax_check():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


def test_script_sets_strict_mode():
    assert "set -euo pipefail" in SCRIPT.read_text(encoding="utf-8")


def test_pytest_invocation_targets_e2e_dir_without_xdist():
    """The suite shares one uvicorn process; parallel workers would race.

    -n0 must appear in the pytest line because the repo addopts default is
    `-n auto` (and `-p no:xdist` is banned by convention).
    """
    text = SCRIPT.read_text(encoding="utf-8")
    pytest_lines = [l for l in text.splitlines() if "pytest" in l]
    assert pytest_lines, "script must invoke pytest"
    assert any("tests_e2e" in l and "-n0" in l for l in pytest_lines)


def test_down_flag_maps_to_supabase_stop():
    text = SCRIPT.read_text(encoding="utf-8")
    assert "--down" in text
    assert "supabase stop" in text


def test_key_values_are_never_echoed():
    """Key NAMES may appear anywhere; VALUES must never reach stdout.

    Two leak channels are pinned: (a) no echo/printf line expands a *_KEY
    variable; (b) `supabase start` — which prints the keys on stdout — has
    its stdout discarded.
    """
    text = SCRIPT.read_text(encoding="utf-8")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(("echo", "printf")):
            assert not re.search(r"\$\{?\w*KEY", stripped), stripped
        if re.match(r"supabase start\b", stripped):
            assert ">/dev/null" in stripped, "supabase start prints keys on stdout"


def test_down_flag_invokes_supabase_stop(tmp_path):
    """Behavioral: --down dispatches to `supabase stop` and nothing else
    (stub-binary pattern, as in test_fabulous_sh.py — no Docker needed)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    stub = bin_dir / "supabase"
    stub.write_text(f'#!/usr/bin/env bash\necho "$@" >> "{log}"\n', encoding="utf-8")
    stub.chmod(0o755)
    env = os.environ | {"PATH": f"{bin_dir}:{os.environ['PATH']}"}
    subprocess.run([str(SCRIPT), "--down"], check=True, env=env, timeout=30)
    assert log.read_text(encoding="utf-8").strip() == "stop"


def test_missing_cli_yields_actionable_error():
    """Without the supabase CLI on PATH, the pre-flight message names it —
    for every invocation shape, including --down."""
    env = os.environ | {"PATH": "/usr/bin:/bin"}
    result = subprocess.run(
        [str(SCRIPT), "--down"], capture_output=True, text=True, env=env, timeout=30
    )
    assert result.returncode == 1
    assert "supabase CLI not found" in result.stderr
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `backend/`: `uv run pytest tests/test_e2e_supabase_sh.py -n0 -q`
Expected: FAIL (`SCRIPT.is_file()` is False — script does not exist yet).

- [ ] **Step 3: Write the script**

`scripts/e2e-supabase.sh`:
```bash
#!/usr/bin/env bash
# Offline supabase e2e suite runner (B27, #94).
#
# Usage:
#   scripts/e2e-supabase.sh [pytest args...]   # run the suite (starts stack if down)
#   scripts/e2e-supabase.sh --down             # stop the local supabase stack
#
# The stack is left running between invocations for fast iteration.
set -euo pipefail

cd "$(dirname "$0")/.."

command -v supabase >/dev/null 2>&1 || {
    echo "error: supabase CLI not found (brew install supabase/tap/supabase)" >&2
    exit 1
}

if [[ "${1:-}" == "--down" ]]; then
    # Plain stop (keeps the DB volume as a backup): local reruns therefore
    # accumulate GoTrue users across stack generations — which is exactly
    # why run-unique identities, not cleanup, are the correctness mechanism.
    supabase stop
    exit 0
fi

docker info >/dev/null 2>&1 || {
    echo "error: docker daemon not reachable (colima start?)" >&2
    exit 1
}

# ES256 signing key for local GoTrue. With signing_keys_path declared in
# config.toml, `gen signing-key` reads the declared file BEFORE writing and
# hard-errors if it is absent (discovered in Task 1; the redirect form
# corrupts the file with a JSON error object). Working recipe: pre-seed an
# empty array, then let the CLI write the declared file itself (native JSON
# array; --yes answers the overwrite prompt; stdout discarded — it names
# the file, not the key, but stay conservative). A failed generation leaves
# `[]`, which the condition below treats as regenerate-needed: self-healing.
if [[ ! -s supabase/signing_keys.json ]] || [[ "$(cat supabase/signing_keys.json)" == "[]" ]]; then
    echo '[]' > supabase/signing_keys.json
    supabase gen signing-key --algorithm ES256 --yes >/dev/null
fi

# Start the stack only if it is not already running. stdout is discarded:
# supabase start prints the stack's keys there.
if ! supabase status >/dev/null 2>&1; then
    supabase start >/dev/null
fi

# Stack coordinates and keys, from the CLI's own env output. SECRET maps to
# the legacy SERVICE_ROLE_KEY: local GoTrue rejects the sb_secret_ opaque
# key as a Bearer admin credential (the hosted platform translates it, the
# local Kong does not) — verified on CLI 2.114.0.
eval "$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|PUBLISHABLE_KEY|SERVICE_ROLE_KEY|MAILPIT_URL)=' || true)"
for var in API_URL PUBLISHABLE_KEY SERVICE_ROLE_KEY MAILPIT_URL; do
    [[ -n "${!var:-}" ]] || {
        echo "error: supabase status did not report $var — is the stack healthy? (supabase status)" >&2
        exit 1
    }
done
export FW_SUPABASE_E2E_API_URL="$API_URL"
export FW_SUPABASE_E2E_MAILPIT_URL="$MAILPIT_URL"
export FW_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY"
export FW_SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY"

cd backend
exec uv run pytest tests_e2e -q -n0 "$@"
```

Then: `chmod +x scripts/e2e-supabase.sh`

- [ ] **Step 4: Run the structural tests to verify they pass**

Run from `backend/`: `uv run pytest tests/test_e2e_supabase_sh.py -n0 -q`
Expected: PASS (9 tests).

- [ ] **Step 5: Mutation-verify the guards**

Each mutation → re-run → named test must FAIL → revert → PASS:
1. Add `echo "$PUBLISHABLE_KEY"` to the script → `test_key_values_are_never_echoed`.
2. Change `supabase start >/dev/null` to `supabase start` → `test_key_values_are_never_echoed`.
3. Delete `-n0` from the pytest line → `test_pytest_invocation_targets_e2e_dir_without_xdist`.
4. Change `testpaths = ["tests"]` in `backend/pyproject.toml` to `["tests", "tests_e2e"]` → `test_default_gate_cannot_collect_the_e2e_suite`.
5. Change the `--down` branch to `supabase stop --no-backup` → `test_down_flag_invokes_supabase_stop`.

- [ ] **Step 6: Run the full default gate**

From `backend/`: `uv run pytest -q`
Expected: green, zero warnings, and NO `tests_e2e` collection (directory does not exist yet — this stays true after Task 3 thanks to `testpaths`).

- [ ] **Step 7: Commit**

```bash
git add scripts/e2e-supabase.sh backend/tests/test_e2e_supabase_sh.py
git commit -m "feat(e2e): wrapper script with stack lifecycle + env plumbing (B27, #94)"
```

---

### Task 3: E2E harness + boot/login flow

**Files:**
- Create: `backend/tests_e2e/__init__.py` (empty)
- Create: `backend/tests_e2e/conftest.py`
- Create: `backend/tests_e2e/mailpit.py`
- Create: `backend/tests_e2e/helpers.py`
- Test: `backend/tests_e2e/test_boot_and_login.py`

**Interfaces:**
- Consumes: the wrapper's env contract (Task 2): `FW_SUPABASE_E2E_API_URL`, `FW_SUPABASE_E2E_MAILPIT_URL`, `FW_SUPABASE_PUBLISHABLE_KEY`, `FW_SUPABASE_SECRET_KEY`.
- Produces (used by Tasks 4–7):
  - fixtures `runid: str`, `stack: StackEnv` (fields `api_url`, `mailpit_url`, `publishable_key`, `secret_key`), `app_url: str` (session-scoped; `http://127.0.0.1:8001`), `admin_creds: tuple[str, str]`, `mailpit: Mailpit`
  - `helpers.login(app_url, email, password) -> dict` (asserts 200, returns LoginResponse JSON: keys `token`, `refresh_token`, `expires_at`, `user`)
  - `helpers.expect_login_failure(app_url, email, password) -> int` (returns status code, asserts != 200)
  - `helpers.bearer(token) -> dict` (`{"Authorization": f"Bearer {token}"}`)
  - `helpers.admin_create_user(app_url, admin_token, email, password=None) -> dict` (asserts 201, returns response JSON incl. `invited`)
  - `Mailpit.wait_for_message(to: str, timeout: float = 20.0) -> dict` (message detail JSON incl. `HTML`; polls every 0.5 s, fails the test on timeout)
  - `Mailpit.extract_token(html: str) -> tuple[str, str]` (returns `(token_hash, type)`)

- [ ] **Step 1: Write `conftest.py`**

```python
"""Session harness for the offline supabase e2e suite (B27, #94).

Run via scripts/e2e-supabase.sh — it starts the supabase local stack and
exports the env contract this file consumes. The suite boots the REAL app:
a uvicorn subprocess on 127.0.0.1:8001 with a tempfile SQLite DB, exactly
the production startup path (config load, credential resolution, provider
lockout probe, seed_admin under a live event loop).
"""

import os
import secrets
import socket
import subprocess
import sys
import time
import warnings
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
import yaml

from .mailpit import Mailpit

BACKEND_DIR = Path(__file__).resolve().parents[1]
APP_PORT = 8001
APP_URL = f"http://127.0.0.1:{APP_PORT}"

_REQUIRED_ENV = (
    "FW_SUPABASE_E2E_API_URL",
    "FW_SUPABASE_E2E_MAILPIT_URL",
    "FW_SUPABASE_PUBLISHABLE_KEY",
    "FW_SUPABASE_SECRET_KEY",
)


@dataclass(frozen=True)
class StackEnv:
    api_url: str
    mailpit_url: str
    publishable_key: str
    secret_key: str


@pytest.fixture(scope="session")
def stack() -> StackEnv:
    missing = [k for k in _REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        pytest.exit(
            "supabase e2e env incomplete (missing: "
            + ", ".join(missing)
            + ") — run the suite via scripts/e2e-supabase.sh",
            returncode=2,
        )
    return StackEnv(
        api_url=os.environ["FW_SUPABASE_E2E_API_URL"],
        mailpit_url=os.environ["FW_SUPABASE_E2E_MAILPIT_URL"],
        publishable_key=os.environ["FW_SUPABASE_PUBLISHABLE_KEY"],
        secret_key=os.environ["FW_SUPABASE_SECRET_KEY"],
    )


@pytest.fixture(scope="session")
def runid() -> str:
    return secrets.token_hex(4)


@pytest.fixture(scope="session")
def admin_creds(runid: str) -> tuple[str, str]:
    return (f"admin-{runid}@e2e.local", f"e2e-admin-password-{runid}")


@pytest.fixture(scope="session")
def mailpit(stack: StackEnv) -> Mailpit:
    return Mailpit(stack.mailpit_url)


def _port_in_use(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(1)
        return sock.connect_ex(("127.0.0.1", port)) == 0


@pytest.fixture(scope="session")
def app_url(
    stack: StackEnv,
    admin_creds: tuple[str, str],
    tmp_path_factory: pytest.TempPathFactory,
):
    if _port_in_use(APP_PORT):
        pytest.exit(
            f"port {APP_PORT} is already in use — refusing to start the"
            " scratch app (another stack still running?)",
            returncode=2,
        )
    tmp = tmp_path_factory.mktemp("e2e-app")
    rules_dir = tmp / "rules"
    rules_dir.mkdir()
    config = {
        "db_path": str(tmp / "e2e.db"),
        "rules_dir": str(rules_dir),
        "auth": {"mode": "supabase", "supabase": {"url": stack.api_url}},
    }
    config_file = tmp / "config.yaml"
    config_file.write_text(yaml.safe_dump(config), encoding="utf-8")

    email, password = admin_creds
    env = os.environ | {
        "FW_CONFIG_FILE": str(config_file),
        "FW_ADMIN_EMAIL": email,
        "FW_ADMIN_PASSWORD": password,
    }
    env.pop("FW_AUTH_SECRET", None)  # supabase mode must not need it

    log_path = tmp / "uvicorn.log"
    with log_path.open("wb") as log:
        proc = subprocess.Popen(
            [
                sys.executable, "-m", "uvicorn", "app.main:app",
                "--host", "127.0.0.1", "--port", str(APP_PORT),
            ],
            cwd=BACKEND_DIR,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    try:
        deadline = time.monotonic() + 60
        last_error = None
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            try:
                if httpx.get(f"{APP_URL}/api/health", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError as exc:
                last_error = exc
            time.sleep(0.5)
        else:
            # No terminate here: pytest.exit must emit the diagnostics
            # first; the finally block below owns process cleanup.
            pytest.exit(
                f"app did not become healthy within 60s (last error:"
                f" {last_error!r}); uvicorn log tail:\n"
                + "\n".join(log_path.read_text(errors="replace").splitlines()[-30:]),
                returncode=2,
            )
        if proc.poll() is not None:
            pytest.exit(
                "uvicorn exited during startup; log tail:\n"
                + "\n".join(log_path.read_text(errors="replace").splitlines()[-30:]),
                returncode=2,
            )
        yield APP_URL
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        # Bounded poll + warn (never raise from teardown: an assert here
        # would mask whatever actually ended the run).
        deadline = time.monotonic() + 5
        while _port_in_use(APP_PORT) and time.monotonic() < deadline:
            time.sleep(0.2)
        if _port_in_use(APP_PORT):
            warnings.warn(f"scratch app port {APP_PORT} still bound after teardown")


@pytest.fixture(scope="session", autouse=True)
def _gotrue_cleanup(stack: StackEnv, runid: str):
    """Best-effort: delete this run's GoTrue users at session end.

    Correctness never depends on this — identities are run-unique — but a
    reused stack should not accumulate garbage. Errors are swallowed.
    """
    yield
    headers = {
        "apikey": stack.secret_key,
        "Authorization": f"Bearer {stack.secret_key}",
    }
    try:
        resp = httpx.get(
            f"{stack.api_url}/auth/v1/admin/users",
            params={"page": 1, "per_page": 200},
            headers=headers,
            timeout=10,
        )
        for user in resp.json().get("users", []):
            if runid in (user.get("email") or ""):
                httpx.delete(
                    f"{stack.api_url}/auth/v1/admin/users/{user['id']}",
                    headers=headers,
                    timeout=10,
                )
    except (httpx.HTTPError, ValueError, KeyError):
        pass
```

- [ ] **Step 2: Write `mailpit.py`**

```python
"""Minimal Mailpit REST client (API shapes verified on the CLI 2.114.0 stack)."""

import re
import time

import httpx

_TOKEN_RE = re.compile(r'#token_hash=([^&"]+)&type=(\w+)')


class Mailpit:
    def __init__(self, base_url: str) -> None:
        self._base = base_url.rstrip("/")

    def wait_for_message(self, to: str, timeout: float = 20.0) -> dict:
        """Newest message addressed to `to`, polled every 0.5 s."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            resp = httpx.get(
                f"{self._base}/api/v1/search",
                params={"query": f"to:{to}"},
                timeout=10,
            )
            resp.raise_for_status()
            messages = resp.json().get("messages", [])
            if messages:
                msg_id = messages[0]["ID"]
                detail = httpx.get(
                    f"{self._base}/api/v1/message/{msg_id}", timeout=10
                )
                detail.raise_for_status()
                return detail.json()
            time.sleep(0.5)
        raise AssertionError(
            f"no mail for {to!r} within {timeout}s — note GoTrue's default"
            " email rate limit (30 mails/hour, not configurable on the"
            " Mailpit-backed local stack) can also cause this: run"
            " scripts/e2e-supabase.sh --down and restart the stack"
        )

    @staticmethod
    def extract_token(html: str) -> tuple[str, str]:
        """(token_hash, type) from the templated fragment link."""
        match = _TOKEN_RE.search(html)
        assert match, f"no token_hash fragment in mail HTML: {html[:200]}"
        return match.group(1), match.group(2)
```

- [ ] **Step 3: Write `helpers.py`**

```python
"""Request helpers shared by the e2e flow files."""

import httpx

TIMEOUT = 30.0  # first verify() fetches JWKS; be generous


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def login(app_url: str, email: str, password: str) -> dict:
    resp = httpx.post(
        f"{app_url}/api/auth/login",
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    assert resp.status_code == 200, f"login failed: {resp.status_code} {resp.text}"
    body = resp.json()
    assert body["token"] and body["refresh_token"] and body["expires_at"]
    return body


def expect_login_failure(app_url: str, email: str, password: str) -> int:
    resp = httpx.post(
        f"{app_url}/api/auth/login",
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    assert resp.status_code != 200, "login unexpectedly succeeded"
    return resp.status_code


def admin_create_user(
    app_url: str, admin_token: str, email: str, password: str | None = None
) -> dict:
    payload: dict = {"email": email}
    if password is not None:
        payload["password"] = password
    resp = httpx.post(
        f"{app_url}/api/admin/users",
        json=payload,
        headers=bearer(admin_token),
        timeout=TIMEOUT,
    )
    assert resp.status_code == 201, f"create failed: {resp.status_code} {resp.text}"
    return resp.json()
```

- [ ] **Step 4: Write the boot/login flow tests**

`backend/tests_e2e/test_boot_and_login.py`:
```python
"""Flow 1+2: real-server boot against the live stack, health, admin login.

A passing app_url fixture already proves the hard part: create_app ran the
full production startup (credential resolution, OAuth lockout probe against
live GoTrue settings, seed_admin under a running uvicorn event loop).
"""

import httpx
import jwt

from .helpers import bearer, expect_login_failure, login


def test_health_advertises_supabase_auth_features(app_url):
    body = httpx.get(f"{app_url}/api/health", timeout=10).json()
    assert body["auth_features"] == {"password_reset": True, "invites": True}


def test_admin_login_returns_full_session_and_me_works(app_url, admin_creds):
    email, password = admin_creds
    session = login(app_url, email, password)
    assert session["user"]["email"] == email
    me = httpx.get(
        f"{app_url}/api/auth/me", headers=bearer(session["token"]), timeout=30
    )
    assert me.status_code == 200
    assert me.json()["email"] == email


def test_wrong_password_is_rejected(app_url, admin_creds):
    email, _ = admin_creds
    assert expect_login_failure(app_url, email, "definitely-wrong-password-x") == 401


def test_garbage_bearer_token_is_rejected(app_url):
    resp = httpx.get(
        f"{app_url}/api/auth/me", headers=bearer("not-a-jwt"), timeout=30
    )
    assert resp.status_code == 401


def test_session_token_is_es256_with_kid(app_url, admin_creds):
    """Pins the signing-keys wiring (spec flow 2: 'verified via real JWKS').

    signing_keys_path has a surprising relative base (supabase/-relative,
    unlike content_path) — if a future config edit breaks it, local GoTrue
    silently falls back to legacy HS256 and this is the test that says so.
    """
    session = login(app_url, *admin_creds)
    header = jwt.get_unverified_header(session["token"])
    assert header["alg"] == "ES256"
    assert header["kid"]
```

(`import jwt` at the top of the file — PyJWT is already a backend dependency.)

- [ ] **Step 5: Run the suite via the wrapper (first full loop)**

From the repo root: `scripts/e2e-supabase.sh`
Expected: stack starts (or reuses), uvicorn boots, 5 tests PASS. If the app fails to boot, the fixture prints the uvicorn log tail — debug from there (this step is precisely where integration bugs surface; that is the suite's purpose).

- [ ] **Step 6: Verify the default gate still cannot see the suite**

From `backend/`: `uv run pytest -q -n0 --collect-only | grep -c tests_e2e || true` → must print `0`. Then run the full default gate: `uv run pytest -q` → green, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add backend/tests_e2e
git commit -m "feat(e2e): harness (uvicorn fixture, mailpit client) + boot/login flow (B27, #94)"
```

---

### Task 4: Refresh rotation + logout flows

**Files:**
- Test: `backend/tests_e2e/test_sessions.py`

**Interfaces:**
- Consumes: `app_url`, `admin_creds` fixtures; `helpers.login`, `helpers.bearer`.

- [ ] **Step 1: Write the flow tests**

```python
"""Flow 3+4: refresh-token rotation and logout, against real GoTrue.

refresh_token_reuse_interval = 0 in supabase/config.toml makes consumed-
token rejection immediate (hosted default is a 10 s grace window).
"""

import httpx

from .helpers import bearer, login

TIMEOUT = 30.0


def _refresh(app_url: str, refresh_token: str) -> httpx.Response:
    return httpx.post(
        f"{app_url}/api/auth/refresh",
        json={"refresh_token": refresh_token},
        timeout=TIMEOUT,
    )


def test_refresh_rotates_and_consumed_token_dies(app_url, admin_creds):
    session = login(app_url, *admin_creds)
    first = _refresh(app_url, session["refresh_token"])
    assert first.status_code == 200
    rotated = first.json()
    assert rotated["token"] and rotated["refresh_token"]
    assert rotated["refresh_token"] != session["refresh_token"]
    # the rotated access token is honored by the app
    me = httpx.get(
        f"{app_url}/api/auth/me", headers=bearer(rotated["token"]), timeout=TIMEOUT
    )
    assert me.status_code == 200
    # the consumed token is dead (rotation, zero reuse interval)
    again = _refresh(app_url, session["refresh_token"])
    assert again.status_code == 401


def test_logout_kills_the_refresh_pair(app_url, admin_creds):
    session = login(app_url, *admin_creds)
    resp = httpx.post(
        f"{app_url}/api/auth/logout",
        headers=bearer(session["token"]),
        timeout=TIMEOUT,
    )
    assert resp.status_code == 204
    after = _refresh(app_url, session["refresh_token"])
    assert after.status_code == 401
```

- [ ] **Step 2: Run the suite via the wrapper**

`scripts/e2e-supabase.sh` — expected: all tests PASS (including Task 3's).
If `test_refresh_rotates_and_consumed_token_dies` fails on the `again` assertion with 200: verify `refresh_token_reuse_interval = 0` survived in `supabase/config.toml` and restart the stack (`scripts/e2e-supabase.sh --down`, then rerun) — config changes need a stack restart.

- [ ] **Step 3: Commit**

```bash
git add backend/tests_e2e/test_sessions.py
git commit -m "feat(e2e): refresh rotation + logout flows (B27, #94)"
```

---

### Task 5: Password change + eviction flow

**Files:**
- Test: `backend/tests_e2e/test_password_change.py`

**Interfaces:**
- Consumes: `app_url`, `runid` fixtures; `helpers.login`, `helpers.expect_login_failure`, `helpers.bearer`, `helpers.admin_create_user`; `admin_creds` for the admin session.

- [ ] **Step 1: Write the flow tests**

```python
"""Flow 5: self-service password change with M2 eviction, live.

What is asserted — and what deliberately is not: the local iat-based access-
token eviction backdates password_changed_at by a 60 s clock-skew leeway, so
an access token minted seconds before the change survives that check by
design. Testing it would need a >60 s wall-clock wait. The e2e-observable
eviction guarantees are the ones asserted here: every outstanding REFRESH
token dies (GoTrue global sign-out) and the old password stops working.
The iat cutoff itself is pinned in the unit suite with controlled clocks.
"""

import httpx

from .helpers import admin_create_user, bearer, expect_login_failure, login

TIMEOUT = 30.0


def test_password_change_rotates_credential_and_kills_other_sessions(
    app_url, admin_creds, runid
):
    email = f"changer-{runid}@e2e.local"
    old_password = f"e2e-old-password-{runid}"
    new_password = f"e2e-new-password-{runid}"

    admin = login(app_url, *admin_creds)
    created = admin_create_user(app_url, admin["token"], email, old_password)
    assert created["invited"] is False

    session_a = login(app_url, email, old_password)
    session_b = login(app_url, email, old_password)

    resp = httpx.post(
        f"{app_url}/api/auth/password",
        json={"current": old_password, "new": new_password},
        headers=bearer(session_a["token"]),
        timeout=TIMEOUT,
    )
    assert resp.status_code == 204

    # every outstanding refresh pair is dead (global sign-out) ...
    for refresh_token in (session_a["refresh_token"], session_b["refresh_token"]):
        after = httpx.post(
            f"{app_url}/api/auth/refresh",
            json={"refresh_token": refresh_token},
            timeout=TIMEOUT,
        )
        assert after.status_code == 401

    # ... the old credential is dead, the new one works
    assert expect_login_failure(app_url, email, old_password) == 401
    assert login(app_url, email, new_password)["user"]["email"] == email
```

- [ ] **Step 2: Run the suite via the wrapper**

`scripts/e2e-supabase.sh` — expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/tests_e2e/test_password_change.py
git commit -m "feat(e2e): password change + eviction flow (B27, #94)"
```

---

### Task 6: Invite acceptance flow

**Files:**
- Test: `backend/tests_e2e/test_invite.py`

**Interfaces:**
- Consumes: `app_url`, `runid`, `mailpit` fixtures; `helpers.login`, `helpers.bearer`, `helpers.admin_create_user`; `Mailpit.wait_for_message`, `Mailpit.extract_token`.

- [ ] **Step 1: Write the flow tests**

```python
"""Flow 6: admin invite -> captured mail -> token_hash -> acceptance -> login.

This is the full production invite path: the app sends the invite through
GoTrue, GoTrue renders supabase/templates/invite.html (the committed
production fragment contract) and delivers via Mailpit, and acceptance goes
through POST /api/auth/reset-confirm, which JIT-creates the local row.
"""

import httpx

from .helpers import admin_create_user, login

TIMEOUT = 30.0


def test_invite_acceptance_end_to_end(app_url, admin_creds, runid, mailpit):
    email = f"invitee-{runid}@e2e.local"
    password = f"e2e-invitee-password-{runid}"

    admin = login(app_url, *admin_creds)
    created = admin_create_user(app_url, admin["token"], email)  # no password
    assert created["invited"] is True

    message = mailpit.wait_for_message(email)
    token_hash, link_type = mailpit.extract_token(message["HTML"])
    assert link_type == "invite"

    resp = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": token_hash, "type": "invite", "new_password": password},
        timeout=TIMEOUT,
    )
    assert resp.status_code == 204

    session = login(app_url, email, password)
    assert session["user"]["email"] == email
    assert session["user"]["is_admin"] is False


def test_stale_token_hash_is_rejected(app_url):
    resp = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={
            "token_hash": "0" * 56,
            "type": "invite",
            "new_password": "irrelevant-long-password-123",
        },
        timeout=TIMEOUT,
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_or_expired_link"
```

- [ ] **Step 2: Run the suite via the wrapper**

`scripts/e2e-supabase.sh` — expected: all tests PASS. If `wait_for_message` times out, open `http://127.0.0.1:54324` in a browser to inspect captured mail, and check the `MeResponse.is_admin` key name against `GET /api/auth/me` output if the last assertion fails.

- [ ] **Step 3: Commit**

```bash
git add backend/tests_e2e/test_invite.py
git commit -m "feat(e2e): invite acceptance flow via mailpit (B27, #94)"
```

---

### Task 7: Password reset flow

**Files:**
- Test: `backend/tests_e2e/test_reset.py`

**Interfaces:**
- Consumes: `app_url`, `runid`, `mailpit` fixtures; `helpers.login`, `helpers.expect_login_failure`, `helpers.admin_create_user`; `Mailpit` methods as in Task 6.

- [ ] **Step 1: Write the flow tests**

```python
"""Flow 7: password reset -> captured mail -> confirm -> eviction.

Throttle note: the app-level reset throttle blocks silently (always 204, no
gateway call), and GoTrue's own SMTP rate limit (max_frequency) can also
suppress mail — so "no mail arrived" cannot distinguish the two. The
throttle's blocking semantics are pinned in the unit suite; here we assert
only the unenumerable-response contract: every request returns 204,
including for an unknown email.
"""

import httpx

from .helpers import admin_create_user, expect_login_failure, login

TIMEOUT = 30.0


def test_password_reset_end_to_end_with_eviction(
    app_url, admin_creds, runid, mailpit
):
    email = f"resetter-{runid}@e2e.local"
    old_password = f"e2e-reset-old-{runid}-x"
    new_password = f"e2e-reset-new-{runid}-x"

    admin = login(app_url, *admin_creds)
    admin_create_user(app_url, admin["token"], email, old_password)
    pre_reset_session = login(app_url, email, old_password)

    resp = httpx.post(
        f"{app_url}/api/auth/reset-request", json={"email": email}, timeout=TIMEOUT
    )
    assert resp.status_code == 204

    message = mailpit.wait_for_message(email)
    token_hash, link_type = mailpit.extract_token(message["HTML"])
    assert link_type == "recovery"

    confirm = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={
            "token_hash": token_hash,
            "type": "recovery",
            "new_password": new_password,
        },
        timeout=TIMEOUT,
    )
    assert confirm.status_code == 204

    # pre-reset refresh pair is dead (reset-confirm eviction)
    after = httpx.post(
        f"{app_url}/api/auth/refresh",
        json={"refresh_token": pre_reset_session["refresh_token"]},
        timeout=TIMEOUT,
    )
    assert after.status_code == 401

    assert expect_login_failure(app_url, email, old_password) == 401
    assert login(app_url, email, new_password)["user"]["email"] == email


def test_reset_request_is_unenumerable(app_url, runid):
    """Unknown email must be indistinguishable from a known one."""
    resp = httpx.post(
        f"{app_url}/api/auth/reset-request",
        json={"email": f"never-existed-{runid}@e2e.local"},
        timeout=TIMEOUT,
    )
    assert resp.status_code == 204
```

- [ ] **Step 2: Run the suite via the wrapper**

`scripts/e2e-supabase.sh` — expected: all tests PASS (now ~12 across five files).

- [ ] **Step 3: Full verification pass**

1. `scripts/e2e-supabase.sh` twice in a row (reused stack, fresh runid each time) — both green: proves run-uniqueness isolation.
2. `scripts/e2e-supabase.sh --down`, then `scripts/e2e-supabase.sh` — green from a cold stack.
3. From `backend/`: `uv run pytest -q` — default gate green, zero warnings, zero `tests_e2e` collection.
4. Frontend gates untouched by this task — no need to run.

- [ ] **Step 4: Commit**

```bash
git add backend/tests_e2e/test_reset.py
git commit -m "feat(e2e): password reset flow with eviction (B27, #94)"
```

---

### Task 8: Manual CI workflow

**Files:**
- Create: `.github/workflows/e2e-supabase.yml`

**Interfaces:**
- Consumes: `scripts/e2e-supabase.sh` (Task 2) and the stack definition (Task 1).

- [ ] **Step 1: Write the workflow**

```yaml
name: Supabase E2E

# Manual only, by design (B27): the suite needs Docker + the supabase CLI
# and takes minutes — trigger it on a branch before merging auth-flow work.
on:
  workflow_dispatch:

concurrency:
  group: e2e-supabase-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7

      - uses: supabase/setup-cli@v1
        with:
          version: 2.114.0

      - name: Install uv
        uses: astral-sh/setup-uv@v7
        with:
          enable-cache: true
          cache-dependency-glob: "backend/uv.lock"

      - name: Install dependencies (incl. spaCy models)
        run: uv sync --locked
        working-directory: backend

      # No Hunspell dictionaries: the e2e suite never runs a spell check,
      # and dictionaries_dir's contract tolerates missing files.

      - name: Run supabase e2e suite
        run: ./scripts/e2e-supabase.sh

      - name: Stop supabase stack
        if: always()
        run: supabase stop --no-backup || true
```

- [ ] **Step 2: Validate the workflow file**

`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/e2e-supabase.yml')); print('yaml OK')"`
Expected: `yaml OK`. (Full behavior is validated by dispatching the workflow once the PR branch is pushed — note this for the PR description; it is the review-time verification.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/e2e-supabase.yml
git commit -m "ci(e2e): manual workflow_dispatch job for the supabase e2e suite (B27, #94)"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/backend-architecture.md` (add an "Offline supabase e2e suite" subsection to the testing section)
- Modify: `docs/supabase-auth-setup.md` (one cross-reference line)
- Modify: `README.md` (developer how-to, near existing test instructions)

**Interfaces:**
- Consumes: everything above; describes, changes no behavior.

- [ ] **Step 1: backend-architecture.md**

Add a subsection to the testing chapter covering, in this order: purpose (integration truth for the B14 surface; catches real-server-boot bugs — cite the `asyncio.run`-under-uvicorn seeding crash as the motivating example); the three layers (stack definition `supabase/`, wrapper `scripts/e2e-supabase.sh`, suite `backend/tests_e2e/`); the env contract (`FW_SUPABASE_E2E_API_URL`, `FW_SUPABASE_E2E_MAILPIT_URL`, `FW_SUPABASE_PUBLISHABLE_KEY`=publishable, `FW_SUPABASE_SECRET_KEY`=legacy service-role JWT — with the local-GoTrue `sb_secret_` rejection fact); isolation model (reused stack, run-unique `<role>-<runid>@e2e.local` identities, tempfile SQLite per run, best-effort GoTrue cleanup); what is deliberately NOT asserted (iat-cutoff eviction — 60 s leeway; throttle blocking — silent by design; adversarial token cases — unit suite); operational limits (GoTrue's email rate limit of 30 mails/hour is NOT configurable on the Mailpit-backed local stack — the CLI only exports `GOTRUE_RATE_LIMIT_EMAIL_SENT` with a real SMTP config — so at 2 mails per run, ~15 runs/hour before `wait_for_message` times out; remedy is `--down` + restart); the colima `$HOME`-share caveat (fact 9 above); and the differing config.toml path bases (fact 2). Follow the file's existing prose style, English, no headers deeper than the file already uses.

- [ ] **Step 2: supabase-auth-setup.md**

In the email-templates section, add one sentence: the committed local-stack templates under `supabase/templates/` carry this exact fragment contract and are exercised by the offline e2e suite (`scripts/e2e-supabase.sh`), so template-contract drift breaks a test before it breaks production.

- [ ] **Step 3: README.md**

Next to the existing backend test instructions, add a short block: what the suite covers in one sentence, `scripts/e2e-supabase.sh` to run, `scripts/e2e-supabase.sh --down` to stop the stack, prerequisites (Docker via colima, supabase CLI), and that the default `pytest` gate never needs any of this.

- [ ] **Step 4: Run both default gates**

From `backend/`: `uv run pytest -q` (green, zero warnings). From `frontend/`: not needed (no frontend changes in this task or plan).

- [ ] **Step 5: Commit**

```bash
git add docs/backend-architecture.md docs/supabase-auth-setup.md README.md
git commit -m "docs(e2e): architecture, setup-guide and README coverage for the supabase e2e suite (B27, #94)"
```

---

## Post-plan (session-level, not tasks)

- LOGBOOK entry: last commit on the PR branch before merge, per convention.
- PR: `b27-supabase-e2e` → main, `Closes #94.`, Copilot review requested, watcher spawned.
- After push: trigger the `Supabase E2E` workflow once on the branch to validate Task 8 end-to-end.
