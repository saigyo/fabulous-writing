import asyncio
import logging
import os
from typing import Any

from fastapi import APIRouter, Depends, Request

from app.api.deps import CurrentUser, get_current_user
from app.checkers.llm import bedrock
from app.checkers.llm.claude import ClaudeProvider
from app.checkers.llm.ollama import OllamaProvider
from app.checkers.llm.openai_compat import OpenAICompatProvider
from app.core.config import BUILTIN_ENV_KEYS, ProviderSettings
from app.core.permissions import policy_for

router = APIRouter(prefix="/api", tags=["providers"])

logger = logging.getLogger(__name__)

# Model ids the OpenAI /models listing returns that are not chat models.
OPENAI_EXCLUDED_MODEL_FRAGMENTS = (
    "embedding",
    "whisper",
    "tts",
    "dall-e",
    "moderation",
    "audio",
    "realtime",
    "image",
    "transcribe",
    "babbage",
    "davinci",
)

_DISCOVERY_TIMEOUT = 5.0


def _entry(
    name: str, available: bool, models: list[str], default_model: str
) -> dict[str, Any]:
    # If the configured default is not in the live list, point clients at
    # one that is.
    if models and default_model not in models:
        default_model = models[0]
    return {
        "name": name,
        "available": available,
        "models": models,
        "default_model": default_model,
    }


async def _ollama_entry(settings: ProviderSettings) -> dict[str, Any]:
    provider = OllamaProvider(
        base_url=settings.ollama_base_url, model=settings.ollama_model
    )
    try:
        async with asyncio.timeout(_DISCOVERY_TIMEOUT):
            models = await provider.list_models()
        return _entry("ollama", True, models, settings.ollama_model)
    except Exception as exc:
        logger.info("ollama discovery failed: %s", exc)
        return _entry("ollama", False, [], settings.ollama_model)


async def _openai_compat_entry(
    name: str,
    env_key: str,
    base_url: str,
    default_model: str,
    exclude_models: tuple[str, ...] = (),
) -> dict[str, Any]:
    api_key = os.environ.get(env_key)
    if not api_key:
        return _entry(name, False, [default_model], default_model)
    provider = OpenAICompatProvider(
        name=name,
        base_url=base_url,
        api_key=api_key,
        model=default_model,
        exclude_models=exclude_models,
    )
    try:
        async with asyncio.timeout(_DISCOVERY_TIMEOUT):
            models = await provider.list_models()
    except Exception as exc:
        logger.info("%s discovery failed: %s", name, exc)
        # Key is set but discovery failed — still usable with the default.
        models = [default_model]
    return _entry(name, True, models, default_model)


async def _claude_entry(settings: ProviderSettings) -> dict[str, Any]:
    if not os.environ.get(BUILTIN_ENV_KEYS["claude"]):
        return _entry(
            "claude", False, [settings.anthropic_model], settings.anthropic_model
        )
    provider = ClaudeProvider(model=settings.anthropic_model)
    try:
        async with asyncio.timeout(_DISCOVERY_TIMEOUT):
            models = await provider.list_models()
    except Exception as exc:
        logger.info("claude discovery failed: %s", exc)
        # Key is set but discovery failed — still usable with the default.
        models = [settings.anthropic_model]
    return _entry("claude", True, models, settings.anthropic_model)


async def _bedrock_entry(settings: ProviderSettings) -> dict[str, Any]:
    available = await asyncio.to_thread(bedrock.credentials_available)
    if not available:
        return _entry("bedrock", False, [settings.bedrock_model], settings.bedrock_model)
    models = settings.bedrock_models
    if not models:
        try:
            async with asyncio.timeout(_DISCOVERY_TIMEOUT):
                models = await asyncio.to_thread(
                    bedrock.discover_models, settings.bedrock_region
                )
        except Exception as exc:
            logger.info("bedrock discovery failed: %s", exc)
            models = [settings.bedrock_model]
    return _entry("bedrock", True, models, settings.bedrock_model)


@router.get("/providers")
async def list_providers(
    request: Request, user: CurrentUser = Depends(get_current_user)
) -> list[dict[str, Any]]:
    settings = request.app.state.settings.providers
    entries = [
        _ollama_entry(settings),
        _claude_entry(settings),
        _openai_compat_entry(
            "openai",
            BUILTIN_ENV_KEYS["openai"],
            settings.openai_base_url,
            settings.openai_model,
            OPENAI_EXCLUDED_MODEL_FRAGMENTS,
        ),
        _openai_compat_entry(
            "mistral",
            BUILTIN_ENV_KEYS["mistral"],
            settings.mistral_base_url,
            settings.mistral_model,
        ),
        _bedrock_entry(settings),
    ]
    entries += [
        _openai_compat_entry(
            name,
            f"{name.upper()}_API_KEY",
            extra.base_url,
            extra.default_model,
            tuple(extra.exclude_model_fragments),
        )
        for name, extra in settings.extra_providers.items()
    ]
    policy = policy_for(
        tier=user.tier, is_admin=user.is_admin, settings=request.app.state.settings
    )
    results = list(await asyncio.gather(*entries))
    for entry in results:
        # 'allowed' means allowed for DIRECT selection (spec §7.2): a
        # provider outside llm.providers can still serve a routed
        # quality-tier run (§6.2 rule 5).
        entry["allowed"] = policy.providers is None or entry["name"] in policy.providers
    return results
