from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.checkers.llm.checker import extract_json_array
from app.checkers.llm.prompts import build_suggestion_prompt
from app.checkers.llm.provider import LLMProvider
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
    llm_provider: str | None = None
    llm_model: str | None = None


class SuggestionResponse(BaseModel):
    suggestions: list[str]


@router.post("/suggestions")
async def create_suggestions(
    request: Request, body: SuggestionRequest
) -> SuggestionResponse:
    span = body.span
    if not (0 <= span.start < span.end <= len(body.text)):
        raise HTTPException(422, "Span does not fit the provided text")

    provider: LLMProvider = request.app.state.provider_factory(
        body.llm_provider, body.llm_model
    )
    system, user = build_suggestion_prompt(
        body.text, span.start, span.end, body.message, body.language
    )
    try:
        response = await provider.generate(system, user)
    except Exception as exc:
        raise HTTPException(502, f"LLM request failed: {exc}") from exc

    items = extract_json_array(response)
    if items is None:
        raise HTTPException(502, "LLM response contained no JSON array")

    original = body.text[span.start : span.end]
    suggestions = [
        item.strip()
        for item in items
        if isinstance(item, str) and item.strip() and item.strip() != original
    ]
    return SuggestionResponse(suggestions=suggestions)
