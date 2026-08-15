"""Supabase-mode auth routes: login/refresh/logout/password/reset, mode
dispatch, the password-change eviction window (B14 Task 4, #55), and
supabase-mode admin bootstrap + invitation-only user entry (Task 5)."""

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, generate_private_key
from fastapi.testclient import TestClient

from app.api.auth import _INVALID_LOGIN
from app.core.auth import AuthConfigError, IAT_LEEWAY_SECONDS
from app.core.config import Settings
from app.core.supabase_auth import SupabaseTokenVerifier
from app.main import create_app
from app.services.supabase_gateway import (
    SupabaseAuthError,
    SupabaseSession,
    SupabaseUnavailableError,
)
from tests.conftest import TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, auth_headers
from tests.fakes_supabase import FakeSupabaseGateway, FakeSupabaseVerifier, StaticJWKSClient

EMAIL = "supa-user@example.com"
PASSWORD = "correct horse battery staple"
UUID = "fake-uuid-primary"


def _build_supabase_app(tmp_path, monkeypatch, fake):
    """Builds a supabase-mode app with `fake` wired in BEFORE create_app
    runs: seed_admin bootstraps the admin through the gateway as part of
    app construction, so the fake must already be in place at that point --
    swapping app.state.supabase_gateway afterwards (as Task 4's fixture
    did) is too late."""
    monkeypatch.setenv("FW_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_t")
    monkeypatch.setenv("FW_SUPABASE_SECRET_KEY", "sb_secret_t")
    monkeypatch.setattr("app.main.SupabaseAuthGateway", lambda creds: fake)
    settings = Settings(
        db_path=tmp_path / "t.db",
        auth={"mode": "supabase", "supabase": {"url": "https://api-test.invalid"}},
    )
    return create_app(settings)


@pytest.fixture()
def supabase_app(tmp_path, monkeypatch):
    fake = FakeSupabaseGateway()
    app = _build_supabase_app(tmp_path, monkeypatch, fake)
    assert app.state.supabase_gateway is fake
    # Route tests authenticate via the fake's tokens; swap the verifier for
    # one that resolves them (no network: the real verifier is never given
    # a chance to fetch JWKS).
    app.state.token_verifier = FakeSupabaseVerifier(fake, app.state.user_store)
    return app, fake


