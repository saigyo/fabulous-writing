import re

from app.core.models import Finding, Source, Span

from ..context import CheckContext
from ..loader import LoadedRule
from ..text import split_sentences


def check_occurrence(rule: LoadedRule, ctx: CheckContext) -> list[Finding]:
    spec = rule.spec
    if spec.count == "tokens":
        counter = _token_counter(ctx)
        if counter is None:  # NLP rule without a doc: skipped, reported upstream
            return []
    else:
        assert spec.token is not None
        flags = re.IGNORECASE if spec.ignorecase else 0
        pattern = re.compile(spec.token, flags)
        counter = lambda start, end, sentence: len(pattern.findall(sentence))  # noqa: E731
    findings: list[Finding] = []
    for start, end, sentence in split_sentences(ctx.text, doc=ctx.doc):
        count = counter(start, end, sentence)
        too_many = spec.max is not None and count > spec.max
        too_few = spec.min is not None and count < spec.min
        if too_many or too_few:
            findings.append(
                Finding(
                    category=spec.category,
                    severity=spec.level,
                    source=Source.RULE,
                    rule_id=rule.rule_id,
                    message=spec.message,
                    span=Span(start=start, end=end, text=sentence),
                )
            )
    return findings


def _token_counter(ctx: CheckContext):
    """Counts non-punctuation spaCy tokens inside a sentence span."""
    doc = ctx.doc
    if doc is None:
        return None

    def count_tokens(start: int, end: int, sentence: str) -> int:
        span = doc.char_span(start, end, alignment_mode="expand")
        if span is None:
            return 0
        return sum(1 for t in span if not t.is_punct and not t.is_space)

    return count_tokens
