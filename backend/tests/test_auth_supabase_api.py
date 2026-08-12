"""Supabase-mode auth routes: login/refresh/logout/password/reset, mode
dispatch, and the password-change eviction window (B14 Task 4, #55)."""

import time

import pytest
from fastapi.testclient import TestClient

from app.api.auth import _INVALID_LOGIN
from app.core.auth import IAT_LEEWAY_SECONDS
from app.core.config import Settings
from app.main import create_app
from app.services.supabase_gateway import SupabaseUnavailableError
from tests.conftest import TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, auth_headers
from tests.fakes_supabase import FakeSupabaseGateway, FakeSupabaseVerifier

EMAIL = "supa-user@example.com"
PASSWORD = "correct horse battery staple"
UUID = "fake-uuid-primary"


@pytest.fixture()
def supabase_app(tmp_path, monkeypatch):
    monkeypatch.setenv("FW_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_t")
    monkeypatch.setenv("FW_SUPABASE_SECRET_KEY", "sb_secret_t")
    settings = Settings(
        db_path=tmp_path / "t.db",
        auth={"mode": "supabase", "supabase": {"url": "https://api-test.invalid"}},
    )
    app = create_app(settings)
    fake = FakeSupabaseGateway()
    app.state.supabase_gateway = fake
    # Route tests authenticate via the fake's tokens; swap the verifier for
    # one that resolves them (no network: the real verifier is never given
    # a chance to fetch JWKS).
    app.state.token_verifier = FakeSupabaseVerifier(fake, app.state.user_store)
    return app, fake


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _login_ok(app, fake, *, email=EMAIL, password=PASSWORD, uuid=UUID):
    fake.register_user(email, password, uuid=uuid)
    client = TestClient(app)
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return client, resp.json()


class TestLogin:
    def test_success_returns_triple_and_user(self, supabase_app):
        app, fake = supabase_app
        _client, body = _login_ok(app, fake)
        assert body["token"].startswith("fake-access-")
        assert body["refresh_token"].startswith("fake-refresh-")
        assert body["expires_at"] == 2_000_000_000
        assert body["user"]["email"] == EMAIL

    def test_wrong_password_401_generic(self, supabase_app):
        app, fake = supabase_app
        fake.register_user(EMAIL, PASSWORD, uuid=UUID)
        client = TestClient(app)
        resp = client.post("/api/auth/login", json={"email": EMAIL, "password": "nope"})
        assert resp.status_code == 401
        assert resp.json()["detail"] == _INVALID_LOGIN

    def test_login_while_throttled_401_without_calling_gateway(self, supabase_app):
        app, fake = supabase_app
        fake.register_user(EMAIL, PASSWORD, uuid=UUID)
        client = TestClient(app)
        for _ in range(5):  # LoginThrottle's default threshold
            client.post("/api/auth/login", json={"email": EMAIL, "password": "nope"})
        calls_before = len(fake.sign_in_calls)
        resp = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
        assert resp.status_code == 401
        assert len(fake.sign_in_calls) == calls_before

    def test_unavailable_returns_503(self, supabase_app):
        app, fake = supabase_app
        fake.register_user(EMAIL, PASSWORD, uuid=UUID)

        async def boom(_email, _password):
            raise SupabaseUnavailableError("down")

        fake.sign_in = boom
        client = TestClient(app)
        resp = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
        assert resp.status_code == 503
        assert resp.json()["detail"] == "Authentication service unavailable"

    def test_inactive_user_401(self, supabase_app):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        app.state.user_store.update_user(body["user"]["id"], is_active=False)
        resp = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
        assert resp.status_code == 401
        assert resp.json()["detail"] == _INVALID_LOGIN


class TestRefresh:
    def test_success_rotates_tokens(self, supabase_app):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        resp = client.post("/api/auth/refresh", json={"refresh_token": body["refresh_token"]})
        assert resp.status_code == 200
        rotated = resp.json()
        assert rotated["token"] != body["token"]
        assert rotated["refresh_token"] != body["refresh_token"]
        assert rotated["user"]["email"] == EMAIL

    def test_invalid_refresh_token_401(self, supabase_app):
        app, _fake = supabase_app
        client = TestClient(app)
        resp = client.post("/api/auth/refresh", json={"refresh_token": "garbage"})
        assert resp.status_code == 401
        assert resp.json()["detail"] == _INVALID_LOGIN


class TestLogout:
    def test_logout_204_and_records_token(self, supabase_app):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        resp = client.post("/api/auth/logout", headers=_bearer(body["token"]))
        assert resp.status_code == 204
        assert fake.sign_out_calls == [body["token"]]

    def test_logout_with_gateway_down_still_204(self, supabase_app):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)

        async def boom(_token):
            raise SupabaseUnavailableError("down")

        fake.sign_out = boom
        resp = client.post("/api/auth/logout", headers=_bearer(body["token"]))
        assert resp.status_code == 204

    def test_anonymous_logout_401_in_supabase_mode(self, supabase_app):
        app, _fake = supabase_app
        client = TestClient(app)
        resp = client.post("/api/auth/logout")
        assert resp.status_code == 401

    def test_anonymous_logout_401_in_local_mode(self, tmp_path):
        settings = Settings(db_path=tmp_path / "local.db", rules_dir=tmp_path / "rules")
        client = TestClient(create_app(settings))
        resp = client.post("/api/auth/logout")
        assert resp.status_code == 401


