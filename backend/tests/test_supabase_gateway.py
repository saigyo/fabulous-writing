"""SupabaseAuthGateway over canned GoTrue responses (httpx.MockTransport)."""

import json

import httpx
import pytest

from app.core.supabase_auth import SupabaseCredentials
from app.services.supabase_gateway import (
    SupabaseAuthError,
    SupabaseAuthGateway,
    SupabaseEmailExistsError,
    SupabaseSession,
    SupabaseUnavailableError,
    SupabaseUserSummary,
    SupabaseWeakPasswordError,
)

CREDS = SupabaseCredentials(
    url="https://gw-test.invalid",
    publishable_key="sb_publishable_gw",
    secret_key="sb_secret_gw",
)

USER_UUID = "11111111-1111-4111-8111-111111111111"
OTHER_UUID = "22222222-2222-4222-8222-222222222222"

SESSION_JSON = {
    "access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600,
    "expires_at": 1_900_000_000, "token_type": "bearer",
    "user": {"id": USER_UUID, "email": "a@example.com", "aud": "authenticated",
             "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"},
}

GOTRUE_WEAK_PASSWORD_BODY = {
    "code": 422,
    "error_code": "weak_password",
    "msg": "Password should be at least 6 characters.",
    "weak_password": {"reasons": ["length"]},
}


def gateway_with(handler):
    return SupabaseAuthGateway(CREDS, transport=httpx.MockTransport(handler))


