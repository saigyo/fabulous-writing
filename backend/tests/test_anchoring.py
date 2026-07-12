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


def test_three_way_ambiguity_prefers_context_match() -> None:
    text = "It was very cold. He felt very tired. She was very sad indeed."
    span = anchor(text, "very", context_before="He felt ")
    assert span is not None
    assert span.start == text.index("very", text.index("He"))  # the middle one


def test_whitespace_tolerant_with_multiple_occurrences() -> None:
    text = "the quick\nbrown fox ran. Later the quick brown fox slept."
    span = anchor(text, "quick brown fox", context_before="Later the ")
    assert span is not None
    assert span.start == text.index("quick", 20)


def test_fuzzy_near_miss_below_threshold_returns_none() -> None:
    # Shares many characters but stays under the 0.8 ratio for every window.
    text = "The committee approved the annual budget yesterday."
    assert anchor(text, "The komitee rejekted the anual budgit tomorow??") is None


def test_fuzzy_refine_window_trims_to_quote() -> None:
    text = "xxA colour-ful paintingzz hangs there."
    span = anchor(text, "A colorful painting")
    assert span is not None
    # The refined window must start at (or within 2 chars of) the real phrase,
    # not at the raw window position.
    assert abs(span.start - text.index("A colour")) <= 2
    assert "painting" in span.text
