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


def run_serve(tmp_path, *, nc_exit=None, nc_exit_v6=None, pull_exit=0, version_label=""):
    """Run `fabulous.sh serve`. nc_exit None = no nc on PATH;
    0 = port busy; 1 = port free. nc_exit_v6 overrides the ::1 probe result
    (only meaningful when nc_exit is not None, since that's what puts the
    nc stub on PATH)."""
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
        if nc_exit_v6 is not None:
            env["STUB_NC_EXIT_V6"] = str(nc_exit_v6)
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

    def test_ipv6_only_squatter_refused(self, tmp_path):
        # localhost may resolve to ::1 — a v6-only listener still wins
        # the browser's lookup, so it must be treated as busy.
        proc, log = run_serve(tmp_path, nc_exit=1, nc_exit_v6=0)
        assert proc.returncode == 75
        assert log == []


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
