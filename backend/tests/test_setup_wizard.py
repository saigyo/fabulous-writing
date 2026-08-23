"""Setup wizard: first run, re-run merging, provider switching."""

from pathlib import Path

import httpx
import pytest

from app.setup_wizard import fetch_ollama_models, parse_env_file, run_wizard

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


def fetch_fail(base_url: str) -> tuple[list[str] | None, str]:
    return None, "connection refused"


def fetch_models_list(names: list[str]):
    def fetch(base_url: str) -> tuple[list[str] | None, str]:
        return list(names), "ok"

    return fetch


def run_first(config_dir, template, answers, secrets_answers, fetch=fetch_fail):
    return run_wizard(
        config_dir,
        template,
        input_fn=scripted(answers),
        getpass_fn=scripted(secrets_answers),
        fetch_models=fetch,
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
        assert "ollama_base_url: http://host.docker.internal:11434" in config
        import yaml as yaml_module

        data = yaml_module.safe_load(config)
        # fetch failed -> the single free-text model maps to ALL four tiers
        assert data["routing"]["languages"]["en"]["quality"]["model"] == "llama3.1"
        assert data["routing"]["languages"]["en"]["cheap"]["model"] == "llama3.1"

    def test_failed_probe_warns_but_completes(self, tmp_path, template, capsys):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        rc = run_first(
            config_dir,
            template,
            answers=["admin@example.com", "4", "", "llama3.1"],
            secrets_answers=["s3cret-password!"],
            fetch=fetch_fail,
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
            fetch_models=fetch_fail,
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
            fetch_models=fetch_fail,
        )
        assert rc == 0
        env = parse_env_file(config_dir / "fabulous.env")
        assert env["MISTRAL_API_KEY"] == "a" * 24
        assert "ANTHROPIC_API_KEY" not in env
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        assert "default_provider: mistral" in config

    def test_switch_away_from_ollama_keeps_url_drops_model(self, tmp_path, template):
        config_dir = self.first_run(tmp_path, template)  # ollama first run
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "3", "n"]),
            getpass_fn=scripted(["", "a" * 24]),
            fetch_models=fetch_fail,
        )
        config = (config_dir / "config.yaml").read_text(encoding="utf-8")
        # B25 (#84): the base URL is deliberately KEPT on a switch away —
        # it is the local tier's pointer and the last known Ollama
        # location. Only the model selection is dropped.
        assert "ollama_base_url: http://host.docker.internal:11434" in config
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
            fetch_models=fetch_fail,
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
            fetch_models=fetch_fail,
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
            fetch_models=fetch_fail,
        )
        assert (config_dir / "fabulous.env.bak").read_text(encoding="utf-8") == original_env
        assert (config_dir / "config.yaml.bak").is_file()

    def test_rerun_preserves_embed_allowed_ancestors(self, tmp_path, template):
        # The wizard never prompts for embed.allowed_ancestors, and rebuilds
        # config.yaml fresh from the template (whose embed block starts
        # empty) on every run — without an explicit merge, a hand-configured
        # allowlist would be silently wiped on the next `setup` rerun.
        import yaml as yaml_module

        config_dir = self.first_run(tmp_path, template)  # ollama first run
        config_path = config_dir / "config.yaml"
        data = yaml_module.safe_load(config_path.read_text(encoding="utf-8"))
        data["embed"] = {"allowed_ancestors": ["https://host.example"]}
        config_path.write_text(yaml_module.safe_dump(data, sort_keys=False), encoding="utf-8")

        # Keep-everything re-run: email, provider, base URL, model, rotate n.
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "", "", "n"]),
            getpass_fn=scripted([""]),
            fetch_models=fetch_fail,
        )
        assert rc == 0
        data = yaml_module.safe_load(config_path.read_text(encoding="utf-8"))
        assert data["embed"]["allowed_ancestors"] == ["https://host.example"]

    # Finding 32: a bare, malformed `embed: nope` (a typo, or a hand-edit
    # gone wrong) must not crash the wizard with an AttributeError — it
    # falls through to the clean, preserved-default (template) path exactly
    # as if the key were absent.
    def test_rerun_with_non_mapping_embed_value_does_not_crash(self, tmp_path, template):
        import yaml as yaml_module

        config_dir = self.first_run(tmp_path, template)
        config_path = config_dir / "config.yaml"
        data = yaml_module.safe_load(config_path.read_text(encoding="utf-8"))
        data["embed"] = "nope"
        config_path.write_text(yaml_module.safe_dump(data, sort_keys=False), encoding="utf-8")

        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "", "", "n"]),
            getpass_fn=scripted([""]),
            fetch_models=fetch_fail,
        )

        assert rc == 0
        data = yaml_module.safe_load(config_path.read_text(encoding="utf-8"))
        # The test fixture template (unlike the real docker/
        # config.container.yaml) carries no embed key at all — the clean
        # path here is "no override, nothing crashed", not a specific
        # written value.
        assert data.get("embed", {}).get("allowed_ancestors", []) == []

    # Finding 33: preserve on `is not None`, not truthiness — an explicit
    # `allowed_ancestors: []` (an operator deliberately re-emptying the
    # allowlist) must round-trip through the rerun the same as any other
    # explicitly-set value.
    def test_rerun_preserves_explicit_empty_allowed_ancestors(self, tmp_path, template):
        import yaml as yaml_module

        config_dir = self.first_run(tmp_path, template)
        config_path = config_dir / "config.yaml"
        data = yaml_module.safe_load(config_path.read_text(encoding="utf-8"))
        data["embed"] = {"allowed_ancestors": []}
        config_path.write_text(yaml_module.safe_dump(data, sort_keys=False), encoding="utf-8")

        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "", "", "n"]),
            getpass_fn=scripted([""]),
            fetch_models=fetch_fail,
        )

        assert rc == 0
        data = yaml_module.safe_load(config_path.read_text(encoding="utf-8"))
        assert data["embed"]["allowed_ancestors"] == []

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

    def test_explicit_null_url_falls_back_to_default(self, tmp_path, template):
        import yaml as yaml_module

        config_dir = tmp_path / "config"
        config_dir.mkdir()
        (config_dir / "fabulous.env").write_text(
            "FW_AUTH_SECRET=null-url-secret-0123456789abcdefghijkl\n"
            "FW_ADMIN_EMAIL=admin@example.com\n"
            "FW_ADMIN_PASSWORD=s3cret-password!\n",
            encoding="utf-8",
        )
        (config_dir / "config.yaml").write_text(
            "providers:\n  default_provider: claude\n  ollama_base_url: null\n",
            encoding="utf-8",
        )
        rc = run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "n"]),
            getpass_fn=scripted(["", "sk-ant-abc123"]),
            fetch_models=fetch_fail,
        )
        assert rc == 0
        data = yaml_module.safe_load((config_dir / "config.yaml").read_text(encoding="utf-8"))
        assert data["providers"]["ollama_base_url"] == "http://host.docker.internal:11434"


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


    def test_over_bcrypt_limit_password_rejected(self, tmp_path, template):
        # seed_admin() enforces bcrypt's 72-byte cap at container startup;
        # the wizard must reject the same passwords, not defer the failure.
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        rc = run_first(
            config_dir,
            template,
            answers=["admin@example.com", "1"],
            secrets_answers=["x" * 80, "fits-in-bcrypt", "sk-ant-abc123"],
        )
        assert rc == 0
        assert parse_env_file(config_dir / "fabulous.env")["FW_ADMIN_PASSWORD"] == "fits-in-bcrypt"

    def test_trailing_space_password_survives_rerun(self, tmp_path, template):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        run_first(
            config_dir,
            template,
            answers=["admin@example.com", "1"],
            secrets_answers=["password-with-space ", "sk-ant-abc123"],
        )
        # keep-everything re-run: the stored value must round-trip untouched
        run_wizard(
            config_dir,
            template,
            input_fn=scripted(["", "", "n"]),
            getpass_fn=scripted(["", ""]),
            fetch_models=fetch_fail,
        )
        assert (
            parse_env_file(config_dir / "fabulous.env")["FW_ADMIN_PASSWORD"]
            == "password-with-space "
        )


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

    def test_languages_stay_linked_to_config(self):
        # If a language is added to config's _LANGUAGE_CODES without updating
        # the wizard, build_routing_table emits a 7-language table and
        # RoutingSettings' overlay silently fills the new language from the
        # stale multi-provider defaults — the exact bug B24 removes.
        from app.core.config import TIERS, _LANGUAGE_CODES
        from app.setup_wizard import LANGUAGES, build_routing_table

        assert set(LANGUAGES) == set(_LANGUAGE_CODES)
        table = build_routing_table("claude")
        assert set(table["en"]) == set(TIERS)

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