class TestSignIn:
    async def test_success_maps_session(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["apikey"] = request.headers.get("apikey")
            seen["auth"] = request.headers.get("Authorization")
            return httpx.Response(200, json=SESSION_JSON)

        session = await gateway_with(handler).sign_in("a@example.com", "pw")
        assert session == SupabaseSession(
            access_token="at-1", refresh_token="rt-1",
            expires_at=1_900_000_000, user_id=USER_UUID, email="a@example.com",
        )
        assert "/auth/v1/token" in seen["url"] and "grant_type=password" in seen["url"]
        assert seen["apikey"] == "sb_publishable_gw"  # user flow: publishable key
        # Both headers, like supabase-py's reference client — a missing
        # Authorization passes MockTransport but fails the live gateway.
        assert seen["auth"] == "Bearer sb_publishable_gw"

    async def test_invalid_credentials_raise_auth_error(self):
        def handler(request):
            return httpx.Response(400, json={
                "error_code": "invalid_credentials",
                "code": 400, "msg": "Invalid login credentials",
            })

        with pytest.raises(SupabaseAuthError):
            await gateway_with(handler).sign_in("a@example.com", "wrong")

    async def test_network_failure_raises_unavailable(self):
        def handler(request):
            raise httpx.ConnectError("boom")

        with pytest.raises(SupabaseUnavailableError):
            await gateway_with(handler).sign_in("a@example.com", "pw")


class TestAdminCalls:
    async def test_create_user_uses_secret_key_and_returns_uuid(self):
        seen = {}

        def handler(request):
            seen["auth"] = request.headers.get("Authorization")
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=SESSION_JSON["user"])

        uuid = await gateway_with(handler).create_user("a@example.com", "pw-12chars-min")
        assert uuid == USER_UUID
        assert seen["auth"] == "Bearer sb_secret_gw"
        assert seen["body"].get("email_confirm") is True

    async def test_invite_user_returns_uuid(self):
        def handler(request):
            assert request.url.path.endswith("/invite")
            return httpx.Response(200, json=SESSION_JSON["user"])

        assert await gateway_with(handler).invite_user("a@example.com") == USER_UUID

    async def test_invite_user_email_exists_maps_to_email_exists_error(self):
        def handler(request):
            return httpx.Response(422, json={
                "code": 422, "error_code": "email_exists",
                "msg": "A user with this email address has already been registered",
            })

        with pytest.raises(SupabaseEmailExistsError) as exc_info:
            await gateway_with(handler).invite_user("a@example.com")
        assert isinstance(exc_info.value, SupabaseAuthError)  # base still catches it

    async def test_get_user_id_by_email_pages_until_found(self):
        calls = []

        def handler(request):
            page = int(dict(request.url.params).get("page", "1"))
            calls.append(page)
            users = (
                [{**SESSION_JSON["user"], "id": OTHER_UUID, "email": "x@example.com"}]
                if page == 1
                else [{**SESSION_JSON["user"], "id": USER_UUID, "email": "A@example.com"}]
                if page == 2
                else []
            )
            return httpx.Response(200, json={"users": users, "aud": "authenticated"})

        found = await gateway_with(handler).get_user_id_by_email("a@example.com")
        assert found == USER_UUID and calls == [1, 2]

    async def test_get_user_id_by_email_exhausts_to_none(self):
        def handler(request):
            return httpx.Response(200, json={"users": [], "aud": "authenticated"})

        assert await gateway_with(handler).get_user_id_by_email("a@example.com") is None

    async def test_get_user_by_email_pending_invite_true(self):
        # GoTrue sets invited_at when admin.invite_user_by_email mints the
        # identity, and last_sign_in_at stays unset until the invitee
        # actually logs in -- exactly the "invited, not yet accepted" state
        # reconciliation must require proof of.
        def handler(request):
            user = {
                **SESSION_JSON["user"],
                "invited_at": "2026-01-01T00:00:00Z",
                "last_sign_in_at": None,
            }
            return httpx.Response(200, json={"users": [user], "aud": "authenticated"})

        found = await gateway_with(handler).get_user_by_email("a@example.com")
        assert found == SupabaseUserSummary(id=USER_UUID, invite_pending=True)

    async def test_get_user_by_email_already_signed_in_is_not_pending(self):
        # invited_at set but the invitee has since signed in at least once
        # -- the invitation was already accepted, not stranded.
        def handler(request):
            user = {
                **SESSION_JSON["user"],
                "invited_at": "2026-01-01T00:00:00Z",
                "last_sign_in_at": "2026-01-02T00:00:00Z",
            }
            return httpx.Response(200, json={"users": [user], "aud": "authenticated"})

        found = await gateway_with(handler).get_user_by_email("a@example.com")
        assert found == SupabaseUserSummary(id=USER_UUID, invite_pending=False)

    async def test_get_user_by_email_never_invited_is_not_pending(self):
        # No invited_at at all: created directly (admin.create_user, the
        # dashboard, a direct signup), never through this app's invite flow.
        def handler(request):
            user = {**SESSION_JSON["user"], "invited_at": None, "last_sign_in_at": None}
            return httpx.Response(200, json={"users": [user], "aud": "authenticated"})

        found = await gateway_with(handler).get_user_by_email("a@example.com")
        assert found == SupabaseUserSummary(id=USER_UUID, invite_pending=False)

    async def test_get_user_by_email_exhausts_to_none(self):
        def handler(request):
            return httpx.Response(200, json={"users": [], "aud": "authenticated"})

        assert await gateway_with(handler).get_user_by_email("a@example.com") is None

    async def test_get_user_by_email_returns_provider_from_app_metadata(self):
        # app_metadata.provider names whichever identity provider minted
        # the account -- reconciliation callers (seed_admin, admin.py) need
        # this to tell an OAuth-origin identity apart from one this app's
        # own email/password flow created.
        def handler(request):
            user = {
                **SESSION_JSON["user"],
                "app_metadata": {"provider": "google", "providers": ["google"]},
            }
            return httpx.Response(200, json={"users": [user], "aud": "authenticated"})

        found = await gateway_with(handler).get_user_by_email("a@example.com")
        assert found.provider == "google"

    async def test_get_user_by_email_provider_none_when_absent(self):
        # No provider key in app_metadata at all -- treated as "not proven
        # email" by callers, not silently assumed to be email.
        def handler(request):
            return httpx.Response(200, json={"users": [SESSION_JSON["user"]], "aud": "authenticated"})

        found = await gateway_with(handler).get_user_by_email("a@example.com")
        assert found.provider is None

    async def test_malformed_uuid_maps_to_auth_error_not_500(self):
        # The library's validate_uuid raises a bare ValueError before any
        # request is made; the mapper must translate it, or a malformed
        # subject becomes a 500 in production.
        def handler(request):  # pragma: no cover - never reached
            raise AssertionError("no request should be made")

        with pytest.raises(SupabaseAuthError):
            await gateway_with(handler).change_password("not-a-uuid", "new-password-1")


