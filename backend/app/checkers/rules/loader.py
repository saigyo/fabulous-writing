from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, ValidationError, model_validator

from app.core.models import Category, Language, Severity

CheckType = Literal[
    "existence",
    "substitution",
    "occurrence",
    "repetition",
    "token_pattern",
    "dependency",
]

NLP_CHECK_TYPES = {"token_pattern", "dependency"}


class RuleSpec(BaseModel):
    extends: CheckType
    message: str
    level: Severity = Severity.WARNING
    category: Category
    ignorecase: bool = False
    # existence
    tokens: list[str] = Field(default_factory=list)
    raw: list[str] = Field(default_factory=list)
    # substitution
    swap: dict[str, str] = Field(default_factory=dict)
    # occurrence
    scope: Literal["sentence"] = "sentence"
    token: str | None = None
    max: int | None = None
    min: int | None = None
    # token_pattern / dependency (spaCy Matcher / DependencyMatcher patterns)
    pattern: list[dict] = Field(default_factory=list)
    # optional static suggestions (used by NLP rule types)
    suggestions: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_required_fields(self) -> "RuleSpec":
        if self.extends == "existence" and not (self.tokens or self.raw):
            raise ValueError("existence rules need 'tokens' or 'raw'")
        if self.extends == "substitution" and not self.swap:
            raise ValueError("substitution rules need 'swap'")
        if self.extends == "occurrence":
            if not self.token:
                raise ValueError("occurrence rules need 'token'")
            if self.max is None and self.min is None:
                raise ValueError("occurrence rules need 'max' or 'min'")
        if self.extends in NLP_CHECK_TYPES and not self.pattern:
            raise ValueError(f"{self.extends} rules need 'pattern'")
        return self


class LoadedRule(BaseModel):
    rule_id: str
    language: Language
    file: str
    spec: RuleSpec


class RuleError(BaseModel):
    file: str
    error: str


def _validate_nlp_pattern(spec: RuleSpec, language: Language) -> None:
    """Compile the pattern against a blank vocab so bad attributes fail at load."""
    import spacy
    from spacy.matcher import DependencyMatcher, Matcher

    vocab = spacy.blank(language.value).vocab
    if spec.extends == "token_pattern":
        Matcher(vocab, validate=True).add("_", [spec.pattern])
    else:
        DependencyMatcher(vocab, validate=True).add("_", [spec.pattern])


def load_rules(rules_dir: Path) -> tuple[list[LoadedRule], list[RuleError]]:
    rules: list[LoadedRule] = []
    errors: list[RuleError] = []
    languages = {lang.value for lang in Language}
    for lang_dir in sorted(rules_dir.iterdir()) if rules_dir.is_dir() else []:
        if not lang_dir.is_dir() or lang_dir.name not in languages:
            continue
        language = Language(lang_dir.name)
        for path in sorted(lang_dir.rglob("*.yml")) + sorted(lang_dir.rglob("*.yaml")):
            try:
                data = yaml.safe_load(path.read_text(encoding="utf-8"))
                spec = RuleSpec.model_validate(data)
                if spec.extends in NLP_CHECK_TYPES:
                    _validate_nlp_pattern(spec, language)
            except Exception as exc:
                errors.append(RuleError(file=str(path), error=str(exc)))
                continue
            relative = path.relative_to(lang_dir).with_suffix("")
            rule_id = ".".join(relative.parts)
            rules.append(
                LoadedRule(rule_id=rule_id, language=language, file=str(path), spec=spec)
            )
    return rules, errors
