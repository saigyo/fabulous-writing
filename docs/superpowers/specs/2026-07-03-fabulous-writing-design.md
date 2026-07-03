# Fabulous Writing — Design & Implementation Plan

## Context

Greenfield project (empty git repo at `/Users/markus/IdeaProjects/fabulous-writing`). "Fabulous Writing" helps writers of articles, documentation, and marketing copy improve text quality. A web editor is continuously checked for quality metrics (spelling, grammar, style, vividness, correctness, terminology); a sidebar shows issue counts per category and individual findings. Clicking a finding highlights it in the text, shows an explanation, and offers suggestions the writer can apply with one click.

Checking happens in two phases: (1) a suitably prompted LLM with pluggable providers (local Ollama + Claude API), and (2) deterministic, locally-run rules in an easy-to-understand formalism so humans and coding agents can add rules. Domain-specific terminology is managed per domain and language.

## Decisions (confirmed with user)

| Topic | Decision |
|---|---|
| Backend | Python + FastAPI |
| Rule formalism | Vale-style YAML rules, own Python engine (no Vale binary) |
| Languages | English + German from the start |
| Persistence | SQLite for terminology; rules as plain YAML files on disk |
| Editor | CodeMirror 6 (Markdown/plain text) |
| Frontend | React + Vite + TypeScript |
| Check timing | Rules/terminology auto-run ~1s after typing pauses; LLM check on longer pause (~5s, toggleable) + explicit "Check" button |
| API shape | Job-based: POST creates check job, results stream via SSE per checker; GET polling fallback |
| MVP deferrals | No server-side document management (single doc in localStorage), no auth, no aggregate quality score |

## Architecture

Two components in one repo:

```
fabulous-writing/
├── backend/
│   ├── pyproject.toml            # uv-managed
│   ├── app/
│   │   ├── main.py               # FastAPI app factory, CORS, router mounting
│   │   ├── core/                 # config.py (YAML+env), models.py (pydantic), db.py (SQLite)
│   │   ├── api/                  # routers: checks.py, terminology.py, rules.py, providers.py
│   │   ├── checkers/
│   │   │   ├── base.py           # Checker protocol: async check(text, ctx) -> list[Finding]
│   │   │   ├── pipeline.py       # orchestrates checkers, dedup/merge, verification of LLM findings
│   │   │   ├── rules/            # engine.py, loader.py, checks/ (existence, substitution, occurrence, repetition)
│   │   │   ├── terminology.py    # terminology checker (compiled from SQLite terms)
│   │   │   └── llm/
│   │   │       ├── provider.py   # LLMProvider protocol
│   │   │       ├── ollama.py     # via Ollama HTTP API
│   │   │       ├── claude.py     # anthropic SDK, key from ANTHROPIC_API_KEY
│   │   │       ├── prompts.py    # per-language system prompts, JSON output schema
│   │   │       └── anchoring.py  # quote → character-offset resolution
│   │   └── services/jobs.py      # in-memory check-job manager (asyncio tasks) + SSE event queues
│   ├── rules/                    # YAML rule files: en/, de/ (style, clarity, vividness, ...)
│   ├── config.yaml               # providers, defaults
│   └── tests/
├── frontend/
│   └── src/
│       ├── api/                  # typed client, SSE subscription
│       ├── editor/               # CodeMirror setup, finding decorations (StateField)
│       ├── sidebar/              # category counts, finding list, detail card with suggestions
│       ├── terminology/          # domain/term management UI
│       └── state/                # zustand store; document persisted to localStorage
└── docs/superpowers/specs/       # this design saved as design doc + committed
```

### Core contract: the Finding model

Everything hangs off this shared shape (pydantic on backend, TS type on frontend):

```json
{
  "id": "uuid",
  "category": "spelling|grammar|style|clarity|vividness|correctness|terminology",
  "severity": "error|warning|suggestion",
  "source": "llm|rule|terminology",
  "rule_id": "style.weasel-words",
  "message": "explanation shown to the writer",
  "span": {"start": 120, "end": 135, "text": "exact flagged text"},
  "suggestions": ["replacement 1", "replacement 2"]
}
```

### Rule engine (deterministic phase)

Vale's YAML formalism, executed by our own engine. One rule per file under `backend/rules/<lang>/<category>/<name>.yml`:

```yaml
extends: existence          # or: substitution | occurrence | repetition
message: "'%s' is a weasel word — be specific."
level: warning
category: style
ignorecase: true
tokens: [very, fairly, extremely, somewhat]
```

- `existence`: flag tokens/regex matches. `substitution`: map bad→preferred (suggestion auto-filled). `occurrence`: min/max of a pattern per scope (e.g. sentence length). `repetition`: adjacent duplicate words.
- Loader validates all YAML at startup and on `POST /api/rules/reload`; invalid rules are reported, not fatal.
- Starter rule sets: EN (weasel words, clichés, passive-voice heuristic, long sentences, repeated words, intensifiers) and DE (Füllwörter, lange Sätze, Anglizismen-Substitution, doppelte Wörter).

