import asyncio
import json
import logging
import sqlite3
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from app.checkers.llm.provider import FakeProvider, GenerationResult, LLMProvider, TokenUsage
from app.core.config import (
    CreditCostSettings,
    LimitsSettings,
    NlpSettings,
    Settings,
    TierLimitsSettings,
)
from app.main import create_app
from app.services.credits import estimate_cost
from tests.conftest import auth_headers, second_user_headers

RULES_DIR = Path(__file__).parent.parent / "rules"

LLM_RESPONSE = json.dumps(
    [
        {
            "category": "vividness",
            "severity": "suggestion",
            "quote": "nice",
            "message": "Bland adjective.",
            "suggestions": ["delightful"],
        }
    ]
)


def one_run_budget(text: str, source: str = "check") -> int:
    """A credits_per_day that admits exactly one run of `text`: after run 1
    the sum equals the budget (not >); run 2 pushes it over."""
    return estimate_cost(source=source, provider="any", model="any",
                         text_chars=len(text), config=CreditCostSettings())


def make_client(tmp_path: Path, provider: LLMProvider) -> TestClient:
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=RULES_DIR)
    app = create_app(settings)
    app.state.provider_factory = lambda name=None, model=None: provider
    # Context-managed use keeps one event loop across requests so that
    # background LLM tasks scheduled by POST survive into later requests.
    client = TestClient(app)
    client.headers.update(auth_headers(client))
    return client


@pytest.fixture
def client(tmp_path: Path):
    with make_client(tmp_path, FakeProvider(LLM_RESPONSE)) as client:
        yield client


def test_rules_only_check_returns_findings_inline(client: TestClient) -> None:
    response = client.post(
        "/api/checks",
        json={"text": "This is very nice.", "language": "en", "checkers": ["rules"]},
    )
    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "done"
    assert any(f["rule_id"] == "style.weasel-words" for f in body["findings"])


def test_check_with_llm_completes_and_merges(client: TestClient) -> None:
    post = client.post(
        "/api/checks",
        json={
            "text": "This is very nice.",
            "language": "en",
            "checkers": ["rules", "llm"],
        },
    )
    assert post.status_code == 202
    check_id = post.json()["check_id"]

    with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
        events = _read_sse_events(stream)
    assert events[-1][0] == "done"

    final = client.get(f"/api/checks/{check_id}").json()
    assert final["status"] == "done"
    sources = {f["source"] for f in final["findings"]}
    assert sources == {"rule", "llm"}
    llm_findings = [f for f in final["findings"] if f["source"] == "llm"]
    assert llm_findings[0]["span"]["text"] == "nice"


def test_terminology_checker_requires_domain(client: TestClient) -> None:
    domain = client.post("/api/domains", json={"name": "Docs"}).json()
    client.post(
        f"/api/domains/{domain['id']}/terms",
        json={"language": "en", "preferred": "sign in", "forbidden_variants": ["login"]},
    )
    response = client.post(
        "/api/checks",
        json={
            "text": "Please login now.",
            "language": "en",
            "domain_ids": [domain["id"]],
            "checkers": ["terminology"],
        },
    )
    findings = response.json()["findings"]
    assert len(findings) == 1
    assert findings[0]["suggestions"] == ["sign in"]


def test_check_request_ignores_foreign_domain_ids(tmp_path: Path) -> None:
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    domain = client.post("/api/domains", json={"name": "Private"}, headers=admin).json()
    client.post(
        f"/api/domains/{domain['id']}/terms",
        json={"language": "en", "preferred": "sign in", "forbidden_variants": ["login"]},
        headers=admin,
    )
    # The owner's check flags the forbidden variant...
    owner_check = client.post(
        "/api/checks",
        json={"text": "please login here", "language": "en",
              "domain_ids": [domain["id"]], "checkers": ["terminology"]},
        headers=admin,
    ).json()
    assert any(f["source"] == "terminology" for f in owner_check["findings"])
    # ...the same request from another user yields nothing: the foreign id
    # resolves to an invisible domain in the checker's scoped store read,
    # exactly like a deleted one.
    foreign_check = client.post(
        "/api/checks",
        json={"text": "please login here", "language": "en",
              "domain_ids": [domain["id"]], "checkers": ["terminology"]},
        headers=other,
    ).json()
    assert not any(f["source"] == "terminology" for f in foreign_check["findings"])


@pytest.fixture()
def client_with_two_domains(tmp_path: Path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=RULES_DIR, seed_terminology=False)
    client = TestClient(create_app(settings))
    client.headers.update(auth_headers(client))
    ids = []
    for name, preferred, forbidden in [
        ("Docs", "sign in", ["login"]),
        ("Style", "email", ["e-mail"]),
    ]:
        domain = client.post("/api/domains", json={"name": name}).json()
        client.post(
            f"/api/domains/{domain['id']}/terms",
            json={"language": "en", "preferred": preferred,
                  "forbidden_variants": forbidden},
        )
        ids.append(domain["id"])
    return client, ids


def test_check_with_multiple_domains(client_with_two_domains) -> None:
    """Terminology findings come from the union of all selected domains."""
    client, ids = client_with_two_domains  # two domains, one forbidden term each
    body = {"text": "Use login and e-mail.", "language": "en",
            "domain_ids": ids, "checkers": ["terminology"]}
    findings = client.post("/api/checks", json=body).json()["findings"]
    assert len(findings) == 2


def test_check_overlapping_domains_deduped(tmp_path: Path) -> None:
    """Two domains forbidding the same variant yield one finding, not two."""
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=RULES_DIR, seed_terminology=False)
    client = TestClient(create_app(settings))
    client.headers.update(auth_headers(client))
    ids = []
    for name, preferred in [("Docs", "sign in"), ("Style", "log in")]:
        domain = client.post("/api/domains", json={"name": name}).json()
        client.post(
            f"/api/domains/{domain['id']}/terms",
            json={"language": "en", "preferred": preferred,
                  "forbidden_variants": ["login"]},
        )
        ids.append(domain["id"])
    body = {"text": "Use login here.", "language": "en",
            "domain_ids": ids, "checkers": ["terminology"]}
    findings = client.post("/api/checks", json=body).json()["findings"]
    assert len(findings) == 1


