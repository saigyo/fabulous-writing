# Provider-Aligned Routing (B24, #81) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The setup wizard generates a provider-appropriate `routing.languages` table into the config it already owns, so a fresh single-provider install has working LLM tiers for every language out of the box.

**Architecture:** One component changes: `backend/app/setup_wizard.py`. A pure `build_routing_table()` produces the full 7-language × 4-tier table (per-provider commercial model columns; Ollama strong+fast split); the wizard writes it into the generated `config.yaml`. The Ollama flow upgrades from free-text model entry to a picker over the `/api/tags` list, with the old free-text prompt as the unreachable-Ollama fallback. Profiles, DB, routing API, frontend: untouched.

**Tech Stack:** Python 3.13, httpx, PyYAML, pytest with injected IO (no network in tests), Docker via colima for the e2e.

**Spec:** `docs/superpowers/specs/2026-08-02-provider-routing-design.md` — binding for tier mappings, flow, and copy.

## Global Constraints

- Backend gates before every commit: from `backend/`, `uv run pytest -q` green with **zero warnings**.
- Tests: `tmp_path` only; never the live DB (`backend/data/fabulous.db`); never call `create_app()` without explicit `Settings`; NO network — the tag-list fetch is injected in every test.
- Never touch host ports **5173/8000**; scratch stacks use **8001** with `fwscratch`-prefixed names only, cleaned up afterwards.
- Secrets never echoed or logged; when sourcing `backend/api-keys.sh` for live verification, never print values — variable NAMES only.
- `frontend/` untouched (`git status --short -- frontend/` empty at commit time).
- Transcribe the plan's code verbatim (Unicode included); mutation-verify every guard test.
- The tier tables' model IDs below are subject to Task 1's live verification — Task 2 uses the values Task 1 confirms (its report is the source of truth if a name moved).
- Every commit message ends with the two trailer lines (Co-Authored-By + Claude-Session) supplied verbatim in the dispatch prompt; messages follow `type(scope): summary (B24, #81)`.

## File structure

- `backend/app/setup_wizard.py` — `LANGUAGES`, `COMMERCIAL_TIER_MODELS`, `DEFAULT_LOCAL_MODEL`, `build_routing_table()`, `fetch_ollama_models()` (replaces `check_ollama`), reworked Ollama prompt flow, routing emission in `run_wizard` (Task 2)
- `backend/tests/test_setup_wizard.py` — new `TestRoutingTable` + `TestOllamaSelection` classes; existing Ollama-path tests updated to the new injectable (Task 2)
- `docs/model-recommendations.md`, `docs/backend-architecture.md` — pointer/paragraph updates (Task 3)

---

### Task 0: Branch

- [ ] **Step 1:**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
git checkout main && git pull && git checkout -b b24-provider-routing || { echo "branch setup failed"; exit 1; }
```

---

### Task 1: Verify the model IDs live

**Files:** none changed (evidence task; report only — unless a verified name differs from the spec, in which case update the spec's table in `docs/superpowers/specs/2026-08-02-provider-routing-design.md` and say so prominently).

**Interfaces:**
- Produces: the confirmed model-ID set Task 2 bakes into `COMMERCIAL_TIER_MODELS`. Report is authoritative.

- [ ] **Step 1: Determine which provider keys exist locally**

```bash
grep -o '^export [A-Z_]*' /Users/markus/IdeaProjects/fabulous-writing/backend/api-keys.sh
```

Never print the values. All three keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`) are expected to be present — verify all nine IDs LIVE; the docs fallback below is only for a key that turns out missing or invalid.

- [ ] **Step 2: Verify per provider**

For each provider WITH a key (source the file in a subshell so nothing persists):

```bash
# Anthropic (expect claude-opus-5, claude-sonnet-5, claude-haiku-4-5 present):
(source backend/api-keys.sh && curl -s https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | \
  python3 -c "import json,sys; print([m['id'] for m in json.load(sys.stdin)['data']])")
# OpenAI (expect gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna):
(source backend/api-keys.sh && curl -s https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" | \
  python3 -c "import json,sys; print(sorted(m['id'] for m in json.load(sys.stdin)['data'] if 'gpt-5' in m['id']))")
# Mistral (expect mistral-medium-latest, mistral-large-latest, mistral-small-latest):
(source backend/api-keys.sh && curl -s https://api.mistral.ai/v1/models \
  -H "Authorization: Bearer $MISTRAL_API_KEY" | \
  python3 -c "import json,sys; print(sorted(m['id'] for m in json.load(sys.stdin)['data']))")
```

For each provider WITHOUT a key, verify against official documentation via WebFetch/WebSearch (docs.anthropic.com, developers.openai.com/api/docs/models, docs.mistral.ai) and record the URL + the relevant quoted line.

- [ ] **Step 3: Report**

Write the verified table (all nine IDs with evidence: endpoint output or doc URL per ID) to the report file given in your dispatch. If any spec ID is wrong, correct the spec's table and flag it in your return message. Also state explicitly whether `claude-opus-4-8` (the repo's multi-provider default table's quality pick) is still live alongside `claude-opus-5` — the wizard's divergence from `_default_routing_languages` is deliberate (newer lineup for fresh single-provider installs; the multi-provider default stays as-is), and the report should record that both IDs resolve so nobody reads the divergence as an oversight.

---

