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


def format_message(template: str, *args: str) -> str:
    """Fill printf-style %s placeholders, tolerating fewer placeholders than args."""
    count = template.count("%s")
    if count == 0:
        return template
    return template % args[:count]
