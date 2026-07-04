import asyncio
import json
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.checkers.llm.checker import LLMChecker
from app.checkers.llm.provider import LLMProvider
from app.checkers.pipeline import drop_overlapping
from app.checkers.terminology import TerminologyChecker
from app.core.models import Finding, Language
from app.services.jobs import CheckJob

router = APIRouter(prefix="/api", tags=["checks"])

CheckerName = Literal["rules", "terminology", "llm"]


class CheckRequest(BaseModel):
    text: str
    language: Language
    domain_id: int | None = None
    checkers: list[CheckerName] = Field(
        default_factory=lambda: ["rules", "terminology", "llm"]
    )
    llm_provider: str | None = None
    llm_model: str | None = None


class CheckStatus(BaseModel):
    check_id: str
    status: str
    findings: list[Finding]
    skipped_rules: list[str] = Field(default_factory=list)


@router.post("/checks", status_code=202)
async def create_check(request: Request, body: CheckRequest) -> CheckStatus:
    app = request.app
    job: CheckJob = app.state.jobs.create()

    if "rules" in body.checkers:
        doc = app.state.nlp.analyze(body.text, body.language.value)
        if doc is None:
            job.skipped_rules = app.state.rule_engine.nlp_rule_ids(body.language)
        findings = app.state.rule_engine.check(body.text, body.language, doc=doc)
        job.add_findings("rules", findings)
    if "terminology" in body.checkers and body.domain_id is not None:
        checker = TerminologyChecker(app.state.terminology_store, nlp=app.state.nlp)
        job.add_findings(
            "terminology", checker.check(body.text, body.language, body.domain_id)
        )

    if "llm" in body.checkers:
        provider: LLMProvider = app.state.provider_factory(
            body.llm_provider, body.llm_model
        )
        job.attach_task(
            asyncio.create_task(
                _run_llm(
                    job,
                    provider,
                    body.text,
                    body.language,
                    vet=app.state.settings.vet_suggestions,
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
    )


async def _run_llm(
    job: CheckJob, provider: LLMProvider, text: str, language: Language, vet: bool = True
) -> None:
    try:
        findings = await LLMChecker(provider, vet=vet).check(text, language)
        job.add_findings("llm", drop_overlapping(findings, job.findings))
    except Exception as exc:
        error = str(exc) or type(exc).__name__
        job.emit("checker_error", {"checker": "llm", "error": error})
    finally:
        job.finish()


@router.get("/checks/{check_id}")
def get_check(request: Request, check_id: str) -> CheckStatus:
    job = request.app.state.jobs.get(check_id)
    if job is None:
        raise HTTPException(404, "Check not found")
    return CheckStatus(
        check_id=job.id,
        status=job.status,
        findings=job.findings,
        skipped_rules=job.skipped_rules,
    )


@router.get("/checks/{check_id}/events")
async def check_events(request: Request, check_id: str) -> StreamingResponse:
    job = request.app.state.jobs.get(check_id)
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
