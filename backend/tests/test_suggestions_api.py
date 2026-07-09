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
    def test_returns_parsed_suggestions_and_echoes_span(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["outstanding", "remarkably clear"]))
        client = make_client(tmp_path, provider)
        response = client.post("/api/suggestions", json=suggestion_request())
        assert response.status_code == 200
        assert response.json() == {
            "suggestions": ["outstanding", "remarkably clear"],
            "span": {"start": 17, "end": 26},
            "original": "very good",
            "rejected": 0,
            "held_back": [],
        }

    def test_filters_echo_of_original_span_and_non_strings(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["very good", "excellent", 42]))
        client = make_client(tmp_path, provider)
        response = client.post("/api/suggestions", json=suggestion_request())
        assert response.json()["suggestions"] == ["excellent"]

    def test_tolerates_code_fences(self, tmp_path: Path) -> None:
        provider = FakeProvider('```json\n["excellent"]\n```')
        client = make_client(tmp_path, provider)
        response = client.post("/api/suggestions", json=suggestion_request())
        assert response.json()["suggestions"] == ["excellent"]

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


class TestSentenceScope:
    def test_expands_span_to_sentence_and_prompts_with_it(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["The results impressed everyone."]))
        client = make_client(tmp_path, provider)
        response = client.post(
            "/api/suggestions", json={**suggestion_request(), "scope": "sentence"}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["original"] == "The results were very good."
        assert body["span"] == {"start": 0, "end": len("The results were very good.")}
        assert body["suggestions"] == ["The results impressed everyone."]
        _, user_prompt = provider.calls[0]
        assert "The results were very good." in user_prompt
        assert "'very good' is vague praise." in user_prompt

    def test_span_across_sentences_covers_both(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["Rewritten."]))
        client = make_client(tmp_path, provider)
        start = TEXT.index("good")
        end = TEXT.index("move")
        response = client.post(
            "/api/suggestions",
            json={**suggestion_request(start, end), "scope": "sentence"},
        )
        assert response.json()["original"] == TEXT

    def test_filters_echo_of_expanded_sentence(self, tmp_path: Path) -> None:
        provider = FakeProvider(
            json.dumps(["The results were very good.", "The results shone."])
        )
        client = make_client(tmp_path, provider)
        response = client.post(
            "/api/suggestions", json={**suggestion_request(), "scope": "sentence"}
        )
        assert response.json()["suggestions"] == ["The results shone."]

    def test_rewrite_prompt_allows_splitting(self, tmp_path: Path) -> None:
        provider = FakeProvider("[]")
        client = make_client(tmp_path, provider)
        client.post(
            "/api/suggestions", json={**suggestion_request(), "scope": "sentence"}
        )
        system_prompt, _ = provider.calls[0]
        assert "split" in system_prompt.lower()


RULES_DIR = Path(__file__).parent.parent / "rules"


class TestVetting:
    def make_client(
        self, tmp_path: Path, provider: LLMProvider, *, vet: bool = True
    ) -> TestClient:
        settings = Settings(
            db_path=tmp_path / "test.db", rules_dir=RULES_DIR, vet_suggestions=vet
        )
        app = create_app(settings)
        app.state.provider_factory = lambda name=None, model=None: provider
        return TestClient(app)

    DE_TEXT = "Ich würde Ihnen den Editor sofort empfehlen."

    def de_request(self) -> dict:
        start = self.DE_TEXT.index("würde")
        return {
            "text": self.DE_TEXT,
            "span": {"start": start, "end": self.DE_TEXT.index(" empfehlen.") + len(" empfehlen")},
            "message": "statt würde-Form oft besser der einfache Konjunktiv II.",
            "language": "de",
            "rule_id": "style.wuerde-stil",
        }

    def test_archaic_and_non_fixing_candidates_rejected(self, tmp_path: Path) -> None:
        provider = FakeProvider(
            json.dumps(
                [
                    "empföhle Ihnen den Editor sofort",
                    "empfähle Ihnen den Editor sofort",
                    "empfehle Ihnen den Editor sofort",
                ]
            )
        )
        client = self.make_client(tmp_path, provider)
        response = client.post("/api/suggestions", json=self.de_request())
        assert response.status_code == 200
        body = response.json()
        assert body["suggestions"] == ["empfehle Ihnen den Editor sofort"]
        assert body["rejected"] == 2

    def test_all_rejected_is_200_with_empty_list(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["empföhle Ihnen den Editor sofort"]))
        client = self.make_client(tmp_path, provider)
        body = client.post("/api/suggestions", json=self.de_request()).json()
        assert body["suggestions"] == []
        assert body["rejected"] == 1

    def test_kill_switch_returns_raw_candidates(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["empföhle Ihnen den Editor sofort"]))
        client = self.make_client(tmp_path, provider, vet=False)
        body = client.post("/api/suggestions", json=self.de_request()).json()
        assert body["suggestions"] == ["empföhle Ihnen den Editor sofort"]
        assert body["rejected"] == 0

    def test_all_rejected_returns_held_back_with_reasons(self, tmp_path: Path) -> None:
        provider = FakeProvider(
            json.dumps(
                [
                    "empföhle Ihnen den Editor sofort",  # spell gate
                    "würde Ihnen den Editor wirklich sofort empfehlen",  # unresolved rule
                ]
            )
        )
        client = self.make_client(tmp_path, provider)
        body = client.post("/api/suggestions", json=self.de_request()).json()
        assert body["suggestions"] == []
        assert body["rejected"] == 2
        kinds = {item["text"]: item for item in body["held_back"]}
        spelling = kinds["empföhle Ihnen den Editor sofort"]
        assert spelling["reason_kind"] == "spelling"
        assert spelling["words"] == ["empföhle"]
        rules = kinds["würde Ihnen den Editor wirklich sofort empfehlen"]
        assert rules["reason_kind"] == "rules"
        assert "style.wuerde-stil" in rules["rule_ids"]

    def test_kill_switch_has_empty_held_back(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["empföhle Ihnen den Editor sofort"]))
        client = self.make_client(tmp_path, provider, vet=False)
        body = client.post("/api/suggestions", json=self.de_request()).json()
        assert body["held_back"] == []
