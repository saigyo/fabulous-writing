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
│   │   ├── routing.py           # tier routing table + per-tier availability
│   │   └── languages.py         # supported languages + NLP model status
│   ├── checkers/
│   │   ├── pipeline.py          # duplicate-diagnosis dedup between checkers
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
  "suggestions": ["replacement 1", "replacement 2"],
  "advice": ["non-applicable guidance the LLM wrapped in parentheses"]
}
```

Two invariants keep the rest of the system simple:

- **Spans are exact.** `span.start`/`span.end` are character offsets into the checked
  text and `span.text` is the verbatim slice. Checkers that cannot guarantee this
  (i.e. the LLM) must prove their spans through anchoring or their findings are dropped.
- **Suggestions are drop-in replacements** for exactly the spanned text. Applying one
  is a plain text substitution; the frontend never has to interpret them.
- **Advice is display-only.** `advice` (also on `SuggestionResponse`, see [Parsing,
  anchoring, vetting](#parsing-anchoring-vetting--the-deterministic-gate)) is guidance
  that cannot be applied as a substitution — it is never a candidate for the apply path.

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
providers; everything else works against the `LLMProvider` protocol. Besides the five
built-ins, `extra_providers` entries from config (OpenAI-compatible endpoints such as
DeepSeek, Qwen, or OpenRouter) are constructed generically. API keys are read from the
environment at construction time (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`MISTRAL_API_KEY`, `<NAME>_API_KEY` for extras; Bedrock uses the standard AWS
credential chain) — they are never stored in config or the database.

Startup also seeds the database idempotently: an example terminology domain
(`seed_terminology`) and per-language checking profiles (`seed_profiles`, see
[Checking profiles](#checking-profiles)).

### Configuration

`Settings` (`app/core/config.py`) is a pydantic model with sensible defaults, optionally
overridden by `backend/config.yaml` (`config.example.yaml` documents every key). Notable
knobs: `db_path`, `rules_dir`, `seed_terminology`, `seed_example_profiles`,
`vet_suggestions`, `dictionaries_dir`, per-provider base URLs and default models,
`providers.extra_providers` (named OpenAI-compatible endpoints — validated at load:
lowercase identifier names that don't shadow built-ins, since the name derives the
`<NAME>_API_KEY` env variable), and the per-language spaCy model map (`nlp.models`),
and the routing section (`routing.default_tier`, per-language tier maps — validated
tier/language names, per-language override of shipped defaults).

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
                         → drop_duplicates(llm, fast findings) → job.add_findings()

202 {check_id, status, findings: [fast findings], skipped_rules, scorecard: null}
  │
GET /api/checks/{id}/events   (SSE; GET /api/checks/{id} is the polling fallback,
                                same shape, with `scorecard` filled in once set)
  ├─ event: checker_result {checker, findings}
  ├─ event: llm_progress   {tokens}        (throttled to every 25 tokens)
  ├─ event: scorecard      {consistency, flow, …}  (once, only if the LLM returned one)
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
- **Cross-checker dedup** (`app/checkers/pipeline.py`): `drop_duplicates(candidates,
  existing)` discards candidates that repeat an existing diagnosis — an overlapping
  finding of the *same category*, or one flagging substantially the same span (the
  overlap covers the majority of the combined extent) in any category. Mere overlap is
  not enough: a whole-sentence finding (e.g. a sentence-length warning) must not shadow
  a different diagnosis on a few words inside it. Applied twice: across terminology
  domains (first domain wins) and to LLM findings against all fast findings
  (deterministic findings win — they are more precise and carry better fixes).
- **NLP degradation**: if the language's spaCy model is not installed, `analyze()`
  returns `None`, NLP-backed rules are skipped, and their ids are reported as
  `skipped_rules` so the UI can say so instead of silently checking less.
- **Profile inputs are resolved by the client.** The check API is deliberately
  profile-agnostic: the frontend translates the selected profile plus any header
  overrides into `domain_ids`, `rule_config`, and `llm_instructions`, and likewise
  resolves a selected quality tier into concrete `llm_provider`/`llm_model` via the
  routing table before the request. The backend never needs to join a check against
  the profiles table.

## The rule engine

Rules are single-purpose YAML files under `rules/<language>/<category>/<name>.yml` —
a Vale-inspired formalism executed by our own engine (`app/checkers/rules/`). The file
path is the rule's identity: `rules/en/style/weasel-words.yml` → rule id
`style.weasel-words`, scoped to `en`. `(language, rule_id)` is the stable key that
profiles and the rule catalog reference.

`load_rules()` validates every file at startup (and on `POST /api/rules/reload`)
against `RuleSpec`, a pydantic model with per-type required fields. Invalid files
become `RuleError` entries — reported via `GET /api/rules`, never fatal.

Every rule also carries a required `examples:` block (`bad`/`good` sentence lists,
min 1 each) — a rule file without one fails to load. `tests/test_rule_examples.py`
runs the whole catalog against its own examples (bad must trigger the rule's own
`rule_id`, good must not), so the catalog tests itself; inline rule snippets used in
`tests/test_rule_engine.py`/`test_nlp_rules.py` get an auto-appended stub block via
`write_rule()` so each test only states what it's actually about — except the
`_engine_with_two_rules` fixture (also in `test_rule_engine.py`), which builds its two
rule files by hand and appends the same stub itself rather than going through
`write_rule()`.

Rules optionally carry a `pack:` slug (use-case pack; `None` for general
always-on rules; slugs are free-form strings discovered from whatever `pack:` values
appear in the files, so a new pack needs no code change). Every language currently
ships three: `marketing`, `techdocs`, `blog`. `GET /api/rules` echoes both `pack` and
`examples` per rule entry (`RuleInfo.examples` is the typed `RuleExamples` model, not
a loose dict, so the OpenAPI schema is honest) and adds a top-level `packs` key — a
flat sorted list of the distinct pack slugs discovered across the (optionally
language-filtered) catalog, not a per-language dict — so the frontend can build a
pack picker without hardcoding pack names.

Seven check types (`extends:`), each implemented as one function in
`checkers/rules/checks/` and dispatched via the `CHECKS` table:

| Type | Flags | Needs spaCy |
|---|---|---|
| `existence` | tokens (word-bounded, CJK-edge-aware) or `raw` regexes | no |
| `substitution` | bad→preferred map; the suggestion comes free | no |
| `occurrence` | min/max matches per sentence (e.g. sentence length) | only with `count: tokens` |
| `repetition` | adjacent duplicated words | no |
| `token_pattern` | spaCy `Matcher` patterns over token attributes | yes |
| `dependency` | spaCy `DependencyMatcher` patterns over syntax trees | yes |
| `consistency` | document-scoped style-variant classification | yes |

`consistency` (`checkers/rules/checks/consistency.py`) is the odd one out: it
doesn't scan for pattern matches to report as individual findings, it classifies
every sentence in the document into one of the rule's named `variants:` (each
either a spaCy `Matcher` pattern, tried in YAML declaration order — which
doubles as priority and tie-break — or the single optional `default: true`
variant, which claims any sentence with no pattern match that still ends in a
`VERB`/`ADJ`/`AUX`) and flags every sentence in a non-majority variant once the
whole document has been classified; a document where only one variant ends up
populated produces no findings. `anchor: end` narrows a pattern variant to
matches ending within 3 tokens of the sentence end (after stripping trailing
punctuation/symbols/particles), to absorb polite endings GiNZA splits into two
tokens (でしょう → でしょ+う). `VariantSpec` (`loader.py`) enforces at load time:
≥2 variants, ≤1 default, and a default variant must not set `pattern`/`anchor`.
`ja/style/desu-masu.yml` (敬体/常体 consistency) is the reference example. The type
now backs five rules across two script families: JA desu-masu plus four
address-register rules — FR tu/vous, ES tú/usted, IT tu/Lei, ZH 你/您.

`existence` tokens and `substitution` keys are wrapped via
`bounded_pattern` (`checkers/rules/text.py`), which is CJK-edge-aware: a side
whose literal edge character is CJK (Han, kana, CJK punctuation, full-width
forms) gets no `\b` — kana/kanji count as `\w`, so a boundary there would never
fire mid-sentence — while Latin-edged sides keep `\b` (patterns for existing
EN/DE rules are byte-for-byte unchanged). Only literal edge characters are
inspected: a key whose edge is a regex metachar (e.g. `(行か|読ま)せる`) keeps
its `\b`; such patterns belong in `raw:`, which is never wrapped. Empty tokens,
`raw` entries, and swap keys are rejected at load time as rule errors (they
would crash `bounded_pattern` at check time).

NLP-backed patterns are compiled against a blank vocab at load time
(`_validate_nlp_pattern`), so a typo in a pattern attribute fails at startup with a rule
error instead of at check time.

`token_pattern`'s `Matcher` is registered with `greedy="LONGEST"`
(`checkers/rules/checks/token_pattern.py`), so a quantified pattern (e.g.
`{POS: NOUN, OP: "{4,}"}` in `rules/en/clarity/noun-string.yml`) yields only the
single longest span per starting point instead of every overlapping sub-match.

`RuleEngine.check()` iterates the language's rules, applies the profile's `RuleConfig`
filter, runs each check with a `CheckContext` (text + optional spaCy doc), and returns
findings sorted by span. `config` defaults to `None`, which is turned into a bare
`RuleConfig()` (`categories_off=[]`, `exceptions=[]`, `packs_on=[]`) — since a pack rule
additionally needs its pack listed in `packs_on` (see below), an empty `packs_on` means
**every pack rule is inactive**: `config=None` means *general rules only*, not "every
rule" (a change from before pack support, when it meant everything).

**`RuleConfig` — profile rule selection.** A profile stores category toggles, pack
opt-ins, and per-rule exceptions; a general rule (`pack` is `None`) is active iff

```python
(category not in categories_off) != (rule_id in exceptions)   # XOR
```

and a pack rule is active iff

```python
(category not in categories_off and pack in packs_on) != (rule_id in exceptions)   # pack gate ANDed in, then XOR
```

Exceptions *invert* their category's (and, for pack rules, pack's) toggle rather than
pinning a state, so a newly added rule file automatically follows its category/pack.
The same predicate is mirrored in the frontend (`isRuleActive`) so the rules page can
display activation without a round-trip.

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
| config-defined extras (e.g. `deepseek`) | `openai_compat.py` via `extra_providers` config | `<NAME>_API_KEY` |
| `fake` | `provider.py` | tests only |

`GET /api/providers` reports availability (key present / service reachable) and
discovers installed models live where the API allows it (Ollama `/api/tags`, Anthropic
`/v1/models` — newest first, OpenAI, Mistral, and extras `/models` with non-chat models
filtered out, Bedrock `ListFoundationModels`/`ListInferenceProfiles` unless models are
pinned in config). Discovery calls run concurrently with a 5 s timeout each and degrade
to the configured default model.

`GET /api/routing` (`app/api/routing.py`) annotates the tier routing table (see
[Configuration](#configuration)) with per-tier availability. It does **not** share
`/api/providers`' discovery-based logic — a deliberate deviation from the original
plan, which called for extracting one shared availability helper. Routing only needs a
cheap yes/no per provider (API key present, an Ollama ping, or Bedrock credential
availability), not a model list, so it runs its own standalone status check
(`_provider_status`) scoped to the providers actually referenced by the routing table;
`/api/providers` keeps deriving availability from its discovery calls unchanged.
Forcing a shared helper would either duplicate work or restructure discovery for no
gain. The Ollama ping and the Bedrock credential check are both bounded by the same
3 s timeout, so one unreachable provider cannot stall the response.

### Prompts

`prompts.py` builds three prompt pairs — full check, span suggestion, sentence rewrite —
all demanding the flagged `quote` copied verbatim. The full-check prompt asks for a JSON
**object envelope**, `{"findings": [...], "scorecard": {...}}` — the scorecard is a
holistic six-dimension assessment of the whole text (see [Parsing, anchoring,
vetting](#parsing-anchoring-vetting--the-deterministic-gate)); span suggestion and
sentence rewrite still demand only a bare JSON array. `extract_json_array` (used for the
`findings` key) also tolerates a bare top-level array with no envelope, so a model that
ignores the object-wrapping instruction still yields findings, just no scorecard.
Messages are written in the text's language. Profile instructions are injected by
`_with_instructions()`, which appends a clearly delimited "style and focus guidance
only" section *after* the output-format contract; empty instructions are a byte-identical
no-op.

### Parsing, anchoring, vetting — the deterministic gate

The LLM's raw response passes through four deterministic stages in
`LLMChecker.check()`:

1. **Parse** (`checker.py`): `extract_json_array` tolerates code fences and surrounding
   prose; items that don't validate as `RawFinding` are skipped individually. The
   optional `scorecard` object gets the opposite treatment — a **strict gate**: it must
   validate as `Scorecard` (all six dimensions present, each score in range) or it is
   discarded whole, with no effect on the findings list.
2. **Anchor** (`anchoring.py`): LLM-reported offsets are unreliable, so each finding is
   located by its verbatim quote — exact match, then whitespace-tolerant match, then a
   fuzzy sliding-window match (difflib, ratio ≥ 0.8 with edge refinement). Ambiguous
   quotes are disambiguated by the LLM-provided `context_before`. **Findings whose quote
   cannot be anchored are discarded** — this is what makes LLM spans trustworthy.
3. **Split advice** (`vetting.py#split_advice`, before any vetting): models sometimes
   disguise advice as a replacement, wrapping it in parentheses ("(Consider moving this
   sentence…)"). A candidate fully wrapped in `(...)` or `（…）` is reclassified as
   advice (one wrapper layer stripped) instead of a suggestion — order preserved,
   everything else passed through unchanged. This runs at both LLM surfaces: check-time
   (`LLMChecker.check()`, feeding `Finding.advice`) and the on-demand suggestions
   endpoint (feeding `SuggestionResponse.advice`). Advice is never spell-gated, never
   counted as `rejected`, and never held back — it was never a candidate for the apply
   path to begin with. All three prompt templates (`prompts.py`) additionally instruct
   the model not to disguise advice as a replacement in the first place; the paren
   convention is the deterministic backstop for when it does anyway.
