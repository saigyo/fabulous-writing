# Fabulous Writing

A writing-quality assistant for articles, documentation, and marketing copy. Text in the
editor is continuously checked for spelling, grammar, style, clarity, vividness,
correctness, and domain terminology. A sidebar shows findings per category; clicking a
finding highlights it in the text and offers one-click suggestions.

Checking happens in two phases:

1. **LLM checking** with pluggable providers (local Ollama models or the Claude API).
2. **Deterministic local rules** in a Vale-style YAML formalism — easy to read, easy to
   extend by hand or with an agentic coding tool.

Domain-specific terminology is managed per domain and language (English and German).

## Structure

- `backend/` — Python/FastAPI checking service (rule engine, terminology, LLM providers, check API)
- `frontend/` — React single-page app (CodeMirror editor + findings sidebar)
- `docs/superpowers/specs/` — design documents

## Development

Backend (requires [uv](https://docs.astral.sh/uv/)):

```sh
cd backend
uv run uvicorn app.main:app --reload --port 8000
uv run pytest
```

Frontend (requires Node):

```sh
cd frontend
npm install
npm run dev
```
