"""Cross-user isolation, endpoint by endpoint.

The per-resource test modules prove each vertical slice; this module proves
the *rule* — every id-addressable endpoint answers 404 for a foreign id,
listings never leak, and 403 appears exactly once (non-admin mutating a
global row). Table-driven so that a new endpoint added without a row here
is a visible review question, not a silent gap.
"""

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.conftest import auth_headers, second_user_headers


@pytest.fixture()
def two_users(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    # One private resource of every kind, owned by the admin.
    doc = client.post("/api/documents", json={"name": "D", "language": "en"}, headers=admin).json()
    folder = client.post("/api/folders", json={"name": "F"}, headers=admin).json()
    profile_body = {
        "language": "en", "name": "P", "categories_off": [], "rule_exceptions": [],
        "packs_on": [], "domain_ids": [], "llm_provider": None, "llm_model": None,
        "llm_tier": None, "llm_instructions": "", "example_text": "",
    }
    profile = client.post("/api/profiles", json=profile_body, headers=admin).json()
    domain = client.post("/api/domains", json={"name": "Dom"}, headers=admin).json()
    term = client.post(
        f"/api/domains/{domain['id']}/terms",
        json={"language": "en", "preferred": "t"},
        headers=admin,
    ).json()
    check = client.post(
        "/api/checks",
        json={"text": "hello", "language": "en", "checkers": ["rules"]},
        headers=admin,
    ).json()
    return client, admin, other, {
        "doc": doc, "folder": folder, "profile": profile,
        "domain": domain, "term": term, "check": check,
        "profile_body": profile_body,
    }


# (method, path-template, json-body-or-None) for every id-addressable
# endpoint over an ownable resource. Adding an endpoint without adding a
# row here should fail review, not slip through.
FOREIGN_404 = [
    ("GET",    "/api/documents/{doc}", None),
    ("PUT",    "/api/documents/{doc}", {"revision": 0, "name": "X"}),
    ("DELETE", "/api/documents/{doc}", None),
    ("POST",   "/api/documents/{doc}/move", {"folder_id": None}),
    ("POST",   "/api/documents/{doc}/generate-name", None),
    ("PUT",    "/api/folders/{folder}", {"name": "X"}),
    ("PUT",    "/api/folders/{folder}/defaults", {}),
    ("DELETE", "/api/folders/{folder}", None),
    ("PUT",    "/api/profiles/{profile}", "profile_body"),
    ("DELETE", "/api/profiles/{profile}", None),
    # Reset on a foreign PRIVATE profile must be 404 (invisible), not the
    # 409 "not Standard" an unscoped lookup would answer with.
    ("POST",   "/api/profiles/{profile}/reset", None),
    ("PUT",    "/api/domains/{domain}", {"name": "X"}),
    ("DELETE", "/api/domains/{domain}", None),
    ("GET",    "/api/domains/{domain}/terms", None),
    ("POST",   "/api/domains/{domain}/terms", {"language": "en", "preferred": "x"}),
    ("PUT",    "/api/terms/{term}", {"preferred": "x"}),
    ("DELETE", "/api/terms/{term}", None),
    ("GET",    "/api/checks/{check}", None),
    ("GET",    "/api/checks/{check}/events", None),
]


@pytest.mark.parametrize("method,template,body", FOREIGN_404)
def test_foreign_id_is_404(two_users, method, template, body):
    client, _admin, other, items = two_users
    ids = {
        "doc": items["doc"]["id"], "folder": items["folder"]["id"],
        "profile": items["profile"]["id"], "domain": items["domain"]["id"],
        "term": items["term"]["id"], "check": items["check"]["check_id"],
    }
    path = template.format(**ids)
    json_body = items["profile_body"] if body == "profile_body" else body
    response = client.request(method, path, json=json_body, headers=other)
    assert response.status_code == 404, (method, path, response.status_code)


def test_listings_never_leak(two_users):
    client, _admin, other, items = two_users
    assert client.get("/api/documents", headers=other).json() == []
    assert client.get("/api/folders", headers=other).json() == []
    assert all(
        p["is_global"]
        for p in client.get("/api/profiles?language=en", headers=other).json()
    )
    assert all(
        d["is_global"]
        for d in client.get("/api/domains", headers=other).json()
    )


def test_global_mutation_as_non_admin_is_403_everywhere(two_users):
    """Every global-mutation route, not a sample: profile PUT/DELETE/reset,
    domain PUT/DELETE, term POST/PUT/DELETE. The two pinned exceptions are
    below the loop."""
    client, admin, other, items = two_users
    g_profiles = {
        p["name"]: p
        for p in client.get("/api/profiles?language=en", headers=other).json()
        if p["is_global"]
    }
    standard = g_profiles["Standard"]
    marketing = g_profiles["Marketing"]  # seed_example_profiles defaults on
    g_domain = next(
        d for d in client.get("/api/domains", headers=other).json() if d["is_global"]
    )
    g_term = client.post(
        f"/api/domains/{g_domain['id']}/terms",
        json={"language": "en", "preferred": "gterm"},
        headers=admin,
    ).json()
    same_name_edit = dict(items["profile_body"], name=standard["name"])
    cases = [
        # (method, path, body) — every route that can mutate a global row.
        ("PUT",    f"/api/profiles/{standard['id']}", same_name_edit),
        ("DELETE", f"/api/profiles/{marketing['id']}", None),
        ("POST",   f"/api/profiles/{standard['id']}/reset", None),
        # F2: reset on a global non-Standard profile — the global-mutation
        # guard must fire before the is-Standard business rule, so a
        # non-admin gets 403 here too, not the 409 an unscoped is_standard
        # check would answer with.
        ("POST",   f"/api/profiles/{marketing['id']}/reset", None),
        ("PUT",    f"/api/domains/{g_domain['id']}", {"name": "X"}),
        ("DELETE", f"/api/domains/{g_domain['id']}", None),
        ("POST",   f"/api/domains/{g_domain['id']}/terms",
                   {"language": "en", "preferred": "x"}),
        ("PUT",    f"/api/terms/{g_term['id']}", {"preferred": "x"}),
        ("DELETE", f"/api/terms/{g_term['id']}", None),
    ]
    for method, path, body in cases:
        response = client.request(method, path, json=body, headers=other)
        assert response.status_code == 403, (method, path, response.status_code)
    # Pinned exceptions: for Standard, the router's own global-mutation
    # guard fires before the store's admin check AND before the router's own
    # is-Standard business rule — so a non-admin gets 403 (never reaching the
    # rename/delete refusal), while an admin reaches the business rule and
    # gets 409. That ordering is deliberate and leaks nothing: Standard is
    # global and visible to all, the 403 tells a non-admin nothing a global
    # listing didn't already, and the 409 reason ("cannot be renamed/deleted")
    # is equally true for admins — Task 3's pinned decision, confirmed here
    # rather than the "409 for every caller" shape once assumed.
    rename = dict(items["profile_body"], name="Renamed Standard")
    assert client.put(
        f"/api/profiles/{standard['id']}", json=rename, headers=other
    ).status_code == 403
    assert client.delete(
        f"/api/profiles/{standard['id']}", headers=other
    ).status_code == 403
    assert client.put(
        f"/api/profiles/{standard['id']}", json=rename, headers=admin
    ).status_code == 409
    assert client.delete(
        f"/api/profiles/{standard['id']}", headers=admin
    ).status_code == 409
    # And the same mutations as admin are permitted, not 403.
    assert client.put(
        f"/api/terms/{g_term['id']}", json={"preferred": "y"}, headers=admin
    ).status_code == 200
    assert client.put(
        f"/api/domains/{g_domain['id']}", json={"name": "Renamed"}, headers=admin
    ).status_code == 200
    assert client.post(
        f"/api/profiles/{standard['id']}/reset", headers=admin
    ).status_code == 200
    # F2: an admin reaches the is-Standard business rule for a global
    # non-Standard profile and gets 409 (never 403 — they're allowed to
    # touch the row, they're just resetting one that has no seed defaults).
    assert client.post(
        f"/api/profiles/{marketing['id']}/reset", headers=admin
    ).status_code == 409