def _admin_bearer(client: TestClient) -> dict:
    # The bootstrap admin's password lives with the fake (seed_admin's
    # supabase branch writes no local hash), so this goes through the fake
    # exactly like a real client's login would.
    token = client.post(
        "/api/auth/login",
        json={"email": TEST_ADMIN_EMAIL, "password": TEST_ADMIN_PASSWORD},
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


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
        # Round-2 finding E: global_sign_out must actually revoke the
        # pre-change refresh token at the fake, not just record the call --
        # otherwise a stale refresh token would still mint fresh sessions
        # after a password change the eviction is supposed to end.
        stale_refresh = client.post(
            "/api/auth/refresh", json={"refresh_token": body["refresh_token"]}
        )
        assert stale_refresh.status_code == 401

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

    def test_gateway_auth_error_maps_to_422_without_bumping(self, supabase_app):
        # finding 2 (Copilot round 1): change_password's own gateway call
        # was unmapped -- a SupabaseAuthError escaped as a 500, and nothing
        # stopped mark_password_changed from having already run first.
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        user_id = body["user"]["id"]

        async def boom(_uuid, _password):
            raise SupabaseAuthError("rejected")

        fake.change_password = boom
        resp = client.post(
            "/api/auth/password",
            json={"current": PASSWORD, "new": "brand-new-password-1"},
            headers=_bearer(body["token"]),
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "password_change_failed"
        assert app.state.user_store.get_user(user_id).password_changed_at is None

    def test_gateway_unavailable_maps_to_503_without_bumping(self, supabase_app):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        user_id = body["user"]["id"]

        async def boom(_uuid, _password):
            raise SupabaseUnavailableError("down")

        fake.change_password = boom
        resp = client.post(
            "/api/auth/password",
            json={"current": PASSWORD, "new": "brand-new-password-1"},
            headers=_bearer(body["token"]),
        )
        assert resp.status_code == 503
        assert app.state.user_store.get_user(user_id).password_changed_at is None

    @pytest.mark.parametrize("gateway_error", [SupabaseAuthError, SupabaseUnavailableError])
    def test_global_sign_out_failure_is_best_effort_still_204(self, supabase_app, gateway_error):
        app, fake = supabase_app
        client, body = _login_ok(app, fake)
        user_id = body["user"]["id"]

        async def boom(_token):
            raise gateway_error("down")

        fake.global_sign_out = boom
        resp = client.post(
            "/api/auth/password",
            json={"current": PASSWORD, "new": "brand-new-password-1"},
            headers=_bearer(body["token"]),
        )
        assert resp.status_code == 204
        assert app.state.user_store.get_user(user_id).password_changed_at is not None


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
        pre_change_refresh = login.json()["refresh_token"]
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
        # Round-2 finding E: the refresh token from BEFORE the reset must be
        # dead at the fake, same eviction contract as the password-change
        # route (TestPasswordChange.test_happy_path_204_and_effects).
        stale_refresh = client.post(
            "/api/auth/refresh", json={"refresh_token": pre_change_refresh}
        )
        assert stale_refresh.status_code == 401
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


# The app is always built with this URL (see _build_supabase_app); the
# verifier below must be pointed at the identical origin, or its issuer
# check would reject even a genuinely well-formed token for the wrong
# reason.
_REAL_VERIFIER_URL = "https://api-test.invalid"


def _es256_keypair():
    private = generate_private_key(SECP256R1())
    return private, private.public_key()


def _mint_oauth_token(private, *, sub: str, email: str, kid: str = "kid-1") -> str:
    """A real, verifier-checkable JWT carrying a non-`email` provider -- the
    shape GoTrue mints for an OAuth/SSO identity, and also for an
    email/password identity whose FIRST provider was OAuth (app_metadata.
    provider records the first provider an identity ever used, not the
    grant now in flight -- see finding #0's login-needs-it-too argument)."""
    claims = {
        "sub": sub,
        "email": email,
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
        "iss": f"{_REAL_VERIFIER_URL}/auth/v1",
        "aud": "authenticated",
        "role": "authenticated",
        "is_anonymous": False,
        "app_metadata": {"provider": "google", "providers": ["google", "email"]},
    }
    return jwt.encode(claims, private, algorithm="ES256", headers={"kid": kid})


class _SignedSessionGateway(FakeSupabaseGateway):
    """Same in-memory bookkeeping as FakeSupabaseGateway, except every
    session it mints carries a REAL, verifier-checkable JWT as its access
    token (signed with `private_key`, `app_metadata.provider: "google"`)
    instead of the fake's own opaque `fake-access-N` string. This is what
    lets a test swap in the real `SupabaseTokenVerifier` and exercise its
    claim guards end to end -- `FakeSupabaseVerifier` cannot stand in for
    this, since it implements none of them (see finding #0's caveat)."""

    def __init__(self, private_key) -> None:
        super().__init__()
        self._private_key = private_key

    def _signed_session(self, uuid: str, email: str) -> SupabaseSession:
        token = _mint_oauth_token(self._private_key, sub=uuid, email=email)
        n = self._next_token
        self._next_token += 1
        refresh = f"fake-refresh-{n}"
        self._refresh_tokens[refresh] = (uuid, email)
        return SupabaseSession(
            access_token=token, refresh_token=refresh,
            expires_at=2_000_000_000, user_id=uuid, email=email,
        )

    async def sign_in(self, email: str, password: str) -> SupabaseSession:
        self.sign_in_calls.append((email, password))
        stored = self._users.get(email)
        if stored is None or stored[0] != password:
            raise SupabaseAuthError("invalid credentials")
        return self._signed_session(stored[1], email)

    async def refresh(self, refresh_token: str) -> SupabaseSession:
        entry = self._refresh_tokens.get(refresh_token)
        if entry is None:
            raise SupabaseAuthError("invalid refresh token")
        uuid, email = entry
        return self._signed_session(uuid, email)

    async def confirm_with_token_hash(
        self, token_hash: str, type_: str, new_password: str
    ) -> SupabaseSession:
        entry = self.valid_token_hashes.get(token_hash)
        if entry is None:
            raise SupabaseAuthError("invalid or expired token_hash")
        uuid, email = entry
        self._users[email] = (new_password, uuid)
        return self._signed_session(uuid, email)


class TestGatewaySessionsAreVerifiedNotResolvedDirectly:
    """Finding #0 (delta review): login/refresh/reset-confirm must route a
    gateway session's own access token through app.state.token_verifier
    (which applies is_anonymous/role/app_metadata.provider guards), not
    call resolve_supabase_user directly (which applies none of them). The
    existing collision tests (TestExternalIdCollision above) keep using
    FakeSupabaseVerifier and stay green regardless of whether the fix is
    in place -- they cannot distinguish the two implementations. Only a
    REAL SupabaseTokenVerifier, fed a genuinely signed JWT whose provider
    is not "email", proves the guard actually runs before resolution.
    `store.count()` unchanged is the load-bearing assertion: without it, a
    reverted fix would still 401 (the caller's *access token* stays
    useless either way -- deps.get_current_user rejects it next request),
    while silently having JIT-provisioned or adopted a local row as a side
    effect of getting there."""

    EMAIL = "oauth-first@example.com"
    UUID = "uuid-oauth-first"

    def _build(self, tmp_path, monkeypatch):
        private, public = _es256_keypair()
        fake = _SignedSessionGateway(private)
        app = _build_supabase_app(tmp_path, monkeypatch, fake)
        jwks = StaticJWKSClient({"kid-1": public})
        app.state.token_verifier = SupabaseTokenVerifier(
            _REAL_VERIFIER_URL, app.state.user_store, jwks_client=jwks,
        )
        return app, fake

    def test_login_is_rejected_and_creates_no_local_row(self, tmp_path, monkeypatch):
        app, fake = self._build(tmp_path, monkeypatch)
        fake.register_user(self.EMAIL, PASSWORD, uuid=self.UUID)
        store = app.state.user_store
        before = store.count()
        client = TestClient(app)

        resp = client.post(
            "/api/auth/login", json={"email": self.EMAIL, "password": PASSWORD}
        )

        assert resp.status_code == 401
        assert resp.json()["detail"] == _INVALID_LOGIN
        assert store.count() == before

    def test_refresh_is_rejected_and_creates_no_local_row(self, tmp_path, monkeypatch):
        app, fake = self._build(tmp_path, monkeypatch)
        fake.register_user(self.EMAIL, PASSWORD, uuid=self.UUID)
        # A signed session minted directly, mirroring what an earlier
        # successful sign-in at Supabase would have handed the client; its
        # refresh_token is what /api/auth/refresh consumes below.
        session = fake._signed_session(self.UUID, self.EMAIL)
        store = app.state.user_store
        before = store.count()
        client = TestClient(app)

        resp = client.post(
            "/api/auth/refresh", json={"refresh_token": session.refresh_token}
        )

        assert resp.status_code == 401
        assert resp.json()["detail"] == _INVALID_LOGIN
        assert store.count() == before

    def test_reset_confirm_is_rejected_and_creates_no_local_row(self, tmp_path, monkeypatch):
        app, fake = self._build(tmp_path, monkeypatch)
        fake.valid_token_hashes["oauth-hash"] = (self.UUID, self.EMAIL)
        store = app.state.user_store
        before = store.count()
        client = TestClient(app)

        resp = client.post(
            "/api/auth/reset-confirm",
            json={
                "token_hash": "oauth-hash", "type": "recovery",
                "new_password": "another-new-pw-1",
            },
        )

        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "invalid_or_expired_link"
        assert store.count() == before


class TestSeedAdminSupabase:
    """seed_admin's supabase branch (Task 5, #55): the admin bootstraps
    through the gateway during create_app, before any test code runs."""

    def test_fresh_app_seeds_admin_through_gateway(self, supabase_app):
        app, fake = supabase_app
        admin = app.state.user_store.get_by_email(TEST_ADMIN_EMAIL)
        assert admin is not None
        assert fake.create_user_calls == [(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)]
        # The admin is the first entity the fake ever mints a uuid for.
        assert admin.external_id == "fake-uuid-1"
        assert admin.is_admin is True
        assert admin.tier == "premium"
        # No local hash: Supabase owns the credential.
        assert app.state.user_store.verify_credentials(
            TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD
        ) is None

    def test_rerun_against_existing_project_links_existing_uuid(self, tmp_path, monkeypatch):
        fake = FakeSupabaseGateway()
        fake.register_user(TEST_ADMIN_EMAIL, "some-other-password", uuid="existing-admin-uuid")
        app = _build_supabase_app(tmp_path, monkeypatch, fake)
        admin = app.state.user_store.get_by_email(TEST_ADMIN_EMAIL)
        assert admin is not None
        assert admin.external_id == "existing-admin-uuid"
        # create_user was attempted (and rejected as a duplicate) before the
        # fallback lookup linked the existing account.
        assert fake.create_user_calls == [(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)]
        # The existing identity's old (operator-unknown) credential must not
        # survive the bootstrap: linking rotates it to the configured
        # FW_ADMIN_PASSWORD, or the operator would have no way to log in.
        assert fake.stored_password(TEST_ADMIN_EMAIL) == TEST_ADMIN_PASSWORD

    def test_bootstrap_failure_aborts_create_app(self, tmp_path, monkeypatch):
        fake = FakeSupabaseGateway()

        async def boom(_email, _password):
            raise SupabaseUnavailableError("down")

        fake.create_user = boom
        with pytest.raises(AuthConfigError):
            _build_supabase_app(tmp_path, monkeypatch, fake)

    async def test_create_app_from_a_running_loop_still_seeds_admin(self, tmp_path, monkeypatch):
        """Reproduces the uvicorn startup path: uvicorn's import_from_string
        calls create_app() from inside Server.serve()'s already-running
        event loop, not before it. seed_admin's supabase branch must not
        rely on asyncio.run() being callable at that point (#93 live-run
        finding: it crashed every real supabase-mode deployment)."""
        fake = FakeSupabaseGateway()
        app = _build_supabase_app(tmp_path, monkeypatch, fake)
        admin = app.state.user_store.get_by_email(TEST_ADMIN_EMAIL)
        assert admin is not None
        assert fake.create_user_calls == [(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD)]
        assert admin.is_admin is True

    async def test_create_app_from_a_running_loop_still_maps_bootstrap_failure(
        self, tmp_path, monkeypatch
    ):
        fake = FakeSupabaseGateway()

        async def boom(_email, _password):
            raise SupabaseUnavailableError("down")

        fake.create_user = boom
        with pytest.raises(AuthConfigError):
            _build_supabase_app(tmp_path, monkeypatch, fake)


class TestAdminCreateSupabase:
    """Admin create in supabase mode: invitation when no password is given,
    Supabase-owned credential when one is (Task 5, #55)."""

    def test_invite_without_password_returns_201_and_invited_true(self, supabase_app):
        app, fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users", json={"email": "invitee@example.com"}, headers=headers,
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["invited"] is True
        assert fake.invites == ["invitee@example.com"]
        created = app.state.user_store.get_by_email("invitee@example.com")
        assert created is not None
        assert created.external_id is not None
        audit_fields = [r["field"] for r in app.state.user_store.list_audit()]
        assert "invite" in audit_fields

    def test_create_with_password_in_supabase_mode_writes_no_local_hash(self, supabase_app):
        app, fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users",
            json={"email": "withpw@example.com", "password": "an initial password 1"},
            headers=headers,
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["invited"] is False
        assert ("withpw@example.com", "an initial password 1") in fake.create_user_calls
        assert app.state.user_store.verify_credentials(
            "withpw@example.com", "an initial password 1"
        ) is None

    def test_list_users_response_has_no_invited_key(self, supabase_app):
        app, _fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        client.post(
            "/api/admin/users", json={"email": "listed@example.com"}, headers=headers,
        )
        listing = client.get("/api/admin/users", headers=headers).json()
        assert listing
        assert all("invited" not in item for item in listing)


class TestAdminCreateModeSwitch:
    """The email-already-exists-locally paths (Copilot round 2 finding D):
    an UNLINKED existing row adopts the Supabase identity (mode switch); a
    row already linked to a DIFFERENT Supabase identity is rejected BEFORE
    any remote call is made, so the admin API never reports failure after
    already provisioning Supabase-side access."""

    UNLINKED_EMAIL = "preexisting@example.com"
    LINKED_EMAIL = "already-linked@example.com"

    def _seed_unlinked(self, app) -> int:
        row = app.state.user_store.create_user(
            self.UNLINKED_EMAIL, "a local password 1", tier="premium",
        )
        assert row.external_id is None
        return row.id

    def _seed_linked(self, app) -> int:
        row = app.state.user_store.create_user(
            self.LINKED_EMAIL, "a local password 1", external_id="fake-uuid-already-there",
        )
        assert row.external_id is not None
        return row.id

    def test_invite_on_unlinked_existing_row_links_and_invites(self, supabase_app):
        app, fake = supabase_app
        client = TestClient(app)
        row_id = self._seed_unlinked(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users", json={"email": self.UNLINKED_EMAIL}, headers=headers,
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["invited"] is True
        assert body["id"] == row_id
        assert fake.invites == [self.UNLINKED_EMAIL]
        linked = app.state.user_store.get_user(row_id)
        assert linked.external_id is not None
        # The row's existing local settings (tier) are preserved, not
        # overwritten by the create request's defaults.
        assert linked.tier == "premium"

    def test_create_with_password_on_unlinked_existing_row_links_no_local_hash(
        self, supabase_app
    ):
        app, fake = supabase_app
        client = TestClient(app)
        row_id = self._seed_unlinked(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users",
            json={"email": self.UNLINKED_EMAIL, "password": "a fresh password 1"},
            headers=headers,
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["invited"] is False
        assert (self.UNLINKED_EMAIL, "a fresh password 1") in fake.create_user_calls
        linked = app.state.user_store.get_user(row_id)
        assert linked.external_id is not None
        # No hash is written for the NEW password: adoption only links
        # external_id, it never touches password_hash (the pre-existing
        # local row's own hash, from before the switch, is untouched too --
        # out of scope for this fix).
        assert app.state.user_store.verify_credentials(
            self.UNLINKED_EMAIL, "a fresh password 1"
        ) is None

    def test_invite_on_linked_existing_row_is_422_with_no_remote_call(self, supabase_app):
        app, fake = supabase_app
        client = TestClient(app)
        self._seed_linked(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users", json={"email": self.LINKED_EMAIL}, headers=headers,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "duplicate_email"
        assert fake.invites == []

    def test_create_with_password_on_linked_existing_row_is_422_with_no_remote_call(
        self, supabase_app
    ):
        app, fake = supabase_app
        client = TestClient(app)
        self._seed_linked(app)
        headers = _admin_bearer(client)
        # Bootstrap already used create_user for the seeded admin; the
        # assertion below is that THIS request added no further call, not
        # that the fake's history is empty.
        before = list(fake.create_user_calls)
        resp = client.post(
            "/api/admin/users",
            json={"email": self.LINKED_EMAIL, "password": "another password 1"},
            headers=headers,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "duplicate_email"
        assert fake.create_user_calls == before


class TestAdminCreateReconciliation:
    """Copilot round 3: a duplicate-email rejection from create_user or
    invite_user is ambiguous -- it can mean a genuine pre-existing account,
    but it can also mean THIS admin's own earlier attempt already succeeded
    at Supabase and only the following local write then failed transiently,
    leaving no local row. A retry must reconcile onto the existing remote
    identity (mirroring seed_admin's create-or-link fallback) instead of
    permanently stranding it behind a 422. supabase/auth#2180 confirms
    invite_user_by_email rejects a retry against an already-invited,
    still-unconfirmed email the same way create_user rejects a duplicate,
    so both branches get the same reconciliation."""

    RETRY_EMAIL = "retry@example.com"

    def test_create_with_password_reconciles_after_prior_success(self, supabase_app):
        app, fake = supabase_app
        # A prior attempt's create_user already succeeded at Supabase, but
        # the local insert that should have followed it failed transiently,
        # leaving no local row -- this call is the admin's retry.
        fake.register_user(
            self.RETRY_EMAIL, "an original password 1", uuid="fake-uuid-retry"
        )
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users",
            json={"email": self.RETRY_EMAIL, "password": "a retried password 1"},
            headers=headers,
        )
        assert resp.status_code == 201, resp.text
        created = app.state.user_store.get_by_email(self.RETRY_EMAIL)
        assert created is not None
        assert created.external_id == "fake-uuid-retry"
        audit_fields = [r["field"] for r in app.state.user_store.list_audit()]
        assert "created" in audit_fields
        # Copilot round 4: reconciliation resolved the pre-existing UUID but
        # used to stop there, leaving the fake's stored credential at
        # "an original password 1" (the prior attempt's password) instead of
        # the one just submitted -- a 201 for a password that cannot log in.
        assert fake.stored_password(self.RETRY_EMAIL) == "a retried password 1"
        # Finding #1 (delta review): the rotation above kills the identity's
        # refresh tokens at Supabase, but a pre-existing ACCESS token is a
        # stateless JWT that keeps verifying locally until password_changed_at
        # moves -- without this, it would survive its full TTL and resolve,
        # via the external_id just linked, to the row this call just created.
        assert created.password_changed_at is not None

    def test_create_with_password_maps_gateway_failure_during_reconciled_password_set(
        self, supabase_app
    ):
        app, fake = supabase_app
        # Same prior-success-then-retry setup as above, but the
        # change_password call that must follow reconciliation fails at the
        # gateway (Copilot round 4).
        fake.register_user(
            self.RETRY_EMAIL, "an original password 1", uuid="fake-uuid-retry"
        )

        async def boom(_user_id, _password):
            raise SupabaseAuthError("rejected")

        fake.change_password = boom
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users",
            json={"email": self.RETRY_EMAIL, "password": "a retried password 1"},
            headers=headers,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "create_failed"
        assert app.state.user_store.get_by_email(self.RETRY_EMAIL) is None

    def test_create_with_password_maps_gateway_unavailable_during_reconciled_password_set(
        self, supabase_app
    ):
        app, fake = supabase_app
        fake.register_user(
            self.RETRY_EMAIL, "an original password 1", uuid="fake-uuid-retry"
        )

        async def boom(_user_id, _password):
            raise SupabaseUnavailableError("down")

        fake.change_password = boom
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users",
            json={"email": self.RETRY_EMAIL, "password": "a retried password 1"},
            headers=headers,
        )
        assert resp.status_code == 503
        assert app.state.user_store.get_by_email(self.RETRY_EMAIL) is None

    def test_create_with_password_422_when_gateway_has_no_matching_identity(
        self, supabase_app
    ):
        app, fake = supabase_app

        async def boom(_email, _password):
            raise SupabaseAuthError("rejected, no matching account exists")

        fake.create_user = boom
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users",
            json={"email": "nomatch@example.com", "password": "a password here 1"},
            headers=headers,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "create_failed"
        assert app.state.user_store.get_by_email("nomatch@example.com") is None

    def test_invite_reconciles_after_prior_success(self, supabase_app):
        app, fake = supabase_app
        # Same shape as the create-with-password case above, but for the
        # invite branch: a prior invite already succeeded remotely (still
        # pending -- never accepted), the local write failed transiently,
        # and this is the retry.
        fake.register_user(
            self.RETRY_EMAIL, "", uuid="fake-uuid-retry-invite", invite_pending=True
        )
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users", json={"email": self.RETRY_EMAIL}, headers=headers,
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["invited"] is True
        created = app.state.user_store.get_by_email(self.RETRY_EMAIL)
        assert created is not None
        assert created.external_id == "fake-uuid-retry-invite"
        audit_fields = [r["field"] for r in app.state.user_store.list_audit()]
        assert "invite" in audit_fields

    def test_invite_against_active_preexisting_identity_is_422_duplicate_email(
        self, supabase_app
    ):
        app, fake = supabase_app
        # An identity that already exists at Supabase but was never created
        # by this app's own invite flow (e.g. dashboard-created, or an
        # invite already accepted) -- invite_pending is False. Reconciling
        # onto it would let its old, operator-unknown password in without
        # ever proving the invitation was accepted, so this must fail
        # closed instead of linking.
        fake.register_user(
            "active-account@example.com", "an old password 1", uuid="fake-uuid-active"
        )
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users", json={"email": "active-account@example.com"}, headers=headers,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "duplicate_email"
        assert app.state.user_store.get_by_email("active-account@example.com") is None
        assert fake.invites == []

    def test_invite_422_when_gateway_has_no_matching_identity(self, supabase_app):
        app, fake = supabase_app

        async def boom(_email):
            raise SupabaseAuthError("rejected, no matching account exists")

        fake.invite_user = boom
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users", json={"email": "noinvitematch@example.com"},
            headers=headers,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "invite_failed"
        assert app.state.user_store.get_by_email("noinvitematch@example.com") is None

    def test_create_with_password_503_when_the_reconciliation_lookup_is_unavailable(
        self, supabase_app
    ):
        # Copilot round 4: _resolve_after_duplicate_rejection's own
        # get_user_by_email call ran unwrapped inside the caller's
        # `except SupabaseAuthError` block, so a SupabaseUnavailableError
        # raised by the LOOKUP itself (as opposed to the original
        # create_user call) escaped both routes' except clauses entirely
        # and surfaced as an unhandled 500 instead of the generic 503 every
        # other gateway-unavailable case maps to.
        app, fake = supabase_app

        async def create_boom(_email, _password):
            raise SupabaseAuthError("rejected, ambiguous duplicate")

        async def lookup_boom(_email):
            raise SupabaseUnavailableError("down")

        fake.create_user = create_boom
        fake.get_user_by_email = lookup_boom
        client = TestClient(app)
        headers = _admin_bearer(client)
        resp = client.post(
            "/api/admin/users",
            json={"email": "lookupdown@example.com", "password": "a password here 1"},
            headers=headers,
        )
        assert resp.status_code == 503
        assert app.state.user_store.get_by_email("lookupdown@example.com") is None


class TestAdminPatchPasswordSupabase:
    """PATCH /admin/users/{id} with a password, in supabase mode (finding 1,
    final review): must rotate the credential at Supabase, kill the
    target's outstanding refresh token, bump password_changed_at locally,
    and write NO local hash -- the local-mode branch (bcrypt + set_password)
    must never run here."""

    OLD_PASSWORD = "an initial password 1"
    NEW_PASSWORD = "a replacement password 1"

    def _make_user(self, client, headers, email="target@example.com"):
        resp = client.post(
            "/api/admin/users",
            json={"email": email, "password": self.OLD_PASSWORD},
            headers=headers,
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    def test_old_password_and_refresh_token_are_dead_after_reset(self, supabase_app):
        app, _fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        created = self._make_user(client, headers)
        login = client.post(
            "/api/auth/login",
            json={"email": created["email"], "password": self.OLD_PASSWORD},
        )
        assert login.status_code == 200
        refresh_token = login.json()["refresh_token"]

        resp = client.patch(
            f"/api/admin/users/{created['id']}",
            json={"password": self.NEW_PASSWORD},
            headers=headers,
        )
        assert resp.status_code == 200

        stale_login = client.post(
            "/api/auth/login",
            json={"email": created["email"], "password": self.OLD_PASSWORD},
        )
        assert stale_login.status_code == 401

        stale_refresh = client.post(
            "/api/auth/refresh", json={"refresh_token": refresh_token},
        )
        assert stale_refresh.status_code == 401

        fresh_login = client.post(
            "/api/auth/login",
            json={"email": created["email"], "password": self.NEW_PASSWORD},
        )
        assert fresh_login.status_code == 200

    def test_password_changed_at_bumped_and_no_local_hash_written(self, supabase_app):
        app, _fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        created = self._make_user(client, headers)
        assert created["password_changed_at"] is None

        resp = client.patch(
            f"/api/admin/users/{created['id']}",
            json={"password": self.NEW_PASSWORD},
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["password_changed_at"] is not None
        assert (
            body["password_changed_at"]
            == app.state.user_store.get_user(created["id"]).password_changed_at
        )
        # No local hash: Supabase owns the credential.
        assert (
            app.state.user_store.verify_credentials(created["email"], self.NEW_PASSWORD)
            is None
        )

    def test_writes_one_audit_row_without_logging_the_password(self, supabase_app):
        app, _fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        created = self._make_user(client, headers)

        resp = client.patch(
            f"/api/admin/users/{created['id']}",
            json={"password": self.NEW_PASSWORD},
            headers=headers,
        )
        assert resp.status_code == 200
        rows = [
            r for r in app.state.user_store.list_audit()
            if r["field"] == "password" and r["target_id"] == created["id"]
        ]
        assert len(rows) == 1
        assert rows[0]["old_value"] is None and rows[0]["new_value"] is None

    def test_gateway_auth_error_maps_to_422_and_writes_no_hash(self, supabase_app):
        app, fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        created = self._make_user(client, headers)

        async def boom(_user_id, _password):
            raise SupabaseAuthError("rejected")

        fake.change_password = boom
        resp = client.patch(
            f"/api/admin/users/{created['id']}",
            json={"password": self.NEW_PASSWORD},
            headers=headers,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "password_reset_failed"
        assert (
            app.state.user_store.verify_credentials(created["email"], self.NEW_PASSWORD)
            is None
        )

    def test_gateway_unavailable_maps_to_503(self, supabase_app):
        app, fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        created = self._make_user(client, headers)

        async def boom(_user_id, _password):
            raise SupabaseUnavailableError("down")

        fake.change_password = boom
        resp = client.patch(
            f"/api/admin/users/{created['id']}",
            json={"password": self.NEW_PASSWORD},
            headers=headers,
        )
        assert resp.status_code == 503

    def test_unlinked_row_password_patch_is_422_not_linked_without_calling_the_gateway(
        self, supabase_app
    ):
        # Finding #5 (delta review): a row with no external_id (predates the
        # mode switch, or was hand-created) has nothing to rotate --
        # sending user_id=None to GoTrue's admin API used to fail only
        # incidentally, via _execute's generic (AuthError, ValueError)
        # mapping. The explicit guard must fire BEFORE any gateway call, not
        # just produce the same status code the incidental path happened to.
        app, fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        unlinked = app.state.user_store.create_user("unlinked@example.com", None)
        assert unlinked.external_id is None
        calls = []

        async def spy(*args):
            calls.append(args)
            raise SupabaseAuthError("must not be reached")

        fake.change_password = spy

        resp = client.patch(
            f"/api/admin/users/{unlinked.id}",
            json={"password": self.NEW_PASSWORD},
            headers=headers,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "not_linked"
        assert calls == []

    def test_mixed_patch_with_failing_rotation_leaves_tier_and_audit_untouched(
        self, supabase_app
    ):
        # finding 3 (Copilot round 1): tier + password used to apply the
        # tier (and its audit row) BEFORE the awaited Supabase rotation --
        # a {tier, password} PATCH that failed at Supabase still moved the
        # tier. Rotation must now run first, with no local write on failure.
        app, fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        created = self._make_user(client, headers)
        assert created["tier"] == "basic"
        audit_before = len(app.state.user_store.list_audit())

        async def boom(_user_id, _password):
            raise SupabaseAuthError("rejected")

        fake.change_password = boom
        resp = client.patch(
            f"/api/admin/users/{created['id']}",
            json={"tier": "premium", "password": self.NEW_PASSWORD},
            headers=headers,
        )
        assert resp.status_code == 422
        after = app.state.user_store.get_user(created["id"])
        assert after.tier == "basic"
        assert after.password_changed_at is None
        assert len(app.state.user_store.list_audit()) == audit_before

    def test_mixed_patch_happy_path_applies_both(self, supabase_app):
        app, _fake = supabase_app
        client = TestClient(app)
        headers = _admin_bearer(client)
        created = self._make_user(client, headers)

        resp = client.patch(
            f"/api/admin/users/{created['id']}",
            json={"tier": "premium", "password": self.NEW_PASSWORD},
            headers=headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["tier"] == "premium"
        assert body["password_changed_at"] is not None
