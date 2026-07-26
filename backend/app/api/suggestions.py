from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.api.deps import CurrentUser, get_current_user
from app.api.llm_gate import get_effective_provider
from app.checkers.llm.checker import extract_json_array
from app.checkers.llm.prompts import build_rewrite_prompt, build_suggestion_prompt
from app.checkers.llm.vetting import split_advice, vet_suggestions
from app.checkers.rules.text import expand_to_sentences
from app.core.models import Language, QualityTier
from app.core.permissions import RequestedLLM

router = APIRouter(prefix="/api", tags=["suggestions"])


class SpanRef(BaseModel):
    start: int
    end: int


class HeldBackSuggestion(BaseModel):
    text: str
    reason_kind: Literal["rules", "spelling"]
    rule_ids: list[str] = []
    words: list[str] = []


class SuggestionRequest(BaseModel):
    text: str
    span: SpanRef
    message: str
    language: Language
    scope: Literal["span", "sentence"] = "span"
    rule_id: str | None = None
    llm_tier: QualityTier | None = None
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_instructions: str = ""


class SuggestionResponse(BaseModel):
    suggestions: list[str]
    span: SpanRef
    original: str
    rejected: int = 0
    held_back: list[HeldBackSuggestion] = []
    advice: list[str] = []
    skipped: str | None = None


@router.post("/suggestions")
async def create_suggestions(
    request: Request,
    body: SuggestionRequest,
    user: CurrentUser = Depends(get_current_user),
) -> SuggestionResponse:
    span = body.span
    if not (0 <= span.start < span.end <= len(body.text)):
        raise HTTPException(422, "Span does not fit the provided text")

    if body.scope == "sentence":
        start, end = expand_to_sentences(body.text, span.start, span.end)
        original = body.text[start:end]
        system, prompt = build_rewrite_prompt(
            original, body.message, body.language, instructions=body.llm_instructions
        )
    else:
        start, end = span.start, span.end
        original = body.text[start:end]
        system, prompt = build_suggestion_prompt(
            body.text,
            start,
            end,
            body.message,
            body.language,
            instructions=body.llm_instructions,
        )

    requested = RequestedLLM(
        tier=body.llm_tier, provider=body.llm_provider, model=body.llm_model
    )
    effective, provider = get_effective_provider(
        request.app, user, requested, body.language.value
    )
    if provider is None:
        # Spec §7.2: where the LLM output IS the product, a denial degrades
        # to an empty 200 with a machine-readable reason -- never 403.
        return SuggestionResponse(
            suggestions=[],
            span=SpanRef(start=start, end=end),
            original=original,
            skipped=effective.skipped,
        )
    try:
        response = await provider.generate(system, prompt)
    except Exception as exc:
        detail = str(exc) or type(exc).__name__
        raise HTTPException(502, f"LLM request failed: {detail}") from exc

    items = extract_json_array(response)
    if items is None:
        raise HTTPException(502, "LLM response contained no JSON array")

    suggestions = [
        item.strip()
        for item in items
        if isinstance(item, str) and item.strip() and item.strip() != original
    ]
    # Advice must never render as an appliable replacement; split it off
    # before vetting (also when vetting is disabled).
    suggestions, advice = split_advice(suggestions)
    rejected = 0
    held_back: list[HeldBackSuggestion] = []
    if request.app.state.settings.vet_suggestions:
        result = vet_suggestions(
            suggestions,
            original=original,
            text=body.text,
            start=start,
            end=end,
            language=body.language,
            rule_id=body.rule_id,
            engine=request.app.state.rule_engine,
            nlp=request.app.state.nlp,
            dictionaries_dir=request.app.state.settings.dictionaries_dir,
        )
        suggestions, rejected = result.accepted, result.rejected
        held_back = [
            HeldBackSuggestion(
                text=candidate.text,
                reason_kind=candidate.reason_kind,
                rule_ids=candidate.rule_ids,
                words=candidate.words,
            )
            for candidate in result.held_back
        ]
    return SuggestionResponse(
        suggestions=suggestions,
        span=SpanRef(start=start, end=end),
        original=original,
        rejected=rejected,
        held_back=held_back,
        advice=advice,
    )
