import asyncio
import json
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.checkers.llm.provider import FakeProvider, LLMProvider
from app.core.config import NlpSettings, Settings
from app.main import create_app
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

    async def generate(self, system, user, on_progress=None) -> str:
        self.last_system = system
        return "[]"


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

        async def generate(self, system: str, user: str) -> str:
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

        async def generate(self, system: str, user: str, on_progress=None) -> str:
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
    """POST /api/checks with unknown llm_provider errors and discards the job.

    Repeated failures must not leak permanently-running jobs: the next valid
    request for the same owner should succeed (not 429), proving the failed
    job was cleaned up and did not consume the owner's quota.
    """
    from app.services.jobs import MAX_JOBS_PER_OWNER

    class BrokenProviderFactory:
        def __call__(self, name=None, model=None):
            if name == "unknown":
                raise ValueError(f"Unknown provider: {name}")
            return FakeProvider(LLM_RESPONSE)

    settings = Settings(db_path=tmp_path / "t.db", rules_dir=RULES_DIR)
    app = create_app(settings)
    app.state.provider_factory = BrokenProviderFactory()

    with TestClient(app) as client:
        headers = auth_headers(client)

        # Trigger MAX_JOBS_PER_OWNER+1 failed checks with unknown provider.
        # Each error should cause a job to be created and then discarded in the
        # exception handler, so no jobs should accumulate to hit the per-owner cap.
        for i in range(MAX_JOBS_PER_OWNER + 1):
            # ValueError from provider_factory is re-raised by exception handler
            # and escapes to TestClient, which re-raises it.
            with pytest.raises(ValueError, match="Unknown provider"):
                client.post(
                    "/api/checks",
                    json={
                        "text": f"Text {i}",
                        "language": "en",
                        "checkers": ["llm"],
                        "llm_provider": "unknown",
                    },
                    headers=headers,
                )

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
