# Runtime Hardening + Update Story Implementation Plan (B21 #78, B26 #86)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the container runtime (env-file path/parsing, reverse-proxy opt-in, wizard rerun edge, port pre-check) and give the quickstart an update story (auto-pull + README note).

**Architecture:** Shell changes in `docker/entrypoint.sh` and `fabulous.sh`, one-line logic change in `backend/app/setup_wizard.py`, README additions. Shell behavior is tested inside the normal backend pytest gate by running the real scripts under `/bin/sh` with stub executables (`uvicorn`, `docker`, `nc`) on a controlled `PATH` — no Docker, no network.

**Tech Stack:** POSIX sh, Python 3.13 / pytest (run from `backend/` with `uv`), uvicorn CLI flags.

**Spec:** `docs/superpowers/specs/2026-08-11-runtime-hardening-update-story-design.md`

## Global Constraints

- Gate before EVERY commit: from `backend/`, `uv run pytest -q` green with ZERO warnings in the summary line. Never add `-W error`.
- Frontend untouched: `git status --short -- frontend/` must stay empty.
- Every commit message ends with exactly these two trailer lines:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`
- Malformed env-line errors name file and line NUMBER only — never echo line content (may hold a mis-pasted secret).
- `FW_TRUSTED_PROXIES` is a container env var, NOT a Settings/config knob.
- Exit codes: 78 (EX_CONFIG) for entrypoint config errors, 75 for the port pre-check refusal, 64 stays for usage errors.
- Subprocess tests invoke scripts as `["/bin/sh", str(script_path), ...]` — an absolute shell path, because the stub `PATH` passed via `env=` cannot resolve `sh` itself.
- Never widen a wall-clock test bound. Mutation-verify every guard test that never went red during TDD (delete the guard, watch the test fail, restore).
- Work happens on branch `b21-b26-runtime-hardening` (already created; spec committed).

---

### Task 1: Entrypoint env-file path + parser hardening

**Files:**
- Modify: `docker/entrypoint.sh`
- Modify: `.github/workflows/backend.yml` (path filter)
- Create (Test): `backend/tests/test_entrypoint_sh.py`

**Interfaces:**
- Produces: `ENV_FILE="${FW_ENV_FILE:-$(dirname "$CONFIG_FILE")/fabulous.env}"`; malformed line → stderr `Error: <file> line <N> is not a KEY=VALUE line`, exit 78. Test helpers `run_entrypoint(tmp_path, *, env_text=None, extra_env=None)`, `stub_env(out_dir)`, `stub_argv(out_dir)` — Task 2 adds tests to this file using them.

- [ ] **Step 1: Write the test file with harness and env-file tests**

Create `backend/tests/test_entrypoint_sh.py`:

```python
"""docker/entrypoint.sh serve-path behavior, driven with a stub uvicorn.

The real script runs under /bin/sh with a stub `uvicorn` first on PATH
that records its argv and environment — no Docker, no network. The
`setup` dispatch line is out of scope (it execs the wizard, which
test_setup_wizard.py covers directly).
"""

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT = REPO_ROOT / "docker" / "entrypoint.sh"

UVICORN_STUB = """\
#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/uvicorn.argv"
env > "$STUB_OUT/uvicorn.env"
"""


def run_entrypoint(tmp_path, *, env_text=None, extra_env=None):
    """Run `entrypoint.sh serve` against a tmp config dir and stub uvicorn.

    env_text, when given, becomes <config dir>/fabulous.env. PATH keeps
    /usr/bin:/bin so the script's `dirname` and the stub's `env` resolve.
    """
    config_dir = tmp_path / "config"
    config_dir.mkdir(exist_ok=True)
    (config_dir / "config.yaml").write_text("providers: {}\n", encoding="utf-8")
    if env_text is not None:
        (config_dir / "fabulous.env").write_text(env_text, encoding="utf-8")
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir(exist_ok=True)
    stub = stub_bin / "uvicorn"
    stub.write_text(UVICORN_STUB, encoding="utf-8")
    stub.chmod(0o755)
    out_dir = tmp_path / "out"
    out_dir.mkdir(exist_ok=True)
    env = {
        "PATH": f"{stub_bin}:/usr/bin:/bin",
        "STUB_OUT": str(out_dir),
        "FW_CONFIG_FILE": str(config_dir / "config.yaml"),
    }
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        ["/bin/sh", str(ENTRYPOINT), "serve"],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    return proc, out_dir


