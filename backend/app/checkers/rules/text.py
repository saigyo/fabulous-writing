import re

_SENTENCE_CHUNK = re.compile(r"[^.!?\n]+[.!?]*")


def split_sentences(text: str) -> list[tuple[int, int, str]]:
    """Split text into sentences, returning (start, end, sentence) tuples.

    Offsets refer to the original text; surrounding whitespace is excluded.
    """
    sentences: list[tuple[int, int, str]] = []
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
