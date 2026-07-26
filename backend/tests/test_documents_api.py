import time

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.conftest import auth_headers, second_user_headers


def make_doc(authed_client: TestClient, name: str = "Untitled", **extra) -> dict:
    response = authed_client.post(
        "/api/documents", json={"name": name, "language": "en", **extra}
    )
    assert response.status_code == 201
    return response.json()


def test_create_returns_full_document(authed_client):
    doc = make_doc(authed_client, text="Hello there world.", llm_tier="cheap")
    assert doc["name"] == "Untitled" and doc["name_source"] == "fallback"
    assert doc["text"] == "Hello there world."
    assert doc["revision"] == 0 and doc["llm_tier"] == "cheap"


def test_list_is_recency_ordered_summaries(authed_client):
    a = make_doc(authed_client, name="A")
    b = make_doc(authed_client, name="B")
    listing = authed_client.get("/api/documents").json()
    assert [d["id"] for d in listing] == [b["id"], a["id"]]
    assert "text" not in listing[0] and "last_findings" not in listing[0]


def test_get_full_document_and_404(authed_client):
    doc = make_doc(authed_client)
    assert authed_client.get(f"/api/documents/{doc['id']}").json()["id"] == doc["id"]
    assert authed_client.get("/api/documents/9999").status_code == 404


def test_get_document_prunes_dead_profile_id(authed_client):
    doc = make_doc(authed_client, profile_id=9999)
    body = authed_client.get(f"/api/documents/{doc['id']}").json()
    assert body["profile_id"] is None


def test_get_document_preserves_live_profile_id(authed_client):
    from app.core.models import Language

    profile = authed_client.app.state.profile_store.create_profile(
        Language.EN, "Formal", owner_id=1
    )
    doc = make_doc(authed_client, profile_id=profile.id)
    body = authed_client.get(f"/api/documents/{doc['id']}").json()
    assert body["profile_id"] == profile.id


