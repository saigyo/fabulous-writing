"""Deterministic vetting of LLM-generated suggestions.

LLM findings pass the anchoring gate; this is the counterpart for LLM *fixes*.
See docs/superpowers/specs/2026-07-04-suggestion-vetting-design.md.
"""

import re
import threading
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

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

_ADVICE_OPEN = "(（"
_ADVICE_CLOSE = ")）"


@dataclass
class HeldBackCandidate:
    """A revealable reject: why vetting suppressed this candidate."""

    text: str
    reason_kind: Literal["rules", "spelling"]
    rule_ids: list[str] = field(default_factory=list)
    words: list[str] = field(default_factory=list)


@dataclass
class VetResult:
    accepted: list[str]
    rejected: int
    held_back: list[HeldBackCandidate] = field(default_factory=list)


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


def split_advice(candidates: list[str]) -> tuple[list[str], list[str]]:
    """Separate replacement candidates from parenthesized advice.

    Models sometimes disguise advice as a replacement, wrapping it in
    parentheses: "(Consider moving this sentence...)". A candidate fully
    wrapped in (...) or （…） is advice — it must be shown, never applied.
    One wrapper layer is stripped; everything else passes through unchanged,
    order preserved. Runs before all vetting stages, so advice is never
    spell-gated, never counted as rejected, and never held back.
    """
    replacements: list[str] = []
    advice: list[str] = []
    for candidate in candidates:
        stripped = candidate.strip()
        inner = stripped[1:-1].strip() if len(stripped) >= 3 else ""
        if (
            inner
            and stripped[0] in _ADVICE_OPEN
            and stripped[-1] in _ADVICE_CLOSE
        ):
            advice.append(inner)
        else:
            replacements.append(candidate)
    return replacements, advice


def _sane(candidate: str, original: str) -> bool:
    stripped = candidate.strip()
    if not stripped or stripped == original.strip():
        return False
    if stripped[0] in '["]' or stripped[-1] in '["]':
        return False
    ratio = len(stripped) / max(len(original), 1)
    return _MIN_LENGTH_RATIO <= ratio <= _MAX_LENGTH_RATIO


def _unknown_words(
    candidate: str,
    language: Language,
    whitelist: set[str],
    dictionaries_dir: Path | None = None,
) -> list[str]:
    code = _SPELL_LANGUAGES.get(language)
    if code is None:
        return []
    checker = _spell_checker(code)
    if checker is None:
        return []
    words = [
        word
        for word in _WORD.findall(candidate)
        if not any(ch.isdigit() for ch in word) and word.lower() not in whitelist
    ]
    unknown = {word.lower() for word in words} & checker.unknown(
        [word.lower() for word in words]
    )
    if not unknown:
        return []
    offending = list(dict.fromkeys(w for w in words if w.lower() in unknown))
    dictionary = _hunspell(code, dictionaries_dir)
    if dictionary is None:
        return offending
    # Union gate: hunspell rescues frequency-unknown words that are
    # morphologically valid (inflections, German compounds).
    return [
        word
        for word in offending
        if not dictionary.lookup(word)  # type: ignore[attr-defined]
    ]


def vet_candidates(
    candidates: list[str],
    *,
    original: str,
    text: str,
    language: Language,
    dictionaries_dir: Path | None = None,
) -> VetResult:
    """Stages 1–2: sanity filters and the spell gate with a document whitelist.

    Spell-gate rejects are revealable and land in `held_back`; sanity rejects
    are garbage and are only counted.
    """
    whitelist = {word.lower() for word in _WORD.findall(text)}
    accepted: list[str] = []
    held_back: list[HeldBackCandidate] = []
    rejected = 0
    for candidate in candidates:
        if not _sane(candidate, original):
            rejected += 1
            continue
        stripped = candidate.strip()
        words = _unknown_words(stripped, language, whitelist, dictionaries_dir)
        if words:
            rejected += 1
            held_back.append(
                HeldBackCandidate(text=stripped, reason_kind="spelling", words=words)
            )
            continue
        accepted.append(stripped)
    return VetResult(accepted=accepted, rejected=rejected, held_back=held_back)


def _finding_counts(
    engine: Any, text: str, language: Language, nlp: Any
) -> Counter[str]:
    doc = nlp.analyze(text, language.value) if nlp is not None else None
    return Counter(
        finding.rule_id
        for finding in engine.check(text, language, doc=doc)
        if finding.rule_id
    )


def _rule_recheck_failures(
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
) -> list[str]:
    patched = text[:start] + candidate + text[end:]
    after = _finding_counts(engine, patched, language, nlp)
    # Rules whose count increased: the fix introduces new problems.
    failures = [rid for rid, count in after.items() if count > before[rid]]
    if (
        rule_id is not None
        and rule_id in before
        and after[rule_id] >= before[rule_id]
        and rule_id not in failures
    ):
        failures.append(rule_id)  # the fix does not resolve the rule it addresses
    return failures


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
    accepted: list[str] = []
    held_back = list(result.held_back)
    rejected = result.rejected
    for candidate in result.accepted:
        failures = _rule_recheck_failures(
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
        if failures:
            rejected += 1
            held_back.append(
                HeldBackCandidate(text=candidate, reason_kind="rules", rule_ids=failures)
            )
        else:
            accepted.append(candidate)
    return VetResult(accepted=accepted, rejected=rejected, held_back=held_back)
