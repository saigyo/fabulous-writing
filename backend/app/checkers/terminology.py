import re
from typing import TYPE_CHECKING

from app.core.models import Category, Finding, Language, Severity, Source, Span
from app.services.terminology import TerminologyStore, Term

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


def _casing_ok(text: str, start: int, matched: str, preferred: str) -> bool:
    if matched == preferred:
        return True
    capitalized = preferred[0].upper() + preferred[1:]
    return matched == capitalized and _sentence_start(text, start)


def _without_overlaps(
    casing: list[Finding], variants: list[Finding]
) -> list[Finding]:
    # Variant findings win: drop casing findings on overlapping spans.
    return [
        c
        for c in casing
        if not any(
            c.span.start < v.span.end and v.span.start < c.span.end
            for v in variants
        )
    ]


class TerminologyChecker:
    def __init__(self, store: TerminologyStore, nlp: "NlpRegistry | None" = None) -> None:
        self.store = store
        self.nlp = nlp

    def check(
        self, text: str, language: Language, domain_id: int, *, owner_id: int
    ) -> list[Finding]:
        terms = self.store.list_terms(domain_id, owner_id=owner_id, language=language)
        if terms is None:
            # Invisible domain (foreign or deleted): no findings, through
            # the same store-level ownership check every other term read
            # goes through (spec §5.2).
            return []
        if language in CJK_LANGUAGES:
            variants = self._check_cjk(text, language, terms)
            casing = self._casing_cjk(text, language, terms)
        else:
            variants = self._check_regex(text, terms)
            casing = self._casing_regex(text, terms)
        findings = variants + _without_overlaps(casing, variants)
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings

    def _check_regex(self, text: str, terms: list[Term]) -> list[Finding]:
        findings: list[Finding] = []
        for term in terms:
            flags = 0 if term.case_sensitive else re.IGNORECASE
            for variant in term.forbidden_variants:
                pattern = rf"\b{re.escape(variant)}\b"
                for match in re.finditer(pattern, text, flags):
                    findings.append(
                        self._finding(term, match.group(), match.start(), match.end())
                    )
        return findings

    def _casing_regex(self, text: str, terms: list[Term]) -> list[Finding]:
        findings: list[Finding] = []
        for term in terms:
            if not term.case_sensitive:
                continue
            pattern = rf"\b{re.escape(term.preferred)}\b"
            for match in re.finditer(pattern, text, re.IGNORECASE):
                if _casing_ok(text, match.start(), match.group(), term.preferred):
                    continue
                findings.append(
                    self._finding(term, match.group(), match.start(), match.end())
                )
        return findings

    def _casing_cjk(
        self, text: str, language: Language, terms: list[Term]
    ) -> list[Finding]:
        # Only meaningful for Latin terms embedded in CJK text: pure CJK
        # strings have no case, so lowercasing never changes them.
        cased = [t for t in terms if t.case_sensitive]
        if not cased:
            return []
        pipeline = self.nlp.get(language.value) if self.nlp else None
        if pipeline is None:
            return self._casing_substring(text, cased)
        from spacy.matcher import PhraseMatcher

        doc = pipeline.make_doc(text)  # tokenization only
        matcher = PhraseMatcher(pipeline.vocab, attr="LOWER")
        for index, term in enumerate(cased):
            matcher.add(str(index), [pipeline.make_doc(term.preferred)])
        findings: list[Finding] = []
        for match_id, start, end in matcher(doc):
            term = cased[int(pipeline.vocab.strings[match_id])]
            span = doc[start:end]
            if _casing_ok(text, span.start_char, span.text, term.preferred):
                continue
            findings.append(
                self._finding(term, span.text, span.start_char, span.end_char)
            )
        return findings

    def _casing_substring(self, text: str, cased: list[Term]) -> list[Finding]:
        haystack = text.lower()
        findings: list[Finding] = []
        for term in cased:
            needle = term.preferred.lower()
            pos = haystack.find(needle)
            while pos != -1:
                end = pos + len(needle)
                matched = text[pos:end]
                if not _casing_ok(text, pos, matched, term.preferred):
                    findings.append(self._finding(term, matched, pos, end))
                pos = haystack.find(needle, pos + 1)
        return findings

    def _check_cjk(
        self, text: str, language: Language, terms: list[Term]
    ) -> list[Finding]:
        pipeline = self.nlp.get(language.value) if self.nlp else None
        if pipeline is None:
            # Documented fallback without a tokenizer: may over-match inside
            # longer words, but keeps terminology working.
            return self._check_substring(text, terms)
        from spacy.matcher import PhraseMatcher

        doc = pipeline.make_doc(text)  # tokenization only
        findings: list[Finding] = []
        for attr, case_sensitive in (("ORTH", True), ("LOWER", False)):
            group = [t for t in terms if t.case_sensitive is case_sensitive]
            if not group:
                continue
            matcher = PhraseMatcher(pipeline.vocab, attr=attr)
            variants: list[Term] = []
            for term in group:
                for variant in term.forbidden_variants:
                    matcher.add(str(len(variants)), [pipeline.make_doc(variant)])
                    variants.append(term)
            for match_id, start, end in matcher(doc):
                term = variants[int(pipeline.vocab.strings[match_id])]
                span = doc[start:end]
                findings.append(
                    self._finding(term, span.text, span.start_char, span.end_char)
                )
        return findings

    def _check_substring(self, text: str, terms: list[Term]) -> list[Finding]:
        findings: list[Finding] = []
        for term in terms:
            haystack = text if term.case_sensitive else text.lower()
            for variant in term.forbidden_variants:
                needle = variant if term.case_sensitive else variant.lower()
                pos = haystack.find(needle)
                while pos != -1:
                    end = pos + len(needle)
                    findings.append(self._finding(term, text[pos:end], pos, end))
                    pos = haystack.find(needle, pos + 1)
        return findings

    def _finding(self, term: Term, matched: str, start: int, end: int) -> Finding:
        message = f"Use '{term.preferred}' instead of '{matched}'."
        if term.definition:
            message += f" {term.definition}"
        return Finding(
            category=Category.TERMINOLOGY,
            severity=Severity.ERROR,
            source=Source.TERMINOLOGY,
            rule_id=f"terminology.{term.id}",
            message=message,
            span=Span(start=start, end=end, text=matched),
            suggestions=[term.preferred],
        )
