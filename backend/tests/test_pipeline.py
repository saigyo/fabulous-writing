from app.checkers.pipeline import drop_overlapping
from app.core.models import Category, Finding, Severity, Source, Span


def make_finding(start: int, end: int, source: Source) -> Finding:
    return Finding(
        category=Category.STYLE,
        severity=Severity.WARNING,
        source=source,
        message="m",
        span=Span(start=start, end=end, text="x" * (end - start)),
    )


def test_llm_finding_overlapping_rule_finding_is_dropped() -> None:
    rule = make_finding(10, 20, Source.RULE)
    llm_overlap = make_finding(15, 25, Source.LLM)
    llm_separate = make_finding(30, 40, Source.LLM)
    kept = drop_overlapping([llm_overlap, llm_separate], existing=[rule])
    assert kept == [llm_separate]


def test_touching_spans_do_not_count_as_overlap() -> None:
    rule = make_finding(10, 20, Source.RULE)
    llm = make_finding(20, 30, Source.LLM)
    assert drop_overlapping([llm], existing=[rule]) == [llm]
