# Held-Back Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When suggestion vetting suppresses every LLM candidate, the user can reveal the held-back candidates — each marked with why it was held back — and apply one anyway.

**Architecture:** The backend vetting pipeline (`vetting.py`) returns per-candidate rejection reasons for revealable stages (spell gate, rule re-check); the suggestions API exposes them as `held_back` on the existing response; the frontend stores them per finding and the sidebar reveals them on demand behind a button, warning-styled with a reason line. No new endpoints, no extra LLM calls.

**Tech Stack:** FastAPI + pydantic (backend), pytest; React 19 + zustand + vitest (frontend); i18n catalogs ×7.

**Spec:** `docs/superpowers/specs/2026-07-12-held-back-suggestions-design.md`

## Global Constraints

- Backend commands run from `backend/` via `uv run`; frontend from `frontend/` via npm.
- Commits go directly on `main`; every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `HeldBackCandidate` / `HeldBackSuggestion` fields exactly: `text: str`, `reason_kind: Literal["rules", "spelling"]`, `rule_ids: list[str]` (default empty), `words: list[str]` (default empty).
- Sanity-stage rejects (empty, identical, bracket artifacts, length ratio outside 0.25–4.0) are counted in `rejected` but NEVER appear in `held_back`.
- The reveal affordance appears only when zero candidates were accepted and at least one held-back candidate exists.
- `VetResult.rejected` keeps counting ALL rejects (sanity included). Existing response fields keep their exact meaning.
- i18n keys (`showHeldBack`, `heldBackRules`, `heldBackSpelling`) must be added to ALL 7 locales: en, de, fr, es, it, ja, zh. The existing `i18n.test.ts` parity test fails otherwise.
- Never touch `backend/data/fabulous.db`; tests use `tmp_path`, e2e uses scratch text only.
- The owner's dev servers on :5173/:8000 may be running — do not kill or restart them.

---

### Task 1: Vetting returns held-back candidates with reasons

**Files:**
- Modify: `backend/app/checkers/llm/vetting.py`
- Test: `backend/tests/test_vetting.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `HeldBackCandidate` dataclass (`text: str`, `reason_kind: Literal["rules", "spelling"]`, `rule_ids: list[str]`, `words: list[str]`); `VetResult` gains `held_back: list[HeldBackCandidate]` (default empty). `vet_candidates` / `vet_suggestions` signatures unchanged. Callers using only `.accepted`/`.rejected` (e.g. `checker.py:135`) are unaffected.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_vetting.py`. Two tests go into a new class after `TestSpellGate`; two more go inside the existing `TestRuleRecheck` class (they use its `_vet` helper).

```python
class TestHeldBack:
    def test_spell_gate_reject_lands_in_held_back_with_words(self) -> None:
        result = vet_candidates(
            ["empföhle Ihnen den Editor sofort"],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
        )
        assert result.rejected == 1
        assert len(result.held_back) == 1
        candidate = result.held_back[0]
        assert candidate.text == "empföhle Ihnen den Editor sofort"
        assert candidate.reason_kind == "spelling"
        assert candidate.words == ["empföhle"]
        assert candidate.rule_ids == []

    def test_sanity_rejects_are_not_held_back(self) -> None:
        result = vet_candidates(
            ["", DE_ORIGINAL, "wort " * 60],
            original=DE_ORIGINAL,
            text=DE_TEXT,
            language=Language.DE,
        )
        assert result.rejected == 3
        assert result.held_back == []
```

```python
    # inside class TestRuleRecheck:
    def test_unresolved_rule_lands_in_held_back(self) -> None:
        result = self._vet(
            ["extremely"],
            text="This is very good.",
            original="very",
            language=Language.EN,
            rule_id="style.weasel-words",
        )
        assert result.accepted == []
        assert len(result.held_back) == 1
        candidate = result.held_back[0]
        assert candidate.text == "extremely"
        assert candidate.reason_kind == "rules"
        assert candidate.rule_ids == ["style.weasel-words"]
        assert candidate.words == []

    def test_introduced_finding_lands_in_held_back_with_rule_id(self) -> None:
        result = self._vet(
            ["quite quite"],
            text="This is very good.",
            original="very",
            language=Language.EN,
            rule_id="style.weasel-words",
        )
        assert result.accepted == []
        assert len(result.held_back) == 1
        assert result.held_back[0].reason_kind == "rules"
        assert "grammar.repeated-words" in result.held_back[0].rule_ids
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_vetting.py -v -k "held_back"`
Expected: 4 FAILED — `AttributeError: 'VetResult' object has no attribute 'held_back'`

