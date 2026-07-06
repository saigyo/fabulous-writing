from app.checkers.pipeline import drop_duplicates
from app.core.models import Category, Finding, Severity, Source, Span


def make_finding(
    start: int, end: int, source: Source, category: Category = Category.STYLE
) -> Finding:
    return Finding(
        category=category,
        severity=Severity.WARNING,
        source=source,
        message="m",
        span=Span(start=start, end=end, text="x" * (end - start)),
    )


def test_same_category_overlap_is_dropped() -> None:
    rule = make_finding(10, 20, Source.RULE)
    llm_overlap = make_finding(15, 25, Source.LLM)
    llm_separate = make_finding(30, 40, Source.LLM)
    kept = drop_duplicates([llm_overlap, llm_separate], existing=[rule])
    assert kept == [llm_separate]


def test_touching_spans_do_not_count_as_overlap() -> None:
    rule = make_finding(10, 20, Source.RULE)
    llm = make_finding(20, 30, Source.LLM)
    assert drop_duplicates([llm], existing=[rule]) == [llm]


def test_small_finding_inside_larger_span_of_other_category_is_kept() -> None:
    # A whole-sentence finding (e.g. clarity.phrase-longue) must not shadow
    # a different diagnosis on a few words inside that sentence.
    sentence = make_finding(0, 120, Source.RULE, Category.CLARITY)
    grammar_point = make_finding(40, 55, Source.LLM, Category.GRAMMAR)
    assert drop_duplicates([grammar_point], existing=[sentence]) == [grammar_point]


def test_same_target_of_other_category_is_dropped() -> None:
    # Both flag essentially the same text (an LLM style finding on a cliché
    # the vividness rule already flagged) — that is a duplicate diagnosis.
    cliche_rule = make_finding(10, 27, Source.RULE, Category.VIVIDNESS)
    llm_same_spot = make_finding(10, 28, Source.LLM, Category.STYLE)
    assert drop_duplicates([llm_same_spot], existing=[cliche_rule]) == []


def test_minor_overlap_of_other_category_is_kept() -> None:
    weasel = make_finding(10, 20, Source.RULE, Category.STYLE)
    llm_neighbor = make_finding(18, 40, Source.LLM, Category.GRAMMAR)
    assert drop_duplicates([llm_neighbor], existing=[weasel]) == [llm_neighbor]
