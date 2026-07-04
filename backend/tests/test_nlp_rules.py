from pathlib import Path

import pytest

from app.core.config import NlpSettings
from app.core.models import Language
from app.nlp.registry import NlpRegistry

from .test_rule_engine import make_engine, write_rule


@pytest.fixture(scope="module")
def registry() -> NlpRegistry:
    return NlpRegistry(NlpSettings().models)


@pytest.fixture
def rules_dir(tmp_path: Path) -> Path:
    return tmp_path / "rules"


TOKEN_RULE = """
extends: token_pattern
message: "'%s' hides the action in a noun."
level: suggestion
category: style
pattern:
  - {LEMMA: {IN: [make, take]}}
  - {POS: DET, OP: "?"}
  - {LOWER: {IN: [decision, assessment]}}
suggestions: [decide]
"""


class TestTokenPattern:
    def test_matches_lemma_and_pos(self, rules_dir: Path, registry: NlpRegistry) -> None:
        write_rule(rules_dir, "en", "style/nominalization.yml", TOKEN_RULE)
        engine = make_engine(rules_dir)
        text = "We made a decision yesterday."
        doc = registry.analyze(text, "en")
        findings = engine.check(text, Language.EN, doc=doc)
        assert len(findings) == 1
        assert findings[0].span.text == "made a decision"
        assert findings[0].message == "'made a decision' hides the action in a noun."
        assert findings[0].suggestions == ["decide"]

    def test_skipped_without_doc(self, rules_dir: Path) -> None:
        write_rule(rules_dir, "en", "style/nominalization.yml", TOKEN_RULE)
        engine = make_engine(rules_dir)
        assert engine.check("We made a decision.", Language.EN, doc=None) == []
        assert engine.nlp_rule_ids(Language.EN) == ["style.nominalization"]

    def test_invalid_pattern_reported_at_load(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/broken.yml",
            """
extends: token_pattern
message: x
category: style
pattern:
  - {NOSUCHATTR: foo}
""",
        )
        engine = make_engine(rules_dir)
        assert len(engine.errors) == 1
        assert "broken.yml" in engine.errors[0].file

    def test_pattern_required(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/empty.yml",
            "extends: token_pattern\nmessage: x\ncategory: style\n",
        )
        engine = make_engine(rules_dir)
        assert len(engine.errors) == 1
