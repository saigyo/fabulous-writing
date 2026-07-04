from app.checkers.llm.vetting import vet_candidates
from app.core.models import Language

DE_TEXT = (
    "Unser neuer Editor ist wirklich gut. "
    "Ich würde Ihnen den Editor sofort empfehlen. "
    "Die Anwendung ist ein sehr guter Standard und kostenlos in der Basisversion."
)
DE_ORIGINAL = "würde Ihnen den Editor sofort empfehlen"


class TestSanity:
    def test_rejects_empty_identical_and_artifacts(self) -> None:
        result = vet_candidates(
            ["", "   ", DE_ORIGINAL, '["kaputt"]', '"quoted"'],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
        )
        assert result.accepted == []
        assert result.rejected == 5

    def test_rejects_absurd_length_ratio(self) -> None:
        result = vet_candidates(
            ["ja", "wort " * 60],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
        )
        assert result.accepted == []
        assert result.rejected == 2


class TestSpellGate:
    def test_rejects_archaic_konjunktiv_forms(self) -> None:
        # Regression: observed claude-sonnet-5 output for style.wuerde-stil.
        result = vet_candidates(
            [
                "empföhle Ihnen den Editor sofort",
                "empfähle Ihnen den Editor sofort",
                "Ich empfehle Ihnen den Editor sofort",
            ],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
        )
        assert result.accepted == ["Ich empfehle Ihnen den Editor sofort"]
        assert result.rejected == 2

    def test_document_words_are_whitelisted(self) -> None:
        # "Basisversion" is not in the frequency dictionary but is the writer's own word.
        result = vet_candidates(
            ["kostenlos in der Basisversion enthalten"],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
        )
        assert result.rejected == 0

    def test_tokens_with_digits_are_ignored(self) -> None:
        result = vet_candidates(
            ["Version 2a des Editors"],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
        )
        assert result.rejected == 0

    def test_english_typo_rejected(self) -> None:
        result = vet_candidates(
            ["you will recieve updates", "you will receive updates"],
            original="you will get updates",
            text="Sign up. You will get updates.",
            language=Language.EN,
        )
        assert result.accepted == ["you will receive updates"]

    def test_cjk_languages_skip_spell_gate(self) -> None:
        result = vet_candidates(
            ["この機能を使えます"],
            original="この機能を使用することができます",
            text="私たちはこの機能を使用することができます。",
            language=Language.JA,
        )
        assert result.rejected == 0


class TestRuleRecheck:
    """Full pipeline with the shipped rules and real spaCy parses."""

    def _vet(self, candidates, *, text, original, language, rule_id):
        from pathlib import Path

        from app.checkers.llm.vetting import vet_suggestions
        from app.checkers.rules.engine import RuleEngine
        from app.core.config import NlpSettings
        from app.nlp.registry import NlpRegistry

        engine = RuleEngine(Path(__file__).parent.parent / "rules")
        registry = NlpRegistry(NlpSettings().models)
        start = text.index(original)
        return vet_suggestions(
            candidates,
            original=original,
            text=text,
            start=start,
            end=start + len(original),
            language=language,
            rule_id=rule_id,
            engine=engine,
            nlp=registry,
        )

    def test_fix_that_does_not_fix_is_rejected(self) -> None:
        # Replacing one weasel word with another leaves the rule firing.
        result = self._vet(
            ["extremely", "specifically"],
            text="This is very good.",
            original="very",
            language=Language.EN,
            rule_id="style.weasel-words",
        )
        assert result.accepted == ["specifically"]
        assert result.rejected == 1

    def test_fix_introducing_new_findings_is_rejected(self) -> None:
        # Candidate resolves the weasel word but introduces a repeated word.
        result = self._vet(
            ["quite quite"],
            text="This is very good.",
            original="very",
            language=Language.EN,
            rule_id="style.weasel-words",
        )
        assert result.accepted == []

    def test_wuerde_stil_regression_full_pipeline(self) -> None:
        text = "Ich würde Ihnen den Editor sofort empfehlen."
        result = self._vet(
            [
                "empföhle Ihnen den Editor sofort",  # archaic → spell gate
                "würde Ihnen den Editor wirklich sofort empfehlen",  # still würde-Stil
                "empfehle Ihnen den Editor sofort",  # good
            ],
            text=text,
            original="würde Ihnen den Editor sofort empfehlen",
            language=Language.DE,
            rule_id="style.wuerde-stil",
        )
        assert result.accepted == ["empfehle Ihnen den Editor sofort"]
        assert result.rejected == 2

    def test_without_rule_id_only_new_findings_matter(self) -> None:
        result = self._vet(
            ["really"],  # another weasel word, but no rule_id demanded a decrease
            text="This is very good.",
            original="very",
            language=Language.EN,
            rule_id=None,
        )
        assert result.accepted == ["really"]
