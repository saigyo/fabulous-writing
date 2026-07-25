from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import CurrentUser, get_current_user, require_admin
from app.core.auth import LocalTokenVerifier, issue_token
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
