"""SupabaseAuthGateway over canned GoTrue responses (httpx.MockTransport)."""

import json

import httpx
import pytest

from app.core.supabase_auth import SupabaseCredentials
from app.services.supabase_gateway import (
    SupabaseAuthError,
    SupabaseAuthGateway,
    SupabaseSession,
    SupabaseUnavailableError,
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

    async def test_malformed_uuid_maps_to_auth_error_not_500(self):
        # The library's validate_uuid raises a bare ValueError before any
        # request is made; the mapper must translate it, or a malformed
        # subject becomes a 500 in production.
        def handler(request):  # pragma: no cover - never reached
            raise AssertionError("no request should be made")

        with pytest.raises(SupabaseAuthError):
            await gateway_with(handler).change_password("not-a-uuid", "new-password-1")


class TestConfirm:
    async def test_confirm_verifies_then_updates_password(self):
        order = []

        def handler(request):
            if request.url.path.endswith("/verify"):
                order.append("verify")
                return httpx.Response(200, json=SESSION_JSON)
            order.append("update")
            assert request.url.path.endswith("/admin/users/" + USER_UUID)
            assert json.loads(request.content)["password"] == "new-password-1"
            return httpx.Response(200, json=SESSION_JSON["user"])

        session = await gateway_with(handler).confirm_with_token_hash(
            "hash-1", "recovery", "new-password-1"
        )
        assert order == ["verify", "update"]
        assert session.access_token == "at-1"
