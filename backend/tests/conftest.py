"""Session-wide test environment.

create_app() now refuses to start without a signing secret and bootstrap
admin credentials (both deliberately fail-closed). Supplying them here
keeps every existing test building apps the way it always did, instead of
threading env vars through fifteen test modules.
"""

import os

import pytest

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