def test_check_with_rule_config(client: TestClient) -> None:
    body = {"text": "This is very good. The cat cat sat.", "language": "en",
            "checkers": ["rules"],
            "rule_config": {"categories_off": ["style"], "exceptions": []}}
    findings = client.post("/api/checks", json=body).json()["findings"]
    assert findings, "a non-style rule must still fire"
    assert all(f["category"] != "style" for f in findings)


class RecordingProvider:
    """Fake LLM provider that records the system prompt it was given."""

    name = "fake"

    def __init__(self) -> None:
        self.last_system: str | None = None

    async def generate(self, system, user, on_progress=None) -> GenerationResult:
        self.last_system = system
        return GenerationResult(text="[]", usage=TokenUsage())


@pytest.fixture()
def client_with_recording_provider(tmp_path: Path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=RULES_DIR, seed_terminology=False)
    app = create_app(settings)
    recorder = RecordingProvider()
    app.state.provider_factory = lambda name=None, model=None: recorder
    client = TestClient(app)
    client.headers.update(auth_headers(client))
    with client:
        yield client, recorder


def test_check_passes_llm_instructions_to_provider(client_with_recording_provider) -> None:
    """The recording provider stores the system prompt; instructions must appear."""
    client, recorder = client_with_recording_provider
    body = {"text": "Hello.", "language": "en", "checkers": ["llm"],
            "llm_instructions": "Audience: kids."}
    post = client.post("/api/checks", json=body)
    check_id = post.json()["check_id"]

    with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
        _read_sse_events(stream)

    assert recorder.last_system is not None
    assert "Audience: kids." in recorder.last_system


def test_llm_failure_still_finishes_job_with_fast_findings(tmp_path: Path) -> None:
    class BrokenProvider:
        name = "broken"

        async def generate(self, system: str, user: str) -> GenerationResult:
            raise RuntimeError("model exploded")

    with make_client(tmp_path, BrokenProvider()) as client:
        _assert_llm_failure_handled(client)


def _assert_llm_failure_handled(client: TestClient) -> None:
    post = client.post(
        "/api/checks",
        json={
            "text": "This is very nice.",
            "language": "en",
            "checkers": ["rules", "llm"],
        },
    )
    check_id = post.json()["check_id"]
    with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
        events = _read_sse_events(stream)
    names = [name for name, _ in events]
    assert "checker_error" in names
    final = client.get(f"/api/checks/{check_id}").json()
    assert final["status"] == "done"
    assert any(f["source"] == "rule" for f in final["findings"])


def test_nlp_rules_run_when_model_available(client: TestClient) -> None:
    response = client.post(
        "/api/checks",
        json={
            "text": "The report was written by the team.",
            "language": "en",
            "checkers": ["rules"],
        },
    )
    body = response.json()
    rule_ids = {f["rule_id"] for f in body["findings"]}
    assert "style.passive-voice" in rule_ids
    assert body["skipped_rules"] == []


def test_missing_model_skips_nlp_rules_but_runs_regex(tmp_path: Path) -> None:
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=RULES_DIR,
        nlp=NlpSettings(models={"en": "xx_totally_missing"}),
    )
    app = create_app(settings)
    app.state.provider_factory = lambda name=None, model=None: FakeProvider("[]")
    client = TestClient(app)
    client.headers.update(auth_headers(client))
    with client:
        response = client.post(
            "/api/checks",
            json={
                "text": "This is very nice and it was written quickly.",
                "language": "en",
                "checkers": ["rules"],
            },
        )
        body = response.json()
        rule_ids = {f["rule_id"] for f in body["findings"]}
        assert "style.weasel-words" in rule_ids
        assert "style.passive-voice" not in rule_ids
        assert "style.passive-voice" in body["skipped_rules"]


def test_get_unknown_check_is_404(client: TestClient) -> None:
    assert client.get("/api/checks/nope").status_code == 404


def test_list_rules_endpoint(client: TestClient) -> None:
    body = client.get("/api/rules").json()
    assert body["errors"] == []
    rule_ids = {r["rule_id"] for r in body["rules"]}
    assert "style.weasel-words" in rule_ids
    assert client.post("/api/rules/reload").status_code == 200


def _read_sse_events(stream) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    event_name = None
    for line in stream.iter_lines():
        if line.startswith("event:"):
            event_name = line.split(":", 1)[1].strip()
        elif line.startswith("data:") and event_name:
            data = json.loads(line.split(":", 1)[1].strip() or "{}")
            events.append((event_name, data))
            if event_name == "done":
                break
            event_name = None
    return events


TIERS_CONFIG = {
    "basic": {"llm": {"tiers": ["local"], "providers": ["ollama"]}, "limits": {
        "credits_per_day": 1_000_000, "max_llm_document_chars": 100000, "concurrent_llm_runs": 5,
    }},
}


class RecordingFactory:
    """Fake provider factory that records the (provider, model) it was asked
    to build, so tests can assert what the gate actually resolved to."""

    def __init__(self, response: str = LLM_RESPONSE) -> None:
        self.response = response
        self.calls: list[tuple[str | None, str | None]] = []

    def __call__(self, name: str | None = None, model: str | None = None) -> LLMProvider:
        self.calls.append((name, model))
        return FakeProvider(self.response)


class SelectiveFactory:
    """Mimics the real make_provider_factory: raises ValueError for a
    provider name this deployment has not configured (e.g. an optional
    extra like gemini referenced by the default routing table), instead of
    unconditionally returning a fake provider. Lets tests exercise the
    gate's except-ValueError -> skipped path end to end."""

    def __init__(self, known: set[str], response: str = LLM_RESPONSE) -> None:
        self.known = known
        self.response = response
        self.calls: list[tuple[str | None, str | None]] = []

    def __call__(self, name: str | None = None, model: str | None = None) -> LLMProvider:
        self.calls.append((name, model))
        if name not in self.known:
            raise ValueError(f"Unknown LLM provider: {name}")
        return FakeProvider(self.response)


