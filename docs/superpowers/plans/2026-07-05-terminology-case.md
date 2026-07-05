# Terminology Case Sensitivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Case-sensitive terms also enforce the casing of the *preferred* term (with a sentence-start exception), and the cryptic add-row checkbox becomes a match-case "Aa" toggle button plus an "Aa" badge on existing rows.

**Architecture:** Pure additions to `TerminologyChecker` — module-level helpers (`_sentence_start`, `_casing_ok`, `_without_overlaps`) plus one casing pass per existing matching path (regex / CJK PhraseMatcher / substring fallback), merged in `check()` with variant findings winning on overlap. Frontend is JSX/CSS only; no API or DB changes (`case_sensitive` is already stored and transported).

**Tech Stack:** Python/FastAPI backend (pytest), React + TypeScript frontend (vitest for logic — none extractable here, so lint/build/live verification), spaCy PhraseMatcher for CJK.

**Spec:** `docs/superpowers/specs/2026-07-05-terminology-case-design.md`

---

### Task 1: Casing-acceptance helpers

**Files:**
- Modify: `backend/app/checkers/terminology.py`
- Test: `backend/tests/test_terminology.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_terminology.py`:

```python
class TestCasingHelpers:
    def test_exact_casing_is_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        assert _casing_ok("Use GitHub now", 4, "GitHub", "GitHub") is True

    def test_wrong_casing_is_not_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        assert _casing_ok("Use Github now", 4, "Github", "GitHub") is False
        assert _casing_ok("Use GITHUB now", 4, "GITHUB", "GitHub") is False

    def test_capitalized_at_sentence_start_is_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        assert _casing_ok("Sign in here.", 0, "Sign in", "sign in") is True
        text = "Great. Sign in here."
        assert _casing_ok(text, 7, "Sign in", "sign in") is True
        text = "Intro:\n- Sign in here."
        assert _casing_ok(text, 9, "Sign in", "sign in") is True

    def test_capitalized_mid_sentence_is_not_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        text = "Please Sign in here."
        assert _casing_ok(text, 7, "Sign in", "sign in") is False

    def test_title_case_at_sentence_start_is_not_ok(self) -> None:
        from app.checkers.terminology import _casing_ok

        assert _casing_ok("Sign In here.", 0, "Sign In", "sign in") is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_terminology.py::TestCasingHelpers -v`
Expected: FAIL — `ImportError: cannot import name '_casing_ok'`

- [ ] **Step 3: Implement the helpers**

