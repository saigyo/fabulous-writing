"""The single gate every LLM-invoking endpoint goes through (spec §7.2).

No route touches app.state.provider_factory directly: checks, suggestions
and document naming all resolve their selection here, so tier policy cannot
be bypassed. M5 extends this gate with the size cap and the quota/
concurrency reservation, in that order around resolve_llm_selection.
"""

import asyncio
from dataclasses import dataclass, replace

from fastapi import FastAPI, HTTPException

from app.api.deps import CurrentUser
from app.checkers.llm.provider import LLMProvider
from app.core.config import known_provider_names
from app.core.models import EffectiveLlmReport, LlmSelectionInfo
from app.core.permissions import (
    EffectiveSelection,
    RequestedLLM,
    limits_for,
    policy_for,
    resolve_llm_selection,
)
from app.services.usage import UsageStore


@dataclass
class LlmReservation:
    """Handle for an admitted run's ledger row (spec §5.3). finish() runs in
    the caller's finally block; UsageStore keeps it conditional, so a swept
    row is warned about, never resurrected."""

    store: UsageStore
    reservation_id: int

    def finish(
        self,
        status: str,
        *,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        fail_stage: str | None = None,
        fail_detail: str | None = None,
    ) -> None:
        self.store.finish_run(
            self.reservation_id,
            status,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            fail_stage=fail_stage,
            fail_detail=fail_detail,
        )


async def get_effective_provider(
    app: FastAPI,
    user: CurrentUser,
    requested: RequestedLLM,
    language: str,
    *,
    text_chars: int,
    source: str,
    run_id: str,
) -> tuple[EffectiveSelection, LLMProvider | None, LlmReservation | None]:
    """Resolve, construct, and reserve — the M5 order (spec §7.2): size cap
    -> resolve_llm_selection -> provider construction -> reservation. A
    (selection, None, None) return means the LLM phase is skipped and
    selection.skipped says why; an admitted run's reservation MUST be
    finished by the caller on every exit path. Concurrency rejections raise
    the documented 429 instead of returning (spec §6.6)."""
    settings = app.state.settings
    if (
        requested.tier is None
        and requested.provider is not None
        and requested.provider not in known_provider_names(settings.providers)
    ):
        # Direct requests only: with a tier set, provider/model are ignored
        # by contract (RequestedLLM), so an ignored field must not 422.
        raise HTTPException(422, f"Unknown LLM provider: {requested.provider}")
    limits = limits_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    if text_chars > limits.max_llm_document_chars:
        # Spec §6.5: the per-tier cap skips only the LLM phase, before any
        # resolution or spend — characters are the pre-spend token proxy.
        return (
            EffectiveSelection(
                tier=None, provider=None, model=None, degraded=False,
                skipped="document_too_large",
            ),
            None,
            None,
        )
    policy = policy_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    effective = resolve_llm_selection(policy, requested, language, settings=settings)
    if effective.provider is None:
        return effective, None, None
    try:
        provider = app.state.provider_factory(effective.provider, effective.model)
    except ValueError:
        # The routing table may point a tier at a provider this server has
        # not configured — that is "not configured", not a 500. Constructed
        # before reserving on purpose: a run that cannot even start never
        # consumes quota.
        return replace(effective, skipped="llm_unavailable"), None, None
    decision = app.state.usage_store.reserve_llm_run(
        user, limits, settings.limits, requested, effective,
        text_chars, source, run_id,
    )
    if decision.kind == "quota_exhausted":
        # Degrade, never 429: an exhausted allowance is not retryable until
        # tomorrow (spec §6.4).
        return replace(effective, skipped="quota_exhausted"), None, None
    if decision.kind == "concurrency_rejected":
        if not decision.server_wide:
            # Backpressure (spec §6.6): non-blocking, after the reservation
            # transaction rolled back, small and fixed. Server-wide
            # rejections answer immediately — holding the connection longer
            # would add to exactly the pressure that cap relieves.
            await asyncio.sleep(settings.limits.concurrency_reject_delay)
        raise HTTPException(
            429,
            "Too many concurrent LLM runs; try again shortly.",
            headers={"Retry-After": str(decision.retry_after)},
        )
    assert decision.reservation_id is not None
    return (
        effective,
        provider,
        LlmReservation(app.state.usage_store, decision.reservation_id),
    )


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
