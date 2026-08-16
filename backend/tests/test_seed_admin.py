from pathlib import Path

import pytest

from app.core.auth import AuthConfigError
from app.services.db.sqlite import SqliteDatabase
from app.services.seed_admin import seed_admin
from app.services.users import UserStore

ENV = {"FW_ADMIN_EMAIL": "root@example.com", "FW_ADMIN_PASSWORD": "bootstrap password"}


@pytest.fixture()
def store(tmp_path: Path) -> UserStore:
    return UserStore(SqliteDatabase(tmp_path / "test.db"))


def test_seeds_the_first_admin_as_id_one(store):
    seed_admin(store, env=ENV)
    admin = store.get_user(1)
    # id 1 matters: existing documents and folders already carry
    # owner_id = 1, so M3's backfill assigns them to this account.
    assert admin.email == "root@example.com"
    assert admin.is_admin is True and admin.tier == "premium"
    assert store.verify_credentials("root@example.com", "bootstrap password") is not None


def test_is_a_bootstrap_not_an_ongoing_sync(store):
    seed_admin(store, env=ENV)
    store.set_password(1, "a rotated password")
    # Re-running must not reset the password: the env vars would otherwise
    # be a standing backdoor for anyone who can read the environment.
    seed_admin(store, env=ENV)
    assert store.count() == 1
    assert store.verify_credentials("root@example.com", "a rotated password") is not None
    assert store.verify_credentials("root@example.com", "bootstrap password") is None


def test_fails_closed_when_no_users_and_no_env(store):
    with pytest.raises(AuthConfigError, match="FW_ADMIN_EMAIL"):
        seed_admin(store, env={})


def test_rejects_a_short_bootstrap_password(store):
    # AuthConfigError, not the bare ValueError validate_password raises:
    # every other startup gate raises AuthConfigError, and an operator
    # wrapper catching it around create_app() must catch this case too.
    with pytest.raises(AuthConfigError, match="at least 12"):
        seed_admin(store, env={"FW_ADMIN_EMAIL": "root@example.com",
                               "FW_ADMIN_PASSWORD": "short"})
