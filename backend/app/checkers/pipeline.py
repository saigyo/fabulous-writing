from app.core.models import Finding, Span


def spans_overlap(a: Span, b: Span) -> bool:
    return a.start < b.end and b.start < a.end


def _same_target(a: Span, b: Span) -> bool:
    """True when two spans flag substantially the same text.

    The overlap must make up the majority of the combined extent — a short
    finding inside a whole-sentence finding is *not* the same target.
    """
    overlap = min(a.end, b.end) - max(a.start, b.start)
    if overlap <= 0:
        return False
    union = max(a.end, b.end) - min(a.start, b.start)
    return overlap / union >= 0.5


def drop_duplicates(
    candidates: list[Finding], existing: list[Finding]
) -> list[Finding]:
    """Drop candidate findings that repeat an existing diagnosis.

    A candidate is a duplicate when its span overlaps an existing finding of
    the same category, or when both flag substantially the same text in any
    category. Used to prefer deterministic rule/terminology findings over
    LLM findings — without letting a whole-sentence finding (e.g. a
    sentence-length warning) shadow different diagnoses inside it.
    """

    def duplicate(candidate: Finding, other: Finding) -> bool:
        if not spans_overlap(candidate.span, other.span):
            return False
        return candidate.category == other.category or _same_target(
            candidate.span, other.span
        )

    return [
        candidate
        for candidate in candidates
        if not any(duplicate(candidate, other) for other in existing)
    ]
