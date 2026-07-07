"""Every rule runs against its own YAML examples — the catalog tests itself.

Bad sentences must yield >=1 finding from that rule; good sentences none.
Other rules firing on the same sentence is fine (findings are filtered by
rule id).
"""

from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleConfig, RuleEngine
from app.checkers.rules.loader import LoadedRule, rule_requires_doc
from app.core.config import NlpSettings
from app.core.models import Finding
from app.nlp.registry import NlpRegistry

RULES_DIR = Path(__file__).parent.parent / "rules"
ENGINE = RuleEngine(RULES_DIR)
REGISTRY = NlpRegistry(NlpSettings().models)

# Until examples are mandatory (see the backfill), rules without them are
# simply not parametrized.
RULES = [rule for rule in ENGINE.list_rules() if rule.spec.examples is not None]


def _hits(rule: LoadedRule, sentence: str) -> list[Finding]:
    doc = None
    if rule_requires_doc(rule.spec):
        doc = REGISTRY.analyze(sentence, rule.language.value)
        assert doc is not None, f"spaCy model for '{rule.language.value}' unavailable"
    config = RuleConfig(packs_on=[rule.spec.pack] if rule.spec.pack else [])
    findings = ENGINE.check(sentence, rule.language, doc=doc, config=config)
    return [f for f in findings if f.rule_id == rule.rule_id]


def _rule_id(rule: LoadedRule) -> str:
    return f"{rule.language.value}:{rule.rule_id}"


def test_catalog_loads_without_errors() -> None:
    assert ENGINE.errors == []


@pytest.mark.parametrize("rule", RULES, ids=_rule_id)
def test_bad_examples_fire(rule: LoadedRule) -> None:
    for sentence in rule.spec.examples.bad:
        assert _hits(rule, sentence), (
            f"{rule.rule_id}: expected a finding for bad example {sentence!r}"
        )


@pytest.mark.parametrize("rule", RULES, ids=_rule_id)
def test_good_examples_stay_clean(rule: LoadedRule) -> None:
    for sentence in rule.spec.examples.good:
        hits = _hits(rule, sentence)
        assert not hits, (
            f"{rule.rule_id}: good example {sentence!r} unexpectedly flagged "
            f"{[f.span.text for f in hits]}"
        )
