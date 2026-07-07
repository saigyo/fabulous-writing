# Japanese Rules + Consistency Check Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a document-scoped `consistency` check type (です・ます/だ・である style uniformity), fix CJK word-boundary handling in existence/substitution, and ship 16 new Japanese rules (9 general + 7 pack).

**Architecture:** The rule engine (`backend/app/checkers/rules/`) gains a sixth check type, `consistency`, which classifies each sentence into a named variant via spaCy Matcher patterns and flags every minority-variant sentence when a document mixes variants. A shared `bounded_pattern` helper makes `\b`-wrapping edge-aware so CJK keys match mid-sentence. All new rules are YAML files under `backend/rules/ja/` with mandatory `examples` blocks that auto-enroll in the catalog-wide example test.

**Tech Stack:** Python 3.13 / FastAPI backend (run everything from `backend/` with `uv run`), spaCy + GiNZA (`ja_ginza`) for Japanese NLP, pytest.

**Spec:** `docs/superpowers/specs/2026-07-07-ja-rules-consistency-design.md` — read it for the rationale behind every decision below.

**Conventions (established in phase 1, follow them):**
- Commits go directly on `main`, pushed at the end; messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Every rule file MUST have an `examples:` block (`bad` + `good`, ≥1 each) — the schema rejects files without one.
- Substitution messages: first `%s` = the good replacement, second `%s` = the matched bad text (see `rules/de/grammar/beliebte-fehler.yml`).
- token_pattern messages: single `%s` = the matched text.
- Run backend tests from `backend/`: `uv run pytest tests/ -x -q` (full) or with `::` selectors. GiNZA-loading tests take ~10-20s to warm up; that is normal.

**Verified GiNZA facts the rules rely on** (probed 2026-07-07 with `ja_ginza`, split_mode C — do not re-derive, but re-probe if an example test fails unexpectedly):
- ら抜き potentials are single tokens whose LEMMA is the ら抜き form: 見れます → 見れ/LEMMA=見れる, 食べれない → 食べれ/LEMMA=食べれる, 来れますか → 来れ/LEMMA=来れる. Godan potentials (走れる) have their own lemmas and are legitimate.
- い抜き/casual contractions are AUX tokens: してる → てる/AUX/LEMMA=てる, 読んでる → でる/AUX/LEMMA=でる, しちゃった → ちゃっ/AUX/LEMMA=ちゃう, やっとく → とく/AUX/LEMMA=とく. The verb 出る is POS=VERB, never AUX.
- ご覧になられます → ご覧/NOUN + に/ADP + なら/LEMMA=なる + れ/AUX/LEMMA=れる + ます.
- 「会議で発言させていただきます」 (legitimate causative) → 発言 + さ/AUX/LEMMA=する + せ/AUX/LEMMA=せる — raw-text regex on godan stems (行かさせ etc.) cannot hit it.
- である → で/AUX/LEMMA=だ + ある/VERB; 高速だ ends だ/AUX; 行きますか？ ends ます + か/PART + ？/PUNCT; はじめに ends に/ADP; 結果は次の通り。 ends 通り/NOUN (体言止め).
- サ変 nouns carry TAG `名詞-普通名詞-サ変可能` (検討, 会議, 発言…).
- `Matcher(vocab)(span)` on a sentence **Span returns span-relative indices** — add `sent.start` to map to doc tokens (verified by probe; the consistency check code below accounts for it).
- `\b` never matches between two word chars; kana/kanji are word chars, so `\b一番最初\b` finds nothing in 「彼は一番最初に確認した。」 (verified).

---

## Task 1: CJK edge-aware boundary helper (`bounded_pattern`)

