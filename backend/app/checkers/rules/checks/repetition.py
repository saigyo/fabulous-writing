import re

from app.core.models import Finding, Source, Span

from ..context import CheckContext
from ..loader import LoadedRule
from ..text import format_message

_REPEATED_WORD = r"\b(?P<word>\w+)(?:\s+(?P=word))+\b"


def check_repetition(rule: LoadedRule, ctx: CheckContext) -> list[Finding]:
    spec = rule.spec
    flags = re.IGNORECASE if spec.ignorecase else 0
    findings: list[Finding] = []
    for match in re.finditer(_REPEATED_WORD, ctx.text, flags):
        word = match.group("word")
        findings.append(
            Finding(
                category=spec.category,
                severity=spec.level,
                source=Source.RULE,
                rule_id=rule.rule_id,
                message=format_message(spec.message, word),
                span=Span(start=match.start(), end=match.end(), text=match.group()),
                suggestions=[word],
            )
        )
    return findings
