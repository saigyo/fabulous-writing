# Advice Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parenthesized LLM "suggestions" that are really advice render as non-clickable 💡 notes instead of appliable replacement buttons.

**Architecture:** A pure `split_advice` helper in the vetting module classifies fully-parenthesized candidates as advice BEFORE any vetting, at both surfaces (check-time findings and the `/api/suggestions` endpoint). `Finding` and `SuggestionResponse` gain additive `advice: list[str]` fields; the frontend stores on-demand advice per finding (held-back-maps lifecycle) and renders all advice as plain notes. All three prompt templates gain a rule pushing advice into the message/explanation instead.

**Tech Stack:** FastAPI + pydantic, pytest; React 19 + zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-advice-notes-design.md`

## Global Constraints

- Backend commands run from `backend/` via `uv run`; frontend from `frontend/` via npm.
- Commits go directly on `main`; every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Advice detection: a candidate whose `strip()`ed text starts with `(` or `（` AND ends with `)` or `）` (mixed pairs count), length ≥ 3, with non-empty inner content after stripping one wrapper layer. Inner parentheses preserved.
- `split_advice` runs BEFORE all vetting stages at both surfaces: advice is never spell-gated, never counted in `rejected`, never in `held_back`. It also runs when vetting is disabled.
- `Finding.advice` and `SuggestionResponse.advice` default to empty lists (additive; older clients unaffected).
- Advice notes are plain text in the UI — no click handler, no button element, class `advice-note`.
- No new i18n keys (the note body is the advice text itself).
- Never touch `backend/data/fabulous.db`; tests use `tmp_path`/FakeProvider; e2e uses scratch text only. The owner's dev servers on :5173/:8000 may be running — do not kill or restart them.

---

### Task 1: `split_advice` helper

**Files:**
- Modify: `backend/app/checkers/llm/vetting.py`
- Test: `backend/tests/test_vetting.py`

**Interfaces:**
- Produces: `split_advice(candidates: list[str]) -> tuple[list[str], list[str]]` — `(replacements, advice)`, both order-preserving; advice strings have one wrapper layer stripped and are `strip()`ed.

- [ ] **Step 1: Write the failing tests** (new class in `backend/tests/test_vetting.py`, after `TestSanity`; extend the module's first import line to `from app.checkers.llm.vetting import split_advice, vet_candidates`)

```python
class TestSplitAdvice:
    def test_parenthesized_candidate_is_advice(self) -> None:
        replacements, advice = split_advice(
            ["better text", "(Consider moving this sentence.)"]
        )
        assert replacements == ["better text"]
        assert advice == ["Consider moving this sentence."]

    def test_fullwidth_and_mixed_wrappers(self) -> None:
        _, advice = split_advice(["（この文を移動してください。）", "(混在フォーム）"])
        assert advice == ["この文を移動してください。", "混在フォーム"]

    def test_single_layer_stripped_inner_parens_preserved(self) -> None:
        _, advice = split_advice(["((keep (this) inner))"])
        assert advice == ["(keep (this) inner)"]

    def test_containing_parens_is_a_replacement(self) -> None:
        replacements, advice = split_advice(["use the editor (v2) daily"])
        assert replacements == ["use the editor (v2) daily"]
        assert advice == []

    def test_empty_wrappers_are_not_advice(self) -> None:
        # No inner content means "not wrapped advice": both stay candidates
        # (the sanity stage kills them later as artifacts/too short).
        replacements, advice = split_advice(["()", "( )"])
        assert replacements == ["()", "( )"]
        assert advice == []

    def test_order_preserved_within_each_list(self) -> None:
        replacements, advice = split_advice(["a", "(x)", "b", "(y)"])
        assert replacements == ["a", "b"]
        assert advice == ["x", "y"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_vetting.py -v -k SplitAdvice`
Expected: FAIL — `ImportError: cannot import name 'split_advice'`

- [ ] **Step 3: Implement in `vetting.py`** (module level, directly above `def _sane`)

```python
_ADVICE_OPEN = "(（"
_ADVICE_CLOSE = ")）"


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
```

- [ ] **Step 4: Run the vetting suite, then the full suite**

Run: `uv run pytest tests/test_vetting.py -v` → all PASS.
Run: `uv run pytest` → 626 passed (620 existing + 6 new), zero warnings.

- [ ] **Step 5: Commit**

```bash
git add app/checkers/llm/vetting.py tests/test_vetting.py
git commit -m "feat: split_advice classifies parenthesized candidates as advice

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `Finding.advice` + checker split + check-prompt rule

**Files:**
- Modify: `backend/app/core/models.py` (Finding, ~line 53)
- Modify: `backend/app/checkers/llm/checker.py` (~lines 132-151)
- Modify: `backend/app/checkers/llm/prompts.py` (`_SYSTEM_TEMPLATE` Rules block, ~line 56)
- Test: `backend/tests/test_llm_checker.py`, `backend/tests/test_prompts.py`

**Interfaces:**
- Consumes: `split_advice` from Task 1.
- Produces: `Finding.advice: list[str]` (pydantic, `Field(default_factory=list)`) — serialized on every findings payload (SSE + polling) automatically.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_llm_checker.py` (module already has async tests and imports json/LLMChecker/FakeProvider/Language locally in test bodies — follow `test_inline_suggestions_are_vetted_but_finding_survives` directly above):

```python
async def test_parenthesized_suggestions_become_advice():
    import json

    from app.checkers.llm.checker import LLMChecker
    from app.checkers.llm.provider import FakeProvider
    from app.core.models import Language

    text = "You will get updates."
    response = json.dumps(
        [
            {
                "category": "style",
                "severity": "suggestion",
                "quote": "get updates",
                "message": "Vague verb.",
                "suggestions": [
                    "(Consider restructuring the whole sentence.)",
                    "receive updates",
                ],
            }
        ]
    )
    result = await LLMChecker(FakeProvider(response)).check(text, Language.EN)
    assert result.findings[0].suggestions == ["receive updates"]
    assert result.findings[0].advice == ["Consider restructuring the whole sentence."]
```

Append to `backend/tests/test_prompts.py` (extend its `from app.checkers.llm.prompts import (...)` block with `_SYSTEM_TEMPLATE`):

```python
def test_check_prompt_forbids_disguised_advice() -> None:
    assert "Never disguise advice" in _SYSTEM_TEMPLATE
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_llm_checker.py::test_parenthesized_suggestions_become_advice tests/test_prompts.py::test_check_prompt_forbids_disguised_advice -v`
Expected: 2 FAILED — `Finding` has no attribute `advice`; assertion on template text.

- [ ] **Step 3: Implement**

`backend/app/core/models.py` — extend `Finding`:

```python
class Finding(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    category: Category
    severity: Severity
    source: Source
    rule_id: str | None = None
    message: str
    span: Span
    suggestions: list[str] = Field(default_factory=list)
    advice: list[str] = Field(default_factory=list)
```

`backend/app/checkers/llm/checker.py` — extend the import (line 14) to `from .vetting import split_advice, vet_candidates`, then change the loop body:

```python
        for raw in raw_findings:
            span = anchor(text, raw.quote, raw.context_before)
            if span is None:
                continue
            # Advice is presented, never applied — and never vetted: even an
            # unknown word in advice is fine to display.
            suggestions, advice = split_advice(raw.suggestions)
            if self.vet and suggestions:
                # Cheap stages only; a bad fix does not invalidate the diagnosis.
                suggestions = vet_candidates(
                    suggestions,
                    original=span.text,
                    text=text,
                    language=language,
                    dictionaries_dir=self.dictionaries_dir,
                ).accepted
            findings.append(
                Finding(
                    category=raw.category,
                    severity=raw.severity,
                    source=Source.LLM,
                    message=raw.message,
                    span=span,
                    suggestions=suggestions,
                    advice=advice,
                )
            )
```

`backend/app/checkers/llm/prompts.py` — in `_SYSTEM_TEMPLATE`'s Rules block, directly after the line `- Each suggestion must be a drop-in replacement for the quote.`, add:

```
- Never disguise advice or commentary as a suggestion. If you cannot offer a literal \
drop-in replacement, use an empty "suggestions" array and put the advice in "message".
```

- [ ] **Step 4: Run the full backend suite**

Run: `uv run pytest`
Expected: 628 passed, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add app/core/models.py app/checkers/llm/checker.py app/checkers/llm/prompts.py tests/test_llm_checker.py tests/test_prompts.py
git commit -m "feat: check-time findings carry parenthesized advice separately

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Endpoint split + `SuggestionResponse.advice` + suggest/rewrite prompt rules

**Files:**
- Modify: `backend/app/api/suggestions.py`
- Modify: `backend/app/checkers/llm/prompts.py` (`_SUGGESTION_SYSTEM_TEMPLATE` ~line 75, `_REWRITE_SYSTEM_TEMPLATE` ~line 91)
- Test: `backend/tests/test_suggestions_api.py`

**Interfaces:**
- Consumes: `split_advice` from Task 1.
- Produces: `SuggestionResponse.advice: list[str] = []` (JSON key `advice`) — used by Task 4.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_suggestions_api.py`, add a new top-level class after `TestSentenceScope`:

```python
class TestAdvice:
    def test_parenthesized_candidates_become_advice(self, tmp_path: Path) -> None:
        provider = FakeProvider(
            json.dumps(["excellent", "(Consider rephrasing the whole paragraph.)"])
        )
        client = make_client(tmp_path, provider)
        body = client.post("/api/suggestions", json=suggestion_request()).json()
        assert body["suggestions"] == ["excellent"]
        assert body["advice"] == ["Consider rephrasing the whole paragraph."]
        assert body["rejected"] == 0

    def test_all_advice_is_no_replacement_not_rejection(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["(Move this sentence elsewhere.)"]))
        client = make_client(tmp_path, provider)
        body = client.post("/api/suggestions", json=suggestion_request()).json()
        assert body["suggestions"] == []
        assert body["advice"] == ["Move this sentence elsewhere."]
        assert body["rejected"] == 0
        assert body["held_back"] == []
```

Add to the existing `class TestVetting`:

```python
    def test_kill_switch_still_splits_advice(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["(Ganz umstellen.)"]))
        client = self.make_client(tmp_path, provider, vet=False)
        body = client.post("/api/suggestions", json=self.de_request()).json()
        assert body["suggestions"] == []
        assert body["advice"] == ["Ganz umstellen."]
```

Add to the existing `class TestSuggestionPrompt` (extend the module's prompts import to include `build_rewrite_prompt`):

```python
    def test_suggest_and_rewrite_prompts_forbid_disguised_advice(self) -> None:
        system, _ = build_suggestion_prompt(
            TEXT, 17, 26, "'very good' is vague praise.", Language.EN
        )
        assert "Never disguise advice" in system
        system, _ = build_rewrite_prompt(
            "The results were very good.", "'very good' is vague praise.", Language.EN
        )
        assert "Never disguise advice" in system
```

Update the exact-dict assertion in `TestSuggestionsEndpoint::test_returns_parsed_suggestions_and_echoes_span` to include the new key:

```python
        assert response.json() == {
            "suggestions": ["outstanding", "remarkably clear"],
            "span": {"start": 17, "end": 26},
            "original": "very good",
            "rejected": 0,
            "held_back": [],
            "advice": [],
        }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_suggestions_api.py -v`
Expected: the four new tests FAIL (`KeyError: 'advice'` / prompt-text assertions), plus the exact-dict test FAILs on the missing key until Step 3.

- [ ] **Step 3: Implement**

`backend/app/api/suggestions.py` — extend the vetting import (line 9) to
`from app.checkers.llm.vetting import split_advice, vet_suggestions`; extend the response model:

```python
class SuggestionResponse(BaseModel):
    suggestions: list[str]
    span: SpanRef
    original: str
    rejected: int = 0
    held_back: list[HeldBackSuggestion] = []
    advice: list[str] = []
```

In `create_suggestions`, directly after the `suggestions = [...]` comprehension and before `rejected = 0`, insert:

```python
    # Advice must never render as an appliable replacement; split it off
    # before vetting (also when vetting is disabled).
    suggestions, advice = split_advice(suggestions)
```

and add `advice=advice` to the returned `SuggestionResponse(...)`.

`backend/app/checkers/llm/prompts.py` — in `_SUGGESTION_SYSTEM_TEMPLATE`, directly BEFORE the line `- Respond with ONLY a JSON array of strings, e.g. ["first option", "second option"].`, add:

```
- Never disguise advice or commentary as a replacement. If you cannot offer a literal \
drop-in replacement, return an empty JSON array [].
```

In `_REWRITE_SYSTEM_TEMPLATE`, directly BEFORE the line `- Respond with ONLY a JSON array of strings, e.g. ["first rewrite", "second rewrite"].`, add the same two lines.

- [ ] **Step 4: Run the API tests, then the full suite**

Run: `uv run pytest tests/test_suggestions_api.py -v` → all PASS.
Run: `uv run pytest` → 632 passed, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add app/api/suggestions.py app/checkers/llm/prompts.py tests/test_suggestions_api.py
git commit -m "feat: suggestions API splits advice from replacements

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend data layer — types, store, fetch flows

**Files:**
- Modify: `frontend/src/types.ts` (Finding interface, ~line 30)
- Modify: `frontend/src/api/client.ts` (SuggestionResponse)
- Modify: `frontend/src/state/store.ts`
- Modify: `frontend/src/checking/suggest.ts`
- Test: `frontend/src/state/store.test.ts`

**Interfaces:**
- Consumes: API field `advice` from Task 3; `Finding.advice` from Task 2.
- Produces (used by Task 5): `Finding.advice: string[]` in `types.ts`; store maps `suggestAdvice: Record<string, string[]>` / `rewriteAdvice: Record<string, string[]>` with setters `setSuggestAdvice(findingId, advice | null)` / `setRewriteAdvice(findingId, advice | null)` (null removes).

- [ ] **Step 1: Write the failing tests** (append to `frontend/src/state/store.test.ts`)

```ts
describe('advice notes', () => {
  it('stores and clears suggest advice per finding', () => {
    useStore.getState().setSuggestAdvice('f1', ['Move this sentence.'])
    expect(useStore.getState().suggestAdvice['f1']).toEqual(['Move this sentence.'])
    useStore.getState().setSuggestAdvice('f1', null)
    expect(useStore.getState().suggestAdvice['f1']).toBeUndefined()
  })

  it('stores and clears rewrite advice per finding', () => {
    useStore.getState().setRewriteAdvice('f1', ['Split into two paragraphs.'])
    expect(useStore.getState().rewriteAdvice['f1']).toEqual(['Split into two paragraphs.'])
    useStore.getState().setRewriteAdvice('f1', null)
    expect(useStore.getState().rewriteAdvice['f1']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/state/store.test.ts`
Expected: FAIL — `setSuggestAdvice is not a function`.

- [ ] **Step 3: Implement**

`frontend/src/types.ts` — add to the `Finding` interface (after `suggestions: string[]`; read the interface first — it also has `span`):

```ts
  advice: string[]
```

`frontend/src/api/client.ts` — extend `SuggestionResponse`:

```ts
export interface SuggestionResponse {
  suggestions: string[]
  span: { start: number; end: number }
  original: string
  rejected: number
  held_back: HeldBackSuggestion[]
  advice: string[]
}
```

`frontend/src/state/store.ts` — mirror the `suggestHeldBack`/`rewriteHeldBack` slices exactly (state fields, action types, initial `{}` values, `migrateByFinding` block, `withEntry` setters; NOT in `partialize`):

```ts
// state fields (next to suggestHeldBack/rewriteHeldBack):
  suggestAdvice: Record<string, string[]>
  rewriteAdvice: Record<string, string[]>

// action types:
  setSuggestAdvice: (findingId: string, advice: string[] | null) => void
  setRewriteAdvice: (findingId: string, advice: string[] | null) => void

// initial values:
      suggestAdvice: {},
      rewriteAdvice: {},

// in the migrateByFinding block:
            suggestAdvice: migrateByFinding(state.suggestAdvice, idMap),
            rewriteAdvice: migrateByFinding(state.rewriteAdvice, idMap),

// setters:
      setSuggestAdvice: (findingId, advice) =>
        set((state) => ({
          suggestAdvice: withEntry(state.suggestAdvice, findingId, advice),
        })),
      setRewriteAdvice: (findingId, advice) =>
        set((state) => ({
          rewriteAdvice: withEntry(state.rewriteAdvice, findingId, advice),
        })),
```

`frontend/src/checking/suggest.ts` — in `fetchSuggestions`, add the clear at fetch start (after `state.setSuggestHeldBack(findingId, null)`):

```ts
  state.setSuggestAdvice(findingId, null)
```

and in the `if (result)` block, immediately after `const store = useStore.getState()` (advice accompanies BOTH outcomes):

```ts
      store.setSuggestAdvice(
        findingId,
        result.advice.length > 0 ? result.advice : null,
      )
```

Mirror in `fetchRewrite`: `state.setRewriteAdvice(findingId, null)` at start; after its `const store = useStore.getState()`:

```ts
      store.setRewriteAdvice(
        findingId,
        result.advice.length > 0 ? result.advice : null,
      )
```

Note: `types.ts` adding a required `advice: string[]` to `Finding` may break test fixtures or code constructing `Finding` objects. Search first: `grep -rn "severity:" frontend/src --include="*.test.ts" -l` and fix fixtures by adding `advice: []`. If many sites construct findings, prefer keeping the field required and updating fixtures (backend always sends it).

- [ ] **Step 4: Run tests, lint, build**

Run: `npm test` → all pass. `npm run lint` → 0 warnings. `npm run build` → green.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/api/client.ts src/state/store.ts src/checking/suggest.ts src/state/store.test.ts
# plus any test fixtures updated for the new Finding.advice field
git commit -m "feat: frontend carries advice separately from suggestions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: AdviceNotes rendering + CSS

**Files:**
- Modify: `frontend/src/sidebar/Sidebar.tsx` (`SuggestionArea`, `RewriteArea`, new `AdviceNotes`)
- Modify: `frontend/src/App.css` (after the `.held-back-reason` rule)

**Interfaces:**
- Consumes: `Finding.advice`, store maps + setters from Task 4.
- Produces: CSS class `advice-note`.

- [ ] **Step 1: Add the `AdviceNotes` component** (module level in `Sidebar.tsx`, next to `HeldBackList`)

```tsx
const NO_ADVICE: string[] = []

function AdviceNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null
  return (
    <>
      {notes.map((note) => (
        <p key={note} className="advice-note">
          💡 {note}
        </p>
      ))}
    </>
  )
}
```

- [ ] **Step 2: Wire `SuggestionArea`**

Add the hook at the top (with the other hooks, before any early return):

```tsx
  const fetchedAdvice = useStore((s) => s.suggestAdvice[finding.id]) ?? NO_ADVICE
```

and directly after the hooks:

```tsx
  const advice = [...finding.advice, ...fetchedAdvice]
```

Render `<AdviceNotes notes={advice} />`:
- in the `suggestions.length > 0` branch, after the mapped buttons (inside the `.suggestions` div);
- in the `fetched` branch: change it to

```tsx
  if (fetched) {
    return (
      <div className="suggestions">
        <p className="suggest-status">{m.noReplacement}</p>
        <AdviceNotes notes={advice} />
      </div>
    )
  }
```

- in the final branch (fetch button + error + held-back), after the `HeldBackList` block, still inside the `.suggestions` div.
The `pending` branch stays untouched.

- [ ] **Step 3: Wire `RewriteArea`**

Hook at the top:

```tsx
  const advice = useStore((s) => s.rewriteAdvice[finding.id]) ?? NO_ADVICE
```

(no `finding.advice` here — check-time advice belongs to `SuggestionArea`; do not render it twice.)

Render `<AdviceNotes notes={advice} />`:
- in the options branch (`rewrite && rewrite.options.length > 0`), after the mapped buttons inside the `.rewrites` div;
- in the `rewrite` (no options) branch: change it to

```tsx
  if (rewrite) {
    return (
      <div className="rewrites">
        <p className="suggest-status">{m.noRewrite}</p>
        <AdviceNotes notes={advice} />
      </div>
    )
  }
```

- in the final branch, after the `HeldBackList` block inside the `.rewrites` div.
The `pending` branch stays untouched.

- [ ] **Step 4: CSS in `App.css`** (directly after the `.held-back-reason` rule)

```css
.advice-note {
  margin: 0.4rem 0 0;
  font-size: 0.78rem;
  font-style: italic;
  color: #6b7280;
}
```

- [ ] **Step 5: Tests, lint, build**

Run: `npm test` → all pass. `npm run lint` → 0 warnings. `npm run build` → green.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/Sidebar.tsx src/App.css
git commit -m "feat: render LLM advice as non-clickable notes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: E2E verification and documentation

**Files:**
- Create: scratchpad script (session scratchpad dir, NOT the repo): `verify-advice-notes.mjs`
- Modify: `docs/backend-architecture.md` (vetting/suggestions sections), `docs/frontend-architecture.md` (sidebar section), `docs/LOGBOOK.md`

**Interfaces:** consumes the full stack from Tasks 1–5.

- [ ] **Step 1: Headless e2e with a stubbed suggestions response**

Dev servers must already be running (`lsof -nP -iTCP:5173 -sTCP:LISTEN`; do not start/restart them). Script (absolute playwright-core import; run with `SCRATCH=<scratchpad dir> node verify-advice-notes.mjs`):

```js
import { chromium } from '/Users/markus/IdeaProjects/fabulous-writing/frontend/node_modules/playwright-core/index.mjs'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

await page.route('**/api/suggestions', (route) =>
  route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      suggestions: ['much better wording'],
      span: { start: 0, end: 18 },
      original: 'The results were v',
      rejected: 0,
      held_back: [],
      advice: ['Move this sentence to its own paragraph.'],
    }),
  }),
)

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
await page.locator('.cm-content').click()
await page.keyboard.press('Meta+a')
await page.keyboard.type('The results were very good and the team was happy overall.')
await page.waitForTimeout(2500)
await page.locator('.finding-row').first().click()
await page.locator('.suggestion-button.suggest-fix').first().click()
await page.locator('.advice-note').first().waitFor({ timeout: 5000 })

const notes = await page.locator('.advice-note').allTextContents()
console.log('advice notes:', notes)
if (!notes.some((n) => n.includes('Move this sentence to its own paragraph.')))
  throw new Error('advice note missing')

// The note must not be a button and must not react to clicks.
const tag = await page.locator('.advice-note').first().evaluate((el) => el.tagName)
if (tag !== 'P') throw new Error(`advice note is <${tag}>, expected <P>`)
const buttons = await page.locator('.suggestions .suggestion-button:not(.suggest-fix)').allTextContents()
console.log('replacement buttons:', buttons)
if (buttons.length !== 1 || !buttons[0].includes('much better wording'))
  throw new Error('expected exactly one real replacement button')

const before = await page.locator('.cm-content').innerText()
await page.locator('.advice-note').first().click()
await page.waitForTimeout(300)
const after = await page.locator('.cm-content').innerText()
if (before !== after) throw new Error('clicking the advice note changed the text')

await page.locator('.sidebar').screenshot({ path: `${process.env.SCRATCH ?? '.'}/advice-note.png` })
await browser.close()
console.log('DONE')
```

Expected: one replacement button, one 💡 note rendered as `<p>`, clicking the note leaves the editor text unchanged; screenshot saved.

- [ ] **Step 2: Update architecture docs**

`docs/backend-architecture.md` (vetting/suggestions paragraphs): `split_advice` classifies fully-parenthesized candidates as advice before any vetting at both surfaces; `Finding.advice` and `SuggestionResponse.advice` carry it; advice is never vetted, rejected, or held back; all three prompt templates forbid disguised advice.

`docs/frontend-architecture.md` (sidebar section): advice renders as non-clickable 💡 notes (`AdviceNotes`, class `advice-note`) — check-time `finding.advice` plus per-finding `suggestAdvice`/`rewriteAdvice` maps with the held-back maps' lifecycle.

- [ ] **Step 3: LOGBOOK entry**

Append an entry dated per `date '+%Y-%m-%d'`, referencing the Task 1–5 commits and noting "+ docs commit".

- [ ] **Step 4: Commit and push**

```bash
git add docs/backend-architecture.md docs/frontend-architecture.md docs/LOGBOOK.md
git commit -m "docs: advice notes architecture and logbook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```