4. **Vet** (`vetting.py`, when `vet_suggestions` is on): suggested fixes pass sanity
   filters (non-empty, not identical, length ratio 0.25–4, no stray JSON debris) and a
   spell gate — words unknown to pyspellchecker's frequency list *and* not whitelisted
   by the document itself are rejected; optional Hunspell dictionaries (spylls) make the
   gate morphology-aware so inflections and German compounds survive. A bad fix never
   invalidates the diagnosis: only the suggestion is dropped. Word-level spelling is
   skipped for ja/zh.

The on-demand suggestions endpoint (`POST /api/suggestions`) additionally runs a
**rule re-check** (`vet_suggestions`, stage 4): the candidate is spliced into the text
and rejected if it introduces new rule findings or fails to resolve the rule it
addresses. Scope `span` produces drop-in replacements; scope `sentence` expands the span
to whole sentences (`expand_to_sentences`) and asks for full rewrites.

Not every reject is thrown away silently. Spell-gate rejects and rule-recheck rejects
are **revealable**: `vet_candidates`/`vet_suggestions` collect them as
`HeldBackCandidate` entries (`reason_kind` `"spelling"` with the offending `words`, or
`"rules"` with the `rule_ids` the candidate still triggers or fails to resolve).
Sanity-filter rejects (the first filter inside the vet stage) are never revealable — they're malformed or
degenerate output, not a legitimate candidate a user might still want. `HeldBackCandidate`
travels on `VetResult.held_back` alongside the existing `accepted`/`rejected` fields, and
the suggestions API (`api/suggestions.py`) maps it onto the response's
`SuggestionResponse.held_back: list[HeldBackSuggestion]`, so an all-vetoed response (empty
`suggestions`, `rejected > 0`) still gives the client something to show on request instead
of a dead end.

