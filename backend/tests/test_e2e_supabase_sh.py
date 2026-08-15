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
    `-n auto` (and `-p no:xdist` is banned by convention) — and it must come
    AFTER the forwarded "$@": pytest's last-argument-wins would otherwise
    let a caller's -n/--numprocesses re-enable xdist.
    """
    text = SCRIPT.read_text(encoding="utf-8")
    pytest_lines = [l for l in text.splitlines() if "pytest" in l]
    assert pytest_lines, "script must invoke pytest"
    assert any(
        "tests_e2e" in l and l.rstrip().endswith('"$@" -n0') for l in pytest_lines
    )


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


def test_stack_definition_pins_the_production_template_contract():
    """supabase/config.toml and supabase/templates/*.html encode the
    production email-link fragment contract from docs/supabase-auth-setup.md
    (`#token_hash={{ .TokenHash }}&type=<invite|recovery>`) plus the auth
    settings the live e2e suite relies on. The live suite only re-verifies
    this when the stack is freshly started (a running stack keeps its
    boot-time config, per FINDING 1) — this test pins the committed files
    directly, in the Docker-free default gate, so a template or config
    regression is caught unconditionally.
    """
    config = tomllib.loads(
        (REPO_ROOT / "supabase" / "config.toml").read_text(encoding="utf-8")
    )
    invite_html = (REPO_ROOT / "supabase" / "templates" / "invite.html").read_text(
        encoding="utf-8"
    )
    recovery_html = (REPO_ROOT / "supabase" / "templates" / "recovery.html").read_text(
        encoding="utf-8"
    )

    assert "#token_hash={{ .TokenHash }}&type=invite" in invite_html
    assert "#token_hash={{ .TokenHash }}&type=recovery" in recovery_html

    auth = config["auth"]
    assert auth["signing_keys_path"] == "./signing_keys.json"
    assert auth["enable_signup"] is False
    assert (
        auth["email"]["template"]["invite"]["content_path"]
        == "./supabase/templates/invite.html"
    )
    assert (
        auth["email"]["template"]["recovery"]["content_path"]
        == "./supabase/templates/recovery.html"
    )


def test_missing_cli_yields_actionable_error():
    """Without the supabase CLI on PATH, the pre-flight message names it —
    for every invocation shape, including --down."""
    env = os.environ | {"PATH": "/usr/bin:/bin"}
    result = subprocess.run(
        [str(SCRIPT), "--down"], capture_output=True, text=True, env=env, timeout=30
    )
    assert result.returncode == 1
    assert "supabase CLI not found" in result.stderr
