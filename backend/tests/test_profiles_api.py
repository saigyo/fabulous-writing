import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.conftest import auth_headers, second_user_headers


@pytest.fixture()
def client(tmp_path):
    settings = Settings(db_path=tmp_path / "test.db", seed_terminology=False)
    client = TestClient(create_app(settings))
    client.headers.update(auth_headers(client))
    return client


def _standard(client, language="en"):
    profiles = client.get(f"/api/profiles?language={language}").json()
    return next(p for p in profiles if p["is_standard"])


def test_list_profiles_contains_seeded(client):
    profiles = client.get("/api/profiles?language=de").json()
    names = [p["name"] for p in profiles]
    assert "Standard" in names and "Marketing" in names


def test_create_update_delete_profile(client):
    # "Blog" is now a seeded example name for EN; use a name that doesn't collide.
    created = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Notes", "llm_provider": "ollama"},
    )
    assert created.status_code == 201
    pid = created.json()["id"]

    updated = client.put(
        f"/api/profiles/{pid}",
        json={"name": "Blog posts", "categories_off": ["vividness"],
              "rule_exceptions": [], "packs_on": [], "domain_ids": [],
              "llm_provider": "ollama", "llm_model": None, "llm_tier": None,
              "llm_instructions": "Casual tone.", "example_text": "Sample."},
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Blog posts"

    assert client.delete(f"/api/profiles/{pid}").status_code == 204
    assert client.delete(f"/api/profiles/{pid}").status_code == 404


def test_duplicate_name_conflict(client):
    # Creating a profile named "Standard" no longer conflicts with the
    # global built-in — a caller's own profiles live in a separate
    # partition and may shadow a global name (ownership model, Task 3).
    # The remaining invariant is uniqueness within one owner's partition.
    body = {"language": "en", "name": "Notes", "llm_provider": "ollama"}
    assert client.post("/api/profiles", json=body).status_code == 201
    assert client.post("/api/profiles", json=body).status_code == 409


def test_standard_guards(client):
    std = _standard(client)
    assert client.delete(f"/api/profiles/{std['id']}").status_code == 409
    renamed = dict(std, name="Renamed")
    renamed.pop("id"), renamed.pop("is_standard"), renamed.pop("language")
    assert client.put(f"/api/profiles/{std['id']}", json=renamed).status_code == 409


def test_reset_standard(client):
    std = _standard(client)
    body = {k: v for k, v in std.items()
            if k not in ("id", "is_standard", "language")}
    body["llm_instructions"] = "changed"
    body["packs_on"] = ["marketing"]
    client.put(f"/api/profiles/{std['id']}", json=body)
    reset = client.post(f"/api/profiles/{std['id']}/reset")
    assert reset.status_code == 200
    assert reset.json()["llm_instructions"] == ""
    assert reset.json()["packs_on"] == []
    assert reset.json()["example_text"].startswith("At the end of the day")

    other = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Other", "llm_provider": "ollama"},
    ).json()
    assert client.post(f"/api/profiles/{other['id']}/reset").status_code == 409


def test_update_prunes_dead_domain_ids(client):
    domain = client.post("/api/domains", json={"name": "Docs"}).json()
    std = _standard(client)
    body = {k: v for k, v in std.items()
            if k not in ("id", "is_standard", "language")}
    body["domain_ids"] = [domain["id"], 424242]
    updated = client.put(f"/api/profiles/{std['id']}", json=body).json()
    assert updated["domain_ids"] == [domain["id"]]


def test_domain_deletion_prunes_profiles(client):
    domain = client.post("/api/domains", json={"name": "Docs"}).json()
    std = _standard(client)
    body = {k: v for k, v in std.items()
            if k not in ("id", "is_standard", "language")}
    body["domain_ids"] = [domain["id"]]
    client.put(f"/api/profiles/{std['id']}", json=body)
    client.delete(f"/api/domains/{domain['id']}")
    assert _standard(client)["domain_ids"] == []


def test_profile_accepts_llm_tier(client: TestClient) -> None:
    created = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Tiered", "llm_tier": "cheap"},
    ).json()
    assert created["llm_tier"] == "cheap"
    updated = client.put(
        f"/api/profiles/{created['id']}",
        json={
            "name": "Tiered",
            "categories_off": [],
            "rule_exceptions": [],
            "packs_on": [],
            "domain_ids": [],
            "llm_provider": None,
            "llm_model": None,
            "llm_tier": "quality",
            "llm_instructions": "",
            "example_text": "",
        },
    ).json()
    assert updated["llm_tier"] == "quality"


def test_profile_rejects_unknown_tier(client: TestClient) -> None:
    response = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Bad", "llm_tier": "premium"},
    )
    assert response.status_code == 422


def test_profile_update_requires_llm_tier(client: TestClient) -> None:
    std = _standard(client)
    body = {k: v for k, v in std.items()
            if k not in ("id", "is_standard", "language", "llm_tier")}
    response = client.put(f"/api/profiles/{std['id']}", json=body)
    assert response.status_code == 422