## Checking profiles

A **profile** bundles language-specific checking presets: rule selection
(`categories_off` + `rule_exceptions`), the use-case packs it enables
(`packs_on`, JSON-encoded list of pack slugs), terminology `domain_ids`, an LLM
provider/model or quality tier, free-form `llm_instructions`, and an `example_text`
for the editor's Load-example button. `packs_on` flows unmodified from
`ProfileCreate`/`ProfileUpdate` through the store into `RuleConfig.packs_on`
when a check runs (see Rule engine below); fresh seeds default it to `[]`.

- **Storage** (`app/services/profiles.py`): a `profiles` table (JSON-encoded list
  columns, `UNIQUE(language, name)`) beside the terminology tables, plus
  `profile_seed_markers` so seeding runs once per language and deleted example profiles
  stay deleted across restarts. `packs_on` is its own `TEXT NOT NULL DEFAULT '[]'`
  column (JSON-encoded list, like `categories_off`/`rule_exceptions`) — the profile's
  rule configuration was never a single JSON blob, so adding pack support meant adding
  a column, not reshaping one. Both `packs_on` and (earlier) `llm_tier` are added to
  existing on-disk databases with a startup `PRAGMA table_info(profiles)` check plus
  `ALTER TABLE ... ADD COLUMN` when missing, so upgrading in place needs no manual
  migration step.
