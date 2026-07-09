# Held-Back Suggestions with On-Demand Reveal — Design

## Problem

"Suggest fix" and "Rewrite sentence" pass LLM candidates through deterministic
vetting (`backend/app/checkers/llm/vetting.py`, three stages: sanity filters,
spell gate, rule re-check). The rule re-check patches the document with each
candidate and rejects it if any rule's finding count increases or the addressed
rule does not improve. A rewrite of a long sentence that carries over other
issues in that sentence (or duplicates one while splitting the sentence) can
lose *every* candidate this way. The rejected texts are discarded server-side;
the user sees only "no reliable suggestion (N held back)" and has no way to get
at the candidates — they must fix the local issues first and retry.

## Feature

When all candidates were vetoed, the user can reveal the held-back candidates
and apply one anyway, with full information about why each was held back.

Decisions (confirmed):

1. **Reveal scope:** candidates rejected by the rule re-check and the spell
   gate are revealable. Sanity-stage rejects (empty, identical to original,
   stray brackets, length ratio outside 0.25–4.0) are genuine garbage and are
   never returned.
2. **When shown:** the reveal affordance appears only when *all* candidates
   were suppressed. If at least one vetted suggestion exists, held-back ones
   stay hidden.
3. **Presentation:** revealed candidates are visually marked (dashed amber
   border) and each shows a one-line reason. Applying one uses the same apply
   path as a vetted suggestion.

Rejected alternatives: re-requesting with vetting disabled (extra LLM call,
different candidates); loosening the vet gate itself (changes semantics for
everyone, hides real regressions — possible future refinement).

## Backend

### `vetting.py`

- New dataclass:

  ```python
  @dataclass
  class HeldBackCandidate:
      text: str
      reason_kind: Literal["rules", "spelling"]
      rule_ids: list[str]   # reason_kind == "rules": rules that got worse or stayed unresolved
      words: list[str]      # reason_kind == "spelling": unrecognized words
  ```

- `VetResult` gains `held_back: list[HeldBackCandidate]` (default empty).
  `accepted` and `rejected` keep their meaning; `rejected` still counts *all*
  rejects including sanity-stage ones.
- `_has_unknown_words(...) -> bool` becomes `_unknown_words(...) -> set[str]`
  (empty set = pass). The words returned are the ones that failed both the
  frequency list and (when available) the Hunspell lookup — i.e. exactly the
  words that caused rejection.
- `_passes_rule_recheck(...) -> bool` becomes `_rule_recheck_failures(...) ->
  list[str]`: the rule IDs whose count increased in the patched document, plus
  the addressed `rule_id` when it did not improve. Empty list = pass.
- `vet_candidates` (stages 1–2) populates `held_back` for spell-gate rejects.
  `vet_suggestions` (all three stages) additionally populates it for
  rule-re-check rejects. Ordering within `held_back` follows candidate order.

### `api/suggestions.py`

- New response model:

  ```python
  class HeldBackSuggestion(BaseModel):
      text: str
      reason_kind: Literal["rules", "spelling"]
      rule_ids: list[str] = []
      words: list[str] = []
  ```

- `SuggestionResponse` gains `held_back: list[HeldBackSuggestion] = []`,
  filled from `VetResult.held_back`. When vetting is disabled
  (`settings.vet_suggestions` false) it stays empty. Existing fields are
  unchanged — non-browser clients that ignore the new field are unaffected.

## Frontend

### Types and client

- `HeldBackSuggestion` type mirroring the backend model; `SuggestionResponse`
  in `api/client.ts` gains `held_back`.

### Store

- New per-finding maps, lifecycle identical to `extraSuggestions` / `rewrites`
  (cleared with the finding):
  - `suggestHeldBack: Record<string, HeldBackSuggestion[]>`
  - `rewriteHeldBack: Record<string, HeldBackSuggestion[]>`
  - setters following the existing naming (`setSuggestHeldBack`,
    `setRewriteHeldBack`), clearing alongside the corresponding
    error/result setters.

### `checking/suggest.ts`

- In the all-vetoed branch (where `noReliableSuggestionMessage` returns a
  message), additionally store `result.held_back` for the finding. In the
  success branch, clear it.

### Sidebar (`SuggestionArea` / `RewriteArea`)

- When the vet error message is shown and the finding has held-back
  candidates: render the existing notice plus a button
  "Show N held-back suggestions" (i18n). Clicking toggles local component
  state (`revealed`), rendering each candidate as a warning-styled button
  (class `held-back`, dashed amber border) with a small reason line:
  - `reason_kind == "rules"` → `m.heldBackRules(ruleIds.join(', '))` — raw
    rule IDs, consistent with how `FindingRow` already displays `rule_id`.
  - `reason_kind == "spelling"` → `m.heldBackSpelling(words.join(', '))`.
- Applying uses the same `applySuggestion` / `applyRewrite` path as vetted
  candidates. Carried-over issues are re-flagged by the next check — the
  honest lifecycle; no suppression of follow-up findings.
- Reveal state is component-local and per finding; it dies with the finding.

### i18n (all 7 locales: en, de, fr, es, it, ja, zh)

- `showHeldBack(count: number)` — button label.
- `heldBackRules(rules: string)` — "Would still trip: {rules}".
- `heldBackSpelling(words: string)` — "Unrecognized: {words}".

## Testing

- **Backend unit (`tests/test_vetting.py`):** a candidate that re-introduces a
  rule finding lands in `held_back` with `reason_kind == "rules"` and the
  offending rule ID; an unresolved addressed rule likewise; a spell-gate
  reject carries `reason_kind == "spelling"` and the unknown words; sanity
  rejects are counted in `rejected` but absent from `held_back`; accepted
  candidates never appear in `held_back`.
- **Backend API (`tests/test_suggestions_api.py` or equivalent):** response
  contains `held_back` with the expected shape when all candidates are vetoed;
  empty when vetting is disabled.
- **Frontend (vitest):** store setter lifecycle; the all-vetoed branch stores
  held-back candidates and the success branch clears them; i18n catalog parity
  (existing test enforces new keys across locales).
- **E2E (headless, scratch text only — never the live DB):** a long sentence
  with a carried-over issue produces the vet notice + reveal button; clicking
  reveals warning-styled options with reason lines; applying one replaces the
  sentence.

## Out of scope

- Persisting reveal state.
- Re-vetting after reveal.
- Loosening or configuring the vet gate.
- Localized rule names in reasons (sidebar consistently shows raw rule IDs).