### Task 2: Wizard — routing table generation and Ollama model picker

**Files:**
- Modify: `backend/app/setup_wizard.py` (docstring; constants after line 52; `check_ollama` at lines 78-93 replaced; new helpers; `run_wizard` Ollama branch lines 239-264 and config generation lines 286-291)
- Test: `backend/tests/test_setup_wizard.py` (existing Ollama tests updated; new classes appended)

**Interfaces:**
- Consumes: Task 1's confirmed model IDs (substitute below if the report differs).
- Produces: `build_routing_table(provider: str, *, strong: str | None = None, fast: str | None = None) -> dict[str, dict[str, dict[str, str]]]`; `fetch_ollama_models(base_url: str) -> tuple[list[str] | None, str]`; `run_wizard` signature change: keyword `probe: ProbeFn` becomes `fetch_models: FetchFn` (`FetchFn = Callable[[str], tuple[list[str] | None, str]]`). Task 3's e2e relies on the generated config shape.

- [ ] **Step 1: Update the existing Ollama-path tests to the new injectable**

In `backend/tests/test_setup_wizard.py`, replace the helper `probe_ok` (near the top) and every test that passes `probe=` — the wizard now takes an injected tag-list fetch instead of a (url, model) probe. Replace:

```python
def probe_ok(base_url: str, model: str) -> tuple[bool, str]:
    return True, "ok"
```

with:

```python
def fetch_fail(base_url: str) -> tuple[list[str] | None, str]:
    return None, "connection refused"


def fetch_models_list(names: list[str]):
    def fetch(base_url: str) -> tuple[list[str] | None, str]:
        return list(names), "ok"

    return fetch
```

Then apply these mechanical updates (the flow they exercise — free-text single model — is now the *fallback* path, reached when the fetch fails):

- `run_first(...)`: parameter `probe=probe_ok` becomes `fetch=fetch_fail`, and the `run_wizard(...)` call inside passes `fetch_models=fetch`. Call sites of `run_first` that passed `probe=...` pass `fetch=...` (NOT `fetch_models=` — that keyword exists only on `run_wizard` itself).
- `TestFirstRun.test_ollama_setup_has_no_key_and_probes` → rename to `test_ollama_fallback_setup_has_no_key`; its custom `probe` closure becomes a fetch closure recording `base_url` only:

```python
    def test_ollama_fallback_setup_has_no_key(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        seen = {}

        def fetch(base_url):
            seen["base_url"] = base_url
            return None, "connection refused"

        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["admin@example.com", "4", "", "llama3.1"]),
            getpass_fn=scripted(["s3cret-password!"]),
            fetch_models=fetch,
        )
        assert rc == 0
        env = parse_env_file(config_dir / "fabulous.env")
        assert not any(k.endswith("_API_KEY") for k in env)
        assert seen["base_url"] == "http://host.docker.internal:11434"
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "default_provider: ollama" in config
        assert "ollama_model: llama3.1" in config
        import yaml as yaml_module

        data = yaml_module.safe_load(config)
        # fetch failed -> the single free-text model maps to ALL four tiers
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "llama3.1"
        assert data["routing"]["languages"]["en"]["cheap"]["model"] == "llama3.1"
```

- `TestFirstRun.test_failed_probe_warns_but_completes` → keeps its shape; it calls `run_first`, so `probe=lambda b, m: (False, "connection refused")` becomes `fetch=fetch_fail`, and the asserted output text stays `"connection refused"`.
- `TestReRun.first_run` (ollama first run) → calls `run_first`: `fetch=fetch_fail` (fallback path, same scripted answers).
- `TestReRun.test_keep_everything_preserves_secret`, `test_rotate_secret_changes_it`, `test_backup_written_on_rerun` → direct `run_wizard` calls: `probe=probe_ok` → `fetch_models=fetch_fail`; their scripted inputs are unchanged (the fallback path has the same prompt count as before).
- All other `probe=probe_ok` occurrences on direct `run_wizard` calls → `fetch_models=fetch_fail`: `test_provider_switch_removes_stale_key`, `test_switch_away_from_ollama_drops_ollama_config`, `test_env_files_are_owner_readable_only`, and `TestValidation.test_trailing_space_password_survives_rerun` — the ONLY `probe=` in that class; its other four tests use `run_first`'s default and need no change. Commercial-provider paths never call the fetch.

- [ ] **Step 2: Append the new failing tests**

Append to `backend/tests/test_setup_wizard.py`:

