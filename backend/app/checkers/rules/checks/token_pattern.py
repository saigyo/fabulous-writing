from app.core.models import Finding, Source, Span

from ..context import CheckContext
from ..loader import LoadedRule
from ..text import format_message


def check_token_pattern(rule: LoadedRule, ctx: CheckContext) -> list[Finding]:
    if ctx.doc is None:
        return []
    from spacy.matcher import Matcher

    matcher = Matcher(ctx.doc.vocab)
    matcher.add(rule.rule_id, [rule.spec.pattern], greedy="LONGEST")
    findings: list[Finding] = []
    for _, start, end in matcher(ctx.doc):
        span = ctx.doc[start:end]
        findings.append(
            Finding(
                category=rule.spec.category,
                severity=rule.spec.level,
                source=Source.RULE,
                rule_id=rule.rule_id,
                message=format_message(rule.spec.message, span.text),
                span=Span(start=span.start_char, end=span.end_char, text=span.text),
                suggestions=list(rule.spec.suggestions),
            )
        )
    return findings
