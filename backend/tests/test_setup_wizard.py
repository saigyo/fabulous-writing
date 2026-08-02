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
            probe=probe_ok,
        )
        assert (
            parse_env_file(config_dir / "fabulous.env")["FW_ADMIN_PASSWORD"]
            == "password-with-space "
        )


class TestImageContract:
    def test_default_paths_match_the_dockerfile_layout(self):
        # Task 4's Dockerfile copies the template to /app/config.container.yaml
        # and declares the /config volume; a silent rename there would break
        # `setup` at runtime only. Pin the contract.
        from app.setup_wizard import DEFAULT_CONFIG_DIR, DEFAULT_TEMPLATE

        assert DEFAULT_CONFIG_DIR == "/config"
        assert DEFAULT_TEMPLATE == "/app/config.container.yaml"