**Files:**
- Modify: `backend/app/checkers/rules/text.py` (append)
- Modify: `backend/app/checkers/rules/checks/existence.py:13`
- Modify: `backend/app/checkers/rules/checks/substitution.py:15`
- Test: `backend/tests/test_rule_engine.py` (append a class)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_rule_engine.py` (it already imports `Path`, `pytest`, `RuleEngine`, `Language`, and defines `write_rule` + the `rules_dir` fixture at the top — reuse them):

```python
class TestCjkBoundaries:
    """\\b never fires between two word chars, and kana/kanji are word
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_rule_engine.py::TestCjkBoundaries -q`
Expected: 4 failures — `ImportError: cannot import name 'bounded_pattern'` for the first, empty-findings assertion failures for the CJK tests (the Latin test may already pass; that is fine, it pins the status quo).

- [ ] **Step 3: Implement `bounded_pattern` in `text.py`**

Append to `backend/app/checkers/rules/text.py`:

```python
# Han (incl. ext. A + compatibility), Hiragana, Katakana, CJK punctuation,
# and full-width forms. A `\b` on a side whose edge char is in these ranges
# can never match mid-sentence (kana/kanji count as \w), so we drop it.
_CJK_CHAR = re.compile(
    "[\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]"
)


def bounded_pattern(fragment: str) -> str:
    """Wrap a regex fragment in word boundaries, edge-aware for CJK."""
    left = "" if _CJK_CHAR.match(fragment[0]) else r"\b"
    right = "" if _CJK_CHAR.match(fragment[-1]) else r"\b"
    return rf"{left}(?:{fragment}){right}"
```

- [ ] **Step 4: Use it in existence and substitution**

In `backend/app/checkers/rules/checks/existence.py`, change the import line and the `patterns` line:

```python
from ..text import bounded_pattern, format_message
...
    patterns = [bounded_pattern(token) for token in spec.tokens] + list(spec.raw)
```

In `backend/app/checkers/rules/checks/substitution.py`, change the import line and the `finditer` line:

```python
from ..text import bounded_pattern, format_message
...
        for match in re.finditer(bounded_pattern(bad), ctx.text, flags):
```

- [ ] **Step 5: Run the tests and the full suite**

Run: `uv run pytest tests/test_rule_engine.py::TestCjkBoundaries -q` → 4 passed.
Run: `uv run pytest tests/ -x -q` → everything green (EN/DE rules must be byte-for-byte unaffected; the catalog example tests prove it).

- [ ] **Step 6: Commit**

```bash
git add app/checkers/rules/text.py app/checkers/rules/checks/existence.py app/checkers/rules/checks/substitution.py tests/test_rule_engine.py
git commit -m "fix: make word-boundary wrapping CJK-aware in existence/substitution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `consistency` check type — loader schema + validation

**Files:**
- Modify: `backend/app/checkers/rules/loader.py`
- Test: `backend/tests/test_rule_engine.py` (append a class)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_rule_engine.py`:

```python
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

    def test_consistency_allows_one_default(self, rules_dir: Path) -> None:
        errors = self._errors(
            rules_dir,
            "extends: consistency\nmessage: m\ncategory: style\n"
            "variants:\n  a:\n    default: true\n  b:\n    default: true\n",
        )
        assert len(errors) == 1 and "one default" in errors[0]

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

    def test_consistency_requires_doc(self, rules_dir: Path) -> None:
        from app.checkers.rules.loader import rule_requires_doc

        write_rule(rules_dir, "ja", "style/desu-masu.yml", CONSISTENCY_OK)
        engine = RuleEngine(rules_dir)
        assert rule_requires_doc(engine.list_rules()[0].spec)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_rule_engine.py::TestConsistencyValidation -q`
Expected: FAIL — pydantic rejects `extends: consistency` (not in the `CheckType` literal), so every rule lands in `errors` with the wrong message.

- [ ] **Step 3: Implement the schema in `loader.py`**

In `backend/app/checkers/rules/loader.py`:

Add `"consistency"` to the `CheckType` literal and to `NLP_CHECK_TYPES`:

```python
CheckType = Literal[
    "existence",
    "substitution",
    "occurrence",
    "repetition",
    "token_pattern",
    "dependency",
    "consistency",
]

NLP_CHECK_TYPES = {"token_pattern", "dependency", "consistency"}
```

Add `VariantSpec` above `RuleSpec`:

```python
class VariantSpec(BaseModel):
    """One style variant of a consistency rule. Non-default variants are
    recognized by their Matcher pattern; the (single, optional) default
    variant claims any sentence with a predicate ending no pattern matched."""

    pattern: list[dict] | None = None
    anchor: Literal["end", "anywhere"] = "anywhere"
    default: bool = False
```

Add the field to `RuleSpec` (after `pack`, before `examples`):

```python
    # consistency: named style variants; minority-variant sentences get flagged
    variants: dict[str, VariantSpec] | None = None
```

In `check_required_fields`, change the NLP-pattern check (consistency has `variants`, not `pattern`) and add the consistency block:

```python
        if self.extends in ("token_pattern", "dependency") and not self.pattern:
            raise ValueError(f"{self.extends} rules need 'pattern'")
        if self.extends == "consistency":
            variants = self.variants or {}
            if len(variants) < 2:
                raise ValueError("consistency rules need at least two 'variants'")
            defaults = [name for name, v in variants.items() if v.default]
            if len(defaults) > 1:
                raise ValueError("consistency rules allow at most one default variant")
            for name, variant in variants.items():
                if variant.default and variant.pattern is not None:
                    raise ValueError(
                        f"default variant '{name}' must not have a pattern"
                    )
                if not variant.default and not variant.pattern:
                    raise ValueError(f"variant '{name}' needs a 'pattern'")
        return self
```

In `_validate_nlp_pattern`, handle the new type:

```python
    vocab = spacy.blank(language.value).vocab
    if spec.extends == "consistency":
        matcher = Matcher(vocab, validate=True)
        for name, variant in (spec.variants or {}).items():
            if variant.pattern:
                matcher.add(name, [variant.pattern])
    elif spec.extends == "token_pattern":
        Matcher(vocab, validate=True).add("_", [spec.pattern])
    else:
        DependencyMatcher(vocab, validate=True).add("_", [spec.pattern])
```

`rule_requires_doc` needs no change — it keys off `NLP_CHECK_TYPES`.

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_rule_engine.py::TestConsistencyValidation -q` → 7 passed.
Note: the engine has no `consistency` entry in `CHECKS` yet, so `test_valid_consistency_rule_loads` only proves loading; execution comes in Task 3. If `RuleEngine.check` crashes on an unknown check type when a consistency rule is merely *loaded*, register a temporary stub is NOT the fix — check how `engine.py` dispatches (it looks up `CHECKS[spec.extends]` only for rules it runs) and if needed move `test_valid_consistency_rule_loads`'s engine-side assertions to Task 3.

- [ ] **Step 5: Run the full suite**

Run: `uv run pytest tests/ -x -q` → green.

- [ ] **Step 6: Commit**

```bash
git add app/checkers/rules/loader.py tests/test_rule_engine.py
git commit -m "feat: consistency check type schema — variants with anchor/default

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `consistency` check implementation

**Files:**
- Create: `backend/app/checkers/rules/checks/consistency.py`
- Modify: `backend/app/checkers/rules/checks/__init__.py`
- Test: Create `backend/tests/test_consistency.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_consistency.py`:

```python
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

    def test_single_variant_documents_never_flag(self, engine: RuleEngine) -> None:
        assert check(engine, "本製品は高速です。") == []
        assert check(engine, "本製品は高速だ。") == []

    def test_no_doc_skips_quietly(self, engine: RuleEngine) -> None:
        assert engine.check("本製品は高速です。設定も簡単だ。", Language.JA) == []
        assert "style.desu-masu" in engine.nlp_rule_ids(Language.JA)
```

Note: `tests/__init__.py` exists, so the relative import works — this is the
same pattern `tests/test_nlp_rules.py` already uses
(`from .test_rule_engine import make_engine, write_rule`). `nlp_rule_ids`
is the engine's real method (engine.py:50): "Rule ids that need a spaCy doc
and are skipped without one."

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_consistency.py -q`
Expected: FAIL/ERROR — `KeyError: 'consistency'` (or similar) from the check dispatch, since `CHECKS` has no entry yet.

- [ ] **Step 3: Implement the check**

Create `backend/app/checkers/rules/checks/consistency.py`:

```python
from app.core.models import Finding, Source, Span

from ..context import CheckContext
from ..loader import LoadedRule

# Trailing tokens ignored for classification: closing punctuation, symbols,
# final particles (JA 終助詞 like か・ね・よ are POS=PART), and whitespace.
_TAIL_POS = {"PUNCT", "SYM", "PART", "SPACE"}
# A sentence only falls back to the default variant if it actually ends in
# a predicate — headings, labels, and 体言止め stay unclassified.
_PREDICATE_POS = {"VERB", "ADJ", "AUX"}
# With anchor: end, a match must end within this many tokens of the
# stripped sentence end (covers 〜ました = まし+た and 〜でしょう = でしょ+う).
_ANCHOR_WINDOW = 3


def check_consistency(rule: LoadedRule, ctx: CheckContext) -> list[Finding]:
    doc = ctx.doc
    if doc is None:
        return []
    from spacy.matcher import Matcher

    spec = rule.spec
    assert spec.variants is not None  # guaranteed by load-time validation

    matchers: dict[str, Matcher] = {}
    for name, variant in spec.variants.items():
        if variant.pattern:
            matcher = Matcher(doc.vocab)
            matcher.add(name, [variant.pattern])
            matchers[name] = matcher
    default_name = next(
        (name for name, v in spec.variants.items() if v.default), None
    )

    classified: dict[str, list] = {name: [] for name in spec.variants}
    for sent in doc.sents:
        name = _classify(spec, matchers, default_name, sent)
        if name is not None:
            classified[name].append(sent)

    voting = {name: sents for name, sents in classified.items() if sents}
    if len(voting) < 2:
        return []
    # max() keeps the first maximum in iteration order, and dicts preserve
    # YAML declaration order — so ties go to the first-declared variant.
    majority = max(voting, key=lambda name: len(voting[name]))

    findings: list[Finding] = []
    for name, sents in voting.items():
        if name == majority:
            continue
        for sent in sents:
            stripped = sent.text.strip()
            start = sent.start_char + (len(sent.text) - len(sent.text.lstrip()))
            findings.append(
                Finding(
                    category=spec.category,
                    severity=spec.level,
                    source=Source.RULE,
                    rule_id=rule.rule_id,
                    message=spec.message,
                    span=Span(start=start, end=start + len(stripped), text=stripped),
                )
            )
    return findings


def _classify(spec, matchers, default_name, sent) -> str | None:
    tokens = [t for t in sent if not t.is_space]
    while tokens and tokens[-1].pos_ in _TAIL_POS:
        tokens.pop()
    if not tokens:
        return None
    # Span-relative index of the last classification-relevant token
    # (Matcher called on a Span returns span-relative indices).
    last_kept = tokens[-1].i - sent.start
    for name, variant in spec.variants.items():
        matcher = matchers.get(name)
        if matcher is None:
            continue
        for _, _, match_end in matcher(sent):
            match_last = match_end - 1
            if variant.anchor == "end":
                if match_last <= last_kept and last_kept - match_last < _ANCHOR_WINDOW:
                    return name
            else:
                return name
    if default_name is not None and tokens[-1].pos_ in _PREDICATE_POS:
        return default_name
    return None
```

Register it in `backend/app/checkers/rules/checks/__init__.py`:

```python
from .consistency import check_consistency
...
CHECKS: dict[str, CheckFn] = {
    "existence": check_existence,
    "substitution": check_substitution,
    "occurrence": check_occurrence,
    "repetition": check_repetition,
    "token_pattern": check_token_pattern,
    "dependency": check_dependency,
    "consistency": check_consistency,
}
```

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_consistency.py -q` → 9 passed.
If a classification test fails, print the actual GiNZA analysis of the failing sentence (`for t in doc: print(t.text, t.lemma_, t.pos_)`) before touching the algorithm — the fix is usually in the test sentence, not the code, and precision beats recall (spec section 1).

- [ ] **Step 5: Full suite + commit**

Run: `uv run pytest tests/ -x -q` → green.

```bash
git add app/checkers/rules/checks/consistency.py app/checkers/rules/checks/__init__.py tests/test_consistency.py
git commit -m "feat: consistency check — variant classification, minority flagged

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: General JA grammar rules (ら抜き, さ入れ, 二重敬語 ×2)

**Files:**
- Create: `backend/rules/ja/grammar/ranuki.yml`
- Create: `backend/rules/ja/grammar/sa-ire.yml`
- Create: `backend/rules/ja/grammar/nijuu-keigo.yml`
- Create: `backend/rules/ja/grammar/nijuu-keigo-honorific.yml`

The catalog-wide example test (`tests/test_rule_examples.py`) IS the test for
this task — every `bad` sentence must make the rule fire, every `good`
sentence must stay clean. TDD here means: create the file, run the example
test for it, iterate until green.

- [ ] **Step 1: Create `backend/rules/ja/grammar/ranuki.yml`**

```yaml
# Demonstrates: GiNZA lemmatizes ら抜き potentials as their own lemma
# (見れます → LEMMA=見れる), so one lemma list catches every conjugation.
# Curated ichidan/kuru forms only — godan potentials (走れる) are legitimate.
extends: token_pattern
message: "「%s」はら抜き言葉です — 「られる」の形を使ってください（例:「見られる」）。"
level: warning
category: grammar
pattern:
  - {LEMMA: {IN: [見れる, 食べれる, 来れる, 出れる, 寝れる, 起きれる, 着れる, 降りれる, 決めれる, 信じれる, 覚えれる, 変えれる, 続けれる, 教えれる]}, POS: VERB}
examples:
  bad:
    - "この映画は家でも見れます。"
    - "朝早く起きれない。"
  good:
    - "この映画は家でも見られます。"
    - "彼はとても速く走れる。"
```

- [ ] **Step 2: Create `backend/rules/ja/grammar/sa-ire.yml`**

```yaml
# さ入れ言葉: godan causatives take せる, not させる. Curated godan stems —
# ichidan causatives (食べさせる) are legitimate, and the raw regex cannot
# hit legit サ変 causatives (発言させて tokenizes as 発言+さ+せ but the
# stem list only contains godan 未然形).
extends: existence
message: "「%s」はさ入れ言葉です — 五段動詞の使役は「せる」で作ります（例:「休ませて」）。"
level: warning
category: grammar
raw:
  - '(?:行か|読ま|書か|飲ま|休ま|待た|帰ら|取ら|作ら|置か|急が|払わ|歌わ|運ば)させ'
examples:
  bad:
    - "明日は休まさせていただきます。"
  good:
    - "明日は休ませていただきます。"
    - "子供に野菜を食べさせる。"
```

- [ ] **Step 3: Create `backend/rules/ja/grammar/nijuu-keigo.yml`**

```yaml
# 二重敬語「お/ご〜になられる」: curated raw list, NOT a token pattern —
# the bare shape に+なる+れる also matches 「社長になられました」, which is
# legitimate single 尊敬語 (plain なる + honorific られる). The お/ご
# prefix is the safe signal.
extends: existence
message: "「%s」は二重敬語です — 「お/ご〜になる」だけで十分な敬意を表せます。"
level: warning
category: grammar
raw:
  - 'ご覧になられ'
  - 'お読みになられ'
  - 'お越しになられ'
  - 'お帰りになられ'
  - 'お聞きになられ'
  - 'お会いになられ'
  - 'お使いになられ'
examples:
  bad:
    - "資料をご覧になられますか。"
  good:
    - "資料をご覧になりますか。"
    - "社長が新しい方針を話されました。"
```

- [ ] **Step 4: Create `backend/rules/ja/grammar/nijuu-keigo-honorific.yml`**

```yaml
# Demonstrates: token_pattern over honorific verb lemmas. These verbs ARE
# the 尊敬語, so stacking れる・られる doubles the honorific.
extends: token_pattern
message: "「%s」は二重敬語です — この動詞はそれ自体が敬語なので「れる・られる」は不要です。"
level: warning
category: grammar
pattern:
  - {LEMMA: {IN: [おっしゃる, なさる, いらっしゃる, 召し上がる, くださる]}}
  - {LEMMA: れる, POS: AUX}
examples:
  bad:
    - "先生がそうおっしゃられました。"
  good:
    - "先生がそうおっしゃいました。"
```

- [ ] **Step 5: Run the example tests for these rules**

```bash
uv run pytest tests/test_rule_examples.py -q -k "ranuki or ire or nijuu"
```

(Hyphens are operators in `-k` expressions — use hyphen-free substrings of
the rule ids.)

Expected: all pass (bad fires, good clean). On failure, probe the sentence:

```bash
uv run python -c "
import spacy
nlp = spacy.load('ja_ginza', config={'components': {'compound_splitter': {'split_mode': 'C'}}})
for t in nlp('FAILING SENTENCE HERE'):
    print(t.text, '|', t.lemma_, '|', t.pos_, '|', t.tag_)"
```

and adjust the pattern or the example — never delete the guard examples.

- [ ] **Step 6: Full suite + commit**

Run: `uv run pytest tests/ -x -q` → green (catalog count assertions, if any, may need +4).

```bash
git add rules/ja/grammar/
git commit -m "feat: JA grammar rules — ら抜き, さ入れ, 二重敬語 ×2

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: General JA style/clarity rules (の連続, を行う, 重複, 冗長, 文体統一)

**Files:**
- Create: `backend/rules/ja/clarity/no-renzoku.yml`
- Create: `backend/rules/ja/style/wo-okonau.yml`
- Create: `backend/rules/ja/style/juufuku-hyougen.yml`
- Create: `backend/rules/ja/style/redundant-phrases.yml`
- Create: `backend/rules/ja/style/desu-masu.yml`

- [ ] **Step 1: Create `backend/rules/ja/clarity/no-renzoku.yml`**

```yaml
# Demonstrates: POS chains — three or more genitive の in a row bury the
# head noun. First slot deliberately NOUN (not PRON): keeps the pattern
# simple; a PRON head still leaves three NOUN-の links to fire on.
extends: token_pattern
message: "「%s」—「の」が3回以上連続しています。語順の変更や複合語で整理してください。"
level: suggestion
category: clarity
pattern:
  - {POS: NOUN}
  - {TEXT: の}
  - {POS: NOUN}
  - {TEXT: の}
  - {POS: NOUN}
  - {TEXT: の}
  - {POS: NOUN}
examples:
  bad:
    - "友達の会社の製品の品質が良い。"
  good:
    - "友達の会社が作る製品は品質が良い。"
```

- [ ] **Step 2: Create `backend/rules/ja/style/wo-okonau.yml`**

```yaml
# Demonstrates: matching on UniDic TAG — サ変 nouns carry
# 名詞-普通名詞-サ変可能, so 「検討を行う」 can just be 「検討する」.
extends: token_pattern
message: "「%s」は回りくどい表現です — 「〜する」と直接書けます（例:「検討する」）。"
level: suggestion
category: style
pattern:
  - {TAG: 名詞-普通名詞-サ変可能}
  - {TEXT: を}
  - {LEMMA: 行う}
examples:
  bad:
    - "来週までに検討を行います。"
  good:
    - "来週までに検討します。"
```

- [ ] **Step 3: Create `backend/rules/ja/style/juufuku-hyougen.yml`**

```yaml
# Redundant doublings (重複表現). Keys are CJK-edged, so they rely on the
# edge-aware boundary handling in the substitution check.
extends: substitution
message: "「%s」で十分です —「%s」は重複表現です。"
level: warning
category: style
swap:
  一番最初: 最初
  一番最後: 最後
  後で後悔: 後悔
  違和感を感じ: 違和感を覚え
  過半数を超え: 半数を超え
  まだ未定: 未定
  必ず必要: 必要
examples:
  bad:
    - "一番最初に結論を書きます。"
    - "その説明には違和感を感じました。"
  good:
    - "最初に結論を書きます。"
    - "その説明には違和感を覚えました。"
```

- [ ] **Step 4: Create `backend/rules/ja/style/redundant-phrases.yml`**

```yaml
# Fixed-string 冗長表現 that the token-level redundant-potential rule does
# not reach (可能です is not できる).
extends: substitution
message: "「%s」と簡潔に書けます —「%s」は冗長です。"
level: suggestion
category: style
swap:
  することが可能です: できます
  することができません: できません
  という結果になりました: という結果でした
examples:
  bad:
    - "この機能を利用することが可能です。"
  good:
    - "この機能を利用できます。"
```

- [ ] **Step 5: Create `backend/rules/ja/style/desu-masu.yml`**

```yaml
# Demonstrates: the consistency check type. Sentences are classified as
# 敬体 (polite, sentence-final です/ます) or 常体 (plain — the default
# variant: any other predicate ending). Minority sentences get flagged;
# polite is declared first, so it wins a 50/50 tie. Headings and 体言止め
# are unclassified. Bad examples must mix styles, so they are
# multi-sentence strings.
extends: consistency
message: "文体が混在しています — 敬体（です・ます）と常体（だ・である）のどちらかに統一してください。"
level: warning
category: style
variants:
  polite:
    pattern:
      - {LEMMA: {IN: [です, ます]}, POS: AUX}
    anchor: end
  plain:
    default: true
examples:
  bad:
    - "本製品は高速です。設定も簡単だ。導入も容易です。"
  good:
    - "本製品は高速です。設定も簡単です。"
    - "本製品は高速だ。設定も簡単である。"
```

- [ ] **Step 6: Run the example tests**

```bash
uv run pytest tests/test_rule_examples.py -q -k "renzoku or okonau or juufuku or redundant or desu"
```

Expected: pass. Probe failures with the GiNZA one-liner from Task 4 Step 5.

- [ ] **Step 7: Full suite + commit**

Run: `uv run pytest tests/ -x -q` → green.

```bash
git add rules/ja/clarity/ rules/ja/style/
git commit -m "feat: JA style/clarity rules — の連続, を行う, 重複, 冗長, 文体統一

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: JA pack rules (marketing ×3, techdocs ×3, blog ×1)

**Files:**
- Create: `backend/rules/ja/style/hype-words.yml`
- Create: `backend/rules/ja/style/unverifiable-claims.yml`
- Create: `backend/rules/ja/style/exclamation-inflation.yml`
- Create: `backend/rules/ja/style/i-nuki.yml`
- Create: `backend/rules/ja/style/hedging.yml`
- Create: `backend/rules/ja/style/casual-contractions.yml`
- Create: `backend/rules/ja/style/kotatsu-cliche.yml`

Note: the example-test harness enables each rule's own pack automatically
(`RuleConfig(packs_on=[rule.spec.pack])`), so pack rules test exactly like
general ones.

- [ ] **Step 1: Create `backend/rules/ja/style/hype-words.yml`**

```yaml
extends: existence
message: "「%s」は誇張表現です — 具体的な利点や数字で示してください。"
level: suggestion
category: style
pack: marketing
tokens: [究極, 最強, 絶対, 圧倒的, 爆速, 革命的, 神レベル, 異次元]
examples:
  bad:
    - "究極の使いやすさを実現した最強のアプリです。"
  good:
    - "起動時間を50%短縮した使いやすいアプリです。"
```

- [ ] **Step 2: Create `backend/rules/ja/style/unverifiable-claims.yml`**

```yaml
# Mixed-width claims (業界No.1) as raw: a Latin-digit edge would demand a
# \b before following kana, which never matches — raw patterns skip the
# boundary wrapping entirely.
extends: existence
message: "「%s」— 根拠を示せない優位性の主張は景品表示法上のリスクがあります。出典や条件を添えてください。"
level: warning
category: style
pack: marketing
tokens: [日本一, 世界一, 世界初, 国内初, 業界初]
raw:
  - '業界No\.?1'
  - '満足度No\.?1'
  - '売上No\.?1'
examples:
  bad:
    - "業界No.1の性能を誇る、日本一のサービスです。"
  good:
    - "2025年のABC調査で最高評価を獲得したサービスです。"
```

- [ ] **Step 3: Create `backend/rules/ja/style/exclamation-inflation.yml`**

```yaml
extends: existence
message: "感嘆符の連続は逆効果です — 1つで十分です。"
level: suggestion
category: style
pack: marketing
raw:
  - '[！!]{2,}'
examples:
  bad:
    - "今すぐダウンロード！！"
  good:
    - "今すぐダウンロード！"
```

- [ ] **Step 4: Create `backend/rules/ja/style/i-nuki.yml`**

```yaml
# Demonstrates: い抜き contractions surface as AUX tokens with their own
# lemma (してる → し+てる/AUX, 読んでる → 読ん+でる/AUX). The verb 出る is
# POS=VERB, never AUX, so it cannot false-positive here.
extends: token_pattern
message: "「%s」はい抜き言葉です — 技術文書では「〜ている」と書いてください。"
level: warning
category: style
pack: techdocs
pattern:
  - {LEMMA: {IN: [てる, でる]}, POS: AUX}
examples:
  bad:
    - "サーバーが動いてるか確認します。"
  good:
    - "サーバーが動いているか確認します。"
    - "会議室から出るところです。"
```

- [ ] **Step 5: Create `backend/rules/ja/style/hedging.yml`**

```yaml
extends: token_pattern
message: "「%s」— 技術文書では推測ではなく事実を書いてください。確信が持てない場合は条件を明記します。"
level: warning
category: style
pack: techdocs
pattern:
  - {TEXT: と}
  - {LEMMA: 思う}
examples:
  bad:
    - "この設定で動作すると思います。"
  good:
    - "この設定で動作します。"
```

- [ ] **Step 6: Create `backend/rules/ja/style/casual-contractions.yml`**

```yaml
# ちゃう/とく contractions of てしまう/ておく (probed: しちゃった →
# ちゃっ/AUX/LEMMA=ちゃう, やっとく → とく/AUX/LEMMA=とく). じゃう/どく
# are the rendaku twins after ん/び/み stems.
extends: token_pattern
message: "「%s」は話し言葉の縮約形です — 技術文書では「〜てしまう」「〜ておく」と書いてください。"
level: warning
category: style
pack: techdocs
pattern:
  - {LEMMA: {IN: [ちゃう, じゃう, とく, どく]}, POS: AUX}
examples:
  bad:
    - "設定を保存しとくと便利です。"
    - "ファイルを消しちゃった場合の復元手順です。"
  good:
    - "設定を保存しておくと便利です。"
```

- [ ] **Step 7: Create `backend/rules/ja/style/kotatsu-cliche.yml`**

```yaml
extends: existence
message: "「%s」は定型フレーズです — 記事の内容に基づいた具体的な導入・締めくくりを書きましょう。"
level: suggestion
category: style
pack: blog
tokens: [いかがでしたか, いかがだったでしょうか, 個人的な意見ですが, あくまで個人の感想です]
examples:
  bad:
    - "新しいカメラの使い心地、いかがでしたか。"
  good:
    - "新しいカメラは暗所撮影で真価を発揮しました。"
```

- [ ] **Step 8: Run the example tests**

```bash
uv run pytest tests/test_rule_examples.py -q -k "hype or unverifiable or exclamation or nuki or hedging or casual or kotatsu"
```

Careful: `-k` matches EN rules with the same names too (en:style.hype-words
etc.) — those must stay green as well; do not scope the filter to ja only.

- [ ] **Step 9: Full suite + commit**

Run: `uv run pytest tests/ -x -q` → green.

```bash
git add rules/ja/style/
git commit -m "feat: JA pack rules — marketing, techdocs, blog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Blog profile for JA + demo texts

**Files:**
- Modify: `backend/app/services/seed_profiles.py:12` (BLOG_LANGUAGES) and `:49` (_BLOG_INSTRUCTIONS)
- Create: `backend/demos/ja-blog.txt`
- Modify: `backend/demos/ja-marketing.txt` (append)
- Modify: `backend/demos/ja-technical-documentation.txt` (append)
- Test: `backend/tests/test_profiles.py:172-184` (`test_seed_pack_profiles`)

- [ ] **Step 1: Flip the existing assertion (failing test)**

`tests/test_profiles.py::test_seed_pack_profiles` currently ends with:

```python
    # Japanese keeps Marketing/TechDoc (packs are no-ops there for now), no Blog.
    ja = {p.name: p for p in store.list_profiles(Language.JA)}
    assert "Blog" not in ja
```

Replace those three lines with:

```python
    ja = {p.name: p for p in store.list_profiles(Language.JA)}
    assert ja["Blog"].packs_on == ["blog"]
    assert ja["Blog"].llm_instructions
    assert "いかがでしたか" in ja["Blog"].example_text
```

Run: `uv run pytest tests/test_profiles.py::test_seed_pack_profiles -q` →
FAILS with `KeyError: 'Blog'` (JA not in `BLOG_LANGUAGES`).

- [ ] **Step 2: Implement in `seed_profiles.py`**

```python
BLOG_LANGUAGES = {Language.EN, Language.DE, Language.JA}
```

Add to `_BLOG_INSTRUCTIONS`:

```python
    Language.JA: (
        "対象読者:ブログ読者。個人的だが引き締まった文体を推奨。抽象論より"
        "具体例、短い段落。決まり文句の導入・締めくくり、脱線、根拠のない"
        "一般化を指摘すること。"
    ),
```

- [ ] **Step 3: Create `backend/demos/ja-blog.txt`**

Write a short (~3 paragraphs) Japanese blog post that triggers the new
rules — it must contain: いかがでしたか (kotatsu-cliche), a ら抜き form
(見れます), an い抜き form is NOT needed (techdocs pack is off in Blog), and
a mixed 敬体/常体 paragraph (desu-masu). Suggested content:

```text
新しいミラーレスカメラを1か月使ってみた

新しいカメラを買いました。店頭で触った瞬間、これだと思いました。持ち帰って最初に驚いたのは起動の速さだ。電源を入れてから撮影できるまで、ほとんど待ち時間がありません。

夜の撮影も試しました。暗い居酒屋でもノイズの少ない写真が撮れて、細部まで見れます。一番最初に撮った一枚は、今でもお気に入りです。

新しいカメラの使い心地、いかがでしたか。次回はレンズ選びについて書きます。
```

(This text intentionally trips: desu-masu — 「驚いたのは起動の速さだ。」 amid
polite sentences; ranuki — 見れます; juufuku — 一番最初; kotatsu-cliche —
いかがでしたか.)

- [ ] **Step 4: Append pack fodder to the existing JA demos**

Append to `backend/demos/ja-marketing.txt` (keep existing content, add a
paragraph):

```text

究極のパフォーマンスを体験してください！！業界No.1の処理速度と圧倒的な使いやすさで、あなたの仕事を変えます。
```

Append to `backend/demos/ja-technical-documentation.txt`:

```text

サービスが起動してるか確認します。設定ファイルは事前にバックアップしとくと安全だと思います。
```

- [ ] **Step 5: Run seeding tests + full suite**

Run: `uv run pytest tests/test_profiles.py tests/ -q` → green.
Note: on the developer's live install the JA seed marker is already set, so
the JA Blog profile only appears on fresh databases — spec-sanctioned, do
not add migration logic.

- [ ] **Step 6: Commit**

```bash
git add app/services/seed_profiles.py demos/ tests/test_profiles.py
git commit -m "feat: seed JA Blog profile and pack-triggering demo texts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Documentation + final verification

**Files:**
- Modify: `backend/rules/README.md`
- Modify: `docs/backend-architecture.md`
- Modify: `docs/LOGBOOK.md` (append)

- [ ] **Step 1: Update `backend/rules/README.md`**

Read the file first; it has a check-type cookbook and a catalog table with a
Pack column. Add:

1. A **consistency** section to the cookbook, after the occurrence/
   token_pattern sections, documenting: variant semantics (first matching
   pattern-variant claims the sentence, declaration order = priority),
   `anchor: end` (match must end within the last 3 tokens after stripping
   trailing punctuation/symbols/final particles), the single optional
   `default: true` variant (claims sentences ending in VERB/ADJ/AUX that no
   pattern matched), minority flagging with tie-break by declaration order,
   and the multi-sentence `bad` example requirement. Include the desu-masu
   YAML as the cookbook example.
2. 16 new rows in the JA section of the catalog table (rule id, type,
   level, pack, one-line description) matching the files from Tasks 4–6.
3. New entries under "Known heuristic limitations": curated-list recall for
   ら抜き/さ入れ/二重敬語 (only listed forms are caught); 文体統一 counts a
   quoted polite sentence as polite when the quote sits at the very end of
   the sentence; hype/claim word lists are precision-first and extendable.
4. Mention in the intro paragraph on boundary handling (if the README has
   one) or in the existence/substitution sections: CJK-edged tokens/keys
   are matched without `\b` anchoring (edge-aware since phase 2).

- [ ] **Step 2: Update `docs/backend-architecture.md`**

Read the rule-engine section and add: the `consistency` check type (document-
scoped, variant classification, minority flagging), `VariantSpec`, and the
CJK edge-aware `bounded_pattern` helper shared by existence/substitution.
Follow the document's existing level of detail — a short paragraph each, not
a re-specification.

- [ ] **Step 3: Append the work summary to `docs/LOGBOOK.md`**

Follow the file's existing entry format (date heading + summary + commit
pointers). Summarize: consistency check type, CJK boundary fix, 16 JA rules,
JA Blog profile, demos, docs; reference the spec and plan files and the
commit range.

- [ ] **Step 4: Full verification**

```bash
uv run pytest tests/ -q
```

Expected: entire backend suite green. Report the exact test count.

Then verify the catalog loads clean through the API surface:

```bash
uv run python -c "
from pathlib import Path
from app.checkers.rules.engine import RuleEngine
e = RuleEngine(Path('rules'))
print('errors:', e.errors)
ja = [r for r in e.list_rules() if r.language.value == 'ja']
print('ja rules:', len(ja))
print('ja packs:', sorted({r.spec.pack for r in ja if r.spec.pack}))"
```

Expected: `errors: []`, `ja rules: 21` (5 existing + 16 new), `ja packs: ['blog', 'marketing', 'techdocs']`.

- [ ] **Step 5: Commit and push**

```bash
git add backend/rules/README.md docs/
git commit -m "docs: JA rules, consistency check type, CJK boundary notes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

(Push from the repo root; all task commits ride along.)
