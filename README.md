# Fabulous Writing

A writing-quality assistant for articles, documentation, and marketing copy. Text in the
editor is continuously checked for spelling, grammar, style, clarity, vividness,
correctness, and domain terminology. A sidebar shows findings per category; clicking a
finding highlights it in the text, explains the issue, and offers one-click suggestions.

Checking happens in two phases:

1. **LLM checking** with pluggable providers — local Ollama models or the Claude API.
   The LLM must quote each problem verbatim; quotes are re-anchored deterministically
   and findings that cannot be anchored are discarded.
2. **Deterministic local rules** in a Vale-style YAML formalism — easy to read, easy to
   extend by hand or with an agentic coding tool.

Domain-specific terminology is managed per domain and language (English and German).

## Structure

- `backend/` — Python/FastAPI checking service (rule engine, terminology, LLM providers, check API)
- `frontend/` — React single-page app (CodeMirror editor + findings sidebar)
- `docs/superpowers/specs/` — design documents

## Running

Backend (requires [uv](https://docs.astral.sh/uv/)):

```sh
cd backend
uv run uvicorn app.main:app --reload --port 8000
```

Frontend (requires Node):

```sh
cd frontend
npm install
npm run dev          # http://localhost:5173
```

For LLM checking, either run [Ollama](https://ollama.com) locally (models are
discovered automatically) or export `ANTHROPIC_API_KEY` and pick the `claude`
provider in the header. Rules and terminology checks work without any LLM.
Optional backend configuration: copy `backend/config.example.yaml` to
`backend/config.yaml`.

## Tests

```sh
cd backend && uv run pytest
cd frontend && npm test && npm run build
```

## Writing rules

Rules live in `backend/rules/<language>/<group>/<name>.yml` and are picked up on
startup or via `POST /api/rules/reload`. Four check types:

```yaml
# existence: flag words/phrases (tokens get word boundaries; raw is verbatim regex)
extends: existence
message: "'%s' is a weasel word — be specific."
level: warning            # error | warning | suggestion
category: style           # spelling|grammar|style|clarity|vividness|correctness
ignorecase: true
tokens: [very, extremely]
raw: ['!{2,}']

# substitution: flag and suggest a replacement
extends: substitution
message: "Use '%s' instead of '%s'."
swap:
  utilize: use

# occurrence: limit matches of a pattern per sentence
extends: occurrence
message: "Sentence longer than 30 words — consider splitting it."
scope: sentence
token: '\b\w+\b'
max: 30

# repetition: flag adjacent duplicated words ("the the")
extends: repetition
message: "'%s' is repeated."
```

Invalid rule files are reported by `GET /api/rules` (and at startup) but never break
the engine.

## Terminology

Manage domains and terms in the app's *Terminology* view or via the API. A term has a
preferred form, forbidden variants, an optional definition, and a language; forbidden
variants found in the text are flagged with the preferred term as a one-click fix.

## API

Interactive OpenAPI docs at `http://localhost:8000/docs`. The essentials:

```sh
# Run a check (rules inline; LLM findings stream via SSE)
curl -X POST localhost:8000/api/checks -H 'Content-Type: application/json' \
  -d '{"text": "This is is very good.", "language": "en", "checkers": ["rules", "llm"]}'
curl -N localhost:8000/api/checks/<check_id>/events   # SSE stream
curl localhost:8000/api/checks/<check_id>             # polling fallback

# LLM fix for one finding: scope "span" = drop-in replacement, "sentence" = whole-sentence rewrite
curl -X POST localhost:8000/api/suggestions -H 'Content-Type: application/json' \
  -d '{"text": "It is very good.", "span": {"start": 6, "end": 10}, "message": "Weasel word.", "language": "en", "scope": "sentence"}'

curl localhost:8000/api/providers                     # LLM provider availability
curl localhost:8000/api/rules                         # loaded rules + errors
curl localhost:8000/api/domains                       # terminology CRUD under /api/domains, /api/terms
```