- **`llm_tier` column** (nullable): the profile's quality tier
  (`quality|balanced|cheap|local`), an alternative to pinning `llm_provider`/
  `llm_model`. Precedence when a profile is applied: pin wins over tier wins over "no
  opinion" — a set `llm_provider` always wins regardless of `llm_tier`; with
  `llm_provider` NULL, a set `llm_tier` selects tier mode; with both NULL, the header's
  LLM settings are left as they are (today's null-provider semantics, so existing rows
  keep behaving identically — no data migration). Fresh seeds (Standard, Marketing,
  Technical Documentation) set `llm_tier="balanced"` with `llm_provider`/`llm_model`
  NULL.
- **Seeding** (`app/services/seed_profiles.py`): every language gets a **Standard**
  profile (all rules on, defaults from config, example text from `backend/demos/`);
  every language additionally gets localized *Marketing*, *Technical Documentation*,
  and *Blog* example profiles when `seed_example_profiles` is on. Seeding is collision-safe: a
  user-created profile with the same name never crashes startup.
- **API semantics** (`app/api/profiles.py`): full CRUD plus `POST
  /api/profiles/{id}/reset`. The Standard profile is editable but cannot be renamed or
  deleted (409); only Standard can be reset to seed defaults (409 otherwise). Responses
  are **pruned**: rule ids that no longer exist for the language and deleted domain ids
  are filtered out, so stale references never reach clients. `llm_tier` is one of the
  four tier ids or `null` on both `POST` and `PUT`; `ProfileCreate` defaults it to
  `null` when omitted, while `ProfileUpdate` requires the field on every `PUT` (still
  nullable) since a full replacement should not leave it implicit.

