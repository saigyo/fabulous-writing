import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.checkers.llm.prompts import build_rewrite_prompt, build_suggestion_prompt
from app.checkers.llm.provider import FakeProvider, LLMProvider
from app.core.config import Settings
from app.core.models import Language
from app.main import create_app
from tests.conftest import auth_headers, second_user_headers

TEXT = "The results were very good. We move on."


def make_client(tmp_path: Path, provider: LLMProvider) -> TestClient:
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    app = create_app(settings)
    app.state.provider_factory = lambda name=None, model=None: provider
    client = TestClient(app)
    client.headers.update(auth_headers(client))
    return client


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

    def test_suggest_and_rewrite_prompts_forbid_disguised_advice(self) -> None:
        system, _ = build_suggestion_prompt(
            TEXT, 17, 26, "'very good' is vague praise.", Language.EN
        )
        assert "Never disguise advice" in system
        system, _ = build_rewrite_prompt(
            "The results were very good.", "'very good' is vague praise.", Language.EN
        )
        assert "Never disguise advice" in system


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
            "advice": [],
            "skipped": None,
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


class TestAdvice:
    def test_parenthesized_candidates_become_advice(self, tmp_path: Path) -> None:
        provider = FakeProvider(
            json.dumps(["excellent", "(Consider rephrasing the whole paragraph.)"])
        )
        client = make_client(tmp_path, provider)
        body = client.post("/api/suggestions", json=suggestion_request()).json()
        assert body["suggestions"] == ["excellent"]
        assert body["advice"] == ["Consider rephrasing the whole paragraph."]
        assert body["rejected"] == 0

    def test_all_advice_is_no_replacement_not_rejection(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["(Move this sentence elsewhere.)"]))
        client = make_client(tmp_path, provider)
        body = client.post("/api/suggestions", json=suggestion_request()).json()
        assert body["suggestions"] == []
        assert body["advice"] == ["Move this sentence elsewhere."]
        assert body["rejected"] == 0
        assert body["held_back"] == []


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
        client = TestClient(app)
        client.headers.update(auth_headers(client))
        return client

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

    def test_kill_switch_still_splits_advice(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["(Ganz umstellen.)"]))
        client = self.make_client(tmp_path, provider, vet=False)
        body = client.post("/api/suggestions", json=self.de_request()).json()
        assert body["suggestions"] == []
        assert body["advice"] == ["Ganz umstellen."]


class RecordingFactory:
    """Fake provider factory that records the (provider, model) it was asked
    to build, so gate tests can assert what was actually resolved."""

    def __init__(self, response: str = json.dumps(["excellent"])) -> None:
        self.response = response
        self.calls: list[tuple[str | None, str | None]] = []

    def __call__(self, name: str | None = None, model: str | None = None) -> LLMProvider:
        self.calls.append((name, model))
        return FakeProvider(self.response)


def _app_with_tiers(tmp_path: Path, tiers: dict | None = None):
    settings = Settings(
        db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules", tiers=tiers or {}
    )
    app = create_app(settings)
    factory = RecordingFactory()
    app.state.provider_factory = factory
    return app, factory


class TestSuggestionsGate:
    def test_restricted_user_cannot_obtain_disallowed_provider(
        self, tmp_path: Path
    ) -> None:
        # tiers={"basic": {"llm": {"tiers": ["local"], "providers": ["ollama"]}}}:
        # the basic user requests llm_provider "claude" -- the recording
        # factory receives ("ollama", ...) (best allowed tier "local" routes
        # there), never "claude". Spec §10: "a basic user cannot obtain a
        # premium provider through them".
        tiers = {"basic": {"llm": {"tiers": ["local"], "providers": ["ollama"]}}}
        app, factory = _app_with_tiers(tmp_path, tiers)
        with TestClient(app) as client:
            headers = second_user_headers(client)  # non-admin, tier 'basic'
            response = client.post(
                "/api/suggestions",
                json={**suggestion_request(), "llm_provider": "claude"},
                headers=headers,
            )
            assert response.status_code == 200
        assert factory.calls == [("ollama", "mistral-nemo:12b-instruct-2407-q6_K")]

    def test_floor_user_gets_200_with_skipped(self, tmp_path: Path) -> None:
        # tiers={"basic": {"llm": {"tiers": [], "providers": []}}}: POST
        # /api/suggestions -> 200, suggestions == [], skipped ==
        # "llm_unavailable", span/original still filled; factory never called.
        # Never 403 (spec §7.2).
        tiers = {"basic": {"llm": {"tiers": [], "providers": []}}}
        app, factory = _app_with_tiers(tmp_path, tiers)
        with TestClient(app) as client:
            headers = second_user_headers(client)  # non-admin, tier 'basic'
            response = client.post(
                "/api/suggestions", json=suggestion_request(), headers=headers
            )
            assert response.status_code == 200
            body = response.json()
        assert body["suggestions"] == []
        assert body["skipped"] == "llm_unavailable"
        assert body["span"] == {"start": 17, "end": 26}
        assert body["original"] == "very good"
        assert factory.calls == []

    def test_unrestricted_response_has_no_skipped(self, tmp_path: Path) -> None:
        # Existing happy path still returns skipped None.
        app, factory = _app_with_tiers(tmp_path)
        with TestClient(app) as client:
            headers = auth_headers(client)
            response = client.post(
                "/api/suggestions", json=suggestion_request(), headers=headers
            )
            assert response.status_code == 200
            body = response.json()
        assert body["skipped"] is None
        assert body["suggestions"] == ["excellent"]
        # No explicit tier/provider requested: resolves to the server's
        # configured default provider (pre-M4 behavior), not tier routing.
        assert factory.calls == [("ollama", "llama3.1")]
