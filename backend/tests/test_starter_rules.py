from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleEngine
from app.core.models import Language

RULES_DIR = Path(__file__).parent.parent / "rules"


@pytest.fixture(scope="module")
def engine() -> RuleEngine:
    return RuleEngine(RULES_DIR)


def rule_ids(engine: RuleEngine, text: str, language: Language) -> set[str]:
    return {f.rule_id for f in engine.check(text, language) if f.rule_id}


def test_starter_rules_load_without_errors(engine: RuleEngine) -> None:
    assert engine.errors == []
    languages = {rule.language for rule in engine.list_rules()}
    assert languages == {Language.EN, Language.DE}


def test_en_weasel_words(engine: RuleEngine) -> None:
    assert "style.weasel-words" in rule_ids(
        engine, "This is very interesting and somewhat useful.", Language.EN
    )


def test_en_wordiness_substitution_suggests(engine: RuleEngine) -> None:
    findings = engine.check("We utilize synergy in order to succeed.", Language.EN)
    wordy = [f for f in findings if f.rule_id == "clarity.wordiness"]
    assert {f.span.text for f in wordy} == {"utilize", "in order to"}
    assert all(f.suggestions for f in wordy)


def test_en_long_sentence(engine: RuleEngine) -> None:
    long_sentence = " ".join(["word"] * 35) + "."
    assert "clarity.long-sentence" in rule_ids(engine, long_sentence, Language.EN)
    assert "clarity.long-sentence" not in rule_ids(engine, "Short sentence.", Language.EN)


def test_en_repeated_words(engine: RuleEngine) -> None:
    assert "grammar.repeated-words" in rule_ids(engine, "It is is fine.", Language.EN)


def test_en_cliches(engine: RuleEngine) -> None:
    assert "vividness.cliches" in rule_ids(
        engine, "At the end of the day, we think outside the box.", Language.EN
    )


def test_en_passive_voice_heuristic(engine: RuleEngine) -> None:
    assert "style.passive-voice" in rule_ids(
        engine, "The report was written by the team.", Language.EN
    )


def test_de_fuellwoerter(engine: RuleEngine) -> None:
    assert "style.fuellwoerter" in rule_ids(
        engine, "Das ist halt eigentlich ganz gut.", Language.DE
    )


def test_de_lange_saetze(engine: RuleEngine) -> None:
    long_sentence = " ".join(["Wort"] * 35) + "."
    assert "clarity.lange-saetze" in rule_ids(engine, long_sentence, Language.DE)


def test_de_anglizismen_suggest_german_term(engine: RuleEngine) -> None:
    findings = engine.check("Wir haben ein Meeting gecancelt.", Language.DE)
    hits = [f for f in findings if f.rule_id == "style.anglizismen"]
    assert hits and all(f.suggestions for f in hits)


def test_de_doppelte_woerter(engine: RuleEngine) -> None:
    assert "grammar.doppelte-woerter" in rule_ids(
        engine, "Das ist ist ein Fehler.", Language.DE
    )
