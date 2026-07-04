from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        seed_terminology=False,  # CRUD tests assert exact domain lists
    )
    return TestClient(create_app(settings))


def test_domain_crud(client: TestClient) -> None:
    created = client.post(
        "/api/domains", json={"name": "Cloud", "description": "Cloud docs"}
    )
    assert created.status_code == 201
    domain = created.json()
    assert domain["name"] == "Cloud"

    assert client.get("/api/domains").json() == [domain]

    updated = client.put(f"/api/domains/{domain['id']}", json={"name": "Cloud Docs"})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Cloud Docs"

    assert client.delete(f"/api/domains/{domain['id']}").status_code == 204
    assert client.get("/api/domains").json() == []
    assert client.put("/api/domains/999", json={"name": "x"}).status_code == 404


def test_term_crud(client: TestClient) -> None:
    domain_id = client.post("/api/domains", json={"name": "Cloud"}).json()["id"]

    created = client.post(
        f"/api/domains/{domain_id}/terms",
        json={
            "language": "en",
            "preferred": "sign in",
            "forbidden_variants": ["login"],
            "definition": "Authenticating.",
        },
    )
    assert created.status_code == 201
    term = created.json()
    assert term["forbidden_variants"] == ["login"]

    listed = client.get(f"/api/domains/{domain_id}/terms", params={"language": "en"})
    assert [t["id"] for t in listed.json()] == [term["id"]]
    assert (
        client.get(f"/api/domains/{domain_id}/terms", params={"language": "de"}).json()
        == []
    )

    updated = client.put(f"/api/terms/{term['id']}", json={"preferred": "sign in to"})
    assert updated.status_code == 200
    assert updated.json()["preferred"] == "sign in to"

    assert client.delete(f"/api/terms/{term['id']}").status_code == 204
    assert client.delete(f"/api/terms/{term['id']}").status_code == 404


def test_create_term_in_missing_domain_is_404(client: TestClient) -> None:
    response = client.post(
        "/api/domains/999/terms", json={"language": "en", "preferred": "x"}
    )
    assert response.status_code == 404