```python
class TestRoutingTable:
    ALL_LANGUAGES = ("en", "de", "fr", "es", "it", "ja", "zh")

    def test_claude_table_full_equality(self):
        from app.setup_wizard import build_routing_table

        per_language = {
            "quality": {"provider": "claude", "model": "claude-opus-5"},
            "balanced": {"provider": "claude", "model": "claude-sonnet-5"},
            "cheap": {"provider": "claude", "model": "claude-haiku-4-5"},
            "local": {"provider": "ollama", "model": "llama3.1"},
        }
        expected = {lang: per_language for lang in self.ALL_LANGUAGES}
        assert build_routing_table("claude") == expected

    def test_openai_table_full_equality(self):
        from app.setup_wizard import build_routing_table

        per_language = {
            "quality": {"provider": "openai", "model": "gpt-5.6-sol"},
            "balanced": {"provider": "openai", "model": "gpt-5.6-terra"},
            "cheap": {"provider": "openai", "model": "gpt-5.6-luna"},
            "local": {"provider": "ollama", "model": "llama3.1"},
        }
        assert build_routing_table("openai") == {
            lang: per_language for lang in self.ALL_LANGUAGES
        }

    def test_mistral_table_full_equality(self):
        from app.setup_wizard import build_routing_table

        # Deliberate: Mistral's Medium 3.5 outranks Large 3 — quality maps
        # to medium. See the spec's research notes.
        per_language = {
            "quality": {"provider": "mistral", "model": "mistral-medium-latest"},
            "balanced": {"provider": "mistral", "model": "mistral-large-latest"},
            "cheap": {"provider": "mistral", "model": "mistral-small-latest"},
            "local": {"provider": "ollama", "model": "llama3.1"},
        }
        assert build_routing_table("mistral") == {
            lang: per_language for lang in self.ALL_LANGUAGES
        }

    def test_ollama_strong_fast_split(self):
        from app.setup_wizard import build_routing_table

        table = build_routing_table("ollama", strong="qwen3:32b", fast="gemma4:12b")
        for lang in self.ALL_LANGUAGES:
            assert table[lang]["quality"] == {"provider": "ollama", "model": "qwen3:32b"}
            assert table[lang]["balanced"] == {"provider": "ollama", "model": "qwen3:32b"}
            assert table[lang]["cheap"] == {"provider": "ollama", "model": "gemma4:12b"}
            assert table[lang]["local"] == {"provider": "ollama", "model": "gemma4:12b"}

    def test_languages_get_independent_dicts(self):
        from app.setup_wizard import build_routing_table

        table = build_routing_table("claude")
        table["en"]["quality"]["model"] = "mutated"
        assert table["de"]["quality"]["model"] == "claude-opus-5"

    def test_local_default_matches_settings_default(self):
        from app.core.config import ProviderSettings
        from app.setup_wizard import DEFAULT_LOCAL_MODEL

        assert DEFAULT_LOCAL_MODEL == ProviderSettings().ollama_model

    def test_generated_config_validates_for_all_providers(self, tmp_path, template):
        import yaml as yaml_module

        from app.core.config import RoutingEntry, Settings
        from app.setup_wizard import COMMERCIAL_TIER_MODELS

        for provider, answers, secrets_answers, fetch in (
            ("claude", ["admin@example.com", "1"], ["s3cret-password!", "sk-ant-abc123"], fetch_fail),
            ("openai", ["admin@example.com", "2"], ["s3cret-password!", "sk-abc123"], fetch_fail),
            ("mistral", ["admin@example.com", "3"], ["s3cret-password!", "a" * 24], fetch_fail),
            ("ollama", ["admin@example.com", "4", "", "1", ""], ["s3cret-password!"], fetch_models_list(["llama3.1"])),
        ):
            config_dir = tmp_path / f"config-{provider}"
            config_dir.mkdir()
            rc = run_wizard(
                config_dir,
                template,
                input_fn=scripted(answers),
                getpass_fn=scripted(secrets_answers),
                fetch_models=fetch,
            )
            assert rc == 0
            data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
            settings = Settings.model_validate(data)
            langs = settings.routing.languages
            assert set(langs) == set(TestRoutingTable.ALL_LANGUAGES)
            for lang in TestRoutingTable.ALL_LANGUAGES:
                assert set(langs[lang]) == {"quality", "balanced", "cheap", "local"}
            # zh specifically: its BUILT-IN default is deepseek, and
            # RoutingSettings overlays defaults for unmentioned languages —
            # so this fails loudly if the wizard's table was absent/partial
            # and the overlay supplied the entry.
            if provider == "ollama":
                assert langs["zh"]["quality"] == RoutingEntry(
                    provider="ollama", model="llama3.1"
                )
            else:
                assert langs["zh"]["quality"] == RoutingEntry(
                    provider=provider,
                    model=COMMERCIAL_TIER_MODELS[provider]["quality"],
                )
                assert langs["zh"]["local"].provider == "ollama"

    def test_menu_and_tier_tables_stay_linked(self):
        from app.setup_wizard import COMMERCIAL_TIER_MODELS, PROVIDER_MENU

        assert set(COMMERCIAL_TIER_MODELS) | {"ollama"} == set(PROVIDER_MENU)

    def test_ollama_table_requires_both_models(self):
        from app.setup_wizard import build_routing_table

        with pytest.raises(ValueError):
            build_routing_table("ollama")

    def test_mistral_config_carries_mapping_comment(self, tmp_path, template):
        import yaml as yaml_module

        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["admin@example.com", "3"]),
            getpass_fn=scripted(["s3cret-password!", "a" * 24]),
            fetch_models=fetch_fail,
        )
        text = (config_dir / "config.yaml").read_text(encoding="utf-8")
        # Full three-line header, byte-for-byte — pins the em dash and the
        # complete wording, not just an ASCII prefix.
        assert text.startswith(
            "# Mistral's naming is inverted vs capability: Medium 3.5 is the\n"
            "# strongest general model, Large 3 the fast one — quality =>\n"
            "# mistral-medium-latest is deliberate (B24, #81).\n"
        )
        assert yaml_module.safe_load(text)["providers"]["default_provider"] == "mistral"

    def test_non_mistral_config_has_no_mapping_comment(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["admin@example.com", "1"]),
            getpass_fn=scripted(["s3cret-password!", "sk-ant-abc123"]),
            fetch_models=fetch_fail,
        )
        text = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert not text.startswith("#")

    def test_commercial_path_never_fetches(self, tmp_path, template):
        def exploding_fetch(base_url):
            raise AssertionError("fetch_models must not be called for commercial providers")

        config_dir = tmp_path / "config"
        config_dir.mkdir()
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["admin@example.com", "1"]),
            getpass_fn=scripted(["s3cret-password!", "sk-ant-abc123"]),
            fetch_models=exploding_fetch,
        )
        assert rc == 0


class TestOllamaSelection:
    def run_ollama(self, tmp_path, template, answers, names):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(answers),
            getpass_fn=scripted(["s3cret-password!"]),
            fetch_models=fetch_models_list(names),
        )
        assert rc == 0
        return config_dir

    def test_strong_and_fast_by_number(self, tmp_path, template, capsys):
        # email, provider 4, URL (default), strong "1", fast "2"
        config_dir = self.run_ollama(
            tmp_path, template,
            ["admin@example.com", "4", "", "1", "2"],
            ["qwen3:32b", "gemma4:12b"],
        )
        out = capsys.readouterr().out
        assert "1. qwen3:32b" in out and "2. gemma4:12b" in out
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "ollama_model: qwen3:32b" in config
        import yaml as yaml_module

        data = yaml_module.safe_load(config)
        assert data["routing"]["languages"]["de"]["quality"]["model"] == "qwen3:32b"
        assert data["routing"]["languages"]["de"]["cheap"]["model"] == "gemma4:12b"

    def test_fast_defaults_to_strong(self, tmp_path, template):
        # Strong is deliberately picked as "2" (NOT names[0]) so this test
        # distinguishes "fast defaults to strong" from "fast defaults to
        # the first list entry".
        config_dir = self.run_ollama(
            tmp_path, template,
            ["admin@example.com", "4", "", "2", ""],
            ["qwen3:32b", "gemma4:12b"],
        )
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "gemma4:12b"
        assert data["routing"]["languages"]["en"]["cheap"]["model"] == "gemma4:12b"

    def test_ambiguous_basename_reprompts(self, tmp_path, template):
        config_dir = self.run_ollama(
            tmp_path, template,
            # "qwen3" matches two tags -> must re-prompt, then "2" resolves
            ["admin@example.com", "4", "", "qwen3", "2", "1"],
            ["qwen3:32b", "qwen3:7b"],
        )
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "qwen3:7b"
        assert data["routing"]["languages"]["en"]["cheap"]["model"] == "qwen3:32b"

    def test_exact_tag_wins_over_basename_of_longer_tag(self, tmp_path, template):
        config_dir = self.run_ollama(
            tmp_path, template,
            # "llama3.1" is an exact tag AND the basename of llama3.1:70b —
            # the exact tag must win.
            ["admin@example.com", "4", "", "llama3.1", ""],
            ["llama3.1:70b", "llama3.1"],
        )
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "llama3.1"

    def test_stale_fast_default_falls_back_to_strong(self, tmp_path, template):
        # First run picks strong qwen3:32b / fast gemma4:12b; the user then
        # removes gemma4:12b from Ollama. On re-run the fast prompt must
        # default to strong ("Enter = strong"), not to the vanished model.
        config_dir = self.run_ollama(
            tmp_path, template,
            ["admin@example.com", "4", "", "1", "2"],
            ["qwen3:32b", "gemma4:12b"],
        )
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "", "", "", "n"]),
            getpass_fn=scripted([""]),
            fetch_models=fetch_models_list(["qwen3:32b"]),
        )
        assert rc == 0
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["en"]["cheap"]["model"] == "qwen3:32b"

    def test_pre_b24_basename_default_resolves_to_canonical_tag(self, tmp_path, template):
        # Upgrade path: a config written BEFORE B24 (no routing key, and
        # ollama_model stored as a basename — the old probe accepted
        # "llama3.1" for the tag "llama3.1:latest"). On the first re-run,
        # Enter at the strong prompt must keep the current model by
        # resolving the basename to its canonical installed tag.
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        (config_dir / "fabulous.env").write_text(
            "FW_AUTH_SECRET=upgrade-path-secret-0123456789abcdefghij\n"
            "FW_ADMIN_EMAIL=admin@example.com\n"
            "FW_ADMIN_PASSWORD=s3cret-password!\n",
            encoding="utf-8",
        )
        (config_dir / "config.yaml").write_text(
            TEMPLATE + "  ollama_base_url: http://host.docker.internal:11434\n"
            "  ollama_model: llama3.1\n",
            encoding="utf-8",
        )
        # email keep, provider keep (ollama), URL keep, strong Enter
        # (= resolved default), fast Enter (= strong), rotate n
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "", "", "", "n"]),
            getpass_fn=scripted([""]),
            fetch_models=fetch_models_list(["llama3.1:latest", "qwen3:32b"]),
        )
        assert rc == 0
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "llama3.1:latest"
        assert data["providers"]["ollama_model"] == "llama3.1:latest"

    def test_switch_to_ollama_fallback_never_offers_commercial_default(self, tmp_path, template):
        # The dangerous half of the prefill guard: on the fetch-FAIL path,
        # _ask would silently ACCEPT a leftover commercial default on Enter.
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["admin@example.com", "1"]),
            getpass_fn=scripted(["s3cret-password!", "sk-ant-abc123"]),
            fetch_models=fetch_fail,
        )
        prompts: list[str] = []
        answers = iter(["", "4", "", "llama3.1", "n"])

        def recording_input(prompt: str = "") -> str:
            prompts.append(prompt)
            return next(answers)

        rc = run_wizard(
            config_dir,
            template,
            input_fn=recording_input,
            getpass_fn=scripted([""]),
            fetch_models=fetch_fail,
        )
        assert rc == 0
        assert not any("claude-opus-5" in p for p in prompts)
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "llama3.1"

    def test_switch_to_ollama_never_offers_commercial_default(self, tmp_path, template):
        # claude first run, then switch to ollama with a model list: the
        # strong prompt must NOT default to claude-opus-5 (an unusable
        # default would loop forever on Enter). Pressing Enter with no
        # usable default re-prompts; "1" then resolves.
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["admin@example.com", "1"]),
            getpass_fn=scripted(["s3cret-password!", "sk-ant-abc123"]),
            fetch_models=fetch_fail,
        )
        prompts: list[str] = []
        # email keep, provider 4, URL keep, strong: Enter (no usable
        # default -> re-prompt), then "1"; fast: Enter (= strong); rotate n
        answers = iter(["", "4", "", "", "1", "", "n"])

        def recording_input(prompt: str = "") -> str:
            prompts.append(prompt)
            return next(answers)

        rc = run_wizard(
            config_dir,
            template,
            input_fn=recording_input,
            getpass_fn=scripted([""]),
            fetch_models=fetch_models_list(["qwen3:32b"]),
        )
        assert rc == 0
        assert not any("claude-opus-5" in p for p in prompts)
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "qwen3:32b"

    def test_model_by_name_and_invalid_reprompts(self, tmp_path, template):
        config_dir = self.run_ollama(
            tmp_path, template,
            ["admin@example.com", "4", "", "nope-model", "gemma4:12b", "1"],
            ["qwen3:32b", "gemma4:12b"],
        )
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "gemma4:12b"
        assert data["routing"]["languages"]["en"]["cheap"]["model"] == "qwen3:32b"

    def test_empty_tag_list_falls_back_to_free_text(self, tmp_path, template, capsys):
        config_dir = self.run_ollama(
            tmp_path, template,
            ["admin@example.com", "4", "", "llama3.1"],
            [],
        )
        assert "no models installed" in capsys.readouterr().out
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["ja"]["local"]["model"] == "llama3.1"

    def test_commercial_switch_rewrites_table(self, tmp_path, template):
        config_dir = self.run_ollama(
            tmp_path, template,
            ["admin@example.com", "4", "", "1", "2"],
            ["qwen3:32b", "gemma4:12b"],
        )
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "3", "n"]),
            getpass_fn=scripted(["", "a" * 24]),
            fetch_models=fetch_fail,
        )
        assert rc == 0
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["fr"]["quality"]["model"] == "mistral-medium-latest"
        text = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "qwen3:32b" not in text

    def test_rerun_prefills_strong_and_fast(self, tmp_path, template):
        config_dir = self.run_ollama(
            tmp_path, template,
            ["admin@example.com", "4", "", "1", "2"],
            ["qwen3:32b", "gemma4:12b"],
        )
        # Prompts are passed to input_fn (never printed), so record them
        # to assert the pre-filled defaults appear in the prompt text.
        prompts: list[str] = []
        answers = iter(["", "", "", "", "", "n"])

        def recording_input(prompt: str = "") -> str:
            prompts.append(prompt)
            return next(answers)

        # re-run keeping everything: email, provider, URL, strong, fast, rotate
        rc = run_wizard(
            config_dir,
            template,
            input_fn=recording_input,
            getpass_fn=scripted([""]),
            fetch_models=fetch_models_list(["qwen3:32b", "gemma4:12b"]),
        )
        assert rc == 0
        assert any(p.startswith("Strong model") and "[qwen3:32b]" in p for p in prompts)
        assert any(p.startswith("Fast model") and "[gemma4:12b]" in p for p in prompts)
        import yaml as yaml_module

        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "qwen3:32b"
        assert data["routing"]["languages"]["en"]["cheap"]["model"] == "gemma4:12b"
```

