from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


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
