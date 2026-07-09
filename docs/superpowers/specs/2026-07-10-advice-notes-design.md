# Advice Notes Instead of Fake Replacement Buttons — Design

## Problem

LLM providers sometimes put advice or meta-commentary into a finding's
`suggestions` array despite the prompt demanding drop-in replacements — e.g.
`(Consider moving this sentence to a separate paragraph about the product's
history.)`. The UI renders every suggestion as a clickable replacement button,
so clicking would paste the parenthesized advice into the document verbatim.
Observed with the local tier (mistral-nemo); the models consistently wrap such
advice in parentheses themselves, which gives a deterministic signal. The
sanity filter already rejects candidates starting with `[` or `"` but not `(`.

Advice is useful and must stay visible — just never as an appliable
replacement.

## Decisions (confirmed)

1. **Presentation:** detected advice renders as a non-clickable note in the
   finding card (💡 + italic muted text, class `advice-note`), below the
   message / real suggestion buttons. The wrapping parentheses are stripped.
   No new i18n keys: the note body is the advice text itself, already in the
   text's language.
2. **Detection:** deterministic parentheses classification plus prompt
   hardening. No verb heuristics, no schema change for self-labeling
   (rejected: per-language verb lists are brittle; weak local models won't
   label reliably).

## Classification (backend, shared helper)

New pure function in `backend/app/checkers/llm/vetting.py`:

```python
def split_advice(candidates: list[str]) -> tuple[list[str], list[str]]:
    """Separate replacement candidates from parenthesized advice.

    A candidate whose stripped text is fully wrapped in (...) or （…） is
    advice; the wrapper is stripped. Everything else passes through in order.
    """
```

Rules:
- Wrapped means: first char `(` or `（` AND last char `)` or `）` (after
  `strip()`), with non-empty content between. Mixed ASCII/fullwidth pairs
  count as wrapped (models mix them).
- Only the outer wrapper is stripped (one layer); inner parentheses are
  preserved. The stripped advice text is `strip()`ed.
- A candidate that merely *contains* parentheses is a replacement, untouched.
- Runs **before** all vetting stages at both surfaces. Consequences: advice is
  never spell-gated, never counted in `rejected`, never lands in `held_back`.

## Check-time findings

- `Finding` (backend `app/core/models.py`) gains `advice: list[str] = []` —
  additive; clients ignoring it are unaffected.
- In `checker.py`, `raw.suggestions` goes through `split_advice` first;
  replacements continue through the existing cheap vetting (`vet_candidates`,
  stages 1–2), advice lands on `finding.advice` (advice is NOT vetted — even
  a spell-gate-unknown word in advice is fine to display).
- Frontend `Finding` type (`frontend/src/types.ts`) mirrors the new field.
  Dedupe/equivalence logic is unaffected (extra field only).

## On-demand suggest/rewrite (`/api/suggestions`)

- In `api/suggestions.py`, candidates go through `split_advice` before the
  vetting block (in both the vetting-enabled and kill-switch paths, so advice
  never renders as a button regardless of the `vet_suggestions` setting).
- `SuggestionResponse` gains `advice: list[str] = []`.
- Semantics when ALL candidates were advice: `suggestions == []`,
  `rejected == 0`, `advice` non-empty → the frontend shows the normal
  "no replacement" notice plus the advice note — NOT the "failed local
  checks" vet message (nothing was rejected).

## Frontend

- `SuggestionResponse` in `api/client.ts` gains `advice: string[]`.
- Store: `suggestAdvice: Record<string, string[]>` and
  `rewriteAdvice: Record<string, string[]>`, with setters
  (`setSuggestAdvice`/`setRewriteAdvice`, null removes), initial `{}`,
  `migrateByFinding` wiring, and the same (non-)persistence treatment —
  exactly the held-back maps' lifecycle.
- `suggest.ts`: both fetch flows store `result.advice` when non-empty (in
  success AND vetoed branches — advice accompanies either outcome), clear it
  at fetch start and when absent.
- Sidebar finding card: an `AdviceNotes` element renders each advice string as
  `💡 <text>` (italic, muted, class `advice-note`) in `SuggestionArea` and
  `RewriteArea` below the buttons/notices, plus check-time `finding.advice`
  rendered the same way in the finding detail under the suggestions area.
- Advice notes are plain text — no click handler, no button semantics.

## Prompt hardening

All three system templates in `prompts.py` (check `_SYSTEM_TEMPLATE`,
`_SUGGESTION_SYSTEM_TEMPLATE`, rewrite template) gain one rule, adapted to
each template's phrasing:

> Never disguise advice or commentary as a replacement. If you cannot offer a
> literal drop-in replacement, return an empty suggestions array and put your
> advice in the message/explanation.

(For the suggestion/rewrite templates, "return an empty JSON array `[]`".)

## Testing

- **Backend unit (`test_vetting.py`):** `split_advice` — ASCII and fullwidth
  wrappers, mixed pairs, single-layer stripping with inner parens preserved,
  non-wrapped candidates pass through untouched and ordered, empty content
  `()` is not advice (stays a candidate, dies in sanity).
- **Backend checker test:** a raw finding suggestion `"(advice text)"` ends up
  in `finding.advice`, not `finding.suggestions`.
- **Backend API (`test_suggestions_api.py`):** response `advice` populated and
  parens stripped; all-advice case gives `suggestions == []`, `rejected == 0`;
  kill-switch path still splits advice.
- **Frontend (vitest):** store setter lifecycle for the two advice maps;
  existing i18n/lint/build gates.
- **E2E (headless, stubbed `/api/suggestions`, scratch text):** one
  replacement + one advice → one button + one non-clickable note; note has no
  pointer semantics; all-advice case shows "no replacement" notice + note.

## Out of scope

- Verb/imperative heuristics for unparenthesized advice.
- Schema changes for LLM self-labeling.
- Persisting or vetting advice text.
