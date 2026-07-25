from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.auth import LoginThrottle
from app.api.deps import CurrentUser, get_current_user, require_admin
from app.core.auth import LocalTokenVerifier, issue_token
from app.core.config import Settings
from app.main import create_app
from app.services.users import UserStore

# 64 bytes, not merely the 32-byte minimum: kept consistent with the secret
# length used in tests/test_auth_core.py.
SECRET = "s" * 64


@pytest.fixture()
def probe(tmp_path: Path):
    """A minimal app exposing the dependencies, so they are tested directly
    rather than through whichever endpoint happens to use them."""
    app = FastAPI()
    app.state.user_store = UserStore(tmp_path / "test.db")
    app.state.token_verifier = LocalTokenVerifier(SECRET)

    @app.get("/probe/user")
    def probe_user(user: CurrentUser = Depends(get_current_user)) -> dict:
        return {"id": user.id, "email": user.email, "tier": user.tier,
                "is_admin": user.is_admin}

    @app.get("/probe/admin")
    def probe_admin(user: CurrentUser = Depends(require_admin)) -> dict:
        return {"id": user.id}

    return app


def auth(user_id: int) -> dict:
    return {"Authorization": f"Bearer {issue_token(user_id, SECRET)}"}


def test_valid_token_resolves_the_user(probe):
    user = probe.state.user_store.create_user("ada@example.com", "correct horse battery")
    body = TestClient(probe).get("/probe/user", headers=auth(user.id)).json()
    assert body == {"id": user.id, "email": "ada@example.com", "tier": "basic",
                    "is_admin": False}


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer"}, {"Authorization": "Basic abc"},
     {"Authorization": "Bearer garbage"}],
)
def test_missing_or_malformed_credentials_are_401(probe, headers):
    assert TestClient(probe).get("/probe/user", headers=headers).status_code == 401


def test_token_for_an_unknown_user_is_401(probe):
    assert TestClient(probe).get("/probe/user", headers=auth(999)).status_code == 401


def test_deactivation_takes_effect_on_the_next_request(probe):
    # The user row is re-read per request, so revoking access does not wait
    # for the token to expire — this is the incident-response lever.
    user = probe.state.user_store.create_user("ada@example.com", "correct horse battery")
    client = TestClient(probe)
    headers = auth(user.id)
    assert client.get("/probe/user", headers=headers).status_code == 200
    probe.state.user_store.update_user(user.id, is_active=False)
    assert client.get("/probe/user", headers=headers).status_code == 401


def test_require_admin_rejects_a_normal_user_and_admits_an_admin(probe):
    normal = probe.state.user_store.create_user("ada@example.com", "correct horse battery")
    admin = probe.state.user_store.create_user(
        "root@example.com", "correct horse battery", is_admin=True
    )
    client = TestClient(probe)
    assert client.get("/probe/admin", headers=auth(normal.id)).status_code == 403
    assert client.get("/probe/admin", headers=auth(admin.id)).status_code == 200


def test_de_adminning_takes_effect_on_the_next_request(probe):
    admin = probe.state.user_store.create_user(
        "root@example.com", "correct horse battery", is_admin=True
    )
    client = TestClient(probe)
    headers = auth(admin.id)
    assert client.get("/probe/admin", headers=headers).status_code == 200
    probe.state.user_store.update_user(admin.id, is_admin=False)
    assert client.get("/probe/admin", headers=headers).status_code == 403


@pytest.fixture()
def app_client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("FW_AUTH_SECRET", SECRET)
    monkeypatch.setenv("FW_ADMIN_EMAIL", "root@example.com")
    monkeypatch.setenv("FW_ADMIN_PASSWORD", "bootstrap password")
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    return TestClient(create_app(settings))


def login(client: TestClient, email: str, password: str):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def test_login_returns_a_token_and_the_user(app_client):
    response = login(app_client, "root@example.com", "bootstrap password")
    assert response.status_code == 200
    body = response.json()
    assert body["token"]
    assert body["user"]["email"] == "root@example.com"
    assert body["user"]["is_admin"] is True
    assert "password_hash" not in str(body)


