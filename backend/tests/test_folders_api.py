from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.services.folders import FolderStore


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    return TestClient(create_app(settings))


def make_folder(client: TestClient, name: str = "Project") -> dict:
    response = client.post("/api/folders", json={"name": name})
    assert response.status_code == 201
    return response.json()


def test_create_and_list_sorted(client):
    make_folder(client, "beta")
    make_folder(client, "Alpha")
    names = [f["name"] for f in client.get("/api/folders").json()]
    assert names == ["Alpha", "beta"]


def test_create_validation(client):
    assert client.post("/api/folders", json={"name": "  "}).status_code == 422
    assert client.post("/api/folders", json={"name": "x" * 101}).status_code == 422
    make_folder(client, "Blog")
    assert client.post("/api/folders", json={"name": "Blog"}).status_code == 409


def test_rename(client):
    folder = make_folder(client, "Old")
    make_folder(client, "Taken")
    ok = client.put(f"/api/folders/{folder['id']}", json={"name": "New"})
    assert ok.status_code == 200 and ok.json()["name"] == "New"
    assert client.put(f"/api/folders/{folder['id']}", json={"name": "Taken"}).status_code == 409
    assert client.put(f"/api/folders/{folder['id']}", json={"name": ""}).status_code == 422
    assert client.put("/api/folders/9999", json={"name": "X"}).status_code == 404


def test_delete_keeps_documents(client):
    folder = make_folder(client)
    doc = client.post(
        "/api/documents",
        json={"name": "Doc", "language": "en", "folder_id": folder["id"]},
    ).json()
    assert doc["folder_id"] == folder["id"]
    assert client.delete(f"/api/folders/{folder['id']}").status_code == 204
    assert client.delete(f"/api/folders/{folder['id']}").status_code == 404
    survivor = client.get(f"/api/documents/{doc['id']}").json()
    assert survivor["folder_id"] is None


def make_profile(client: TestClient, language: str = "en", name: str = "P") -> dict:
    response = client.post(
        "/api/profiles", json={"language": language, "name": name}
    )
    assert response.status_code == 201
    return response.json()


def make_domain(client: TestClient, name: str = "Med") -> dict:
    response = client.post("/api/domains", json={"name": name})
    assert response.status_code == 201
    return response.json()


def test_defaults_roundtrip_and_full_replace(client):
    folder = make_folder(client)
    profile = make_profile(client, "en", "Blogging")
    domain = make_domain(client)
    full = {
        "default_language": "en",
        "default_profile_id": profile["id"],
        "default_domain_ids": [domain["id"]],
        "default_llm_provider": None,
        "default_llm_model": None,
        "default_llm_tier": "cheap",
        "default_llm_auto": False,
    }
    put = client.put(f"/api/folders/{folder['id']}/defaults", json=full)
    assert put.status_code == 200
    assert put.json()["default_profile_id"] == profile["id"]
    assert put.json()["default_llm_auto"] is False
    # GET serves the defaults on the folder objects.
    listed = client.get("/api/folders").json()[0]
    assert listed["default_language"] == "en"
    assert listed["default_domain_ids"] == [domain["id"]]
    # Full replace: an omitted field is cleared, not kept.
    put2 = client.put(
        f"/api/folders/{folder['id']}/defaults",
        json={"default_language": "en"},
    )
    assert put2.status_code == 200
    assert put2.json()["default_profile_id"] is None
    assert put2.json()["default_llm_tier"] is None


def test_defaults_validation_matrix(client):
    folder = make_folder(client)
    profile_en = make_profile(client, "en", "English only")
    url = f"/api/folders/{folder['id']}/defaults"
    # Profile default without a language default.
    assert (
        client.put(url, json={"default_profile_id": profile_en["id"]}).status_code
        == 422
    )
    # Unknown profile.
    assert (
        client.put(
            url, json={"default_language": "en", "default_profile_id": 99999}
        ).status_code
        == 422
    )
    # Profile of a different language than the language default.
    assert (
        client.put(
            url,
            json={"default_language": "de", "default_profile_id": profile_en["id"]},
        ).status_code
        == 422
    )
    # Unknown domain id.
    assert (
        client.put(url, json={"default_domain_ids": [99999]}).status_code == 422
    )
    # Invalid tier value (pydantic Literal).
    assert client.put(url, json={"default_llm_tier": "turbo"}).status_code == 422
    # Unknown folder.
    assert (
        client.put("/api/folders/9999/defaults", json={}).status_code == 404
    )
    # Empty body is a valid "clear all defaults".
    ok = client.put(url, json={})
    assert ok.status_code == 200
    assert ok.json()["default_language"] is None


def test_defaults_pruning_is_read_time_only(tmp_path: Path):
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    folder = make_folder(client)
    profile = make_profile(client, "de", "Kurzlebig")
    d1 = make_domain(client, "Keep")
    d2 = make_domain(client, "Drop")
    client.put(
        f"/api/folders/{folder['id']}/defaults",
        json={
            "default_language": "de",
            "default_profile_id": profile["id"],
            "default_domain_ids": [d1["id"], d2["id"]],
        },
    )
    assert client.delete(f"/api/profiles/{profile['id']}").status_code == 204
    assert client.delete(f"/api/domains/{d2['id']}").status_code == 204
    listed = client.get("/api/folders").json()[0]
    # Dead references pruned from the response; the language stays.
    assert listed["default_profile_id"] is None
    assert listed["default_language"] == "de"
    assert listed["default_domain_ids"] == [d1["id"]]
    # The DB row itself is untouched (read-time view, like documents GET).
    raw = FolderStore(settings.db_path).get_folder(folder["id"])
    assert raw.default_profile_id == profile["id"]
    assert raw.default_domain_ids == [d1["id"], d2["id"]]


def test_rename_response_prunes_dangling_profile_default(client):
    # rename_folder never touches the defaults columns, so its response used
    # to echo the raw row verbatim -- including a profile id that no longer
    # resolves to anything once the profile is deleted.
    folder = make_folder(client)
    profile = make_profile(client, "en", "Fleeting")
    client.put(
        f"/api/folders/{folder['id']}/defaults",
        json={"default_language": "en", "default_profile_id": profile["id"]},
    )
    assert client.delete(f"/api/profiles/{profile['id']}").status_code == 204
    renamed = client.put(f"/api/folders/{folder['id']}", json={"name": "Renamed"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Renamed"
    assert renamed.json()["default_profile_id"] is None


def test_rename_response_prunes_dangling_domain_default(client):
    # Same bug, other field: a domain id dangling in default_domain_ids must
    # not survive into the rename response either.
    folder = make_folder(client)
    kept = make_domain(client, "Keep")
    stale = make_domain(client, "Fleeting")
    client.put(
        f"/api/folders/{folder['id']}/defaults",
        json={"default_domain_ids": [kept["id"], stale["id"]]},
    )
    assert client.delete(f"/api/domains/{stale['id']}").status_code == 204
    renamed = client.put(f"/api/folders/{folder['id']}", json={"name": "Renamed"})
    assert renamed.status_code == 200
    assert renamed.json()["default_domain_ids"] == [kept["id"]]
