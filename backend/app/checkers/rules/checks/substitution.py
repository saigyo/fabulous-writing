import re

from app.core.models import Finding, Source, Span

from ..context import CheckContext
from ..loader import LoadedRule
from ..text import bounded_pattern, format_message


def check_substitution(rule: LoadedRule, ctx: CheckContext) -> list[Finding]:
    spec = rule.spec
    flags = re.IGNORECASE if spec.ignorecase else 0
    findings: list[Finding] = []
    for bad, good in spec.swap.items():
        for match in re.finditer(bounded_pattern(bad), ctx.text, flags):
            findings.append(
                Finding(
                    category=spec.category,
                    severity=spec.level,
                    source=Source.RULE,
                    rule_id=rule.rule_id,
                    message=format_message(spec.message, good, match.group()),
                    span=Span(start=match.start(), end=match.end(), text=match.group()),
                    suggestions=[good],
                )
            )
    return findings
