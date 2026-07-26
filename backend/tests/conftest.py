"""Session-wide test environment.

create_app() now refuses to start without a signing secret and bootstrap
admin credentials (both deliberately fail-closed). Supplying them here
keeps every existing test building apps the way it always did, instead of
threading env vars through fifteen test modules.
"""

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

TEST_SECRET = "test-secret-value-that-is-long-enough-32"
TEST_ADMIN_EMAIL = "root@example.com"
TEST_ADMIN_PASSWORD = "bootstrap password"


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
