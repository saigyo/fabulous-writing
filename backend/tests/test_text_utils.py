from app.checkers.rules.text import expand_to_sentences

TEXT = "First sentence here. Second one is longer. Third ends it."


def test_span_inside_sentence_expands_to_sentence() -> None:
    start = TEXT.index("longer")
    assert expand_to_sentences(TEXT, start, start + len("longer")) == (
        TEXT.index("Second"),
        TEXT.index("longer.") + len("longer."),
    )


def test_span_across_sentences_covers_both() -> None:
    start = TEXT.index("here")
    end = TEXT.index("Second") + len("Second")
    assert expand_to_sentences(TEXT, start, end) == (0, TEXT.index("longer.") + len("longer."))


def test_span_matching_whole_sentence_is_unchanged() -> None:
    start = TEXT.index("Second")
    end = TEXT.index("longer.") + len("longer.")
    assert expand_to_sentences(TEXT, start, end) == (start, end)


def test_span_outside_any_sentence_falls_back_to_input() -> None:
    text = "   \n   "
    assert expand_to_sentences(text, 1, 2) == (1, 2)
