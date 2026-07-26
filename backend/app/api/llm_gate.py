"""The single gate every LLM-invoking endpoint goes through (spec §7.2).

No route touches app.state.provider_factory directly: checks, suggestions
and document naming all resolve their selection here, so tier policy cannot
be bypassed. M5 extends this gate with the size cap and the quota/
concurrency reservation, in that order around resolve_llm_selection.
"""

from dataclasses import replace

from fastapi import FastAPI, HTTPException

from app.api.deps import CurrentUser
from app.checkers.llm.provider import LLMProvider
from app.core.config import known_provider_names
from app.core.models import EffectiveLlmReport, LlmSelectionInfo
from app.core.permissions import (
    EffectiveSelection,
    RequestedLLM,
    policy_for,
    resolve_llm_selection,
)


def get_effective_provider(
    app: FastAPI, user: CurrentUser, requested: RequestedLLM, language: str
) -> tuple[EffectiveSelection, LLMProvider | None]:
    """Resolve the caller's request against their policy and build the
    provider that will actually run. (selection, None) means the LLM phase
    is skipped — selection.skipped says why."""
    settings = app.state.settings
    if (
        requested.tier is None
        and requested.provider is not None
        and requested.provider not in known_provider_names(settings.providers)
    ):
        # Direct requests only: with a tier set, provider/model are ignored
        # by contract (RequestedLLM), so an ignored field must not 422.
        raise HTTPException(422, f"Unknown LLM provider: {requested.provider}")
    policy = policy_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    effective = resolve_llm_selection(policy, requested, language, settings=settings)
    if effective.provider is None:
        return effective, None
    try:
        provider = app.state.provider_factory(effective.provider, effective.model)
    except ValueError:
        # The routing table may point a tier at a provider this server has
        # not configured (the default table references optional extras as
        # configuration guidance) — that is "not configured", not a 500.
        return replace(effective, skipped="llm_unavailable"), None
    return effective, provider


def effective_llm_report(
    requested: RequestedLLM, effective: EffectiveSelection
) -> EffectiveLlmReport:
    return EffectiveLlmReport(
        requested=LlmSelectionInfo(
            tier=requested.tier, provider=requested.provider, model=requested.model
        ),
        effective=LlmSelectionInfo(
            tier=effective.tier, provider=effective.provider, model=effective.model
        ),
        degraded=effective.degraded,
        skipped=effective.skipped,
    )