class TestChangePassword:
    async def test_change_password_maps_weak_password_with_reasons(self):
        def handler(request):
            return httpx.Response(422, json=GOTRUE_WEAK_PASSWORD_BODY)

        gateway = gateway_with(handler)
        with pytest.raises(SupabaseWeakPasswordError) as exc_info:
            await gateway.change_password(USER_UUID, "abc")
        assert exc_info.value.reasons == ["length"]
        assert isinstance(exc_info.value, SupabaseAuthError)  # base still catches it

    async def test_weak_password_reasons_coerced_to_list_when_absent(self):
        # Body omits weak_password.reasons entirely: supabase-auth then
        # passes {} as reasons -- the gateway must coerce to [].
        body = {**GOTRUE_WEAK_PASSWORD_BODY, "weak_password": {}}

        def handler(request):
            return httpx.Response(422, json=body)

        gateway = gateway_with(handler)
        with pytest.raises(SupabaseWeakPasswordError) as exc_info:
            await gateway.change_password(USER_UUID, "abc")
        assert exc_info.value.reasons == []


class TestVerifyTokenHash:
    async def test_verify_token_hash_returns_session_without_touching_password(self):
        requests = []

        def handler(request):
            requests.append(request.url.path)
            assert request.url.path.endswith("/verify")
            return httpx.Response(200, json=SESSION_JSON)

        session = await gateway_with(handler).verify_token_hash("hash-1", "recovery")
        assert session == SupabaseSession(
            access_token="at-1", refresh_token="rt-1",
            expires_at=1_900_000_000, user_id=USER_UUID, email="a@example.com",
        )
        # The old confirm_with_token_hash issued a PUT to admin/users/{id}
        # afterward -- this must not.
        assert all("/admin/users/" not in path for path in requests)


class TestGetEnabledExternalProviders:
    async def test_returns_enabled_names_sorted_using_publishable_key(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["apikey"] = request.headers.get("apikey")
            return httpx.Response(200, json={
                "external": {
                    "email": True, "phone": False,
                    "google": True, "github": False,
                },
                "disable_signup": False,
            })

        found = await gateway_with(handler).get_enabled_external_providers()
        assert found == ["email", "google"]
        assert seen["url"].endswith("/auth/v1/settings")
        # Public endpoint: the publishable key, never the secret key.
        assert seen["apikey"] == "sb_publishable_gw"

    async def test_no_providers_enabled_returns_empty_list(self):
        def handler(request):
            return httpx.Response(200, json={"external": {"email": False, "google": False}})

        assert await gateway_with(handler).get_enabled_external_providers() == []

    async def test_network_failure_raises_unavailable(self):
        def handler(request):
            raise httpx.ConnectError("boom")

        with pytest.raises(SupabaseUnavailableError):
            await gateway_with(handler).get_enabled_external_providers()

    async def test_server_error_raises_unavailable(self):
        def handler(request):
            return httpx.Response(500, json={"msg": "internal error"})

        with pytest.raises(SupabaseUnavailableError):
            await gateway_with(handler).get_enabled_external_providers()

    async def test_malformed_body_raises_unavailable(self):
        def handler(request):
            return httpx.Response(200, content=b"not json")

        with pytest.raises(SupabaseUnavailableError):
            await gateway_with(handler).get_enabled_external_providers()
