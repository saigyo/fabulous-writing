from app.core.models import Finding, Source, Span

from ..context import CheckContext
from ..loader import LoadedRule
from ..text import format_message


def check_dependency(rule: LoadedRule, ctx: CheckContext) -> list[Finding]:
    if ctx.doc is None:
        return []
    from spacy.matcher import DependencyMatcher

    matcher = DependencyMatcher(ctx.doc.vocab)
    matcher.add(rule.rule_id, [rule.spec.pattern])
    findings: list[Finding] = []
    for _, token_ids in matcher(ctx.doc):
        tokens = [ctx.doc[i] for i in token_ids]
        start = min(t.idx for t in tokens)
        end = max(t.idx + len(t.text) for t in tokens)
        matched = ctx.text[start:end]
        findings.append(
            Finding(
                category=rule.spec.category,
                severity=rule.spec.level,
                source=Source.RULE,
                rule_id=rule.rule_id,
                message=format_message(rule.spec.message, matched),
                span=Span(start=start, end=end, text=matched),
                suggestions=list(rule.spec.suggestions),
            )
        )
    return findings