def test_login_is_case_insensitive_on_email(app_client):
    assert login(app_client, "ROOT@Example.com", "bootstrap password").status_code == 200


@pytest.mark.parametrize(
    ("email", "password"),
    [("root@example.com", "wrong password"), ("nobody@example.com", "bootstrap password")],
)
def test_login_failures_are_indistinguishable(app_client, email, password):
    response = login(app_client, email, password)
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid email or password"


def test_deactivated_account_cannot_log_in(app_client):
    store = app_client.app.state.user_store
    store.update_user(1, is_active=False)
    assert login(app_client, "root@example.com", "bootstrap password").status_code == 401


def test_me_requires_authentication_and_returns_the_caller(app_client):
    assert app_client.get("/api/auth/me").status_code == 401
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    body = app_client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert body["email"] == "root@example.com" and body["is_admin"] is True
    assert body["tier"] == "premium"


def test_password_change_requires_the_current_password(app_client):
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    wrong = app_client.post(
        "/api/auth/password",
        json={"current": "not it", "new": "a new long password"},
        headers=headers,
    )
    assert wrong.status_code == 401
    ok = app_client.post(
        "/api/auth/password",
        json={"current": "bootstrap password", "new": "a new long password"},
        headers=headers,
    )
    assert ok.status_code == 204
    assert login(app_client, "root@example.com", "bootstrap password").status_code == 401
    assert login(app_client, "root@example.com", "a new long password").status_code == 200


def test_password_change_enforces_the_self_chosen_minimum(app_client):
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    response = app_client.post(
        "/api/auth/password",
        json={"current": "bootstrap password", "new": "short"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 422
    assert "at least 8" in response.json()["detail"]


def test_throttle_blocks_after_repeated_failures_then_recovers():
    now = [0.0]
    throttle = LoginThrottle(threshold=3, base_delay=2.0, clock=lambda: now[0])
    key = ("ada@example.com", "127.0.0.1")
    assert throttle.blocked_for(key) == 0
    for _ in range(3):
        throttle.record_failure(key)
    assert throttle.blocked_for(key) > 0
    now[0] += 2.0
    assert throttle.blocked_for(key) == 0


def test_throttle_backoff_grows_and_success_clears_it():
    now = [0.0]
    throttle = LoginThrottle(threshold=1, base_delay=2.0, clock=lambda: now[0])
    key = ("ada@example.com", "127.0.0.1")
    throttle.record_failure(key)
    first = throttle.blocked_for(key)
    throttle.record_failure(key)
    assert throttle.blocked_for(key) > first
    throttle.record_success(key)
    assert throttle.blocked_for(key) == 0


def test_throttle_expires_stale_entries():
    # Keys come from unauthenticated input, so the table must not keep an
    # entry alive forever on the strength of one ancient failure.
    now = [0.0]
    throttle = LoginThrottle(threshold=1, entry_ttl=100.0, clock=lambda: now[0])
    stale = ("ada@example.com", "127.0.0.1")
    throttle.record_failure(stale)
    now[0] += 500.0
    throttle.record_failure(("other@example.com", "127.0.0.1"))
    assert throttle.entry_count() == 1
    assert throttle.blocked_for(stale) == 0


def test_throttle_table_is_bounded():
    # An attacker spraying distinct addresses must not be able to grow the
    # table without limit — that would trade a brute-force defense for a
    # memory-exhaustion vector.
    throttle = LoginThrottle(threshold=1, max_entries=8, clock=lambda: 0.0)
    for index in range(100):
        throttle.record_failure((f"user{index}@example.com", "127.0.0.1"))
    assert throttle.entry_count() <= 8


def test_throttled_login_is_rejected_even_with_the_right_password(app_client):
    for _ in range(5):
        login(app_client, "root@example.com", "wrong password")
    blocked = login(app_client, "root@example.com", "bootstrap password")
    assert blocked.status_code == 401
    assert blocked.json()["detail"] == "Invalid email or password"
