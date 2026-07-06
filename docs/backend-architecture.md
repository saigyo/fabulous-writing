# Backend architecture

The backend is a Python 3.12+ / FastAPI service (managed with [uv](https://docs.astral.sh/uv/))
that turns text into **findings**: structured quality issues with exact character spans,
explanations, and one-click fixes. It combines deterministic local checkers (a YAML rule
engine and a terminology checker) with a pluggable LLM checker whose non-deterministic
output is gated by deterministic verification (anchoring and suggestion vetting).

For hands-on usage (install, config, curl examples) see the [root README](../README.md).
This document explains how the pieces fit together and why.

## Module map

```
backend/
├── app/
│   ├── main.py                  # app factory: builds and wires all singletons
│   ├── core/
│   │   ├── config.py            # Settings (YAML file + defaults); no secrets
│   │   └── models.py            # the Finding contract shared with the frontend
│   ├── api/                     # one FastAPI router per resource
│   │   ├── checks.py            # POST /api/checks + SSE event stream
│   │   ├── suggestions.py       # on-demand LLM fixes and sentence rewrites
│   │   ├── rules.py             # rule catalog + reload
│   │   ├── terminology.py       # domain/term CRUD
│   │   ├── profiles.py          # checking-profile CRUD + reset
│   │   ├── providers.py         # provider availability + live model discovery
│   │   └── languages.py         # supported languages + NLP model status
│   ├── checkers/
│   │   ├── pipeline.py          # span-overlap dedup between checkers
│   │   ├── terminology.py       # terminology checker (regex / CJK PhraseMatcher)
│   │   ├── rules/               # deterministic YAML rule engine
│   │   │   ├── engine.py        # RuleEngine + RuleConfig (profile filtering)
│   │   │   ├── loader.py        # YAML loading & validation, rule identity
│   │   │   ├── checks/          # one module per check type (existence, ...)
│   │   │   ├── text.py          # sentence splitting, message formatting
│   │   │   └── context.py       # CheckContext passed to check functions
│   │   └── llm/
│   │       ├── provider.py      # LLMProvider protocol + FakeProvider
│   │       ├── ollama.py        # local Ollama (HTTP API, streaming)
│   │       ├── claude.py        # Anthropic SDK
│   │       ├── openai_compat.py # OpenAI + Mistral (shared /v1 dialect)
│   │       ├── bedrock.py       # AWS Bedrock (boto3, credential chain)
│   │       ├── prompts.py       # per-language prompts + profile instructions
│   │       ├── checker.py       # response parsing → anchored Findings
│   │       ├── anchoring.py     # quote → span resolution (the LLM gate)
│   │       └── vetting.py       # deterministic vetting of LLM fixes
│   ├── nlp/registry.py          # lazy per-language spaCy pipelines
│   └── services/
│       ├── jobs.py              # in-memory check jobs + event streams
│       ├── terminology.py       # SQLite store: domains, terms
│       ├── profiles.py          # SQLite store: checking profiles
│       ├── seed.py              # example terminology domain
│       └── seed_profiles.py     # Standard + example profiles per language
├── rules/<lang>/<category>/*.yml  # the shipped rule catalog
├── demos/                       # seed example texts for profiles
└── tests/                       # pytest suite (one module per unit)
```

## The Finding contract

Everything hangs off one shape, defined in `app/core/models.py` and mirrored as a
TypeScript interface in the frontend (`frontend/src/types.ts`):

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

Two invariants keep the rest of the system simple:

- **Spans are exact.** `span.start`/`span.end` are character offsets into the checked
  text and `span.text` is the verbatim slice. Checkers that cannot guarantee this
  (i.e. the LLM) must prove their spans through anchoring or their findings are dropped.
- **Suggestions are drop-in replacements** for exactly the spanned text. Applying one
  is a plain text substitution; the frontend never has to interpret them.

`Language` (en, de, fr, es, it, ja, zh) is the second shared enum; every rule, term,
profile, and prompt is language-scoped.

## Application assembly

`create_app()` in `app/main.py` is a plain factory: it loads `Settings`, constructs all
long-lived objects, and hangs them off `app.state` — no globals, no import-time side
effects, which keeps tests trivial (each test builds its own app with its own temp DB
and a `FakeProvider`).

Singletons on `app.state`:

| Object | Role |
|---|---|
| `settings` | validated `Settings` (see below) |
| `terminology_store` | SQLite-backed domains/terms |
| `profile_store` | SQLite-backed checking profiles |
| `rule_engine` | all YAML rules, loaded and validated |
| `jobs` | in-memory `JobManager` for check jobs |
| `nlp` | `NlpRegistry` of lazy spaCy pipelines |
| `provider_factory` | `(name?, model?) -> LLMProvider` |

The **provider factory** is the only place that knows how to construct concrete LLM
providers; everything else works against the `LLMProvider` protocol. API keys are read
from the environment at construction time (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`MISTRAL_API_KEY`; Bedrock uses the standard AWS credential chain) — they are never
stored in config or the database.

Startup also seeds the database idempotently: an example terminology domain
(`seed_terminology`) and per-language checking profiles (`seed_profiles`, see
[Checking profiles](#checking-profiles)).

### Configuration

`Settings` (`app/core/config.py`) is a pydantic model with sensible defaults, optionally
overridden by `backend/config.yaml` (`config.example.yaml` documents every key). Notable
knobs: `db_path`, `rules_dir`, `seed_terminology`, `seed_example_profiles`,
`vet_suggestions`, `dictionaries_dir`, per-provider base URLs and default models, and the
per-language spaCy model map (`nlp.models`).

## The check flow

A check is a **job**: rules and terminology run synchronously (they are fast), the LLM
runs as a background `asyncio` task whose results stream to the client.

```
POST /api/checks {text, language, domain_ids, checkers, rule_config,
                  llm_provider, llm_model, llm_instructions}
  │
  ├─ rules        : NlpRegistry.analyze() → RuleEngine.check(doc, rule_config)   (inline)
  ├─ terminology  : TerminologyChecker.check() per domain, deduped across domains (inline)
  │
  └─ llm          : asyncio.create_task(_run_llm(...))                        (background)
                      └─ provider.generate() → parse → anchor → vet
                         → drop_overlapping(llm, fast findings) → job.add_findings()

202 {check_id, status, findings: [fast findings], skipped_rules}
  │
GET /api/checks/{id}/events   (SSE; GET /api/checks/{id} is the polling fallback)
  ├─ event: checker_result {checker, findings}
  ├─ event: llm_progress   {tokens}        (throttled to every 25 tokens)
  ├─ event: checker_error  {checker, error}   (on LLM failure; job still finishes)
  └─ event: done           {status}
```

Details worth knowing:

- **`CheckJob` / `JobManager`** (`app/services/jobs.py`): a job is an append-only event
  list plus an `asyncio.Event`; `stream()` replays history and then waits, so an SSE
  client that connects late (or reconnects) still receives every event. The manager
  keeps the last 100 jobs in an `OrderedDict` — state is in-memory and per-process by
  design (a check is ephemeral; the client re-checks rather than resumes after a
  restart).
- **Cross-checker dedup** (`app/checkers/pipeline.py`): `drop_overlapping(candidates,
  existing)` discards candidates whose span overlaps an existing finding. It is applied
  twice: across terminology domains (first domain wins) and to LLM findings against all
  fast findings (deterministic findings win — they are more precise and carry better
  fixes).
- **NLP degradation**: if the language's spaCy model is not installed, `analyze()`
  returns `None`, NLP-backed rules are skipped, and their ids are reported as
  `skipped_rules` so the UI can say so instead of silently checking less.
- **Profile inputs are resolved by the client.** The check API is deliberately
  profile-agnostic: the frontend translates the selected profile plus any header
  overrides into `domain_ids`, `rule_config`, and `llm_instructions`. The backend never
  needs to join a check against the profiles table.

## The rule engine

Rules are single-purpose YAML files under `rules/<language>/<category>/<name>.yml` —
a Vale-inspired formalism executed by our own engine (`app/checkers/rules/`). The file
path is the rule's identity: `rules/en/style/weasel-words.yml` → rule id
`style.weasel-words`, scoped to `en`. `(language, rule_id)` is the stable key that
profiles and the rule catalog reference.

`load_rules()` validates every file at startup (and on `POST /api/rules/reload`)
against `RuleSpec`, a pydantic model with per-type required fields. Invalid files
become `RuleError` entries — reported via `GET /api/rules`, never fatal.

Six check types (`extends:`), each implemented as one function in
`checkers/rules/checks/` and dispatched via the `CHECKS` table:

| Type | Flags | Needs spaCy |
|---|---|---|
| `existence` | tokens (word-bounded) or `raw` regexes | no |
| `substitution` | bad→preferred map; the suggestion comes free | no |
| `occurrence` | min/max matches per sentence (e.g. sentence length) | only with `count: tokens` |
| `repetition` | adjacent duplicated words | no |
| `token_pattern` | spaCy `Matcher` patterns over token attributes | yes |
| `dependency` | spaCy `DependencyMatcher` patterns over syntax trees | yes |

NLP-backed patterns are compiled against a blank vocab at load time
(`_validate_nlp_pattern`), so a typo in a pattern attribute fails at startup with a rule
error instead of at check time.

`RuleEngine.check()` iterates the language's rules, applies the profile's `RuleConfig`
filter, runs each check with a `CheckContext` (text + optional spaCy doc), and returns
findings sorted by span.

**`RuleConfig` — profile rule selection.** A profile stores category toggles plus
per-rule exceptions; a rule is active iff

```python
(category not in categories_off) != (rule_id in exceptions)   # XOR
```

Exceptions *invert* their category's toggle rather than pinning a state, so a newly
added rule file automatically follows its category. The same predicate is mirrored in
the frontend (`isRuleActive`) so the rules page can display activation without a
round-trip.

## The NLP registry

`NlpRegistry` (`app/nlp/registry.py`) lazily loads at most one spaCy pipeline per
language, thread-safely, with `ner` excluded for speed. A model that fails to load is
remembered as failed together with an install hint; callers get `None` and degrade
(rules report `skipped_rules`, terminology falls back to substring matching for CJK).
Japanese uses GiNZA and carries a config patch for a known GiNZA 5.2 / newer-confection
incompatibility (`compound_splitter.split_mode`).

## Terminology

Storage (`app/services/terminology.py`) is two SQLite tables: `domains(id, name,
description)` and `terms(id, domain_id, language, preferred, forbidden_variants JSON,
definition, case_sensitive)`, with `ON DELETE CASCADE` from domain to terms. CRUD is
exposed under `/api/domains` and `/api/terms`; deleting a domain also prunes it from
every profile (`ProfileStore.remove_domain_everywhere`).

The checker (`app/checkers/terminology.py`) produces two kinds of findings, both
`terminology`/`error` with the preferred term as the suggestion:

- **Forbidden variants**: for Latin-script languages, word-boundary regexes per variant
  (case-insensitive unless the term is case-sensitive). For ja/zh there are no `\b`
  boundaries, so variants are matched with spaCy's `PhraseMatcher` over tokens
  (`ORTH`/`LOWER` depending on case sensitivity), falling back to plain substring search
  when no tokenizer is available.
- **Casing violations**: for case-sensitive terms, an occurrence of the preferred term
  with the wrong casing is flagged — except an initial capital at a conventional
  sentence start (text start, after `.!?…` + closing quotes, after a newline with
  optional markdown structure characters). Variant findings win over casing findings on
  overlapping spans.

## The LLM layer

### Providers

`LLMProvider` (`app/checkers/llm/provider.py`) is a small protocol: `name` plus
`async generate(system, user, on_progress) -> str`. When `on_progress` is passed,
providers stream and report cumulative output tokens (that is what feeds the
`llm_progress` SSE events and the UI's token counter). Implementations:

| Provider | Module | Auth |
|---|---|---|
| `ollama` | `ollama.py` (HTTP, local) | none |
| `claude` | `claude.py` (Anthropic SDK) | `ANTHROPIC_API_KEY` |
| `openai`, `mistral` | `openai_compat.py` (shared OpenAI-dialect client) | `OPENAI_API_KEY` / `MISTRAL_API_KEY` |
| `bedrock` | `bedrock.py` (boto3) | AWS credential chain |
| `fake` | `provider.py` | tests only |

`GET /api/providers` reports availability (key present / service reachable) and
discovers installed models live where the API allows it (Ollama `/api/tags`, OpenAI
and Mistral `/models` with non-chat models filtered out, Bedrock
`ListFoundationModels`/`ListInferenceProfiles` unless models are pinned in config).
Discovery calls run concurrently with a 5 s timeout each and degrade to the configured
default model.

### Prompts

`prompts.py` builds three prompt pairs — full check, span suggestion, sentence rewrite —
all demanding **only a JSON array** as output and the flagged `quote` copied verbatim.
Messages are written in the text's language. Profile instructions are injected by
`_with_instructions()`, which appends a clearly delimited "style and focus guidance
only" section *after* the output-format contract; empty instructions are a byte-identical
no-op.

### Parsing, anchoring, vetting — the deterministic gate

The LLM's raw response passes through three deterministic stages in
`LLMChecker.check()`:

1. **Parse** (`checker.py`): `extract_json_array` tolerates code fences and surrounding
   prose; items that don't validate as `RawFinding` are skipped individually.
2. **Anchor** (`anchoring.py`): LLM-reported offsets are unreliable, so each finding is
   located by its verbatim quote — exact match, then whitespace-tolerant match, then a
   fuzzy sliding-window match (difflib, ratio ≥ 0.8 with edge refinement). Ambiguous
   quotes are disambiguated by the LLM-provided `context_before`. **Findings whose quote
   cannot be anchored are discarded** — this is what makes LLM spans trustworthy.
3. **Vet** (`vetting.py`, when `vet_suggestions` is on): suggested fixes pass sanity
   filters (non-empty, not identical, length ratio 0.25–4, no stray JSON debris) and a
   spell gate — words unknown to pyspellchecker's frequency list *and* not whitelisted
   by the document itself are rejected; optional Hunspell dictionaries (spylls) make the
   gate morphology-aware so inflections and German compounds survive. A bad fix never
   invalidates the diagnosis: only the suggestion is dropped. Word-level spelling is
   skipped for ja/zh.

The on-demand suggestions endpoint (`POST /api/suggestions`) additionally runs a
**rule re-check** (`vet_suggestions`, stage 3): the candidate is spliced into the text
and rejected if it introduces new rule findings or fails to resolve the rule it
addresses. Scope `span` produces drop-in replacements; scope `sentence` expands the span
to whole sentences (`expand_to_sentences`) and asks for full rewrites.

## Checking profiles

A **profile** bundles language-specific checking presets: rule selection
(`categories_off` + `rule_exceptions`), terminology `domain_ids`, an LLM
provider/model, free-form `llm_instructions`, and an `example_text` for the editor's
Load-example button.

- **Storage** (`app/services/profiles.py`): a `profiles` table (JSON-encoded list
  columns, `UNIQUE(language, name)`) beside the terminology tables, plus
  `profile_seed_markers` so seeding runs once per language and deleted example profiles
  stay deleted across restarts.
- **Seeding** (`app/services/seed_profiles.py`): every language gets a **Standard**
  profile (all rules on, defaults from config, example text from `backend/demos/`);
  EN/DE/JA additionally get localized *Marketing* and *Technical Documentation* example
  profiles when `seed_example_profiles` is on. Seeding is collision-safe: a
  user-created profile with the same name never crashes startup.
- **API semantics** (`app/api/profiles.py`): full CRUD plus `POST
  /api/profiles/{id}/reset`. The Standard profile is editable but cannot be renamed or
  deleted (409); only Standard can be reset to seed defaults (409 otherwise). Responses
  are **pruned**: rule ids that no longer exist for the language and deleted domain ids
  are filtered out, so stale references never reach clients.

## API surface

| Endpoint | Purpose |
|---|---|
| `POST /api/checks` → `GET /api/checks/{id}[/events]` | run a check; poll or stream results |
| `POST /api/suggestions` | on-demand LLM fix (span) or sentence rewrite |
| `GET /api/rules`, `POST /api/rules/reload` | rule catalog + validation errors; hot reload |
| `GET/POST/PUT/DELETE /api/domains`, `/api/domains/{id}/terms`, `/api/terms/{id}` | terminology CRUD |
| `GET/POST/PUT/DELETE /api/profiles`, `POST /api/profiles/{id}/reset` | profile CRUD |
| `GET /api/providers` | provider availability + model discovery |
| `GET /api/languages` | languages + NLP model status |
| `GET /api/health` | liveness |

FastAPI serves the OpenAPI schema at `/docs` — that is the contract for any future
non-browser client.

## Testing

`uv run pytest` runs the suite in `backend/tests/` — one module per unit (rule engine,
each API router, anchoring, vetting, providers, profiles, seeding, …). Conventions:

- API tests build a real app via `create_app(Settings(db_path=tmp_path/...))` and drive
  it with httpx/TestClient; LLM behavior is exercised through `FakeProvider` with canned
  JSON responses — no network, no mocking of internals.
- Golden tests pair a rule or text sample with its expected findings
  (`test_starter_rules.py`, `test_demo_texts.py` keeps the seeded example texts firing).
- Anchoring and vetting have dedicated edge-case suites (ambiguous quotes, fuzzy
  fallback, unanchorable discard; spell-gate whitelisting, length ratios).
- `scripts/vetting-benchmark.py` measures the spell gate's false-reject rate against
  provider outputs.
