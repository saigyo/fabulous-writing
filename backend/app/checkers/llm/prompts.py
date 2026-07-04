from app.core.models import Category, Language

_LANGUAGE_NAMES = {
    Language.EN: "English",
    Language.DE: "German (Deutsch)",
    Language.FR: "French (Français)",
    Language.ES: "Spanish (Español)",
    Language.IT: "Italian (Italiano)",
    Language.JA: "Japanese (日本語)",
    Language.ZH: "Chinese (中文)",
}

_SYSTEM_TEMPLATE = """You are an expert writing coach reviewing a {language} text \
(article, documentation, or marketing copy). Identify concrete quality issues in \
these categories: {categories}.

- spelling: misspelled words
- grammar: grammatical mistakes
- style: weak, wordy, or awkward phrasing; passive voice; inconsistent tone
- clarity: ambiguous, convoluted, or hard-to-follow passages
- vividness: bland, abstract, or clichéd language that could be more concrete and engaging
- correctness: statements that are internally contradictory or factually dubious

Respond with ONLY a JSON array. Each element:
{{
  "category": "<one of the categories above>",
  "severity": "error" | "warning" | "suggestion",
  "quote": "<the EXACT problematic text, copied verbatim from the input, max ~15 words>",
  "context_before": "<the few words immediately preceding the quote, verbatim>",
  "message": "<short explanation for the writer, in {language}>",
  "suggestions": ["<improved replacement for exactly the quoted text>", ...]
}}

Rules:
- "quote" MUST be copied character-for-character from the input text; never paraphrase it.
- Each suggestion must be a drop-in replacement for the quote.
- Report at most 15 of the most important issues. If the text is fine, return [].
"""


_SUGGESTION_SYSTEM_TEMPLATE = """You are an expert writing coach. The writer's text is \
in {language}. You are given a flagged passage, the issue with it, and its context. \
Propose 1 to 3 improved replacements.

Rules:
- Each replacement must be a drop-in substitute for EXACTLY the flagged passage: it \
must fit grammatically when swapped in, preserving the surrounding words.
- Write replacements in {language}.
- Keep the writer's meaning; fix only the flagged issue.
- Respond with ONLY a JSON array of strings, e.g. ["first option", "second option"].
"""


_REWRITE_SYSTEM_TEMPLATE = """You are an expert writing coach. The writer's text is \
in {language}. You are given a passage (one or more full sentences) and an issue that \
was flagged inside it. Rewrite the passage to fix the issue.

Rules:
- Provide 1 or 2 rewrites. Each must be a complete replacement for the whole passage.
- You may split a long sentence into several shorter ones.
- Write in {language}, keep the writer's meaning and tone; fix only the flagged issue.
- Respond with ONLY a JSON array of strings, e.g. ["first rewrite", "second rewrite"].
"""


def build_rewrite_prompt(
    passage: str, message: str, language: Language
) -> tuple[str, str]:
    """Prompt for full rewrites of the sentence(s) containing a finding."""
    system = _REWRITE_SYSTEM_TEMPLATE.format(language=_LANGUAGE_NAMES[language])
    user = (
        f"Passage:\n{passage}\n\n"
        f"Flagged issue: {message}\n\n"
        "Provide the JSON array of rewrites now."
    )
    return system, user


def build_suggestion_prompt(
    text: str, start: int, end: int, message: str, language: Language
) -> tuple[str, str]:
    """Prompt for drop-in replacements for one flagged span."""
    from app.checkers.rules.text import split_sentences

    flagged = text[start:end]
    context_parts = [
        sentence
        for s_start, s_end, sentence in split_sentences(text)
        if s_start < end and start < s_end
    ]
    context = " ".join(context_parts) or flagged
    system = _SUGGESTION_SYSTEM_TEMPLATE.format(language=_LANGUAGE_NAMES[language])
    user = (
        f"Context:\n{context}\n\n"
        f"Flagged passage: \"{flagged}\"\n"
        f"Issue: {message}\n\n"
        "Provide the JSON array of replacements now."
    )
    return system, user


def build_prompt(text: str, language: Language) -> tuple[str, str]:
    categories = ", ".join(c.value for c in Category if c != Category.TERMINOLOGY)
    system = _SYSTEM_TEMPLATE.format(
        language=_LANGUAGE_NAMES[language], categories=categories
    )
    user = f"Review the following text:\n\n{text}"
    return system, user
