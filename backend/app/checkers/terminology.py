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
_SENTENCE_START = re.compile(r'(?:^|[.!?…]["\')\]]*\s+|\n[\s>#*+-]*)$')


def _sentence_start(text: str, start: int) -> bool:
    return _SENTENCE_START.search(text, 0, start) is not None


def _casing_ok(text: str, start: int, matched: str, preferred: str) -> bool:
    if matched == preferred:
        return True
    capitalized = preferred[0].upper() + preferred[1:]
    return matched == capitalized and _sentence_start(text, start)


class TerminologyChecker:
    def __init__(self, store: TerminologyStore, nlp: "NlpRegistry | None" = None) -> None:
        self.store = store
        self.nlp = nlp

    def check(self, text: str, language: Language, domain_id: int) -> list[Finding]:
        terms = self.store.list_terms(domain_id, language=language)
        if language in CJK_LANGUAGES:
            findings = self._check_cjk(text, language, terms)
        else:
            findings = self._check_regex(text, terms)
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
