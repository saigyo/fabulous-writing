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
