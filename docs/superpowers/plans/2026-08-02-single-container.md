# Single-Container Setup (B17, #58) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One GHCR Docker image ("pull, wizard, run"), a re-runnable setup wizard, third-party license collection with a CI drift check, and a tag-driven release workflow.

**Architecture:** Multi-stage Dockerfile (Node 26 builds the SPA; Python 3.13 runs FastAPI serving it single-origin). Two dev-neutral backend hooks (`FW_CONFIG_FILE`, `frontend.dist_dir`). A Python wizard inside the image owns `/config` and regenerates `fabulous.env` + `config.yaml` completely on every run. Licenses are collected into `THIRD-PARTY-NOTICES.md` (full texts), committed, baked into the image, and drift-checked in CI. Releases are deliberate: tag push → multi-arch GHCR push → GitHub Release.

**Tech Stack:** Docker/BuildKit, `docker/build-push-action` with registry cache, uv, FastAPI `StaticFiles`/`FileResponse`, httpx, PyYAML, `license-checker-rseidelsohn` (npx), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-02-single-container-design.md` — binding for all copy, defaults, and behavior below.

## Global Constraints

- Backend gates before every commit that touches `backend/`: `uv run pytest -q` green with **zero warnings** (run from `backend/`).
- Frontend source is NOT touched by this plan. `frontend/` stays byte-identical except nothing — verify with `git status --short -- frontend/` (empty) before each commit.
- Tests never touch the live DB (`backend/data/fabulous.db`) and never call `create_app()` with default settings — every test passes `tmp_path`-based `Settings`.
- Never kill/start anything on ports **5173** or **8000**. Scratch containers use host port **8001** (and only own containers/volumes, prefixed `fwscratch`).
- Secrets from environment only; never committed, never logged, never echoed by the wizard.
- The bcrypt work factor stays out of Settings/config/env. `require_admin` stays on the admin router. No `dangerouslySetInnerHTML`, no dynamic `href`/`src`.
- Never widen a wall-clock test bound. Mutation-verify every guard test (delete the guarded behavior → test fails → restore).
- Node line is **26** everywhere (image builder stage `node:26-slim`, CI `node-version: 26`). Python image is `python:3.13-slim`. spaCy model wheel version is **3.8.0**; ginza/ja-ginza pinned **5.2.0**.
- The git tag is the single source of truth for the app version; `pyproject.toml`/`package.json` versions are NOT bumped. First release will be `v0.1.0` (cut post-merge by the owner, not in this plan).
- Image name: `ghcr.io/saigyo/fabulous-writing`. Registry build cache ref: `ghcr.io/saigyo/fabulous-writing:buildcache`.
- Every commit message ends with the two trailer lines (Co-Authored-By + Claude-Session) supplied verbatim in the dispatch prompt.
- Commit messages follow the repo's `type(scope): summary (B17, #58)` convention.

## File structure

- `backend/app/core/config.py` — add `FrontendSettings`, `frontend` field, `FW_CONFIG_FILE` in `load_settings()` (Task 1)
- `backend/app/main.py` — SPA mount + fallback, version in `/api/health` (Task 1)
- `backend/tests/test_container_serving.py` — new (Task 1)
- `backend/app/setup_wizard.py` — new, the wizard incl. `__main__` entry (Task 2)
- `backend/tests/test_setup_wizard.py` — new (Task 2)
- `scripts/collect-licenses.py` — new, repo-root scripts dir (Task 3)
- `scripts/curated-licenses.yaml` — new, hand-curated model/dictionary entries (Task 3)
- `THIRD-PARTY-NOTICES.md` — new, generated + committed (Task 3)
- `Dockerfile`, `.dockerignore`, `docker/entrypoint.sh`, `docker/config.container.yaml`, `fabulous.sh` — new (Task 4)
- `.github/workflows/docker.yml`, `.github/workflows/release.yml` — new; `.github/workflows/frontend.yml` node bump (Task 5)
- `README.md`, `docs/backend-architecture.md`, `docs/frontend-architecture.md` — sections (Task 6)

---

### Task 0: Branch

- [ ] **Step 1:** From up-to-date `main`, create the branch:

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
git checkout main && git pull && git checkout -b b17-single-container || { echo "branch setup failed"; exit 1; }
```

---

### Task 1: Backend container hooks — `FW_CONFIG_FILE`, SPA serving, health version

**Files:**
- Modify: `backend/app/core/config.py` (imports at top; `CorsSettings` area ~line 199; `Settings` ~line 448; `load_settings` ~line 537)
- Modify: `backend/app/main.py` (imports; end of `create_app` around the health route, lines 171-175)
- Modify: `backend/tests/test_health.py` (exact-equality health assertion gains the version field)
- Test: `backend/tests/test_container_serving.py` (new)

**Interfaces:**
- Consumes: existing `Settings`, `create_app`, conftest pattern `Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")`.
- Produces: `FrontendSettings` with `dist_dir: Path | None`; `Settings.frontend: FrontendSettings`; `load_settings()` honoring env `FW_CONFIG_FILE`; `/api/health` returning `{"status", "name", "version"}` where version = env `FW_APP_VERSION` or `"dev"`. Task 4's image relies on exactly these names.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_container_serving.py`:

```python
"""Container-deployment hooks: FW_CONFIG_FILE, SPA serving, health version."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import FrontendSettings, Settings, load_settings
from app.main import create_app


def make_dist(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>FW</title>", encoding="utf-8")
    (dist / "assets" / "app-abc123.js").write_text("console.log('fw')", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    return dist


def make_app(tmp_path: Path, dist: Path | None) -> TestClient:
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        frontend=FrontendSettings(dist_dir=dist),
    )
    return TestClient(create_app(settings))


class TestConfigFileEnv:
    def test_env_var_selects_config_file(self, tmp_path, monkeypatch):
        cfg = tmp_path / "elsewhere.yaml"
        cfg.write_text("environment: dev\n", encoding="utf-8")
        monkeypatch.setenv("FW_CONFIG_FILE", str(cfg))
        assert load_settings().environment == "dev"

    def test_explicit_argument_beats_env_var(self, tmp_path, monkeypatch):
        env_cfg = tmp_path / "env.yaml"
        env_cfg.write_text("environment: dev\n", encoding="utf-8")
        arg_cfg = tmp_path / "arg.yaml"
        arg_cfg.write_text("environment: staging\n", encoding="utf-8")
        monkeypatch.setenv("FW_CONFIG_FILE", str(env_cfg))
        assert load_settings(arg_cfg).environment == "staging"

    def test_empty_env_var_falls_back_to_default_path(self, tmp_path, monkeypatch):
        # An empty FW_CONFIG_FILE (e.g. `FW_CONFIG_FILE= uvicorn ...`) must
        # behave like unset — the default backend/config.yaml resolution
        # still applies, rather than Path("") suppressing it.
        import app.core.config as config_module

        monkeypatch.setattr(config_module, "BACKEND_DIR", tmp_path)
        (tmp_path / "config.yaml").write_text("environment: dev\n", encoding="utf-8")
        monkeypatch.setenv("FW_CONFIG_FILE", "")
        assert load_settings().environment == "dev"


class TestSpaServing:
    def test_index_served_at_root(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/")
        assert r.status_code == 200
        assert "<!doctype html>" in r.text

    def test_deep_link_falls_back_to_index(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/documents/42")
        assert r.status_code == 200
        assert "<!doctype html>" in r.text

    def test_hashed_asset_served(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/assets/app-abc123.js")
        assert r.status_code == 200
        assert "console.log" in r.text

    def test_top_level_file_served(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        assert client.get("/favicon.svg").status_code == 200

    def test_unknown_api_path_stays_404(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/api/definitely-not-a-route")
        assert r.status_code == 404
        assert "<!doctype html>" not in r.text

    def test_api_routes_still_reachable(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        assert client.get("/api/health").status_code == 200

    def test_no_dist_dir_means_no_spa_routes(self, tmp_path):
        client = make_app(tmp_path, None)
        assert client.get("/").status_code == 404

    def test_path_traversal_is_not_served(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        secret = tmp_path / "secret.txt"
        secret.write_text("nope", encoding="utf-8")
        # Percent-encoded dot segments survive httpx's client-side URL
        # normalization and reach the ASGI path decoded — a literal
        # "/../secret.txt" would be normalized away before the app sees it.
        r = client.get("/%2e%2e/secret.txt")
        assert "nope" not in r.text

    def test_dist_dir_without_index_fails_loudly(self, tmp_path):
        empty = tmp_path / "not-a-dist"
        empty.mkdir()
        with pytest.raises(RuntimeError, match="index.html"):
            make_app(tmp_path, empty)


class TestHealthVersion:
    def test_version_from_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FW_APP_VERSION", "1.2.3")
        client = make_app(tmp_path, None)
        assert client.get("/api/health").json()["version"] == "1.2.3"

    def test_version_defaults_to_dev(self, tmp_path, monkeypatch):
        monkeypatch.delenv("FW_APP_VERSION", raising=False)
        client = make_app(tmp_path, None)
        assert client.get("/api/health").json()["version"] == "dev"
```

- [ ] **Step 2: Run the tests, verify they fail correctly**

Run (from `backend/`): `uv run pytest tests/test_container_serving.py -v`
Expected: ImportError on `FrontendSettings` — feature missing, not a typo.

- [ ] **Step 3: Implement the config changes**

In `backend/app/core/config.py`:

Add `import os` to the imports if absent.

After `CorsSettings` (~line 202), add:

```python
class FrontendSettings(BaseModel):
    # Absolute path to the built SPA (Vite dist/). None (the dev default)
    # registers no static routes at all — dev keeps its two-origin setup.
    dist_dir: Path | None = None
```

In `Settings`, next to `cors: CorsSettings = Field(default_factory=CorsSettings)`, add:

```python
    frontend: FrontendSettings = Field(default_factory=FrontendSettings)
```

Replace `load_settings` with:

```python
def load_settings(config_file: Path | None = None) -> Settings:
    """Load settings from a YAML file, falling back to defaults.

    Resolution order: explicit argument, then the FW_CONFIG_FILE
    environment variable (the container entrypoint sets it to the
    wizard-generated /config/config.yaml), then backend/config.yaml.
    """
    env_path = os.environ.get("FW_CONFIG_FILE", "").strip()
    path = config_file or (Path(env_path) if env_path else BACKEND_DIR / "config.yaml")
    if not path.is_file():
        return Settings()
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return Settings.model_validate(data)
```

- [ ] **Step 4: Implement the serving changes**

In `backend/app/main.py`: add imports

```python
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
```

(keep the existing import lines; only `HTTPException`, `FileResponse`, `StaticFiles`, `Path` are new).

Replace the health route block (lines 171-173) with, and append the SPA block after it (order matters — the catch-all must be registered after every API route):

```python
    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {
            "status": "ok",
            "name": APP_NAME,
            "version": os.environ.get("FW_APP_VERSION", "dev"),
        }

    # Single-origin serving for the container image (spec: single-container
    # design). Registered last: FastAPI matches routes in registration
    # order, so every /api route above wins over the catch-all. Known,
    # accepted quirk: with dist_dir set, a POST to an unknown path returns
    # 405 (the catch-all matches by path, GET-only) instead of 404.
    dist_dir = settings.frontend.dist_dir
    if dist_dir is not None:
        dist = Path(dist_dir).resolve()
        if not (dist / "index.html").is_file():
            raise RuntimeError(
                f"frontend.dist_dir={dist} has no index.html — point it at a"
                " built Vite dist/"
            )
        app.mount(
            "/assets",
            StaticFiles(directory=dist / "assets", check_dir=False),
            name="assets",
        )

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str) -> FileResponse:
            # /api/* never falls back to HTML: a missing API route must
            # stay a JSON 404, not a 200 page.
            if full_path == "api" or full_path.startswith("api/"):
                raise HTTPException(status_code=404)
            candidate = (dist / full_path).resolve()
            if (
                full_path
                and candidate.is_relative_to(dist)
                and candidate.is_file()
            ):
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")

    return app
```

- [ ] **Step 5: Update the existing health test**

`backend/tests/test_health.py:26` asserts the payload by exact equality and
now needs the version field. Change the assertion to:

```python
    assert response.json() == {"status": "ok", "name": "Fabulous Writing", "version": "dev"}
```

and add the `monkeypatch` fixture parameter to that test with
`monkeypatch.delenv("FW_APP_VERSION", raising=False)` as its first line, so a
stray env var in a dev shell cannot flake it. (`tests/test_check_api.py:1300`
also touches `/api/health` but asserts only the status code — leave it.)

- [ ] **Step 6: Run the new tests, verify they pass**

Run: `uv run pytest tests/test_container_serving.py tests/test_health.py -v`
Expected: all PASS.

- [ ] **Step 7: Mutation-verify the guard tests**

1. Comment out the `if full_path == "api" or full_path.startswith("api/"):` guard → `test_unknown_api_path_stays_404` FAILS. Restore.
2. Change `"dev"` to `""` in the health route → `test_version_defaults_to_dev` FAILS. Restore.
3. In `load_settings`, ignore `env_path` → `test_env_var_selects_config_file` FAILS. Restore.
4. Remove `candidate.is_relative_to(dist)` from the `spa` route condition → `test_path_traversal_is_not_served` FAILS. Restore.
5. Remove the `index.html` existence guard → `test_dist_dir_without_index_fails_loudly` FAILS. Restore.

- [ ] **Step 8: Full backend suite, zero warnings**

Run: `uv run pytest -q`
Expected: green, zero warnings.

- [ ] **Step 9: Commit**

```bash
git add backend/app/core/config.py backend/app/main.py backend/tests/test_container_serving.py backend/tests/test_health.py
git commit -m "feat(backend): container hooks — FW_CONFIG_FILE, SPA serving, health version (B17, #58)"
```

---

### Task 2: Setup wizard

**Files:**
- Create: `backend/app/setup_wizard.py`
- Test: `backend/tests/test_setup_wizard.py`

**Interfaces:**
- Consumes: `BUILTIN_ENV_KEYS` from `app.core.config` (`{"claude": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "mistral": "MISTRAL_API_KEY"}`).
- Produces: `run_wizard(config_dir: Path, template_path: Path, *, input_fn, getpass_fn, probe) -> int` and module entry `python -m app.setup_wizard` (reads `FW_SETUP_CONFIG_DIR`, default `/config`, and `FW_CONFIG_TEMPLATE`, default `/app/config.container.yaml`). Task 4's entrypoint invokes exactly `python -m app.setup_wizard`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_setup_wizard.py`:

```python
"""Setup wizard: first run, re-run merging, provider switching."""

from pathlib import Path

import pytest

from app.setup_wizard import parse_env_file, run_wizard

TEMPLATE = """\
environment: production
db_path: /data/fabulous.db
frontend:
  dist_dir: /app/dist
cors:
  origins: []
providers:
  default_provider: ollama
"""


@pytest.fixture()
def template(tmp_path: Path) -> Path:
    path = tmp_path / "config.container.yaml"
    path.write_text(TEMPLATE, encoding="utf-8")
    return path


def scripted(answers: list[str]):
    it = iter(answers)

    def input_fn(prompt: str = "") -> str:
        return next(it)

    return input_fn


def probe_ok(base_url: str, model: str) -> tuple[bool, str]:
    return True, "ok"


def run_first(config_dir, template, answers, secrets_answers, probe=probe_ok):
    return run_wizard(
        config_dir,
        template,
        input_fn=scripted(answers),
        getpass_fn=scripted(secrets_answers),
        probe=probe,
    )


class TestFirstRun:
    def test_anthropic_setup_writes_both_files(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        # prompts: email, provider choice, [key via getpass], (secret auto)
        rc = run_first(
            config_dir,
            template,
            answers=["admin@example.com", "1"],
            secrets_answers=["s3cret-password!", "sk-ant-abc123"],
        )
        assert rc == 0
        env = parse_env_file(config_dir / "fabulous.env")
        assert env["FW_ADMIN_EMAIL"] == "admin@example.com"
        assert env["FW_ADMIN_PASSWORD"] == "s3cret-password!"
        assert len(env["FW_AUTH_SECRET"]) >= 32
        assert env["ANTHROPIC_API_KEY"] == "sk-ant-abc123"
        assert "OPENAI_API_KEY" not in env
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "default_provider: claude" in config
        assert "db_path: /data/fabulous.db" in config

    def test_ollama_setup_has_no_key_and_probes(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        seen = {}

        def probe(base_url, model):
            seen["args"] = (base_url, model)
            return True, "ok"

        rc = run_first(
            config_dir,
            template,
            # email, provider "4" (ollama), base URL (accept default), model
            answers=["admin@example.com", "4", "", "llama3.1"],
            secrets_answers=["s3cret-password!"],
            probe=probe,
        )
        assert rc == 0
        env = parse_env_file(config_dir / "fabulous.env")
        assert not any(k.endswith("_API_KEY") for k in env)
        assert seen["args"] == ("http://host.docker.internal:11434", "llama3.1")
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "default_provider: ollama" in config
        assert "ollama_base_url: http://host.docker.internal:11434" in config
        assert "ollama_model: llama3.1" in config

    def test_failed_probe_warns_but_completes(self, tmp_path, template, capsys):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        rc = run_first(
            config_dir,
            template,
            answers=["admin@example.com", "4", "", "llama3.1"],
            secrets_answers=["s3cret-password!"],
            probe=lambda b, m: (False, "connection refused"),
        )
        assert rc == 0
        assert (config_dir / "fabulous.env").is_file()
        assert "connection refused" in capsys.readouterr().out

    def test_short_password_reprompts(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        rc = run_first(
            config_dir,
            template,
            answers=["admin@example.com", "1"],
            secrets_answers=["short", "long-enough-password", "sk-ant-abc123"],
        )
        assert rc == 0
        env = parse_env_file(config_dir / "fabulous.env")
        assert env["FW_ADMIN_PASSWORD"] == "long-enough-password"

    def test_secret_never_printed(self, tmp_path, template, capsys):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_first(
            config_dir,
            template,
            answers=["admin@example.com", "1"],
            secrets_answers=["s3cret-password!", "sk-ant-abc123"],
        )
        out = capsys.readouterr().out
        env = parse_env_file(config_dir / "fabulous.env")
        assert env["FW_AUTH_SECRET"] not in out
        assert "sk-ant-abc123" not in out
        assert "s3cret-password!" not in out


class TestReRun:
    def first_run(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_first(
            config_dir,
            template,
            answers=["admin@example.com", "4", "", "llama3.1"],
            secrets_answers=["s3cret-password!"],
        )
        return config_dir

    def first_run_claude(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_first(
            config_dir,
            template,
            answers=["admin@example.com", "1"],
            secrets_answers=["s3cret-password!", "sk-ant-abc123"],
        )
        return config_dir

    def test_keep_everything_preserves_secret(self, tmp_path, template):
        config_dir = self.first_run(tmp_path, template)
        before = parse_env_file(config_dir / "fabulous.env")
        # email (keep), keep-password "", provider (keep), base URL (keep),
        # model (keep), rotate-secret "n"
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "", "", "n"]),
            getpass_fn=scripted([""]),
            probe=probe_ok,
        )
        assert rc == 0
        after = parse_env_file(config_dir / "fabulous.env")
        assert after["FW_AUTH_SECRET"] == before["FW_AUTH_SECRET"]
        assert after["FW_ADMIN_EMAIL"] == "admin@example.com"
        assert after["FW_ADMIN_PASSWORD"] == "s3cret-password!"

    def test_provider_switch_removes_stale_key(self, tmp_path, template):
        # First run used claude, so ANTHROPIC_API_KEY genuinely exists
        # before the switch — the absence assertion below is non-vacuous.
        config_dir = self.first_run_claude(tmp_path, template)
        assert "ANTHROPIC_API_KEY" in parse_env_file(config_dir / "fabulous.env")
        # email (keep), provider "3" (mistral), rotate-secret "n";
        # getpass: keep-password "", then the mistral key
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "3", "n"]),
            getpass_fn=scripted(["", "a" * 24]),
            probe=probe_ok,
        )
        assert rc == 0
        env = parse_env_file(config_dir / "fabulous.env")
        assert env["MISTRAL_API_KEY"] == "a" * 24
        assert "ANTHROPIC_API_KEY" not in env
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "default_provider: mistral" in config

    def test_switch_away_from_ollama_drops_ollama_config(self, tmp_path, template):
        config_dir = self.first_run(tmp_path, template)  # ollama first run
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "3", "n"]),
            getpass_fn=scripted(["", "a" * 24]),
            probe=probe_ok,
        )
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "ollama_base_url" not in config
        assert "ollama_model" not in config

    def test_env_files_are_owner_readable_only(self, tmp_path, template):
        config_dir = self.first_run_claude(tmp_path, template)
        # Widen the source file first: shutil.copy2 propagates the source's
        # mode, so without this the .bak assertion could never catch a
        # missing chmod in _backup.
        (config_dir / "fabulous.env").chmod(0o644)
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "n"]),
            getpass_fn=scripted(["", ""]),
            probe=probe_ok,
        )
        assert (config_dir / "fabulous.env").stat().st_mode & 0o077 == 0
        assert (config_dir / "fabulous.env.bak").stat().st_mode & 0o077 == 0

    def test_rotate_secret_changes_it(self, tmp_path, template):
        config_dir = self.first_run(tmp_path, template)
        before = parse_env_file(config_dir / "fabulous.env")["FW_AUTH_SECRET"]
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "", "", "y"]),
            getpass_fn=scripted([""]),
            probe=probe_ok,
        )
        assert rc == 0
        after = parse_env_file(config_dir / "fabulous.env")["FW_AUTH_SECRET"]
        assert after != before
        assert len(after) >= 32

    def test_backup_written_on_rerun(self, tmp_path, template):
        config_dir = self.first_run(tmp_path, template)
        original_env = (config_dir / "fabulous.env").read_text(encoding="utf-8")
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "", "", "n"]),
            getpass_fn=scripted([""]),
            probe=probe_ok,
        )
        assert (config_dir / "fabulous.env.bak").read_text(encoding="utf-8") == original_env
        assert (config_dir / "config.yaml.bak").is_file()


class TestValidation:
    def test_bad_email_reprompts(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        rc = run_first(
            config_dir,
            template,
            answers=["not-an-email", "admin@example.com", "1"],
            secrets_answers=["s3cret-password!", "sk-ant-abc123"],
        )
        assert rc == 0
        assert parse_env_file(config_dir / "fabulous.env")["FW_ADMIN_EMAIL"] == "admin@example.com"

    def test_wrong_key_prefix_reprompts(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        rc = run_first(
            config_dir,
            template,
            answers=["admin@example.com", "1"],
            secrets_answers=["s3cret-password!", "wrong-prefix", "sk-ant-abc123"],
        )
        assert rc == 0
        assert parse_env_file(config_dir / "fabulous.env")["ANTHROPIC_API_KEY"] == "sk-ant-abc123"

    def test_newline_in_password_rejected(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        rc = run_first(
            config_dir,
            template,
            answers=["admin@example.com", "1"],
            secrets_answers=["bad\npassword-value", "good-password-value", "sk-ant-abc123"],
        )
        assert rc == 0
        assert (
            parse_env_file(config_dir / "fabulous.env")["FW_ADMIN_PASSWORD"]
            == "good-password-value"
        )


class TestImageContract:
    def test_default_paths_match_the_dockerfile_layout(self):
        # Task 4's Dockerfile copies the template to /app/config.container.yaml
        # and declares the /config volume; a silent rename there would break
        # `setup` at runtime only. Pin the contract.
        from app.setup_wizard import DEFAULT_CONFIG_DIR, DEFAULT_TEMPLATE

        assert DEFAULT_CONFIG_DIR == "/config"
        assert DEFAULT_TEMPLATE == "/app/config.container.yaml"
```

- [ ] **Step 2: Run tests, verify they fail correctly**

Run: `uv run pytest tests/test_setup_wizard.py -v`
Expected: ImportError on `app.setup_wizard`.

- [ ] **Step 3: Implement the wizard**

Create `backend/app/setup_wizard.py`:

```python
"""Interactive setup wizard for the containerized deployment (B17, #58).

Invoked as ``docker run --rm -it -v fabulous-config:/config <image> setup``
(the entrypoint dispatches ``setup`` to ``python -m app.setup_wizard``).

Contract: the wizard owns the config directory and regenerates BOTH files
completely on every run — ``fabulous.env`` (secrets only) and
``config.yaml`` (non-secret config, extending the baked-in template). A
re-run pre-fills every prompt from the existing files; because the files
are rewritten whole from the merged answers, switching providers can never
leave a stale key behind. Secrets are read via getpass, never echoed, and
never written anywhere but the env file.
"""

from __future__ import annotations

import getpass
import os
import secrets as secrets_module
import shutil
import sys
from pathlib import Path
from typing import Callable

import httpx
import yaml

from app.core.config import BUILTIN_ENV_KEYS

MIN_PASSWORD_LENGTH = 12  # mirrors ADMIN_SET_MIN_PASSWORD_LENGTH (app.core.auth)
MIN_SECRET_LENGTH = 32
DEFAULT_OLLAMA_URL = "http://host.docker.internal:11434"
# The Dockerfile's layout contract (Task 4 copies the template to exactly
# this path and declares the /config volume) — pinned by tests.
DEFAULT_CONFIG_DIR = "/config"
DEFAULT_TEMPLATE = "/app/config.container.yaml"

# Menu order is stable: tests and docs reference the numbers.
PROVIDER_MENU = ("claude", "openai", "mistral", "ollama")
PROVIDER_LABELS = {
    "claude": "Anthropic (Claude)",
    "openai": "OpenAI",
    "mistral": "Mistral",
    "ollama": "Ollama (existing local instance)",
}
KEY_PREFIXES = {"claude": "sk-ant-", "openai": "sk-"}
MIN_MISTRAL_KEY_LENGTH = 20

InputFn = Callable[[str], str]
ProbeFn = Callable[[str, str], tuple[bool, str]]


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines; blank lines and #-comments are skipped."""
    result: dict[str, str] = {}
    if not path.is_file():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, sep, value = stripped.partition("=")
        if sep:
            result[key.strip()] = value
    return result


def check_ollama(base_url: str, model: str) -> tuple[bool, str]:
    """Probe /api/tags from inside the container — the app's own vantage."""
    try:
        response = httpx.get(f"{base_url.rstrip('/')}/api/tags", timeout=5.0)
        response.raise_for_status()
    except Exception as exc:  # noqa: BLE001 - any failure is the same advice
        return False, str(exc)
    names = [m.get("name", "") for m in response.json().get("models", [])]
    if any(n == model or n.split(":")[0] == model for n in names):
        return True, "ok"
    return False, f"model '{model}' not in Ollama's list: {', '.join(names) or '(empty)'}"


def _valid_text(value: str, label: str) -> str | None:
    if "\n" in value or "\r" in value:
        return f"{label} must not contain line breaks."
    return None


def _validate_key(provider: str, key: str) -> str | None:
    error = _valid_text(key, "API key")
    if error:
        return error
    prefix = KEY_PREFIXES.get(provider)
    if prefix and not key.startswith(prefix):
        return f"{PROVIDER_LABELS[provider]} keys start with '{prefix}'."
    if provider == "mistral" and len(key) < MIN_MISTRAL_KEY_LENGTH:
        return f"Mistral keys are at least {MIN_MISTRAL_KEY_LENGTH} characters."
    if not key:
        return "The key must not be empty."
    return None


def _ask(input_fn: InputFn, prompt: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        raw = input_fn(f"{prompt}{suffix}: ").strip()
        if not raw and default is not None:
            return default
        if raw:
            return raw


def _ask_email(input_fn: InputFn, default: str | None) -> str:
    while True:
        value = _ask(input_fn, "Admin email", default)
        if "@" in value and _valid_text(value, "Email") is None:
            return value
        print("That does not look like an email address — try again.")


def _ask_password(getpass_fn: InputFn, existing: str | None) -> str:
    prompt = (
        "Admin password (Enter = keep current): "
        if existing
        else f"Admin password (min {MIN_PASSWORD_LENGTH} chars): "
    )
    while True:
        value = getpass_fn(prompt)
        if not value and existing:
            return existing
        if "\n" in value or "\r" in value:
            print("The password must not contain line breaks.")
            continue
        if len(value) >= MIN_PASSWORD_LENGTH:
            return value
        print(f"Too short — at least {MIN_PASSWORD_LENGTH} characters.")


def _ask_provider(input_fn: InputFn, current: str | None) -> str:
    print("\nLLM provider — exactly one:")
    for index, name in enumerate(PROVIDER_MENU, start=1):
        marker = " (current)" if name == current else ""
        print(f"  {index}. {PROVIDER_LABELS[name]}{marker}")
    default = str(PROVIDER_MENU.index(current) + 1) if current in PROVIDER_MENU else None
    while True:
        choice = _ask(input_fn, "Choice", default)
        if choice in {"1", "2", "3", "4"}:
            return PROVIDER_MENU[int(choice) - 1]
        print("Enter 1, 2, 3, or 4.")


def _ask_api_key(getpass_fn: InputFn, provider: str, existing: str | None) -> str:
    label = PROVIDER_LABELS[provider]
    prompt = (
        f"{label} API key (Enter = keep current): "
        if existing
        else f"{label} API key: "
    )
    while True:
        value = getpass_fn(prompt)
        if not value and existing:
            return existing
        error = _validate_key(provider, value)
        if error is None:
            return value
        print(error)


def _backup(path: Path) -> None:
    if path.is_file():
        backup = path.with_name(path.name + ".bak")
        shutil.copy2(path, backup)
        backup.chmod(0o600)


def _write_env(path: Path, values: dict[str, str]) -> None:
    lines = [
        "# Generated by the Fabulous Writing setup wizard. Secrets only —",
        "# non-secret configuration lives in config.yaml next to this file.",
    ]
    lines += [f"{key}={value}" for key, value in values.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)


def run_wizard(
    config_dir: Path,
    template_path: Path,
    *,
    input_fn: InputFn = input,
    getpass_fn: InputFn = getpass.getpass,
    probe: ProbeFn = check_ollama,
) -> int:
    env_path = config_dir / "fabulous.env"
    config_path = config_dir / "config.yaml"
    existing_env = parse_env_file(env_path)
    existing_config: dict = {}
    if config_path.is_file():
        existing_config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    rerun = bool(existing_env)

    print("Fabulous Writing setup" + (" (re-run — Enter keeps current values)" if rerun else ""))
    if rerun:
        print(
            "Note: admin email/password bootstrap the admin account only on"
            " the FIRST start against an empty database. Afterwards the"
            " password is changed in the app, not here."
        )

    email = _ask_email(input_fn, existing_env.get("FW_ADMIN_EMAIL"))
    password = _ask_password(getpass_fn, existing_env.get("FW_ADMIN_PASSWORD"))

    current_provider = None
    existing_providers = existing_config.get("providers", {})
    if rerun:
        current_provider = existing_providers.get("default_provider")
    provider = _ask_provider(input_fn, current_provider)

    api_key = None
    ollama_url = None
    ollama_model = None
    if provider == "ollama":
        print(
            "The app runs inside Docker: 'localhost' would be the container"
            " itself. macOS/Windows reach the host via host.docker.internal;"
            " on Linux, add --add-host=host.docker.internal:host-gateway to"
            " the run command or use the docker0 gateway IP."
        )
        ollama_url = _ask(
            input_fn,
            "Ollama base URL (from inside the container)",
            existing_providers.get("ollama_base_url", DEFAULT_OLLAMA_URL),
        )
        ollama_model = _ask(
            input_fn, "Ollama model", existing_providers.get("ollama_model")
        )
        ok, detail = probe(ollama_url, ollama_model)
        if ok:
            print("Ollama reachable, model found.")
        else:
            print(f"WARNING: Ollama check failed: {detail}")
            print(
                "  The config is written anyway. On Linux, try"
                " --add-host=host.docker.internal:host-gateway on the run"
                " command, or use the docker0 gateway IP. On macOS/Windows"
                " host.docker.internal works out of the box."
            )
    else:
        env_key = BUILTIN_ENV_KEYS[provider]
        api_key = _ask_api_key(getpass_fn, provider, existing_env.get(env_key))

    auth_secret = existing_env.get("FW_AUTH_SECRET", "")
    if auth_secret:
        rotate = _ask(input_fn, "Rotate FW_AUTH_SECRET? Logs everyone out (y/n)", "n")
        if rotate.lower().startswith("y"):
            auth_secret = ""
    if not auth_secret or len(auth_secret) < MIN_SECRET_LENGTH:
        auth_secret = secrets_module.token_urlsafe(48)
        print("Generated a new FW_AUTH_SECRET.")

    env_values = {
        "FW_AUTH_SECRET": auth_secret,
        "FW_ADMIN_EMAIL": email,
        "FW_ADMIN_PASSWORD": password,
    }
    if api_key is not None:
        env_values[BUILTIN_ENV_KEYS[provider]] = api_key

    config_data = yaml.safe_load(template_path.read_text(encoding="utf-8")) or {}
    providers_section = config_data.setdefault("providers", {})
    providers_section["default_provider"] = provider
    if provider == "ollama":
        providers_section["ollama_base_url"] = ollama_url
        providers_section["ollama_model"] = ollama_model

    _backup(env_path)
    _backup(config_path)
    _write_env(env_path, env_values)
    config_path.write_text(
        yaml.safe_dump(config_data, sort_keys=False), encoding="utf-8"
    )
    print(f"\nWrote {env_path.name} and {config_path.name} to {config_dir}.")
    print("Start the app with the serve command (see README quickstart).")
    return 0


def main() -> int:
    config_dir = Path(os.environ.get("FW_SETUP_CONFIG_DIR", DEFAULT_CONFIG_DIR))
    template = Path(os.environ.get("FW_CONFIG_TEMPLATE", DEFAULT_TEMPLATE))
    if not config_dir.is_dir():
        print(
            f"Config directory {config_dir} does not exist — run with"
            " -v fabulous-config:/config",
            file=sys.stderr,
        )
        return 1
    try:
        return run_wizard(config_dir, template)
    except (KeyboardInterrupt, EOFError):
        print("\nAborted — nothing was written.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the wizard tests, verify they pass**

Run: `uv run pytest tests/test_setup_wizard.py -v`
Expected: all PASS. If a scripted-input test errors with `StopIteration`, an unexpected extra prompt was added — fix the flow, not the test.

- [ ] **Step 5: Mutation-verify**

1. In `run_wizard`, drop the `_backup(env_path)` call → `test_backup_written_on_rerun` FAILS. Restore.
2. In `run_wizard`, replace the `env_values = {...}` construction with `env_values = dict(existing_env)` updated with the three FW_ keys (simulating a merge that carries old provider keys forward) → `test_provider_switch_removes_stale_key` FAILS. Restore.
3. Make `_validate_key` return `None` always → `test_wrong_key_prefix_reprompts` FAILS. Restore.
4. Drop the `path.chmod(0o600)` in `_write_env` → `test_env_files_are_owner_readable_only` FAILS. Restore.
5. Drop the `backup.chmod(0o600)` in `_backup` → the `.bak` assertion in the same test FAILS (the test widens the source to 0644 first, so copy2 propagation cannot mask it). Restore.

- [ ] **Step 6: Full backend suite, zero warnings**

Run: `uv run pytest -q`

- [ ] **Step 7: Commit**

```bash
git add backend/app/setup_wizard.py backend/tests/test_setup_wizard.py
git commit -m "feat(backend): re-runnable containerized setup wizard (B17, #58)"
```

---

### Task 3: License collection — `THIRD-PARTY-NOTICES.md` generator

**Files:**
- Create: `scripts/collect-licenses.py` (repo-root `scripts/`, new directory)
- Create: `scripts/curated-licenses.yaml`
- Create: `THIRD-PARTY-NOTICES.md` (generated, committed)

**Interfaces:**
- Consumes: `backend/uv.lock` via `uv export --no-dev`, installed backend venv metadata, `frontend/node_modules` via `npx license-checker-rseidelsohn`.
- Produces: `THIRD-PARTY-NOTICES.md` at repo root (Task 4 copies it into the image; Task 5's drift check runs this script and diffs). Run as `uv run --project backend python scripts/collect-licenses.py` from the repo root.

- [ ] **Step 1: Write the curated data**

Create `scripts/curated-licenses.yaml`. The versions below are the pinned ones (spaCy models 3.8.0; ginza 5.2.0). **The implementer must verify each `license` value against the named upstream before committing** — for the wooorm dictionaries, read the per-dictionary `license` file in https://github.com/wooorm/dictionaries (e.g. `dictionaries/de/license`); for spaCy models, the model page on https://spacy.io/models or the package's `meta.json`. If a verified value differs from the value below, correct it here — this file is the source of truth for what we relied on.

```yaml
# Hand-curated entries for distributed components no package manager tracks
# (spaCy model wheels are installed straight from URLs; Hunspell
# dictionaries are downloaded as raw files). license values verified
# against upstream at implementation time.
- name: en_core_web_sm
  version: 3.8.0
  license: MIT
  source: https://github.com/explosion/spacy-models
- name: de_core_news_sm
  version: 3.8.0
  license: MIT
  source: https://github.com/explosion/spacy-models
- name: fr_core_news_sm
  version: 3.8.0
  license: LGPL-3.0 (model); trained on Sequoia/WikiNER (see source)
  source: https://github.com/explosion/spacy-models
- name: es_core_news_sm
  version: 3.8.0
  license: GPL-3.0 (model; AnCora corpus)
  source: https://github.com/explosion/spacy-models
- name: it_core_news_sm
  version: 3.8.0
  license: CC BY-NC-SA 3.0 (model; ISDT/WikiNER)
  source: https://github.com/explosion/spacy-models
- name: zh_core_web_sm
  version: 3.8.0
  license: MIT (model; OntoNotes 5 terms apply to the corpus)
  source: https://github.com/explosion/spacy-models
- name: ginza
  version: 5.2.0
  license: MIT
  source: https://github.com/megagonlabs/ginza
- name: ja_ginza
  version: 5.2.0
  license: MIT
  source: https://github.com/megagonlabs/ginza
- name: hunspell-dictionary-en
  version: wooorm/dictionaries (en)
  license: (verify upstream dictionaries/en/license)
  source: https://github.com/wooorm/dictionaries
- name: hunspell-dictionary-de
  version: wooorm/dictionaries (de, igerman98)
  license: GPL-2.0 OR GPL-3.0
  source: https://github.com/wooorm/dictionaries
- name: hunspell-dictionary-fr
  version: wooorm/dictionaries (fr)
  license: MPL-2.0
  source: https://github.com/wooorm/dictionaries
- name: hunspell-dictionary-es
  version: wooorm/dictionaries (es)
  license: GPL-3.0 OR LGPL-3.0 OR MPL-1.1
  source: https://github.com/wooorm/dictionaries
- name: hunspell-dictionary-it
  version: wooorm/dictionaries (it)
  license: GPL-3.0
  source: https://github.com/wooorm/dictionaries
```

(The `(verify upstream)` placeholder for `en` MUST be replaced with the verified value during this task — the generator refuses to run while any `license` value contains `verify upstream`.)

- [ ] **Step 2: Write the generator**

Create `scripts/collect-licenses.py`:

```python
#!/usr/bin/env python3
"""Generate THIRD-PARTY-NOTICES.md (B17, #58).

Collects, with full license texts:
  1. Python runtime dependencies — the ``uv export --no-dev`` set, license
     text read from the installed distribution's metadata (run via
     ``uv run --project backend`` so the venv is importable).
  2. Frontend production dependencies — ``license-checker-rseidelsohn``
     over frontend/ (the set that reaches dist/).
  3. Curated entries (scripts/curated-licenses.yaml) — spaCy models,
     ginza, Hunspell dictionaries.

Debian base-image packages are attributed by the /usr/share/doc/*/copyright
files that remain in the image (stated in the output header).

The output describes the linux/CPython 3.13 container image: requirement
markers are evaluated against a fixed IMAGE_ENV (not the machine running
the script), so the file is byte-identical whether generated on the dev
Mac or in ubuntu CI — a pure function of uv.lock, package-lock.json, and
the curated data.

Usage (repo root):  uv run --project backend python scripts/collect-licenses.py
CI drift check:     run it, then `git diff --exit-code THIRD-PARTY-NOTICES.md`
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from importlib import metadata
from pathlib import Path

import yaml
from packaging.markers import Marker  # transitive dep of the backend venv

# The image's environment (linux/amd64, CPython 3.13). Markers are evaluated
# against THIS, never the local platform, so dev and CI agree byte-for-byte.
IMAGE_ENV = {
    "sys_platform": "linux",
    "platform_system": "Linux",
    "os_name": "posix",
    "platform_machine": "x86_64",
    "platform_python_implementation": "CPython",
    "python_version": "3.13",
    "python_full_version": "3.13.0",
    "implementation_name": "cpython",
    "extra": "",
}

REPO = Path(__file__).resolve().parent.parent
OUTPUT = REPO / "THIRD-PARTY-NOTICES.md"
CURATED = REPO / "scripts" / "curated-licenses.yaml"

HEADER = """\
# Third-Party Notices

Fabulous Writing is MIT-licensed (see LICENSE). The distributed container
image and application bundle include the third-party components below,
reproduced with their license texts as those licenses require.

Debian packages in the base image keep their license and copyright
information in `/usr/share/doc/<package>/copyright` inside the image.

This file is generated by `scripts/collect-licenses.py`; CI fails if it
is out of date. Do not edit by hand.
"""


def python_requirements() -> list[tuple[str, str]]:
    """Pinned (name, version) pairs for the image — marker-filtered."""
    out = subprocess.run(
        ["uv", "export", "--no-dev", "--no-hashes", "--format", "requirements-txt"],
        cwd=REPO / "backend",
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    pins = []
    for line in out.splitlines():
        line = line.strip()
        match = re.match(r"^([A-Za-z0-9._-]+)==([^ ;]+)\s*(?:;\s*(.+))?$", line)
        if not match:
            continue
        name, version, marker = match.group(1), match.group(2), match.group(3)
        # The export is universal (all platforms). Keep only what the
        # linux/CPython image actually ships — e.g. colorama (win32-only)
        # is exported but never installed in the image.
        if marker and not Marker(marker).evaluate(IMAGE_ENV):
            continue
        pins.append((name, version))
    if not pins:
        raise SystemExit("uv export produced no pinned requirements")
    return sorted(pins, key=lambda p: p[0].lower())


def python_license(name: str) -> tuple[str, str]:
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError:
        raise SystemExit(
            f"'{name}' is in the uv export for the image but not installed"
            " locally — run `uv sync --locked` in backend/ first"
        ) from None
    meta = dist.metadata
    spdx = meta.get("License-Expression") or ""
    if not spdx:
        classifiers = [
            c.removeprefix("License :: OSI Approved :: ")
            for c in meta.get_all("Classifier", [])
            if c.startswith("License ::")
        ]
        spdx = "; ".join(classifiers) or (meta.get("License") or "UNKNOWN")
    texts = []
    for file in dist.files or []:
        parts = [part.lower() for part in file.parts]
        if not parts or ".dist-info" not in parts[0]:
            continue
        if not ("licenses" in parts or parts[-1].startswith(("license", "copying", "notice"))):
            continue
        # PackagePath is rooted at site-packages; locate() gives the real
        # path (dist.read_text() would resolve relative to .dist-info and
        # silently return None for every file).
        located = file.locate()
        if located.is_file():
            texts.append(located.read_text(encoding="utf-8", errors="replace"))
    return spdx, "\n\n".join(texts) or "(license text not shipped in wheel; see project page)"


def npm_packages() -> dict[str, dict]:
    out = subprocess.run(
        [
            "npx", "--yes", "license-checker-rseidelsohn@4",
            "--production", "--json", "--excludePrivatePackages",
        ],
        cwd=REPO / "frontend",
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return json.loads(out)


def render(sections: list[tuple[str, list[tuple[str, str, str, str]]]]) -> str:
    lines = [HEADER]
    for title, entries in sections:
        lines.append(f"\n## {title}\n")
        for name, version, license_id, text in entries:
            lines.append(f"\n### {name} {version}\n")
            lines.append(f"License: {license_id}\n")
            # 4-backtick fence: npm licenseFile sometimes points at a README
            # whose own ``` fences would otherwise break the structure.
            lines.append("````text")
            lines.append(text.strip() or "(no text)")
            lines.append("````")
    return "\n".join(lines) + "\n"


def main() -> int:
    curated = yaml.safe_load(CURATED.read_text(encoding="utf-8"))
    for entry in curated:
        if "verify upstream" in entry["license"]:
            raise SystemExit(f"curated entry '{entry['name']}' still unverified")

    python_entries = []
    for name, version in python_requirements():
        spdx, text = python_license(name)
        python_entries.append((name, version, spdx, text))

    npm_entries = []
    for key, info in sorted(npm_packages().items()):
        name, _, version = key.rpartition("@")
        license_file = info.get("licenseFile")
        text = (
            Path(license_file).read_text(encoding="utf-8", errors="replace")
            if license_file and Path(license_file).is_file()
            else "(license text not shipped; see repository)"
        )
        licenses = info.get("licenses", "UNKNOWN")
        if isinstance(licenses, list):
            licenses = " OR ".join(licenses)
        npm_entries.append((name, version, str(licenses), text))

    curated_entries = [
        (
            entry["name"],
            str(entry["version"]),
            entry["license"],
            f"Source: {entry['source']}\nLicense terms: see the source's license file for this component.",
        )
        for entry in curated
    ]

    OUTPUT.write_text(
        render(
            [
                ("Python (backend runtime)", python_entries),
                ("JavaScript (bundled frontend)", npm_entries),
                ("Language models and dictionaries", curated_entries),
            ]
        ),
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size // 1024} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Note: `numpy`'s `.dist-info/licenses/` contains ~15 vendored license files; concatenating them all is correct behavior, just verbose.

- [ ] **Step 3: Verify the curated licenses against upstream**

For each `(verify upstream)` or doubtful entry, fetch the upstream license file (e.g. `curl -s https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/license | head -5`) and correct `scripts/curated-licenses.yaml`. Every entry must end up with a concrete license identifier.

- [ ] **Step 4: Generate and sanity-check**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
uv run --project backend python scripts/collect-licenses.py
grep -c "^### " THIRD-PARTY-NOTICES.md   # expect ~110-130 (71 Python after marker filtering + ~30 npm + 13 curated)
grep -n "UNKNOWN" THIRD-PARTY-NOTICES.md # investigate every hit before committing
python3 - <<'PY'
import pathlib
text = pathlib.Path("THIRD-PARTY-NOTICES.md").read_text(encoding="utf-8")
entries = text.count("\n### ")
textless = text.count("license text not shipped")
print(f"entries: {entries}, textless: {textless}")
assert entries > 100, "far fewer entries than the dependency surface — collector is dropping packages"
assert textless < 10, "license texts are not being extracted — python_license() is broken"
PY
```

Every `UNKNOWN` license must be resolved (usually by fixing the metadata read) or explicitly justified in the entry.

- [ ] **Step 5: Commit** (before mutation-verification — the drift check below needs the files tracked, and commit-then-mutate is exactly what CI does)

```bash
git add scripts/collect-licenses.py scripts/curated-licenses.yaml THIRD-PARTY-NOTICES.md
git commit -m "feat(licenses): collect third-party notices with full texts (B17, #58)"
```

- [ ] **Step 6: Mutation-verify the drift mechanism**

```bash
# 1. Malformed curated entry (missing 'license' key) must be rejected loudly:
echo "- name: fake" >> scripts/curated-licenses.yaml
uv run --project backend python scripts/collect-licenses.py \
  && echo "GENERATOR ACCEPTED MALFORMED ENTRY — BUG" \
  || echo "generator rejected the malformed entry OK"
git checkout -- scripts/curated-licenses.yaml

# 2. A content change must show up as drift:
sed -i '' 's/version: 3.8.0/version: 9.9.9/' scripts/curated-licenses.yaml
uv run --project backend python scripts/collect-licenses.py
git diff --exit-code THIRD-PARTY-NOTICES.md \
  && echo "DRIFT NOT DETECTED — BUG" \
  || echo "drift detected OK"

# 3. Restore and confirm clean:
git checkout -- scripts/curated-licenses.yaml THIRD-PARTY-NOTICES.md
uv run --project backend python scripts/collect-licenses.py
git diff --exit-code THIRD-PARTY-NOTICES.md && echo "clean OK"
```

Expected output lines: "generator rejected the malformed entry OK", "drift detected OK", "clean OK". Anything else is a bug in the collector or this verification — stop and fix before proceeding. (The malformed-entry rejection comes from the KeyError on `entry["license"]` — acceptable as long as it is a hard, nonzero exit.)

---

### Task 4: Image — Dockerfile, entrypoint, config template, wrapper; local e2e

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker/entrypoint.sh`, `docker/config.container.yaml`, `fabulous.sh`

**Interfaces:**
- Consumes: Task 1 (`FW_CONFIG_FILE`, `frontend.dist_dir`, health version), Task 2 (`python -m app.setup_wizard`, `FW_SETUP_CONFIG_DIR`/`FW_CONFIG_TEMPLATE` defaults `/config` and `/app/config.container.yaml`), Task 3 (`THIRD-PARTY-NOTICES.md`).
- Produces: image buildable as `docker build -t fabulous-writing:dev .`; Task 5's workflows build exactly this Dockerfile with build-arg `APP_VERSION`.

- [ ] **Step 1: Create `.dockerignore`**

```
.git
.github
.claude
.superpowers
docs
frontend/node_modules
frontend/dist
frontend/coverage
backend/.venv
backend/data
backend/config.yaml
backend/api-keys.sh
backend/dictionaries
backend/.ruff_cache
backend/htmlcov
**/__pycache__
**/.pytest_cache
**/.DS_Store
**/*.bak
```

(`backend/config.yaml` and `api-keys.sh` are the owner's local dev config/secrets — never in the build context. `backend/data` is the live DB.)

- [ ] **Step 2: Create `docker/config.container.yaml`**

```yaml
# Base configuration for the container image. The setup wizard copies and
# extends this into /config/config.yaml — do not point FW_CONFIG_FILE here.
environment: production
db_path: /data/fabulous.db
frontend:
  dist_dir: /app/dist
# Single-origin serving: no cross-origin callers exist, so no origin is
# allowed. Dev keeps its own defaults (this file is container-only).
cors:
  origins: []
providers:
  default_provider: ollama
```

- [ ] **Step 3: Create `docker/entrypoint.sh`** (the Dockerfile copies it with `--chmod=0755`, but set the git exec bit too — see the commit step)

```sh
#!/bin/sh
# Entrypoint: `setup` runs the wizard; anything else serves the app.
# Env-file semantics: /config/fabulous.env is applied only for variables
# not already set — real environment variables win (fly.io secrets, B16).
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

if [ -f /config/fabulous.env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|\#*) continue ;; esac
        key=${line%%=*}
        value=${line#*=}
        if ! printenv "$key" >/dev/null 2>&1; then
            export "$key=$value"
        fi
    done < /config/fabulous.env
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- [ ] **Step 4: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# Layers are ordered strictly by change frequency (registry build cache):
# OS packages -> dictionaries -> Python deps (lockfile only) -> spaCy
# models -> application code. Editing app code must bust only the last
# layer.

FROM node:26-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Empty VITE_API_URL = relative API paths = single-origin serving
# (frontend/src/api/client.ts uses `??`, which keeps an empty string).
ENV VITE_API_URL=""
RUN npm run build

FROM python:3.13-slim AS runtime
WORKDIR /app

# 1. OS packages (curl: dictionary download + healthcheck)
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Pinned deliberately: a floating :latest resolves to a new digest on every
# uv release, and a changed COPY source invalidates every layer below it —
# including the ~1.5 GB model layer. (Implementer: check the current uv
# release at https://github.com/astral-sh/uv/releases and pin that.)
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv

# 2. Hunspell dictionaries (own layer: network fetch, changes ~never)
COPY backend/scripts/install-dictionaries.sh scripts/
RUN ./scripts/install-dictionaries.sh en de fr es it

# 3. Python runtime dependencies from the lockfile only
COPY backend/pyproject.toml backend/uv.lock ./
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    VIRTUAL_ENV=/app/.venv
RUN uv sync --locked --no-dev

# 4. spaCy pipelines + GiNZA (largest, most stable layer; pins match
#    backend/scripts/install-models.sh VER=3.8.0 and the curated notices).
#    This layer sits below the lockfile COPY even though it changes less
#    often, because `uv pip install` needs the venv from layer 3 to exist —
#    a dependency bump therefore rebuilds it; the registry cache absorbs
#    that for unchanged-lockfile builds. ginza/ja-ginza resolve their own
#    deps against the already-synced venv (VIRTUAL_ENV above makes the
#    target venv explicit rather than cwd-derived).
RUN uv pip install \
    "en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl" \
    "de-core-news-sm @ https://github.com/explosion/spacy-models/releases/download/de_core_news_sm-3.8.0/de_core_news_sm-3.8.0-py3-none-any.whl" \
    "fr-core-news-sm @ https://github.com/explosion/spacy-models/releases/download/fr_core_news_sm-3.8.0/fr_core_news_sm-3.8.0-py3-none-any.whl" \
    "es-core-news-sm @ https://github.com/explosion/spacy-models/releases/download/es_core_news_sm-3.8.0/es_core_news_sm-3.8.0-py3-none-any.whl" \
    "it-core-news-sm @ https://github.com/explosion/spacy-models/releases/download/it_core_news_sm-3.8.0/it_core_news_sm-3.8.0-py3-none-any.whl" \
    "zh-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/zh_core_web_sm-3.8.0/zh_core_web_sm-3.8.0-py3-none-any.whl" \
    "ginza==5.2.0" "ja-ginza==5.2.0"

# 5. Application
COPY backend/app ./app
COPY backend/rules ./rules
COPY backend/demos ./demos
COPY docker/config.container.yaml ./config.container.yaml
COPY THIRD-PARTY-NOTICES.md LICENSE ./
COPY --from=frontend-build /build/dist ./dist
COPY --chmod=0755 docker/entrypoint.sh /entrypoint.sh

ARG APP_VERSION=dev
ENV FW_APP_VERSION=$APP_VERSION \
    FW_CONFIG_FILE=/config/config.yaml \
    PATH="/app/.venv/bin:$PATH"
LABEL org.opencontainers.image.source="https://github.com/saigyo/fabulous-writing" \
      org.opencontainers.image.description="Fabulous Writing — writing checker with LLM support" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$APP_VERSION

RUN useradd --create-home fabulous \
    && mkdir -p /data /config \
    && chown fabulous:fabulous /data /config
USER fabulous
VOLUME ["/data", "/config"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -fsS http://localhost:8000/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["serve"]
```

- [ ] **Step 5: Create `fabulous.sh`** (repo root, `chmod +x`)

```sh
#!/bin/sh
# Thin wrapper around the two docker run invocations. All behavior lives
# in the image (wizard + entrypoint); this only plumbs arguments.
# Usage:  ./fabulous.sh setup [version]
#         ./fabulous.sh serve [version]
# Env:    FW_PORT (host port, default 8080), FW_IMAGE (override image ref;
#         give it WITHOUT a tag — the version argument supplies the tag)
set -eu

IMAGE_BASE=${FW_IMAGE:-ghcr.io/saigyo/fabulous-writing}
COMMAND=${1:-}
VERSION=${2:-latest}
IMAGE="$IMAGE_BASE:$VERSION"
PORT=${FW_PORT:-8080}

case "$COMMAND" in
    setup)
        exec docker run --rm -it \
            -v fabulous-config:/config \
            "$IMAGE" setup
        ;;
    serve)
        exec docker run --rm \
            -v fabulous-config:/config \
            -v fabulous-data:/data \
            -p "$PORT:8000" \
            "$IMAGE" serve
        ;;
    *)
        echo "Usage: $0 {setup|serve} [version]" >&2
        exit 64
        ;;
esac
```

- [ ] **Step 6: Build the image locally**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
docker build -t fwscratch:dev --build-arg APP_VERSION=0.0.0-local .
```

Expected: clean build. Fix any layer that fails (typical: `uv sync` needing an extra flag — if it errors trying to build the project itself, add `--no-install-project`).

- [ ] **Step 7: End-to-end verification on a scratch stack (host port 8001 only)**

```bash
docker volume create fwscratch-config
docker volume create fwscratch-data
# Scripted e2e uses a pre-seeded config volume (the wizard's getpass needs
# a TTY; its interactive smoke-test comes at the end of this step):
docker run --rm -v fwscratch-config:/config --entrypoint sh fwscratch:dev -c '
cat > /config/fabulous.env <<EOF
FW_AUTH_SECRET=e2e-scratch-secret-0123456789abcdefghijklmn
FW_ADMIN_EMAIL=e2e@example.com
FW_ADMIN_PASSWORD=e2e-scratch-password
EOF
cp /app/config.container.yaml /config/config.yaml'
docker run -d --name fwscratch -p 8001:8000 \
  -v fwscratch-config:/config -v fwscratch-data:/data fwscratch:dev
sleep 5
curl -s http://localhost:8001/api/health          # {"status":"ok",...,"version":"0.0.0-local"}
curl -s http://localhost:8001/ | head -c 100      # SPA index.html
TOKEN=$(curl -s -X POST http://localhost:8001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"e2e@example.com","password":"e2e-scratch-password"}' | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl -s http://localhost:8001/api/languages -H "Authorization: Bearer $TOKEN"
# A real rules-only check — proves the spaCy model layer actually loads
# (the Hunspell dictionaries feed only the LLM-suggestion spell gate, which
# a rules-only check never reaches — their presence is covered by the
# /app/dictionaries listing below):
CHECK=$(curl -s -X POST http://localhost:8001/api/checks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"Thsi is a sentense with a typo.","language":"en","checkers":["rules"]}' | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["check_id"])')
curl -s -N --max-time 30 http://localhost:8001/api/checks/$CHECK/events \
  -H "Authorization: Bearer $TOKEN" | head -c 500   # expect SSE events
# A missing spaCy model is a SOFT skip (checks.py sets skipped_rules), so
# assert the skip list is empty — this is the actual model-layer proof:
curl -s http://localhost:8001/api/checks/$CHECK -H "Authorization: Bearer $TOKEN" | \
  python3 -c 'import json,sys; s=json.load(sys.stdin); assert s["skipped_rules"] == [], s["skipped_rules"]; print("no skipped rules OK")'
docker exec fwscratch ls /app/dictionaries        # en/de/fr/es/it .aff+.dic present
docker exec fwscratch ls /data                    # fabulous.db present
docker exec fwscratch cat /app/THIRD-PARTY-NOTICES.md | head -3
docker exec fwscratch sh -c 'ls /usr/share/doc | head -3'
# persistence across replacement:
docker rm -f fwscratch
docker run -d --name fwscratch -p 8001:8000 \
  -v fwscratch-config:/config -v fwscratch-data:/data fwscratch:dev
sleep 5
curl -s -X POST http://localhost:8001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"e2e@example.com","password":"e2e-scratch-password"}' | head -c 60
# interactive wizard smoke (real TTY): run manually and answer prompts
docker run --rm -it -v fwscratch-config:/config fwscratch:dev setup
# cleanup — own scratch resources only:
docker rm -f fwscratch; docker volume rm fwscratch-config fwscratch-data
docker rmi fwscratch:dev
```

Every step's expected outcome is in its comment; a deviation is a bug in the image, not in the test. Record the interactive-wizard transcript observations (prompts shown, files written) in the task report.

- [ ] **Step 8: Commit** (the exec bits must be in git — the image gets the entrypoint's via `--chmod`, but `fabulous.sh` is run from a checkout/download)

```bash
git add Dockerfile .dockerignore docker/ fabulous.sh
git update-index --chmod=+x fabulous.sh docker/entrypoint.sh
git ls-files -s fabulous.sh docker/entrypoint.sh   # both must show mode 100755
git commit -m "feat(deploy): single-container image, entrypoint, setup wrapper (B17, #58)"
```

---

### Task 5: Workflows — docker CI, release, Node 26 bump

**Files:**
- Create: `.github/workflows/docker.yml`
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/frontend.yml` (`node-version: 24` → `26`)

**Interfaces:**
- Consumes: `Dockerfile` (Task 4), `scripts/collect-licenses.py` (Task 3).
- Produces: on tag `v*`: GHCR image `ghcr.io/saigyo/fabulous-writing:{X.Y.Z,latest}` + GitHub Release. On PRs touching image inputs: build-only check + license drift check.

- [ ] **Step 1: Create `.github/workflows/docker.yml`**

```yaml
name: Docker CI

on:
  push:
    branches: [main]
    paths:
      - "Dockerfile"
      - ".dockerignore"
      - "docker/**"
      - "fabulous.sh"
      - "scripts/**"
      - "backend/scripts/**"
      - "THIRD-PARTY-NOTICES.md"
      - "backend/pyproject.toml"
      - "backend/uv.lock"
      - "frontend/package.json"
      - "frontend/package-lock.json"
      - ".github/workflows/docker.yml"
  pull_request:
    paths:
      - "Dockerfile"
      - ".dockerignore"
      - "docker/**"
      - "fabulous.sh"
      - "scripts/**"
      - "backend/scripts/**"
      - "THIRD-PARTY-NOTICES.md"
      - "backend/pyproject.toml"
      - "backend/uv.lock"
      - "frontend/package.json"
      - "frontend/package-lock.json"
      - ".github/workflows/docker.yml"
  workflow_dispatch:

concurrency:
  group: docker-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read
  packages: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: docker/setup-buildx-action@v3
      - name: Log in to GHCR (registry cache reads)
        if: ${{ github.event.pull_request.head.repo.fork != true }}
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build (amd64, no push)
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: false
          cache-from: type=registry,ref=ghcr.io/saigyo/fabulous-writing:buildcache

  licenses:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Install uv
        uses: astral-sh/setup-uv@v7
      - name: Set up Node
        uses: actions/setup-node@v7
        with:
          node-version: 26
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      # Runtime-only: matches the marker-filtered export the collector uses,
      # and skips the ~500 MB dev-group model wheels on every PR.
      - name: Install backend deps (runtime only)
        run: uv sync --locked --no-dev
        working-directory: backend
      - name: Install frontend deps
        run: npm ci
        working-directory: frontend
      - name: Regenerate notices
        run: uv run --project backend --no-sync python scripts/collect-licenses.py
      - name: Fail on drift
        run: git diff --exit-code THIRD-PARTY-NOTICES.md
```

- [ ] **Step 2: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ["v*"]

concurrency:
  group: release

permissions:
  contents: write
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    # The arm64 leg runs under QEMU emulation and unpacks ~1.5 GB of model
    # wheels — expect a long first build (the registry cache tames later ones).
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@v7
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Version from tag
        id: version
        run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"
      - name: Build and push (amd64 + arm64)
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          build-args: |
            APP_VERSION=${{ steps.version.outputs.version }}
          tags: |
            ghcr.io/saigyo/fabulous-writing:${{ steps.version.outputs.version }}
            ghcr.io/saigyo/fabulous-writing:latest
          cache-from: type=registry,ref=ghcr.io/saigyo/fabulous-writing:buildcache
          cache-to: type=registry,ref=ghcr.io/saigyo/fabulous-writing:buildcache,mode=max
      - name: Create GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" --generate-notes --verify-tag
```

- [ ] **Step 3: Bump `frontend.yml` Node version**

In `.github/workflows/frontend.yml`, change `node-version: 24` to `node-version: 26`.

- [ ] **Step 4: Validate workflow syntax**

```bash
if command -v actionlint >/dev/null; then
  actionlint .github/workflows/docker.yml .github/workflows/release.yml .github/workflows/frontend.yml
else
  python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['.github/workflows/docker.yml','.github/workflows/release.yml','.github/workflows/frontend.yml']]; print('YAML parse OK (actionlint not installed)')"
fi
```

Expected: exit 0, no findings. (An `A && B || C` chain would swallow actionlint failures — keep the if/else shape.) (docker.yml runs live on the implementation PR itself — its paths match the PR's files — which is the real test; release.yml is exercised by the post-merge `v0.1.0` tag.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/docker.yml .github/workflows/release.yml .github/workflows/frontend.yml
git commit -m "ci(deploy): docker build check, license drift gate, tag-driven release (B17, #58)"
```

---

### Task 6: Docs — README quickstart, architecture docs

**Files:**
- Modify: `README.md` (new top-level section after the existing intro/setup material)
- Modify: `docs/backend-architecture.md` (new section)
- Modify: `docs/frontend-architecture.md` (new short section)

- [ ] **Step 1: README quickstart section**

Add a section `## Run it in a container (quickstart)` to `README.md`, inserted directly before the `## Setup and running` heading (currently line 175), so container users stop reading early. Content (adjust heading levels to the file's conventions):

````markdown
## Run it in a container (quickstart)

Requires only Docker.

```sh
curl -fsSLO https://raw.githubusercontent.com/saigyo/fabulous-writing/main/fabulous.sh && chmod +x fabulous.sh
./fabulous.sh setup    # interactive: admin account, one LLM provider
./fabulous.sh serve    # http://localhost:8080
```

Or with plain `docker run`:

```sh
docker run --rm -it -v fabulous-config:/config ghcr.io/saigyo/fabulous-writing:latest setup
docker run --rm -v fabulous-config:/config -v fabulous-data:/data -p 8080:8000 \
  ghcr.io/saigyo/fabulous-writing:latest serve
```

- The wizard writes all configuration to the `fabulous-config` volume and
  can be re-run at any time (e.g. to switch LLM providers); it pre-fills
  your previous answers.
- Your data lives in the `fabulous-data` volume; backup = copy that
  volume's directory.
- Versions: images are tagged `X.Y.Z` (git tag `vX.Y.Z`) plus `latest`;
  `./fabulous.sh serve 0.1.0` pins a version. Releases are cut
  deliberately by pushing an annotated tag `vX.Y.Z` — the release
  workflow builds and publishes the image, then creates the GitHub
  Release; nothing is released automatically on pushes to `main`.

### Troubleshooting

- **Ollama not reachable from the container** — the app runs inside
  Docker, so `localhost:11434` is the container, not your machine. On
  macOS/Windows use `http://host.docker.internal:11434` (the wizard's
  default). On Linux add `--add-host=host.docker.internal:host-gateway`
  to the `docker run serve` line (edit `fabulous.sh` or use plain
  `docker run`), or use your `docker0` gateway IP (usually
  `http://172.17.0.1:11434`).
- **Port already in use** — pick another host port: `FW_PORT=9090
  ./fabulous.sh serve` (or change `-p 9090:8000`).

Third-party license notices for everything bundled in the image are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (also at
`/app/THIRD-PARTY-NOTICES.md` inside the image).
````

- [ ] **Step 2: Backend architecture doc**

In `docs/backend-architecture.md`, append a section `## Container deployment (B17)` covering, in this order, one short paragraph each: config resolution (`FW_CONFIG_FILE` between explicit argument and `backend/config.yaml` default), single-origin serving (`frontend.dist_dir`, `/assets` mount + catch-all with `/api` exclusion and traversal guard, registered after all API routers), the wizard (`app/setup_wizard.py`, owns `/config`, whole-file regeneration, injectable IO for tests), version reporting (`FW_APP_VERSION` → `/api/health`, tag-as-truth), and the image layer ordering rationale (cache by change frequency). Reference the spec file path.

- [ ] **Step 3: Frontend architecture doc**

In `docs/frontend-architecture.md`, append a short section `## Production serving (B17)` after the API-client section: production builds run with `VITE_API_URL=""` so `client.ts`'s `??` fallback keeps the empty string and all API calls are relative (single origin, no CORS); dev behavior unchanged.

- [ ] **Step 4: Gates and commit**

Backend untouched in this task; run `git status --short -- frontend/` (must be empty).

```bash
git add README.md docs/backend-architecture.md docs/frontend-architecture.md
git commit -m "docs(deploy): container quickstart, architecture sections (B17, #58)"
```

---

## Post-PR steps (controller, not a dispatched task)

1. Push the branch, open the implementation PR with `Closes #58.` in the body, request Copilot review, spawn the watcher (match `copilot-pull-request-reviewer[bot]`). Note in the PR body that `THIRD-PARTY-NOTICES.md` is a multi-MB generated file — reviewers should skip it and review `scripts/collect-licenses.py` + `scripts/curated-licenses.yaml` instead (Copilot degrades on files >~100 KiB).
2. The PR itself triggers `docker.yml` (its paths match) — confirm both the build job and the licenses job pass before merge; that is the live test of the new CI.
3. After the owner merges: append the LOGBOOK entry referencing the real PR number (run `date` first), update architecture docs memory if needed, sync main, delete the branch.
4. Ask the owner to cut `v0.1.0` (`git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0`) — verify: GHCR image pulls on both architectures, Release page exists with notes, `/api/health` reports `0.1.0`. Make the GHCR package public if this is the first push (one-time, in the GitHub package settings). Known risk: the arm64 leg runs under QEMU and may take >1 h on the first (cache-cold) build; if it exhausts the 180-min timeout, the fallback is an amd64-only `v0.1.0` (drop `linux/arm64` from `platforms` in a follow-up PR, retag) plus a follow-up issue for native-arm64 builds (`runs-on: ubuntu-24.04-arm` + manifest merge).