- [ ] **Step 3: Implement in `vetting.py`**

Replace the imports/dataclass section and the three functions. New `typing` import:

```python
from typing import Any, Literal
```

Replace the `VetResult` dataclass with:

```python
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
```

(add `field` to the dataclasses import: `from dataclasses import dataclass, field`)

Replace `_has_unknown_words` with `_unknown_words` returning the offending words (empty list = pass); order-preserving, deduplicated, original casing:

```python
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
```

Replace `vet_candidates`:

```python
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
```

Replace `_passes_rule_recheck` with `_rule_recheck_failures` (empty list = pass):

```python
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
```

Replace the stage-3 loop in `vet_suggestions`:

```python
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
```

- [ ] **Step 4: Run the vetting suite**

Run: `uv run pytest tests/test_vetting.py -v`
Expected: all PASS (existing tests included — `accepted`/`rejected` semantics are unchanged).

- [ ] **Step 5: Run the full backend suite**

Run: `uv run pytest`
Expected: 618 passed (614 existing + 4 new), zero warnings.

- [ ] **Step 6: Commit**

```bash
git add app/checkers/llm/vetting.py tests/test_vetting.py
git commit -m "feat: vetting returns held-back candidates with reasons

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Suggestions API exposes `held_back`

**Files:**
- Modify: `backend/app/api/suggestions.py`
- Test: `backend/tests/test_suggestions_api.py`

**Interfaces:**
- Consumes: `VetResult.held_back` / `HeldBackCandidate` from Task 1.
- Produces: `SuggestionResponse.held_back: list[HeldBackSuggestion]` where `HeldBackSuggestion(BaseModel)` has `text: str`, `reason_kind: Literal["rules", "spelling"]`, `rule_ids: list[str] = []`, `words: list[str] = []`. JSON key: `held_back`.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_suggestions_api.py`, add to `class TestVetting`:

```python
    def test_all_rejected_returns_held_back_with_reasons(self, tmp_path: Path) -> None:
        provider = FakeProvider(
            json.dumps(
                [
                    "empföhle Ihnen den Editor sofort",  # spell gate
                    "würde Ihnen den Editor wirklich sofort empfehlen",  # unresolved rule
                ]
            )
        )
        client = self.make_client(tmp_path, provider)
        body = client.post("/api/suggestions", json=self.de_request()).json()
        assert body["suggestions"] == []
        assert body["rejected"] == 2
        kinds = {item["text"]: item for item in body["held_back"]}
        spelling = kinds["empföhle Ihnen den Editor sofort"]
        assert spelling["reason_kind"] == "spelling"
        assert spelling["words"] == ["empföhle"]
        rules = kinds["würde Ihnen den Editor wirklich sofort empfehlen"]
        assert rules["reason_kind"] == "rules"
        assert "style.wuerde-stil" in rules["rule_ids"]

    def test_kill_switch_has_empty_held_back(self, tmp_path: Path) -> None:
        provider = FakeProvider(json.dumps(["empföhle Ihnen den Editor sofort"]))
        client = self.make_client(tmp_path, provider, vet=False)
        body = client.post("/api/suggestions", json=self.de_request()).json()
        assert body["held_back"] == []
```

Also update the exact-dict assertion in
`TestSuggestionsEndpoint::test_returns_parsed_suggestions_and_echoes_span`
(it compares the whole response and will now see the new key):

```python
        assert response.json() == {
            "suggestions": ["outstanding", "remarkably clear"],
            "span": {"start": 17, "end": 26},
            "original": "very good",
            "rejected": 0,
            "held_back": [],
        }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_suggestions_api.py -v`
Expected: `test_all_rejected_returns_held_back_with_reasons`, `test_kill_switch_has_empty_held_back`, and `test_returns_parsed_suggestions_and_echoes_span` FAIL with `KeyError: 'held_back'` / dict mismatch.

- [ ] **Step 3: Implement in `suggestions.py`**

Add the import and models (after `SpanRef`; extend the existing `typing` import to `from typing import Literal` — already present):

