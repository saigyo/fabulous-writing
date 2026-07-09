import json

from app.checkers.llm.checker import LLMChecker, parse_findings, parse_response
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
        result = await checker.check(text, Language.EN)
        findings = result.findings
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
        result = await checker.check("Hello world.", Language.EN)
        assert result.findings[0].severity == Severity.WARNING


def test_prompt_language_names_cover_all_languages():
    from app.checkers.llm.prompts import _LANGUAGE_NAMES
    from app.core.models import Language

    assert set(_LANGUAGE_NAMES) == set(Language)


def test_fix_prompts_steer_toward_idiomatic_wording():
    from app.checkers.llm.prompts import build_rewrite_prompt, build_suggestion_prompt
    from app.core.models import Language

    for system in (
        build_suggestion_prompt("It is very good.", 6, 10, "Weasel word.", Language.EN)[0],
        build_rewrite_prompt("It is very good.", "Weasel word.", Language.EN)[0],
    ):
        assert "not a transformation recipe" in system
        assert "archaic" in system


async def test_inline_suggestions_are_vetted_but_finding_survives():
    import json

    from app.checkers.llm.checker import LLMChecker
    from app.checkers.llm.provider import FakeProvider
    from app.core.models import Language

    text = "You will get updates."
    response = json.dumps(
        [
            {
                "category": "style",
                "severity": "suggestion",
                "quote": "get updates",
                "message": "Vague verb.",
                "suggestions": ["recieve updates", "receive updates"],
            }
        ]
    )
    result = await LLMChecker(FakeProvider(response)).check(text, Language.EN)
    findings = result.findings
    assert len(findings) == 1
    assert findings[0].suggestions == ["receive updates"]

    unvetted = await LLMChecker(FakeProvider(response), vet=False).check(
        text, Language.EN
    )
    assert unvetted.findings[0].suggestions == ["recieve updates", "receive updates"]


async def test_parenthesized_suggestions_become_advice():
    import json

    from app.checkers.llm.checker import LLMChecker
    from app.checkers.llm.provider import FakeProvider
    from app.core.models import Language

    text = "You will get updates."
    response = json.dumps(
        [
            {
                "category": "style",
                "severity": "suggestion",
                "quote": "get updates",
                "message": "Vague verb.",
                "suggestions": [
                    "(Consider restructuring the whole sentence.)",
                    "receive updates",
                ],
            }
        ]
    )
    result = await LLMChecker(FakeProvider(response)).check(text, Language.EN)
    assert result.findings[0].suggestions == ["receive updates"]
    assert result.findings[0].advice == ["Consider restructuring the whole sentence."]


SCORECARD = {
    "consistency": {"score": 4, "note": "Terminology is uniform."},
    "flow": {"score": 3, "note": "Transitions are functional."},
    "clarity": {"score": 4, "note": "Mostly easy to follow."},
    "vividness": {"score": 2, "note": "Abstract throughout."},
    "tone": {"score": 5, "note": "Fits the genre well."},
    "structure": {"score": 3, "note": "Sound but flat ordering."},
}

FINDING_ITEM = {
    "category": "style",
    "severity": "warning",
    "quote": "very good",
    "message": "Weak intensifier.",
    "suggestions": ["excellent"],
}


class TestParseResponse:
    def test_object_with_findings_and_scorecard(self) -> None:
        response = json.dumps({"findings": [FINDING_ITEM], "scorecard": SCORECARD})
        findings, scorecard = parse_response(response)
        assert len(findings) == 1
        assert findings[0].quote == "very good"
        assert scorecard is not None
        assert scorecard.vividness.score == 2
        assert scorecard.tone.note == "Fits the genre well."

    def test_object_without_scorecard(self) -> None:
        response = json.dumps({"findings": [FINDING_ITEM]})
        findings, scorecard = parse_response(response)
        assert len(findings) == 1
        assert scorecard is None

    def test_scorecard_missing_dimension_discarded_findings_kept(self) -> None:
        incomplete = {k: v for k, v in SCORECARD.items() if k != "flow"}
        response = json.dumps({"findings": [FINDING_ITEM], "scorecard": incomplete})
        findings, scorecard = parse_response(response)
        assert len(findings) == 1
        assert scorecard is None  # strict gate: no partial scorecards

    def test_scorecard_out_of_range_discarded(self) -> None:
        bad = {**SCORECARD, "flow": {"score": 6, "note": ""}}
        response = json.dumps({"findings": [FINDING_ITEM], "scorecard": bad})
        assert parse_response(response).scorecard is None

    def test_bare_array_fallback_has_no_scorecard(self) -> None:
        response = json.dumps([FINDING_ITEM])
        findings, scorecard = parse_response(response)
        assert len(findings) == 1
        assert scorecard is None

    def test_single_item_array_not_mistaken_for_envelope(self) -> None:
        # A one-element bare array contains a top-level {...} substring that
        # parses as an object but is a finding, not the envelope.
        response = json.dumps([FINDING_ITEM])
        findings, _ = parse_response(response)
        assert findings[0].message == "Weak intensifier."

    def test_object_in_code_fence(self) -> None:
        payload = json.dumps({"findings": [], "scorecard": SCORECARD})
        response = f"```json\n{payload}\n```"
        assert parse_response(response).scorecard is not None

    def test_note_is_optional(self) -> None:
        no_notes = {k: {"score": v["score"]} for k, v in SCORECARD.items()}
        response = json.dumps({"findings": [], "scorecard": no_notes})
        scorecard = parse_response(response).scorecard
        assert scorecard is not None
        assert scorecard.consistency.note == ""
