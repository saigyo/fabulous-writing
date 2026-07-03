import os
from typing import Any

from fastapi import APIRouter, Request

from app.checkers.llm.ollama import OllamaProvider

router = APIRouter(prefix="/api", tags=["providers"])


@router.get("/providers")
async def list_providers(request: Request) -> list[dict[str, Any]]:
    settings = request.app.state.settings.providers
    ollama = OllamaProvider(
        base_url=settings.ollama_base_url, model=settings.ollama_model
    )
    try:
        models = await ollama.list_models()
        ollama_available = True
    except Exception:
        models = []
        ollama_available = False
    return [
        {
            "name": "ollama",
            "available": ollama_available,
            "models": models,
            "default_model": settings.ollama_model,
        },
        {
            "name": "claude",
            "available": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "models": [settings.anthropic_model],
            "default_model": settings.anthropic_model,
        },
    ]
