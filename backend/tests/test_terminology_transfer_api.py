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
    response = client.post("/api/domains", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _concept(client: TestClient, domain_id: int, headers: dict | None = None, **fields) -> dict:
    response = post_concept(client, domain_id, headers=headers, **fields)
    assert response.status_code == 201, response.text
    return response.json()


def _merge(client, source_id, target_id, headers=None, **body):
    return client.post(
        f"/api/concepts/{source_id}/merge",
        json={"target_id": target_id, **body},
        headers=headers,
    )


def _move(client, term_id, target_id, headers=None, **body):
    return client.post(
        f"/api/terms/{term_id}/move",
        json={"target_id": target_id, **body},
        headers=headers,
    )


def _list(client: TestClient, domain_id: int) -> list[dict]:
    return client.get(f"/api/domains/{domain_id}/concepts").json()


def _first_term_id(concept: dict) -> int:
    return concept["sections"][0]["terms"][0]["id"]


def test_merge_preview_then_run(client: TestClient) -> None:
    domain_id = _domain(client)
    source = _concept(client, domain_id, preferred="log in", forbidden=["login"])
    target = _concept(client, domain_id, preferred="sign in")

    preview = _merge(client, source["id"], target["id"], preview=True)
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["source"] is None
    assert [m["text"] for m in body["moved"]] == ["log in", "login"]
    assert "owner_id" not in body["target"]
    assert body["target"]["is_global"] is False
    assert len(_list(client, domain_id)) == 2
    assert client.get(f"/api/concepts/{source['id']}").status_code == 200

    run = _merge(client, source["id"], target["id"], basis=body["basis"], comment="tidy")
    assert run.status_code == 200, run.text
    assert run.json()["target"]["id"] == target["id"]
    [remaining] = _list(client, domain_id)
    assert remaining["id"] == target["id"]
    assert sorted(t["text"] for t in remaining["sections"][0]["terms"]) == [
        "log in",
        "login",
        "sign in",
    ]
    assert client.get(f"/api/concepts/{source['id']}").status_code == 404


def test_move_preview_then_run(client: TestClient) -> None:
    domain_id = _domain(client)
    source = _concept(client, domain_id, preferred="log in", forbidden=["login"])
    target = _concept(client, domain_id, preferred="sign in")
    moving = source["sections"][0]["terms"][1]
    assert moving["text"] == "login"

    preview = _move(client, moving["id"], target["id"], preview=True)
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert [m["id"] for m in body["moved"]] == [moving["id"]]
    assert body["source"]["id"] == source["id"]
    unchanged = {c["id"]: c for c in _list(client, domain_id)}
    assert len(unchanged[source["id"]]["sections"][0]["terms"]) == 2
    assert len(unchanged[target["id"]]["sections"][0]["terms"]) == 1

    run = _move(client, moving["id"], target["id"], basis=body["basis"])
    assert run.status_code == 200, run.text
    by_id = {c["id"]: c for c in _list(client, domain_id)}
    assert [t["text"] for t in by_id[source["id"]]["sections"][0]["terms"]] == ["log in"]
    assert sorted(t["text"] for t in by_id[target["id"]]["sections"][0]["terms"]) == [
        "login",
        "sign in",
    ]


def test_move_to_a_new_concept(client: TestClient) -> None:
    domain_id = _domain(client)
    source = _concept(client, domain_id, preferred="log in", forbidden=["login"])
    moving = source["sections"][0]["terms"][1]

    preview = _move(client, moving["id"], None, preview=True).json()
    assert preview["basis"]["target"] is None
    run = _move(client, moving["id"], None, basis=preview["basis"])
    assert run.status_code == 200, run.text
    assert run.json()["target"]["id"] != source["id"]
    assert len(_list(client, domain_id)) == 2


@pytest.mark.parametrize("kind", ["merge", "move"])
def test_run_without_basis_is_422(client: TestClient, kind: str) -> None:
    domain_id = _domain(client)
    source = _concept(client, domain_id, preferred="log in", forbidden=["login"])
    target = _concept(client, domain_id, preferred="sign in")
    if kind == "merge":
        response = _merge(client, source["id"], target["id"])
    else:
        response = _move(client, source["sections"][0]["terms"][1]["id"], target["id"])
    assert response.status_code == 422
    assert len(_list(client, domain_id)) == 2


def test_outdated_basis_is_409_with_the_concept_id(client: TestClient) -> None:
    domain_id = _domain(client)
    source = _concept(client, domain_id, preferred="log in")
    target = _concept(client, domain_id, preferred="sign in")
    basis = _merge(client, source["id"], target["id"], preview=True).json()["basis"]
    section = target["sections"][0]
    saved = client.put(
        f"/api/concepts/{target['id']}/languages/en",
        json={
            "id": section["id"],
            "revision": section["revision"],
            "definition": "Authenticating.",
            "terms": [{"text": "sign in", "usage_status": "preferred"}],
        },
    )
    assert saved.status_code == 200, saved.text

    response = _merge(client, source["id"], target["id"], basis=basis)
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail == {"code": "outdated", "message": detail["message"], "concept_id": target["id"]}
    assert detail["message"]
    assert client.get(f"/api/concepts/{source['id']}").status_code == 200


def test_rule_errors_are_409_objects(client: TestClient) -> None:
    domain_id = _domain(client)
    first = _concept(client, domain_id, preferred="log in", forbidden=["sign in"])
    second = _concept(client, domain_id, preferred="sign in")

    same = _merge(client, first["id"], first["id"], preview=True)
    assert same.status_code == 409
    assert same.json()["detail"] == {
        "code": "same_concept",
        "message": "Source and target are the same concept.",
    }

    duplicate = _move(client, first["sections"][0]["terms"][1]["id"], second["id"], preview=True)
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == {
        "code": "duplicate_text",
        "message": "The target already has a term with this wording.",
    }

    global_domain = client.app.state.terminology_store.create_domain("Built-in", owner_id=None).id
    built_in = _concept(client, global_domain, preferred="log on")
    mismatch = _merge(client, first["id"], built_in["id"], preview=True)
    assert mismatch.status_code == 409
    assert mismatch.json()["detail"] == {
        "code": "owner_mismatch",
        "message": "Terms can only move between concepts with the same owner: own or built-in.",
    }


def test_unknown_or_foreign_ids_are_404(client: TestClient) -> None:
    other = second_user_headers(client)
    foreign_domain = _domain(client, "Theirs", headers=other)
    foreign = _concept(client, foreign_domain, headers=other, preferred="log in")
    mine = _concept(client, _domain(client), preferred="sign in")
    foreign_term = _first_term_id(foreign)
    own_term = _first_term_id(mine)

    for preview in (True, False):
        extra = {"preview": preview}
        if not preview:
            extra["basis"] = {"source": {"concept_id": 1, "revision": 1, "sections": []}}
        assert _merge(client, 99999, mine["id"], **extra).status_code == 404
        assert _merge(client, mine["id"], 99999, **extra).status_code == 404
        assert _merge(client, foreign["id"], mine["id"], **extra).status_code == 404
        assert _merge(client, mine["id"], foreign["id"], **extra).status_code == 404
        assert _move(client, 99999, mine["id"], **extra).status_code == 404
        assert _move(client, own_term, 99999, **extra).status_code == 404
        assert _move(client, foreign_term, mine["id"], **extra).status_code == 404
        assert _move(client, own_term, foreign["id"], **extra).status_code == 404


def test_non_admin_gets_403_on_global_concepts(client: TestClient) -> None:
    other = second_user_headers(client)
    global_domain = client.app.state.terminology_store.create_domain("Built-in", owner_id=None).id
    built_in = _concept(client, global_domain, preferred="log on", forbidden=["logon"])
    built_in_target = _concept(client, global_domain, preferred="sign on")
    own = _concept(client, _domain(client, "Mine", headers=other), headers=other, preferred="x")

    for preview in (True, False):
        extra = {"preview": preview}
        if not preview:
            basis = _merge(client, built_in["id"], built_in_target["id"], preview=True).json()
            extra["basis"] = basis["basis"]
        assert _merge(client, built_in["id"], built_in_target["id"], other, **extra).status_code == 403
        assert _merge(client, own["id"], built_in["id"], other, **extra).status_code == 403
        term_id = built_in["sections"][0]["terms"][1]["id"]
        assert _move(client, term_id, built_in_target["id"], other, **extra).status_code == 403
    assert len(_list(client, global_domain)) == 2


def test_new_concept_needs_the_feature(tmp_path: Path) -> None:
    db_path = tmp_path / "db.sqlite"
    app_a = _app(tmp_path, db_path=db_path, tiers=WITH_FEATURES)
    headers_a = second_user_headers(app_a)
    domain_id = _domain(app_a, headers=headers_a)
    source = _concept(app_a, domain_id, headers_a, preferred="log in", forbidden=["login"])
    target = _concept(app_a, domain_id, headers_a, preferred="sign in")
    moving = source["sections"][0]["terms"][1]["id"]

    app_b = _app(tmp_path, db_path=db_path, tiers=NO_FEATURES)
    headers_b = second_user_headers(app_b)
    basis = {
        "source": {
            "concept_id": source["id"],
            "revision": source["revision"],
            "sections": [
                {"id": s["id"], "revision": s["revision"]} for s in source["sections"]
            ],
        },
        "target": None,
    }
    assert _move(app_b, moving, None, headers_b, preview=True).status_code == 403
    assert _move(app_b, moving, None, headers_b, basis=basis).status_code == 403
    assert len(_list_for(app_b, domain_id, headers_b)) == 2

    preview = _move(app_b, moving, target["id"], headers_b, preview=True)
    assert preview.status_code == 200, preview.text
    run = _move(app_b, moving, target["id"], headers_b, basis=preview.json()["basis"])
    assert run.status_code == 200, run.text


def _list_for(client: TestClient, domain_id: int, headers: dict) -> list[dict]:
    return client.get(f"/api/domains/{domain_id}/concepts", headers=headers).json()


def test_comment_reaches_the_change_log(client: TestClient) -> None:
    domain_id = _domain(client)
    source = _concept(client, domain_id, preferred="log in", forbidden=["login"])
    target = _concept(client, domain_id, preferred="sign in")

    move_basis = _move(
        client, source["sections"][0]["terms"][1]["id"], target["id"], preview=True
    ).json()["basis"]
    _move(
        client,
        source["sections"][0]["terms"][1]["id"],
        target["id"],
        basis=move_basis,
        comment="Style guide 2026",
    )
    assert changes(client.app.state.db)[-1]["comment"] == "Style guide 2026"

    merge_basis = _merge(client, source["id"], target["id"], preview=True).json()["basis"]
    _merge(client, source["id"], target["id"], basis=merge_basis, comment="Merged by decision")
    assert changes(client.app.state.db)[-1]["comment"] == "Merged by decision"