class TestImageContract:
    def test_default_paths_match_the_dockerfile_layout(self):
        # Task 4's Dockerfile copies the template to /app/config.container.yaml
        # and declares the /config volume; a silent rename there would break
        # `setup` at runtime only. Pin the contract.
        from app.setup_wizard import DEFAULT_CONFIG_DIR, DEFAULT_TEMPLATE

        assert DEFAULT_CONFIG_DIR == "/config"
        assert DEFAULT_TEMPLATE == "/app/config.container.yaml"

    def test_real_template_validates_for_every_provider(self):
        # Nothing else pins the real docker/config.container.yaml against
        # Settings(extra="forbid") — template drift would only explode at
        # container start. Load the actual repo file, apply the same merge
        # run_wizard performs for each built-in provider, and validate.
        import yaml

        from app.core.config import Settings

        template_path = Path(__file__).parents[2] / "docker" / "config.container.yaml"
        raw = template_path.read_text(encoding="utf-8")

        config_data = yaml.safe_load(raw) or {}
        Settings.model_validate(config_data)

        for provider in ("claude", "openai", "mistral", "ollama"):
            config_data = yaml.safe_load(raw) or {}
            providers_section = config_data.setdefault("providers", {})
            providers_section["default_provider"] = provider
            providers_section["ollama_base_url"] = "http://host.docker.internal:11434"
            if provider == "ollama":
                providers_section["ollama_model"] = "llama3.1"
            from app.setup_wizard import build_routing_table

            config_data["routing"] = {
                "languages": build_routing_table(
                    provider,
                    strong="llama3.1" if provider == "ollama" else None,
                    fast="llama3.1" if provider == "ollama" else None,
                )
            }
            Settings.model_validate(config_data)


