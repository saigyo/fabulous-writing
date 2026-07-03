from app.core.models import Category, Language

_LANGUAGE_NAMES = {Language.EN: "English", Language.DE: "German (Deutsch)"}

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


def build_prompt(text: str, language: Language) -> tuple[str, str]:
    categories = ", ".join(c.value for c in Category if c != Category.TERMINOLOGY)
    system = _SYSTEM_TEMPLATE.format(
        language=_LANGUAGE_NAMES[language], categories=categories
    )
    user = f"Review the following text:\n\n{text}"
    return system, user
