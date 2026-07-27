import asyncio
import json
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, get_current_user
from app.api.llm_gate import LlmReservation, effective_llm_report, get_effective_provider
from app.checkers.llm.checker import LLMChecker
from app.checkers.llm.provider import LLMProvider
from app.checkers.pipeline import drop_duplicates
from app.checkers.rules.engine import RuleConfig
from app.checkers.terminology import TerminologyChecker
from app.core.models import EffectiveLlmReport, Finding, Language, QualityTier, Scorecard
from app.core.permissions import RequestedLLM
from app.services.jobs import CheckJob, JobsAtCapacity

router = APIRouter(prefix="/api", tags=["checks"])

logger = logging.getLogger(__name__)

CheckerName = Literal["rules", "terminology", "llm"]

# Emit llm_progress at most every N generated tokens (keeps SSE traffic low).
PROGRESS_TOKEN_STEP = 25


class CheckRequest(BaseModel):
    text: str
    language: Language
    domain_ids: list[int] = Field(default_factory=list)
    checkers: list[CheckerName] = Field(
        default_factory=lambda: ["rules", "terminology", "llm"]
    )
    rule_config: RuleConfig | None = None
    llm_tier: QualityTier | None = None
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_instructions: str = ""


class CheckStatus(BaseModel):
    check_id: str
    status: str
    findings: list[Finding]
    skipped_rules: list[str] = Field(default_factory=list)
    scorecard: Scorecard | None = None
    effective_llm: EffectiveLlmReport | None = None


@router.post("/checks", status_code=202)
async def create_check(
    request: Request,
    body: CheckRequest,
    user: CurrentUser = Depends(get_current_user),
) -> CheckStatus:
    app = request.app
    if len(body.text) > app.state.settings.limits.max_document_chars:
        raise HTTPException(
            413,
            f"Text exceeds the {app.state.settings.limits.max_document_chars}"
            " character limit",
        )

    try:
        job: CheckJob = app.state.jobs.create(user.id)
    except JobsAtCapacity as exc:
        raise HTTPException(429, "Too many checks in progress; try again shortly.") from exc

    try:
        if "rules" in body.checkers:
            doc = app.state.nlp.analyze(body.text, body.language.value)
            if doc is None:
                job.skipped_rules = app.state.rule_engine.nlp_rule_ids(body.language)
            findings = app.state.rule_engine.check(
                body.text, body.language, doc=doc, config=body.rule_config
            )
            job.add_findings("rules", findings)
        if "terminology" in body.checkers and body.domain_ids:
            checker = TerminologyChecker(app.state.terminology_store, nlp=app.state.nlp)
            findings: list[Finding] = []
            for domain_id in body.domain_ids:
                # A foreign or deleted domain id yields no findings: the
                # checker's store read is owner-scoped (spec §5.2), so there is
                # no id vetting to do here and no existence leak to cause.
                more = checker.check(body.text, body.language, domain_id, owner_id=user.id)
                findings.extend(drop_duplicates(more, findings))
            job.add_findings("terminology", findings)

        if "llm" in body.checkers:
            requested = RequestedLLM(
                tier=body.llm_tier, provider=body.llm_provider, model=body.llm_model
            )
            effective, provider, reservation = await get_effective_provider(
                app, user, requested, body.language.value,
                text_chars=len(body.text), source="check", run_id=job.id,
            )
            job.effective_llm = effective_llm_report(requested, effective)
            # On the stream too (spec §6.2): SSE consumers see the same block
            # the POST response carries.
            job.emit("effective_llm", job.effective_llm.model_dump(mode="json"))
            if provider is None:
                job.finish()
            else:
                assert reservation is not None
                job.attach_task(
                    asyncio.create_task(
                        _run_llm(
                            job,
                            provider,
                            body.text,
                            body.language,
                            reservation,
                            vet=app.state.settings.vet_suggestions,
                            dictionaries_dir=app.state.settings.dictionaries_dir,
                            instructions=body.llm_instructions,
                        )
                    )
                )
        else:
            job.finish()

        return CheckStatus(
            check_id=job.id,
            status=job.status,
            findings=job.findings,
            skipped_rules=job.skipped_rules,
            scorecard=job.scorecard,
            effective_llm=job.effective_llm,
        )
    except Exception:
        app.state.jobs.discard(job.id)
        raise


async def _run_llm(
    job: CheckJob,
    provider: LLMProvider,
    text: str,
    language: Language,
    reservation: LlmReservation,
    vet: bool = True,
    dictionaries_dir: Any = None,
    instructions: str = "",
) -> None:
    emitted = -PROGRESS_TOKEN_STEP  # the first report always goes out
    latest_tokens = 0

    def on_progress(tokens: int) -> None:
        nonlocal emitted, latest_tokens
        latest_tokens = tokens
        if tokens - emitted >= PROGRESS_TOKEN_STEP:
            emitted = tokens
            job.emit("llm_progress", {"tokens": tokens})

    # The terminal ledger write is the mechanism that releases this run's
    # concurrency slot (spec §5.3), so it must be exception-safe by
    # construction: success, failure and cancellation all pass through the
    # finally below, each with its own status.
    status = "completed"
    try:
        checker = LLMChecker(provider, vet=vet, dictionaries_dir=dictionaries_dir)
        result = await checker.check(
            text, language, on_progress=on_progress, instructions=instructions
        )
        job.add_findings("llm", drop_duplicates(result.findings, job.findings))
        if result.scorecard is not None:
            job.set_scorecard(result.scorecard)
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    except Exception as exc:
        status = "failed"
        error = str(exc) or type(exc).__name__
        logger.warning("llm check failed (provider %s): %s", provider.name, error)
        job.emit("checker_error", {"checker": "llm", "error": error})
    finally:
        reservation.finish(
            status, output_tokens=latest_tokens if latest_tokens > 0 else None
        )
        job.finish()


@router.get("/checks/{check_id}")
def get_check(
    request: Request,
    check_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> CheckStatus:
    job = request.app.state.jobs.get(check_id, owner_id=user.id)
    if job is None:
        raise HTTPException(404, "Check not found")
    return CheckStatus(
        check_id=job.id,
        status=job.status,
        findings=job.findings,
        skipped_rules=job.skipped_rules,
        scorecard=job.scorecard,
        effective_llm=job.effective_llm,
    )


@router.get("/checks/{check_id}/events")
async def check_events(
    request: Request,
    check_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> StreamingResponse:
    job = request.app.state.jobs.get(check_id, owner_id=user.id)
    if job is None:
        raise HTTPException(404, "Check not found")

    async def event_stream() -> Any:
        async for name, data in job.stream():
            yield f"event: {name}\ndata: {json.dumps(data)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