```python
class HeldBackSuggestion(BaseModel):
    text: str
    reason_kind: Literal["rules", "spelling"]
    rule_ids: list[str] = []
    words: list[str] = []
```

Extend `SuggestionResponse`:

```python
class SuggestionResponse(BaseModel):
    suggestions: list[str]
    span: SpanRef
    original: str
    rejected: int = 0
    held_back: list[HeldBackSuggestion] = []
```

In `create_suggestions`, initialize `held_back: list[HeldBackSuggestion] = []` next to `rejected = 0`, and inside the `if request.app.state.settings.vet_suggestions:` block, after `suggestions, rejected = result.accepted, result.rejected`, add:

```python
        held_back = [
            HeldBackSuggestion(
                text=candidate.text,
                reason_kind=candidate.reason_kind,
                rule_ids=candidate.rule_ids,
                words=candidate.words,
            )
            for candidate in result.held_back
        ]
```

and include `held_back=held_back` in the returned `SuggestionResponse`.

- [ ] **Step 4: Run the API tests, then the full suite**

Run: `uv run pytest tests/test_suggestions_api.py -v` → all PASS.
Run: `uv run pytest` → 620 passed, zero warnings.

- [ ] **Step 5: Commit**

```bash
git add app/api/suggestions.py tests/test_suggestions_api.py
git commit -m "feat: suggestions API returns held-back candidates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend data layer — types, store, fetch flow

**Files:**
- Modify: `frontend/src/api/client.ts` (SuggestionResponse)
- Modify: `frontend/src/state/store.ts`
- Modify: `frontend/src/checking/suggest.ts`
- Modify: `frontend/src/checking/vetMessage.ts`
- Test: `frontend/src/state/store.test.ts`, `frontend/src/checking/vetMessage.test.ts`

**Interfaces:**
- Consumes: API field `held_back` from Task 2.
- Produces (used by Task 4):
  - `HeldBackSuggestion` type exported from `api/client.ts`: `{ text: string; reason_kind: 'rules' | 'spelling'; rule_ids: string[]; words: string[] }`.
  - Store: `suggestHeldBack: Record<string, HeldBackSuggestion[]>`, `rewriteHeldBack: Record<string, HeldBackRewrite>` with `HeldBackRewrite = { original: string; candidates: HeldBackSuggestion[] }`; setters `setSuggestHeldBack(findingId, candidates | null)`, `setRewriteHeldBack(findingId, heldBack | null)` (null removes the entry).
  - `heldBackReason(candidate: HeldBackSuggestion, messages: Messages): string` from `vetMessage.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/state/store.test.ts` (follow the file's existing import style — it imports `useStore` and resets state; add `import type { HeldBackSuggestion } from '../api/client'`):

```ts
describe('held-back suggestions', () => {
  const candidate: HeldBackSuggestion = {
    text: 'extremely',
    reason_kind: 'rules',
    rule_ids: ['style.weasel-words'],
    words: [],
  }

  it('stores and clears suggest held-back per finding', () => {
    useStore.getState().setSuggestHeldBack('f1', [candidate])
    expect(useStore.getState().suggestHeldBack['f1']).toEqual([candidate])
    useStore.getState().setSuggestHeldBack('f1', null)
    expect(useStore.getState().suggestHeldBack['f1']).toBeUndefined()
  })

  it('stores and clears rewrite held-back per finding', () => {
    useStore.getState().setRewriteHeldBack('f1', {
      original: 'This is very good.',
      candidates: [candidate],
    })
    expect(useStore.getState().rewriteHeldBack['f1']?.original).toBe('This is very good.')
    useStore.getState().setRewriteHeldBack('f1', null)
    expect(useStore.getState().rewriteHeldBack['f1']).toBeUndefined()
  })
})
```

Append to `frontend/src/checking/vetMessage.test.ts` (it already imports a `Messages`-shaped fixture or the en catalog — follow its existing pattern; the en catalog is imported as `en` from `'../i18n/en'` if the file does so, otherwise construct the minimal stub the file already uses):

```ts
describe('heldBackReason', () => {
  it('formats a rules reason from rule ids', () => {
    expect(
      heldBackReason(
        { text: 'x', reason_kind: 'rules', rule_ids: ['a.b', 'c.d'], words: [] },
        en,
      ),
    ).toBe(en.heldBackRules('a.b, c.d'))
  })

  it('formats a spelling reason from words', () => {
    expect(
      heldBackReason(
        { text: 'x', reason_kind: 'spelling', rule_ids: [], words: ['empföhle'] },
        en,
      ),
    ).toBe(en.heldBackSpelling('empföhle'))
  })
})
```

Note: these tests reference `en.heldBackRules` / `en.heldBackSpelling`, which do not exist until Task 4 adds the i18n keys. To keep Task 3 self-contained, add the three keys to the `Messages` interface and ALL 7 catalogs in THIS task (exact catalog lines are listed in Task 4 Step 3 — use them verbatim); Task 4 then only consumes them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/state/store.test.ts src/checking/vetMessage.test.ts`
Expected: FAIL — `setSuggestHeldBack is not a function`, `heldBackReason` not exported.

