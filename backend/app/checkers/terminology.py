import re

from app.core.models import Category, Finding, Language, Severity, Source, Span
from app.services.terminology import TerminologyStore


class TerminologyChecker:
    def __init__(self, store: TerminologyStore) -> None:
        self.store = store

    def check(self, text: str, language: Language, domain_id: int) -> list[Finding]:
        findings: list[Finding] = []
        for term in self.store.list_terms(domain_id, language=language):
            flags = 0 if term.case_sensitive else re.IGNORECASE
            for variant in term.forbidden_variants:
                pattern = rf"\b{re.escape(variant)}\b"
                for match in re.finditer(pattern, text, flags):
                    message = f"Use '{term.preferred}' instead of '{match.group()}'."
                    if term.definition:
                        message += f" {term.definition}"
                    findings.append(
                        Finding(
                            category=Category.TERMINOLOGY,
                            severity=Severity.ERROR,
                            source=Source.TERMINOLOGY,
                            rule_id=f"terminology.{term.id}",
                            message=message,
                            span=Span(
                                start=match.start(), end=match.end(), text=match.group()
                            ),
                            suggestions=[term.preferred],
                        )
                    )
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings
