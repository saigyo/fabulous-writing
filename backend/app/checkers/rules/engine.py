from pathlib import Path

from app.core.models import Finding, Language

from .checks import CHECKS
from .context import CheckContext
from .loader import LoadedRule, RuleError, load_rules


class RuleEngine:
    def __init__(self, rules_dir: Path) -> None:
        self.rules_dir = rules_dir
        self._rules: list[LoadedRule] = []
        self._errors: list[RuleError] = []
        self.reload()

    def reload(self) -> None:
        self._rules, self._errors = load_rules(self.rules_dir)

    @property
    def errors(self) -> list[RuleError]:
        return self._errors

    def list_rules(self) -> list[LoadedRule]:
        return list(self._rules)

    def nlp_rule_ids(self, language: Language) -> list[str]:
        """Rule ids that need a spaCy doc and are skipped without one."""
        from .loader import rule_requires_doc

        return [
            rule.rule_id
            for rule in self._rules
            if rule.language == language and rule_requires_doc(rule.spec)
        ]

    def check(
        self, text: str, language: Language, doc: object | None = None
    ) -> list[Finding]:
        ctx = CheckContext(text=text, doc=doc)
        findings: list[Finding] = []
        for rule in self._rules:
            if rule.language != language:
                continue
            findings.extend(CHECKS[rule.spec.extends](rule, ctx))
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings
