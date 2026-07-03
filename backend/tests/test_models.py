from app.core.models import Category, Finding, Severity, Source, Span


def test_finding_gets_generated_id_and_empty_suggestions() -> None:
    finding = Finding(
        category=Category.STYLE,
        severity=Severity.WARNING,
        source=Source.RULE,
        rule_id="style.weasel-words",
        message="'very' is a weasel word.",
        span=Span(start=10, end=14, text="very"),
    )
    assert finding.id
    assert finding.suggestions == []


def test_finding_serializes_enums_as_strings() -> None:
    finding = Finding(
        category=Category.TERMINOLOGY,
        severity=Severity.ERROR,
        source=Source.TERMINOLOGY,
        message="Use the preferred term.",
        span=Span(start=0, end=4, text="Foo"),
        suggestions=["Bar"],
    )
    data = finding.model_dump(mode="json")
    assert data["category"] == "terminology"
    assert data["severity"] == "error"
    assert data["source"] == "terminology"
    assert data["rule_id"] is None