def _app_with_tiers(tmp_path: Path, tiers: dict | None = None):
    settings = Settings(
        db_path=tmp_path / "t.db", rules_dir=RULES_DIR, tiers=tiers or {}
    )
    app = create_app(settings)
    factory = RecordingFactory()
    app.state.provider_factory = factory
    return app, factory


class TestEffectiveLlm:
    def test_unrestricted_tier_request_resolves_via_routing(self, tmp_path: Path) -> None:
        app, factory = _app_with_tiers(tmp_path)
        with TestClient(app) as client:
            headers = auth_headers(client)
            post = client.post(
                "/api/checks",
                json={
                    "text": "A nice text.",
                    "language": "en",
                    "checkers": ["llm"],
                    "llm_tier": "balanced",
                },
                headers=headers,
            )
            assert post.status_code == 202
            body = post.json()
            expected = {
                "requested": {"tier": "balanced", "provider": None, "model": None},
                "effective": {
                    "tier": "balanced",
                    "provider": "claude",
                    "model": "claude-sonnet-5",
                },
                "degraded": False,
                "skipped": None,
            }
            assert body["effective_llm"] == expected
            check_id = body["check_id"]

            with client.stream(
                "GET", f"/api/checks/{check_id}/events", headers=headers
            ) as stream:
                events = _read_sse_events(stream)
            effective_events = [data for name, data in events if name == "effective_llm"]
            assert effective_events == [expected]

            final = client.get(f"/api/checks/{check_id}", headers=headers).json()
            assert final["effective_llm"] == expected
        assert factory.calls == [("claude", "claude-sonnet-5")]

    def test_routing_to_unconfigured_provider_is_skipped_not_500(
        self, tmp_path: Path
    ) -> None:
        """A granted quality tier can still route to a provider this server
        has not configured (the default table references optional extras
        like gemini as configuration guidance, spec §7.2 comment in
        llm_gate.py). The factory's ValueError must surface as a graceful
        skip, never a 500."""
        settings = Settings(db_path=tmp_path / "t.db", rules_dir=RULES_DIR)
        app = create_app(settings)
        # Only ollama/claude are "configured" here; the default en/cheap
        # routing entry points at gemini, which this factory cannot build.
        factory = SelectiveFactory(known={"ollama", "claude"})
        app.state.provider_factory = factory
        with TestClient(app) as client:
            headers = auth_headers(client)  # admin: unrestricted policy
            post = client.post(
                "/api/checks",
                json={
                    "text": "A nice text.",
                    "language": "en",
                    "checkers": ["llm"],
                    "llm_tier": "cheap",
                },
                headers=headers,
            )
            assert post.status_code == 202
            body = post.json()
            assert body["status"] == "done"
            assert body["findings"] == []
            expected = {
                "requested": {"tier": "cheap", "provider": None, "model": None},
                "effective": {
                    "tier": "cheap",
                    "provider": "gemini",
                    "model": "models/gemini-flash-latest",
                },
                "degraded": False,
                "skipped": "llm_unavailable",
            }
            assert body["effective_llm"] == expected
            check_id = body["check_id"]

            final = client.get(f"/api/checks/{check_id}", headers=headers).json()
            assert final["effective_llm"] == expected
        assert factory.calls == [("gemini", "models/gemini-flash-latest")]

    def test_restricted_user_degrades_balanced_to_local(self, tmp_path: Path) -> None:
        app, factory = _app_with_tiers(tmp_path, TIERS_CONFIG)
        with TestClient(app) as client:
            headers = second_user_headers(client)  # non-admin, tier 'basic'
            post = client.post(
                "/api/checks",
                json={
                    "text": "A nice text.",
                    "language": "en",
                    "checkers": ["llm"],
                    "llm_tier": "balanced",
                },
                headers=headers,
            )
            assert post.status_code == 202
            body = post.json()
            expected = {
                "requested": {"tier": "balanced", "provider": None, "model": None},
                "effective": {
                    "tier": "local",
                    "provider": "ollama",
                    "model": "mistral-nemo:12b-instruct-2407-q6_K",
                },
                "degraded": True,
                "skipped": None,
            }
            assert body["effective_llm"] == expected
            check_id = body["check_id"]

            with client.stream(
                "GET", f"/api/checks/{check_id}/events", headers=headers
            ) as stream:
                _read_sse_events(stream)
            final = client.get(f"/api/checks/{check_id}", headers=headers).json()
            assert final["effective_llm"] == expected
        assert factory.calls == [("ollama", "mistral-nemo:12b-instruct-2407-q6_K")]

    def test_floor_user_gets_skipped_not_error(self, tmp_path: Path) -> None:
        tiers = {"basic": {"llm": {"tiers": [], "providers": []}, "limits": {
            "credits_per_day": 1_000_000, "max_llm_document_chars": 100000, "concurrent_llm_runs": 5,
        }}}
        app, factory = _app_with_tiers(tmp_path, tiers)
        with TestClient(app) as client:
            headers = second_user_headers(client)  # non-admin, tier 'basic'
            post = client.post(
                "/api/checks",
                json={"text": "A nice text.", "language": "en", "checkers": ["llm"]},
                headers=headers,
            )
            assert post.status_code == 202
            body = post.json()
            assert body["status"] == "done"
            assert body["findings"] == []
            assert body["effective_llm"]["skipped"] == "llm_unavailable"
            check_id = body["check_id"]

            final = client.get(f"/api/checks/{check_id}", headers=headers).json()
            assert final["effective_llm"]["skipped"] == "llm_unavailable"
        assert factory.calls == []

    def test_unknown_llm_provider_is_422(self, tmp_path: Path) -> None:
        app, factory = _app_with_tiers(tmp_path)
        with TestClient(app) as client:
            headers = auth_headers(client)
            post = client.post(
                "/api/checks",
                json={
                    "text": "A nice text.",
                    "language": "en",
                    "checkers": ["llm"],
                    "llm_provider": "nope",
                },
                headers=headers,
            )
            assert post.status_code == 422
            # No job leaked as permanently-running (mirrors test_jobs.py's
            # direct use of the private store to assert retention behavior).
            assert len(app.state.jobs._jobs) == 0
        assert factory.calls == []

    def test_invalid_llm_tier_is_422(self, tmp_path: Path) -> None:
        app, factory = _app_with_tiers(tmp_path)
        with TestClient(app) as client:
            headers = auth_headers(client)
            post = client.post(
                "/api/checks",
                json={
                    "text": "A nice text.",
                    "language": "en",
                    "checkers": ["llm"],
                    "llm_tier": "turbo",
                },
                headers=headers,
            )
            assert post.status_code == 422
        assert factory.calls == []

    def test_tier_request_ignores_bogus_provider(self, tmp_path: Path) -> None:
        app, factory = _app_with_tiers(tmp_path)
        with TestClient(app) as client:
            headers = auth_headers(client)
            post = client.post(
                "/api/checks",
                json={
                    "text": "A nice text.",
                    "language": "en",
                    "checkers": ["llm"],
                    "llm_tier": "local",
                    "llm_provider": "nope",
                },
                headers=headers,
            )
            assert post.status_code == 202
            body = post.json()
            assert body["effective_llm"]["requested"]["tier"] == "local"
            assert body["effective_llm"]["effective"]["provider"] == "ollama"
        assert factory.calls == [("ollama", "mistral-nemo:12b-instruct-2407-q6_K")]

    def test_no_llm_checker_has_no_effective_llm(self, tmp_path: Path) -> None:
        app, factory = _app_with_tiers(tmp_path)
        with TestClient(app) as client:
            headers = auth_headers(client)
            post = client.post(
                "/api/checks",
                json={"text": "A nice text.", "language": "en", "checkers": ["rules"]},
                headers=headers,
            )
            assert post.status_code == 202
            body = post.json()
            assert body["effective_llm"] is None
            final = client.get(f"/api/checks/{body['check_id']}", headers=headers).json()
            assert final["effective_llm"] is None
        assert factory.calls == []


