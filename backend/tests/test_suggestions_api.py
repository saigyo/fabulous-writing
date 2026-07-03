import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.checkers.llm.prompts import build_suggestion_prompt
from app.checkers.llm.provider import FakeProvider, LLMProvider
from app.core.config import Settings
from app.core.models import Language
from app.main import create_app

TEXT = "The results were very good. We move on."


def make_client(tmp_path: Path, provider: LLMProvider) -> TestClient:
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    app = create_app(settings)
    app.state.provider_factory = lambda name=None, model=None: provider
    return TestClient(app)


def suggestion_request(start: int = 17, end: int = 26) -> dict:
    return {
        "text": TEXT,
        "span": {"start": start, "end": end},
        "message": "'very good' is vague praise.",
        "language": "en",
    }


class TestSuggestionPrompt:
    def test_prompt_contains_span_message_and_context(self) -> None:
        system, user = build_suggestion_prompt(
            TEXT, 17, 26, "'very good' is vague praise.", Language.EN
        )
        assert "very good" in user
        assert "'very good' is vague praise." in user
        assert "The results were very good." in user  # surrounding sentence
        assert "JSON" in system

    def test_prompt_names_the_language(self) -> None:
        system, _ = build_suggestion_prompt("Das ist gut.", 8, 11, "m", Language.DE)
        assert "German" in system or "Deutsch" in system


class TestSuggestionsEndpoint:
    def test_returns_parsed_suggestions(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["outstanding", "remarkably clear"]))
        client = make_client(tmp_path, provider)
        response = client.post("/api/suggestions", json=suggestion_request())
        assert response.status_code == 200
        assert response.json() == {"suggestions": ["outstanding", "remarkably clear"]}

    def test_filters_echo_of_original_span_and_non_strings(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["very good", "excellent", 42]))
        client = make_client(tmp_path, provider)
        response = client.post("/api/suggestions", json=suggestion_request())
        assert response.json() == {"suggestions": ["excellent"]}

    def test_tolerates_code_fences(self, tmp_path: Path) -> None:
        provider = FakeProvider('```json\n["excellent"]\n```')
        client = make_client(tmp_path, provider)
        assert client.post("/api/suggestions", json=suggestion_request()).json() == {
            "suggestions": ["excellent"]
        }

    def test_unparseable_response_is_502(self, tmp_path: Path) -> None:
        provider = FakeProvider("I have no suggestions for you.")
        client = make_client(tmp_path, provider)
        response = client.post("/api/suggestions", json=suggestion_request())
        assert response.status_code == 502

    def test_llm_failure_is_502_with_message(self, tmp_path: Path) -> None:
        class BrokenProvider:
            name = "broken"

            async def generate(self, system: str, user: str) -> str:
                raise RuntimeError("model exploded")

        client = make_client(tmp_path, BrokenProvider())
        response = client.post("/api/suggestions", json=suggestion_request())
        assert response.status_code == 502
        assert "model exploded" in response.json()["detail"]

    @pytest.mark.parametrize("start,end", [(30, 20), (0, 0), (10, 999)])
    def test_invalid_span_is_422(self, tmp_path: Path, start: int, end: int) -> None:
        client = make_client(tmp_path, FakeProvider("[]"))
        response = client.post(
            "/api/suggestions", json=suggestion_request(start, end)
        )
        assert response.status_code == 422
