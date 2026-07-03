import json

from app.checkers.llm.checker import LLMChecker, parse_findings
from app.checkers.llm.prompts import build_prompt
from app.checkers.llm.provider import FakeProvider
from app.core.models import Category, Language, Severity, Source


class TestParseFindings:
    def test_parses_plain_json_array(self) -> None:
        raw = json.dumps(
            [
                {
                    "category": "style",
                    "severity": "warning",
                    "quote": "very good",
                    "message": "Vague praise.",
                    "suggestions": ["excellent"],
                }
            ]
        )
        items = parse_findings(raw)
        assert len(items) == 1
        assert items[0].quote == "very good"

    def test_strips_markdown_code_fences(self) -> None:
        raw = '```json\n[{"category": "style", "quote": "x", "message": "m"}]\n```'
        assert len(parse_findings(raw)) == 1

    def test_extracts_array_from_surrounding_prose(self) -> None:
        raw = 'Here are the issues:\n[{"category": "style", "quote": "x", "message": "m"}]\nDone.'
        assert len(parse_findings(raw)) == 1

    def test_skips_invalid_items_and_unknown_categories(self) -> None:
        raw = json.dumps(
            [
                {"category": "nonsense", "quote": "x", "message": "m"},
                {"category": "style", "message": "missing quote"},
                {"category": "style", "quote": "ok", "message": "m"},
            ]
        )
        items = parse_findings(raw)
        assert len(items) == 1
        assert items[0].quote == "ok"

    def test_unparseable_response_returns_empty(self) -> None:
        assert parse_findings("I could not find any issues.") == []


class TestPrompts:
    def test_prompt_mentions_language_and_contains_text(self) -> None:
        system, user = build_prompt("Das ist ein Test.", Language.DE)
        assert "German" in system or "Deutsch" in system
        assert "Das ist ein Test." in user

    def test_prompt_requests_verbatim_quotes(self) -> None:
        system, _ = build_prompt("Hello.", Language.EN)
        assert "verbatim" in system.lower() or "exact" in system.lower()


class TestLLMChecker:
    async def test_anchors_findings_and_discards_unanchorable(self) -> None:
        text = "The results were very good. We utilize synergy."
        response = json.dumps(
            [
                {
                    "category": "style",
                    "severity": "warning",
                    "quote": "very good",
                    "message": "Vague praise — say what was good.",
                    "suggestions": ["outstanding"],
                },
                {
                    "category": "clarity",
                    "quote": "this text never appears anywhere at all",
                    "message": "Should be discarded.",
                },
            ]
        )
        checker = LLMChecker(FakeProvider(response))
        findings = await checker.check(text, Language.EN)
        assert len(findings) == 1
        f = findings[0]
        assert f.source == Source.LLM
        assert f.category == Category.STYLE
        assert f.severity == Severity.WARNING
        assert f.span.start == text.index("very good")
        assert f.span.text == "very good"
        assert f.suggestions == ["outstanding"]

    async def test_severity_defaults_to_warning(self) -> None:
        response = json.dumps(
            [{"category": "style", "quote": "Hello", "message": "m"}]
        )
        checker = LLMChecker(FakeProvider(response))
        findings = await checker.check("Hello world.", Language.EN)
        assert findings[0].severity == Severity.WARNING