def test_llm_progress_events_stream(tmp_path: Path) -> None:
    provider = FakeProvider(LLM_RESPONSE, progress_steps=[5, 40, 41])
    with make_client(tmp_path, provider) as client:
        check = client.post(
            "/api/checks",
            json={"text": "A nice text.", "language": "en", "checkers": ["llm"]},
        ).json()
        with client.stream("GET", f"/api/checks/{check['check_id']}/events") as stream:
            events = _read_sse_events(stream)
    progress = [data["tokens"] for name, data in events if name == "llm_progress"]
    # 5 (first) and 40 (+35) pass the >=25-token throttle; 41 (+1) does not.
    assert progress == [5, 40]
    assert events[-1][0] == "done"


def test_check_accepts_packs_on(client) -> None:
    response = client.post(
        "/api/checks",
        json={
            "text": "This is very interesting.",
            "language": "en",
            "checkers": ["rules"],
            "rule_config": {
                "categories_off": [],
                "exceptions": [],
                "packs_on": ["marketing"],
            },
        },
    )
    assert response.status_code == 202


SCORECARD = {
    "consistency": {"score": 4, "note": "Terminology is uniform."},
    "flow": {"score": 3, "note": "Transitions are functional."},
    "clarity": {"score": 4, "note": "Mostly easy to follow."},
    "vividness": {"score": 2, "note": "Abstract throughout."},
    "tone": {"score": 5, "note": "Fits the genre well."},
    "structure": {"score": 3, "note": "Sound but flat ordering."},
}


def test_scorecard_streams_and_polls(tmp_path: Path) -> None:
    response = json.dumps({"findings": json.loads(LLM_RESPONSE), "scorecard": SCORECARD})
    with make_client(tmp_path, FakeProvider(response)) as client:
        check = client.post(
            "/api/checks",
            json={"text": "A nice text.", "language": "en", "checkers": ["llm"]},
        ).json()
        assert check["scorecard"] is None  # LLM still running at POST time
        with client.stream("GET", f"/api/checks/{check['check_id']}/events") as stream:
            events = _read_sse_events(stream)
        final = client.get(f"/api/checks/{check['check_id']}").json()

    scorecard_events = [data for name, data in events if name == "scorecard"]
    assert scorecard_events == [SCORECARD]
    assert final["scorecard"] == SCORECARD
    # Findings from the same (object-form) response still arrive normally.
    assert any(f["span"]["text"] == "nice" for f in final["findings"])


def test_bare_array_response_yields_null_scorecard(client: TestClient) -> None:
    check = client.post(
        "/api/checks",
        json={"text": "A nice text.", "language": "en", "checkers": ["llm"]},
    ).json()
    with client.stream("GET", f"/api/checks/{check['check_id']}/events") as stream:
        events = _read_sse_events(stream)
    final = client.get(f"/api/checks/{check['check_id']}").json()
    assert final["scorecard"] is None
    assert all(name != "scorecard" for name, _ in events)


def test_check_results_are_invisible_to_other_users(tmp_path: Path) -> None:
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    check = client.post(
        "/api/checks",
        json={"text": "the secret launch date is May", "language": "en",
              "checkers": ["rules"]},
        headers=admin,
    ).json()
    check_id = check["check_id"]
    assert client.get(f"/api/checks/{check_id}", headers=admin).status_code == 200
    # Foreign caller: 404 on status and on the SSE stream, indistinguishable
    # from an unknown id.
    assert client.get(f"/api/checks/{check_id}", headers=other).status_code == 404
    assert (
        client.get(f"/api/checks/{check_id}/events", headers=other).status_code
        == 404
    )
    unknown = client.get(f"/api/checks/{uuid.uuid4()}", headers=other)
    assert unknown.status_code == 404
    assert (
        unknown.json()
        == client.get(f"/api/checks/{check_id}", headers=other).json()
    )


