"""Deterministic vetting of LLM-generated suggestions.

LLM findings pass the anchoring gate; this is the counterpart for LLM *fixes*.
See docs/superpowers/specs/2026-07-04-suggestion-vetting-design.md.
"""

import re
import threading
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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

# Hunspell dictionaries (spylls) keyed by (directory, language code). When
# installed via scripts/install-dictionaries.sh they make the gate
# morphology-aware: affix forms and German compounds resolve properly instead
# of relying on the frequency list alone.
_dictionaries: dict[tuple[str, str], object] = {}
_dictionaries_lock = threading.Lock()


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


def _hunspell(code: str, dictionaries_dir: Path | None):
    if dictionaries_dir is None:
        return None
    key = (str(dictionaries_dir), code)
    with _dictionaries_lock:
        if key not in _dictionaries:
            _dictionaries[key] = None  # degrade open
            if (dictionaries_dir / f"{code}.dic").is_file():
                try:
                    from spylls.hunspell import Dictionary

                    _dictionaries[key] = Dictionary.from_files(
                        str(dictionaries_dir / code)
                    )
                except Exception:
                    pass
        return _dictionaries[key]


def _sane(candidate: str, original: str) -> bool:
    stripped = candidate.strip()
    if not stripped or stripped == original.strip():
        return False
    if stripped[0] in '["]' or stripped[-1] in '["]':
        return False
    ratio = len(stripped) / max(len(original), 1)
    return _MIN_LENGTH_RATIO <= ratio <= _MAX_LENGTH_RATIO


def _has_unknown_words(
    candidate: str,
    language: Language,
    whitelist: set[str],
    dictionaries_dir: Path | None = None,
) -> bool:
    code = _SPELL_LANGUAGES.get(language)
    if code is None:
        return False
    checker = _spell_checker(code)
    if checker is None:
        return False
    words = [
        word
        for word in _WORD.findall(candidate)
        if not any(ch.isdigit() for ch in word) and word.lower() not in whitelist
    ]
    unknown = {word.lower() for word in words} & checker.unknown(
        [word.lower() for word in words]
    )
    if not unknown:
        return False
    dictionary = _hunspell(code, dictionaries_dir)
    if dictionary is None:
        return True
    # Union gate: hunspell rescues frequency-unknown words that are
    # morphologically valid (inflections, German compounds).
    return any(
        not dictionary.lookup(word)  # type: ignore[attr-defined]
        for word in words
        if word.lower() in unknown
    )


def vet_candidates(
    candidates: list[str],
    *,
    original: str,
    text: str,
    language: Language,
    dictionaries_dir: Path | None = None,
) -> VetResult:
    """Stages 1–2: sanity filters and the spell gate with a document whitelist."""
    whitelist = {word.lower() for word in _WORD.findall(text)}
    accepted = [
        candidate.strip()
        for candidate in candidates
        if _sane(candidate, original)
        and not _has_unknown_words(candidate, language, whitelist, dictionaries_dir)
    ]
    return VetResult(accepted=accepted, rejected=len(candidates) - len(accepted))


def _finding_counts(
    engine: Any, text: str, language: Language, nlp: Any
) -> Counter[str]:
    doc = nlp.analyze(text, language.value) if nlp is not None else None
    return Counter(
        finding.rule_id
        for finding in engine.check(text, language, doc=doc)
        if finding.rule_id
    )


def _passes_rule_recheck(
    candidate: str,
    *,
    before: Counter[str],
    text: str,
    start: int,
    end: int,
    language: Language,
    rule_id: str | None,
    engine: Any,
    nlp: Any,
) -> bool:
    patched = text[:start] + candidate + text[end:]
    after = _finding_counts(engine, patched, language, nlp)
    if any(count > before[rid] for rid, count in after.items()):
        return False  # the fix introduces new problems
    if rule_id is not None and rule_id in before and after[rule_id] >= before[rule_id]:
        return False  # the fix does not resolve the rule it addresses
    return True


def vet_suggestions(
    candidates: list[str],
    *,
    original: str,
    text: str,
    start: int,
    end: int,
    language: Language,
    rule_id: str | None,
    engine: Any,
    nlp: Any,
    dictionaries_dir: Path | None = None,
) -> VetResult:
    """All three stages; for on-demand suggestions where the span is known."""
    result = vet_candidates(
        candidates,
        original=original,
        text=text,
        language=language,
        dictionaries_dir=dictionaries_dir,
    )
    before = _finding_counts(engine, text, language, nlp)
    accepted = [
        candidate
        for candidate in result.accepted
        if _passes_rule_recheck(
            candidate,
            before=before,
            text=text,
            start=start,
            end=end,
            language=language,
            rule_id=rule_id,
            engine=engine,
            nlp=nlp,
        )
    ]
    return VetResult(accepted=accepted, rejected=len(candidates) - len(accepted))
