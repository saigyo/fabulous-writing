from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.conftest import auth_headers, second_user_headers
from tests.terminology_helpers import changes, post_concept
from tests.test_terminology_api import NO_FEATURES, WITH_FEATURES, _app


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        seed_terminology=False,
    )
    client = TestClient(create_app(settings))
    client.headers.update(auth_headers(client))
    return client


def _domain(client: TestClient, name: str = "Cloud", headers: dict | None = None) -> int:
    return client.post("/api/domains", json={"name": name}, headers=headers).json()["id"]


def _global_domain(client: TestClient) -> int:
    return client.app.state.terminology_store.create_domain("Built-in", owner_id=None).id


def _concept(client: TestClient, domain_id: int, **fields) -> dict:
    response = post_concept(client, domain_id, **fields)
    assert response.status_code == 201, response.text
    return response.json()


def _term(text: str, usage: str = "admitted", **fields) -> dict:
    return {"text": text, "usage_status": usage, **fields}


def _save_language(client: TestClient, concept: dict, language: str, body: dict, **kw):
    return client.put(f"/api/concepts/{concept['id']}/languages/{language}", json=body, **kw)


def _en_body(concept: dict, terms: list[dict], **fields) -> dict:
    section = next(s for s in concept["sections"] if s["language"] == "en")
    return {"id": section["id"], "revision": section["revision"], "terms": terms, **fields}