- [ ] **Step 3: Implement**

`frontend/src/api/client.ts` — extend the response interface and export the type:

```ts
export interface HeldBackSuggestion {
  text: string
  reason_kind: 'rules' | 'spelling'
  rule_ids: string[]
  words: string[]
}

export interface SuggestionResponse {
  suggestions: string[]
  span: { start: number; end: number }
  original: string
  rejected: number
  held_back: HeldBackSuggestion[]
}
```

`frontend/src/state/store.ts` — mirror the `extraSuggestions`/`rewrites` slices exactly (state fields near line 62, action types near line 97, initial values near line 166, the `migrateByFinding` block near line 189, and setters near line 226; `withEntry` removes on null):

```ts
import type { HeldBackSuggestion } from '../api/client'

export interface HeldBackRewrite {
  original: string
  candidates: HeldBackSuggestion[]
}

// state fields:
  suggestHeldBack: Record<string, HeldBackSuggestion[]>
  rewriteHeldBack: Record<string, HeldBackRewrite>

// action types:
  setSuggestHeldBack: (findingId: string, candidates: HeldBackSuggestion[] | null) => void
  setRewriteHeldBack: (findingId: string, heldBack: HeldBackRewrite | null) => void

// initial values:
      suggestHeldBack: {},
      rewriteHeldBack: {},

// in the migrateByFinding block (same list as extraSuggestions/rewrites):
            suggestHeldBack: migrateByFinding(state.suggestHeldBack, idMap),
            rewriteHeldBack: migrateByFinding(state.rewriteHeldBack, idMap),

// setters:
      setSuggestHeldBack: (findingId, candidates) =>
        set((state) => ({
          suggestHeldBack: withEntry(state.suggestHeldBack, findingId, candidates),
        })),
      setRewriteHeldBack: (findingId, heldBack) =>
        set((state) => ({
          rewriteHeldBack: withEntry(state.rewriteHeldBack, findingId, heldBack),
        })),
```

Do NOT add the new maps to `partialize` unless `extraSuggestions` is there; match whatever persistence treatment `extraSuggestions` has, exactly.

`frontend/src/checking/vetMessage.ts` — add:

```ts
import type { HeldBackSuggestion } from '../api/client'

/** One-line reason shown under a revealed held-back candidate. */
export function heldBackReason(
  candidate: HeldBackSuggestion,
  messages: Messages,
): string {
  return candidate.reason_kind === 'rules'
    ? messages.heldBackRules(candidate.rule_ids.join(', '))
    : messages.heldBackSpelling(candidate.words.join(', '))
}
```

`frontend/src/checking/suggest.ts` — wire the vetoed branches. In `fetchSuggestions`, replace the `if (result)` body:

```ts
    if (result) {
      const vetoed = noReliableSuggestionMessage(
        result.suggestions,
        result.rejected,
        currentMessages(),
      )
      const store = useStore.getState()
      if (vetoed) {
        store.setSuggestError(findingId, vetoed)
        store.setSuggestHeldBack(
          findingId,
          result.held_back.length > 0 ? result.held_back : null,
        )
      } else {
        store.setExtraSuggestions(findingId, result.suggestions)
        store.setSuggestHeldBack(findingId, null)
      }
    }
```

In `fetchRewrite`, replace the `if (result)` body:

```ts
    if (result) {
      const vetoed = noReliableSuggestionMessage(
        result.suggestions,
        result.rejected,
        currentMessages(),
      )
      const store = useStore.getState()
      if (vetoed) {
        store.setRewriteError(findingId, vetoed)
        store.setRewriteHeldBack(
          findingId,
          result.held_back.length > 0
            ? { original: result.original, candidates: result.held_back }
            : null,
        )
      } else {
        store.setRewrite(findingId, {
          original: result.original,
          options: result.suggestions,
        })
        store.setRewriteHeldBack(findingId, null)
      }
    }
```

