"""Tests for the global request-size caps (spec §6.5): the byte-budget ASGI
middleware plus the char-level 413s at the text-entry endpoints."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient as RawASGIClient

from app.api.request_size import RequestSizeLimitMiddleware, byte_budget
from app.core.config import LimitsSettings, Settings
from app.core.models import Language
from app.main import create_app
from tests.conftest import auth_headers

SMALL_CAP = 100  # small char cap, so char-cap tests can use tiny payloads


@pytest.fixture()
def small_cap_client(tmp_path: Path) -> TestClient:
    """A client whose max_document_chars is tiny (byte_budget's own floor of
    5 MB stays out of reach of char caps, so the char-cap tests need a small
    cap of their own rather than one derived from the byte budget)."""
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        limits=LimitsSettings(max_document_chars=SMALL_CAP),
    )
    client = TestClient(create_app(settings))
    client.headers.update(auth_headers(client))
    return client


class TestByteBudget:
    def test_formula(self):
        # Spec §6.5: max(5 MB, 4 × chars + 1 MB) — tuning the char cap can
        # never strand legal payloads behind a stale fixed byte limit.
        assert byte_budget(200000) == 5 * 1024 * 1024
        assert byte_budget(10_000_000) == 4 * 10_000_000 + 1024 * 1024


class TestCharCaps:
    def test_check_text_over_cap_is_413(self, small_cap_client):
        # POST /api/checks with 101 chars -> 413; body mentions the limit.
        response = small_cap_client.post(
            "/api/checks",
            json={"text": "a" * (SMALL_CAP + 1), "language": "en"},
        )
        assert response.status_code == 413
        assert str(SMALL_CAP) in response.json()["detail"]
        # Rejected before job creation: nothing leaked into the job store.
        assert len(small_cap_client.app.state.jobs._jobs) == 0

    def test_document_create_over_cap_is_413(self, small_cap_client):
        response = small_cap_client.post(
            "/api/documents",
            json={
                "name": "Untitled",
                "language": "en",
                "text": "a" * (SMALL_CAP + 1),
            },
        )
        assert response.status_code == 413
        assert str(SMALL_CAP) in response.json()["detail"]

    def test_document_save_over_cap_is_413(self, small_cap_client):
        # PUT with content.text over the cap -> 413. A save under the cap
        # still works (control).
        doc = small_cap_client.post(
            "/api/documents",
            json={"name": "Untitled", "language": "en", "text": "short"},
        ).json()

        oversized = small_cap_client.put(
            f"/api/documents/{doc['id']}",
            json={
                "revision": doc["revision"],
                "content": {"text": "a" * (SMALL_CAP + 1), "findings": []},
            },
        )
        assert oversized.status_code == 413
        assert str(SMALL_CAP) in oversized.json()["detail"]

        ok = small_cap_client.put(
            f"/api/documents/{doc['id']}",
            json={
                "revision": doc["revision"],
                "content": {"text": "a" * SMALL_CAP, "findings": []},
            },
        )
        assert ok.status_code == 200
        assert ok.json()["text"] == "a" * SMALL_CAP

    def test_oversized_document_stays_loadable(self, small_cap_client):
        # Insert a document with text over the cap directly via the store,
        # then GET it -> 200 (the caps gate new saves, never access).
        store = small_cap_client.app.state.document_store
        admin_id = 1  # bootstrap admin, seeded at id 1
        oversized_text = "a" * (SMALL_CAP + 1)
        doc = store.create_document(
            "Legacy", Language.EN, owner_id=admin_id, text=oversized_text
        )

        response = small_cap_client.get(f"/api/documents/{doc.id}")
        assert response.status_code == 200
        assert response.json()["text"] == oversized_text


def _make_probe_app(max_bytes: int):
    """A bare Starlette app behind the size middleware, standing in for the
    real app in tests that need an exact small max_bytes: byte_budget's own
    floor is 5 MB, too large to exercise directly with real test payloads.

    Registered via Starlette's own `middleware=` list -- the same position
    (inside ServerErrorMiddleware) that FastAPI's `app.add_middleware` puts
    it in the real app -- rather than wrapping the built app from the
    outside, which would put a second exception boundary between the raise
    and our handler and break the single clean 413.
    """
    calls: list[int] = []

    async def echo(request):
        body = await request.body()  # BodyTooLarge raises before this returns
        calls.append(1)
        return PlainTextResponse(f"len={len(body)}")

    app = Starlette(
        routes=[Route("/probe", echo, methods=["POST"])],
        middleware=[Middleware(RequestSizeLimitMiddleware, max_bytes=max_bytes)],
    )
    return app, calls


class TestByteMiddleware:
    def test_direct_chunked_body_over_small_budget_is_capped(self):
        # Unit-style, with an explicit small max_bytes rather than one
        # derived from settings (see _make_probe_app).
        app, calls = _make_probe_app(max_bytes=10)
        client = RawASGIClient(app)

        def chunks():
            yield b"12345"
            yield b"67890"
            yield b"abcdef"  # 16 bytes total, over the 10-byte budget

        response = client.post("/probe", content=chunks())
        assert response.status_code == 413
        assert calls == []  # the handler never ran

    def test_oversized_content_length_is_rejected_before_parsing(self, authed_client):
        # Send Content-Length above the budget with a tiny actual body ->
        # 413, rejected before any parsing.
        budget = byte_budget(authed_client.app.state.settings.limits.max_document_chars)
        response = authed_client.post(
            "/api/checks",
            content=b"x",
            headers={
                "Content-Length": str(budget + 1),
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 413

    def test_chunked_body_without_content_length_is_capped(self, authed_client):
        # httpx sends this as chunked transfer with no Content-Length;
        # stream more than the budget -> 413, and the endpoint handler never
        # ran (proven by the lack of a 422: the body below is not valid
        # JSON, so if it reached FastAPI's parsing it would fail loudly).
        budget = byte_budget(authed_client.app.state.settings.limits.max_document_chars)
        chunk = b"x" * 65536
        chunk_count = budget // len(chunk) + 2

        def chunks():
            for _ in range(chunk_count):
                yield chunk

        jobs_before = len(authed_client.app.state.jobs._jobs)
        response = authed_client.post("/api/checks", content=chunks())
        assert response.status_code == 413
        assert len(authed_client.app.state.jobs._jobs) == jobs_before

    def test_413_carries_cors_headers(self, authed_client):
        # Send Origin with the oversized request -> the 413 response
        # includes access-control-allow-origin. Pins the middleware ORDER
        # (CORS outermost, spec §6.5).
        budget = byte_budget(authed_client.app.state.settings.limits.max_document_chars)
        response = authed_client.post(
            "/api/checks",
            content=b"x",
            headers={
                "Content-Length": str(budget + 1),
                "Content-Type": "application/json",
                "Origin": "http://localhost:5173",
            },
        )
        assert response.status_code == 413
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"

    def test_normal_requests_pass_through(self, authed_client):
        # A regular small POST still works with the middleware installed.
        response = authed_client.post(
            "/api/documents", json={"name": "Untitled", "language": "en"}
        )
        assert response.status_code == 201