def stub_env(out_dir):
    """Parse the stub's `env` dump; first line wins per key (sentinel
    values in these tests never contain newlines)."""
    result = {}
    for line in (out_dir / "uvicorn.env").read_bytes().decode("utf-8").split("\n"):
        key, sep, value = line.partition("=")
        if sep:
            result.setdefault(key, value)
    return result


def stub_argv(out_dir):
    return (out_dir / "uvicorn.argv").read_text(encoding="utf-8").splitlines()


class TestEnvFileSelection:
    def test_env_file_next_to_config_is_applied(self, tmp_path):
        proc, out = run_entrypoint(tmp_path, env_text="FW_SENTINEL=from-file\n")
        assert proc.returncode == 0
        assert stub_env(out)["FW_SENTINEL"] == "from-file"

    def test_real_environment_wins_over_file(self, tmp_path):
        proc, out = run_entrypoint(
            tmp_path,
            env_text="FW_SENTINEL=from-file\n",
            extra_env={"FW_SENTINEL": "from-env"},
        )
        assert proc.returncode == 0
        assert stub_env(out)["FW_SENTINEL"] == "from-env"

    def test_fw_env_file_overrides_location(self, tmp_path):
        other = tmp_path / "elsewhere.env"
        other.write_text("FW_SENTINEL=elsewhere\n", encoding="utf-8")
        proc, out = run_entrypoint(tmp_path, extra_env={"FW_ENV_FILE": str(other)})
        assert proc.returncode == 0
        assert stub_env(out)["FW_SENTINEL"] == "elsewhere"

    def test_empty_fw_env_file_falls_back_to_derived_default(self, tmp_path):
        proc, out = run_entrypoint(
            tmp_path,
            env_text="FW_SENTINEL=from-file\n",
            extra_env={"FW_ENV_FILE": ""},
        )
        assert proc.returncode == 0
        assert stub_env(out)["FW_SENTINEL"] == "from-file"

    def test_missing_env_file_serves_anyway(self, tmp_path):
        proc, out = run_entrypoint(tmp_path)
        assert proc.returncode == 0
        assert (out / "uvicorn.argv").is_file()


class TestEnvFileParsing:
    def test_crlf_line_ending_stripped_from_value(self, tmp_path):
        proc, out = run_entrypoint(tmp_path, env_text="FW_SENTINEL=abc\r\n")
        assert proc.returncode == 0
        assert stub_env(out)["FW_SENTINEL"] == "abc"

    def test_comments_and_blank_lines_skipped(self, tmp_path):
        proc, out = run_entrypoint(
            tmp_path, env_text="# comment\n\nFW_SENTINEL=abc\n"
        )
        assert proc.returncode == 0
        assert stub_env(out)["FW_SENTINEL"] == "abc"

    def test_malformed_line_fails_naming_line_number_only(self, tmp_path):
        proc, out = run_entrypoint(
            tmp_path, env_text="# comment\nFW_OK=1\nfoo bar=leaky-value\n"
        )
        assert proc.returncode == 78
        assert "line 3" in proc.stderr
        assert "leaky-value" not in proc.stderr
        assert "foo bar" not in proc.stderr
        assert not (out / "uvicorn.argv").exists()

    def test_line_without_equals_fails(self, tmp_path):
        proc, out = run_entrypoint(tmp_path, env_text="justtext\n")
        assert proc.returncode == 78
        assert "line 1" in proc.stderr
        assert not (out / "uvicorn.argv").exists()