def test_put_content_and_settings(authed_client):
    doc = make_doc(authed_client)
    response = authed_client.put(
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


def test_put_stale_revision_409(authed_client):
    doc = make_doc(authed_client)
    ok = {"revision": 0, "content": {"text": "a", "findings": [], "scorecard": None}}
    assert authed_client.put(f"/api/documents/{doc['id']}", json=ok).status_code == 200
    stale = authed_client.put(f"/api/documents/{doc['id']}", json=ok)
    assert stale.status_code == 409
    assert authed_client.put("/api/documents/9999", json=ok).status_code == 404


def test_rename_sets_user_source(authed_client):
    doc = make_doc(authed_client)
    body = authed_client.put(
        f"/api/documents/{doc['id']}", json={"revision": 0, "name": "Mine"}
    ).json()
    assert body["name"] == "Mine" and body["name_source"] == "user"
    assert body["revision"] == 1


def test_delete(authed_client):
    doc = make_doc(authed_client)
    assert authed_client.delete(f"/api/documents/{doc['id']}").status_code == 204
    assert authed_client.delete(f"/api/documents/{doc['id']}").status_code == 404


from app.checkers.llm.provider import FakeProvider


def with_provider(authed_client: TestClient, response: str | None) -> None:
    """Route every provider request to a fake; None simulates provider failure."""
    if response is None:
        def failing(name=None, model=None):
            raise RuntimeError("provider unavailable")
        authed_client.app.state.provider_factory = failing
    else:
        authed_client.app.state.provider_factory = (
            lambda name=None, model=None: FakeProvider(response=response)
        )


def test_generate_name_titles_fallback_document(authed_client):
    doc = make_doc(authed_client, text="A long enough body about widget assembly.")
    with_provider(authed_client, '"Widget Assembly Guide."')
    body = authed_client.post(f"/api/documents/{doc['id']}/generate-name").json()
    assert body["name"] == "Widget Assembly Guide"
    assert body["name_source"] == "llm"
    assert body["revision"] == doc["revision"]  # naming never bumps revision


def test_generate_name_failure_falls_back_to_first_words(authed_client):
    doc = make_doc(authed_client, text="alpha beta gamma delta epsilon zeta eta")
    with_provider(authed_client, None)
    body = authed_client.post(f"/api/documents/{doc['id']}/generate-name").json()
    assert body["name"] == "alpha beta gamma delta epsilon zeta"
    assert body["name_source"] == "fallback"


def test_generate_name_noop_when_named(authed_client):
    doc = make_doc(authed_client, text="some body text here")
    authed_client.put(f"/api/documents/{doc['id']}", json={"revision": 0, "name": "Mine"})
    with_provider(authed_client, "Ignored Title")
    body = authed_client.post(f"/api/documents/{doc['id']}/generate-name").json()
    assert body["name"] == "Mine" and body["name_source"] == "user"


def test_generate_name_empty_text_keeps_name(authed_client):
    doc = make_doc(authed_client, name="Untitled", text="")
    with_provider(authed_client, "Ignored")
    body = authed_client.post(f"/api/documents/{doc['id']}/generate-name").json()
    assert body["name"] == "Untitled" and body["name_source"] == "fallback"
    assert authed_client.post("/api/documents/9999/generate-name").status_code == 404


class RenamingProvider:
    """Simulates a user renaming the document while the LLM call is in
    flight, to exercise the generate-name check-then-set TOCTOU race."""

    name = "fake"

    def __init__(self, store, document_id: int, response: str) -> None:
        self.store = store
        self.document_id = document_id
        self.response = response

    async def generate(self, system, user, on_progress=None) -> str:
        self.store.update_document(
            self.document_id, 0, owner_id=1, name="User Renamed", name_source="user"
        )
        return self.response


def test_generate_name_toctou_user_rename_wins(authed_client):
    doc = make_doc(authed_client, text="A long enough body about widget assembly.")
    store = authed_client.app.state.document_store
    authed_client.app.state.provider_factory = lambda name=None, model=None: (
        RenamingProvider(store, doc["id"], '"Some Title."')
    )
    body = authed_client.post(f"/api/documents/{doc['id']}/generate-name").json()
    # The user's rename (which landed mid-flight) must survive; the LLM
    # title from the stale check must not clobber it.
    assert body["name"] == "User Renamed" and body["name_source"] == "user"


class RecordingFactory:
    """Fake provider factory that records the (provider, model) it was asked
    to build, so gate tests can assert what was actually resolved."""

    def __init__(self, response: str = '"A Title."') -> None:
        self.response = response
        self.calls: list[tuple[str | None, str | None]] = []

    def __call__(self, name: str | None = None, model: str | None = None):
        self.calls.append((name, model))
        return FakeProvider(response=self.response)


def _app_with_tiers(tmp_path, tiers: dict | None = None):
    settings = Settings(
        db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules", tiers=tiers or {}
    )
    app = create_app(settings)
    factory = RecordingFactory()
    app.state.provider_factory = factory
    return app, factory


def test_generate_name_floor_user_falls_back_silently(tmp_path):
    # Floor-tier user POSTs generate-name on their own fallback-named
    # document with text: 200, name_source "fallback" (local naming), no
    # factory call, no error field anywhere.
    tiers = {"basic": {"llm": {"tiers": [], "providers": []}}}
    app, factory = _app_with_tiers(tmp_path, tiers)
    with TestClient(app) as client:
        headers = second_user_headers(client)  # non-admin, tier 'basic'
        doc = client.post(
            "/api/documents",
            json={
                "name": "Untitled",
                "language": "en",
                "text": "alpha beta gamma delta epsilon zeta eta",
            },
            headers=headers,
        ).json()
        response = client.post(
            f"/api/documents/{doc['id']}/generate-name", headers=headers
        )
        assert response.status_code == 200
        body = response.json()
    assert body["name_source"] == "fallback"
    assert body["name"] == "alpha beta gamma delta epsilon zeta"
    assert "error" not in body
    assert factory.calls == []


def test_generate_name_uses_cheap_route_through_gate(tmp_path):
    # Unrestricted user: the recording factory receives exactly the
    # routing table's ("cheap") entry for the document's language.
    app, factory = _app_with_tiers(tmp_path)
    with TestClient(app) as client:
        headers = auth_headers(client)
        doc = client.post(
            "/api/documents",
            json={
                "name": "Untitled",
                "language": "en",
                "text": "A long enough body about widget assembly.",
            },
            headers=headers,
        ).json()
        response = client.post(
            f"/api/documents/{doc['id']}/generate-name", headers=headers
        )
        assert response.status_code == 200
        body = response.json()
    assert body["name_source"] == "llm"
    assert factory.calls == [("gemini", "models/gemini-flash-latest")]


def test_generate_name_empty_text_never_reaches_gate(tmp_path):
    # Empty/whitespace document: the factory is never called -- the text
    # guard sits OUTSIDE the gate (and must stay there when M5 adds quota
    # reservation to it).
    app, factory = _app_with_tiers(tmp_path)
    with TestClient(app) as client:
        headers = auth_headers(client)
        doc = client.post(
            "/api/documents",
            json={"name": "Untitled", "language": "en", "text": "   "},
            headers=headers,
        ).json()
        response = client.post(
            f"/api/documents/{doc['id']}/generate-name", headers=headers
        )
        assert response.status_code == 200
        body = response.json()
    assert body["name_source"] == "fallback"
    assert body["name"] == "Untitled"
    assert factory.calls == []


def test_create_document_with_unknown_folder_is_422(authed_client):
    response = authed_client.post(
        "/api/documents",
        json={"name": "Doc", "language": "en", "folder_id": 9999},
    )
    assert response.status_code == 422


def test_move_document_between_folders(authed_client):
    folder = authed_client.post("/api/folders", json={"name": "Target"}).json()
    doc = make_doc(authed_client)
    moved = authed_client.post(
        f"/api/documents/{doc['id']}/move", json={"folder_id": folder["id"]}
    )
    assert moved.status_code == 200
    assert moved.json()["folder_id"] == folder["id"]
    assert moved.json()["revision"] == doc["revision"]  # moves never bump
    assert authed_client.get("/api/documents").json()[0]["folder_id"] == folder["id"]
    back = authed_client.post(f"/api/documents/{doc['id']}/move", json={"folder_id": None})
    assert back.json()["folder_id"] is None
    assert authed_client.post(
        f"/api/documents/{doc['id']}/move", json={"folder_id": 9999}
    ).status_code == 422
    assert authed_client.post(
        "/api/documents/9999/move", json={"folder_id": None}
    ).status_code == 404


def test_documents_api_is_owner_scoped(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    doc = client.post(
        "/api/documents",
        json={"name": "Mine", "language": "en"},
        headers=admin,
    ).json()
    # Foreign id: indistinguishable from nonexistent -- 404 on every verb.
    assert client.get(f"/api/documents/{doc['id']}", headers=other).status_code == 404
    assert (
        client.put(
            f"/api/documents/{doc['id']}",
            json={"revision": 0, "name": "Stolen"},
            headers=other,
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/documents/{doc['id']}", headers=other).status_code == 404
    )
    assert (
        client.post(
            f"/api/documents/{doc['id']}/move",
            json={"folder_id": None},
            headers=other,
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/documents/{doc['id']}/generate-name", headers=other
        ).status_code
        == 404
    )
    listed = client.get("/api/documents", headers=other).json()
    assert listed == []
    # And the owner still sees it untouched.
    assert (
        client.get(f"/api/documents/{doc['id']}", headers=admin).json()["name"]
        == "Mine"
    )


def test_summaries_expose_timestamps_and_order_by_edited(authed_client):
    a = make_doc(authed_client, name="A")
    b = make_doc(authed_client, name="B")
    time.sleep(1.1)  # second-precision timestamps: the edit must be later
    # A check-style save on B (same text, findings only)...
    authed_client.put(
        f"/api/documents/{b['id']}",
        json={
            "revision": 0,
            "content": {"text": "", "findings": [{"finding": {}, "from": 0, "to": 0}], "scorecard": None},
        },
    )
    # ...then a real edit on A.
    authed_client.put(
        f"/api/documents/{a['id']}",
        json={"revision": 0, "content": {"text": "real edit", "findings": [], "scorecard": None}},
    )
    listing = authed_client.get("/api/documents").json()
    assert [d["id"] for d in listing] == [a["id"], b["id"]]
    first = listing[0]
    assert {"created_at", "edited_at", "checked_at", "updated_at"} <= set(first)
