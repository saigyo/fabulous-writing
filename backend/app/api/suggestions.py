from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.checkers.llm.checker import extract_json_array
from app.checkers.llm.prompts import build_rewrite_prompt, build_suggestion_prompt
from app.checkers.llm.provider import LLMProvider
from app.checkers.llm.vetting import vet_suggestions
from app.checkers.rules.text import expand_to_sentences
from app.core.models import Language

router = APIRouter(prefix="/api", tags=["suggestions"])


class SpanRef(BaseModel):
    start: int
    end: int


class SuggestionRequest(BaseModel):
    text: str
    span: SpanRef
    message: str
    language: Language
    scope: Literal["span", "sentence"] = "span"
    rule_id: str | None = None
    llm_provider: str | None = None
    llm_model: str | None = None


class SuggestionResponse(BaseModel):
    suggestions: list[str]
    span: SpanRef
    original: str
    rejected: int = 0


@router.post("/suggestions")
async def create_suggestions(
    request: Request, body: SuggestionRequest
) -> SuggestionResponse:
    span = body.span
    if not (0 <= span.start < span.end <= len(body.text)):
        raise HTTPException(422, "Span does not fit the provided text")

    if body.scope == "sentence":
        start, end = expand_to_sentences(body.text, span.start, span.end)
        original = body.text[start:end]
        system, user = build_rewrite_prompt(original, body.message, body.language)
    else:
        start, end = span.start, span.end
        original = body.text[start:end]
        system, user = build_suggestion_prompt(
            body.text, start, end, body.message, body.language
        )

    provider: LLMProvider = request.app.state.provider_factory(
        body.llm_provider, body.llm_model
    )
    try:
        response = await provider.generate(system, user)
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
    rejected = 0
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
    return SuggestionResponse(
        suggestions=suggestions,
        span=SpanRef(start=start, end=end),
        original=original,
        rejected=rejected,
    )
