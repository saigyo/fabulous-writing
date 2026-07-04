import json
import re
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from app.core.models import Category, Finding, Language, Severity, Source

from .anchoring import anchor
from .prompts import build_prompt
from .provider import LLMProvider
from .vetting import vet_candidates

_CODE_FENCE = re.compile(r"^```[a-z]*\s*|\s*```$", re.MULTILINE)


class RawFinding(BaseModel):
    category: Category
    severity: Severity = Severity.WARNING
    quote: str
    context_before: str = ""
    message: str
    suggestions: list[str] = Field(default_factory=list)


def extract_json_array(response: str) -> list | None:
    """Extract a JSON array from an LLM response, tolerating fences and prose."""
    candidates = [response, _CODE_FENCE.sub("", response).strip()]
    start, end = response.find("["), response.rfind("]")
    if start != -1 and end > start:
        candidates.append(response[start : end + 1])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, list):
            return data
    return None


def parse_findings(response: str) -> list[RawFinding]:
    """Extract findings from an LLM response, skipping invalid items."""
    data = extract_json_array(response)
    if data is None:
        return []
    findings = []
    for item in data:
        try:
            findings.append(RawFinding.model_validate(item))
        except ValidationError:
            continue
    return findings


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

    async def check(self, text: str, language: Language) -> list[Finding]:
        system, user = build_prompt(text, language)
        response = await self.provider.generate(system, user)
        findings: list[Finding] = []
        for raw in parse_findings(response):
            span = anchor(text, raw.quote, raw.context_before)
            if span is None:
                continue
            suggestions = raw.suggestions
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
                )
            )
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings
