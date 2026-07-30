from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def build(tmp_path: Path, *, allow_additional_admins: bool = False) -> TestClient:
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        auth={"allow_additional_admins": allow_additional_admins},
    )
    return TestClient(create_app(settings))


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return build(tmp_path)


def admin_headers(client: TestClient) -> dict:
    token = client.post(
        "/api/auth/login",
        json={"email": "root@example.com", "password": "bootstrap password"},
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def make_user(client: TestClient, email="ada@example.com", **extra) -> dict:
    response = client.post(
        "/api/admin/users",
        json={"email": email, "password": "an initial password", **extra},
        headers=admin_headers(client),
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_admin_endpoints_require_an_admin(client):
    assert client.get("/api/admin/users").status_code == 401
    make_user(client)
    normal = client.post(
        "/api/auth/login",
        json={"email": "ada@example.com", "password": "an initial password"},
    ).json()["token"]
    response = client.get(
        "/api/admin/users", headers={"Authorization": f"Bearer {normal}"}
    )
    assert response.status_code == 403


def test_list_and_create(client):
    created = make_user(client, display_name="Ada", tier="premium")
    assert created["email"] == "ada@example.com" and created["tier"] == "premium"
    # "password" alone would also match the new password_changed_at field,
    # which is just a timestamp, not credential material; password_hash is
    # what must never leak (same convention as test_auth_api.py). That
    # substring check also used to catch the plaintext password echoing
    # back in the response (make_user submits "an initial password") — a
    # separate property from the hash never leaking, so it is asserted here
    # explicitly rather than folded into the hash check.
    assert "password_hash" not in str(created)
    assert "an initial password" not in str(created)
    listing = client.get("/api/admin/users", headers=admin_headers(client)).json()
    assert [u["email"] for u in listing] == ["ada@example.com", "root@example.com"]


def test_create_rejects_duplicates_and_weak_passwords(client):
    make_user(client)
    duplicate = client.post(
        "/api/admin/users",
        json={"email": "ADA@example.com", "password": "an initial password"},
        headers=admin_headers(client),
    )
    assert duplicate.status_code == 422
    weak = client.post(
        "/api/admin/users",
        json={"email": "new@example.com", "password": "short"},
        headers=admin_headers(client),
    )
    assert weak.status_code == 422
    assert "at least 12" in weak.json()["detail"]


def test_create_rejects_whitespace_only_email(client):
    # Round-2 added whitespace stripping to UserStore, but nothing rejected
    # an email that is only whitespace: it normalized to '', so an admin
    # could create an addressless, still-loginable account. Must be
    # rejected outright, and no user created.
    response = client.post(
        "/api/admin/users",
        json={"email": "   ", "password": "an initial password"},
        headers=admin_headers(client),
    )
    assert response.status_code == 422
    listing = client.get("/api/admin/users", headers=admin_headers(client)).json()
    assert [u["email"] for u in listing] == ["root@example.com"]


def test_create_strips_surrounding_whitespace_from_a_real_email(client):
    # Round-2's whitespace stripping must not regress: an email with
    # legitimate surrounding whitespace still creates a normal, loginable
    # account, distinct from the whitespace-only case above.
    created = make_user(client, email="  ada@example.com  ")
    assert created["email"] == "ada@example.com"
    assert client.post(
        "/api/auth/login",
        json={"email": "ada@example.com", "password": "an initial password"},
    ).status_code == 200


def test_unknown_tier_is_rejected(client):
    # An unrecognised tier would be an authorization state no policy covers,
    # so it must never reach the database.
    headers = admin_headers(client)
    created = client.post(
        "/api/admin/users",
        json={"email": "new@example.com", "password": "an initial password",
              "tier": "premum"},
        headers=headers,
    )
    assert created.status_code == 422
    user = make_user(client)
    patched = client.patch(
        f"/api/admin/users/{user['id']}", json={"tier": "gold"}, headers=headers
    )
    assert patched.status_code == 422


def test_patch_updates_fields_and_writes_one_audit_row_per_field(client):
    user = make_user(client)
    response = client.patch(
        f"/api/admin/users/{user['id']}",
        json={"tier": "premium", "is_active": False},
        headers=admin_headers(client),
    )
    assert response.status_code == 200
    assert response.json()["tier"] == "premium"
    assert response.json()["is_active"] is False
    rows = client.app.state.user_store.list_audit()
    changed = {(r["field"], r["old_value"], r["new_value"]) for r in rows}
    assert ("tier", "basic", "premium") in changed
    assert ("is_active", "True", "False") in changed
    assert all(r["actor_id"] == 1 for r in rows)


def test_patch_can_reset_a_password_without_logging_it(client):
    user = make_user(client)
    assert user["password_changed_at"] is None
    response = client.patch(
        f"/api/admin/users/{user['id']}",
        json={"password": "a replacement password"},
        headers=admin_headers(client),
    )
    assert response.status_code == 200
    # The response is the endpoint's contract (it returns User directly), so
    # password_changed_at must reflect the reset that just happened, not the
    # stale/null value fetched before set_password() ran.
    body = response.json()
    assert body["password_changed_at"] is not None
    assert (
        body["password_changed_at"]
        == client.app.state.user_store.get_user(user["id"]).password_changed_at
    )
    assert client.post(
        "/api/auth/login",
        json={"email": "ada@example.com", "password": "a replacement password"},
    ).status_code == 200
    rows = [r for r in client.app.state.user_store.list_audit() if r["field"] == "password"]
    assert len(rows) == 1
    assert rows[0]["old_value"] is None and rows[0]["new_value"] is None


def test_admin_cannot_lock_itself_out(client):
    headers = admin_headers(client)
    for payload in ({"is_admin": False}, {"is_active": False}):
        response = client.patch("/api/admin/users/1", json=payload, headers=headers)
        assert response.status_code == 409


def test_switch_blocks_admin_creation_and_promotion(client, caplog):
    with caplog.at_level("WARNING"):
        created = client.post(
            "/api/admin/users",
            json={"email": "second@example.com", "password": "an initial password",
                  "is_admin": True},
            headers=admin_headers(client),
        )
    assert created.status_code == 403
    assert "admin" in caplog.text.lower()
    user = make_user(client)
    promoted = client.patch(
        f"/api/admin/users/{user['id']}",
        json={"is_admin": True},
        headers=admin_headers(client),
    )
    assert promoted.status_code == 403


def test_demotion_is_allowed_even_while_the_switch_is_off(tmp_path):
    # Demotion only ever reduces privilege, so the switch must not block it.
    client = build(tmp_path, allow_additional_admins=True)
    second = client.post(
        "/api/admin/users",
        json={"email": "second@example.com", "password": "an initial password",
              "is_admin": True},
        headers=admin_headers(client),
    ).json()
    locked = build(tmp_path)  # same DB, switch now off
    response = locked.patch(
        f"/api/admin/users/{second['id']}",
        json={"is_admin": False},
        headers=admin_headers(locked),
    )
    assert response.status_code == 200 and response.json()["is_admin"] is False


def test_switch_on_permits_creation(tmp_path):
    client = build(tmp_path, allow_additional_admins=True)
    response = client.post(
        "/api/admin/users",
        json={"email": "second@example.com", "password": "an initial password",
              "is_admin": True},
        headers=admin_headers(client),
    )
    assert response.status_code == 201 and response.json()["is_admin"] is True


def test_no_admin_endpoint_can_raise_the_ceiling(client):
    # spec §10: the admin ceiling's value comes only from config. A `limits`
    # key in the PATCH body has no corresponding field on UserPatch, so
    # pydantic's default extra="ignore" drops it silently; the endpoint must
    # not raise the ceiling for the admin either way, and a subsequent /me
    # must still report the unchanged config value.
    headers = admin_headers(client)
    response = client.patch(
        "/api/admin/users/1",
        json={"limits": {"credits_per_day": 999999999}},
        headers=headers,
    )
    assert response.status_code == 200
    assert "limits" not in response.json()
    me = client.get("/api/auth/me", headers=headers).json()
    admin_limits = client.app.state.settings.limits.admin
    assert me["usage"]["windows"] == [{"window": "day", "used_percent": 0}]
    assert me["limits"]["max_llm_document_chars"] == admin_limits.max_llm_document_chars
    assert me["limits"]["concurrent_llm_runs"] == admin_limits.concurrent_llm_runs


def test_patch_explicit_null_clears_a_field_and_writes_an_audit_row(client):
    # `{"display_name": null}` is the natural way to clear a display name.
    # It must not be indistinguishable from omitting the field entirely.
    headers = admin_headers(client)
    user = make_user(client, display_name="Ada")
    response = client.patch(
        f"/api/admin/users/{user['id']}",
        json={"display_name": None},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["display_name"] is None
    rows = [r for r in client.app.state.user_store.list_audit() if r["field"] == "display_name"]
    assert len(rows) == 1
    assert rows[0]["old_value"] == "Ada" and rows[0]["new_value"] == "None"


def test_patch_omitted_field_is_left_untouched(client):
    headers = admin_headers(client)
    user = make_user(client, display_name="Ada")
    response = client.patch(
        f"/api/admin/users/{user['id']}",
        json={"tier": "premium"},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["display_name"] == "Ada"


def test_patch_resubmitting_the_current_value_writes_no_audit_row(client):
    headers = admin_headers(client)
    user = make_user(client, tier="basic")
    response = client.patch(
        f"/api/admin/users/{user['id']}",
        json={"tier": "basic"},
        headers=headers,
    )
    assert response.status_code == 200
    rows = [r for r in client.app.state.user_store.list_audit() if r["field"] == "tier"]
    assert rows == []


@pytest.mark.parametrize("field", ["tier", "is_admin", "is_active"])
def test_patch_rejects_explicit_null_for_non_nullable_fields(client, field):
    headers = admin_headers(client)
    user = make_user(client)
    response = client.patch(
        f"/api/admin/users/{user['id']}",
        json={field: None},
        headers=headers,
    )
    assert response.status_code == 422


def test_default_names_accepted_without_tiers_block(client):
    # No tiers: block configured, so the spec's two default names remain
    # assignable (create validates the default "basic" too).
    headers = admin_headers(client)
    created = make_user(client, tier="premium")
    assert created["tier"] == "premium"
    patched = client.patch(
        f"/api/admin/users/{created['id']}", json={"tier": "basic"}, headers=headers
    )
    assert patched.status_code == 200
    assert patched.json()["tier"] == "basic"


def test_configured_names_replace_defaults(tmp_path):
    client = TestClient(
        create_app(
            Settings(
                db_path=tmp_path / "test.db",
                rules_dir=tmp_path / "rules",
                tiers={"gold": {"llm": {}, "limits": {
                    "credits_per_day": 1_000_000, "max_llm_document_chars": 100000,
                    "concurrent_llm_runs": 5,
                }}},
            )
        )
    )
    headers = admin_headers(client)
    ok = client.post(
        "/api/admin/users",
        json={"email": "ada@example.com", "password": "an initial password",
              "tier": "gold"},
        headers=headers,
    )
    assert ok.status_code == 201

    rejected = client.post(
        "/api/admin/users",
        json={"email": "second@example.com", "password": "an initial password",
              "tier": "basic"},
        headers=headers,
    )
    assert rejected.status_code == 422
    assert "gold" in rejected.json()["detail"]

    patched = client.patch(
        f"/api/admin/users/{ok.json()['id']}", json={"tier": "premium"}, headers=headers
    )
    assert patched.status_code == 422
    assert "gold" in patched.json()["detail"]


class TestListTiers:
    def test_returns_config_tier_names(self, tmp_path):
        settings = Settings(
            db_path=tmp_path / "test.db",
            rules_dir=tmp_path / "rules",
            tiers={"gold": {"llm": {}, "limits": {
                "credits_per_day": 1_000_000, "max_llm_document_chars": 100000,
                "concurrent_llm_runs": 5,
            }}},
        )
        client = TestClient(create_app(settings))
        headers = admin_headers(client)
        response = client.get("/api/admin/tiers", headers=headers)
        assert response.status_code == 200
        assert response.json() == list(settings.tiers)

    def test_defaults_when_no_tiers_configured(self, client):
        headers = admin_headers(client)
        response = client.get("/api/admin/tiers", headers=headers)
        assert response.status_code == 200
        assert response.json() == ["basic", "premium"]

    def test_non_admin_is_403(self, client):
        from tests.conftest import second_user_headers
        second = second_user_headers(client)
        response = client.get("/api/admin/tiers", headers=second)
        assert response.status_code == 403