Also add the i18n keys now (see Task 4 Step 3 for the exact lines in `messages.ts` and all 7 catalogs) so `heldBackReason` compiles and the parity test passes.

- [ ] **Step 4: Run tests, lint, build**

Run: `npm test` → all pass (including `i18n.test.ts` parity with the new keys).
Run: `npm run lint` → 0 warnings. Run: `npm run build` → green.

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts src/state/store.ts src/checking/suggest.ts src/checking/vetMessage.ts src/i18n src/state/store.test.ts src/checking/vetMessage.test.ts
git commit -m "feat: frontend stores held-back suggestions per finding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Sidebar reveal UI + styling

**Files:**
- Modify: `frontend/src/sidebar/Sidebar.tsx` (`SuggestionArea`, `RewriteArea`)
- Modify: `frontend/src/App.css`
- Verify present (added in Task 3): i18n keys in `frontend/src/i18n/messages.ts` + all 7 catalogs

**Interfaces:**
- Consumes: store slices `suggestHeldBack`/`rewriteHeldBack`, `heldBackReason` from Task 3; existing `applySuggestion(findingId, text)` / `applyRewrite(findingId, original, option)` from `editor/editorRef`.
- Produces: CSS classes `show-held-back`, `held-back-option`, `held-back`, `held-back-reason`.

- [ ] **Step 1: i18n keys (verify from Task 3, else add)**

`messages.ts` interface additions:

```ts
  showHeldBack: (count: number) => string
  heldBackRules: (rules: string) => string
  heldBackSpelling: (words: string) => string
```

Catalog lines (verbatim):

`en.ts`:
```ts
  showHeldBack: (count) =>
    `Show ${count} held-back ${count === 1 ? 'suggestion' : 'suggestions'}`,
  heldBackRules: (rules) => `Would still trip: ${rules}`,
  heldBackSpelling: (words) => `Unrecognized: ${words}`,
```

`de.ts`:
```ts
  showHeldBack: (count) =>
    count === 1
      ? '1 zurückgehaltenen Vorschlag anzeigen'
      : `${count} zurückgehaltene Vorschläge anzeigen`,
  heldBackRules: (rules) => `Würde weiterhin auslösen: ${rules}`,
  heldBackSpelling: (words) => `Nicht erkannt: ${words}`,
```

`fr.ts`:
```ts
  showHeldBack: (count) =>
    count === 1
      ? 'Afficher 1 suggestion retenue'
      : `Afficher ${count} suggestions retenues`,
  heldBackRules: (rules) => `Déclencherait encore : ${rules}`,
  heldBackSpelling: (words) => `Non reconnu : ${words}`,
```

`es.ts`:
```ts
  showHeldBack: (count) =>
    count === 1
      ? 'Mostrar 1 sugerencia retenida'
      : `Mostrar ${count} sugerencias retenidas`,
  heldBackRules: (rules) => `Seguiría activando: ${rules}`,
  heldBackSpelling: (words) => `No reconocido: ${words}`,
```

`it.ts`:
```ts
  showHeldBack: (count) =>
    count === 1
      ? 'Mostra 1 suggerimento trattenuto'
      : `Mostra ${count} suggerimenti trattenuti`,
  heldBackRules: (rules) => `Attiverebbe ancora: ${rules}`,
  heldBackSpelling: (words) => `Non riconosciuto: ${words}`,
```

`ja.ts`:
```ts
  showHeldBack: (count) => `保留された候補を${count}件表示`,
  heldBackRules: (rules) => `依然として該当: ${rules}`,
  heldBackSpelling: (words) => `未知の語: ${words}`,
```

`zh.ts`:
```ts
  showHeldBack: (count) => `显示 ${count} 条被保留的建议`,
  heldBackRules: (rules) => `仍会触发：${rules}`,
  heldBackSpelling: (words) => `无法识别：${words}`,
```

- [ ] **Step 2: Extend `SuggestionArea` in `Sidebar.tsx`**

Add imports: `heldBackReason` from `'../checking/vetMessage'`; `HeldBackList` is a new local component (below). Replace the final `return` block of `SuggestionArea` (the branch that renders the fetch button + error) with:

