from app.core.models import Finding, Span


def spans_overlap(a: Span, b: Span) -> bool:
    return a.start < b.end and b.start < a.end


def drop_overlapping(
    candidates: list[Finding], existing: list[Finding]
) -> list[Finding]:
    """Drop candidate findings whose span overlaps an existing finding.

    Used to prefer deterministic rule/terminology findings over LLM
    findings covering the same text.
    """
    return [
        candidate
        for candidate in candidates
        if not any(spans_overlap(candidate.span, other.span) for other in existing)
    ]