class TestFetchOllamaModels:
    """Transport-level tests for the real httpx adapter (every picker test
    above injects fetch_models, so this is the only coverage of the
    function actually used at runtime). fetch_ollama_models calls the
    module-level httpx.get(...) directly rather than an injectable client,
    so it can't take a transport= like OllamaProvider in test_providers.py
    — the same handler/httpx.MockTransport pattern from there is reused by
    monkeypatching httpx.get to route through a mock-transport Client.
    """

    def _patch_get(self, monkeypatch, handler):
        def fake_get(url, *, timeout=None, **kwargs):
            with httpx.Client(transport=httpx.MockTransport(handler)) as client:
                return client.get(url, timeout=timeout)

        monkeypatch.setattr(httpx, "get", fake_get)

    def test_success_lists_and_filters_names(self, monkeypatch):
        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            return httpx.Response(
                200,
                json={
                    "models": [
                        {"name": "llama3.1:latest"},
                        {"name": "qwen3:32b"},
                        {"name": ""},
                        {},
                    ]
                },
            )

        self._patch_get(monkeypatch, handler)

        # Trailing slash on the base URL must not produce a double slash.
        names, detail = fetch_ollama_models("http://host:11434/")

        assert names == ["llama3.1:latest", "qwen3:32b"]
        assert detail == "ok"
        assert seen["url"] == "http://host:11434/api/tags"

    def test_http_error_returns_none_and_reason(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="boom")

        self._patch_get(monkeypatch, handler)

        names, detail = fetch_ollama_models("http://host:11434")

        assert names is None
        assert "500" in detail

    def test_malformed_list_payload_returns_none(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[{"name": "llama3.1"}])

        self._patch_get(monkeypatch, handler)

        names, detail = fetch_ollama_models("http://host:11434")

        assert names is None
        assert detail

    def test_non_json_body_returns_none(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="not json")

        self._patch_get(monkeypatch, handler)

        names, detail = fetch_ollama_models("http://host:11434")

        assert names is None
        assert detail