## Documents

Documents give each piece of writing its own persisted text, check-state snapshot, and
per-document settings — the multi-document upgrade from the earlier single-buffer model.
There is one owner (`owner_id` defaults to `1`; the column exists so a future multi-user
mode is a data migration, not a schema change — nothing today issues a different value).

- **Storage** (`app/services/documents.py`): a single `documents` table — `id`, `owner_id`,
  `name`, `name_source` (`fallback|llm|user`), `text`, `language`, `profile_id`,
  `domain_ids` (JSON list), `llm_provider`/`llm_model`/`llm_tier`/`llm_auto` (the same
  per-document LLM settings the header exposes), `last_findings` (JSON list) and
  `scorecard` (JSON object or `NULL`) — the check-state snapshot travels with the text
  so a reload restores findings without re-checking — `revision`, `created_at`,
  `updated_at`.
- **`DocumentStore`** (same module) is the optimistic-locking guard: `update_document(id,
  base_revision, **fields)` applies a `WHERE id = ? AND revision = ?` conditional update
  that also bumps `revision` and `updated_at`; a `rowcount == 0` means the document either
  moved past `base_revision` (raises `RevisionConflictError(current_revision)`, → HTTP
  409) or no longer exists (`None`, → 404). `set_name(id, name, name_source)` is the one
  deliberate exception: it updates `name`/`name_source`/`updated_at` **without** touching
  `revision`, so a server-side rename (auto-titling, see below) can never invalidate a
  client's in-flight autosave by moving the revision out from under it. `list_documents()`
  returns the lighter `DocumentSummary` (`id`, `name`, `language`, `updated_at` — no
  `revision`, no content) ordered most-recently-updated first, for the sidebar; the full
  `Document` (content, settings, `revision`) is only fetched per-document via `GET
  /api/documents/{id}`.
