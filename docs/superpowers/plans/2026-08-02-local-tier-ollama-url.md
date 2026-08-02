# Local Tier Host-Ollama URL (B25, #84) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commercial-provider configs point Ollama at the host, so the local tier lights up the moment host Ollama runs.

**Architecture:** One `else` branch in `run_wizard`'s config generation plus a null-hardened `existing_providers` read; four new tests plus one updated B24 test.

**Tech Stack:** Python 3.13, pytest (injected IO, no network).

**Spec:** `docs/superpowers/specs/2026-08-02-local-tier-ollama-url-design.md` — binding.

## Global Constraints

- From `backend/`: `uv run pytest -q` green, ZERO warnings before commit. Tests tmp_path-only, fetch injected, no network, no live DB, no ports 5173/8000. `frontend/` untouched. Transcribe code verbatim; mutation-verify the guard. Commit messages `type(scope): summary (B25, #84)` + the two dispatch-supplied trailer lines.

---

### Task 0: Branch

- [ ] **Step 1:**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
git checkout main && git pull && git checkout -b b25-local-tier-url || { echo "branch setup failed"; exit 1; }
```

---

### Task 1: The else branch + tests

**Files:**
- Modify: `backend/app/setup_wizard.py` (config-generation block, the `if provider == "ollama":` that writes `ollama_base_url`/`ollama_model`)
- Test: `backend/tests/test_setup_wizard.py` (one test updated, one class added)

- [ ] **Step 1: Update the now-outdated B24 switch test.** TDD order: after this step the renamed test FAILS (the URL is not yet written on the switch path — that red state is required); Step 3's implementation turns it green.

In `test_switch_away_from_ollama_drops_ollama_config`, replace the two final assertions:

```python
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "ollama_base_url" not in config
        assert "ollama_model" not in config
```

with:

```python
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        # B25 (#84): the base URL is deliberately KEPT on a switch away —
        # it is the local tier's pointer and the last known Ollama
        # location. Only the model selection is dropped.
        assert "ollama_base_url: http://host.docker.internal:11434" in config
        assert "ollama_model" not in config
```

and rename the test to `test_switch_away_from_ollama_keeps_url_drops_model`.

- [ ] **Step 2: Append the new failing tests**

```python
class TestCommercialOllamaUrl:
    def test_commercial_first_run_writes_default_url(self, tmp_path, template):
        import yaml as yaml_module

        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["admin@example.com", "1"]),
            getpass_fn=scripted(["s3cret-password!", "sk-ant-abc123"]),
            fetch_models=fetch_fail,
        )
        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["providers"]["ollama_base_url"] == "http://host.docker.internal:11434"
        assert "ollama_model" not in data["providers"]

    def test_rerun_preserves_hand_edited_url(self, tmp_path, template):
        import yaml as yaml_module

        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["admin@example.com", "1"]),
            getpass_fn=scripted(["s3cret-password!", "sk-ant-abc123"]),
            fetch_models=fetch_fail,
        )
        # Hand-edit: a LAN Ollama host
        config_path = config_dir / "config.yaml"
        data = yaml_module.safe_load(config_path.read_text(encoding="utf-8"))
        data["providers"]["ollama_base_url"] = "http://192.168.1.50:11434"
        config_path.write_text(yaml_module.safe_dump(data, sort_keys=False), encoding="utf-8")
        # Keep-everything re-run (commercial: email, provider, rotate)
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "n"]),
            getpass_fn=scripted(["", ""]),
            fetch_models=fetch_fail,
        )
        data = yaml_module.safe_load(config_path.read_text(encoding="utf-8"))
        assert data["providers"]["ollama_base_url"] == "http://192.168.1.50:11434"

    def test_switch_preserves_prompted_url(self, tmp_path, template):
        # Ollama first run with a NON-default prompted URL (a bare
        # default here would pass against a hard-coded constant), then a
        # switch to mistral: the prompted URL must survive.
        import yaml as yaml_module

        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(
                ["admin@example.com", "4", "http://10.0.0.7:11434", "llama3.1"]
            ),
            getpass_fn=scripted(["s3cret-password!"]),
            fetch_models=fetch_fail,
        )
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "3", "n"]),
            getpass_fn=scripted(["", "a" * 24]),
            fetch_models=fetch_fail,
        )
        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["providers"]["ollama_base_url"] == "http://10.0.0.7:11434"
        assert data["providers"]["default_provider"] == "mistral"
```

- [ ] **Step 3: Run — the three Step 2 tests FAIL (missing key / clobbered value / lost prompted URL; the bare-providers test in Step 3's code block below is added with the implementation), the renamed test FAILS on the kept-URL assertion. Implement:**

In `run_wizard`'s config generation, the block

```python
    if provider == "ollama":
        providers_section["ollama_base_url"] = ollama_url
        providers_section["ollama_model"] = ollama_model