- [ ] **Step 2b: Extend the real-template contract test**

In `TestImageContract.test_real_template_validates_for_every_provider` (currently lines 350-372), inside its per-provider loop, add before the `Settings.model_validate(config_data)` call:

```python
            from app.setup_wizard import build_routing_table

            config_data["routing"] = {
                "languages": build_routing_table(
                    provider,
                    strong="llama3.1" if provider == "ollama" else None,
                    fast="llama3.1" if provider == "ollama" else None,
                )
            }
```

(the import can live at the top of the test instead; match the file's style). This pins the SHIPPED `docker/config.container.yaml` + generated routing combination against `Settings(extra="forbid")` — template drift must fail in tests, not at container start.

- [ ] **Step 3: Run the test file, verify the new tests fail correctly**

Run: `uv run pytest tests/test_setup_wizard.py -v`
Expected: the updated existing tests error with `TypeError: run_wizard() got an unexpected keyword argument 'fetch_models'` and the new classes fail on the missing `build_routing_table` import — feature missing, not typos.

- [ ] **Step 4: Implement**

In `backend/app/setup_wizard.py`:

**(a)** Docstring: after the sentence ending "leave a stale key behind." insert: `The generated config also carries a full per-language LLM routing table for the chosen provider (B24, #81), so every quality tier works out of the box.`

**(b)** After `MIN_MISTRAL_KEY_LENGTH = 20` (line 52), add:

```python
# Single-provider routing tables (B24, #81). Same models for all
# languages — language-specialized routing is a multi-provider luxury.
# IDs verified against provider model endpoints/docs 2026-08-02 (see the
# spec's research notes). Mistral's naming is inverted vs capability:
# Medium 3.5 is currently their strongest general model and Large 3 the
# fast multimodal — quality deliberately maps to medium.
LANGUAGES = ("en", "de", "fr", "es", "it", "ja", "zh")
COMMERCIAL_TIER_MODELS = {
    "claude": {
        "quality": "claude-opus-5",
        "balanced": "claude-sonnet-5",
        "cheap": "claude-haiku-4-5",
    },
    "openai": {
        "quality": "gpt-5.6-sol",
        "balanced": "gpt-5.6-terra",
        "cheap": "gpt-5.6-luna",
    },
    "mistral": {
        "quality": "mistral-medium-latest",
        "balanced": "mistral-large-latest",
        "cheap": "mistral-small-latest",
    },
}
# Mirrors ProviderSettings.ollama_model's default (pinned by a test): the
# local tier under a commercial provider resolves against that default.
DEFAULT_LOCAL_MODEL = "llama3.1"
```

(If Task 1's report corrected any ID, use the corrected value here AND in Step 2's test expectations.)

**(c)** Replace the `ProbeFn` type alias (line 55) with:

```python
FetchFn = Callable[[str], tuple[list[str] | None, str]]
```

**(d)** Replace `check_ollama` (lines 78-93) with:

```python
def fetch_ollama_models(base_url: str) -> tuple[list[str] | None, str]:
    """Fetch installed model names from /api/tags — the app's own vantage.

    Failures are warnings by contract, so the parse of the payload lives
    inside the same exception boundary as the request: (None, reason)
    rather than an exception, whatever went wrong.
    """
    try:
        response = httpx.get(f"{base_url.rstrip('/')}/api/tags", timeout=5.0)
        response.raise_for_status()
        names = [m.get("name", "") for m in response.json().get("models", [])]
    except Exception as exc:  # noqa: BLE001 - any failure is the same advice
        return None, str(exc)
    return [n for n in names if n], "ok"
```

**(e)** After `_ask_api_key`, add the model picker and table builder:

```python
def _ask_model_choice(
    input_fn: InputFn, names: list[str], prompt: str, default: str | None
) -> str:
    # A default the picker would reject (e.g. a commercial model ID left
    # over from a provider switch) must never be offered: on Enter it
    # would re-prompt with the same rejected default forever. But first,
    # resolve a unique basename to its canonical tag — pre-B24 configs
    # legitimately store e.g. "llama3.1" where the installed tag is
    # "llama3.1:latest" (the old probe accepted basename matches), and
    # the re-run contract says Enter keeps the current model.
    if default is not None and default not in names:
        matches = [n for n in names if n.split(":")[0] == default]
        default = matches[0] if len(matches) == 1 else None
    while True:
        raw = _ask(input_fn, prompt, default)
        if raw.isdigit() and 1 <= int(raw) <= len(names):
            return names[int(raw) - 1]
        if raw in names:  # an exact tag always wins over a basename match
            return raw
        matches = [n for n in names if n.split(":")[0] == raw]
        if len(matches) == 1:
            return matches[0]
        if matches:
            print(f"'{raw}' is ambiguous: {', '.join(matches)} — pick a number.")
            continue
        print(f"Pick 1-{len(names)} or one of the listed names.")


def build_routing_table(
    provider: str,
    *,
    strong: str | None = None,
    fast: str | None = None,
) -> dict[str, dict[str, dict[str, str]]]:
    """Full routing.languages table for a single-provider instance.

    Commercial providers: quality/balanced/cheap from the verified tier
    column, local stays honestly on Ollama's defaults (shows unavailable
    until the user runs Ollama). Ollama: quality+balanced -> strong,
    cheap+local -> fast.
    """
    if provider == "ollama":
        if not strong or not fast:
            raise ValueError("ollama routing needs strong and fast models")
        tier_entries = {
            "quality": ("ollama", strong),
            "balanced": ("ollama", strong),
            "cheap": ("ollama", fast),
            "local": ("ollama", fast),
        }
    else:
        models = COMMERCIAL_TIER_MODELS[provider]
        tier_entries = {
            "quality": (provider, models["quality"]),
            "balanced": (provider, models["balanced"]),
            "cheap": (provider, models["cheap"]),
            "local": ("ollama", DEFAULT_LOCAL_MODEL),
        }
    return {
        lang: {
            tier: {"provider": entry_provider, "model": entry_model}
            for tier, (entry_provider, entry_model) in tier_entries.items()
        }
        for lang in LANGUAGES
    }
```

(The inner comprehension builds fresh dicts per language — `yaml.safe_dump` would otherwise emit anchors/aliases for shared objects, and `test_languages_get_independent_dicts` pins it.)

**(f)** In `run_wizard`: change the signature keyword `probe: ProbeFn = check_ollama` to `fetch_models: FetchFn = fetch_ollama_models`. Replace the Ollama branch INCLUDING the `else:` clause (currently lines 239-267 — the replacement below ends with its own `else:`/`api_key` block; leaving the original in place would duplicate it) with:

```python
    strong_model = None
    fast_model = None
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
        # Prefill only from entries that are actually Ollama entries — after
        # a commercial run the table holds e.g. claude-opus-5, which must
        # never be offered as an Ollama default (the picker would reject it
        # on every Enter, and the fallback path would silently accept it).
        existing_en = existing_config.get("routing", {}).get("languages", {}).get("en", {})

        def _existing_ollama_model(tier: str) -> str | None:
            entry = existing_en.get(tier) or {}
            return entry.get("model") if entry.get("provider") == "ollama" else None

        default_strong = _existing_ollama_model("quality") or existing_providers.get(
            "ollama_model"
        )
        default_fast = _existing_ollama_model("cheap")
        names, detail = fetch_models(ollama_url)
        if names:
            print("Installed Ollama models:")
            for index, name in enumerate(names, start=1):
                print(f"  {index}. {name}")
            strong_model = _ask_model_choice(
                input_fn, names, "Strong model (quality/balanced tiers)", default_strong
            )
            fast_model = _ask_model_choice(
                input_fn,
                names,
                "Fast model (cheap/local tiers)",
                # A stale fast default (model since removed from Ollama)
                # must fall back to strong — the picker would drop it and
                # Enter would stop meaning "same as strong".
                default_fast if default_fast in names else strong_model,
            )
            print("Ollama reachable, models selected.")
        else:
            if names == []:
                print("Ollama is reachable but has no models installed — pull one")
                print("  first (ollama pull <model>); enter the model to use later.")
            else:
                print(f"WARNING: Ollama check failed: {detail}")
                print(
                    "  The config is written anyway. On Linux, try"
                    " --add-host=host.docker.internal:host-gateway on the run"
                    " command, or use the docker0 gateway IP. On macOS/Windows"
                    " host.docker.internal works out of the box."
                )
            strong_model = _ask(input_fn, "Ollama model", default_strong)
            fast_model = strong_model
        ollama_model = strong_model
    else:
        env_key = BUILTIN_ENV_KEYS[provider]
        api_key = _ask_api_key(getpass_fn, provider, existing_env.get(env_key))
```

(Keep the surrounding `api_key = None` / `ollama_url = None` / `ollama_model = None` initializers above the branch.)

**(g)** In the config-generation block (after `providers_section["ollama_model"] = ollama_model`), add:

```python
    config_data["routing"] = {
        "languages": build_routing_table(
            provider, strong=strong_model, fast=fast_model
        )
    }
```

and replace the `config_path.write_text(...)` call with a header-aware
write (the spec requires the Mistral-mapping rationale IN the generated
file, and `yaml.safe_dump` cannot emit comments; the file is regenerated
whole each run, so the header self-maintains):

```python
    header = ""
    if provider == "mistral":
        header = (
            "# Mistral's naming is inverted vs capability: Medium 3.5 is the\n"
            "# strongest general model, Large 3 the fast one — quality =>\n"
            "# mistral-medium-latest is deliberate (B24, #81).\n"
        )
    config_path.write_text(
        header + yaml.safe_dump(config_data, sort_keys=False), encoding="utf-8"
    )
```

- [ ] **Step 5: Run the wizard tests, verify all pass**

Run: `uv run pytest tests/test_setup_wizard.py -v`
Expected: all PASS (updated + new). A `StopIteration` means a prompt-count mismatch — fix the flow, not the tests.

- [ ] **Step 6: Mutation-verify**

1. In `run_wizard`, replace the routing assignment with a merge that keeps old entries: `config_data["routing"] = existing_config.get("routing") or {"languages": build_routing_table(provider, strong=strong_model, fast=fast_model)}` → the re-run keeps the Ollama table, so `test_commercial_switch_rewrites_table` FAILS (`fr.quality.model` stays `qwen3:32b`). Restore.
2. In `build_routing_table`, share one per-language dict across languages (hoist the inner dict out of the comprehension) → `test_languages_get_independent_dicts` FAILS. Restore.
3. Swap Mistral quality/balanced (large on quality) → `test_mistral_table_full_equality` FAILS. Restore.
4. Change `DEFAULT_LOCAL_MODEL` to `"llama3"` → `test_local_default_matches_settings_default` FAILS. Restore.
5. In `_existing_ollama_model`, drop the `entry.get("provider") == "ollama"` check (return `entry.get("model")` unconditionally) → `test_switch_to_ollama_never_offers_commercial_default` and `test_switch_to_ollama_fallback_never_offers_commercial_default` FAIL. On the fallback twin the failure is the `[claude-opus-5]` prompt assertion; on the picker test it may surface as a `StopIteration` — that IS the failure here (the leftover commercial default gets rejected and consumes an extra prompt), not a broken script. Restore.

- [ ] **Step 7: Full backend suite, zero warnings**

Run: `uv run pytest -q`

- [ ] **Step 8: Commit**

```bash
git add backend/app/setup_wizard.py backend/tests/test_setup_wizard.py
git commit -m "feat(backend): wizard generates provider-aligned routing table, Ollama model picker (B24, #81)"
```

---

### Task 3: E2e against a built image + docs

**Files:**
- Modify: `docs/model-recommendations.md` (pointer note), `docs/backend-architecture.md` (wizard paragraph)

**Interfaces:**
- Consumes: Task 2's generated-config shape; the B17 image tooling (`Dockerfile`, scratch recipe).

- [ ] **Step 1: Build the image with the new wizard**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
docker build -t fwscratch:b24 --build-arg APP_VERSION=0.0.0-b24 . 2>&1 | tail -3
```

Only the app layer rebuilds (B17's cached layers carry the rest) — expect a short build. If the build runs long in one Bash call, re-run the same command (BuildKit resumes); never conclude failure from a timed-out call without checking `docker images`.

- [ ] **Step 2: Run the wizard scripted (Anthropic path) and serve**

getpass falls back to stdin without a TTY; the prompt order is email, password (getpass), provider choice, API key (getpass):

```bash
docker volume create fwscratch-config
printf 'e2e@example.com\ne2e-scratch-password\n1\nsk-ant-e2e-dummy-key\n' | \
  docker run --rm -i -v fwscratch-config:/config fwscratch:b24 setup
docker run --rm -v fwscratch-config:/config --entrypoint sh fwscratch:b24 -c \
  'grep -c "provider: claude" /config/config.yaml; grep -c "provider: ollama" /config/config.yaml'
# expect 22 "provider: claude" matches (21 tier entries + the
# default_provider line, which the substring also hits) and 7 ollama (local tier)
docker run -d --name fwscratch -p 8001:8000 -v fwscratch-config:/config fwscratch:b24
curl --retry 30 --retry-delay 2 --retry-connrefused -sf http://localhost:8001/api/health >/dev/null
```

(`curl --retry` instead of a `sleep` loop — foreground `sleep` is blocked in this harness.)

(No data volume needed — this instance is throwaway; the dummy key is fine because `/api/routing` only checks the env var's presence, no live call.)

- [ ] **Step 3: Assert the routing API**

```bash
TOKEN=$(curl -s -X POST http://localhost:8001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"e2e@example.com","password":"e2e-scratch-password"}' | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl -s http://localhost:8001/api/routing -H "Authorization: Bearer $TOKEN" | python3 -c '
import json, sys
data = json.load(sys.stdin)
langs = data["languages"]
assert set(langs) == {"en", "de", "fr", "es", "it", "ja", "zh"}, sorted(langs)
for lang, tiers in langs.items():
    for tier in ("quality", "balanced", "cheap"):
        entry = tiers[tier]
        assert entry["provider"] == "claude" and entry["available"], (lang, tier, entry)
    local = tiers["local"]
    assert local["provider"] == "ollama" and not local["available"], (lang, local)
    assert local["reason"] == "Ollama not running", local
print("routing table OK:", langs["de"]["quality"]["model"], "/", langs["de"]["cheap"]["model"])
'
```

Expected final line: `routing table OK: claude-opus-5 / claude-haiku-4-5`.

- [ ] **Step 4: Tear down (own scratch resources only)**

```bash
docker rm -f -v fwscratch; docker volume rm fwscratch-config; docker rmi fwscratch:b24
```

(`-v` matters: the Dockerfile declares `VOLUME /data`, so the run created an anonymous data volume that plain `rm -f` would leak.)

- [ ] **Step 5: Docs**

In `docs/model-recommendations.md`, add a short note directly under the top heading: the per-language multi-provider table remains the default for key-rich setups; wizard-configured single-provider instances get a generated single-provider routing table instead (`app/setup_wizard.py`, B24/#81), including the deliberate Mistral quality=medium mapping.

In `docs/backend-architecture.md`, extend the wizard paragraph in `## Container deployment (B17)`: the wizard also generates the full `routing.languages` table for the chosen provider (commercial tier columns / Ollama strong+fast from the `/api/tags` list), the local tier stays on Ollama defaults under commercial providers, and the table is regenerated whole on every run like the rest of the config. ALSO correct the injectables sentence in that same paragraph (it currently names `probe` and "a real Ollama probe"): the injectables are `input_fn`/`getpass_fn`/`fetch_models`, defaulting to `input`, `getpass.getpass`, and `fetch_ollama_models` (a `/api/tags` fetch); `check_ollama` no longer exists.

Optionally (same doc pass): `README.md` ~line 210 says "reachability probe" — "model-list fetch" is now the accurate term; a one-word touch-up is fine, no structural change.

- [ ] **Step 6: Gates and commit**

`git status --short -- frontend/ backend/` — backend must be empty too (docs-only task; the e2e changed nothing).

```bash
git add docs/model-recommendations.md docs/backend-architecture.md
git commit -m "docs(deploy): provider-aligned routing notes — wizard table, Mistral mapping rationale (B24, #81)"
```

---

## Post-PR steps (controller, not a dispatched task)

1. Push the branch, open the implementation PR with `Closes #81.`, request Copilot review, spawn the watcher (match `copilot-pull-request-reviewer[bot]`). The PR triggers `docker.yml` (backend/app path) — confirm build + licenses jobs pass.
2. After reviews settle: append the LOGBOOK entry as the LAST commit on the PR branch (run `date` first; reference the real PR numbers).
3. After the owner merges: sync main, delete the branch. Suggest cutting `v0.2.0` (first feature release after 0.1.0) — the wizard change is exactly what releases are for.