class TestThrottleIsolation:
    def test_reset_requests_do_not_block_login_for_the_same_key(self, supabase_app):
        app, fake = supabase_app
        fake.register_user(EMAIL, PASSWORD, uuid=UUID)
        client = TestClient(app)
        for _ in range(10):
            resp = client.post("/api/auth/reset-request", json={"email": EMAIL})
            assert resp.status_code == 204
        resp = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
        assert resp.status_code == 200


class TestPasswordChange:
    def test_happy_path_204_and_effects(self, supabase_app):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        user_id = body["user"]["id"]
        resp = client.post(
            "/api/auth/password",
            json={"current": PASSWORD, "new": "brand-new-password-1"},
            headers=_bearer(body["token"]),
        )
        assert resp.status_code == 204
        user = app.state.user_store.get_user(user_id)
        assert user.password_changed_at is not None
        assert fake.global_sign_out_calls

    def test_wrong_current_password_422(self, supabase_app):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        resp = client.post(
            "/api/auth/password",
            json={"current": "totally-wrong", "new": "brand-new-password-1"},
            headers=_bearer(body["token"]),
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "wrong_current_password"

    def test_short_new_password_422(self, supabase_app):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        resp = client.post(
            "/api/auth/password",
            json={"current": PASSWORD, "new": "short"},
            headers=_bearer(body["token"]),
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "password_too_short"


class TestResetRequest:
    def test_always_204_including_unknown_email(self, supabase_app):
        app, fake = supabase_app
        client = TestClient(app)
        resp = client.post("/api/auth/reset-request", json={"email": "unknown@example.com"})
        assert resp.status_code == 204
        assert fake.reset_emails == ["unknown@example.com"]

    def test_throttled_204_without_calling_gateway_again(self, supabase_app):
        app, fake = supabase_app
        client = TestClient(app)
        email = "throttle-reset@example.com"
        for _ in range(3):  # reset_throttle's threshold
            client.post("/api/auth/reset-request", json={"email": email})
        before = list(fake.reset_emails)
        resp = client.post("/api/auth/reset-request", json={"email": email})
        assert resp.status_code == 204
        assert fake.reset_emails == before


class TestResetConfirm:
    def test_valid_recovery_hash_204_updates_password_and_signs_out(self, supabase_app):
        app, fake = supabase_app
        uuid = fake.register_user(EMAIL, PASSWORD, uuid=UUID)
        client = TestClient(app)
        login = client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
        user_id = login.json()["user"]["id"]
        fake.valid_token_hashes["good-hash"] = (uuid, EMAIL)
        resp = client.post(
            "/api/auth/reset-confirm",
            json={
                "token_hash": "good-hash", "type": "recovery",
                "new_password": "another-new-pw-1",
            },
        )
        assert resp.status_code == 204
        assert fake.stored_password(EMAIL) == "another-new-pw-1"
        user = app.state.user_store.get_user(user_id)
        assert user.password_changed_at is not None
        assert fake.global_sign_out_calls

    def test_invalid_hash_422(self, supabase_app):
        app, _fake = supabase_app
        client = TestClient(app)
        resp = client.post(
            "/api/auth/reset-confirm",
            json={
                "token_hash": "bad-hash", "type": "recovery",
                "new_password": "another-new-pw-1",
            },
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "invalid_or_expired_link"

    def test_invite_type_unknown_subject_jit_creates_row(self, supabase_app):
        app, fake = supabase_app
        new_uuid = "fake-uuid-invite-1"
        fake.valid_token_hashes["invite-hash"] = (new_uuid, "invitee@example.com")
        client = TestClient(app)
        resp = client.post(
            "/api/auth/reset-confirm",
            json={
                "token_hash": "invite-hash", "type": "invite",
                "new_password": "invitee-pw-123",
            },
        )
        assert resp.status_code == 204
        created = app.state.user_store.get_by_external_id(new_uuid)
        assert created is not None
        assert created.email == "invitee@example.com"


SUPABASE_ONLY_BODIES = {
    "/api/auth/refresh": {"refresh_token": "x"},
    "/api/auth/reset-request": {"email": "a@example.com"},
    "/api/auth/reset-confirm": {
        "token_hash": "x", "type": "recovery", "new_password": "abcdefgh",
    },
}


class TestModeDispatch:
    def test_supabase_only_routes_404_in_local_mode(self, tmp_path):
        settings = Settings(db_path=tmp_path / "local.db", rules_dir=tmp_path / "rules")
        client = TestClient(create_app(settings))
        for path, body in SUPABASE_ONLY_BODIES.items():
            resp = client.post(path, json=body)
            assert resp.status_code == 404, f"{path} returned {resp.status_code}"

    def test_logout_404_in_local_mode_for_an_authenticated_caller(self, tmp_path):
        settings = Settings(db_path=tmp_path / "local.db", rules_dir=tmp_path / "rules")
        client = TestClient(create_app(settings))
        client.headers.update(auth_headers(client))
        resp = client.post("/api/auth/logout")
        assert resp.status_code == 404

    def test_local_login_unchanged_and_supabase_fields_are_none(self, tmp_path):
        settings = Settings(db_path=tmp_path / "local.db", rules_dir=tmp_path / "rules")
        client = TestClient(create_app(settings))
        resp = client.post(
            "/api/auth/login",
            json={"email": TEST_ADMIN_EMAIL, "password": TEST_ADMIN_PASSWORD},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["refresh_token"] is None
        assert body["expires_at"] is None

    def test_health_auth_features_false_in_local_mode(self, tmp_path):
        settings = Settings(db_path=tmp_path / "local.db", rules_dir=tmp_path / "rules")
        client = TestClient(create_app(settings))
        resp = client.get("/api/health")
        assert resp.json()["auth_features"] == {"password_reset": False, "invites": False}

    def test_health_auth_features_true_in_supabase_mode(self, supabase_app):
        app, _fake = supabase_app
        client = TestClient(app)
        resp = client.get("/api/health")
        assert resp.json()["auth_features"] == {"password_reset": True, "invites": True}


class TestEvictionIntegration:
    def test_backdated_token_401_after_change_in_window_token_stays_200(self, supabase_app):
        app, fake = supabase_app
        uuid = fake.register_user(EMAIL, PASSWORD, uuid=UUID)
        now = time.time()
        old_token = fake.issue_session(
            EMAIL, uuid=uuid, issued_at=now - (IAT_LEEWAY_SECONDS + 60)
        ).access_token
        in_window_token = fake.issue_session(EMAIL, uuid=uuid, issued_at=now).access_token
        client = TestClient(app)
        # Trigger JIT-provisioning (via the old token) and mark_password_changed.
        resp = client.post(
            "/api/auth/password",
            json={"current": PASSWORD, "new": "brand-new-password-2"},
            headers=_bearer(old_token),
        )
        assert resp.status_code == 204
        stale = client.get("/api/auth/me", headers=_bearer(old_token))
        assert stale.status_code == 401
        fresh = client.get("/api/auth/me", headers=_bearer(in_window_token))
        assert fresh.status_code == 200


class TestExternalIdCollision:
    """resolve_supabase_user raises InvalidToken (not an HTTPException) when
    a verified Supabase session's email belongs to a local row already
    linked to a DIFFERENT external_id. Each of login/refresh/reset-confirm
    calls resolve_supabase_user directly, so each must catch it and answer
    its own generic error -- not let it escape as an unhandled 500."""

    COLLIDING_EMAIL = "collision@example.com"
    SESSION_UUID = "fake-uuid-session"
    OTHER_UUID = "fake-uuid-already-linked"

    def _seed_collision(self, app, fake):
        # A local row already linked to a DIFFERENT external_id than the
        # one the incoming Supabase session will carry.
        app.state.user_store.create_user(
            self.COLLIDING_EMAIL, "local-password-1", external_id=self.OTHER_UUID
        )
        fake.register_user(self.COLLIDING_EMAIL, PASSWORD, uuid=self.SESSION_UUID)

    def test_login_collision_is_401_not_500(self, supabase_app):
        app, fake = supabase_app
        self._seed_collision(app, fake)
        client = TestClient(app)
        resp = client.post(
            "/api/auth/login",
            json={"email": self.COLLIDING_EMAIL, "password": PASSWORD},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == _INVALID_LOGIN

    def test_refresh_collision_is_401_not_500(self, supabase_app):
        app, fake = supabase_app
        self._seed_collision(app, fake)
        session = fake.issue_session(self.COLLIDING_EMAIL, uuid=self.SESSION_UUID)
        client = TestClient(app)
        resp = client.post(
            "/api/auth/refresh", json={"refresh_token": session.refresh_token}
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == _INVALID_LOGIN

    def test_reset_confirm_collision_is_422_not_500(self, supabase_app):
        app, fake = supabase_app
        self._seed_collision(app, fake)
        fake.valid_token_hashes["colliding-hash"] = (
            self.SESSION_UUID, self.COLLIDING_EMAIL,
        )
        client = TestClient(app)
        resp = client.post(
            "/api/auth/reset-confirm",
            json={
                "token_hash": "colliding-hash", "type": "recovery",
                "new_password": "another-new-pw-1",
            },
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "invalid_or_expired_link"