### LLM checker (phase 1) + deterministic verification (phase 2)

- `LLMProvider` protocol: `async generate(system, user) -> str` + `name/models` metadata. Implementations: `OllamaProvider` (configurable base URL + model, model discovery via `/api/tags`), `ClaudeProvider` (anthropic SDK, model from config). Selected per request or from config default. A `FakeProvider` for tests.
- Prompt asks for a JSON array of findings; each must include the **exact verbatim quote** of the flagged span plus category, explanation, and suggestions. Language-specific prompts (EN/DE).
- **Anchoring (deterministic verification):** LLM offsets are unreliable, so `anchoring.py` locates each quote by exact string search (disambiguated by LLM-provided preceding context), with fuzzy fallback (difflib). Findings whose quote cannot be anchored are **discarded** — this is the deterministic gate over non-deterministic LLM output. The pipeline also drops LLM findings that duplicate rule/terminology findings on overlapping spans.

### Terminology

SQLite: `domains(id, name, description)` and `terms(id, domain_id, language, preferred, forbidden_variants[json], definition, case_sensitive)`. The terminology checker compiles the active domain+language's forbidden variants into word-boundary regexes; hits become findings with the preferred term as suggestion. Full CRUD via API + management UI.

### Check API

- `POST /api/checks` `{text, language, domain?, checkers?, llm_provider?, llm_model?}` → `202 {check_id}`; rules/terminology run inline (fast), LLM as asyncio task.
- `GET /api/checks/{check_id}` → `{status, findings[]}` (polling fallback for simple clients).
- `GET /api/checks/{check_id}/events` → SSE: `checker_result` event per completed checker (with its findings), then `done`.
- `GET/POST/PUT/DELETE /api/domains`, `/api/domains/{id}/terms/...` — terminology CRUD.
- `GET /api/rules` (loaded rules + validation errors), `POST /api/rules/reload`.
- `GET /api/providers` (configured providers, available models incl. live Ollama discovery).
- OpenAPI docs come free with FastAPI — that's the contract for future native/plugin clients.

### Frontend behavior

- Layout: header (language, domain, LLM provider/model selectors, check status + "Check" button) · CodeMirror editor · right sidebar.
- Sidebar: category chips with counts → expandable finding list → clicking a finding scrolls the editor to and highlights its span (selected style), and shows a detail card (message, source, suggestion buttons). Clicking a suggestion dispatches a CodeMirror transaction replacing the span.
- **Offset survival:** findings are decorations in a CodeMirror `StateField`, so positions map automatically through subsequent edits until the next check replaces them. Findings invalidated by edits inside their span are dropped.
- Debounce: 1s pause → rules+terminology check; 5s pause → LLM check (toggle in header, default on) + always available via button. In-flight LLM checks are superseded by newer ones.
- Document text persisted to localStorage; language/domain/provider settings too.

## Implementation phases (TDD throughout)

1. **Scaffolding**: git structure, backend skeleton (uv, FastAPI, health endpoint), frontend skeleton (Vite React TS), README; save + commit this design doc to `docs/superpowers/specs/2026-07-03-fabulous-writing-design.md`.
2. **Core models + rule engine**: Finding model, YAML loader with validation, the four check types, starter EN/DE rules, golden tests (rule + text → expected findings).
3. **Terminology**: SQLite schema, CRUD API, terminology checker + tests.
4. **LLM layer**: provider protocol, Fake/Ollama/Claude providers, prompts, anchoring with tests (anchoring is the trickiest unit — test exact match, ambiguous quotes, fuzzy fallback, unanchorable discard).
5. **Pipeline + check API**: job manager, SSE, dedup/merge; API tests with httpx + FakeProvider.
6. **Editor frontend**: CodeMirror with decoration StateField, debounced checking, SSE client.
7. **Sidebar + interactions**: categories, finding list, detail card, suggestion apply, selection sync editor↔sidebar.
8. **Terminology UI + settings**: domain/term management, header selectors wired to `/api/providers`.
9. **Polish + verification**: README with run instructions, end-to-end verification.

Commit after each phase on `main` (fresh repo, no branch needed unless preferred).

## Verification

- Backend: `pytest` (rule golden tests, anchoring, API with fake provider).
- Frontend: `vitest` for suggestion-application and offset-mapping logic; `npm run build` must pass.
- End-to-end: run `uvicorn` + `vite dev`; paste text with known defects (weasel words, a forbidden term, duplicated word); confirm rule findings appear ~1s after typing stops, LLM findings after the pause (with Ollama if running locally, else Claude API / fake provider); click a finding → span highlights; apply a suggestion → text updates and finding clears; `curl` the check API to confirm the polling contract.
