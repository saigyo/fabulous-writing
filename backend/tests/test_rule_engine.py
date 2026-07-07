from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleConfig, RuleEngine
from app.core.models import Category, Language, Severity


def write_rule(rules_dir: Path, lang: str, relpath: str, content: str) -> None:
    path = rules_dir / lang / relpath
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@pytest.fixture
def rules_dir(tmp_path: Path) -> Path:
    return tmp_path / "rules"


def make_engine(rules_dir: Path) -> RuleEngine:
    rules_dir.mkdir(parents=True, exist_ok=True)
    return RuleEngine(rules_dir)


class TestExistence:
    def test_flags_token_with_span_and_formatted_message(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/weasel-words.yml",
            """
extends: existence
message: "'%s' is a weasel word."
level: warning
category: style
ignorecase: true
tokens:
  - very
  - extremely
""",
        )
        engine = make_engine(rules_dir)
        findings = engine.check("This is Very good.", Language.EN)
        assert len(findings) == 1
        f = findings[0]
        assert f.message == "'Very' is a weasel word."
        assert f.span.start == 8
        assert f.span.end == 12
        assert f.span.text == "Very"
        assert f.category == Category.STYLE
        assert f.severity == Severity.WARNING
        assert f.rule_id == "style.weasel-words"

    def test_respects_word_boundaries(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/weasel-words.yml",
            """
extends: existence
message: "'%s' is a weasel word."
category: style
tokens: [very]
""",
        )
        engine = make_engine(rules_dir)
        assert engine.check("everyone has everything", Language.EN) == []

    def test_case_sensitive_by_default(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/weasel-words.yml",
            """
extends: existence
message: "'%s' found."
category: style
tokens: [very]
""",
        )
        engine = make_engine(rules_dir)
        assert engine.check("Very good", Language.EN) == []
        assert len(engine.check("very good", Language.EN)) == 1

    def test_raw_regex_tokens(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/exclamations.yml",
            """
extends: existence
message: "Avoid multiple exclamation marks."
category: style
raw:
  - '!{2,}'
""",
        )
        engine = make_engine(rules_dir)
        findings = engine.check("Wow!!! Nice.", Language.EN)
        assert len(findings) == 1
        assert findings[0].span.text == "!!!"


class TestSubstitution:
    def test_flags_and_suggests_replacement(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/wordiness.yml",
            """
extends: substitution
message: "Use '%s' instead of '%s'."
level: suggestion
category: clarity
ignorecase: true
swap:
  utilize: use
  in order to: to
""",
        )
        engine = make_engine(rules_dir)
        findings = engine.check("We utilize tools in order to work.", Language.EN)
        assert len(findings) == 2
        by_text = {f.span.text: f for f in findings}
        assert by_text["utilize"].suggestions == ["use"]
        assert by_text["utilize"].message == "Use 'use' instead of 'utilize'."
        assert by_text["in order to"].suggestions == ["to"]


class TestOccurrence:
    def test_flags_sentence_exceeding_max_tokens(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "clarity/long-sentence.yml",
            """
extends: occurrence
message: "Sentence has more than 5 words; consider splitting it."
level: suggestion
category: clarity
scope: sentence
token: '\\b\\w+\\b'
max: 5
""",
        )
        engine = make_engine(rules_dir)
        text = "Short one. This particular sentence definitely contains far too many words."
        findings = engine.check(text, Language.EN)
        assert len(findings) == 1
        assert findings[0].span.text.startswith("This particular")
        assert findings[0].span.start == text.index("This")


class TestRepetition:
    def test_flags_adjacent_duplicate_words(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "grammar/repeated-words.yml",
            """
extends: repetition
message: "'%s' is repeated."
level: error
category: grammar
ignorecase: true
""",
        )
        engine = make_engine(rules_dir)
        findings = engine.check("This is is the the problem.", Language.EN)
        assert len(findings) == 2
        assert findings[0].span.text == "is is"
        assert findings[0].suggestions == ["is"]
        assert findings[1].span.text == "the the"


class TestLoader:
    def test_language_selection(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/en-rule.yml",
            """
extends: existence
message: "'%s' found."
category: style
tokens: [very]
""",
        )
        write_rule(
            rules_dir,
            "de",
            "style/de-rule.yml",
            """
extends: existence
message: "'%s' ist ein Füllwort."
category: style
tokens: [halt]
""",
        )
        engine = make_engine(rules_dir)
        assert engine.check("very halt", Language.EN)[0].rule_id == "style.en-rule"
        assert engine.check("very halt", Language.DE)[0].rule_id == "style.de-rule"

    def test_invalid_rule_reported_but_not_fatal(self, rules_dir: Path) -> None:
        write_rule(rules_dir, "en", "style/broken.yml", "extends: nonsense\nmessage: x\n")
        write_rule(
            rules_dir,
            "en",
            "style/good.yml",
            """
extends: existence
message: "'%s' found."
category: style
tokens: [very]
""",
        )
        engine = make_engine(rules_dir)
        assert len(engine.errors) == 1
        assert "broken.yml" in engine.errors[0].file
        assert len(engine.check("very", Language.EN)) == 1

    def test_lists_loaded_rules(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/good.yml",
            """
extends: existence
message: "'%s' found."
category: style
tokens: [very]
""",
        )
        engine = make_engine(rules_dir)
        rules = engine.list_rules()
        assert len(rules) == 1
        assert rules[0].rule_id == "style.good"
        assert rules[0].language == Language.EN


