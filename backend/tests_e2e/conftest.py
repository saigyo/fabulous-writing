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
                health = httpx.get(f"{APP_URL}/api/health", timeout=2)
                if health.status_code == 200:
                    break
                last_error = f"health returned {health.status_code}"
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
    reused stack should not accumulate garbage. Errors are swallowed. The
    sweep is page-1-only (per_page=200): on a long-lived stack with more
    than 200 accumulated users, older runs' users may fall off the first
    page and simply be left behind — identities, not cleanup, carry
    correctness, so this is an accepted degradation, not a bug.
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
            email = user.get("email") or ""
            if email.endswith("@e2e.local") and runid in email:
                httpx.delete(
                    f"{stack.api_url}/auth/v1/admin/users/{user['id']}",
                    headers=headers,
                    timeout=10,
                )
    except (httpx.HTTPError, ValueError, KeyError):
        pass
