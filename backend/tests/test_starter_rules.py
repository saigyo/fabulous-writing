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


# --- Illustrative rule examples (showcasing pattern features) ---


def test_en_an_before_consonant(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "grammar.article-an" in nlp_rule_ids(
        engine, registry, "She gave an presentation about writing.", Language.EN
    )
    assert "grammar.article-an" not in nlp_rule_ids(
        engine, registry, "She gave an honest answer in an hour.", Language.EN
    )


def test_en_split_infinitive(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.split-infinitive" in nlp_rule_ids(
        engine, registry, "We want to quickly finish the report.", Language.EN
    )
    assert "style.split-infinitive" not in nlp_rule_ids(
        engine, registry, "We want to finish the report quickly.", Language.EN
    )


def test_en_expletive_opener(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "vividness.expletive-opener" in nlp_rule_ids(
        engine, registry, "There are many issues in the draft.", Language.EN
    )
    assert "vividness.expletive-opener" not in nlp_rule_ids(
        engine, registry, "The draft has many issues.", Language.EN
    )


def test_de_einzigste(engine: RuleEngine) -> None:
    findings = engine.check("Das ist das einzigste Problem.", Language.DE)
    hits = [f for f in findings if f.rule_id == "grammar.einzigste"]
    assert hits and hits[0].suggestions == ["einzige"]


def test_de_wuerde_stil(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.wuerde-stil" in nlp_rule_ids(
        engine, registry, "Ich würde das Angebot gerne annehmen.", Language.DE
    )
    assert "style.wuerde-stil" not in nlp_rule_ids(
        engine, registry, "Ich nehme das Angebot gerne an.", Language.DE
    )


def test_de_schachtelsaetze(engine: RuleEngine) -> None:
    nested = "Der Satz, der viele Nebensätze, die stören, enthält, ist lang."
    assert "clarity.schachtelsaetze" in rule_ids(engine, nested, Language.DE)
    assert "clarity.schachtelsaetze" not in rule_ids(
        engine, "Der Satz ist kurz, klar und gut.", Language.DE
    )


def test_fr_voix_passive(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.voix-passive" in nlp_rule_ids(
        engine, registry, "Le rapport a été écrit par l'équipe.", Language.FR
    )
    assert "style.voix-passive" not in nlp_rule_ids(
        engine, registry, "L'équipe a écrit le rapport.", Language.FR
    )


def test_fr_lourdeurs_and_malgre_que(engine: RuleEngine) -> None:
    findings = engine.check(
        "Suite à votre message, nous répondrons. Malgré que ce soit difficile.",
        Language.FR,
    )
    by_rule = {f.rule_id: f for f in findings if f.rule_id}
    assert by_rule["clarity.lourdeurs"].suggestions == ["après"]
    assert by_rule["grammar.malgre-que"].suggestions == ["bien que"]


def test_es_voz_pasiva(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.voz-pasiva" in nlp_rule_ids(
        engine, registry, "El informe fue escrito por el equipo.", Language.ES
    )
    assert "style.voz-pasiva" not in nlp_rule_ids(
        engine, registry, "El equipo escribió el informe.", Language.ES
    )


def test_es_dequeismo(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "grammar.dequeismo" in nlp_rule_ids(
        engine, registry, "Pienso de que es una buena idea.", Language.ES
    )
    assert "grammar.dequeismo" not in nlp_rule_ids(
        engine, registry, "Pienso que es una buena idea.", Language.ES
    )


def test_es_circunloquios(engine: RuleEngine) -> None:
    findings = engine.check("En base a los datos, decidimos.", Language.ES)
    hits = [f for f in findings if f.rule_id == "clarity.circunloquios"]
    assert hits and hits[0].suggestions == ["según"]


def test_it_forma_passiva(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.forma-passiva" in nlp_rule_ids(
        engine, registry, "Il rapporto è stato scritto dal team.", Language.IT
    )
    assert "style.forma-passiva" in nlp_rule_ids(
        engine, registry, "Il rapporto viene scritto ogni anno.", Language.IT
    )
    assert "style.forma-passiva" not in nlp_rule_ids(
        engine, registry, "Il team ha scritto il rapporto.", Language.IT
    )


def test_it_ma_pero(engine: RuleEngine) -> None:
    findings = engine.check("Ma però questo non funziona.", Language.IT)
    hits = [f for f in findings if f.rule_id == "grammar.ma-pero"]
    assert hits and hits[0].suggestions == ["ma"]


def test_it_burocratese(engine: RuleEngine) -> None:
    findings = engine.check("Al fine di migliorare, cambiamo processo.", Language.IT)
    hits = [f for f in findings if f.rule_id == "clarity.burocratese"]
    assert hits and hits[0].suggestions == ["per"]


def test_ja_double_negative(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.double-negative" in nlp_rule_ids(
        engine, registry, "できないことはない。", Language.JA
    )
    assert "style.double-negative" not in nlp_rule_ids(
        engine, registry, "できます。", Language.JA
    )


def test_ja_mazu_saisho(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.mazu-saisho" in nlp_rule_ids(
        engine, registry, "まず最初に、計画を説明します。", Language.JA
    )


def test_ja_touten_kajou(engine: RuleEngine, registry: NlpRegistry) -> None:
    heavy = "これは、とても、長い、複雑な、例文で、あります。"
    assert "clarity.touten-kajou" in nlp_rule_ids(engine, registry, heavy, Language.JA)
    assert "clarity.touten-kajou" not in nlp_rule_ids(
        engine, registry, "これは短い文です。", Language.JA
    )


def test_zh_jinxing(engine: RuleEngine, registry: NlpRegistry) -> None:
    assert "style.jinxing" in nlp_rule_ids(
        engine, registry, "他对这个项目进行了分析。", Language.ZH
    )
    assert "style.jinxing" in nlp_rule_ids(
        engine, registry, "我们明天进行讨论。", Language.ZH
    )
    assert "style.jinxing" not in nlp_rule_ids(
        engine, registry, "我们明天讨论这个项目。", Language.ZH
    )


def test_zh_douhao_guoduo(engine: RuleEngine, registry: NlpRegistry) -> None:
    heavy = "这个方法很好，操作简单，成本很低，效果明显，大家都很满意，值得推广，应该继续。"
    assert "clarity.douhao-guoduo" in nlp_rule_ids(engine, registry, heavy, Language.ZH)
    assert "clarity.douhao-guoduo" not in nlp_rule_ids(
        engine, registry, "这个方法有效。", Language.ZH
    )