```tsx
  return (
    <div className="suggestions">
      <button
        className="suggestion-button suggest-fix"
        disabled={anyPending}
        onClick={(event) => {
          event.stopPropagation()
          void fetchSuggestions(finding.id)
        }}
      >
        ✨ {error ? m.retrySuggestion : m.suggestFix}
      </button>
      {error && <p className="suggest-error">{error}</p>}
      {error && heldBack.length > 0 && (
        <HeldBackList
          candidates={heldBack}
          onApply={(text) => applySuggestion(finding.id, text)}
        />
      )}
    </div>
  )
```

with the hook added at the top of `SuggestionArea` (hooks before any early return):

```tsx
  const heldBack = useStore((s) => s.suggestHeldBack[finding.id]) ?? []
```

Add the shared component at module level in `Sidebar.tsx`:

```tsx
const NO_HELD_BACK: never[] = []

function HeldBackList({
  candidates,
  onApply,
}: {
  candidates: HeldBackSuggestion[]
  onApply: (text: string) => void
}) {
  const m = useMessages()
  const [revealed, setRevealed] = useState(false)
  if (!revealed) {
    return (
      <button
        className="suggestion-button show-held-back"
        onClick={(event) => {
          event.stopPropagation()
          setRevealed(true)
        }}
      >
        {m.showHeldBack(candidates.length)}
      </button>
    )
  }
  return (
    <>
      {candidates.map((candidate) => (
        <div key={candidate.text} className="held-back-option">
          <button
            className="suggestion-button held-back"
            onClick={(event) => {
              event.stopPropagation()
              onApply(candidate.text)
            }}
          >
            {candidate.text}
          </button>
          <p className="held-back-reason">{heldBackReason(candidate, m)}</p>
        </div>
      ))}
    </>
  )
}
```

(import `HeldBackSuggestion` type from `'../api/client'`; use `NO_HELD_BACK` as the `?? []` fallback in both areas so the selector returns a stable reference: `useStore((s) => s.suggestHeldBack[finding.id]) ?? NO_HELD_BACK`.)

- [ ] **Step 3: Extend `RewriteArea`**

Hook at the top:

```tsx
  const heldBack = useStore((s) => s.rewriteHeldBack[finding.id])
```

Add an apply helper next to the existing `apply`:

```tsx
  function applyHeldBack(option: string) {
    if (!heldBack) return
    if (!applyRewrite(finding.id, heldBack.original, option)) {
      const store = useStore.getState()
      store.setRewriteHeldBack(finding.id, null)
      store.setRewriteError(finding.id, m.sentenceChangedRewriteAgain)
    }
  }
```

Replace the final `return` block (fetch button + error) with:

```tsx
  return (
    <div className="rewrites">
      <button
        className="suggestion-button suggest-fix"
        disabled={anyPending}
        onClick={(event) => {
          event.stopPropagation()
          void fetchRewrite(finding.id)
        }}
      >
        ↻ {error ? m.retryRewrite : m.rewriteSentence}
      </button>
      {error && <p className="suggest-error">{error}</p>}
      {error && heldBack && heldBack.candidates.length > 0 && (
        <HeldBackList candidates={heldBack.candidates} onApply={applyHeldBack} />
      )}
    </div>
  )
```

- [ ] **Step 4: CSS in `App.css`** (place after the `.rewrite-option` rules, ~line 653)

```css
.suggestion-button.show-held-back {
  border-style: dashed;
  opacity: 0.85;
}

.held-back-option {
  margin-top: 0.4rem;
}

.suggestion-button.held-back {
  border: 1px dashed #d97706;
  background: rgba(217, 119, 6, 0.06);
}

.held-back-reason {
  margin: 0.15rem 0 0;
  font-size: 0.72rem;
  color: #b45309;
}
```

- [ ] **Step 5: Tests, lint, build**

Run: `npm test` → all pass. `npm run lint` → 0 warnings. `npm run build` → green.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/Sidebar.tsx src/App.css
git commit -m "feat: reveal held-back suggestions in the sidebar

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: E2E verification and documentation

**Files:**
- Create: scratchpad script (session scratchpad dir, NOT the repo): `verify-held-back.mjs`
- Modify: `docs/backend-architecture.md` (vetting section), `docs/frontend-architecture.md` (sidebar/suggestions section), `docs/LOGBOOK.md`