```

gains an else branch:

```python
    if provider == "ollama":
        providers_section["ollama_base_url"] = ollama_url
        providers_section["ollama_model"] = ollama_model
    else:
        # Commercial provider: still point Ollama at the host so the
        # local tier's availability ping probes the right place — the
        # tier lights up once host Ollama is reachable (B25, #84; needs
        # OLLAMA_HOST beyond 127.0.0.1 — see README troubleshooting).
        # The prefill-style read preserves a hand-edited custom URL
        # across re-runs and the last prompted URL across a provider
        # switch; `or` (not a .get default) so an explicit null cannot
        # emit an invalid config.
        providers_section["ollama_base_url"] = (
            existing_providers.get("ollama_base_url") or DEFAULT_OLLAMA_URL
        )
```

ALSO harden the `existing_providers` definition earlier in `run_wizard` (line ~324): change `existing_providers = existing_config.get("providers", {})` to `existing_providers = existing_config.get("providers") or {}` — a hand-edited bare `providers:` (YAML null) must not crash the run. Add one test to the new class:

```python
    def test_bare_providers_key_does_not_crash(self, tmp_path, template):
        import yaml as yaml_module

        config_dir = tmp_path / "config"
        config_dir.mkdir()
        (config_dir / "fabulous.env").write_text(
            "FW_AUTH_SECRET=null-guard-secret-0123456789abcdefghij\n"
            "FW_ADMIN_EMAIL=admin@example.com\n"
            "FW_ADMIN_PASSWORD=s3cret-password!\n",
            encoding="utf-8",
        )
        (config_dir / "config.yaml").write_text("providers:\n", encoding="utf-8")
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "1", "n"]),
            getpass_fn=scripted(["", "sk-ant-abc123"]),
            fetch_models=fetch_fail,
        )
        assert rc == 0
        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["providers"]["ollama_base_url"] == "http://host.docker.internal:11434"
```

- [ ] **Step 3b: Keep `TestImageContract` mirroring the shipped merge**

In `test_real_template_validates_for_every_provider`, the per-provider merge replication currently sets `ollama_base_url` only inside its ollama branch — hoist it so EVERY provider variant sets `providers["ollama_base_url"]` (the ollama branch keeps its prompted-value semantics; the commercial branches use `"http://host.docker.internal:11434"`), matching what `run_wizard` now emits.

- [ ] **Step 4: Run the wizard test file (all pass), mutation-verify** (replace the else-branch `or` read with the bare `DEFAULT_OLLAMA_URL` constant → `test_rerun_preserves_hand_edited_url` and `test_switch_preserves_prompted_url` FAIL; delete the else branch → `test_commercial_first_run_writes_default_url` and the renamed switch test FAIL; revert the `existing_providers` hardening to `.get("providers", {})` → `test_bare_providers_key_does_not_crash` FAILS with AttributeError; restore all), **then the full suite — zero warnings.**

- [ ] **Step 5: Docs + commit**

In `docs/backend-architecture.md`'s wizard paragraph: REPLACE the now-false sentence ("local tier stays on the Ollama defaults regardless of the chosen provider", ~line 1990) — commercial-provider configs carry `providers.ollama_base_url` pointing at the host (`host.docker.internal`; hand-edits preserved on re-runs), so the local tier reports available once host Ollama is reachable from the container.

In `README.md`'s Ollama troubleshooting bullet (~lines 206-213): add platform-differentiated Ollama reachability guidance: macOS/Windows (Docker Desktop, colima/lima) — the default 127.0.0.1 bind is reachable via the host-side proxy, no `OLLAMA_HOST` change needed; native Linux Docker — bind Ollama to the docker bridge interface specifically (e.g. `OLLAMA_HOST=172.17.0.1`) or firewall port 11434, since loopback-only refuses there. Emphasize that since Ollama's API has no authentication, wildcard binds (`0.0.0.0`) expose it to the local network and should be avoided. This applies to commercial-provider setups too (the local tier probes host Ollama). One more sentence in the backend-architecture note: on commercial configs the URL has no prompt, so correcting a stale hand-edited value means editing `config.yaml` directly (or one round-trip through the Ollama provider).

```bash
git add backend/app/setup_wizard.py backend/tests/test_setup_wizard.py docs/backend-architecture.md README.md
git commit -m "feat(backend): commercial configs point Ollama at the host — local tier auto-discovers (B25, #84)"
```

---

## Post-PR steps (controller)

Push; PR `Closes #84.` (single PR: spec + plan + code, squash-merge material); Copilot round + watcher; LOGBOOK as last branch commit; after merge: suggest `v0.2.0`.
