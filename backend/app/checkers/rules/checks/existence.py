import re

from app.core.models import Finding, Source, Span

from ..context import CheckContext
from ..loader import LoadedRule
from ..text import bounded_pattern, format_message


def check_existence(rule: LoadedRule, ctx: CheckContext) -> list[Finding]:
    spec = rule.spec
    flags = re.IGNORECASE if spec.ignorecase else 0
    patterns = [bounded_pattern(token) for token in spec.tokens] + list(spec.raw)
    findings: list[Finding] = []
    for pattern in patterns:
        for match in re.finditer(pattern, ctx.text, flags):
            findings.append(
                Finding(
                    category=spec.category,
                    severity=spec.level,
                    source=Source.RULE,
                    rule_id=rule.rule_id,
                    message=format_message(spec.message, match.group()),
                    span=Span(start=match.start(), end=match.end(), text=match.group()),
                )
            )
    return findings