In `backend/app/checkers/terminology.py`, below the `CJK_LANGUAGES` constant, add:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_terminology.py -v`
Expected: all PASS (new class and pre-existing tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/checkers/terminology.py backend/tests/test_terminology.py
git commit -m "Add casing-acceptance helpers to terminology checker

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Preferred-casing enforcement, regex path

**Files:**
- Modify: `backend/app/checkers/terminology.py`
- Test: `backend/tests/test_terminology.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_terminology.py`:

```python
class TestPreferredCasing:
    def _github_domain(self, store: TerminologyStore) -> int:
        domain = store.create_domain("Dev")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="GitHub",
            forbidden_variants=["Git Hub"],
            case_sensitive=True,
        )
        return domain.id

    def test_flags_wrong_casing_of_preferred(self, store: TerminologyStore) -> None:
        domain_id = self._github_domain(store)
        checker = TerminologyChecker(store)
        findings = checker.check("We are on github now.", Language.EN, domain_id)
        assert len(findings) == 1
        f = findings[0]
        assert f.span.text == "github"
        assert f.suggestions == ["GitHub"]
        assert "GitHub" in f.message

    def test_correct_casing_is_not_flagged(self, store: TerminologyStore) -> None:
        domain_id = self._github_domain(store)
        checker = TerminologyChecker(store)
        assert checker.check("We are on GitHub now.", Language.EN, domain_id) == []

    def test_case_insensitive_term_is_not_casing_checked(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Dev")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login"],
        )
        checker = TerminologyChecker(store)
        assert checker.check("SIGN IN here.", Language.EN, domain.id) == []

    def test_sentence_start_capitalization_is_allowed(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Dev")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="sign in",
            forbidden_variants=["login"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store)
        assert checker.check("Sign in to your account.", Language.EN, domain.id) == []
        findings = checker.check("Please Sign In now.", Language.EN, domain.id)
        assert len(findings) == 1
        assert findings[0].span.text == "Sign In"

    def test_casing_finding_overlapping_variant_is_dropped(
        self, store: TerminologyStore
    ) -> None:
        domain = store.create_domain("Dev")
        store.create_term(
            domain.id,
            language=Language.EN,
            preferred="GitHub",
            forbidden_variants=["Github Enterprise"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store)
        findings = checker.check("Use Github Enterprise.", Language.EN, domain.id)
        assert len(findings) == 1
        assert findings[0].span.text == "Github Enterprise"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_terminology.py::TestPreferredCasing -v`
Expected: FAIL — wrong-casing/overlap tests find 0 findings (feature missing); the
two negative tests may already pass.

- [ ] **Step 3: Implement the regex casing pass and merge**

In `backend/app/checkers/terminology.py`:

Add below `_casing_ok`:

```python
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
```

Replace the body of `check()`:

```python
    def check(self, text: str, language: Language, domain_id: int) -> list[Finding]:
        terms = self.store.list_terms(domain_id, language=language)
        if language in CJK_LANGUAGES:
            variants = self._check_cjk(text, language, terms)
            casing = self._casing_cjk(text, language, terms)
        else:
            variants = self._check_regex(text, terms)
            casing = self._casing_regex(text, terms)
        findings = variants + _without_overlaps(casing, variants)
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return findings
```

Add the regex casing pass (after `_check_regex`); `_casing_cjk` is Task 3 — for
this task add a stub returning `[]` so `check()` stays runnable:

```python
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
        return []  # implemented with the CJK paths (next task)
```

- [ ] **Step 4: Run the full backend suite**

Run: `cd backend && uv run pytest`
Expected: all PASS (previous behavior unchanged for case-insensitive terms)

- [ ] **Step 5: Commit**

```bash
git add backend/app/checkers/terminology.py backend/tests/test_terminology.py
git commit -m "Enforce preferred-term casing for case-sensitive terms (regex path)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Preferred-casing enforcement, CJK paths

**Files:**
- Modify: `backend/app/checkers/terminology.py`
- Test: `backend/tests/test_terminology.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_terminology.py` (inside `TestCjkChecker`):

```python
    def test_ja_flags_wrong_casing_of_embedded_latin_preferred(
        self, store: TerminologyStore
    ) -> None:
        from app.core.config import NlpSettings
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev")
        store.create_term(
            domain.id,
            language=Language.JA,
            preferred="GitHub",
            forbidden_variants=["ギットハブ"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry(NlpSettings().models))
        text = "コードは Github にあります。"
        findings = checker.check(text, Language.JA, domain.id)
        assert len(findings) == 1
        assert findings[0].span.text == "Github"
        assert findings[0].suggestions == ["GitHub"]
        assert checker.check("コードは GitHub にあります。", Language.JA, domain.id) == []

    def test_cjk_substring_fallback_checks_preferred_casing(
        self, store: TerminologyStore
    ) -> None:
        from app.nlp.registry import NlpRegistry

        domain = store.create_domain("dev")
        store.create_term(
            domain.id,
            language=Language.JA,
            preferred="GitHub",
            forbidden_variants=["ギットハブ"],
            case_sensitive=True,
        )
        checker = TerminologyChecker(store, nlp=NlpRegistry({"ja": "xx_bogus_model"}))
        findings = checker.check("コードは Github にあります。", Language.JA, domain.id)
        assert len(findings) == 1
        assert findings[0].span.text == "Github"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_terminology.py::TestCjkChecker -v`
Expected: the two new tests FAIL with 0 findings (stub returns `[]`); the three
pre-existing CJK tests still PASS.

- [ ] **Step 3: Implement the CJK casing passes**

In `backend/app/checkers/terminology.py`, replace the `_casing_cjk` stub with:

```python
    def _casing_cjk(
        self, text: str, language: Language, terms: list[Term]
    ) -> list[Finding]:
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
```

- [ ] **Step 4: Run the full backend suite**

Run: `cd backend && uv run pytest`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/checkers/terminology.py backend/tests/test_terminology.py
git commit -m "Enforce preferred-term casing on the CJK terminology paths

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Match-case toggle button and row badge (frontend)

**Files:**
- Modify: `frontend/src/terminology/TerminologyView.tsx`
- Modify: `frontend/src/App.css`

No component-test harness exists in this repo (vitest covers pure logic only) and
this change is JSX/CSS with no extractable logic — verification is lint, build,
and the live check in Task 5.

- [ ] **Step 1: Replace the checkbox with a toggle button in the add row**

In `frontend/src/terminology/TerminologyView.tsx`, replace the forbidden-variants
cell of the add row (currently a bare `<input>`) with:

```tsx
            <td>
              <div className="input-with-toggle">
                <input
                  value={variants}
                  placeholder={m.forbiddenPlaceholder}
                  onChange={(event) => setVariants(event.target.value)}
                />
                <button
                  type="button"
                  className="match-case-toggle"
                  aria-pressed={caseSensitive}
                  title={m.caseSensitiveTitle}
                  onClick={() => setCaseSensitive((value) => !value)}
                >
                  Aa
                </button>
              </div>
            </td>
```

and shrink the last cell (currently `.case-label` + button) to just:

```tsx
            <td>
              <button onClick={() => void addTerm()}>{m.add}</button>
            </td>
```

- [ ] **Step 2: Show an "Aa" badge on case-sensitive rows**

In the same file, extend the forbidden-variants cell of existing rows from
`<td>{term.forbidden_variants.join(', ')}</td>` to:

```tsx
              <td>
                {term.forbidden_variants.join(', ')}
                {term.case_sensitive && (
                  <span className="case-badge" title={m.caseSensitiveTitle}>
                    Aa
                  </span>
                )}
              </td>
```

- [ ] **Step 3: CSS — remove `.case-label`, add the new styles**

In `frontend/src/App.css`, delete the `.case-label` rule and add in its place:

```css
.input-with-toggle {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.match-case-toggle {
  flex: none;
  font-size: 0.75rem;
  padding: 0.15rem 0.35rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
}

.match-case-toggle[aria-pressed='true'] {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.case-badge {
  margin-left: 0.4rem;
  font-size: 0.7rem;
  padding: 0 0.25rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-dim);
}
```

- [ ] **Step 4: Lint, test, build**

Run: `cd frontend && npm run lint && npm test && npm run build`
Expected: lint clean apart from the two pre-existing exhaustive-deps warnings;
all vitest suites PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/terminology/TerminologyView.tsx frontend/src/App.css
git commit -m "Replace case-sensitivity checkbox with match-case toggle and row badge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Live verification, screenshots, docs

**Files:**
- Modify: `README.md` (terminology section)
- Modify: `docs/images/terminology.png` (refresh)
- Modify: `docs/LOGBOOK.md`

- [ ] **Step 1: Live end-to-end verification (both dev servers running)**

Backend API (checker semantics at the surface):

```bash
# create a case-sensitive term via the API, then check wrong casing
curl -s -X POST localhost:8000/api/domains -H 'Content-Type: application/json' \
  -d '{"name": "Verify"}'
curl -s -X POST localhost:8000/api/domains/<id>/terms -H 'Content-Type: application/json' \
  -d '{"language": "en", "preferred": "GitHub", "forbidden_variants": ["Git Hub"], "case_sensitive": true}'
curl -s -X POST localhost:8000/api/checks -H 'Content-Type: application/json' \
  -d '{"text": "We are on github. Sign in there.", "language": "en", "domain_id": <id>, "checkers": ["terminology"]}'
```

Expected: a terminology finding on `github` suggesting `GitHub`; no finding on
"Sign in" for a case-sensitive lowercase term at sentence start. Delete the
Verify domain afterwards.

Browser (frontend behavior): open the Terminology tab —
- toggle button shows pressed state when clicked, tooltip explains it,
  nothing wraps at narrow widths (the original bug);
- adding a term with the toggle pressed produces a row with the "Aa" badge;
- a wrong-casing occurrence in the editor is flagged with a one-click fix.

- [ ] **Step 2: Refresh the terminology screenshot**

Run: `cd frontend && npm run screenshots`
Then check `docs/images/terminology.png` shows the new add row.

- [ ] **Step 3: README note**

In the Terminology section of `README.md`, extend the first paragraph:

> A term has a preferred form, forbidden variants, an optional definition, and a
> language; forbidden variants found in the text are flagged with the preferred
> term as a one-click fix. Marking a term *case-sensitive* (the "Aa" toggle) makes
> variants match exact-case and additionally flags wrong casing of the preferred
> term itself (e.g. "Github" → "GitHub") — conventional capitalization at sentence
> starts is allowed.

(Adapt to the actual paragraph wording in the current README structure.)

- [ ] **Step 4: Logbook entry**

Append a `## 2026-07-05 — Terminology case sensitivity` entry to
`docs/LOGBOOK.md` with the commit pointers from Tasks 1–4, summarizing: one-flag
semantics ("casing matters"), the sentence-start heuristic, overlap suppression,
the three matching paths, and the toggle/badge UI.

- [ ] **Step 5: Commit and push**

```bash
git add README.md docs/images/terminology.png docs/LOGBOOK.md
git commit -m "Document terminology case-sensitivity semantics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

Then confirm Backend CI and Frontend CI pass on the pushed commits.
