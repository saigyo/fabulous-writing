import re
from bisect import bisect_right
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from typing import TYPE_CHECKING

from app.core.models import Category, Finding, Language, Severity, Source, Span
from app.services.terminology import (
    ConceptTerm,
    LanguageSection,
    TerminologyStore,
    UsageStatus,
    is_enforced,
)

if TYPE_CHECKING:
    from app.nlp.registry import NlpRegistry

# No word boundaries in CJK scripts: match tokens (or substrings) instead of \b regexes.
CJK_LANGUAGES = {Language.JA, Language.ZH}

# Positions where an initial capital is conventional: text start, after
# sentence-ending punctuation (+ optional closing quotes/brackets), or after
# a newline (optionally followed by markdown structure characters).
#
# Scanned backwards rather than matched with the equivalent regex
#   re.compile(r'(?:^|[.!?…]["\')\]]*\s+|\n[\s>#*+-]*)$').search(text, 0, start)
# which is quadratic in the document length: `search` retries at every start
# position and each attempt re-scans the trailing whitespace run to reach the
# `$` anchor. Measured on a document of newlines: 4k -> 33 ms, 8k -> 129 ms,
# 16k -> 510 ms, i.e. ~20 s at 100k — and this runs once per term match, so a
# single crafted request could pin a CPU core (CodeQL py/polynomial-redos).
# The scan below only ever touches the trailing run, so it is linear.
_SENTENCE_PUNCTUATION = ".!?…"
_CLOSING_MARKS = "\"')]"
_MARKDOWN_STRUCTURE = ">#*+-"


def _sentence_start(text: str, start: int) -> bool:
    if start == 0:
        return True
    # A newline followed only by whitespace or markdown structure characters.
    # The newline is tracked during the walk rather than tested afterwards
    # with `"\n" in text[index:start]`, which would copy the whole trailing
    # run — needless allocation on attacker-supplied text.
    index = start
    saw_newline = False
    while index > 0:
        char = text[index - 1]
        if char == "\n":
            saw_newline = True
        elif not (char.isspace() or char in _MARKDOWN_STRUCTURE):
            break
        index -= 1
    if saw_newline:
        return True
    # Sentence-ending punctuation, optional closing quotes/brackets, then at
    # least one whitespace character.
    index = start
    while index > 0 and text[index - 1].isspace():
        index -= 1
    if index == start:
        return False
    while index > 0 and text[index - 1] in _CLOSING_MARKS:
        index -= 1
    return index > 0 and text[index - 1] in _SENTENCE_PUNCTUATION


def _casing_ok(text: str, start: int, matched: str, term_text: str) -> bool:
    if matched == term_text:
        return True
    capitalized = term_text[0].upper() + term_text[1:]
    return matched == capitalized and _sentence_start(text, start)


def _overlap_test(findings: list[Finding]) -> Callable[[Finding], bool]:
    merged: list[list[int]] = []
    for start, end in sorted((f.span.start, f.span.end) for f in findings):
        if merged and start < merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    starts = [start for start, _ in merged]

    def overlaps(finding: Finding) -> bool:
        index = bisect_right(starts, finding.span.end - 1) - 1
        return index >= 0 and merged[index][1] > finding.span.start

    return overlaps


def _resolve_overlaps(status: list[Finding], casing: list[Finding]) -> list[Finding]:
    hits_error = _overlap_test([f for f in status if f.severity == Severity.ERROR])
    kept = [f for f in status if f.severity == Severity.ERROR or not hits_error(f)]
    hits_kept = _overlap_test(kept)
    return kept + [c for c in casing if not hits_kept(c)]


_SEVERITY = {UsageStatus.FORBIDDEN: Severity.ERROR, UsageStatus.DEPRECATED: Severity.WARNING}


@dataclass(frozen=True)
class _Entry:
    reported: list[ConceptTerm]
    cased: list[ConceptTerm]
    accepted: frozenset[str]
    replacements: list[str]
    definition: str
    order: tuple[bool, str]


def _by_text(terms: list[ConceptTerm]) -> list[ConceptTerm]:
    return sorted(terms, key=lambda t: (t.text.casefold(), t.text))


