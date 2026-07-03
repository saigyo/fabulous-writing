# On-demand LLM suggestions for suggestion-less findings

## Context

Rule findings from `existence`, `occurrence`, and repetition-style rules (weasel words,
passive voice, clichés, long sentences) explain the problem but carry no replacement, so
their sidebar detail card offers nothing to click. The writer should be able to ask the
LLM for a fix for exactly that finding, on demand. Automatic enrichment was rejected:
local models take seconds to tens of seconds per call, so unsolicited calls on every
typing pause would be slow and wasteful.

## Backend

New endpoint `POST /api/suggestions`:

```json
{
  "text": "<current full editor text>",
  "span": {"start": 8, "end": 12},
  "message": "'very' is a weasel word — be specific.",
  "language": "en",
  "llm_provider": "ollama",   // optional, defaults as in /api/checks
  "llm_model": "gemma4:12b"   // optional
}
```

→ `200 {"suggestions": ["...", "..."]}`.

- Synchronous: one focused LLM call; the client shows a spinner.
- `build_suggestion_prompt(text, span, message, language)` in `prompts.py` sends the
  flagged span, the sentence(s) around it, and the finding's message, and requests 1–3
  drop-in replacements for exactly the quoted span as a JSON string array (in the text's
  language).
- Response parsing reuses the tolerant JSON-array extraction from the checker (shared
  helper); non-string items and replacements identical to the original span are dropped.
- Errors: span out of bounds → 422; LLM failure or unparseable response → 502 with the
  error message.

## Frontend

- Store gains `extraSuggestions: Record<findingId, string[]>` (plus a pending/error flag
  per finding); entries are dropped when the finding disappears from `tracked`.
- Sidebar detail card: if the finding has no native suggestions and no cached extras,
  show a "✨ Suggest fix" button → `postSuggestions` with the current doc text and the
  finding's current tracked span → chips render exactly like native suggestions (same
  `applySuggestion` path). While pending: "asking LLM…"; on failure: inline error with
  retry.
- No changes to the check pipeline, scheduler, or rule engine.

## Testing

- Backend (pytest, FakeProvider): happy path; echo filtering; unparseable → 502;
  span out of bounds → 422; prompt contains span text, message, and language.
- Frontend (vitest): helper that resolves a finding's effective suggestions
  (native > cached extras > none).
- End-to-end: browser run against local Ollama — click "Suggest fix" on a weasel-word
  finding, chips appear, applying one rewrites the text.
