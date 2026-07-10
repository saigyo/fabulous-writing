"""Document title helpers: LLM-title cleaning and first-words fallback."""

_QUOTES = (
    chr(0x0022) +  # " (double quote)
    chr(0x0027) +  # ' (single quote)
    chr(0x00AB) +  # « (left guillemet)
    chr(0x00BB) +  # » (right guillemet)
    chr(0x201E) +  # „ (left double quotation mark)
    chr(0x201C) +  # " (left double quotation mark - curly)
    chr(0x201D) +  # " (right double quotation mark - curly)
    chr(0x2018) +  # ' (left single quotation mark - curly)
    chr(0x2019) +  # ' (right single quotation mark - curly)
    chr(0x2039) +  # ‹ (single left-pointing angle quotation mark)
    chr(0x203A) +  # › (single right-pointing angle quotation mark)
    chr(0x300C) +  # 「 (left corner bracket)
    chr(0x300D) +  # 」 (right corner bracket)
    chr(0x300E) +  # 『 (left white corner bracket)
    chr(0x300F)    # 』 (right white corner bracket)
)

_TRAILING = (
    chr(0x002E) +  # . (period)
    chr(0x002C) +  # , (comma)
    chr(0x003B) +  # ; (semicolon)
    chr(0x003A) +  # : (colon)
    chr(0x0021) +  # ! (exclamation)
    chr(0x003F) +  # ? (question mark)
    chr(0x2026) +  # … (horizontal ellipsis)
    chr(0x3002) +  # 。 (ideographic full stop)
    chr(0x3001)    # 、 (ideographic comma)
)


def clean_title(raw: str) -> str | None:
    """Normalize an LLM title reply; None when nothing usable remains."""
    line = raw.strip().splitlines()[0] if raw.strip() else ""
    line = " ".join(line.split())
    line = line.strip(_QUOTES).strip()
    line = line.rstrip(_TRAILING).strip(_QUOTES).strip()
    return line[:80] or None


def fallback_name(text: str) -> str | None:
    """First six words, capped at 40 chars (the cap limits spaceless CJK)."""
    words = text.split()
    if not words:
        return None
    return " ".join(words[:6])[:40].strip() or None
