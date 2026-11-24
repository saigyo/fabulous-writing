from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.conftest import auth_headers, second_user_headers
from tests.terminology_helpers import changes, post_concept


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        seed_terminology=False,  # CRUD tests assert exact domain lists
    )
    client = TestClient(create_app(settings))
    client.headers.update(auth_headers(client))
    return client


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


def test_create_concept_in_missing_domain_is_404(client: TestClient) -> None:
    assert post_concept(client, 999, preferred="x").status_code == 404


def test_terminology_api_ownership(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    mine = client.post("/api/domains", json={"name": "Mine"}, headers=admin).json()
    assert mine["is_global"] is False and "owner_id" not in mine
    concept = post_concept(client, mine["id"], preferred="secret term", headers=admin).json()
    # Foreign domain and its concepts: 404 everywhere.
    assert all(d["id"] != mine["id"] for d in client.get("/api/domains", headers=other).json())
    assert client.get(f"/api/domains/{mine['id']}/concepts", headers=other).status_code == 404
    assert post_concept(client, mine["id"], preferred="x", headers=other).status_code == 404
    assert client.get(f"/api/concepts/{concept['id']}", headers=other).status_code == 404
    assert client.delete(f"/api/concepts/{concept['id']}", headers=other).status_code == 404
    assert (
        client.put(f"/api/domains/{mine['id']}", json={"name": "X"}, headers=other).status_code
        == 404
    )
    assert client.delete(f"/api/domains/{mine['id']}", headers=other).status_code == 404
    # Global domain (the seeded one): readable by all, writable by admins only.
    seeded = next(d for d in client.get("/api/domains", headers=other).json() if d["is_global"])
    assert (
        client.get(f"/api/domains/{seeded['id']}/concepts", headers=other).status_code == 200
    )
    assert (
        client.put(f"/api/domains/{seeded['id']}", json={"name": "X"}, headers=other).status_code
        == 403
    )
    assert post_concept(client, seeded["id"], preferred="x", headers=other).status_code == 403
    global_concept = client.get(f"/api/domains/{seeded['id']}/concepts", headers=admin).json()[0]
    assert (
        client.delete(f"/api/concepts/{global_concept['id']}", headers=other).status_code == 403
    )
    # Duplicate own domain name: now 409.
    client.post("/api/domains", json={"name": "Dup"}, headers=other)
    assert client.post("/api/domains", json={"name": "dup"}, headers=other).status_code == 409


_LIMITS = {"credits_per_day": 1_000_000, "max_llm_document_chars": 100000, "concurrent_llm_runs": 5}
NO_FEATURES = {"basic": {"llm": {}, "features": [], "limits": _LIMITS}}
WITH_FEATURES = {
    "basic": {"llm": {}, "features": ["custom_profiles", "custom_domains"], "limits": _LIMITS}
}


def _app(tmp_path, db_path=None, tiers=None) -> TestClient:
    settings = Settings(
        db_path=db_path or tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        seed_terminology=False,
        **({"tiers": tiers} if tiers is not None else {}),
    )
    return TestClient(create_app(settings))


class TestCustomDomainsGate:
    def test_create_without_feature_is_403(self, tmp_path):
        client = _app(tmp_path, tiers=NO_FEATURES)
        headers = second_user_headers(client)
        response = client.post("/api/domains", json={"name": "Cloud"}, headers=headers)
        assert response.status_code == 403
        assert (
            response.json()["detail"]
            == "Your plan does not include custom terminology domains"
        )
        # Global read access remains: the domain listing endpoint still works.
        assert client.get("/api/domains", headers=headers).status_code == 200

    def test_create_with_feature_succeeds(self, tmp_path):
        client = _app(tmp_path, tiers=WITH_FEATURES)
        headers = second_user_headers(client)
        response = client.post("/api/domains", json={"name": "Cloud"}, headers=headers)
        assert response.status_code == 201

    def test_admin_bypasses_gate(self, tmp_path):
        client = _app(tmp_path, tiers=NO_FEATURES)
        headers = auth_headers(client)
        response = client.post("/api/domains", json={"name": "Cloud"}, headers=headers)
        assert response.status_code == 201

    def test_default_config_is_ungated(self, tmp_path):
        client = _app(tmp_path)
        headers = second_user_headers(client)
        response = client.post("/api/domains", json={"name": "Cloud"}, headers=headers)
        assert response.status_code == 201

    def test_existing_domain_stays_editable_after_flag_removal(self, tmp_path):
        db_path = tmp_path / "db.sqlite"
        app_a = _app(tmp_path, db_path=db_path, tiers=WITH_FEATURES)
        headers_a = second_user_headers(app_a)
        created = app_a.post("/api/domains", json={"name": "Cloud"}, headers=headers_a)
        assert created.status_code == 201
        domain_id = created.json()["id"]

        app_b = _app(tmp_path, db_path=db_path, tiers=NO_FEATURES)
        headers_b = second_user_headers(app_b)
        updated = app_b.put(
            f"/api/domains/{domain_id}", json={"name": "Cloud Docs"}, headers=headers_b
        )
        assert updated.status_code == 200
        assert app_b.delete(f"/api/domains/{domain_id}", headers=headers_b).status_code == 204
        blocked = app_b.post("/api/domains", json={"name": "Other"}, headers=headers_b)
        assert blocked.status_code == 403



def _domain(client: TestClient) -> int:
    return client.post("/api/domains", json={"name": "Cloud"}).json()["id"]


def _findings(client: TestClient, domain_id: int, text: str) -> list[dict]:
    response = client.post(
        "/api/checks",
        json={
            "text": text,
            "language": "en",
            "domain_ids": [domain_id],
            "checkers": ["terminology"],
        },
    )
    assert response.json()["status"] == "done", response.text
    return response.json()["findings"]


def _save_english(client: TestClient, concept: dict, terms: list[dict]) -> dict:
    section = concept["sections"][0]
    response = client.put(
        f"/api/concepts/{concept['id']}/languages/en",
        json={"id": section["id"], "revision": section["revision"], "terms": terms},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_case_sensitive_applies_to_every_wording(client: TestClient) -> None:
    domain_id = _domain(client)
    concept = post_concept(
        client, domain_id, preferred="sign in", forbidden=["login"], case_sensitive=True
    ).json()
    assert _findings(client, domain_id, "Please LOGIN now") == []
    assert len(_findings(client, domain_id, "Please login now")) == 1

    insensitive = [
        {"id": t["id"], "text": t["text"], "usage_status": t["usage_status"]}
        for t in concept["sections"][0]["terms"]
    ]
    _save_english(client, concept, insensitive)
    assert len(_findings(client, domain_id, "Please LOGIN now")) == 1


def test_concept_changes_are_logged(client: TestClient) -> None:
    admin_id = client.get("/api/auth/me").json()["id"]
    concept = post_concept(client, _domain(client), preferred="sign in").json()
    term = concept["sections"][0]["terms"][0]
    saved = _save_english(
        client, concept, [{"id": term["id"], "text": "log on", "usage_status": "preferred"}]
    )
    assert client.delete(f"/api/concepts/{saved['id']}").status_code == 204
    entries = changes(client.app.state.db)
    assert len({entry["batch"] for entry in entries}) == 3
    assert {(entry["origin"], entry["user_id"]) for entry in entries} == {("manual", admin_id)}
