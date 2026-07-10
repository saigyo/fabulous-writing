from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    return TestClient(create_app(settings))


def make_doc(client: TestClient, name: str = "Untitled", **extra) -> dict:
    response = client.post(
        "/api/documents", json={"name": name, "language": "en", **extra}
    )
    assert response.status_code == 201
    return response.json()


def test_create_returns_full_document(client):
    doc = make_doc(client, text="Hello there world.", llm_tier="cheap")
    assert doc["name"] == "Untitled" and doc["name_source"] == "fallback"
    assert doc["text"] == "Hello there world."
    assert doc["revision"] == 0 and doc["llm_tier"] == "cheap"


def test_list_is_recency_ordered_summaries(client):
    a = make_doc(client, name="A")
    b = make_doc(client, name="B")
    listing = client.get("/api/documents").json()
    assert [d["id"] for d in listing] == [b["id"], a["id"]]
    assert "text" not in listing[0] and "last_findings" not in listing[0]


def test_get_full_document_and_404(client):
    doc = make_doc(client)
    assert client.get(f"/api/documents/{doc['id']}").json()["id"] == doc["id"]
    assert client.get("/api/documents/9999").status_code == 404


def test_put_content_and_settings(client):
    doc = make_doc(client)
    response = client.put(
        f"/api/documents/{doc['id']}",
        json={
            "revision": 0,
            "content": {
                "text": "New body.",
                "findings": [{"finding": {"id": "x"}, "from": 0, "to": 3}],
                "scorecard": {"card": {"overall": 80}, "stale": False},
            },
            "settings": {
                "language": "de",
                "profile_id": None,
                "domain_ids": [2],
                "llm_provider": None,
                "llm_model": None,
                "llm_tier": "local",
                "llm_auto": False,
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["revision"] == 1 and body["text"] == "New body."
    assert body["language"] == "de" and body["llm_tier"] == "local"
    assert body["last_findings"][0]["from"] == 0
    assert body["scorecard"]["stale"] is False


def test_put_stale_revision_409(client):
    doc = make_doc(client)
    ok = {"revision": 0, "content": {"text": "a", "findings": [], "scorecard": None}}
    assert client.put(f"/api/documents/{doc['id']}", json=ok).status_code == 200
    stale = client.put(f"/api/documents/{doc['id']}", json=ok)
    assert stale.status_code == 409
    assert client.put("/api/documents/9999", json=ok).status_code == 404


def test_rename_sets_user_source(client):
    doc = make_doc(client)
    body = client.put(
        f"/api/documents/{doc['id']}", json={"revision": 0, "name": "Mine"}
    ).json()
    assert body["name"] == "Mine" and body["name_source"] == "user"
    assert body["revision"] == 1


def test_delete(client):
    doc = make_doc(client)
    assert client.delete(f"/api/documents/{doc['id']}").status_code == 204
    assert client.delete(f"/api/documents/{doc['id']}").status_code == 404
