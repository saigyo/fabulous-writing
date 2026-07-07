"""Each demo text must trigger its language's marquee rules."""

from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleEngine
from app.core.config import NlpSettings
from app.core.models import Language
from app.nlp.registry import NlpRegistry

DEMOS_DIR = Path(__file__).parent.parent / "demos"
RULES_DIR = Path(__file__).parent.parent / "rules"

# The rules every demo text is designed to showcase (a subset of what fires).
EXPECTED = {
    Language.EN: {
        "style.weasel-words",
        "style.exclamations",
        "style.passive-voice",
        "style.nominalizations",
        "style.split-infinitive",
        "grammar.article-an",
        "grammar.repeated-words",
        "clarity.wordiness",
        "clarity.long-sentence",
        "vividness.cliches",
        "vividness.expletive-opener",
    },
    Language.DE: {
        "style.fuellwoerter",
        "style.anglizismen",
        "style.passiv",
        "style.wuerde-stil",
        "grammar.einzigste",
        "grammar.doppelte-woerter",
        "clarity.schachtelsaetze",
    },
    Language.FR: {
        "style.mots-flous",
        "style.voix-passive",
        "grammar.mots-repetes",
        "grammar.malgre-que",
        "grammar.pleonasmes",
        "grammar.pallier-a",
        "clarity.phrase-longue",
        "clarity.lourdeurs",
        "vividness.cliches",
    },
    Language.ES: {
        "style.muletillas",
        "style.voz-pasiva",
        "grammar.palabras-repetidas",
        "grammar.dequeismo",
        "grammar.queismo",
        "grammar.haber-impersonal",
        "style.en-base-a",
        "clarity.frase-larga",
        "clarity.circunloquios",
        "vividness.cliches",
    },
    Language.IT: {
        "style.parole-vaghe",
        "style.forma-passiva",
        "grammar.parole-ripetute",
        "grammar.ma-pero",
        "clarity.frase-lunga",
        "clarity.burocratese",
        "vividness.cliches",
    },
    Language.JA: {
        "style.mazu-saisho",
        "style.redundant-potential",
        "style.double-negative",
        "clarity.touten-kajou",
        "clarity.long-sentence",
    },
    Language.ZH: {
        "style.filler",
        "style.jinxing",
        "clarity.douhao-guoduo",
    },
}


@pytest.fixture(scope="module")
def engine() -> RuleEngine:
    return RuleEngine(RULES_DIR)


@pytest.fixture(scope="module")
def registry() -> NlpRegistry:
    return NlpRegistry(NlpSettings().models)


@pytest.mark.parametrize("language", list(Language))
def test_demo_text_triggers_marquee_rules(
    language: Language, engine: RuleEngine, registry: NlpRegistry
) -> None:
    path = DEMOS_DIR / f"{language.value}.txt"
    assert path.is_file(), f"missing demo text {path}"
    text = path.read_text(encoding="utf-8")
    doc = registry.analyze(text, language.value)
    assert doc is not None
    triggered = {f.rule_id for f in engine.check(text, language, doc=doc) if f.rule_id}
    missing = EXPECTED[language] - triggered
    assert not missing, f"demo text does not trigger: {sorted(missing)}"


@pytest.mark.parametrize("language", list(Language))
def test_demo_text_triggers_terminology(
    language: Language, registry: NlpRegistry, tmp_path: Path
) -> None:
    from app.checkers.terminology import TerminologyChecker
    from app.services.seed import seed_terminology
    from app.services.terminology import TerminologyStore

    store = TerminologyStore(tmp_path / "test.db")
    seed_terminology(store)
    domain = store.list_domains()[0]
    checker = TerminologyChecker(store, nlp=registry)
    text = (DEMOS_DIR / f"{language.value}.txt").read_text(encoding="utf-8")
    findings = checker.check(text, language, domain.id)
    assert findings, f"demo text for {language.value} triggers no terminology finding"