def test_job_retention_is_per_owner_not_global_fifo(tmp_path: Path) -> None:
    # Pins the fix: flooding with cheap checks used to evict the *global*
    # oldest job regardless of owner, so one user's flood could 404 another
    # user's still-running or recently finished check. The cap must be
    # enforced per owner, never cross-owner.
    from app.services.jobs import MAX_JOBS_PER_OWNER

    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)

    b_check = client.post(
        "/api/checks",
        json={"text": "b's job", "language": "en", "checkers": ["rules"]},
        headers=other,
    ).json()

    a_first_check_id = None
    for i in range(MAX_JOBS_PER_OWNER + 1):
        resp = client.post(
            "/api/checks",
            json={"text": f"a's job {i}", "language": "en", "checkers": ["rules"]},
            headers=admin,
        ).json()
        if i == 0:
            a_first_check_id = resp["check_id"]

    # A's oldest job was evicted by A's own flood...
    assert (
        client.get(f"/api/checks/{a_first_check_id}", headers=admin).status_code
        == 404
    )
    # ...but B's job, created before A's flood, is untouched.
    assert (
        client.get(f"/api/checks/{b_check['check_id']}", headers=other).status_code
        == 200
    )


def test_at_capacity_with_all_jobs_running_refuses_new_check_with_429(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Router-level companion to the JobManager unit tests in test_jobs.py:
    # confirms JobsAtCapacity actually surfaces as a 429 through the API,
    # not just as an internal exception.
    from app.services import jobs as jobs_module

    monkeypatch.setattr(jobs_module, "MAX_JOBS", 1)
    monkeypatch.setattr(jobs_module, "MAX_JOBS_PER_OWNER", 1)

    class HangingProvider:
        """Never resolves, so its job's status stays 'running' forever."""

        name = "hanging"

        async def generate(self, system: str, user: str, on_progress=None) -> GenerationResult:
            await asyncio.Event().wait()

    settings = Settings(db_path=tmp_path / "t.db", rules_dir=RULES_DIR)
    app = create_app(settings)
    app.state.provider_factory = lambda name=None, model=None: HangingProvider()
    with TestClient(app) as client:
        admin = auth_headers(client)
        other = second_user_headers(client)

        first = client.post(
            "/api/checks",
            json={"text": "a's job", "language": "en", "checkers": ["llm"]},
            headers=admin,
        )
        assert first.json()["status"] == "running"  # store now at MAX_JOBS (1)

        second = client.post(
            "/api/checks",
            json={"text": "b's job", "language": "en", "checkers": ["llm"]},
            headers=other,
        )
        assert second.status_code == 429


def test_failed_setup_discards_job_and_does_not_leak_running_entry(
    tmp_path: Path,
) -> None:
    """POST /api/checks with an unknown llm_provider is rejected by the gate
    (422, spec §7.2) before the factory is ever called, and discards the job.

    Repeated failures must not leak permanently-running jobs: the next valid
    request for the same owner should succeed (not 429), proving the failed
    job was cleaned up and did not consume the owner's quota.
    """
    from app.services.jobs import MAX_JOBS_PER_OWNER

    settings = Settings(db_path=tmp_path / "t.db", rules_dir=RULES_DIR)
    app = create_app(settings)
    factory = RecordingFactory()
    app.state.provider_factory = factory

    with TestClient(app) as client:
        headers = auth_headers(client)

        # Trigger MAX_JOBS_PER_OWNER+1 failed checks with an unknown provider.
        # Each 422 comes from the gate's known-provider check, raised inside
        # create_check's existing try/except discard net -- no jobs should
        # accumulate to hit the per-owner cap.
        for i in range(MAX_JOBS_PER_OWNER + 1):
            response = client.post(
                "/api/checks",
                json={
                    "text": f"Text {i}",
                    "language": "en",
                    "checkers": ["llm"],
                    "llm_provider": "unknown",
                },
                headers=headers,
            )
            assert response.status_code == 422

        assert factory.calls == []  # the gate blocked it before the factory ran

        # The next valid check must succeed (not 429), proving no leaked jobs.
        valid = client.post(
            "/api/checks",
            json={
                "text": "Valid text",
                "language": "en",
                "checkers": ["llm"],
                "llm_provider": None,  # Will use default provider
            },
            headers=headers,
        )
        assert valid.status_code == 202
        assert valid.json()["status"] == "running"


def _read_usage_rows(db_path: Path) -> list[sqlite3.Row]:
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute("SELECT * FROM llm_usage ORDER BY id").fetchall()


class HangingProvider:
    """Never resolves, so its reservation stays 'started' forever unless the
    test cancels the task or the process ends. Each call awaits a fresh
    Event that is never set, matching the existing hanging-provider idiom in
    this file (test_at_capacity_with_all_jobs_running_refuses_new_check)."""

    name = "hanging"

    async def generate(self, system: str, user: str, on_progress=None) -> GenerationResult:
        await asyncio.Event().wait()


class TestCheckMetering:
    def test_llm_run_writes_a_completed_ledger_row(self, tmp_path: Path) -> None:
        settings = Settings(db_path=tmp_path / "test.db", rules_dir=RULES_DIR)
        app = create_app(settings)
        provider = FakeProvider(LLM_RESPONSE, progress_steps=[5, 40, 41])
        app.state.provider_factory = lambda name=None, model=None: provider
        text = "This is very nice."
        with TestClient(app) as client:
            client.headers.update(auth_headers(client))
            post = client.post(
                "/api/checks",
                json={"text": text, "language": "en", "checkers": ["llm"]},
            )
            check_id = post.json()["check_id"]
            with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
                events = _read_sse_events(stream)
            assert events[-1][0] == "done"
            final = client.get(f"/api/checks/{check_id}").json()
            assert final["status"] == "done"

        rows = _read_usage_rows(settings.db_path)
        assert len(rows) == 1
        row = rows[0]
        assert row["status"] == "completed"
        assert row["source"] == "check"
        assert row["run_id"] == check_id
        assert row["text_chars"] == len(text)
        assert row["output_tokens"] == 41  # the fake's last progress value

    def test_provider_failure_writes_a_failed_row(self, tmp_path: Path) -> None:
        class BrokenProvider:
            name = "broken"

            async def generate(self, system: str, user: str, on_progress=None) -> GenerationResult:
                raise RuntimeError("model exploded")

        settings = Settings(db_path=tmp_path / "test.db", rules_dir=RULES_DIR)
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: BrokenProvider()
        with TestClient(app) as client:
            client.headers.update(auth_headers(client))
            post = client.post(
                "/api/checks",
                json={"text": "This is very nice.", "language": "en",
                      "checkers": ["rules", "llm"]},
            )
            check_id = post.json()["check_id"]
            with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
                events = _read_sse_events(stream)
            assert any(name == "checker_error" for name, _ in events)
            final = client.get(f"/api/checks/{check_id}").json()
            assert final["status"] == "done"

        rows = _read_usage_rows(settings.db_path)
        assert len(rows) == 1
        assert rows[0]["status"] == "failed"
        assert rows[0]["fail_stage"] == "provider"
        assert rows[0]["fail_detail"] == "RuntimeError: model exploded"

    def test_completed_run_settles_provider_usage(self, tmp_path: Path) -> None:
        # progress_steps make the approximation (41) available, so this
        # pins that reported usage WINS over the approximation (spec §3.3) —
        # without them, an inverted precedence would still pass.
        provider = FakeProvider(
            LLM_RESPONSE, progress_steps=[5, 40, 41],
            usage=TokenUsage(input_tokens=100, output_tokens=20),
        )
        with make_client(tmp_path, provider) as client:
            post = client.post(
                "/api/checks",
                json={"text": "This is very nice.", "language": "en",
                      "checkers": ["llm"]},
            )
            check_id = post.json()["check_id"]
            with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
                _read_sse_events(stream)
        (row,) = _read_usage_rows(tmp_path / "test.db")
        assert row["status"] == "completed"
        assert row["input_tokens"] == 100
        assert row["output_tokens"] == 20  # reported count, not the 41 approximation
        assert row["fail_stage"] is None
        assert row["fail_detail"] is None

    def test_unparseable_response_is_response_stage_failure(self, tmp_path: Path) -> None:
        # Spec §4.4: garbage output no longer settles 'completed' with zero
        # findings; the detail records length metadata, never the text —
        # and the usage generate() already burned still settles (spec §3.3).
        provider = FakeProvider(
            "I could not find any issues worth reporting.",
            usage=TokenUsage(input_tokens=90, output_tokens=15),
        )
        with make_client(tmp_path, provider) as client:
            post = client.post(
                "/api/checks",
                json={"text": "This is very nice.", "language": "en",
                      "checkers": ["llm"]},
            )
            check_id = post.json()["check_id"]
            with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
                events = _read_sse_events(stream)
            assert any(name == "checker_error" for name, _ in events)
        (row,) = _read_usage_rows(tmp_path / "test.db")
        assert row["status"] == "failed"
        assert row["fail_stage"] == "response"
        assert "UnparseableResponseError" in row["fail_detail"]
        assert "could not find" not in row["fail_detail"]  # guardrail
        assert row["input_tokens"] == 90   # usage survives the parse failure
        assert row["output_tokens"] == 15

    def test_empty_findings_envelope_still_completes(self, tmp_path: Path) -> None:
        with make_client(tmp_path, FakeProvider('{"findings": []}')) as client:
            post = client.post(
                "/api/checks",
                json={"text": "This is very nice.", "language": "en",
                      "checkers": ["llm"]},
            )
            check_id = post.json()["check_id"]
            with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
                _read_sse_events(stream)
            final = client.get(f"/api/checks/{check_id}").json()
            assert final["findings"] == []
        (row,) = _read_usage_rows(tmp_path / "test.db")
        assert row["status"] == "completed"
        assert row["fail_stage"] is None

    def test_quota_exhausted_degrades_with_skip_code(self, tmp_path: Path) -> None:
        first_text = "a nice text"
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(admin=TierLimitsSettings(
                credits_per_day=one_run_budget(first_text),
                max_llm_document_chars=200000, concurrent_llm_runs=5,
            )),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: FakeProvider(LLM_RESPONSE)
        with TestClient(app) as client:
            client.headers.update(auth_headers(client))
            first = client.post(
                "/api/checks",
                json={"text": first_text, "language": "en", "checkers": ["llm"]},
            )
            with client.stream(
                "GET", f"/api/checks/{first.json()['check_id']}/events"
            ) as stream:
                _read_sse_events(stream)

            second = client.post(
                "/api/checks",
                json={"text": "This is very nice.", "language": "en",
                      "checkers": ["rules", "llm"]},
            )
            assert second.status_code == 202
            body = second.json()
            assert body["findings"], "rules must still run"
            assert body["effective_llm"]["skipped"] == "quota_exhausted"
            assert body["status"] == "done"

        rows = _read_usage_rows(settings.db_path)
        assert len(rows) == 1  # the denied second insert did not survive

    def test_unconfigured_provider_does_not_reserve_a_ledger_row(
        self, tmp_path: Path
    ) -> None:
        # Mirrors TestEffectiveLlm.test_routing_to_unconfigured_provider_is_
        # skipped_not_500: a granted quality tier ('cheap') routes to a
        # provider (gemini, the default routing table's entry) this server
        # has not configured. The gate must construct the provider BEFORE
        # reserving (spec §7.2) -- a run that cannot even start must never
        # consume quota or leak a concurrency slot until the 900s sweep.
        settings = Settings(db_path=tmp_path / "test.db", rules_dir=RULES_DIR)
        app = create_app(settings)
        app.state.provider_factory = SelectiveFactory(known={"ollama", "claude"})
        with TestClient(app) as client:
            client.headers.update(auth_headers(client))  # admin: unrestricted policy
            post = client.post(
                "/api/checks",
                json={"text": "A nice text.", "language": "en", "checkers": ["llm"],
                      "llm_tier": "cheap"},
            )
            body = post.json()
            assert body["effective_llm"]["skipped"] == "llm_unavailable"

        assert _read_usage_rows(settings.db_path) == []

    def test_document_too_large_skips_llm_only(self, tmp_path: Path) -> None:
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(admin=TierLimitsSettings(
                credits_per_day=1_000_000, max_llm_document_chars=10,
                concurrent_llm_runs=5,
            )),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: FakeProvider(LLM_RESPONSE)
        with TestClient(app) as client:
            client.headers.update(auth_headers(client))
            text = "This is very nice." * 3  # well over the 10-char cap
            post = client.post(
                "/api/checks",
                json={"text": text, "language": "en", "checkers": ["rules", "llm"]},
            )
            body = post.json()
            assert body["findings"], "rules must still run"
            assert body["effective_llm"]["skipped"] == "document_too_large"

        assert _read_usage_rows(settings.db_path) == []

    def test_size_cap_is_decided_before_resolution(self, tmp_path: Path) -> None:
        tiers = {"basic": {"llm": {"tiers": [], "providers": []}, "limits": {
            "credits_per_day": 1_000_000, "max_llm_document_chars": 10,
            "concurrent_llm_runs": 5,
        }}}
        settings = Settings(db_path=tmp_path / "test.db", rules_dir=RULES_DIR, tiers=tiers)
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: FakeProvider(LLM_RESPONSE)
        with TestClient(app) as client:
            headers = second_user_headers(client)  # non-admin, tier 'basic', floor policy
            text = "This is very nice." * 3
            post = client.post(
                "/api/checks",
                json={"text": text, "language": "en", "checkers": ["llm"]},
                headers=headers,
            )
            body = post.json()
            # Moving the size check below resolve_llm_selection would report
            # 'llm_unavailable' (the floor policy's own skip code) instead.
            assert body["effective_llm"]["skipped"] == "document_too_large"

    def test_skip_reason_reaches_the_sse_stream(self, tmp_path: Path) -> None:
        first_text = "a nice text"
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(admin=TierLimitsSettings(
                credits_per_day=one_run_budget(first_text),
                max_llm_document_chars=200000, concurrent_llm_runs=5,
            )),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: FakeProvider(LLM_RESPONSE)
        with TestClient(app) as client:
            client.headers.update(auth_headers(client))
            first = client.post(
                "/api/checks",
                json={"text": first_text, "language": "en", "checkers": ["llm"]},
            )
            with client.stream(
                "GET", f"/api/checks/{first.json()['check_id']}/events"
            ) as stream:
                _read_sse_events(stream)

            second = client.post(
                "/api/checks",
                json={"text": "another nice text", "language": "en", "checkers": ["llm"]},
            )
            check_id = second.json()["check_id"]
            with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
                events = _read_sse_events(stream)
            effective_events = [data for name, data in events if name == "effective_llm"]
            assert len(effective_events) == 1
            assert effective_events[0]["skipped"] == "quota_exhausted"

    def test_per_user_concurrency_cap_returns_429_with_retry_after(
        self, tmp_path: Path
    ) -> None:
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(
                concurrency_reject_delay=0,
                admin=TierLimitsSettings(
                    credits_per_day=1_000_000, max_llm_document_chars=200000,
                    concurrent_llm_runs=1,
                ),
            ),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: HangingProvider()
        with TestClient(app) as client:
            admin = auth_headers(client)
            other = second_user_headers(client)

            first = client.post(
                "/api/checks",
                json={"text": "a's job", "language": "en", "checkers": ["llm"]},
                headers=admin,
            )
            assert first.status_code == 202

            second = client.post(
                "/api/checks",
                json={"text": "a's second job", "language": "en", "checkers": ["llm"]},
                headers=admin,
            )
            assert second.status_code == 429
            assert second.headers["Retry-After"] == "5"

            # A different user is unaffected by A's full concurrency slot.
            third = client.post(
                "/api/checks",
                json={"text": "b's job", "language": "en", "checkers": ["llm"]},
                headers=other,
            )
            assert third.status_code == 202

    def test_server_wide_cap_returns_429(self, tmp_path: Path) -> None:
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(
                max_concurrent_llm_runs=1,
                concurrency_reject_delay=0,
                admin=TierLimitsSettings(
                    credits_per_day=1_000_000, max_llm_document_chars=200000,
                    concurrent_llm_runs=1,
                ),
            ),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: HangingProvider()
        with TestClient(app) as client:
            admin = auth_headers(client)
            other = second_user_headers(client)

            first = client.post(
                "/api/checks",
                json={"text": "a's job", "language": "en", "checkers": ["llm"]},
                headers=admin,
            )
            assert first.status_code == 202

            second = client.post(
                "/api/checks",
                json={"text": "b's job", "language": "en", "checkers": ["llm"]},
                headers=other,
            )
            assert second.status_code == 429
            assert second.headers["Retry-After"] == "5"

    async def test_pause_happens_outside_the_reservation_transaction(
        self, tmp_path: Path
    ) -> None:
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(
                concurrency_reject_delay=1.0,
                admin=TierLimitsSettings(
                    credits_per_day=1_000_000, max_llm_document_chars=200000,
                    concurrent_llm_runs=1,
                ),
            ),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: HangingProvider()
        sync_client = TestClient(app)
        admin = auth_headers(sync_client)
        other = second_user_headers(sync_client)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            hold = await client.post(
                "/api/checks",
                json={"text": "hold", "language": "en", "checkers": ["llm"]},
                headers=admin,
            )
            assert hold.status_code == 202

            async def rejected():
                return await client.post(
                    "/api/checks",
                    json={"text": "a's second job", "language": "en",
                          "checkers": ["llm"]},
                    headers=admin,
                )

            async def admitted():
                start = time.monotonic()
                resp = await client.post(
                    "/api/checks",
                    json={"text": "b's job", "language": "en", "checkers": ["llm"]},
                    headers=other,
                )
                return resp, time.monotonic() - start

            rejected_resp, (admitted_resp, admitted_elapsed) = await asyncio.gather(
                rejected(), admitted()
            )

        assert rejected_resp.status_code == 429
        assert admitted_resp.status_code == 202
        assert admitted_elapsed < 0.3  # well inside the 1.0s per-user pause

    async def test_backpressure_pause_does_not_block_the_event_loop(
        self, tmp_path: Path
    ) -> None:
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(
                concurrency_reject_delay=0.5,
                admin=TierLimitsSettings(
                    credits_per_day=1_000_000, max_llm_document_chars=200000,
                    concurrent_llm_runs=1,
                ),
            ),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: HangingProvider()
        sync_client = TestClient(app)
        admin = auth_headers(sync_client)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            hold = await client.post(
                "/api/checks",
                json={"text": "hold", "language": "en", "checkers": ["llm"]},
                headers=admin,
            )
            assert hold.status_code == 202

            async def rejected():
                return await client.post(
                    "/api/checks",
                    json={"text": "reject me", "language": "en", "checkers": ["llm"]},
                    headers=admin,
                )

            async def health():
                start = time.monotonic()
                resp = await client.get("/api/health")
                return resp, time.monotonic() - start

            *rejected_results, (health_resp, health_elapsed) = await asyncio.gather(
                *(rejected() for _ in range(5)), health()
            )

        assert all(r.status_code == 429 for r in rejected_results)
        assert health_resp.status_code == 200
        assert health_elapsed < 0.3  # not stalled behind the 0.5s pauses

    def test_server_wide_rejection_skips_the_pause(self, tmp_path: Path) -> None:
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(
                max_concurrent_llm_runs=1,
                concurrency_reject_delay=1.0,
                admin=TierLimitsSettings(
                    credits_per_day=1_000_000, max_llm_document_chars=200000,
                    concurrent_llm_runs=1,
                ),
            ),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: HangingProvider()
        with TestClient(app) as client:
            admin = auth_headers(client)
            other = second_user_headers(client)

            first = client.post(
                "/api/checks",
                json={"text": "a's job", "language": "en", "checkers": ["llm"]},
                headers=admin,
            )
            assert first.status_code == 202

            start = time.monotonic()
            second = client.post(
                "/api/checks",
                json={"text": "b's job", "language": "en", "checkers": ["llm"]},
                headers=other,
            )
            elapsed = time.monotonic() - start
            assert second.status_code == 429
            assert elapsed < 0.5  # well under the 1.0s pause it must skip

    async def test_cancellation_during_backpressure_sleep_discards_the_job(
        self, tmp_path: Path
    ) -> None:
        # Pins the CancelledError-safety fix in create_check: the job is
        # created BEFORE the gate's backpressure `await asyncio.sleep(...)`
        # (llm_gate.py), so a client disconnect/cancellation mid-sleep used
        # to leak a permanently-'running' job -- CancelledError does not
        # match the surrounding `except Exception` net, so nothing discarded
        # it. Repeated cancellations would eventually exhaust
        # MAX_JOBS_PER_OWNER since every retained job looked "running".
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(
                concurrency_reject_delay=1.0,
                admin=TierLimitsSettings(
                    credits_per_day=1_000_000, max_llm_document_chars=200000,
                    concurrent_llm_runs=1,
                ),
            ),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: HangingProvider()
        sync_client = TestClient(app)
        admin = auth_headers(sync_client)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            hold = await client.post(
                "/api/checks",
                json={"text": "hold", "language": "en", "checkers": ["llm"]},
                headers=admin,
            )
            assert hold.status_code == 202

            baseline_jobs = len(app.state.jobs._jobs)

            task = asyncio.create_task(
                client.post(
                    "/api/checks",
                    json={"text": "cancel me", "language": "en",
                          "checkers": ["llm"]},
                    headers=admin,
                )
            )
            # Give create_check time to create the job, hit the gate, get
            # concurrency_rejected and reach the 1.0s backpressure sleep.
            await asyncio.sleep(0.1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

            # The cancelled request's job must not remain registered.
            assert len(app.state.jobs._jobs) == baseline_jobs

            # A follow-up check for the same owner is not refused: nothing
            # was left occupying the owner's job/concurrency capacity.
            follow_up = await client.post(
                "/api/checks",
                json={"text": "after cancel", "language": "en",
                      "checkers": ["rules"]},
                headers=admin,
            )
            assert follow_up.status_code == 202

    def test_cancelled_llm_run_writes_cancelled_and_frees_the_slot(
        self, tmp_path: Path
    ) -> None:
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(admin=TierLimitsSettings(
                credits_per_day=1_000_000, max_llm_document_chars=200000,
                concurrent_llm_runs=1,
            )),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: HangingProvider()
        with TestClient(app) as client:
            client.headers.update(auth_headers(client))
            me = client.get("/api/auth/me").json()
            first = client.post(
                "/api/checks",
                json={"text": "hold", "language": "en", "checkers": ["llm"]},
            )
            check_id = first.json()["check_id"]
            job = app.state.jobs.get(check_id, owner_id=me["id"])
            assert job is not None and job._task is not None
            job._task.get_loop().call_soon_threadsafe(job._task.cancel)

            deadline = time.monotonic() + 5
            rows = _read_usage_rows(settings.db_path)
            while (
                rows and rows[0]["status"] == "started" and time.monotonic() < deadline
            ):
                time.sleep(0.02)
                rows = _read_usage_rows(settings.db_path)
            assert rows and rows[0]["status"] == "cancelled"

            second = client.post(
                "/api/checks",
                json={"text": "next", "language": "en", "checkers": ["llm"]},
            )
            assert second.status_code == 202
            assert second.json()["status"] == "running"

    def test_admin_is_metered_with_the_admin_ceiling(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        first_text = "a's job"
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR,
            limits=LimitsSettings(admin=TierLimitsSettings(
                credits_per_day=one_run_budget(first_text),
                max_llm_document_chars=200000, concurrent_llm_runs=5,
            )),
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: FakeProvider(LLM_RESPONSE)
        with TestClient(app) as client:
            client.headers.update(auth_headers(client))
            me = client.get("/api/auth/me").json()
            first = client.post(
                "/api/checks",
                json={"text": first_text, "language": "en", "checkers": ["llm"]},
            )
            with client.stream(
                "GET", f"/api/checks/{first.json()['check_id']}/events"
            ) as stream:
                _read_sse_events(stream)

            with caplog.at_level(logging.WARNING, logger="app.services.usage"):
                second = client.post(
                    "/api/checks",
                    json={"text": "a's second job", "language": "en",
                          "checkers": ["llm"]},
                )
            assert second.status_code == 202
            assert second.json()["effective_llm"]["skipped"] == "quota_exhausted"

        rows = _read_usage_rows(settings.db_path)
        assert len(rows) == 1
        assert any(
            "admin" in r.message and str(me["id"]) in r.message
            for r in caplog.records
        )
