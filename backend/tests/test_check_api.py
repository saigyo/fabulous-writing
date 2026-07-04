import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.checkers.llm.provider import FakeProvider, LLMProvider
from app.core.config import NlpSettings, Settings
from app.main import create_app

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
    return TestClient(app)


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
            "domain_id": domain["id"],
            "checkers": ["terminology"],
        },
    )
    findings = response.json()["findings"]
    assert len(findings) == 1
    assert findings[0]["suggestions"] == ["sign in"]


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
    with TestClient(app) as client:
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