```

- [ ] **Step 2: Run the new tests, verify the expected failures**

Run (from `backend/`): `uv run pytest tests/test_entrypoint_sh.py -v -n0`

Expected FAILs against the current script — all for the same root cause: it reads only the hardcoded `/config/fabulous.env`, which does not exist on the test host, so the tmp env file is never opened and the script serves with exit 0. That fails `test_env_file_next_to_config_is_applied`, `test_fw_env_file_overrides_location`, `test_empty_fw_env_file_falls_back_to_derived_default`, `test_crlf_line_ending_stripped_from_value`, `test_comments_and_blank_lines_skipped` (each misses its sentinel), and both malformed-line tests (exit 0 instead of 78). Expected PASSes (trivially green for that same reason): `test_real_environment_wins_over_file`, `test_missing_env_file_serves_anyway` — these two get mutation-verified in Step 5.

- [ ] **Step 3: Rewrite the env-file block in `docker/entrypoint.sh`**

Replace lines 19–28 (the `if [ -f /config/fabulous.env ]` block) so the whole file reads:

```sh
#!/bin/sh
# Entrypoint: `setup` runs the wizard; anything else serves the app.
# Env-file semantics: the env file (default: fabulous.env next to the
# config file, override with FW_ENV_FILE) is applied only for variables
# not already set — real environment variables win (fly.io secrets, B16).
# NB: the wizard writes into FW_SETUP_CONFIG_DIR (default /config) — a
# deployment that relocates FW_CONFIG_FILE must relocate that too, or
# set FW_ENV_FILE explicitly.
set -eu

if [ "${1:-serve}" = "setup" ]; then
    exec python -m app.setup_wizard
fi

CONFIG_FILE="${FW_CONFIG_FILE:-/config/config.yaml}"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No $CONFIG_FILE found. Run the setup wizard first:" >&2
    echo "  docker run --rm -it -v fabulous-config:/config <image> setup" >&2
    echo "(or ./fabulous.sh setup)" >&2
    exit 78
fi

# Never echo the offending line: it may hold a mis-pasted secret.
bad_env_line() {
    echo "Error: $1 line $2 is not a KEY=VALUE line" >&2
    exit 78
}

ENV_FILE="${FW_ENV_FILE:-$(dirname "$CONFIG_FILE")/fabulous.env}"
if [ -f "$ENV_FILE" ]; then
    cr=$(printf '\r')
    lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
        lineno=$((lineno + 1))
        line=${line%"$cr"}
        case "$line" in ''|\#*) continue ;; esac
        case "$line" in
            *=*) ;;
            *) bad_env_line "$ENV_FILE" "$lineno" ;;
        esac
        key=${line%%=*}
        value=${line#*=}
        # A key that export can't accept would crash with a bare shell
        # error under set -eu; validate POSIX name syntax first.
        case "$key" in
            ''|*[!A-Za-z0-9_]*|[0-9]*) bad_env_line "$ENV_FILE" "$lineno" ;;
        esac
        if ! printenv "$key" >/dev/null 2>&1; then
            export "$key=$value"
        fi
    done < "$ENV_FILE"
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
```

(`exit` inside the loop terminates the script: the `< "$ENV_FILE"` redirection runs the loop in the current shell, not a pipeline subshell.)

- [ ] **Step 4: Run the new tests, verify all pass**

Run: `uv run pytest tests/test_entrypoint_sh.py -v -n0`
Expected: all 9 PASS.

- [ ] **Step 5: Mutation-verify the trivially-green guards**

One at a time, hand-edit `docker/entrypoint.sh`, re-run the named test, confirm it FAILS, revert the edit:
1. Swap the precedence branch — replace the `if ! printenv …; then export …; fi` body with an unconditional `export "$key=$value"` → `test_real_environment_wins_over_file` must fail.
2. Add an `else` branch to `if [ -f "$ENV_FILE" ]` (before its `fi`): `else echo "no env file" >&2; exit 78;` → `test_missing_env_file_serves_anyway` must fail (exit 78, no argv file). (Do NOT mutate via `if true` + reading the missing file: a redirection failure inside a compound command is fatal under dash but NOT under macOS bash-as-sh, so that mutation only goes red on Linux.)

After the two rounds, `git diff docker/entrypoint.sh` must show only the Step 3 state (all mutations reverted); re-run the file once more to confirm green.

- [ ] **Step 6: Add the new shell scripts to the backend CI path filter**

In `.github/workflows/backend.yml`, both `on.push.paths` and `on.pull_request.paths` currently list `"backend/**"` and `".github/workflows/backend.yml"`. Add to BOTH lists:

```yaml
      - "docker/entrypoint.sh"