def _rule_ids(findings):
    return {f.rule_id for f in findings}


def _engine_with_two_rules(tmp_path):
    (tmp_path / "en" / "style").mkdir(parents=True)
    (tmp_path / "en" / "grammar").mkdir(parents=True)
    (tmp_path / "en" / "style" / "test-weasel.yml").write_text(
        "extends: existence\nmessage: \"'%s' is weak.\"\ncategory: style\n"
        "ignorecase: true\ntokens: [very]\n"
    )
    (tmp_path / "en" / "grammar" / "test-repeat.yml").write_text(
        "extends: repetition\nmessage: \"'%s' is repeated.\"\ncategory: grammar\n"
    )
    return RuleEngine(tmp_path)


def test_rule_config_none_means_all_active(tmp_path):
    engine = _engine_with_two_rules(tmp_path)
    text = "This is very good. The cat cat sat."
    assert _rule_ids(engine.check(text, Language.EN)) == {
        "style.test-weasel", "grammar.test-repeat",
    }


def test_rule_config_category_off(tmp_path):
    engine = _engine_with_two_rules(tmp_path)
    text = "This is very good. The cat cat sat."
    config = RuleConfig(categories_off=["style"], exceptions=[])
    assert _rule_ids(engine.check(text, Language.EN, config=config)) == {
        "grammar.test-repeat",
    }


def test_rule_config_exception_inverts(tmp_path):
    engine = _engine_with_two_rules(tmp_path)
    text = "This is very good. The cat cat sat."
    # Category on + exception -> rule off.
    config = RuleConfig(categories_off=[], exceptions=["grammar.test-repeat"])
    assert _rule_ids(engine.check(text, Language.EN, config=config)) == {
        "style.test-weasel",
    }
    # Category off + exception -> rule back on.
    config = RuleConfig(categories_off=["style"], exceptions=["style.test-weasel"])
    assert "style.test-weasel" in _rule_ids(engine.check(text, Language.EN, config=config))


def test_rule_config_unknown_ids_harmless(tmp_path):
    engine = _engine_with_two_rules(tmp_path)
    config = RuleConfig(categories_off=["nosuchcategory"], exceptions=["gone.rule"])
    text = "This is very good."
    assert "style.test-weasel" in _rule_ids(engine.check(text, Language.EN, config=config))


class TestPacks:
    def test_is_active_truth_table(self) -> None:
        config = RuleConfig(
            categories_off=["style"],
            exceptions=["clarity.cherry", "clarity.optout"],
            packs_on=["techdocs"],
        )
        # General rules: unchanged XOR semantics.
        assert config.is_active("clarity", "clarity.plain")
        assert not config.is_active("style", "style.plain")
        # Pack rule, pack on, category on -> active.
        assert config.is_active("clarity", "clarity.pack", pack="techdocs")
        # Pack rule, pack off -> inactive.
        assert not config.is_active("clarity", "clarity.pack", pack="marketing")
        # Pack off + exception -> cherry-picked active.
        assert config.is_active("clarity", "clarity.cherry", pack="marketing")
        # Pack on + exception -> opted out.
        assert not config.is_active("clarity", "clarity.optout", pack="techdocs")
        # Pack on but category off -> inactive (category toggle wins).
        assert not config.is_active("style", "style.pack", pack="techdocs")

    def test_pack_rules_skipped_by_default(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/hype.yml",
            """
extends: existence
message: "'%s' is hype."
level: warning
category: style
pack: marketing
tokens: [revolutionary]
""",
        )
        engine = make_engine(rules_dir)
        assert engine.errors == []
        text = "A revolutionary idea."
        # No config and empty config: pack rule stays off.
        assert engine.check(text, Language.EN) == []
        assert engine.check(text, Language.EN, config=RuleConfig()) == []
        # Enabled pack: rule fires.
        active = engine.check(
            text, Language.EN, config=RuleConfig(packs_on=["marketing"])
        )
        assert [f.rule_id for f in active] == ["style.hype"]

    def test_invalid_pack_slug_is_reported(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/bad-pack.yml",
            """
extends: existence
message: "x"
category: style
pack: "Tech Docs"
tokens: [x]
""",
        )
        engine = make_engine(rules_dir)
        assert engine.list_rules() == []
        assert len(engine.errors) == 1
        assert "pack" in engine.errors[0].error
