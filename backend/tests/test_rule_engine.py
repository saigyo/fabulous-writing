from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleConfig, RuleEngine
from app.core.models import Category, Language, Severity


_STUB_EXAMPLES = """
examples:
  bad: ["trigger sentence"]
  good: ["clean sentence"]
"""


def write_rule(rules_dir: Path, lang: str, relpath: str, content: str) -> None:
    # examples: is schema-required; inline test rules get a stub block so
    # each test states only what it is about.
    if "examples:" not in content:
        content = content.rstrip() + "\n" + _STUB_EXAMPLES
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
        "ignorecase: true\ntokens: [very]\n" + _STUB_EXAMPLES
    )
    (tmp_path / "en" / "grammar" / "test-repeat.yml").write_text(
        "extends: repetition\nmessage: \"'%s' is repeated.\"\ncategory: grammar\n"
        + _STUB_EXAMPLES
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
            exceptions=["clarity.cherry", "clarity.optout", "style.cherry"],
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
        # Even with category off and pack off, an exception resurrects the rule.
        assert config.is_active("style", "style.cherry", pack="marketing")

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


def test_rule_without_examples_is_reported(tmp_path: Path) -> None:
    rules_dir = tmp_path / "rules"
    path = rules_dir / "en" / "style" / "bare.yml"
    path.parent.mkdir(parents=True)
    path.write_text(
        'extends: existence\nmessage: "x"\ncategory: style\ntokens: [x]\n',
        encoding="utf-8",
    )
    engine = RuleEngine(rules_dir)
    assert engine.list_rules() == []
    assert len(engine.errors) == 1
    assert "examples" in engine.errors[0].error


class TestCjkBoundaries:
    """\b never fires between two word chars, and kana/kanji are word
    chars — CJK-edged keys must not be boundary-anchored on that side."""

    def test_bounded_pattern_edges(self) -> None:
        from app.checkers.rules.text import bounded_pattern

        assert bounded_pattern("一番最初") == "(?:一番最初)"
        assert bounded_pattern("very") == r"\b(?:very)\b"
        assert bounded_pattern("No1万") == r"\b(?:No1万)"
        assert bounded_pattern("万No1") == r"(?:万No1)\b"

    def test_substitution_matches_cjk_mid_sentence(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "ja",
            "style/juufuku.yml",
            "extends: substitution\nmessage: \"%s statt %s\"\n"
            "category: style\nswap:\n  一番最初: 最初\n",
        )
        engine = RuleEngine(rules_dir)
        findings = engine.check("彼は一番最初に確認した。", Language.JA)
        assert [f.span.text for f in findings] == ["一番最初"]
        assert findings[0].suggestions == ["最初"]

    def test_existence_tokens_match_cjk_mid_sentence(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "ja",
            "style/hype.yml",
            "extends: existence\nmessage: hype\ncategory: style\ntokens: [究極]\n",
        )
        engine = RuleEngine(rules_dir)
        findings = engine.check("これぞ究極の体験です。", Language.JA)
        assert [f.span.text for f in findings] == ["究極"]

    def test_latin_keys_still_respect_word_boundaries(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir,
            "en",
            "style/sub.yml",
            "extends: substitution\nmessage: \"%s not %s\"\n"
            "category: style\nswap:\n  cat: feline\n",
        )
        engine = RuleEngine(rules_dir)
        assert engine.check("The catalog is big.", Language.EN) == []
        assert len(engine.check("The cat sleeps.", Language.EN)) == 1

    def test_empty_existence_token_is_load_error(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir, "ja", "style/empty.yml",
            "extends: existence\nmessage: m\ncategory: style\ntokens: ['']\n",
        )
        engine = RuleEngine(rules_dir)
        assert len(engine.errors) == 1
        assert engine.check("何でも", Language.JA) == []  # must not raise

    def test_empty_substitution_key_is_load_error(self, rules_dir: Path) -> None:
        write_rule(
            rules_dir, "ja", "style/empty-swap.yml",
            "extends: substitution\nmessage: \"%s %s\"\ncategory: style\nswap:\n  '': x\n",
        )
        engine = RuleEngine(rules_dir)
        assert len(engine.errors) == 1
        assert engine.check("何でも", Language.JA) == []


CONSISTENCY_OK = """
extends: consistency
message: "文体が混在しています"
level: warning
category: style
variants:
  polite:
    pattern:
      - {LEMMA: {IN: [です, ます]}, POS: AUX}
    anchor: end
  plain:
    default: true
"""


class TestConsistencyValidation:
    def _errors(self, rules_dir: Path, body: str) -> list[str]:
        write_rule(rules_dir, "ja", "style/consistency.yml", body)
        return [e.error for e in RuleEngine(rules_dir).errors]

    def test_valid_consistency_rule_loads(self, rules_dir: Path) -> None:
        write_rule(rules_dir, "ja", "style/desu-masu.yml", CONSISTENCY_OK)
        engine = RuleEngine(rules_dir)
        assert engine.errors == []
        assert [r.rule_id for r in engine.list_rules()] == ["style.desu-masu"]

    def test_consistency_requires_two_variants(self, rules_dir: Path) -> None:
        errors = self._errors(
            rules_dir,
            "extends: consistency\nmessage: m\ncategory: style\n"
            "variants:\n  polite:\n    pattern: [{TEXT: a}]\n",
        )
        assert len(errors) == 1 and "at least two" in errors[0]

    def test_consistency_rejects_two_defaults(self, rules_dir: Path) -> None:
        errors = self._errors(
            rules_dir,
            "extends: consistency\nmessage: m\ncategory: style\n"
            "variants:\n  a:\n    default: true\n  b:\n    default: true\n",
        )
        assert len(errors) == 1 and "one default" in errors[0]

    def test_default_variant_must_not_set_anchor(self, rules_dir: Path) -> None:
        errors = self._errors(
            rules_dir,
            "extends: consistency\nmessage: m\ncategory: style\n"
            "variants:\n  a:\n    pattern: [{TEXT: a}]\n"
            "  b:\n    default: true\n    anchor: end\n",
        )
        assert len(errors) == 1 and "must not set 'anchor'" in errors[0]

    def test_default_variant_must_not_have_pattern(self, rules_dir: Path) -> None:
        errors = self._errors(
            rules_dir,
            "extends: consistency\nmessage: m\ncategory: style\n"
            "variants:\n  a:\n    pattern: [{TEXT: a}]\n"
            "  b:\n    default: true\n    pattern: [{TEXT: b}]\n",
        )
        assert len(errors) == 1 and "must not have a pattern" in errors[0]

    def test_non_default_variant_needs_pattern(self, rules_dir: Path) -> None:
        errors = self._errors(
            rules_dir,
            "extends: consistency\nmessage: m\ncategory: style\n"
            "variants:\n  a:\n    pattern: [{TEXT: a}]\n  b: {}\n",
        )
        assert len(errors) == 1 and "needs a 'pattern'" in errors[0]

    def test_bad_variant_pattern_attribute_is_load_error(
        self, rules_dir: Path
    ) -> None:
        errors = self._errors(
            rules_dir,
            "extends: consistency\nmessage: m\ncategory: style\n"
            "variants:\n  a:\n    pattern: [{NOPE: x}]\n  b:\n    default: true\n",
        )
        assert len(errors) == 1
        assert "a" in errors[0]

    def test_consistency_requires_doc(self, rules_dir: Path) -> None:
        from app.checkers.rules.loader import rule_requires_doc

        write_rule(rules_dir, "ja", "style/desu-masu.yml", CONSISTENCY_OK)
        engine = RuleEngine(rules_dir)
        assert rule_requires_doc(engine.list_rules()[0].spec)
