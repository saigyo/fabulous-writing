"""Address-register consistency rules (FR/ES/IT/ZH) against the real
catalog and live spaCy models, plus the two morphology-gated grammar
rules. Slim by design: catalog examples already cover one bad/good pair
per rule; these tests pin the voting behavior (both minority directions,
tie-break, silence below two votes) that single examples cannot."""

from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleEngine
from app.core.config import NlpSettings
from app.core.models import Language
from app.nlp.registry import NlpRegistry

RULES_DIR = Path(__file__).parent.parent / "rules"
ENGINE = RuleEngine(RULES_DIR)
REGISTRY = NlpRegistry(NlpSettings().models)


def hits(text: str, language: Language, rule_id: str):
    doc = REGISTRY.analyze(text, language.value)
    assert doc is not None, f"model for {language.value} unavailable"
    return [f for f in ENGINE.check(text, language, doc=doc) if f.rule_id == rule_id]


FR_RULE = "grammar.tutoiement-vouvoiement"


class TestTutoiementVouvoiement:
    def test_minority_formal_flagged(self) -> None:
        text = (
            "Tu peux relire ton texte ce soir. Pense à corriger tes fautes. "
            "Vous pouvez ensuite le publier."
        )
        found = hits(text, Language.FR, FR_RULE)
        assert len(found) == 1
        assert "Vous" in found[0].span.text

    def test_minority_informal_flagged(self) -> None:
        text = (
            "Vous pouvez relire votre texte ce soir. Vérifiez vos sources. "
            "Tu peux ensuite le publier."
        )
        found = hits(text, Language.FR, FR_RULE)
        assert len(found) == 1
        assert "Tu" in found[0].span.text

    def test_single_vote_is_silent(self) -> None:
        text = "Tu peux commencer maintenant. La suite viendra plus tard."
        assert hits(text, Language.FR, FR_RULE) == []

    def test_uniform_register_is_silent(self) -> None:
        text = "Vous pouvez relire votre texte. Vous pouvez le publier."
        assert hits(text, Language.FR, FR_RULE) == []


class TestApresQueSubjonctif:
    def test_subjunctive_fires(self) -> None:
        text = "Après qu'il soit parti, nous avons mangé."
        assert hits(text, Language.FR, "grammar.apres-que-subjonctif")

    def test_indicative_is_clean(self) -> None:
        text = "Après qu'il est parti, nous avons mangé."
        assert hits(text, Language.FR, "grammar.apres-que-subjonctif") == []


ES_RULE = "grammar.tuteo-ustedeo"


class TestTuteoUstedeo:
    def test_minority_formal_flagged(self) -> None:
        text = (
            "Puedes empezar hoy con tu borrador. Te aviso cuando termine la revisión. "
            "Usted puede publicar después."
        )
        found = hits(text, Language.ES, ES_RULE)
        assert len(found) == 1
        assert "Usted" in found[0].span.text

    def test_minority_informal_flagged(self) -> None:
        text = (
            "Usted debe revisar el ritmo del proyecto. Usted controla el avance del proyecto. "
            "Te aviso cuando termine la revisión."
        )
        found = hits(text, Language.ES, ES_RULE)
        assert len(found) == 1
        assert "Te aviso" in found[0].span.text

    def test_single_vote_is_silent(self) -> None:
        text = "Puedes empezar hoy mismo. El resto llegará después."
        assert hits(text, Language.ES, ES_RULE) == []


class TestHaberImpersonal:
    def test_existential_plural_fires(self) -> None:
        assert hits("Habían muchos problemas en el proyecto.", Language.ES, "grammar.haber-impersonal")

    def test_auxiliary_is_clean(self) -> None:
        assert hits("Ellos habían comido antes de salir.", Language.ES, "grammar.haber-impersonal") == []
