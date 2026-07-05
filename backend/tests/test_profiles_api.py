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
    created = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Blog", "llm_provider": "ollama"},
    )
    assert created.status_code == 201
    pid = created.json()["id"]

    updated = client.put(
        f"/api/profiles/{pid}",
        json={"name": "Blog posts", "categories_off": ["vividness"],
              "rule_exceptions": [], "domain_ids": [], "llm_provider": "ollama",
              "llm_model": None, "llm_instructions": "Casual tone.",
              "example_text": "Sample."},
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
    client.put(f"/api/profiles/{std['id']}", json=body)
    reset = client.post(f"/api/profiles/{std['id']}/reset")
    assert reset.status_code == 200
    assert reset.json()["llm_instructions"] == ""
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
