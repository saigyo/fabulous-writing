import re

from app.core.models import Finding, Source, Span

from ..loader import LoadedRule
from ..text import split_sentences


def check_occurrence(rule: LoadedRule, text: str) -> list[Finding]:
    spec = rule.spec
    assert spec.token is not None
    flags = re.IGNORECASE if spec.ignorecase else 0
    pattern = re.compile(spec.token, flags)
    findings: list[Finding] = []
    for start, end, sentence in split_sentences(text):
        count = len(pattern.findall(sentence))
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
