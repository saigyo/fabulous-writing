import json
import re

from pydantic import BaseModel, Field, ValidationError

from app.core.models import Category, Finding, Language, Severity, Source

from .anchoring import anchor
from .prompts import build_prompt
from .provider import LLMProvider

_CODE_FENCE = re.compile(r"^```[a-z]*\s*|\s*```$", re.MULTILINE)


class RawFinding(BaseModel):
    category: Category
    severity: Severity = Severity.WARNING
    quote: str
    context_before: str = ""
    message: str
    suggestions: list[str] = Field(default_factory=list)


def parse_findings(response: str) -> list[RawFinding]:
    """Extract findings from an LLM response, tolerating fences and prose."""
    candidates = [response, _CODE_FENCE.sub("", response).strip()]
    start, end = response.find("["), response.rfind("]")
    if start != -1 and end > start:
        candidates.append(response[start : end + 1])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, list):
            continue
        findings = []
        for item in data:
            try:
                findings.append(RawFinding.model_validate(item))
            except ValidationError:
                continue
        return findings
    return []


class LLMChecker:
    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider

    async def check(self, text: str, language: Language) -> list[Finding]:
        system, user = build_prompt(text, language)
        response = await self.provider.generate(system, user)
        findings: list[Finding] = []
        for raw in parse_findings(response):
            span = anchor(text, raw.quote, raw.context_before)
            if span is None:
                continue
            findings.append(
                Finding(
                    category=raw.category,
                    severity=raw.severity,
                    source=Source.LLM,
                    message=raw.message,
                    span=span,
                    suggestions=raw.suggestions,
                )
            )
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings
