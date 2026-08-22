"""Read-only activity/usage series endpoints (B40, #124).

Aggregation itself is covered by test_usage_activity.py against
UsageStore.activity_series/activity_user_totals directly; this module only
exercises the router's authz, shaping, and validation.
"""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.conftest import SECOND_USER_EMAIL, auth_headers, second_user_headers

_run_counter = 0


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    return TestClient(create_app(settings))


def _seed_row(store, *, user_id, day, status="completed", source="check",
              input_tokens=100, output_tokens=40, credits=5):
    global _run_counter
    _run_counter += 1
    run_id = f"activity-api-run-{_run_counter}"
    with store.db.connect() as conn:
        conn.execute(
            """INSERT INTO llm_usage (user_id, day, created_at, status,
                   provider, model, text_chars, input_tokens, output_tokens,
                   source, run_id, credits)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user_id,
                day,
                f"{day}T00:00:00+00:00",
                status,
                "p",
                "m",
                0,
                input_tokens,
                output_tokens,
                source,
                run_id,
                credits,
            ),
        )


class TestAuthz:
    def test_anonymous_gets_401_on_all_three(self, client):
        for path in (
            "/api/usage/activity",
            "/api/usage/activity/all",
            "/api/usage/activity/1",
        ):
            assert client.get(path).status_code == 401

    def test_regular_user_can_see_own_but_not_admin_views(self, client):
        headers = second_user_headers(client)
        assert client.get("/api/usage/activity", headers=headers).status_code == 200
        assert client.get("/api/usage/activity/all", headers=headers).status_code == 403
        assert client.get("/api/usage/activity/1", headers=headers).status_code == 403

    def test_admin_can_see_all_three(self, client):
        headers = auth_headers(client)
        assert client.get("/api/usage/activity", headers=headers).status_code == 200
        assert client.get("/api/usage/activity/all", headers=headers).status_code == 200
        assert client.get("/api/usage/activity/1", headers=headers).status_code == 200


class TestShape:
    def test_self_series_shape(self, client):
        headers = second_user_headers(client)
        r = client.get("/api/usage/activity?days=30", headers=headers)
        assert r.status_code == 200
        body = r.json()
        assert len(body["days"]) == 30
        assert set(body["series"]["runs"]) == {"check", "suggestion", "name", "failed"}
        assert all(len(v) == 30 for v in body["series"]["runs"].values())
        assert len(body["series"]["input_tokens"]) == 30
        assert isinstance(body["series"]["credits"][0], int)
        # Omitted entirely, not null: the spec reserves per_user for /all —
        # ActivityResponse (own/{user_id}) does not declare the field at
        # all, so a wholesale revert to an Optional-with-null-default field
        # on the shared model fails this.
        assert "per_user" not in body

    def test_user_activity_omits_per_user(self, client):
        admin_hdrs = auth_headers(client)
        second_user_headers(client)  # provisions second@example.com
        user = client.app.state.user_store.get_by_email(SECOND_USER_EMAIL)
        assert user is not None

        r = client.get(f"/api/usage/activity/{user.id}?days=30", headers=admin_hdrs)
        assert r.status_code == 200
        assert "per_user" not in r.json()

    def test_all_has_per_user_with_identity(self, client):
        admin_hdrs = auth_headers(client)
        second_user_headers(client)  # provisions second@example.com
        user = client.app.state.user_store.get_by_email(SECOND_USER_EMAIL)
        assert user is not None
        today = datetime.now(UTC).date().isoformat()
        _seed_row(client.app.state.usage_store, user_id=user.id, day=today)

        r = client.get("/api/usage/activity/all", headers=admin_hdrs)
        assert r.status_code == 200
        body = r.json()
        per_user = {row["user_id"]: row for row in body["per_user"]}
        assert user.id in per_user
        assert per_user[user.id]["email"] == SECOND_USER_EMAIL
        assert per_user[user.id]["display_name"] == user.display_name
        assert per_user[user.id]["runs"] == 1

    def test_days_validation(self, client):
        headers = auth_headers(client)
        r = client.get("/api/usage/activity?days=31", headers=headers)
        assert r.status_code == 422

    def test_unknown_user_404(self, client):
        headers = auth_headers(client)
        r = client.get("/api/usage/activity/99999", headers=headers)
        assert r.status_code == 404

    def test_all_not_shadowed(self, client):
        # ADMIN headers, assert 200: a non-admin would 403 before path
        # parsing, and mutation 3 (route reorder -> 422, "all" parsed as a
        # user id) would be invisible under a non-admin caller.
        headers = auth_headers(client)
        r = client.get("/api/usage/activity/all", headers=headers)
        assert r.status_code == 200