def _texts(terms: list[ConceptTerm]) -> list[str]:
    return [t.text for t in _by_text(terms)]


def _entry(section: LanguageSection) -> _Entry | None:
    enforced = [t for t in section.terms if is_enforced(t.process_status)]
    preferred = [t for t in enforced if t.usage_status == UsageStatus.PREFERRED]
    admitted = [t for t in enforced if t.usage_status == UsageStatus.ADMITTED]
    reported = [t for t in enforced if t.usage_status in _SEVERITY]
    cased = [t for t in _by_text(preferred) + _by_text(admitted) if t.case_sensitive]
    if not reported and not cased:
        return None
    accepted = frozenset(t.text for t in preferred + admitted)
    replacements = _texts(preferred) or _texts(admitted)
    order = (not preferred, replacements[0] if preferred else "")
    return _Entry(reported, cased, accepted, replacements, section.definition, order)


def _finding(
    term: ConceptTerm,
    severity: Severity,
    message: str,
    suggestions: list[str],
    matched: str,
    start: int,
    end: int,
) -> Finding:
    return Finding(
        category=Category.TERMINOLOGY,
        severity=severity,
        source=Source.TERMINOLOGY,
        rule_id=f"terminology.{term.uid}",
        message=message,
        span=Span(start=start, end=end, text=matched),
        suggestions=suggestions,
    )


def _message(*parts: str) -> str:
    return " ".join(part for part in parts if part)


def _status_finding(
    entry: _Entry, term: ConceptTerm, matched: str, start: int, end: int
) -> Finding:
    if entry.replacements:
        quoted = " or ".join(f"'{text}'" for text in entry.replacements)
        lead = f"Use {quoted} instead of '{matched}'."
    else:
        lead = f"'{matched}' is {term.usage_status.value}."
    message = _message(lead, term.status_reason, entry.definition)
    return _finding(
        term, _SEVERITY[term.usage_status], message, list(entry.replacements), matched, start, end
    )


def _casing_finding(
    entry: _Entry, term: ConceptTerm, matched: str, start: int, end: int
) -> Finding:
    message = _message(f"Use '{term.text}' instead of '{matched}'.", entry.definition)
    return _finding(term, Severity.ERROR, message, [term.text], matched, start, end)


def _casing_findings(
    text: str, matches: Iterable[tuple[_Entry, ConceptTerm, str, int, int]]
) -> list[Finding]:
    groups: dict[tuple[int, int, int], list[tuple[_Entry, ConceptTerm, str, int, int]]] = {}
    for match in matches:
        entry, _, matched, start, end = match
        if matched not in entry.accepted:
            groups.setdefault((id(entry), start, end), []).append(match)
    findings: list[Finding] = []
    for group in groups.values():
        entry, term, matched, start, end = group[0]
        if any(_casing_ok(text, start, matched, other.text) for _, other, _, _, _ in group):
            continue
        findings.append(_casing_finding(entry, term, matched, start, end))
    return findings