**Interfaces:** consumes the full stack from Tasks 1–4.

- [ ] **Step 1: Headless e2e with a stubbed suggestions response**

The all-vetoed condition depends on nondeterministic LLM output, so the UI e2e stubs `POST /api/suggestions` via Playwright route interception — the real backend behavior is already covered by Task 2's API tests. The dev servers on :5173/:8000 must be running (do not restart them; check `lsof -nP -iTCP:5173 -sTCP:LISTEN`).

Script (import playwright-core by absolute path — Node resolves from the script's location):

```js
import { chromium } from '/Users/markus/IdeaProjects/fabulous-writing/frontend/node_modules/playwright-core/index.mjs'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

await page.route('**/api/suggestions', (route) => {
  const original = JSON.parse(route.request().postData()).text
  route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      suggestions: [],
      span: { start: 0, end: 18 },
      original: original.slice(0, 18),
      rejected: 2,
      held_back: [
        {
          text: 'Extremely good results here',
          reason_kind: 'rules',
          rule_ids: ['style.weasel-words'],
          words: [],
        },
        {
          text: 'Outstandig results here',
          reason_kind: 'spelling',
          rule_ids: [],
          words: ['Outstandig'],
        },
      ],
    }),
  })
})

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)

// Scratch text with a guaranteed rule finding ("very" = style.weasel-words).
await page.locator('.cm-content').click()
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
await page.keyboard.type('The results were very good and the team was happy overall.')
await page.waitForTimeout(2500) // fast check debounce (~1s) + render

// Open the finding and request a fix (stubbed response: all vetoed).
await page.locator('.finding-row').first().click()
await page.locator('.suggestion-button.suggest-fix').first().click()
await page.locator('.suggest-error').first().waitFor({ timeout: 5000 })

const revealBtn = page.locator('.suggestion-button.show-held-back')
if ((await revealBtn.count()) === 0) throw new Error('reveal button missing')
await revealBtn.first().click()

const options = page.locator('.held-back-option')
if ((await options.count()) !== 2) throw new Error('expected 2 revealed options')
const reasons = await page.locator('.held-back-reason').allTextContents()
console.log('reasons:', reasons)
if (!reasons.some((r) => r.includes('style.weasel-words'))) throw new Error('rules reason missing')
if (!reasons.some((r) => r.includes('Outstandig'))) throw new Error('spelling reason missing')

await page.locator('.sidebar').screenshot({ path: `${process.env.SCRATCH ?? '.'}/held-back-revealed.png` })

// Apply the first revealed candidate; the editor text must change.
await page.locator('.suggestion-button.held-back').first().click()
await page.waitForTimeout(300)
const text = await page.locator('.cm-content').innerText()
console.log('editor text:', text)
if (!text.includes('Extremely good results here')) throw new Error('apply did not replace text')

await browser.close()
console.log('DONE')
```

Note: the stub's `span`/`original` must match what the frontend sends — the frontend replaces the finding's span with the candidate via its own apply path, so the stub only needs plausible values; what matters is `suggestions: []`, `rejected > 0`, and the two `held_back` entries. Run with `SCRATCH=<scratchpad dir> node verify-held-back.mjs`. Expected: both reason lines print, screenshot shows dashed amber options, final editor text contains the applied candidate.

- [ ] **Step 2: Update architecture docs**

`docs/backend-architecture.md`, vetting/suggestions paragraphs: vetting now returns `held_back` (revealable rejects with `reason_kind` `rules`/`spelling` + rule IDs/words); sanity rejects are never revealable; `SuggestionResponse.held_back` carries them to clients.

`docs/frontend-architecture.md`, sidebar/suggestions section: all-vetoed responses store held-back candidates per finding (`suggestHeldBack`/`rewriteHeldBack`); the sidebar offers "Show N held-back suggestions", revealing warning-styled candidates with localized reason lines; applying uses the normal apply path and the next check re-flags carried-over issues.

- [ ] **Step 3: LOGBOOK entry**

Append an entry (commit pointers to Tasks 1–4 commits + this one) summarizing the feature and the verification evidence.

- [ ] **Step 4: Commit**

```bash
git add docs/backend-architecture.md docs/frontend-architecture.md docs/LOGBOOK.md
git commit -m "docs: held-back suggestions architecture and logbook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```
