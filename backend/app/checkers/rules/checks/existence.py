import re

from app.core.models import Finding, Source, Span

from ..loader import LoadedRule
from ..text import format_message


def check_existence(rule: LoadedRule, text: str) -> list[Finding]:
    spec = rule.spec
    flags = re.IGNORECASE if spec.ignorecase else 0
    patterns = [rf"\b(?:{token})\b" for token in spec.tokens] + list(spec.raw)
    findings: list[Finding] = []
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags):
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