class TerminologyChecker:
    def __init__(self, store: TerminologyStore, nlp: "NlpRegistry | None" = None) -> None:
        self.store = store
        self.nlp = nlp

    def check(
        self, text: str, language: Language, domain_id: int, *, owner_id: int
    ) -> list[Finding]:
        sections = self.store.list_sections(domain_id, owner_id=owner_id, language=language)
        if sections is None:
            # Invisible domain (foreign or deleted): no findings, through
            # the same store-level ownership check every other term read
            # goes through (spec §5.2).
            return []
        entries = sorted(
            (entry for entry in map(_entry, sections) if entry is not None),
            key=lambda entry: entry.order,
        )
        if language in CJK_LANGUAGES:
            status = self._check_cjk(text, language, entries)
            casing = self._casing_cjk(text, language, entries)
        else:
            status = self._check_regex(text, entries)
            casing = self._casing_regex(text, entries)
        findings = _resolve_overlaps(status, casing)
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings

    def _check_regex(self, text: str, entries: list[_Entry]) -> list[Finding]:
        findings: list[Finding] = []
        for entry in entries:
            for term in entry.reported:
                flags = 0 if term.case_sensitive else re.IGNORECASE
                pattern = rf"\b{re.escape(term.text)}\b"
                for match in re.finditer(pattern, text, flags):
                    findings.append(
                        _status_finding(entry, term, match.group(), match.start(), match.end())
                    )
        return findings

    def _casing_regex(self, text: str, entries: list[_Entry]) -> list[Finding]:
        return _casing_findings(
            text,
            (
                (entry, term, match.group(), match.start(), match.end())
                for entry in entries
                for term in entry.cased
                for match in re.finditer(rf"\b{re.escape(term.text)}\b", text, re.IGNORECASE)
            ),
        )

    def _casing_cjk(
        self, text: str, language: Language, entries: list[_Entry]
    ) -> list[Finding]:
        # Only meaningful for Latin terms embedded in CJK text: pure CJK
        # strings have no case, so lowercasing never changes them.
        cased = [(entry, term) for entry in entries for term in entry.cased]
        if not cased:
            return []
        pipeline = self.nlp.get(language.value) if self.nlp else None
        if pipeline is None:
            return self._casing_substring(text, cased)
        from spacy.matcher import PhraseMatcher

        doc = pipeline.make_doc(text)  # tokenization only
        matcher = PhraseMatcher(pipeline.vocab, attr="LOWER")
        for index, (_, term) in enumerate(cased):
            matcher.add(str(index), [pipeline.make_doc(term.text)])
        matches = sorted(
            (int(pipeline.vocab.strings[match_id]), start, end)
            for match_id, start, end in matcher(doc)
        )
        spans = ((index, doc[start:end]) for index, start, end in matches)
        return _casing_findings(
            text,
            ((*cased[index], span.text, span.start_char, span.end_char) for index, span in spans),
        )

    def _casing_substring(
        self, text: str, cased: list[tuple[_Entry, ConceptTerm]]
    ) -> list[Finding]:
        haystack = text.lower()

        def matches() -> Iterator[tuple[_Entry, ConceptTerm, str, int, int]]:
            for entry, term in cased:
                needle = term.text.lower()
                pos = haystack.find(needle)
                while pos != -1:
                    end = pos + len(needle)
                    yield entry, term, text[pos:end], pos, end
                    pos = haystack.find(needle, pos + 1)

        return _casing_findings(text, matches())

    def _check_cjk(
        self, text: str, language: Language, entries: list[_Entry]
    ) -> list[Finding]:
        pipeline = self.nlp.get(language.value) if self.nlp else None
        if pipeline is None:
            # Documented fallback without a tokenizer: may over-match inside
            # longer words, but keeps terminology working.
            return self._check_substring(text, entries)
        from spacy.matcher import PhraseMatcher

        doc = pipeline.make_doc(text)  # tokenization only
        findings: list[Finding] = []
        for attr, case_sensitive in (("ORTH", True), ("LOWER", False)):
            group = [
                (entry, term)
                for entry in entries
                for term in entry.reported
                if term.case_sensitive is case_sensitive
            ]
            if not group:
                continue
            matcher = PhraseMatcher(pipeline.vocab, attr=attr)
            for index, (_, term) in enumerate(group):
                matcher.add(str(index), [pipeline.make_doc(term.text)])
            for match_id, start, end in matcher(doc):
                entry, term = group[int(pipeline.vocab.strings[match_id])]
                span = doc[start:end]
                findings.append(
                    _status_finding(entry, term, span.text, span.start_char, span.end_char)
                )
        return findings

    def _check_substring(self, text: str, entries: list[_Entry]) -> list[Finding]:
        findings: list[Finding] = []
        for entry in entries:
            for term in entry.reported:
                haystack = text if term.case_sensitive else text.lower()
                needle = term.text if term.case_sensitive else term.text.lower()
                pos = haystack.find(needle)
                while pos != -1:
                    end = pos + len(needle)
                    findings.append(_status_finding(entry, term, text[pos:end], pos, end))
                    pos = haystack.find(needle, pos + 1)
        return findings
