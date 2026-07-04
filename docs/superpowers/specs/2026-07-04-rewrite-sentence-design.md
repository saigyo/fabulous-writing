# "Rewrite sentence" action

## Context

The on-demand "Suggest fix" (2026-07-03) produces drop-in replacements for a finding's
exact span. For many issues the better fix is rewriting the whole sentence — the only
sensible fix for long-sentence findings, and often stronger than a word swap for style
issues. Every finding therefore gets a "Rewrite sentence" action (decision: all
findings, not just sentence-level or suggestion-less ones).

## Backend

`POST /api/suggestions` gains `scope: "span" | "sentence"` (default `"span"`,
backward compatible) and the response gains the effective replacement range:

```json
{"suggestions": ["..."], "span": {"start": 27, "end": 74}, "original": "<exact replaced text>"}
```

- `scope: "sentence"`: the request span is expanded to enclosing sentence boundaries
  via a new `expand_to_sentences(text, start, end)` in `app/checkers/rules/text.py`
  (a span overlapping several sentences covers them all; if no sentence overlaps, the
  span stays as-is). A rewrite-specific prompt sends the sentence(s) and the finding's
  message and asks for 1–2 rewrites in the text's language that fix the issue —
  splitting into several sentences is explicitly allowed.
- `scope: "span"`: behavior unchanged; `span`/`original` echo the request.
- Existing filtering (non-strings, echo of the original text) and error mapping
  (422 invalid span, 502 LLM failure/unparseable) apply to both scopes.

## Frontend

- Every finding's detail card shows "↻ Rewrite sentence" (below native chips /
  Suggest fix). Results render as stacked full-width blocks, one per rewrite; clicking
  a block applies it.
- Applying never trusts fetch-time offsets: `rewriteChange(state, findingId, original,
  replacement)` in `src/editor/findings.ts` searches the *current* document for
  `original` and picks the occurrence overlapping the finding's current tracked span.
  Not found (sentence edited since fetch) → the cached rewrite is discarded and an
  inline "the sentence changed — rewrite again" error with retry is shown.
- Store: `rewrites: Record<findingId, {original, options[]}>` plus pending id and
  per-finding error, pruned when the finding disappears (same as extra suggestions).
  Only one LLM action (suggest or rewrite) runs at a time; both buttons disable while
  either is pending.
- Applying a rewrite touches the finding's span, so the finding and its caches clean
  themselves up via the existing decoration logic.

## Testing

- Backend (pytest, FakeProvider): `expand_to_sentences` unit tests (mid-sentence span,
  cross-sentence span, no-sentence fallback); sentence scope returns full-sentence
  `original`+`span` and prompts with the sentence and message; span scope unchanged;
  echo filtering. Existing suggestion tests updated for the extended response shape.
- Frontend (vitest): `rewriteChange` — replaces the sentence containing the finding,
  disambiguates duplicate sentences by overlap with the tracked span, returns null
  when the sentence was edited away, still works after unrelated earlier edits.
- End-to-end (browser + Ollama): flag a long sentence, click Rewrite sentence, apply a
  rewrite, verify the sentence is replaced and the finding clears.
