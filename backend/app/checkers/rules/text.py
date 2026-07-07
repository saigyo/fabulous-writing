import re

_SENTENCE_CHUNK = re.compile(r"[^.!?。！？\n]+[.!?。！？]*")


def split_sentences(text: str, doc: object | None = None) -> list[tuple[int, int, str]]:
    """Split text into sentences, returning (start, end, sentence) tuples.

    Uses spaCy sentence boundaries when a parsed doc is given; otherwise a
    punctuation regex (including CJK 。！？). Offsets refer to the original
    text; surrounding whitespace is excluded.
    """
    if doc is not None:
        sentences: list[tuple[int, int, str]] = []
        for sent in doc.sents:  # type: ignore[attr-defined]
            stripped = sent.text.strip()
            if not stripped:
                continue
            start = sent.start_char + (len(sent.text) - len(sent.text.lstrip()))
            sentences.append((start, start + len(stripped), stripped))
        return sentences
    sentences = []
    for match in _SENTENCE_CHUNK.finditer(text):
        chunk = match.group()
        stripped = chunk.strip()
        if not stripped:
            continue
        start = match.start() + (len(chunk) - len(chunk.lstrip()))
        sentences.append((start, start + len(stripped), stripped))
    return sentences


def expand_to_sentences(text: str, start: int, end: int) -> tuple[int, int]:
    """Expand a span to the boundaries of the sentence(s) it overlaps.

    Returns the span unchanged if no sentence overlaps it.
    """
    overlapping = [
        (s_start, s_end)
        for s_start, s_end, _ in split_sentences(text)
        if s_start < end and start < s_end
    ]
    if not overlapping:
        return start, end
    return min(s for s, _ in overlapping), max(e for _, e in overlapping)


def format_message(template: str, *args: str) -> str:
    """Fill printf-style %s placeholders, tolerating fewer placeholders than args."""
    count = template.count("%s")
    if count == 0:
        return template
    return template % args[:count]


# Han (incl. ext. A + compatibility), Hiragana, Katakana, CJK punctuation,
# and full-width forms. A `\b` on a side whose edge char is in these ranges
# can never match mid-sentence (kana/kanji count as \w), so we drop it.
_CJK_CHAR = re.compile(
    "[\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]"
)


def bounded_pattern(fragment: str) -> str:
    """Wrap a regex fragment in word boundaries, edge-aware for CJK.

    Only the literal edge characters are inspected: a fragment whose edge
    is a regex metachar (e.g. ``(行か|読ま)せる``) keeps ``\\b`` and will
    not match adjacent to kana/kanji — put such patterns in ``raw:``,
    which is never wrapped.
    """
    left = "" if _CJK_CHAR.match(fragment[0]) else r"\b"
    right = "" if _CJK_CHAR.match(fragment[-1]) else r"\b"
    return rf"{left}(?:{fragment}){right}"