```

Without this, a later change to the script alone would silently skip the very tests that guard it (this PR triggers the workflow anyway via `backend/**`, but future script-only changes would not). Task 4 adds the matching `fabulous.sh` line in its own commit.

- [ ] **Step 7: Full gate and commit**

Run from `backend/`: `uv run pytest -q` — green, zero warnings. Check `git status --short -- frontend/` is empty.

```bash
git add docker/entrypoint.sh backend/tests/test_entrypoint_sh.py .github/workflows/backend.yml
git commit -m "fix(docker): derive env-file path from config dir, harden env parsing (B21, #78)

FW_ENV_FILE overrides; default follows dirname(FW_CONFIG_FILE) so a
relocated config carries its secrets file. CRLF values are stripped; a
malformed line fails fast naming file+line number only (content may
hold a mis-pasted secret) instead of dying in export's bare error.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

### Task 2: Reverse-proxy opt-in (FW_TRUSTED_PROXIES)

**Files:**
- Modify: `docker/entrypoint.sh` (the final `exec uvicorn` line from Task 1)
- Modify: `backend/app/api/auth.py:367-371` (comment only)
- Modify: `README.md` (troubleshooting section, after the "Port already in use" bullet)
- Test: `backend/tests/test_entrypoint_sh.py` (append; uses Task 1's `run_entrypoint`/`stub_argv`)

**Interfaces:**
- Consumes: Task 1's helpers and final entrypoint layout.
- Produces: env contract `FW_TRUSTED_PROXIES` (comma-separated IPs/CIDRs or `*`); set+non-empty ⇒ uvicorn argv gains `--proxy-headers --forwarded-allow-ips <value>`.

- [ ] **Step 1: Append the failing tests**

Append to `backend/tests/test_entrypoint_sh.py`:

```python
class TestTrustedProxies:
    def test_flags_added_when_set(self, tmp_path):
        proc, out = run_entrypoint(
            tmp_path, extra_env={"FW_TRUSTED_PROXIES": "10.0.0.1,10.0.0.2"}
        )
        assert proc.returncode == 0
        argv = stub_argv(out)
        assert "--proxy-headers" in argv
        assert argv[argv.index("--forwarded-allow-ips") + 1] == "10.0.0.1,10.0.0.2"

    def test_flags_absent_by_default(self, tmp_path):
        proc, out = run_entrypoint(tmp_path)
        assert proc.returncode == 0
        argv = stub_argv(out)
        assert "--proxy-headers" not in argv
        assert "--forwarded-allow-ips" not in argv

    def test_empty_value_means_off(self, tmp_path):
        proc, out = run_entrypoint(tmp_path, extra_env={"FW_TRUSTED_PROXIES": ""})
        assert proc.returncode == 0
        assert "--proxy-headers" not in stub_argv(out)
```

- [ ] **Step 2: Run, verify the expected failure**

Run: `uv run pytest tests/test_entrypoint_sh.py -v -n0 -k TrustedProxies`
Expected: `test_flags_added_when_set` FAILS (`--proxy-headers` absent); the other two pass trivially — mutation-verified in Step 5.

- [ ] **Step 3: Implement in `docker/entrypoint.sh`**

Replace the final line (`exec uvicorn app.main:app --host 0.0.0.0 --port 8000`) with:

```sh
# Opt-in reverse-proxy support: uvicorn rewrites request.client from
# X-Forwarded-For only for peers on this list, so the login throttle
# keys on real client IPs instead of collapsing to the proxy's.
if [ -n "${FW_TRUSTED_PROXIES:-}" ]; then
    exec uvicorn app.main:app --host 0.0.0.0 --port 8000 \
        --proxy-headers --forwarded-allow-ips "$FW_TRUSTED_PROXIES"
fi
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- [ ] **Step 4: Run, verify all entrypoint tests pass**

Run: `uv run pytest tests/test_entrypoint_sh.py -v -n0`
Expected: all 12 PASS.

- [ ] **Step 5: Mutation-verify the trivially-green guards**

Hand-edit the new block so BOTH exec lines carry `--proxy-headers --forwarded-allow-ips "${FW_TRUSTED_PROXIES:-}"` → `test_flags_absent_by_default` and `test_empty_value_means_off` must fail; revert, confirm `git diff docker/entrypoint.sh` shows only Step 3's state, re-run green.

- [ ] **Step 6: Update the `_throttle_key` comment**

In `backend/app/api/auth.py`, replace the first comment block in `_throttle_key` (the four lines starting `# Forwarded headers are deliberately ignored:` and ending `# trusted-proxy list first (sub-project 3).`) with:

```python
    # Forwarded headers are deliberately ignored unless the deployment
    # opts in: trusting them unverified would let an attacker mint a
    # fresh spoofed IP per request and bypass the throttle entirely.
    # The opt-in is FW_TRUSTED_PROXIES (container env) — the entrypoint
    # then starts uvicorn with --proxy-headers/--forwarded-allow-ips,
    # which rewrites request.client.host from X-Forwarded-For for
    # connections from trusted proxies only; this key needs no change.
```

- [ ] **Step 7: Add the README troubleshooting bullet**

In `README.md`, directly after the "**Port already in use**" bullet (line ~227), add:

```markdown
- **Behind a reverse proxy (nginx/Traefik/…)** — set `FW_TRUSTED_PROXIES`
  on the serve container (e.g. `docker run -e FW_TRUSTED_PROXIES=172.16.0.1
  …`) to the proxy's address as the container sees it (comma-separated,
  CIDRs and `*` allowed — uvicorn's `--forwarded-allow-ips` syntax).
  Without it, every visitor arrives with the proxy's IP and the login
  throttle treats all clients as one. The direct `-p` mapping of the
  quickstart needs none of this; leave it unset there.
```

- [ ] **Step 8: Full gate and commit**

Run from `backend/`: `uv run pytest -q` — green, zero warnings. `git status --short -- frontend/` empty.

```bash
git add docker/entrypoint.sh backend/app/api/auth.py backend/tests/test_entrypoint_sh.py README.md
git commit -m "feat(docker): FW_TRUSTED_PROXIES opt-in for reverse-proxy deployments (B21, #78)

When set, the entrypoint passes --proxy-headers/--forwarded-allow-ips
to uvicorn, so request.client.host — and the login-throttle key — is
the real client behind a trusted proxy. Unset keeps today's invocation:
forwarded headers from untrusted peers stay ignored.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

### Task 3: Wizard rerun prefill edge

**Files:**
- Modify: `backend/app/setup_wizard.py:310`
- Test: `backend/tests/test_setup_wizard.py` (append to `class TestReRun`)

**Interfaces:**
- Consumes: existing test helpers in the file — `scripted(answers)`, `fetch_fail`, `run_wizard(config_dir, template, *, input_fn, getpass_fn, fetch_models)`, `parse_env_file(path)`, and `TestReRun.first_run(tmp_path, template)` (an Ollama first run whose config carries `ollama_model: llama3.1` and a routing table with `en.quality.model == "llama3.1"`).
- Produces: `rerun = bool(existing_env) or bool(existing_config)`.

- [ ] **Step 1: Write the failing test**

Append to `class TestReRun` in `backend/tests/test_setup_wizard.py`:

```python
    def test_config_only_rerun_prefills_provider(self, tmp_path, template, capsys):
        # fabulous.env deleted, config.yaml survives (B21 #78 item 4):
        # still a re-run — provider/model prefills come from the config.
        config_dir = self.first_run(tmp_path, template)  # ollama first run
        (config_dir / "fabulous.env").unlink()
        # inputs: email (typed — its prefill lived in the deleted env),
        # provider "" (keep ollama), base URL "" (keep), model "" (keep
        # llama3.1 from the routing table); getpass: fresh password.
        # No rotate prompt: the secret's only copy was deleted.
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["admin@example.com", "", "", ""]),
            getpass_fn=scripted(["s3cret-password!"]),
            fetch_models=fetch_fail,
        )
        assert rc == 0
        assert "re-run" in capsys.readouterr().out
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "default_provider: ollama" in config
        assert "ollama_model: llama3.1" in config
        env = parse_env_file(config_dir / "fabulous.env")
        assert len(env["FW_AUTH_SECRET"]) >= 32
```

- [ ] **Step 2: Run, verify it fails**

Run: `uv run pytest tests/test_setup_wizard.py::TestReRun::test_config_only_rerun_prefills_provider -v -n0`
Expected: FAIL — with `rerun` False the provider prompt has no prefill, so the scripted `""` answer is rejected and the wizard re-asks, exhausting the iterator (`StopIteration`).

- [ ] **Step 3: Implement**

In `backend/app/setup_wizard.py`, replace line 310 (`rerun = bool(existing_env)`) with:

```python
    # Either surviving file triggers re-run mode: config.yaml alone still
    # holds provider/model prefills worth offering (B21 #78 item 4).
    rerun = bool(existing_env) or bool(existing_config)
```

- [ ] **Step 4: Run, verify it passes (plus neighbors)**

Run: `uv run pytest tests/test_setup_wizard.py -v -n0`
Expected: all PASS (the fresh-install path still has both files absent → `rerun` False, unchanged).

- [ ] **Step 5: Full gate and commit**

Run from `backend/`: `uv run pytest -q` — green, zero warnings. `git status --short -- frontend/` empty.

```bash
git add backend/app/setup_wizard.py backend/tests/test_setup_wizard.py
git commit -m "fix(wizard): config.yaml alone triggers re-run prefill (B21, #78)

rerun keyed only on fabulous.env: deleting the env file while the
config survived silently dropped the provider/model prefills. Either
surviving file now enters re-run mode; env-derived prefills (email,
key, secret) are genuinely gone and prompt fresh.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

### Task 4: `fabulous.sh serve` port pre-check + auto-pull + version print; README "Updating"

**Files:**
- Modify: `fabulous.sh` (serve branch only)
- Modify: `README.md` (new `### Updating` subsection between the quickstart bullet list and `### Troubleshooting`)
- Modify: `.github/workflows/backend.yml` (path filter)
- Create (Test): `backend/tests/test_fabulous_sh.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: serve order **port pre-check → pull → version print → run**; busy port ⇒ exit 75; pull failure ⇒ warning, still serves.

- [ ] **Step 1: Write the test file**

Create `backend/tests/test_fabulous_sh.py`:

```python
"""fabulous.sh serve: port pre-check, auto-pull, version print (B21/B26).

Runs the real script under /bin/sh with stub `docker`/`nc` as the ONLY
entries on PATH — the script needs no other external commands, and an
empty-but-for-stubs PATH makes the "nc absent" case deterministic (a
real /usr/bin/nc can never leak in). The stub docker appends each argv
to docker.log; assertions read that log.
"""

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FABULOUS = REPO_ROOT / "fabulous.sh"

DOCKER_STUB = """\
#!/bin/sh
echo "$@" >> "$STUB_OUT/docker.log"
case "$1" in
    pull) exit "${STUB_PULL_EXIT:-0}" ;;
    image) printf '%s\\n' "${STUB_VERSION_LABEL:-}" ;;
esac
exit 0
"""

NC_STUB = """\
#!/bin/sh
if [ "$4" = "::1" ]; then exit "${STUB_NC_EXIT_V6:-1}"; fi
exit "${STUB_NC_EXIT:-1}"
"""


def run_serve(tmp_path, *, nc_exit=None, pull_exit=0, version_label=""):
    """Run `fabulous.sh serve`. nc_exit None = no nc on PATH;
    0 = port busy; 1 = port free."""
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir(exist_ok=True)
    docker = stub_bin / "docker"
    docker.write_text(DOCKER_STUB, encoding="utf-8")
    docker.chmod(0o755)
    env = {
        "PATH": str(stub_bin),
        "STUB_OUT": str(tmp_path),
        "STUB_PULL_EXIT": str(pull_exit),
        "STUB_VERSION_LABEL": version_label,
    }
    if nc_exit is not None:
        nc = stub_bin / "nc"
        nc.write_text(NC_STUB, encoding="utf-8")
        nc.chmod(0o755)
        env["STUB_NC_EXIT"] = str(nc_exit)
    proc = subprocess.run(
        ["/bin/sh", str(FABULOUS), "serve"],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    log_path = tmp_path / "docker.log"
    log = log_path.read_text(encoding="utf-8").splitlines() if log_path.is_file() else []
    return proc, log


class TestPortPreCheck:
    def test_busy_port_refuses_before_any_docker_call(self, tmp_path):
        proc, log = run_serve(tmp_path, nc_exit=0)
        assert proc.returncode == 75
        assert "8080" in proc.stderr
        assert "FW_PORT" in proc.stderr
        assert log == []

    def test_nc_absent_skips_check_and_serves(self, tmp_path):
        proc, log = run_serve(tmp_path, nc_exit=None)
        assert proc.returncode == 0
        assert any(entry.startswith("run ") for entry in log)


class TestAutoPull:
    def test_free_port_pulls_then_runs(self, tmp_path):
        proc, log = run_serve(tmp_path, nc_exit=1)
        assert proc.returncode == 0
        pull = next(i for i, entry in enumerate(log) if entry.startswith("pull "))
        run = next(i for i, entry in enumerate(log) if entry.startswith("run "))
        assert pull < run
        assert "ghcr.io/saigyo/fabulous-writing:latest" in log[pull]

    def test_pull_failure_warns_and_still_serves(self, tmp_path):
        proc, log = run_serve(tmp_path, nc_exit=1, pull_exit=1)
        assert proc.returncode == 0
        assert "could not check for updates" in proc.stderr
        assert any(entry.startswith("run ") for entry in log)


class TestVersionPrint:
    def test_version_label_printed(self, tmp_path):
        proc, _ = run_serve(tmp_path, nc_exit=1, version_label="0.2.0")
        assert "Serving Fabulous Writing 0.2.0" in proc.stdout

    def test_empty_label_prints_no_version_line(self, tmp_path):
        proc, _ = run_serve(tmp_path, nc_exit=1, version_label="")
        assert "Serving Fabulous Writing" not in proc.stdout

    def test_no_value_label_prints_no_version_line(self, tmp_path):
        # docker's Go template prints "<no value>" for a missing map key.
        proc, _ = run_serve(tmp_path, nc_exit=1, version_label="<no value>")
        assert "Serving Fabulous Writing" not in proc.stdout
```

- [ ] **Step 2: Run, verify the expected failures**

Run: `uv run pytest tests/test_fabulous_sh.py -v -n0`
Expected: `test_busy_port_refuses_before_any_docker_call` FAILS (old script runs docker regardless; exit 0, log non-empty), `test_free_port_pulls_then_runs` FAILS (no `pull` entry), `test_pull_failure_warns_and_still_serves` FAILS (no warning), `test_version_label_printed` FAILS (no version line). Trivially green: `test_nc_absent_skips_check_and_serves`, the two no-version-line tests — mutation-verified in Step 5.

- [ ] **Step 3: Implement the serve branch**

In `fabulous.sh`, replace the `serve)` case branch with:

```sh
    serve)
        # With some Docker backends (colima), publishing a taken host
        # port does not fail: the container serves healthily while the
        # squatter answers localhost:$PORT. Refuse up front when we can
        # tell; without nc, skip — the README covers the collision.
        # Probe both loopback families: a ::1-only squatter still wins
        # the browser's localhost lookup. An nc without IPv6 support
        # just fails the ::1 probe, which is the same as "free".
        if command -v nc >/dev/null 2>&1; then
            for probe_addr in 127.0.0.1 ::1; do
                if nc -z -w 1 "$probe_addr" "$PORT" >/dev/null 2>&1; then
                    echo "Port $PORT is already in use on this host." >&2
                    echo "Pick another port: FW_PORT=9090 $0 serve" >&2
                    exit 75
                fi
            done
        fi
        # Auto-update: a no-op when current; an offline host still
        # serves the cached image.
        if ! docker pull "$IMAGE"; then
            echo "WARNING: could not check for updates — serving the local $IMAGE if present." >&2
        fi
        version_label=$(docker image inspect \
            --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
            "$IMAGE" 2>/dev/null || true)
        if [ -n "$version_label" ] && [ "$version_label" != "<no value>" ]; then
            echo "Serving Fabulous Writing $version_label"
        fi
        exec docker run --rm \
            -v fabulous-config:/config \
            -v fabulous-data:/data \
            -p "$PORT:8000" \
            "$IMAGE" serve
        ;;
```

(`setup` branch and the usage error stay untouched.)

- [ ] **Step 4: Run, verify all pass**

Run: `uv run pytest tests/test_fabulous_sh.py -v -n0`
Expected: all 8 PASS (includes `test_ipv6_only_squatter_refused`, added for the
two-family probe).

- [ ] **Step 5: Mutation-verify the trivially-green guards**

One at a time, hand-edit `fabulous.sh`, run the named test, confirm FAIL, revert:
1. Replace the entire `if` condition (`command -v nc >/dev/null 2>&1 && nc -z -w 1 127.0.0.1 "$PORT" >/dev/null 2>&1`) with `true` — the refusal branch is now taken unconditionally → `test_nc_absent_skips_check_and_serves` must fail (returncode 75 instead of 0).
2. Change the version guard to `if true; then` → both no-version-line tests must fail (a `Serving Fabulous Writing` line appears).

Revert both; `git diff fabulous.sh` must show only Step 3's state; re-run the file green.

- [ ] **Step 6: Add the README "Updating" subsection**

In `README.md`, between the quickstart bullet list (ends ~line 202 with "nothing is released automatically on pushes to `main`.") and `### Troubleshooting`, insert:

````markdown
### Updating

`./fabulous.sh serve` checks for a newer image on every start (`docker
pull` — a no-op when you're current, skipped with a warning when
offline) and prints the version it serves. With plain `docker run`,
update manually:

```sh
docker pull ghcr.io/saigyo/fabulous-writing:latest
```

Image updates never touch your configuration or data — both live in
the `fabulous-config`/`fabulous-data` volumes. To check the version of
the image you have locally:

```sh
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  ghcr.io/saigyo/fabulous-writing:latest
```

The running app also reports its version at `/api/health`.
````

- [ ] **Step 7: Add `fabulous.sh` to the backend CI path filter**

In `.github/workflows/backend.yml`, add to BOTH `on.push.paths` and `on.pull_request.paths` (below the `"docker/entrypoint.sh"` line Task 1 added):

```yaml
      - "fabulous.sh"
```

- [ ] **Step 8: Full gate and commit**

Run from `backend/`: `uv run pytest -q` — green, zero warnings. `git status --short -- frontend/` empty.

```bash
git add fabulous.sh backend/tests/test_fabulous_sh.py README.md .github/workflows/backend.yml
git commit -m "feat(cli): serve pre-checks the host port, auto-pulls, prints version (B21+B26, #78, #86)

Port pre-check (nc, when available) catches the colima case where a
squatted host port answers instead of the healthy container. docker
pull before run turns a stale 'latest' into an automatic update while
an offline host still serves its cache; the OCI version label is
printed so the user sees what they got. README gains the Updating
story for plain-docker users.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

## After all tasks

Final whole-branch review, then the PR (superpowers:finishing-a-development-branch → push + PR with Copilot review; Markus merges). PR body carries `Closes #78.` and `Closes #86.` as separate keyword sentences. LOGBOOK entry follows the repo convention: last commit on the PR branch after reviews settle — not part of these tasks. Architecture docs: `docs/backend-architecture.md` container/runtime section gets the new env vars (`FW_ENV_FILE`, `FW_TRUSTED_PROXIES`), the serve-flow change, and a note that relocating `FW_CONFIG_FILE` requires relocating `FW_SETUP_CONFIG_DIR` (the wizard's output dir) too — or setting `FW_ENV_FILE` explicitly — since the two are independent knobs. Fold into the LOGBOOK commit step per convention.
