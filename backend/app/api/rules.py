from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api", tags=["rules"])


def _payload(engine: Any) -> dict[str, Any]:
    return {
        "rules": [
            {
                "rule_id": rule.rule_id,
                "language": rule.language.value,
                "category": rule.spec.category.value,
                "level": rule.spec.level.value,
                "extends": rule.spec.extends,
                "message": rule.spec.message,
                "file": rule.file,
            }
            for rule in engine.list_rules()
        ],
        "errors": [error.model_dump() for error in engine.errors],
    }


@router.get("/rules")
def list_rules(request: Request) -> dict[str, Any]:
    return _payload(request.app.state.rule_engine)


@router.post("/rules/reload")
def reload_rules(request: Request) -> dict[str, Any]:
    engine = request.app.state.rule_engine
    engine.reload()
    return _payload(engine)
