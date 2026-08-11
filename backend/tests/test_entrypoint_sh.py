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
        assert "fabulous.env" in proc.stderr
        assert "leaky-value" not in proc.stderr
        assert "foo bar" not in proc.stderr
        assert not (out / "uvicorn.argv").exists()

    def test_line_without_equals_fails(self, tmp_path):
        proc, out = run_entrypoint(tmp_path, env_text="justtext\n")
        assert proc.returncode == 78
        assert "line 1" in proc.stderr
        assert not (out / "uvicorn.argv").exists()


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