- **API** (`app/api/documents.py`, `/api/documents` prefix):

  | Endpoint | Purpose |
  |---|---|
  | `GET /api/documents` | list summaries (sidebar) |
  | `POST /api/documents` | create (`name`, `language`, optional seed `text`/settings/findings/scorecard); `name_source` defaults to `fallback`, `llm` is server-assigned only — a client cannot claim it |
  | `GET /api/documents/{id}` | full document incl. `revision` |
  | `PUT /api/documents/{id}` | revision-guarded update of any of `name`/`content` (`text`+`findings`+`scorecard`, always written together so findings can never describe different text than they were computed against)/`settings`; a body `name` also stamps `name_source="user"` |
  | `DELETE /api/documents/{id}` | remove |
  | `POST /api/documents/{id}/generate-name` | auto-title (below) |

  `PUT` requires `revision` in the body and maps a `RevisionConflictError` to 409 with the
  current server revision in the message, so the client can decide how to reconcile
  (see the frontend's recovered-copy flow in `docs/frontend-architecture.md`).
- **Auto-naming** (`generate_name` in `app/api/documents.py` + `app/services/naming.py`):
  a no-op once a document has ever been titled or user-renamed (`name_source != "fallback"`
  short-circuits immediately — "Untitled" documents are the only ones eligible). Otherwise
  it resolves the **cheap tier** for the document's language from
  `settings.routing.languages[language]["cheap"]`, builds a title prompt
  (`build_title_prompt`), and asks that provider for one line. Any failure (missing tier
  entry, empty text, provider error) is swallowed silently and falls through to the
  fallback — auto-titling must never surface an error to the user. A usable LLM reply is
  cleaned by `clean_title()` (first line, whitespace-collapsed, surrounding
  quotes/guillemets/corner-brackets and trailing punctuation stripped, capped at 80 chars)
  and saved via `set_name(..., "llm")`. If the LLM path produced nothing (or text is
  empty), `fallback_name()` takes the first six words of the text (capped at 40 characters
  to bound spaceless CJK) and saves that via `set_name(..., "fallback")`; empty text keeps
  the localized "Untitled" name entirely (no `set_name` call). Either path uses `set_name`,
  never `update_document`, so auto-titling never bumps `revision` or risks a 409 against a
  concurrent autosave.

## API surface

| Endpoint | Purpose |
|---|---|
| `POST /api/checks` → `GET /api/checks/{id}[/events]` | run a check; poll or stream results |
| `POST /api/suggestions` | on-demand LLM fix (span) or sentence rewrite |
| `GET /api/rules`, `POST /api/rules/reload` | rule catalog + validation errors; hot reload |
| `GET/POST/PUT/DELETE /api/domains`, `/api/domains/{id}/terms`, `/api/terms/{id}` | terminology CRUD |
| `GET/POST/PUT/DELETE /api/profiles`, `POST /api/profiles/{id}/reset` | profile CRUD |
| `GET/POST/PUT/DELETE /api/documents`, `POST /api/documents/{id}/generate-name` | revision-guarded document CRUD + auto-titling (see [Documents](#documents)) |
| `GET /api/providers` | provider availability + model discovery |
| `GET /api/routing` | tier routing table with per-tier availability + reason |
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
- CI (`.github/workflows/backend.yml`) runs the suite with `--cov=app` and junit XML
  output; `scripts/ci-summary.py` renders test counts, failures, and the coverage total
  onto the run's Summary page, and the junit XML plus the HTML coverage report are
  uploaded as run artifacts. On pushes to `main` a follow-up job converts the total
  percentage into shields.io endpoint JSON on the orphan `badges` branch, which the
  README's coverage badge renders.
