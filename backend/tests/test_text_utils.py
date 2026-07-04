from app.checkers.rules.text import expand_to_sentences, split_sentences
from app.core.config import NlpSettings
from app.nlp.registry import NlpRegistry

TEXT = "First sentence here. Second one is longer. Third ends it."


def test_split_sentences_uses_doc_when_given() -> None:
    registry = NlpRegistry(NlpSettings().models)
    text = "Dr. Smith wrote this. It is short."
    doc = registry.analyze(text, "en")
    sentences = split_sentences(text, doc=doc)
    # The regex splitter would break after "Dr."; spaCy must not.
    assert sentences[0][2] == "Dr. Smith wrote this."
    assert sentences[0][0] == 0


def test_regex_fallback_splits_cjk_punctuation() -> None:
    text = "これは文です。これも文です。"
    sentences = split_sentences(text)
    assert len(sentences) == 2
    assert sentences[1][2] == "これも文です。"


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
