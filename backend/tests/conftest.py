"""Session-wide test environment.

create_app() now refuses to start without a signing secret and bootstrap
admin credentials (both deliberately fail-closed). Supplying them here
keeps every existing test building apps the way it always did, instead of
threading env vars through fifteen test modules.
"""

import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import auth
from app.core.config import Settings
from app.main import create_app
from app.services.db.sqlite import SqliteDatabase

TEST_SECRET = "test-secret-value-that-is-long-enough-32"
TEST_ADMIN_EMAIL = "root@example.com"
TEST_ADMIN_PASSWORD = "bootstrap password"

# Captured at module import time, before any fixture (including
# _fast_bcrypt below) has a chance to run — this is the real production
# value, not whatever the test session happens to override it to.
PRODUCTION_BCRYPT_ROUNDS = auth._BCRYPT_ROUNDS


@pytest.fixture(autouse=True, scope="session")
def _config_isolation(tmp_path_factory):
    """A developer's live backend/config.yaml must never leak into the suite.

    load_settings() falls back to backend/config.yaml whenever
    FW_CONFIG_FILE is unset, and the manage-CLI tests spawn subprocesses
    that inherit this process's environment — so a local config (e.g.
    auth.mode: supabase left over from manual acceptance testing) fails
    tests that build settings without an explicit path. Pinning
    FW_CONFIG_FILE to a neutral empty config closes both routes; tests
    that set FW_CONFIG_FILE themselves override it per-test as before.
    """
    previous = os.environ.get("FW_CONFIG_FILE")
    neutral = tmp_path_factory.mktemp("config-isolation") / "config.yaml"
    neutral.write_text("{}\n", encoding="utf-8")
    os.environ["FW_CONFIG_FILE"] = str(neutral)
    yield
    if previous is None:
        os.environ.pop("FW_CONFIG_FILE", None)
    else:
        os.environ["FW_CONFIG_FILE"] = previous


@pytest.fixture(autouse=True, scope="session")
def _auth_env():
    previous = {
        key: os.environ.get(key)
        for key in ("FW_AUTH_SECRET", "FW_ADMIN_EMAIL", "FW_ADMIN_PASSWORD")
    }
    os.environ["FW_AUTH_SECRET"] = TEST_SECRET
    os.environ["FW_ADMIN_EMAIL"] = TEST_ADMIN_EMAIL
    os.environ["FW_ADMIN_PASSWORD"] = TEST_ADMIN_PASSWORD
    yield
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@pytest.fixture(autouse=True, scope="session")
def _fast_bcrypt():
    """Cost-4 bcrypt for the whole test session (~0.7 ms vs ~173 ms/hash).

    Every test app pays one hash in seed_admin and one verify per login;
    at production cost that alone dominates suite runtime. Production
    keeps cost 12 — this override exists only inside the test process,
    which is exactly why it is not a Settings knob.
    """
    from app.core import auth

    previous = auth._BCRYPT_ROUNDS
    auth._BCRYPT_ROUNDS = 4
    yield
    auth._BCRYPT_ROUNDS = previous


class DocumentClock:
    """Deterministic stand-in for app.services.documents._utcnow."""

    def __init__(self) -> None:
        self.current = datetime(2026, 1, 1, tzinfo=UTC)

    def advance(self, seconds: int = 2) -> None:
        self.current += timedelta(seconds=seconds)

    def now_iso(self) -> str:
        return self.current.isoformat(timespec="seconds")


@pytest.fixture()
def document_clock(monkeypatch: pytest.MonkeyPatch) -> DocumentClock:
    """Second-precision document timestamps under test control.

    Replaces the real clock so ordering tests advance time explicitly
    instead of sleeping 1.1 s. No fixture writes document rows (`store`
    only constructs the DocumentStore; `authed_client` only builds the
    app and logs in), so the patch merely has to be active before the
    test body runs — every row then carries clock time, never a mix of
    real and patched timestamps.
    """
    clock = DocumentClock()
    monkeypatch.setattr("app.services.documents._utcnow", clock.now_iso)
    return clock


def auth_headers(client: TestClient) -> dict[str, str]:
    """Bearer header for the bootstrap admin, via a real login.

    Used by test modules that must build their own app (custom settings,
    monkeypatched env, etc.) and so can't use the `authed_client` fixture
    below. Goes through `/api/auth/login` rather than `issue_token`
    directly, so the test stays honest about the path a real client takes.
    """
    token = client.post(
        "/api/auth/login",
        json={"email": TEST_ADMIN_EMAIL, "password": TEST_ADMIN_PASSWORD},
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


SECOND_USER_EMAIL = "second@example.com"
SECOND_USER_PASSWORD = "second user password"  # >= 12 chars (admin-set floor)


def second_user_headers(client: TestClient) -> dict[str, str]:
    """Bearer header for a second, non-admin user, created via the real
    admin API + login — the same honest path auth_headers takes."""
    admin = auth_headers(client)
    client.post(
        "/api/admin/users",
        json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD},
        headers=admin,
    )
    token = client.post(
        "/api/auth/login",
        json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD},
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def authed_client(tmp_path: Path) -> TestClient:
    """A TestClient for a plain tmp_path app, with the admin's Bearer header
    pre-attached to every request.

    The bootstrap admin (seeded as id 1 by `seed_admin` at startup) is used
    rather than creating a second user, matching what the app actually does.
    Fits the test modules that don't need unusual settings; the seven that
    build their own app for that reason use `auth_headers` instead.
    """
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    client.headers.update(auth_headers(client))
    return client


@pytest.fixture(params=["sqlite", "postgres"])
def db(request, tmp_path):
    """One Database per test, parametrized over both backends (spec §R7).

    The postgres parameter skips without FW_TEST_DATABASE_URL, keeping the
    default gate Docker- and network-free.
    """
    if request.param == "sqlite":
        yield SqliteDatabase(tmp_path / "test.db")
        return
    yield request.getfixturevalue("pg_database")


@pytest.fixture
def pg_database():
    """A PostgresDatabase isolated in a throwaway schema, or skip.

    Never a live database: each test gets its own schema, dropped on
    teardown; the base DSN (FW_TEST_DATABASE_URL) points at a disposable
    local server (CI service container / supabase stack port 54322).
    """
    base_dsn = os.environ.get("FW_TEST_DATABASE_URL", "").strip()
    if not base_dsn:
        pytest.skip("FW_TEST_DATABASE_URL not set")
    import psycopg

    from app.services.db.postgres import PostgresDatabase

    schema = f"fw_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(base_dsn, autocommit=True) as admin:
        admin.execute(f'CREATE SCHEMA "{schema}"')
    sep = "&" if "?" in base_dsn else "?"
    dsn = f"{base_dsn}{sep}options=-csearch_path%3D{schema}"
    # Pool + schema per test is deliberate, honest isolation; the cost is
    # real (hundreds of create/drop cycles across the parametrized files)
    # and accepted. A PostgresDatabase(...) failure before the try would
    # leak the schema — acceptable for a disposable test server.
    database = PostgresDatabase(dsn)
    try:
        yield database
    finally:
        database.close()
        with psycopg.connect(base_dsn, autocommit=True) as admin:
            admin.execute(f'DROP SCHEMA "{schema}" CASCADE')
