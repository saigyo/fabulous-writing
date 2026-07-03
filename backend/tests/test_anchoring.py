from app.checkers.llm.anchoring import anchor


def test_exact_unique_match() -> None:
    text = "The quick brown fox jumps over the lazy dog."
    span = anchor(text, "brown fox")
    assert span is not None
    assert (span.start, span.end) == (10, 19)
    assert span.text == "brown fox"


def test_ambiguous_quote_disambiguated_by_context() -> None:
    text = "He was very happy. She was very sad."
    span = anchor(text, "very", context_before="She was ")
    assert span is not None
    assert span.start == text.rindex("very")


def test_ambiguous_quote_without_context_takes_first() -> None:
    text = "He was very happy. She was very sad."
    span = anchor(text, "very")
    assert span is not None
    assert span.start == text.index("very")


def test_fuzzy_match_tolerates_small_differences() -> None:
    text = "The colours of the painting were vivid."
    # LLM normalized the spelling; fuzzy matching should still anchor it.
    span = anchor(text, "The colors of the painting")
    assert span is not None
    assert span.start == 0
    assert "painting" in span.text


def test_unanchorable_quote_returns_none() -> None:
    text = "A completely different sentence."
    assert anchor(text, "nothing like this appears here") is None


def test_whitespace_normalization() -> None:
    text = "First line ends\nand the next continues."
    span = anchor(text, "ends and the next")
    assert span is not None
    assert span.start == text.index("ends")
    assert span.end == text.index("next") + len("next")
