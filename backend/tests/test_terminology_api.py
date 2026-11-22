from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.models import Language
from app.main import create_app
from app.services.terminology import Actor, SectionInput, TermInput, UsageStatus
from tests.conftest import auth_headers, second_user_headers


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


def test_create_term_with_blank_preferred_is_422(client: TestClient) -> None:
    domain_id = client.post("/api/domains", json={"name": "Cloud"}).json()["id"]

    response = client.post(
        f"/api/domains/{domain_id}/terms",
        json={"language": "en", "preferred": "   "},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Preferred term must not be empty"


def test_update_term_with_empty_preferred_is_422(client: TestClient) -> None:
    domain_id = client.post("/api/domains", json={"name": "Cloud"}).json()["id"]
    term = client.post(
        f"/api/domains/{domain_id}/terms",
        json={"language": "en", "preferred": "sign in"},
    ).json()

    response = client.put(f"/api/terms/{term['id']}", json={"preferred": ""})
    assert response.status_code == 422
    assert response.json()["detail"] == "Preferred term must not be empty"


def test_update_term_with_preferred_none_still_succeeds(client: TestClient) -> None:
    domain_id = client.post("/api/domains", json={"name": "Cloud"}).json()["id"]
    term = client.post(
        f"/api/domains/{domain_id}/terms",
        json={"language": "en", "preferred": "sign in"},
    ).json()

    response = client.put(
        f"/api/terms/{term['id']}", json={"definition": "Updated definition."}
    )
    assert response.status_code == 200
    assert response.json()["preferred"] == "sign in"
    assert response.json()["definition"] == "Updated definition."


def test_terminology_api_ownership(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    mine = client.post("/api/domains", json={"name": "Mine"}, headers=admin).json()
    assert mine["is_global"] is False and "owner_id" not in mine
    term = client.post(
        f"/api/domains/{mine['id']}/terms",
        json={"language": "en", "preferred": "secret term"},
        headers=admin,
    ).json()
    # Foreign domain and its terms: 404 everywhere.
    assert all(d["id"] != mine["id"] for d in client.get("/api/domains", headers=other).json())
    assert client.get(f"/api/domains/{mine['id']}/terms", headers=other).status_code == 404
    assert (
        client.post(
            f"/api/domains/{mine['id']}/terms",
            json={"language": "en", "preferred": "x"},
            headers=other,
        ).status_code
        == 404
    )
    assert (
        client.put(f"/api/terms/{term['id']}", json={"preferred": "x"}, headers=other).status_code
        == 404
    )
    assert client.delete(f"/api/terms/{term['id']}", headers=other).status_code == 404
    assert (
        client.put(f"/api/domains/{mine['id']}", json={"name": "X"}, headers=other).status_code
        == 404
    )
    assert client.delete(f"/api/domains/{mine['id']}", headers=other).status_code == 404
    # Global domain (the seeded one): readable by all, writable by admins only.
    seeded = next(d for d in client.get("/api/domains", headers=other).json() if d["is_global"])
    assert client.get(f"/api/domains/{seeded['id']}/terms", headers=other).status_code == 200
    assert (
        client.put(f"/api/domains/{seeded['id']}", json={"name": "X"}, headers=other).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/domains/{seeded['id']}/terms",
            json={"language": "en", "preferred": "x"},
            headers=other,
        ).status_code
        == 403
    )
    global_term = client.get(f"/api/domains/{seeded['id']}/terms", headers=admin).json()[0]
    assert (
        client.delete(f"/api/terms/{global_term['id']}", headers=other).status_code == 403
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

    def test_term_create_without_feature_is_403(self, tmp_path):
        db_path = tmp_path / "db.sqlite"
        app_a = _app(tmp_path, db_path=db_path, tiers=WITH_FEATURES)
        headers_a = second_user_headers(app_a)
        domain_id = app_a.post(
            "/api/domains", json={"name": "Cloud"}, headers=headers_a
        ).json()["id"]

        app_b = _app(tmp_path, db_path=db_path, tiers=NO_FEATURES)
        headers_b = second_user_headers(app_b)
        response = app_b.post(
            f"/api/domains/{domain_id}/terms",
            json={"language": "en", "preferred": "sign in"},
            headers=headers_b,
        )
        assert response.status_code == 403
        assert (
            response.json()["detail"]
            == "Your plan does not include custom terminology domains"
        )

    def test_term_update_delete_stay_allowed(self, tmp_path):
        db_path = tmp_path / "db.sqlite"
        app_a = _app(tmp_path, db_path=db_path, tiers=WITH_FEATURES)
        headers_a = second_user_headers(app_a)
        domain_id = app_a.post(
            "/api/domains", json={"name": "Cloud"}, headers=headers_a
        ).json()["id"]
        term = app_a.post(
            f"/api/domains/{domain_id}/terms",
            json={"language": "en", "preferred": "sign in"},
            headers=headers_a,
        ).json()

        app_b = _app(tmp_path, db_path=db_path, tiers=NO_FEATURES)
        headers_b = second_user_headers(app_b)
        updated = app_b.put(
            f"/api/terms/{term['id']}", json={"preferred": "sign in to"}, headers=headers_b
        )
        assert updated.status_code == 200
        assert app_b.delete(f"/api/terms/{term['id']}", headers=headers_b).status_code == 204


def _domain(client: TestClient) -> int:
    return client.post("/api/domains", json={"name": "Cloud"}).json()["id"]


def _post_term(client: TestClient, domain_id: int, **fields) -> dict:
    response = client.post(
        f"/api/domains/{domain_id}/terms", json={"language": "en", **fields}
    )
    assert response.status_code == 201, response.text
    return response.json()


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


def test_variants_are_cleaned(client: TestClient) -> None:
    term = _post_term(
        client,
        _domain(client),
        preferred="sign in",
        forbidden_variants=["login", "", "  ", "login", "sign in"],
    )
    assert term["forbidden_variants"] == ["login"]


def test_update_adds_and_removes_variants_in_creation_order(client: TestClient) -> None:
    term = _post_term(client, _domain(client), preferred="x", forbidden_variants=["a", "b"])
    updated = client.put(f"/api/terms/{term['id']}", json={"forbidden_variants": ["c", "a"]})
    assert updated.status_code == 200
    assert updated.json()["forbidden_variants"] == ["a", "c"]


def test_update_can_change_the_language(client: TestClient) -> None:
    domain_id = _domain(client)
    term = _post_term(
        client,
        domain_id,
        preferred="sign in",
        forbidden_variants=["login"],
        definition="Authenticating.",
    )
    assert client.put(f"/api/terms/{term['id']}", json={"language": "de"}).status_code == 200
    def listed(language: str) -> list[dict]:
        return client.get(
            f"/api/domains/{domain_id}/terms", params={"language": language}
        ).json()

    assert listed("en") == []
    [moved] = listed("de")
    assert (moved["preferred"], moved["forbidden_variants"], moved["definition"]) == (
        "sign in",
        ["login"],
        "Authenticating.",
    )


def test_case_sensitive_applies_to_every_wording(client: TestClient) -> None:
    domain_id = _domain(client)
    term = _post_term(client, domain_id, preferred="sign in", forbidden_variants=["login"])
    assert (
        client.put(f"/api/terms/{term['id']}", json={"case_sensitive": True}).status_code
        == 200
    )
    assert _findings(client, domain_id, "Please LOGIN now") == []
    assert len(_findings(client, domain_id, "Please login now")) == 1


def test_term_changes_are_logged(client: TestClient) -> None:
    admin_id = client.get("/api/auth/me").json()["id"]
    term = _post_term(client, _domain(client), preferred="sign in")
    assert client.put(f"/api/terms/{term['id']}", json={"preferred": "log on"}).status_code == 200
    assert client.delete(f"/api/terms/{term['id']}").status_code == 204
    with client.app.state.db.connect() as conn:
        entries = conn.execute(
            "SELECT batch, origin, user_id FROM terminology_changes ORDER BY id"
        ).fetchall()
    assert len({entry["batch"] for entry in entries}) == 3
    assert {(entry["origin"], entry["user_id"]) for entry in entries} == {("manual", admin_id)}


def test_two_edits_in_a_row_both_succeed(client: TestClient) -> None:
    term = _post_term(client, _domain(client), preferred="sign in")
    first = client.put(f"/api/terms/{term['id']}", json={"definition": "One."})
    second = client.put(f"/api/terms/{term['id']}", json={"definition": "Two."})
    assert (first.status_code, second.status_code) == (200, 200)
    assert second.json()["definition"] == "Two."


def test_renaming_keeps_the_term_id(client: TestClient) -> None:
    term = _post_term(client, _domain(client), preferred="sign in")
    updated = client.put(f"/api/terms/{term['id']}", json={"preferred": "log on"})
    assert updated.json()["id"] == term["id"]


def test_renaming_to_a_current_variant_drops_that_variant(client: TestClient) -> None:
    term = _post_term(client, _domain(client), preferred="sign in", forbidden_variants=["login"])
    updated = client.put(f"/api/terms/{term['id']}", json={"preferred": "login"})
    assert updated.status_code == 200
    assert updated.json()["forbidden_variants"] == []


def test_list_follows_the_store_order(client: TestClient) -> None:
    domain_id = _domain(client)
    for wording in ["Zoom", "apple", "Äpfel", "Bild"]:
        _post_term(client, domain_id, preferred=wording)
    admin_id = client.get("/api/auth/me").json()["id"]
    order = client.app.state.terminology_store.section_ids_by_preferred(
        domain_id, owner_id=admin_id
    )
    listed = client.get(f"/api/domains/{domain_id}/terms").json()
    assert [t["id"] for t in listed] == order


def test_update_into_a_language_the_concept_has_is_409(client: TestClient) -> None:
    store = client.app.state.terminology_store
    admin = Actor(user_id=client.get("/api/auth/me").json()["id"], is_admin=True)
    term = _post_term(client, _domain(client), preferred="sign in")
    concept = store.get_concept_by_section(term["id"], owner_id=admin.user_id)
    store.save_section(
        concept.id,
        SectionInput(
            language=Language.DE,
            terms=[TermInput(text="anmelden", usage_status=UsageStatus.PREFERRED)],
        ),
        actor=admin,
    )
    response = client.put(f"/api/terms/{term['id']}", json={"language": "de"})
    assert response.status_code == 409
    assert response.json()["detail"]
