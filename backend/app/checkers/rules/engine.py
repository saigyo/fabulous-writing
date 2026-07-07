from pathlib import Path

from pydantic import BaseModel, Field

from app.core.models import Finding, Language

from .checks import CHECKS
from .context import CheckContext
from .loader import LoadedRule, RuleError, load_rules


class RuleConfig(BaseModel):
    """Profile rule selection: category toggles, pack opt-ins, per-rule
    exceptions.

    A general rule is active iff (category not off) XOR (rule id in
    exceptions). A pack rule additionally needs its pack in packs_on:
    (pack on AND category on) XOR exception — so exceptions can opt out of
    one rule of an enabled pack, or cherry-pick one rule without the pack.
    """

    categories_off: list[str] = Field(default_factory=list)
    exceptions: list[str] = Field(default_factory=list)
    packs_on: list[str] = Field(default_factory=list)

    def is_active(self, category: str, rule_id: str, pack: str | None = None) -> bool:
        base = category not in self.categories_off
        if pack is not None:
            base = base and pack in self.packs_on
        return base != (rule_id in self.exceptions)


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
        self,
        text: str,
        language: Language,
        doc: object | None = None,
        config: RuleConfig | None = None,
    ) -> list[Finding]:
        cfg = config if config is not None else RuleConfig()
        ctx = CheckContext(text=text, doc=doc)
        findings: list[Finding] = []
        for rule in self._rules:
            if rule.language != language:
                continue
            if not cfg.is_active(
                rule.spec.category.value, rule.rule_id, rule.spec.pack
            ):
                continue
            findings.extend(CHECKS[rule.spec.extends](rule, ctx))
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings
