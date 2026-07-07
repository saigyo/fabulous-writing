from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.checkers.rules.loader import LoadedRule, RuleExamples, rule_requires_doc
from app.core.models import Language

router = APIRouter(prefix="/api", tags=["rules"])


class RuleInfo(BaseModel):
    """Catalog entry for one rule. (language, rule_id) is the stable identity
    that future features — enabling/disabling, checking profiles, custom
    rules — will reference."""

    rule_id: str
    language: str
    category: str
    level: str
    extends: str
    message: str
    requires_nlp: bool
    file: str
    detail: dict[str, Any]
    pack: str | None
    examples: RuleExamples


def _detail(rule: LoadedRule) -> dict[str, Any]:
    """The type-specific configuration, for display and (later) editing."""
    spec = rule.spec
    match spec.extends:
        case "existence":
            return {"tokens": spec.tokens, "raw": spec.raw, "ignorecase": spec.ignorecase}
        case "substitution":
            return {"swap": spec.swap, "ignorecase": spec.ignorecase}
        case "occurrence":
            return {
                "count": spec.count,
                "token": spec.token,
                "max": spec.max,
                "min": spec.min,
                "scope": spec.scope,
            }
        case "token_pattern" | "dependency":
            return {"pattern": spec.pattern, "suggestions": spec.suggestions}
        case _:  # repetition
            return {}


def _rule_info(rule: LoadedRule) -> RuleInfo:
    return RuleInfo(
        rule_id=rule.rule_id,
        language=rule.language.value,
        category=rule.spec.category.value,
        level=rule.spec.level.value,
        extends=rule.spec.extends,
        message=rule.spec.message,
        requires_nlp=rule_requires_doc(rule.spec),
        file=rule.file,
        detail=_detail(rule),
        pack=rule.spec.pack,
        examples=rule.spec.examples,
    )


def _payload(engine: Any, language: Language | None = None) -> dict[str, Any]:
    rules = engine.list_rules()
    if language is not None:
        rules = [rule for rule in rules if rule.language == language]
    return {
        "rules": [_rule_info(rule).model_dump() for rule in rules],
        "packs": sorted({rule.spec.pack for rule in rules if rule.spec.pack}),
        "errors": [error.model_dump() for error in engine.errors],
    }


@router.get("/rules")
def list_rules(request: Request, language: Language | None = None) -> dict[str, Any]:
    return _payload(request.app.state.rule_engine, language)


@router.post("/rules/reload")
def reload_rules(request: Request) -> dict[str, Any]:
    engine = request.app.state.rule_engine
    engine.reload()
    return _payload(engine)