def _get(client: TestClient, concept_id: int) -> dict:
    response = client.get(f"/api/concepts/{concept_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_create_list_get_roundtrip(client: TestClient) -> None:
    domain_id = _domain(client)
    created = post_concept(
        client, domain_id, preferred="sign in", forbidden=["login"], definition="Authenticating."
    )
    assert created.status_code == 201
    concept = created.json()
    assert concept["id"] and concept["uid"]
    assert concept["revision"] == 1
    assert concept["domain_ids"] == [domain_id]
    assert concept["is_global"] is False
    assert "owner_id" not in concept
    [section] = concept["sections"]
    assert section["id"] and section["revision"] == 1
    assert [(t["text"], t["revision"]) for t in section["terms"]] == [
        ("sign in", 1),
        ("login", 1),
    ]
    assert all(t["id"] for t in section["terms"])
    assert client.get(f"/api/domains/{domain_id}/concepts").json() == [concept]
    assert client.get(f"/api/concepts/{concept['id']}").json() == concept


def test_create_needs_the_custom_domains_feature(tmp_path: Path) -> None:
    db_path = tmp_path / "db.sqlite"
    app_a = _app(tmp_path, db_path=db_path, tiers=WITH_FEATURES)
    headers_a = second_user_headers(app_a)
    domain_id = _domain(app_a, headers=headers_a)

    app_b = _app(tmp_path, db_path=db_path, tiers=NO_FEATURES)
    headers_b = second_user_headers(app_b)
    response = post_concept(app_b, domain_id, preferred="sign in", headers=headers_b)
    assert response.status_code == 403


def test_save_and_delete_stay_allowed_without_the_feature(tmp_path: Path) -> None:
    db_path = tmp_path / "db.sqlite"
    app_a = _app(tmp_path, db_path=db_path, tiers=WITH_FEATURES)
    headers_a = second_user_headers(app_a)
    first = _domain(app_a, "One", headers_a)
    second = _domain(app_a, "Two", headers_a)
    kept = post_concept(app_a, first, preferred="sign in", headers=headers_a).json()
    linked = post_concept(app_a, first, preferred="log out", headers=headers_a).json()
    both = app_a.put(
        f"/api/concepts/{linked['id']}",
        json={"domain_ids": [first, second], "revision": linked["revision"]},
        headers=headers_a,
    )
    assert both.status_code == 200

    app_b = _app(tmp_path, db_path=db_path, tiers=NO_FEATURES)
    headers_b = second_user_headers(app_b)
    assert app_b.get(f"/api/domains/{first}/concepts", headers=headers_b).status_code == 200
    assert app_b.get(f"/api/concepts/{kept['id']}", headers=headers_b).status_code == 200
    saved_language = app_b.put(
        f"/api/concepts/{kept['id']}/languages/en",
        json=_en_body(kept, [_term("sign in", "preferred")], definition="x"),
        headers=headers_b,
    )
    assert saved_language.status_code == 200
    saved = app_b.put(
        f"/api/concepts/{kept['id']}", json={"sections": []}, headers=headers_b
    )
    assert saved.status_code == 200
    assert (
        app_b.delete(f"/api/domains/{first}/concepts/{linked['id']}", headers=headers_b).status_code
        == 204
    )
    assert app_b.delete(f"/api/concepts/{kept['id']}", headers=headers_b).status_code == 204


def test_save_language_adds_changes_and_removes_terms(client: TestClient) -> None:
    concept = _concept(
        client, _domain(client), preferred="sign in", forbidden=["login", "log in"]
    )
    preferred, login, _ = concept["sections"][0]["terms"]
    body = _en_body(
        concept,
        [
            _term("sign in to", "preferred", id=preferred["id"]),
            _term("login", "forbidden", id=login["id"]),
            _term("signin", "deprecated"),
        ],
    )
    response = _save_language(client, concept, "en", body)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["revision"] == 1
    [section] = saved["sections"]
    assert section["revision"] == 2
    by_text = {t["text"]: t for t in section["terms"]}
    assert set(by_text) == {"sign in to", "login", "signin"}
    assert by_text["sign in to"]["id"] == preferred["id"]
    assert by_text["sign in to"]["revision"] == 2
    assert by_text["login"]["revision"] == 1
    assert by_text["signin"]["revision"] == 1


def test_save_language_creates_a_new_section(client: TestClient) -> None:
    concept = _concept(client, _domain(client), preferred="sign in")
    response = _save_language(
        client, concept, "de", {"terms": [_term("anmelden", "preferred")]}
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert [s["language"] for s in saved["sections"]] == ["en", "de"]
    assert saved["revision"] == 2


def test_save_language_without_terms_removes_the_section(client: TestClient) -> None:
    concept = _concept(client, _domain(client), preferred="sign in")
    added = _save_language(client, concept, "de", {"terms": [_term("anmelden", "preferred")]})
    german = next(s for s in added.json()["sections"] if s["language"] == "de")
    removed = _save_language(
        client, concept, "de", {"id": german["id"], "revision": german["revision"], "terms": []}
    )
    assert removed.status_code == 200
    [left] = removed.json()["sections"]
    assert left["language"] == "en"

    last = _save_language(client, concept, "en", _en_body(removed.json(), []))
    assert last.status_code == 409
    assert last.json()["detail"]["code"] == "no_section"


def test_save_concept_writes_only_listed_sections(client: TestClient) -> None:
    concept = _concept(client, _domain(client), preferred="sign in")
    added = _save_language(
        client, concept, "de", {"terms": [_term("anmelden", "preferred")]}
    ).json()
    english, german = added["sections"]
    response = client.put(
        f"/api/concepts/{concept['id']}",
        json={
            "sections": [
                {
                    "language": "de",
                    "id": german["id"],
                    "revision": german["revision"],
                    "definition": "Neu.",
                    "terms": [_term("anmelden", "preferred", id=german["terms"][0]["id"])],
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    saved_english, saved_german = saved["sections"]
    assert saved_german["revision"] == german["revision"] + 1
    assert saved_german["definition"] == "Neu."
    assert saved_english["revision"] == english["revision"]
    assert saved_english["modified_at"] == english["modified_at"]


def test_save_concept_sets_domain_links(client: TestClient) -> None:
    first, second = _domain(client, "One"), _domain(client, "Two")
    concept = _concept(client, first, preferred="sign in")
    url = f"/api/concepts/{concept['id']}"

    assert client.put(url, json={"domain_ids": [first, second]}).status_code == 422

    both = client.put(url, json={"domain_ids": [first, second], "revision": 1})
    assert both.status_code == 200, both.text
    assert sorted(both.json()["domain_ids"]) == sorted([first, second])

    none = client.put(url, json={"domain_ids": [], "revision": both.json()["revision"]})
    assert none.status_code == 409
    assert none.json()["detail"]["code"] == "no_domain"


def test_out_of_date_language_names_the_language(client: TestClient) -> None:
    concept = _concept(client, _domain(client), preferred="sign in")
    body = _en_body(concept, [_term("sign in", "preferred")], definition="first")
    assert _save_language(client, concept, "en", body).status_code == 200
    after_first = _get(client, concept["id"])

    stale = _save_language(client, concept, "en", {**body, "definition": "second"})
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail == {"code": "conflict", "part": "en", "message": detail["message"]}
    assert detail["message"]
    assert _get(client, concept["id"]) == after_first


def test_out_of_date_links_name_the_links(client: TestClient) -> None:
    domain_id = _domain(client)
    concept = _concept(client, domain_id, preferred="sign in")
    assert _save_language(
        client, concept, "de", {"terms": [_term("anmelden", "preferred")]}
    ).status_code == 200
    stale = client.put(
        f"/api/concepts/{concept['id']}",
        json={"domain_ids": [domain_id], "revision": concept["revision"]},
    )
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["code"] == "conflict" and detail["part"] == "links"


def _duplicate_text(client, concept, global_id):
    return _save_language(
        client,
        concept,
        "en",
        _en_body(concept, [_term("a", "preferred"), _term("a", "forbidden")]),
    )


def _second_preferred(client, concept, global_id):
    return _save_language(
        client,
        concept,
        "en",
        _en_body(concept, [_term("a", "preferred"), _term("b", "preferred")]),
    )


def _owner_mismatch(client, concept, global_id):
    return client.put(
        f"/api/concepts/{concept['id']}",
        json={"domain_ids": [*concept["domain_ids"], global_id], "revision": concept["revision"]},
    )


@pytest.mark.parametrize(
    ("code", "attempt"),
    [
        ("duplicate_text", _duplicate_text),
        ("second_preferred", _second_preferred),
        ("domain_owner_mismatch", _owner_mismatch),
    ],
)
def test_rule_violations_are_409_with_their_code(client: TestClient, code, attempt) -> None:
    concept = _concept(client, _domain(client), preferred="sign in")
    response = attempt(client, concept, _global_domain(client))
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == code
    assert detail["message"]
    assert "part" not in detail


@pytest.mark.parametrize(
    ("language", "term"),
    [
        ("en", _term("   ", "preferred")),
        ("en", _term("a", "mandatory")),
        ("xx", _term("a", "preferred")),
    ],
)
def test_invalid_values_are_422(client: TestClient, language, term) -> None:
    concept = _concept(client, _domain(client), preferred="sign in")
    response = _save_language(client, concept, language, _en_body(concept, [term]))
    assert response.status_code == 422


def test_remove_from_domain_and_delete(client: TestClient) -> None:
    first, second = _domain(client, "One"), _domain(client, "Two")
    concept = _concept(client, first, preferred="sign in")
    linked = client.put(
        f"/api/concepts/{concept['id']}", json={"domain_ids": [first, second], "revision": 1}
    )
    assert linked.status_code == 200

    removed = client.delete(f"/api/domains/{first}/concepts/{concept['id']}")
    assert removed.status_code == 204
    assert _get(client, concept["id"])["domain_ids"] == [second]

    last = client.delete(f"/api/domains/{second}/concepts/{concept['id']}")
    assert last.status_code == 409
    assert last.json()["detail"]["code"] == "no_domain"

    assert client.delete(f"/api/concepts/{concept['id']}").status_code == 204
    assert client.get(f"/api/concepts/{concept['id']}").status_code == 404
    assert client.delete(f"/api/concepts/{concept['id']}").status_code == 404


def test_other_user_sees_404_everywhere(client: TestClient) -> None:
    domain_id = _domain(client)
    concept = _concept(client, domain_id, preferred="sign in")
    other = second_user_headers(client)
    cid = concept["id"]
    responses = [
        client.get(f"/api/domains/{domain_id}/concepts", headers=other),
        post_concept(client, domain_id, preferred="x", headers=other),
        client.get(f"/api/concepts/{cid}", headers=other),
        client.put(f"/api/concepts/{cid}", json={"sections": []}, headers=other),
        client.put(
            f"/api/concepts/{cid}/languages/en",
            json={"terms": [_term("x", "preferred")]},
            headers=other,
        ),
        client.delete(f"/api/concepts/{cid}", headers=other),
        client.delete(f"/api/domains/{domain_id}/concepts/{cid}", headers=other),
    ]
    assert [r.status_code for r in responses] == [404] * 7


def test_global_concept_is_read_only_for_non_admin(client: TestClient) -> None:
    domain_id = _global_domain(client)
    concept = _concept(client, domain_id, preferred="sign in")
    assert concept["is_global"] is True
    other = second_user_headers(client)
    cid = concept["id"]

    assert client.get(f"/api/domains/{domain_id}/concepts", headers=other).status_code == 200
    assert client.get(f"/api/concepts/{cid}", headers=other).status_code == 200
    denied = [
        post_concept(client, domain_id, preferred="x", headers=other),
        client.put(f"/api/concepts/{cid}", json={"sections": []}, headers=other),
        client.put(
            f"/api/concepts/{cid}/languages/en",
            json=_en_body(concept, [_term("sign in", "preferred")]),
            headers=other,
        ),
        client.delete(f"/api/concepts/{cid}", headers=other),
        client.delete(f"/api/domains/{domain_id}/concepts/{cid}", headers=other),
    ]
    assert [r.status_code for r in denied] == [403] * 5

    admin = _save_language(
        client, concept, "en", _en_body(concept, [_term("sign in", "preferred")], definition="x")
    )
    assert admin.status_code == 200


def _comment_on_create(client, concept, comment):
    return client.post(
        f"/api/domains/{concept['domain_ids'][0]}/concepts",
        json={
            "sections": [{"language": "en", "terms": [_term("log on", "preferred")]}],
            "comment": comment,
        },
    )


def _comment_on_save_concept(client, concept, comment):
    section = _en_body(concept, [_term("log on", "preferred")])
    return client.put(
        f"/api/concepts/{concept['id']}",
        json={"sections": [{"language": "en", **section}], "comment": comment},
    )


def _comment_on_save_language(client, concept, comment):
    body = _en_body(concept, [_term("log on", "preferred")], comment=comment)
    return _save_language(client, concept, "en", body)


@pytest.mark.parametrize(
    "write", [_comment_on_create, _comment_on_save_concept, _comment_on_save_language]
)
def test_comment_reaches_the_change_log(client: TestClient, write) -> None:
    concept = _concept(client, _domain(client), preferred="sign in")
    response = write(client, concept, "Style guide 2026")
    assert response.status_code in (200, 201), response.text
    assert changes(client.app.state.db)[-1]["comment"] == "Style guide 2026"


def test_term_endpoints_are_gone(client: TestClient) -> None:
    paths = [path for path in client.app.openapi()["paths"] if "/terms" in path]
    assert paths == ["/api/terms/{term_id}/move"]
