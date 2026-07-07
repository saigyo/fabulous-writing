import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture()
def client(tmp_path):
    settings = Settings(db_path=tmp_path / "test.db", seed_terminology=False)
    return TestClient(create_app(settings))


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
    body = {"language": "en", "name": "Standard", "llm_provider": "ollama"}
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
