import asyncio
import logging
import os
from typing import Any

from fastapi import APIRouter, Request

from app.checkers.llm import bedrock
from app.checkers.llm.ollama import OllamaProvider
from app.core.config import BUILTIN_ENV_KEYS, TIERS, ProviderSettings

router = APIRouter(prefix="/api", tags=["routing"])

logger = logging.getLogger(__name__)

_PING_TIMEOUT = 3.0


async def _provider_status(
    settings: ProviderSettings, name: str
) -> tuple[bool, str | None]:
    """Cheap availability check (no model discovery) with a human-readable reason."""
    if name == "ollama":
        provider = OllamaProvider(
            base_url=settings.ollama_base_url, model=settings.ollama_model
        )
        try:
            async with asyncio.timeout(_PING_TIMEOUT):
                await provider.list_models()
            return True, None
        except Exception as exc:
            logger.info("ollama ping failed: %s", exc)
            return False, "Ollama not running"
    if name == "bedrock":
        try:
            async with asyncio.timeout(_PING_TIMEOUT):
                available = await asyncio.to_thread(bedrock.credentials_available)
        except TimeoutError:
            available = False
        return (True, None) if available else (False, "AWS credentials not available")
    env_key = BUILTIN_ENV_KEYS.get(name)
    if env_key is None and name in settings.extra_providers:
        env_key = f"{name.upper()}_API_KEY"
    if env_key is None:
        return False, "provider not configured"
    if os.environ.get(env_key):
        return True, None
    return False, f"missing {env_key}"


@router.get("/routing")
async def get_routing(request: Request) -> dict[str, Any]:
    settings = request.app.state.settings
    routing = settings.routing
    names = sorted(
        {
            entry.provider
            for tiers in routing.languages.values()
            for entry in tiers.values()
        }
    )
    results = await asyncio.gather(
        *(_provider_status(settings.providers, name) for name in names)
    )
    status = dict(zip(names, results))
    languages = {
        lang: {
            tier: {
                "provider": entry.provider,
                "model": entry.model,
                "available": status[entry.provider][0],
                "reason": status[entry.provider][1],
            }
            for tier, entry in tiers.items()
        }
        for lang, tiers in routing.languages.items()
    }
    return {
        "default_tier": routing.default_tier,
        "tiers": list(TIERS),
        "languages": languages,
    }
