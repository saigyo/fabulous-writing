from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleEngine
from app.core.config import NlpSettings
from app.core.models import Language
from app.nlp.registry import NlpRegistry

RULES_DIR = Path(__file__).parent.parent / "rules"


@pytest.fixture(scope="module")
def engine() -> RuleEngine:
    return RuleEngine(RULES_DIR)


@pytest.fixture(scope="module")
def registry() -> NlpRegistry:
    return NlpRegistry(NlpSettings().models)


def rule_ids(engine: RuleEngine, text: str, language: Language) -> set[str]:
    return {f.rule_id for f in engine.check(text, language) if f.rule_id}


def nlp_rule_ids(
    engine: RuleEngine, registry: NlpRegistry, text: str, language: Language
) -> set[str]:
    doc = registry.analyze(text, language.value)
    assert doc is not None
    return {f.rule_id for f in engine.check(text, language, doc=doc) if f.rule_id}


def test_starter_rules_load_without_errors(engine: RuleEngine) -> None:
    assert engine.errors == []
    languages = {rule.language for rule in engine.list_rules()}
    assert languages == set(Language)


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


def test_en_passive_voice_dependency(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.passive-voice" in nlp_rule_ids(
        engine, registry, "The report was written by the team.", Language.EN
    )
    assert "style.passive-voice" not in nlp_rule_ids(
        engine, registry, "The team wrote the report.", Language.EN
    )
    # be + adjective must not be flagged (old regex false positive).
    assert "style.passive-voice" not in nlp_rule_ids(
        engine, registry, "The team was tired.", Language.EN
    )


def test_en_nominalizations(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.nominalizations" in nlp_rule_ids(
        engine, registry, "We made a decision to proceed.", Language.EN
    )


def test_de_passiv(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.passiv" in nlp_rule_ids(
        engine, registry, "Der Bericht wurde vom Team geschrieben.", Language.DE
    )
    assert "style.passiv" not in nlp_rule_ids(
        engine, registry, "Das Team schrieb den Bericht.", Language.DE
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


def test_fr_starter_rules(engine: RuleEngine) -> None:
    assert "style.mots-flous" in rule_ids(engine, "C'est très intéressant.", Language.FR)
    assert "vividness.cliches" in rule_ids(
        engine, "Au bout du compte, ça marche.", Language.FR
    )
    assert "grammar.mots-repetes" in rule_ids(
        engine, "C'est est une erreur.", Language.FR
    )
    long_sentence = " ".join(["mot"] * 35) + "."
    assert "clarity.phrase-longue" in rule_ids(engine, long_sentence, Language.FR)


def test_es_starter_rules(engine: RuleEngine) -> None:
    assert "style.muletillas" in rule_ids(engine, "Es muy interesante.", Language.ES)
    assert "vividness.cliches" in rule_ids(
        engine, "Al fin y al cabo, funciona.", Language.ES
    )
    assert "grammar.palabras-repetidas" in rule_ids(
        engine, "Esto es es un error.", Language.ES
    )
    long_sentence = " ".join(["palabra"] * 35) + "."
    assert "clarity.frase-larga" in rule_ids(engine, long_sentence, Language.ES)


def test_it_starter_rules(engine: RuleEngine) -> None:
    assert "style.parole-vaghe" in rule_ids(engine, "È molto interessante.", Language.IT)
    assert "vividness.cliches" in rule_ids(
        engine, "Alla fine dei conti, funziona.", Language.IT
    )
    assert "grammar.parole-ripetute" in rule_ids(
        engine, "Questo è è un errore.", Language.IT
    )
    long_sentence = " ".join(["parola"] * 35) + "."
    assert "clarity.frase-lunga" in rule_ids(engine, long_sentence, Language.IT)


def test_ja_redundant_potential(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.redundant-potential" in nlp_rule_ids(
        engine, registry, "私たちはこの機能を使用することができます。", Language.JA
    )
    assert "style.redundant-potential" not in nlp_rule_ids(
        engine, registry, "私たちはこの機能を使えます。", Language.JA
    )


def test_ja_long_sentence_token_count(engine: RuleEngine, registry: NlpRegistry) -> None:
    long_sentence = "この機能はとても便利で、" * 12 + "使いやすいです。"
    assert "clarity.long-sentence" in nlp_rule_ids(
        engine, registry, long_sentence, Language.JA
    )
    assert "clarity.long-sentence" not in nlp_rule_ids(
        engine, registry, "短い文です。", Language.JA
    )


def test_ja_sentence_splitting_on_kuten(registry: NlpRegistry) -> None:
    from app.checkers.rules.text import split_sentences

    text = "最初の文です。二番目の文です。"
    doc = registry.analyze(text, "ja")
    assert doc is not None
    assert [s for _, _, s in split_sentences(text, doc=doc)] == [
        "最初の文です。",
        "二番目の文です。",
    ]


def test_zh_filler(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.filler" in nlp_rule_ids(
        engine, registry, "基本上，这个方法有效。", Language.ZH
    )
    assert "style.filler" not in nlp_rule_ids(
        engine, registry, "这个方法有效。", Language.ZH
    )


def test_zh_long_sentence_token_count(engine: RuleEngine, registry: NlpRegistry) -> None:
    long_sentence = "这个功能非常好用而且" * 10 + "大家都喜欢。"
    assert "clarity.long-sentence" in nlp_rule_ids(
        engine, registry, long_sentence, Language.ZH
    )
    assert "clarity.long-sentence" not in nlp_rule_ids(
        engine, registry, "这个方法有效。", Language.ZH
    )
