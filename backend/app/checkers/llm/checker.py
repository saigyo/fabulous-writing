import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple

from pydantic import BaseModel, Field, ValidationError

from app.core.models import Category, Finding, Language, Scorecard, Severity, Source

from .anchoring import anchor
from .prompts import build_prompt
from .provider import LLMProvider, ProgressCallback
from .vetting import split_advice, vet_candidates

_CODE_FENCE = re.compile(r"^```[a-z]*\s*|\s*```$", re.MULTILINE)


class RawFinding(BaseModel):
    category: Category
    severity: Severity = Severity.WARNING
    quote: str
    context_before: str = ""
    message: str
    suggestions: list[str] = Field(default_factory=list)


def _extract_json(response: str, open_ch: str, close_ch: str, expected: type) -> Any:
    """Extract a JSON value from an LLM response, tolerating fences and prose."""
    candidates = [response, _CODE_FENCE.sub("", response).strip()]
    start, end = response.find(open_ch), response.rfind(close_ch)
    if start != -1 and end > start:
        candidates.append(response[start : end + 1])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, expected):
            return data
    return None


def extract_json_array(response: str) -> list | None:
    return _extract_json(response, "[", "]", list)


def extract_json_object(response: str) -> dict | None:
    return _extract_json(response, "{", "}", dict)


class ParsedResponse(NamedTuple):
    findings: list[RawFinding]
    scorecard: Scorecard | None


def parse_response(response: str) -> ParsedResponse:
    """Parse the check response: object envelope, or bare-array fallback.

    The envelope must have a "findings" list — a lone finding object (e.g.
    the {...} inside a one-element bare array) is not mistaken for it. A
    scorecard that fails validation is discarded whole (strict gate); the
    findings from the same response are unaffected.
    """
    data = extract_json_object(response)
    if data is not None and isinstance(data.get("findings"), list):
        scorecard = None
        if data.get("scorecard") is not None:
            try:
                scorecard = Scorecard.model_validate(data["scorecard"])
            except ValidationError:
                scorecard = None
        return ParsedResponse(_validate_findings(data["findings"]), scorecard)
    return ParsedResponse(_validate_findings(extract_json_array(response) or []), None)


def _validate_findings(items: list) -> list[RawFinding]:
    findings = []
    for item in items:
        try:
            findings.append(RawFinding.model_validate(item))
        except ValidationError:
            continue
    return findings


def parse_findings(response: str) -> list[RawFinding]:
    """Extract findings from an LLM response, skipping invalid items."""
    return parse_response(response).findings


@dataclass
class LLMCheckResult:
    findings: list[Finding]
    scorecard: Scorecard | None


class LLMChecker:
    def __init__(
        self,
        provider: LLMProvider,
        vet: bool = True,
        dictionaries_dir: "Path | None" = None,
    ) -> None:
        self.provider = provider
        self.vet = vet
        self.dictionaries_dir = dictionaries_dir

    async def check(
        self,
        text: str,
        language: Language,
        on_progress: ProgressCallback | None = None,
        instructions: str = "",
    ) -> "LLMCheckResult":
        system, user = build_prompt(text, language, instructions=instructions)
        response = (await self.provider.generate(system, user, on_progress)).text
        raw_findings, scorecard = parse_response(response)
        findings: list[Finding] = []
        for raw in raw_findings:
            span = anchor(text, raw.quote, raw.context_before)
            if span is None:
                continue
            # Advice is presented, never applied — and never vetted: even an
            # unknown word in advice is fine to display.
            suggestions, advice = split_advice(raw.suggestions)
            if self.vet and suggestions:
                # Cheap stages only; a bad fix does not invalidate the diagnosis.
                suggestions = vet_candidates(
                    suggestions,
                    original=span.text,
                    text=text,
                    language=language,
                    dictionaries_dir=self.dictionaries_dir,
                ).accepted
            findings.append(
                Finding(
                    category=raw.category,
                    severity=raw.severity,
                    source=Source.LLM,
                    message=raw.message,
                    span=span,
                    suggestions=suggestions,
                    advice=advice,
                )
            )
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return LLMCheckResult(findings=findings, scorecard=scorecard)
