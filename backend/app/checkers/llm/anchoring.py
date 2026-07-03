import re
from difflib import SequenceMatcher

from app.core.models import Span

FUZZY_THRESHOLD = 0.8


def anchor(text: str, quote: str, context_before: str = "") -> Span | None:
    """Locate `quote` in `text`, returning its span or None if unanchorable.

    LLM-reported offsets are unreliable, so findings are anchored by their
    verbatim quote: exact match first, then whitespace-tolerant match, then
    a fuzzy sliding-window match. Ambiguous quotes are disambiguated by the
    text immediately preceding the occurrence (`context_before`).
    """
    quote = quote.strip()
    if not quote:
        return None

    starts = _exact_occurrences(text, quote)
    if starts:
        start = _pick_occurrence(text, starts, context_before)
        return Span(start=start, end=start + len(quote), text=text[start : start + len(quote)])

    match_spans = _whitespace_tolerant_occurrences(text, quote)
    if match_spans:
        start, end = match_spans[
            _pick_occurrence_index(text, [s for s, _ in match_spans], context_before)
        ]
        return Span(start=start, end=end, text=text[start:end])

    return _fuzzy_match(text, quote)


def _exact_occurrences(text: str, quote: str) -> list[int]:
    starts = []
    index = text.find(quote)
    while index != -1:
        starts.append(index)
        index = text.find(quote, index + 1)
    return starts


def _whitespace_tolerant_occurrences(text: str, quote: str) -> list[tuple[int, int]]:
    tokens = quote.split()
    if not tokens:
        return []
    pattern = r"\s+".join(re.escape(token) for token in tokens)
    return [(m.start(), m.end()) for m in re.finditer(pattern, text)]


def _pick_occurrence(text: str, starts: list[int], context_before: str) -> int:
    return starts[_pick_occurrence_index(text, starts, context_before)]


def _pick_occurrence_index(text: str, starts: list[int], context_before: str) -> int:
    if len(starts) == 1 or not context_before.strip():
        return 0
    best_index = 0
    best_score = -1.0
    for i, start in enumerate(starts):
        preceding = text[max(0, start - len(context_before)) : start]
        score = SequenceMatcher(None, preceding, context_before, autojunk=False).ratio()
        if score > best_score:
            best_score = score
            best_index = i
    return best_index


def _fuzzy_match(text: str, quote: str) -> Span | None:
    window = len(quote)
    if window == 0 or len(text) < 3:
        return None
    matcher = SequenceMatcher(b=quote, autojunk=False)
    best_ratio = 0.0
    best_start = -1
    last_start = max(0, len(text) - window)
    for start in range(last_start + 1):
        matcher.set_seq1(text[start : start + window])
        if matcher.real_quick_ratio() <= best_ratio or matcher.quick_ratio() <= best_ratio:
            continue
        ratio = matcher.ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_start = start
    if best_ratio < FUZZY_THRESHOLD or best_start < 0:
        return None
    start, end = _refine_window(text, quote, best_start, window)
    return Span(start=start, end=end, text=text[start:end])


def _refine_window(text: str, quote: str, start: int, window: int) -> tuple[int, int]:
    """Nudge window edges a few characters to best align with the quote."""
    best = (start, min(len(text), start + window))
    best_ratio = 0.0
    for s in range(max(0, start - 2), min(start + 3, len(text))):
        for e in range(max(s + 1, s + window - 2), min(len(text), s + window + 3) + 1):
            ratio = SequenceMatcher(None, text[s:e], quote, autojunk=False).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best = (s, e)
    return best
