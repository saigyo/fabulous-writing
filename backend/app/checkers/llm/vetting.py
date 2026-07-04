"""Deterministic vetting of LLM-generated suggestions.

LLM findings pass the anchoring gate; this is the counterpart for LLM *fixes*.
See docs/superpowers/specs/2026-07-04-suggestion-vetting-design.md.
"""

import re
import threading
from dataclasses import dataclass

from app.core.models import Language

# Frequency dictionaries shipped by pyspellchecker that we use. Word-level
# spell checking is not meaningful for ja/zh; they rely on the other stages.
_SPELL_LANGUAGES = {
    Language.EN: "en",
    Language.DE: "de",
    Language.FR: "fr",
    Language.ES: "es",
    Language.IT: "it",
}

_WORD = re.compile(r"\w+", re.UNICODE)
_MIN_LENGTH_RATIO = 0.25
_MAX_LENGTH_RATIO = 4.0

_checkers: dict[str, object] = {}
_checkers_lock = threading.Lock()


@dataclass
class VetResult:
    accepted: list[str]
    rejected: int


def _spell_checker(code: str):
    with _checkers_lock:
        if code not in _checkers:
            try:
                from spellchecker import SpellChecker

                _checkers[code] = SpellChecker(language=code)
            except Exception:
                _checkers[code] = None  # degrade open: gate skips
        return _checkers[code]


def _sane(candidate: str, original: str) -> bool:
    stripped = candidate.strip()
    if not stripped or stripped == original.strip():
        return False
    if stripped[0] in '["]' or stripped[-1] in '["]':
        return False
    ratio = len(stripped) / max(len(original), 1)
    return _MIN_LENGTH_RATIO <= ratio <= _MAX_LENGTH_RATIO


def _has_unknown_words(candidate: str, language: Language, whitelist: set[str]) -> bool:
    code = _SPELL_LANGUAGES.get(language)
    if code is None:
        return False
    checker = _spell_checker(code)
    if checker is None:
        return False
    words = [
        word.lower()
        for word in _WORD.findall(candidate)
        if not any(ch.isdigit() for ch in word) and word.lower() not in whitelist
    ]
    return bool(checker.unknown(words))


def vet_candidates(
    candidates: list[str], *, original: str, text: str, language: Language
) -> VetResult:
    """Stages 1–2: sanity filters and the spell gate with a document whitelist."""
    whitelist = {word.lower() for word in _WORD.findall(text)}
    accepted = [
        candidate.strip()
        for candidate in candidates
        if _sane(candidate, original)
        and not _has_unknown_words(candidate, language, whitelist)
    ]
    return VetResult(accepted=accepted, rejected=len(candidates) - len(accepted))
