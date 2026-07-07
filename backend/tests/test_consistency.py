"""Consistency check: classify sentences into variants, flag the minority.

Uses the real GiNZA pipeline — classification hinges on POS/lemma output
that a fake doc cannot faithfully reproduce.
"""

from pathlib import Path

import pytest

from app.checkers.rules.engine import RuleEngine
from app.core.config import NlpSettings
from app.core.models import Language
from app.nlp.registry import NlpRegistry

from .test_rule_engine import write_rule

REGISTRY = NlpRegistry(NlpSettings().models)

DESU_MASU = """
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


@pytest.fixture
def engine(tmp_path: Path) -> RuleEngine:
    rules_dir = tmp_path / "rules"
    write_rule(rules_dir, "ja", "style/desu-masu.yml", DESU_MASU)
    eng = RuleEngine(rules_dir)
    assert eng.errors == []
    return eng


def check(engine: RuleEngine, text: str):
    doc = REGISTRY.analyze(text, "ja")
    assert doc is not None, "ja_ginza unavailable"
    return engine.check(text, Language.JA, doc=doc)


class TestConsistency:
    def test_minority_plain_sentence_flagged(self, engine: RuleEngine) -> None:
        text = "本製品は高速です。設定も簡単だ。導入も容易です。"
        findings = check(engine, text)
        assert [f.span.text for f in findings] == ["設定も簡単だ。"]
        assert findings[0].rule_id == "style.desu-masu"
        assert text[findings[0].span.start : findings[0].span.end] == "設定も簡単だ。"

    def test_minority_polite_sentence_flagged(self, engine: RuleEngine) -> None:
        text = "本製品は高速だ。設定も簡単である。導入も容易です。"
        findings = check(engine, text)
        assert [f.span.text for f in findings] == ["導入も容易です。"]

    def test_uniform_document_is_clean(self, engine: RuleEngine) -> None:
        assert check(engine, "本製品は高速です。導入も容易です。") == []
        assert check(engine, "本製品は高速だ。導入も容易である。") == []

    def test_tie_breaks_by_declaration_order(self, engine: RuleEngine) -> None:
        # 1 polite + 1 plain: polite is declared first, so plain is flagged.
        findings = check(engine, "本製品は高速です。設定も簡単だ。")
        assert [f.span.text for f in findings] == ["設定も簡単だ。"]

    def test_fragments_do_not_vote_and_are_never_flagged(
        self, engine: RuleEngine
    ) -> None:
        # Heading (ends ADP) and 体言止め (ends NOUN) are unclassified;
        # the rest is uniformly polite → no findings.
        text = "はじめに\n本製品は高速です。結果は次の通り。導入も容易です。"
        assert check(engine, text) == []

    def test_quoted_polite_inside_plain_stays_plain(
        self, engine: RuleEngine
    ) -> None:
        # です inside brackets sits before the anchor window at the end.
        text = "彼は「便利です」と言った。今日は晴れだ。"
        assert check(engine, text) == []

    def test_final_particles_are_stripped_before_anchoring(
        self, engine: RuleEngine
    ) -> None:
        # ます + か(PART) + ？: stripping the tail exposes ます at the end.
        text = "すぐ行きますか？すぐ行きます。今日は晴れだ。"
        findings = check(engine, text)
        assert [f.span.text for f in findings] == ["今日は晴れだ。"]

    def test_standalone_quote_votes_with_its_internal_register(
        self, engine: RuleEngine
    ) -> None:
        # GiNZA splits the bare quote into its own sentence; the trailing
        # bracket is stripped as PUNCT, so the quote's internal polite
        # register votes — documented limitation, pinned here.
        text = "彼は部屋に入った。窓を開けた。彼女は微笑んだ。『今日はいい天気です』"
        findings = check(engine, text)
        assert [f.span.text for f in findings] == ["『今日はいい天気です』"]

    def test_single_variant_documents_never_flag(self, engine: RuleEngine) -> None:
        assert check(engine, "本製品は高速です。") == []
        assert check(engine, "本製品は高速だ。") == []

    def test_no_doc_skips_quietly(self, engine: RuleEngine) -> None:
        assert engine.check("本製品は高速です。設定も簡単だ。", Language.JA) == []
        assert "style.desu-masu" in engine.nlp_rule_ids(Language.JA)