def test_profile_api_carries_packs_on(client) -> None:
    created = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Packy", "packs_on": ["marketing"]},
    ).json()
    assert created["packs_on"] == ["marketing"]
    updated = client.put(
        f"/api/profiles/{created['id']}",
        json={
            "name": "Packy",
            "categories_off": [],
            "rule_exceptions": [],
            "packs_on": ["marketing", "blog"],
            "domain_ids": [],
            "llm_provider": None,
            "llm_model": None,
            "llm_tier": "balanced",
            "llm_instructions": "",
            "example_text": "",
        },
    ).json()
    assert updated["packs_on"] == ["marketing", "blog"]


def test_profiles_api_ownership(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    listed = client.get("/api/profiles?language=en", headers=other).json()
    # Non-admin sees the seeded globals, flagged as such.
    assert listed and all(p["is_global"] for p in listed)
    assert all("owner_id" not in p for p in listed)
    standard = next(p for p in listed if p["name"] == "Standard")
    # Global mutation as non-admin: 403 (the one non-404 case).
    body = {k: v for k, v in standard.items() if k not in ("id", "is_standard", "is_global")}
    assert (
        client.put(
            f"/api/profiles/{standard['id']}", json={**body, "example_text": "x"},
            headers=other,
        ).status_code
        == 403
    )
    assert client.delete(f"/api/profiles/{standard['id']}", headers=other).status_code == 403
    assert client.post(f"/api/profiles/{standard['id']}/reset", headers=other).status_code == 403
    # Admin may still edit and reset the global Standard.
    assert client.post(f"/api/profiles/{standard['id']}/reset", headers=admin).status_code == 200
    # Creation is always as the caller; shadowing a global name is fine.
    created = client.post(
        "/api/profiles", json={**body, "name": "Standard"}, headers=other
    ).json()
    assert created["is_global"] is False
    # The other user's private profile is invisible to the admin — admins
    # are ordinary callers for private data (Global Constraints): absent
    # from the listing, 404 on direct access.
    admin_names = {
        p["name"] for p in client.get("/api/profiles?language=en", headers=admin).json()
    }
    assert "Standard" in admin_names          # the global one
    assert created["id"] not in {
        p["id"] for p in client.get("/api/profiles?language=en", headers=admin).json()
    }
    assert (
        client.put(
            f"/api/profiles/{created['id']}", json=body, headers=admin
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/profiles/{created['id']}", headers=admin).status_code
        == 404
    )


NO_FEATURES = {"basic": {"llm": {}, "features": []}}
WITH_FEATURES = {"basic": {"llm": {}, "features": ["custom_profiles", "custom_domains"]}}

_PROFILE_BODY = {"language": "en", "name": "Notes"}


class TestCustomProfilesGate:
    def test_create_without_feature_is_403(self, tmp_path):
        settings = Settings(db_path=tmp_path / "test.db", tiers=NO_FEATURES)
        client = TestClient(create_app(settings))
        client.headers.update(second_user_headers(client))
        response = client.post("/api/profiles", json=_PROFILE_BODY)
        assert response.status_code == 403
        assert response.json()["detail"] == "Your plan does not include custom profiles"
        # Global profiles remain listable/usable.
        listed = client.get("/api/profiles?language=en")
        assert listed.status_code == 200
        assert any(p["is_standard"] for p in listed.json())

    def test_create_with_feature_succeeds(self, tmp_path):
        settings = Settings(db_path=tmp_path / "test.db", tiers=WITH_FEATURES)
        client = TestClient(create_app(settings))
        client.headers.update(second_user_headers(client))
        response = client.post("/api/profiles", json=_PROFILE_BODY)
        assert response.status_code == 201

    def test_admin_bypasses_gate(self, tmp_path):
        settings = Settings(db_path=tmp_path / "test.db", tiers=NO_FEATURES)
        client = TestClient(create_app(settings))
        client.headers.update(auth_headers(client))
        response = client.post("/api/profiles", json=_PROFILE_BODY)
        assert response.status_code == 201

    def test_default_config_is_ungated(self, tmp_path):
        settings = Settings(db_path=tmp_path / "test.db")
        client = TestClient(create_app(settings))
        client.headers.update(second_user_headers(client))
        response = client.post("/api/profiles", json=_PROFILE_BODY)
        assert response.status_code == 201

    def test_existing_items_stay_editable_after_flag_removal(self, tmp_path):
        db_path = tmp_path / "test.db"
        app_a = TestClient(create_app(Settings(db_path=db_path, tiers=WITH_FEATURES)))
        headers_a = second_user_headers(app_a)
        created = app_a.post("/api/profiles", json=_PROFILE_BODY, headers=headers_a)
        assert created.status_code == 201
        pid = created.json()["id"]

        app_b = TestClient(create_app(Settings(db_path=db_path, tiers=NO_FEATURES)))
        headers_b = second_user_headers(app_b)

        put_body = {
            "name": "Notes updated",
            "categories_off": [],
            "rule_exceptions": [],
            "packs_on": [],
            "domain_ids": [],
            "llm_provider": None,
            "llm_model": None,
            "llm_tier": None,
            "llm_instructions": "",
            "example_text": "",
        }
        updated = app_b.put(f"/api/profiles/{pid}", json=put_body, headers=headers_b)
        assert updated.status_code == 200
        assert app_b.delete(f"/api/profiles/{pid}", headers=headers_b).status_code == 204
        blocked = app_b.post("/api/profiles", json=_PROFILE_BODY, headers=headers_b)
        assert blocked.status_code == 403
