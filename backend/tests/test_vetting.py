from pathlib import Path

import pytest

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


class TestHeldBack:
    def test_spell_gate_reject_lands_in_held_back_with_words(self) -> None:
        result = vet_candidates(
            ["empföhle Ihnen den Editor sofort"],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
        )
        assert result.rejected == 1
        assert len(result.held_back) == 1
        candidate = result.held_back[0]
        assert candidate.text == "empföhle Ihnen den Editor sofort"
        assert candidate.reason_kind == "spelling"
        assert candidate.words == ["empföhle"]
        assert candidate.rule_ids == []

    def test_sanity_rejects_are_not_held_back(self) -> None:
        result = vet_candidates(
            ["", DE_ORIGINAL, "wort " * 60],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
        )
        assert result.rejected == 3
        assert result.held_back == []


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

    def test_unresolved_rule_lands_in_held_back(self) -> None:
        result = self._vet(
            ["extremely"],
            text="This is very good.",
            original="very",
            language=Language.EN,
            rule_id="style.weasel-words",
        )
        assert result.accepted == []
        assert len(result.held_back) == 1
        candidate = result.held_back[0]
        assert candidate.text == "extremely"
        assert candidate.reason_kind == "rules"
        assert candidate.rule_ids == ["style.weasel-words"]
        assert candidate.words == []

    def test_introduced_finding_lands_in_held_back_with_rule_id(self) -> None:
        result = self._vet(
            ["quite quite"],
            text="This is very good.",
            original="very",
            language=Language.EN,
            rule_id="style.weasel-words",
        )
        assert result.accepted == []
        assert len(result.held_back) == 1
        assert result.held_back[0].reason_kind == "rules"
        assert "grammar.repeated-words" in result.held_back[0].rule_ids


DICTS = Path(__file__).parent.parent / "dictionaries"

needs_dictionaries = pytest.mark.skipif(
    not (DICTS / "de.dic").is_file(),
    reason="hunspell dictionaries not installed (scripts/install-dictionaries.sh)",
)


@needs_dictionaries
class TestHunspellGate:
    def test_novel_compound_accepted_with_dictionary(self) -> None:
        # "Satzumstellung" is in neither the document nor the frequency list;
        # only hunspell compounding recognizes it. M1 rejected this (false reject).
        candidate = "eine Satzumstellung würde helfen"
        without = vet_candidates(
            [candidate], original=DE_ORIGINAL, text=DE_TEXT, language=Language.DE
        )
        assert without.rejected == 1
        with_dict = vet_candidates(
            [candidate],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
            dictionaries_dir=DICTS,
        )
        assert with_dict.rejected == 0

    def test_archaic_forms_still_rejected_with_dictionary(self) -> None:
        result = vet_candidates(
            ["empföhle Ihnen den Editor sofort", "empfähle Ihnen den Editor sofort"],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
            dictionaries_dir=DICTS,
        )
        assert result.rejected == 2

    def test_english_typo_still_rejected_with_dictionary(self) -> None:
        result = vet_candidates(
            ["you will recieve updates"],
            original="you will get updates",
            text="Sign up. You will get updates.",
            language=Language.EN,
            dictionaries_dir=DICTS,
        )
        assert result.rejected == 1

    def test_missing_dictionary_directory_degrades_to_frequency(self) -> None:
        result = vet_candidates(
            ["you will receive updates"],
            original="you will get updates",
            text="Sign up. You will get updates.",
            language=Language.EN,
            dictionaries_dir=Path("/nonexistent"),
        )
        assert result.rejected == 0
