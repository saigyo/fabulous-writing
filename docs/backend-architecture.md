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
│   ├── manage.py                # operator CLI: `python -m app.manage <command>`
│   ├── core/
│   │   ├── config.py            # Settings (YAML file + defaults); no secrets
│   │   ├── auth.py              # secrets, password hashing, HS256 tokens, TokenVerifier
│   │   ├── permissions.py       # LLMPolicy, policy_for/features_for, resolve_llm_selection (M4)
│   │   └── models.py            # the Finding contract shared with the frontend
│   ├── api/                     # one FastAPI router per resource
│   │   ├── checks.py            # POST /api/checks + SSE event stream
│   │   ├── suggestions.py       # on-demand LLM fixes and sentence rewrites
│   │   ├── llm_gate.py          # get_effective_provider: the one path from a request to a provider
│   │   ├── rules.py             # rule catalog + reload
│   │   ├── terminology.py       # domain/term CRUD
│   │   ├── profiles.py          # checking-profile CRUD + reset
│   │   ├── documents.py         # document CRUD + auto-titling
│   │   ├── folders.py           # folder CRUD + per-folder defaults
│   │   ├── validation.py        # shared validate_name() name guard
│   │   ├── providers.py         # provider availability + live model discovery
│   │   ├── routing.py           # tier routing table + per-tier availability
│   │   ├── languages.py         # supported languages + NLP model status
│   │   ├── deps.py              # get_current_user / require_admin
│   │   ├── auth.py              # POST /api/auth/login|password, GET /api/auth/me
│   │   └── admin.py             # /api/admin/users list/create/patch, /api/admin/tiers list (require_admin)
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
│   │       ├── _http_chat.py    # shared HTTP chat-completion skeleton
│   │       ├── ollama.py        # local Ollama (HTTP API, streaming) — on _http_chat
│   │       ├── claude.py        # Anthropic SDK
│   │       ├── openai_compat.py # OpenAI + Mistral (shared /v1 dialect) — on _http_chat
│   │       ├── bedrock.py       # AWS Bedrock (boto3, credential chain)
│   │       ├── prompts.py       # per-language prompts + profile instructions
│   │       ├── checker.py       # response parsing → anchored Findings
│   │       ├── anchoring.py     # quote → span resolution (the LLM gate)
│   │       └── vetting.py       # deterministic vetting of LLM fixes
│   ├── nlp/registry.py          # lazy per-language spaCy pipelines
│   └── services/
│       ├── _sqlite.py           # shared connect()/migrate_columns() for all five stores
│       ├── ownership.py         # GlobalReadOnlyError — the one exception every owner-scoped store raises
│       ├── jobs.py              # in-memory check jobs, scoped to their creator
│       ├── terminology.py       # SQLite store: domains, terms — owner-scoped, nullable owner_id
│       ├── profiles.py          # SQLite store: checking profiles — owner-scoped, nullable owner_id
│       ├── documents.py         # SQLite store: documents — owner-scoped, NOT NULL owner_id
│       ├── folders.py           # SQLite store: folders + per-folder defaults — owner-scoped
│       ├── seed.py              # example terminology domain (seeded as a global row)
│       ├── seed_profiles.py     # Standard + example profiles per language (seeded as global rows)
│       ├── users.py             # UserStore: users + admin_audit tables; per-user token_epoch
│       └── seed_admin.py        # bootstrap the first admin from the environment
├── rules/<lang>/<category>/*.yml  # the shipped rule catalog
├── demos/                       # seed example texts for profiles
└── tests/                       # pytest suite (one module per unit)
```

See [Authentication and user accounts](#authentication-and-user-accounts)
below for the auth/admin/manage modules just added to this map, and [Tiers
and LLM policy](#tiers-and-llm-policy) for `permissions.py`/`llm_gate.py`.

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
| `user_store` | `UserStore` — users + admin_audit (see [Authentication](#authentication-and-user-accounts)) |
| `auth_secret` | resolved HS256 signing secret (never logged) |
| `token_verifier` | `LocalTokenVerifier` bound to `auth_secret` |
| `login_throttle` | in-process `LoginThrottle`, per-(email, IP) backoff |

The **provider factory** is the only place that knows how to construct concrete LLM
providers; everything else works against the `LLMProvider` protocol. Besides the five
built-ins, `extra_providers` entries from config (OpenAI-compatible endpoints such as
DeepSeek, Qwen, or OpenRouter) are constructed generically. API keys are read from the
environment at construction time (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`MISTRAL_API_KEY`, `<NAME>_API_KEY` for extras; Bedrock uses the standard AWS
credential chain) — they are never stored in config or the database. `main.py`'s
factory looks up the built-in keys via `BUILTIN_ENV_KEYS` (`app/core/config.py`), a
`{"claude": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "mistral":
"MISTRAL_API_KEY"}` map — the single place these three env-var names are spelled out in
code; every other reference to them is a docstring/config-example string, not a literal
the factory re-derives.

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

**CORS is config-driven, not hardcoded** (`cors.origins`, default
`["http://localhost:5173"]` — the Vite dev server). `create_app()` passes it straight
to `CORSMiddleware` as `allow_origins`; `allow_credentials` is deliberately left unset
(`False`) since Bearer-header auth needs no cookie/credentials mode, and turning it on
alongside a permissive origin list is a common misconfiguration this avoids by
construction. A deployment serving the frontend from anywhere other than
`localhost:5173` — a built `vite preview`, a different port, a real domain — must set
`cors.origins` in `config.yaml`; there is no environment-variable override, because
`load_settings()` only reads YAML (`config_file` param aside, used by tests and
one-off scripts, never by `main.py`'s own `app` attribute).

**`environment` gates the API docs routes** (`dev` | `staging` | `production`,
default `production` — YAML-only, same as `cors.origins`, no environment-variable
override). `create_app()` passes `docs_url=None, redoc_url=None, openapi_url=None`
to the `FastAPI(...)` constructor whenever `environment` is not `"dev"`, so `/docs`,
`/redoc`, and `/openapi.json` are not registered as routes at all outside dev — not
merely gated behind auth. The default is fail-closed on purpose: a deployment that
forgets to set `environment` gets `production` (docs off), not an anonymously
reachable API surface; a developer who forgets gets their own docs turned off,
which is visible and harmless by comparison.

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
  restart). **Scoped to its creator (M3)**: `CheckJob` carries the `owner_id` passed to
  `JobManager.create(owner_id)` (`POST /api/checks`, from the authenticated caller), and
  `JobManager.get(job_id, *, owner_id)` treats a job whose `owner_id` doesn't match the
  requesting caller identically to a missing one (`None`) — both id-addressable
  endpoints, `GET /api/checks/{id}` and `GET /api/checks/{id}/events`, go through this
  same scoped lookup. This was a deliberate M3 addition beyond the plan's original
  document/folder/profile/domain scope: check ids are UUIDs (obscurity, not
  authorization) and findings carry quoted spans of the document text, so an
  unauthenticated-by-owner job lookup would have let any logged-in caller read another
  account's check results by guessing or observing an id, once documents themselves
  became private. `POST /api/suggestions` needed no equivalent change — it receives text
  in the request body and stores nothing server-side, so there is no persistent artifact
  for a foreign caller to address by id.
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
- **Logging at swallowed-failure sites.** Failures that are intentionally not surfaced
  to the client as errors are still logged via a module-level `logger =
  logging.getLogger(__name__)`, so an operator can see them without instrumenting a
  debugger: `checks.py` logs a failed LLM check (`"llm check failed (provider %s): %s"`)
  before the job still finishes with a `checker_error` event; `documents.py` logs a
  failed auto-title generation (`exc_info=True`) before falling through to the fallback
  name; `providers.py` logs each provider's failed model-discovery call at `info` level;
  `routing.py` logs a failed Ollama availability ping at `info` level. None of these
  change client-visible behavior — they were previously silent `except` blocks.

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
description, owner_id)` and `terms(id, domain_id, language, preferred,
forbidden_variants JSON, definition, case_sensitive)` — **terms carry no `owner_id` of
their own**; a term's visibility and mutability are entirely derived from its parent
domain's (`get_term`/`update_term`/`delete_term` join to `domains` and read
`d.owner_id`) — with `ON DELETE CASCADE` from domain to terms. CRUD is exposed under
`/api/domains` and `/api/terms`; deleting a domain also prunes it from every profile
(`ProfileStore.remove_domain_everywhere`, deliberately unscoped by owner — see
[Ownership](#ownership) for why a domain deletion must reach every owner's profiles).

`domains.owner_id` is nullable, exactly like `profiles.owner_id`: `NULL` is a **global**
domain — the seeded "Product docs" example, and nothing else, since `create_domain`
always writes `owner_id=user.id` regardless of caller; a caller's `users.id` is a
private one. **One-shot backfill**: when `owner_id`
is first added to an existing database, the single row matching the seed domain's name
(`seed.DOMAIN_NAME`, "Product docs" — asserted equal to `terminology.py`'s own
`_SEED_DOMAIN_NAME` by a test, since the two constants can't share an import without a
cycle) keeps `owner_id NULL`; every other row becomes `owner_id = 1`. Unlike `profiles`
and `folders`, `domains` never had a `UNIQUE` constraint to begin with, so there is no
guarded table rebuild here — only the two partial unique indexes
(`idx_domains_owner_name`, `idx_domains_global_name`, same `WHERE owner_id IS [NOT]
NULL` shape as profiles), each behind the same duplicate pre-scan and skip-with-warning
fallback. Because `domains` never enforced uniqueness pre-M3, this is the table most
likely, on a real legacy database, to have the index actually skipped for one or both
partitions — a live-DB rehearsal found neither partition needed a skip on this repo's
current data, but the code path (and its warning) exists for exactly that pre-existing
data shape, unlike `folders`, whose old `UNIQUE(name)` already made a legacy
case-*sensitive* skip the more likely finding.

Term names go through the same shared `validate_name()` guard documents/profiles/folders
use (below): `POST`/`PUT /api/terms` reject an empty (whitespace-only) `preferred` term
with a 422, closing a gap where an empty preferred term could previously be stored.

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
`async generate(system, user, on_progress) -> GenerationResult`, where
`GenerationResult` is `(text: str, usage: TokenUsage)` and `TokenUsage` is
`(input_tokens: int | None, output_tokens: int | None)` — `None` means "the
provider didn't report this," never 0, which is a real reported value. When
`on_progress` is passed, providers stream and report cumulative output tokens
(that is what feeds the `llm_progress` SSE events and the UI's token
counter); reported usage, when the provider supplies it, is preferred over
that progress approximation everywhere it is available. Per-provider usage
sources: `ollama` reads `prompt_eval_count`/`eval_count` off the final
response; `claude` reads the Anthropic SDK's `usage.input_tokens`/
`usage.output_tokens` (streamed responses combine the `message_start` input
count with the final `message_delta`'s output count); `bedrock` reads
`usage.inputTokens`/`usage.outputTokens` (streamed: taken from each
metadata event's usage; the last reported value wins); `openai`/`mistral`
(`openai_compat.py`) read
`usage.prompt_tokens`/`usage.completion_tokens` from the response body, and
additionally send `stream_options: {"include_usage": true}` on streaming
requests so the final SSE chunk carries usage at all — sent only for those
two built-in names; configured extra compat endpoints (e.g. `deepseek`) are
left untouched since some reject unknown request fields, and so simply lack
streaming usage telemetry (their non-streaming responses are unaffected). A
provider that cannot find usage anywhere in a response returns
`TokenUsage(None, None)` — missing telemetry is never an error. `FakeProvider`
takes an optional `usage: TokenUsage` (defaulting to `TokenUsage()`, both
fields `None`) for tests that need to pin specific counts. Implementations:

`ollama.py` and `openai_compat.py` both speak the same shape of HTTP chat API — "POST a
`{model, stream, messages}` payload; non-streaming returns one JSON body, streaming
yields lines" — so both are rebased onto a shared abstract skeleton,
`HttpChatProvider` (`app/checkers/llm/_http_chat.py`). The skeleton owns `generate()` and
the streaming loop (accumulating parts, calling `on_progress`, detecting `"done"`);
each subclass supplies only what's actually provider-specific: `_client()` (the
configured `httpx.AsyncClient`, e.g. Ollama's plain client vs. OpenAI-compat's
`Authorization: Bearer` header), `_chat_path` (`/api/chat` vs. `/chat/completions`),
`_response_text(data)` (extracting the message from a non-streaming body), and
`_stream_events(line)` (parsing one streamed line into `("content", text)` /
`("tokens", n)` / `("done", "")` events). Behavior is unchanged from before the
extraction — both providers' existing test suites (15 tests) passed unmodified against
the rebased implementations.

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

1. **Parse** (`checker.py`): `parse_response` tries the object envelope first
   (`{"findings": [...], "scorecard": {...}}`), falling back to a bare
   `extract_json_array` array for models that ignore the envelope
   instruction; either way, items that don't validate as `RawFinding` are
   skipped individually. The optional `scorecard` object gets the opposite
   treatment — a **strict gate**: it must validate as `Scorecard` (all six
   dimensions present, each score in range) or it is discarded whole, with
   no effect on the findings list. A response that is neither a findings
   envelope nor a bare array raises `UnparseableResponseError` — a
   `'response'`-stage failure (`classify_failure`, `app/api/llm_gate.py`)
   rather than a silent zero-findings success. Its message carries only the
   response's character count, never the text, so it is safe to store
   verbatim as the ledger's `fail_detail`; `LLMChecker.check` also attaches
   `result.usage` to the exception (`exc.usage`) before re-raising, since
   `generate()` already succeeded and burned real tokens before the parse
   failed — `_run_llm` reads that attached usage back off the exception to
   settle the failed run's real `input_tokens`/`output_tokens` instead of
   `NULL`.
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
  columns, nullable `owner_id` as of M3 — see below) beside the terminology tables,
  plus `profile_seed_markers` so seeding runs once per language and deleted example
  profiles stay deleted across restarts. `packs_on` is its own `TEXT NOT NULL DEFAULT
  '[]'` column (JSON-encoded list, like `categories_off`/`rule_exceptions`) — the
  profile's rule configuration was never a single JSON blob, so adding pack support
  meant adding a column, not reshaping one. `packs_on`, (earlier) `llm_tier`, and (M3)
  `owner_id` are all added to existing on-disk databases with a startup `PRAGMA
  table_info(profiles)` check plus `ALTER TABLE ... ADD COLUMN` when missing, so
  upgrading in place needs no manual migration step.

  **Ownership** (M3): `owner_id INTEGER` — `NULL` for a **global** profile (visible to
  and, per [Ownership](#ownership) below, mutable only by an admin) or a caller's
  `users.id` for a private one. `Profile.is_global` is a `computed_field` (`owner_id is
  None`) — the raw `owner_id` never reaches an API response (`exclude=True` on the
  field); callers only ever see the derived boolean. **One-shot backfill**, run once
  when `owner_id` is first added to an existing database: every `is_standard=1` row and
  every row whose `(language, name)` matches a name in `SEED_EXAMPLE_NAMES` *and* whose
  language already has a `profile_seed_markers` row becomes global (`owner_id` stays
  `NULL`, since `ALTER TABLE ... ADD COLUMN` with no `DEFAULT` leaves existing rows
  `NULL`); every other pre-existing row is explicitly set to `owner_id = 1` (the admin,
  by migration-time convention — see [Ownership](#ownership) for why this is safe).
  This runs exactly once, guarded by the same `"owner_id" not in columns` check that
  gates the `ALTER TABLE`: a later rename onto a seed name must never re-globalize an
  already-private row. **Guarded rebuild**: the legacy `UNIQUE(language, name)`
  table-level constraint enforced global cross-owner uniqueness, which is wrong once
  names are meaningful per-owner — SQLite cannot drop a table-level constraint without
  a rebuild, so `_migrate()` detects `"UNIQUE" in sql.upper()` against the stored DDL
  and, if present, creates `profiles_new` from the column-listed `_SCHEMA_TABLE`, copies
  every row across, drops the old table, and renames the new one in — the same
  create-copy-drop-rename shape `folders` uses (above). In place of the single dropped
  constraint, two **partial** unique indexes are created (SQLite treats every `NULL` as
  distinct from every other `NULL`, so one composite index covering both global and
  per-owner rows would never actually enforce global-name uniqueness):
  `idx_profiles_owner_lang_name` — `UNIQUE(owner_id, language, name COLLATE NOCASE)
  WHERE owner_id IS NOT NULL` — and `idx_profiles_global_lang_name` — `UNIQUE(language,
  name COLLATE NOCASE) WHERE owner_id IS NULL`. Each is preceded by a duplicate
  pre-scan (`GROUP BY … , lower(name) HAVING count(*) > 1`, partitioned the same way as
  the index it guards); if the scan finds any collision in that partition, the index is
  **skipped** and the collision logged as a warning instead of crashing startup — the
  same skip-with-warning pattern `folders`/`domains` use, since a pre-existing database
  offers no general guarantee that no two rows in a partition already share a
  case-insensitive name.
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
  /api/profiles/{id}/reset`, all owner-scoped (`ProfileStore` methods take `owner_id`
  and the query itself is `WHERE owner_id IS NULL OR owner_id = ?`, so a global profile
  is visible to everyone and a private one only to its owner — a foreign private
  profile id 404s exactly like a nonexistent one, never 403; see
  [Ownership](#ownership)). The Standard profile is editable but cannot be renamed or
  deleted; only Standard can be reset to seed defaults. **Two independent guards can
  both refuse a mutation, and their status codes differ on purpose** (adjudicated
  against spec §7.2 after an earlier plan draft assumed a flat 409 for every caller):
  a **non-admin** touching *any* global row — Standard or not — is refused **403**
  ("Only admins can change built-in items", `GlobalReadOnlyError` mapped by the router)
  before the Standard-specific rule is even consulted; an **admin**, who is allowed to
  mutate global rows in general, hits the Standard-specific **409** ("The Standard
  profile cannot be renamed"/"…deleted"/"Only the Standard profile can be reset") — a
  business rule about *this one profile*, not an authorization boundary. The router
  checks 403 before 409 in `update`/`delete` (`app/api/profiles.py`) precisely so a
  non-admin's rejection reads as "you can't touch built-ins," never as "renaming
  Standard specifically is forbidden," which would leak that the row is Standard to a
  caller who was never going to be allowed to touch it regardless. Responses are
  **pruned**: rule ids that no longer exist for the language and deleted domain ids
  are filtered out, so stale references never reach clients. Pruning is existence-only,
  not owner-scoped: if an admin points a *global* profile at one of their own *private*
  domains, every other viewer of that profile still sees the domain's bare integer id in
  `domain_ids` — never its name, terms, or findings, since the checker and every
  copy-forward path re-derive domain content from the caller's own domain list, never
  from the profile's raw ids. Adjudicated as acceptable: per-viewer pruning of a shared
  global profile's `domain_ids` would add real complexity for exposure limited to an
  opaque integer. `llm_tier` is one of the
  four tier ids or `null` on both `POST` and `PUT`; `ProfileCreate` defaults it to
  `null` when omitted, while `ProfileUpdate` requires the field on every `PUT` (still
  nullable) since a full replacement should not leave it implicit.

## Documents

Documents give each piece of writing its own persisted text, check-state snapshot, and
per-document settings — the multi-document upgrade from the earlier single-buffer model.
`owner_id` (`INTEGER NOT NULL DEFAULT 1` — the column, and its default, predate M3 and are
unchanged in the DDL) is the caller's `users.id`: every store method (`list_documents`,
`get_document`, `update_document`, …) now takes and enforces `owner_id`, so one account's
documents are simply absent from another's queries — see [Ownership](#ownership) below.
The `DEFAULT 1` was always inert for scoping purposes (this section used to describe it as
a placeholder for "a future multi-user mode"): every write path has always supplied
`owner_id` explicitly (`create_document` requires it as a keyword-only argument, dropped
from the pydantic model's own `= 1` default at the same time), so the column default never
actually determined a row's owner — it only matters as a defensive fallback for a
hand-written `INSERT` that forgot the column. What M3 changed is that `owner_id` is finally
*enforced*: pre-M3 code accepted the column but never scoped a query by it, so every
document was visible to every logged-in caller regardless of whose id was stored.

All five SQLite-backed stores (`terminology.py`, `profiles.py`, `documents.py`,
`folders.py`, `users.py` under `app/services/`) share `connect()`, and three of them
(`documents.py`, `folders.py`, `profiles.py`) also share `migrate_columns()`, from
`app/services/_sqlite.py` instead of each hand-rolling the same plumbing:
`connect(db_path)` is a context manager that wraps `sqlite3.connect` with
`row_factory = sqlite3.Row`, `PRAGMA foreign_keys = ON`, and — unlike sqlite3's own
context manager, which only commits/rolls back — also guarantees the connection itself
is closed afterward; `migrate_columns(conn, table, columns)` adds any missing
`(name, declaration)` columns via `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN`,
the same idempotent phased-in-column pattern those three stores already used for things
like `documents.folder_id` and `profiles.packs_on`/`llm_tier`, now with one
implementation instead of three copies. Each store keeps a thin `_connect()` delegate for its own
docstring/type-hint purposes but forwards straight to the shared `connect()`.

- **Storage** (`app/services/documents.py`): a single `documents` table — `id`, `owner_id`,
  `name`, `name_source` (`fallback|llm|user`), `text`, `language`, `profile_id`,
  `domain_ids` (JSON list), `llm_provider`/`llm_model`/`llm_tier`/`llm_auto` (the same
  per-document LLM settings the header exposes), `last_findings` (JSON list) and
  `scorecard` (JSON object or `NULL`) — the check-state snapshot travels with the text
  so a reload restores findings without re-checking — `revision`, `created_at`,
  `edited_at`, `checked_at` (nullable), `updated_at`, and `folder_id` (nullable
  `INTEGER`, no `FOREIGN KEY` — see [Folders](#folders) below).

- **The three-timestamp model.** `created_at` never changes after insert. The other two
  split what used to be a single `updated_at`-drives-everything model into two distinct
  questions, because a check-triggered save and an actual edit are not the same event
  for recency purposes:

  | Column | Bumped by | Meaning | Nullable |
  |---|---|---|---|
  | `edited_at` | `update_document` **only when** the `text` or `name` actually changed | "when did the writer last change this document" — **this is what sidebar ordering rides** | no |
  | `checked_at` | `update_document` **only when** the update carries `last_findings` and/or `scorecard` | "when was this document's check state last written" — display/diagnostic only, not an ordering key | yes (`NULL` until the first check-save) |
  | `updated_at` | every `update_document`/`set_name`/`set_folder` write, unconditionally | technical "last row write" bookkeeping timestamp; not used for ordering or display | no |

  `update_document` computes both conditionally in one pass: `text_changed = "text" in
  fields and fields["text"] != current.text`, `name_changed` likewise for `name`;
  `edited_at` becomes `now` if either is true, else it carries the current value forward
  unchanged. `checked_at` becomes `now` if the update includes `last_findings` and/or
  `scorecard` (a "carries check state" write — this is what an autosave triggered purely
  by the fast/LLM check-and-save cycle looks like when the user hasn't typed), else it
  too carries forward unchanged. Both bumps can fire on the same `PUT` (a save that both
  changed the text and carries fresh findings bumps both) — they are independent
  conditions on the same write, not mutually exclusive branches. `set_name(id, name,
  name_source)` and `set_folder(id, folder_id)` **never bump `edited_at` or
  `checked_at`** — like their pre-existing `revision`-skipping behavior (below), a
  server-side rename or a sidebar move is not the writer editing the document's content,
  so neither should touch the timestamp that drives "most recently edited." They still
  bump `updated_at` unconditionally, since a row write happened.

  **Practical effect**: a background check-and-save (autosave firing after the fast
  check's findings/scorecard land, with the writer not having typed anything else)
  bumps `revision` and `checked_at` but leaves `edited_at` untouched — so it does **not**
  reorder the sidebar and does **not** change the relative time shown next to the
  document. Only the writer actually changing the text (or an explicit rename) moves a
  document to the top.

- **`DocumentStore`** (same module) is the optimistic-locking guard: `update_document(id,
  base_revision, **fields)` applies a `WHERE id = ? AND revision = ?` conditional update
  that also bumps `revision`, `updated_at`, and (conditionally, per the table above)
  `edited_at`/`checked_at`; a `rowcount == 0` means the document either moved past
  `base_revision` (raises `RevisionConflictError(current_revision)`, → HTTP 409) or no
  longer exists (`None`, → 404). `set_name(id, name, name_source)` is the one deliberate
  exception: it updates `name`/`name_source`/`updated_at` **without** touching
  `revision` (and, per the three-timestamp model above, without touching `edited_at` or
  `checked_at` either), so a server-side rename (auto-titling, see below) can never
  invalidate a client's in-flight autosave by moving the revision out from under it.
  `list_documents()` returns the lighter `DocumentSummary` (`id`, `name`, `language`,
  `folder_id`, `created_at`, `edited_at`, `checked_at`, `updated_at` — no `revision`, no
  content) ordered **`edited_at DESC, id DESC`** (most-recently-*edited* first, ties
  broken by highest id first — id-descending as a stable, deterministic tiebreak when
  two documents share a same-second `edited_at`), for the sidebar; the full `Document`
  (content, settings, `revision`) is only fetched per-document via `GET
  /api/documents/{id}`.

- **Migration seeding**: `edited_at`/`checked_at` are added to existing on-disk databases
  the same idempotent way as other phased-in columns (`folder_id`, `profiles.packs_on`/
  `llm_tier` — see [Checking profiles](#checking-profiles)): a startup `PRAGMA
  table_info(documents)` check plus `ALTER TABLE ... ADD COLUMN` when missing. On first
  add, existing rows are backfilled with `UPDATE documents SET edited_at = updated_at`
  and `UPDATE documents SET checked_at = updated_at` — so pre-migration documents keep
  their prior `updated_at`-based ordering as a reasonable starting point (a document that
  hasn't been touched since the migration doesn't jump to "never checked"), and every
  subsequent write then follows the new conditional-bump rules above.
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

## Folders

Folders group documents for organization and, as of phase 3, carry optional per-folder
defaults applied when a document is created inside them. Deleting a folder never
deletes what it contains.

- **Storage** (`app/services/folders.py`): a single `folders` table — `id`, `owner_id`
  (`INTEGER NOT NULL`, the caller's `users.id`), `name`, `created_at`, plus seven nullable
  defaults columns added by phase 3 (below). `FolderStore` is deliberately simpler than
  `DocumentStore`: no revision, no optimistic locking — a folder is just a named bucket,
  scoped by owner, so the only invariant worth enforcing is **unique names per owner**,
  case-insensitively (a `sqlite3.IntegrityError` from the unique index on
  `create_folder`/`rename_folder` is caught and re-raised as `ValueError`, which the API
  layer maps to 409). `list_folders()` orders case-insensitively by name (`COLLATE
  NOCASE`) then `id`, so the sidebar's alphabetical folder list needs no client-side sort
  for the initial fetch (the frontend still re-sorts locally after mutations — see
  `docs/frontend-architecture.md`).

  **M3's guarded rebuild.** The pre-M3 table carried an inline `UNIQUE` on `name`
  (case-sensitive, so `"Blog"` and `"blog"` could already coexist as two folders) and
  `owner_id INTEGER NOT NULL DEFAULT 1` — both wrong once folders are per-user: global
  uniqueness on `name` would block two different owners from both naming a folder
  "Notes", and a silent `DEFAULT 1` would let an `INSERT` that forgot `owner_id` file
  under the admin instead of failing loudly. SQLite cannot drop an inline `UNIQUE` or a
  column default without rebuilding the table, so `_migrate()` detects either
  (`"UNIQUE" in sql.upper() or "DEFAULT 1" in sql` against `sqlite_master`'s stored DDL)
  and, if present, creates a `folders_new` table from the current `_SCHEMA` (which has
  neither), copies every row across explicitly by column list, drops the old table, and
  renames the new one into place — the same
  create-copy-drop-rename shape [Checking profiles](#checking-profiles) above uses for
  the analogous `profiles` rebuild. Row count and content are preserved exactly; only the
  DDL changes. After the rebuild (or immediately, on a database that already lacks both),
  `_migrate()` creates `idx_folders_owner_name` — `UNIQUE(owner_id, name COLLATE
  NOCASE)` — replacing the old global `UNIQUE(name)` with a per-owner, case-insensitive
  one. As with the profiles indexes above, a duplicate pre-scan
  (`GROUP BY owner_id, lower(name) HAVING count(*) > 1`) guards the `CREATE UNIQUE INDEX`:
  if any owner already has case-duplicate folder names (impossible on a fresh migration
  from a single-owner DB, since the old index was already unique-per-name globally, but
  guarded defensively the same way domains/profiles are), the index is skipped and a
  warning logged instead of crashing startup.
- **Lossless delete** (`delete_folder`): removing a folder and detaching its documents
  happen in the same transaction — `UPDATE documents SET folder_id = NULL WHERE folder_id
  = ?` runs before the `DELETE FROM folders`, both under the store's single `_connect()`
  context manager (commit-or-rollback as one unit). A folder's documents are never
  cascade-deleted; they always survive as ungrouped. `delete_folder` returns whether a row
  was actually removed, so the API can 404 a repeat delete of the same id.
- **API** (`app/api/folders.py`, `/api/folders` prefix):

  | Endpoint | Purpose |
  |---|---|
  | `GET /api/folders` | list all folders, name-sorted, defaults pruned at read time (below) |
  | `POST /api/folders` | create (`name`); 422 on empty/oversized (>100 chars) name, 409 on a name collision; new folders start with all seven defaults `NULL` |
  | `PUT /api/folders/{id}` | rename; same 422/409 validation, 404 if the folder doesn't exist |
  | `PUT /api/folders/{id}/defaults` | full-replace the seven defaults (below); 422 validation matrix, 404 if the folder doesn't exist |
  | `DELETE /api/folders/{id}` | delete (204); members drop to ungrouped in the same transaction; 404 if already gone |

  Name validation (`_validated_name`: strip, then reject empty or >100 chars) is shared
  by create and rename so both endpoints reject the same inputs the same way.
  `rename_folder` and `set_folder_defaults` now route their responses through the same
  `_pruned` read-time helper `list_folders` already used (below), so a renamed folder or
  a folder whose defaults were just updated never echoes back a dangling
  `default_profile_id`/`default_domain_ids` reference either — the three folder-mutating
  endpoints and the list endpoint all show the identical pruned view.

`app/api/validation.py`'s `validate_name(raw, *, message, max_len=None)` is the one
shared name guard behind all of this: strip, reject empty with the caller-supplied
per-entity message (so existing 422 texts like "Document name must not be empty" /
"Profile name must not be empty" / "Folder name must not be empty" /
"Preferred term must not be empty" stay byte-identical), and optionally enforce a max
length (folders' 100-char cap; documents and profiles pass no `max_len`). It backs name
validation in `app/api/documents.py`, `app/api/profiles.py`, `app/api/folders.py`
(`_validated_name`, above), and `app/api/terminology.py` (the empty-`preferred` guard
noted in [Terminology](#terminology)) — one validator instead of four near-duplicate
strip-and-check blocks.

### Per-folder defaults

Phase 3 gives each folder optional default settings — language, profile, domains, LLM
provider/model/tier, and the auto-flag — applied to documents created inside it, mirroring
the same fields `documents` itself stores (typed nullable columns, not a JSON blob).

- **Schema and migration**: `FolderStore._migrate()` is the idempotent hook phase 2
  reserved for this — the same `PRAGMA table_info(folders)`-then-`ALTER TABLE ... ADD
  COLUMN` guard used for `documents.folder_id` and `profiles.packs_on`/`llm_tier` (see
  [Documents](#documents) and [Checking profiles](#checking-profiles)), so it's safe to
  run against a pre-phase-3 database and a no-op on repeated startup. It adds
  `default_language TEXT`, `default_profile_id INTEGER`, `default_domain_ids TEXT` (JSON
  array or `NULL`), `default_llm_provider TEXT`, `default_llm_model TEXT`,
  `default_llm_tier TEXT`, `default_llm_auto INTEGER` (tri-state: `NULL`/`0`/`1`). `NULL`
  means "no default for this field" on every column; `default_domain_ids` additionally
  distinguishes `NULL` (unset) from the JSON-encoded `[]` (a *set* default of "no
  domains") — the same NULL-vs-empty-list distinction matters throughout the apply and
  pruning logic below.
- **Models**: `FolderDefaults` (a `BaseModel` with all seven fields, each optional) holds
  just the defaults; `Folder(FolderDefaults)` inherits from it and adds `id`, `owner_id`,
  `name`, `created_at` — so every `Folder` response already carries the defaults fields
  with no separate nested object, and `set_defaults` can accept a bare `FolderDefaults`
  without the row's identity fields.
- **`set_defaults(folder_id, defaults)`** is a **full replace, not a merge**: the `UPDATE`
  statement writes all seven columns from the given `FolderDefaults` unconditionally
  (encoding the language as its `.value`, domain ids via `json.dumps`, the auto-flag via
  `int()`/`None`), so clearing a single field means the caller must resend the rest of the
  current state unchanged — same contract as `documents`' settings update, not a partial
  PATCH. Returns `None` for an unknown `folder_id` (checked via `get_folder` first) so the
  API can 404.
- **`PUT /api/folders/{id}/defaults`** (`FolderDefaultsPayload`, mirroring
  `FolderDefaults` field-for-field) validates before writing, 422 with a detail message
  on any of:
  - `default_profile_id` set while `default_language` is `None` — the invariant *profile
    default ⇒ language default* is enforced here as well as by the UI (the dialog disables
    the profile selector until a language is chosen, but the API doesn't trust that alone);
  - `default_profile_id` set to an id that doesn't resolve via `profile_store.get_profile`;
  - that profile resolving but belonging to a different language than `default_language`
    (a profile default must be usable the moment the folder's language default is
    applied);
  - any id in `default_domain_ids` not present in `terminology_store.list_domains()`.

  404 if the folder itself doesn't exist (checked by `set_defaults` returning `None`).
  Folder create/rename/delete are otherwise untouched by phase 3 — `create_folder` still
  starts every new folder with all seven defaults `NULL`.
- **Read-time pruning** (`_pruned`, `app/api/folders.py`): `GET /api/folders` maps every
  folder through the same dead-reference philosophy as the documents `GET` pruning (see
  [Documents](#documents)) — if `default_profile_id` no longer resolves to an existing
  profile, it's omitted from the *response* (`model_copy(update=...)`), while the language
  default is left in place; any ids in `default_domain_ids` that no longer resolve to a
  known domain are dropped from the returned list. Critically, **the database row is never
  written** by pruning — only the read-time view changes, so a profile or domain restored
  under the same id later would make the original default reappear (this is deliberate:
  pruning is a display/apply-time filter, not a destructive edit the user never asked for).
  Because pruning happens in `GET /api/folders`, the frontend's document-creation overlay
  (`applyFolderDefaults`, see `docs/frontend-architecture.md#documents`) never has to
  re-derive or duplicate this logic — it only ever sees already-pruned folder objects.

### Documents carry a folder

`documents.folder_id` (nullable `INTEGER`, added via the same idempotent
`ALTER TABLE ... ADD COLUMN` pattern used for other phased-in columns — see
[Checking profiles](#checking-profiles) for the precedent) is the only schema change
folders made to the documents table. `POST /api/documents` accepts an optional
`folder_id`, validated against the folder store (422 `"Unknown folder"` if it doesn't
resolve) before the document is created directly inside that folder — this is what
lets the sidebar's "New document here" skip a separate move call.

**`POST /api/documents/{id}/move`** (`MoveRequest{folder_id: int | None}`) is the
one dedicated mutation: it re-validates the target folder (same 422 as create) and
calls `DocumentStore.set_folder(id, folder_id)`, then 404s if the document itself
doesn't exist. `set_folder` updates `folder_id` and `updated_at` only — **it never
touches `revision`**, for exactly the reason `set_name` doesn't (see
[Documents](#documents) above): moving a document between folders is a sidebar
action wholly outside the editor's autosave lifecycle, and bumping `revision` would
risk 409-ing an in-flight `PUT` from a client mid-edit over content that the move
never touched. Last move wins (no optimistic lock) — the same trade-off `set_name`
already makes, since a folder assignment race is much lower-stakes than a lost edit.

**Phase 3**: the per-folder defaults described above land exactly the way this section
predicted — additive nullable columns via `_migrate`, `Folder` still the same response
shape (never a bare dict, never a nested sub-object beyond `FolderDefaults` inheritance).
Applying those defaults on creation is entirely a frontend concern (`applyFolderDefaults`
in `src/documents/documents.ts`, see `docs/frontend-architecture.md#documents`) —
`POST /api/documents` itself is unchanged by phase 3; it still just accepts whatever
settings the client sends in the create payload, same as before defaults existed.

## Authentication and user accounts

Milestone 1 of the multi-user work added user accounts, local email/password
login, an admin user-management API, and an operator CLI, without
authenticating any existing endpoint. Milestone 2 closed that gap:
`documents`, `folders`, `checks`, `profiles`, `terminology`, `rules`,
`providers`, `routing`, `suggestions`, and `languages` all require a
logged-in caller, and the frontend ships with the login gate, the bearer
transport, and the account menu needed to satisfy it (see
[frontend-architecture.md](frontend-architecture.md)). M2 answered *who can
call the API at all*, not *whose rows a given caller can see* — every
document, folder, profile, and terminology domain was still shared across
every account. **Milestone 3 (this one) is what scopes data to the caller
who created it** — see [Ownership](#ownership) below.

### Enforcement: router-level auth

`app/main.py#create_app` attaches `Depends(get_current_user)` at
**router-level inclusion**, not on individual endpoints:

```python
protected = [
    terminology_router, checks_router, languages_router, rules_router,
    providers_router, suggestions_router, documents_router,
    folders_router, profiles_router, routing_router,
]
for router in protected:
    app.include_router(router, dependencies=[Depends(get_current_user)])
app.include_router(auth_router)
app.include_router(admin_router)
```

`auth_router` is excluded from that loop because `POST /api/auth/login` must
stay public; its own two other endpoints (`GET /api/auth/me`, `POST
/api/auth/password`) declare `get_current_user` individually instead.
`admin_router` is excluded too — it already carries the strictly stronger
`require_admin` on itself (see below). Attaching the dependency at inclusion
rather than editing it into each of the ten router files means a router
added to `protected` later inherits enforcement by construction, and one
*not* added is a one-line diff to catch in review, rather than a
per-endpoint omission that has to be individually noticed.

`backend/tests/test_auth_enforcement.py` is the check that keeps this true:
it walks the app's actual route tree (`app.routes`, recursing through
FastAPI's internal `_IncludedRouter` wrapper) rather than a hand-maintained
endpoint list or the OpenAPI schema alone — the schema silently omits any
`include_in_schema=False` route, which is exactly the flag an
internal/ops/debug endpoint would carry if someone forgot to wire it up. The
test asserts every discovered `(path, method)` pair requires auth except a
`PUBLIC` allowlist of exactly `{("/api/health", "GET"), ("/api/auth/login",
"POST")}`, and separately asserts those two are actually reachable
anonymously (not just registered unauthenticated by omission).

### Users and the audit trail

`app/services/users.py` adds two SQLite tables via the same idempotent
`CREATE TABLE IF NOT EXISTS` pattern every other store uses: `users` (`id`,
`external_id` — the Supabase subject UUID in supabase mode, `UNIQUE`, `NULL`
in local mode — `email
UNIQUE COLLATE NOCASE`, `display_name`, `password_hash`, `tier` (a free-form
string, validated at the API layer rather than a DB `CHECK` — SQLite cannot
alter a `CHECK` without rebuilding the table, so a constraint would turn
"add a tier" into a migration), `is_admin`, `is_active`, `created_at`) and
`admin_audit` (`id`, `actor_id` nullable, `target_id`, `field`, `old_value`,
`new_value`, `created_at`) — one row per changed field, with `actor_id NULL`
marking an action taken by the operator CLI rather than through a web
session. `tier` is **not** a code-level `Literal`: as of M4, valid tier
names are whatever the deployment's `tiers:` config defines (see [Tiers and
LLM policy](#tiers-and-llm-policy) below) — `basic`/`premium` are only the
fallback names `app/api/admin.py#_known_tiers` accepts when no
`tiers:` block is configured at all, not a fixed enum baked into the schema
or the model.

`User` (the pydantic model every caller sees) never carries
`password_hash`, so no code path can leak it into an API response by
accident. Email lookups (`get_by_email`, `verify_credentials`) use `COLLATE
NOCASE`, and the `UNIQUE` constraint is declared the same way, so
`Alice@example.com` and `alice@example.com` are one account both at lookup
time and at the database's own duplicate check.

`verify_credentials` is where the timing-equalisation defense actually
meets the database: `check_password` (below) runs unconditionally, even
when no row matched, so an unknown email spends the same bcrypt time as a
wrong password on a real account. The method's own comment warns against
adding an early `if row is None: return None` — that would skip bcrypt for
unknown emails and reopen the account-enumeration timing oracle the generic
401 (below) is meant to close.

### `app/core/auth.py` — secrets, passwords, tokens

**Secret resolution** (`resolve_auth_secret`) is fail-closed: `FW_AUTH_SECRET`
must be at least 32 characters or startup raises `AuthConfigError`. The one
escape hatch is `auth.ephemeral_secret: true` (config-only, never an env
var), which generates a random per-process secret and logs a warning — every
token issued before a restart is worthless after it, so this is explicitly
"never outside development."

**Password hashing** (`hash_password`/`check_password`) wraps bcrypt with a
72-byte ceiling — bcrypt's own hard input limit, not a policy choice. The
write path (`hash_password`) raises on an over-long password; every caller
validates first via `validate_password`, so silently truncating here would
weaken a credential without telling anyone. The read path (`check_password`)
never raises: an over-long candidate is truncated only far enough to keep
`bcrypt.checkpw` from throwing, which still runs (to preserve timing) before
the function unconditionally returns `False` — no over-long password could
ever have been *stored*, once `hash_password` started rejecting them, so no
over-long candidate can ever legitimately match. A module-level
`_dummy_hash()` (`lru_cache(maxsize=1)`) supplies a real hash to check
against when no account matches at all, which is what makes
`verify_credentials`'s unconditional bcrypt call meaningful.

**Tokens** (`issue_token`/`LocalTokenVerifier`) are HS256 JWTs with a
24-hour TTL and no refresh tokens. `LocalTokenVerifier.verify()` pins
exactly one algorithm (`algorithms=["HS256"]` — never `none`, never an
asymmetric algorithm an attacker could supply a public key for) and requires
`exp`, `iss`, `aud`, and `iat` to all be present, with `iss`/`aud` both the
literal string `fabulous-writing`. `iat` gets hand-rolled handling: PyJWT's
own `verify_iat` is disabled and the 60-second future-leeway check is done
explicitly, so the tolerance doesn't depend on PyJWT's version-specific
interpretation of a future issue time — disabling that flag also disables
PyJWT's own type check on `iat`, so `LocalTokenVerifier` re-validates that
the claim is actually numeric before comparing it.

**`TokenVerifier` is a `Protocol`, and every implementation returns the
local `users.id`** — never an external subject id. That return value is the
seam that let Supabase Auth (`auth.mode: supabase`, below) arrive without
touching the request path: `SupabaseTokenVerifier` resolves a Supabase
subject UUID to `users.external_id` internally and fails closed if
unlinked, so nothing downstream — `get_current_user`, any handler reading
`CurrentUser.id` — changes shape between the two modes.

### `app/api/deps.py` — per-request identity

`get_current_user` reads the `Authorization: Bearer <token>` header, verifies
it via `app.state.token_verifier`, and then **re-reads the user row from the
database on every request** rather than trusting the token's claims. That
re-read is what makes deactivation and de-admin take effect immediately: the
alternative (trusting `is_admin`/`is_active` baked into the token) would need
token-revocation machinery to get the same guarantee. Every authentication
failure — missing header, malformed/expired token, unknown or inactive user —
collapses to the same `401 "Not authenticated"`, so a caller cannot
distinguish "no such account" from "token expired" from "account
deactivated." `require_admin` layers a `403` on top for a non-admin caller.

**`password_changed_at` is the second revocation lever**, alongside
deactivation above. A password change updates `users.password_changed_at` to
the current UTC time (second granularity, via `_utcnow()`); `get_current_user`
compares it against the token's own `iat` and rejects (401) any token issued
strictly before that timestamp. Nothing needs to track individual token
identifiers or maintain a blocklist — every outstanding token for that user,
regardless of how many are in flight, becomes unusable the instant the
column is written, without touching `LocalTokenVerifier` or the JWT itself.

**`password_changed_at`'s same-second residual, closed by M3's token
epoch.** Both sides of the comparison above are second-granularity (`iat`
from `fromtimestamp(..., UTC)`, `password_changed_at` from `_utcnow()`), and
the check is a strict `<` — so a token issued in the *same* wall-clock
second as the password change was not revoked; it survived for the
remainder of its normal 24-hour lifetime. M3 closes this exactly, with a
per-user `token_epoch` counter (`users.token_epoch`, `INTEGER NOT NULL
DEFAULT 0`) rather than a wall-clock comparison: `set_password`
(`app/services/users.py`) bumps it in the same `UPDATE` that sets
`password_changed_at`, `issue_token` (`app/core/auth.py`) gained a
keyword-only `epoch: int` parameter baked into the JWT as an `epoch` claim
(required, validated as a non-bool `int` — `bool` is an `int` subclass, so
an unguarded `isinstance` check would silently accept `True` as epoch `1`),
and `VerifiedToken` grew a third field, `epoch: int | None`.
`get_current_user` (`app/api/deps.py`) checks epoch **first**, by equality
(not ordering) against the current `users.token_epoch`: any mismatch is 401,
regardless of timestamps. This is exact where the old wall-clock comparison
was not: the replacement token a password change mints (in the very same
instant as the old token's `iat`, in the pathological same-second case) is
freshly issued *after* `set_password` has already bumped `token_epoch`, so
it always carries the new epoch and is correctly accepted, while every
other outstanding token — including one from that same wall-clock second —
still carries the old epoch and is rejected. `epoch is None` is the fallback
path for a verifier with no epoch concept at all — `SupabaseTokenVerifier`
always returns `epoch=None` (below): only then does `get_current_user` fall
back to the `password_changed_at` comparison described above, same-second
residual and all. A pre-M3 database's `users` rows are backfilled to
`token_epoch = 0` by
the same idempotent `migrate_columns` pattern every other store uses — see
[Ownership](#ownership) below for the deploy-time consequence (every
existing session signs out once, since a pre-M3 token carries no `epoch`
claim at all and the JWT's own `required` claims list now rejects it
outright).

### `app/api/auth.py` — login, me, password change, and (supabase mode) refresh/logout/reset

Three routes serve **both** auth modes behind one URL, dispatching on
`settings.auth.mode` inside the handler: `POST /api/auth/login`, `POST
/api/auth/password`, and (Task 5) `POST /api/admin/users`. Each has a
`_local` implementation and a `_supabase` implementation; the local branch
runs `store.verify_credentials`/bcrypt, so it is dispatched through
`run_in_threadpool` to keep bcrypt (~173 ms in production) off the event
loop — the supabase branch is `async def` end to end and never touches
bcrypt, so it runs inline. Every other route in this file —
`/api/auth/refresh`, `/api/auth/logout`, `/api/auth/reset-request`,
`/api/auth/reset-confirm` — exists **only** in supabase mode: there is no
Supabase session to refresh, revoke, or reset a password against in local
mode, so `_require_supabase_mode` 404s them there. `/api/auth/me` is the one
route that needs no dispatch at all — it just re-reads the local user row,
identically in both modes. Login failures are uniformly `401 "Invalid email
or password"` in both modes: unknown email, wrong password, deactivated
account, and (supabase mode) a verified Supabase session that
`resolve_supabase_user` cannot map to a local row are all indistinguishable
to the caller.

`LoginThrottle` is exponential backoff keyed on `(email, client IP)` —
`client_ip` is `request.client.host`; `X-Forwarded-For`/`Forwarded` are
deliberately ignored, since trusting them unverified would let an attacker
mint a fresh spoofed IP per request and bypass the throttle entirely. **One**
`LoginThrottle` instance (`app.state.login_throttle`) guards `/auth/login`
in both modes — a failed Supabase sign-in records a throttle failure exactly
like a failed local `verify_credentials` call, so a Supabase-mode deployment
is not relying on Supabase's own rate limiting to protect this endpoint. A
**second, separate** instance (`app.state.reset_throttle`) guards only
`/auth/reset-request`, with a smaller `threshold` (3) and a longer
`base_delay`/`max_delay` (60s / 900s): sharing one table between the two
routes would let five free reset-request POSTs block a legitimate login for
the same `(email, ip)`, and would break the throttle's own
bcrypt-cost argument for why its exempt-entry set stays bounded (reset
requests pay no bcrypt at all — `record_failure` runs unconditionally on
every non-blocked attempt). Both instances are in-process state, correct
for this single-process deployment, and thread-safe because FastAPI runs
sync (`def`) handlers in a threadpool — one `threading.Lock` guards every
read/write of the attempts table. Its size cap (`max_entries=4096`) is a
**soft** ceiling: an entry whose block is currently active is exempt from
eviction via an explicit check in `_evict_to_cap_locked`, so the table can
briefly exceed the cap. It is also, in effect, exempt from the TTL sweep,
but not via any explicit check — `_prune_locked` never inspects
`blocked_until`. That exemption instead falls out of the invariant
`max_delay <= entry_ttl` enforced in `__post_init__`: while an entry stays
blocked, its `last_seen` can never age past `entry_ttl`, so the sweep never
reaches it. That exemption closes a bypass rather than opening one — without it, an
attacker who already triggered a block on a victim key could spray
disposable throwaway emails from the same IP to evict the victim's entry and
reset its accumulated backoff. What actually bounds the exempt set's growth
is bcrypt cost, not the cap for `login_throttle` — reaching a blocked state
costs `threshold` (5) failed logins per entry, each paying full bcrypt time
— and `entry_ttl` for `reset_throttle`, which pays no such cost. See the
class docstring for the complete argument.

`POST /api/auth/refresh` deliberately carries **no** throttle: a refresh
token is 256-bit random (not guessable the way a password is), GoTrue
applies its own server-side rate limiting, and an IP-keyed throttle here
would let one NAT (many callers behind one address) starve every legitimate
refresh behind it — a denial of service the login throttle doesn't risk,
since it's keyed on `(email, ip)` rather than `ip` alone.

### `app/core/supabase_auth.py` — the Supabase verifier

`resolve_supabase_credentials` is the fail-closed startup gate for supabase
mode: it requires `auth.supabase.url` in config plus both
`FW_SUPABASE_PUBLISHABLE_KEY` and `FW_SUPABASE_SECRET_KEY` in the
environment, and its error messages name the missing variable, never a
value — a config-error log line must never become a credential at rest.

`SupabaseTokenVerifier.verify()` fetches the project's JWKS **lazily**, on
first use (`jwt.PyJWKClient`, document cache lifespan 600 seconds —
Supabase's own edge-cache guidance), rather than prefetching it at startup:
a misconfigured URL or a transient Supabase outage then surfaces as a 401 on
the first login attempt, in the server log, instead of wedging every
container restart. Requests fail closed until the key set is reachable.
`cache_keys=False` is passed deliberately: PyJWT's per-kid key cache has no
TTL of its own, so leaving it enabled would let a key revoked in the
dashboard keep verifying in this process until restart. With it disabled,
a revoked key stops verifying within the 600-second document-cache window
above — no cache in this verifier outlives that lifespan. Verification pins
`algorithms=["ES256", "RS256"]` — asymmetric only, never `HS256` — checks
`iss`/`aud` against the project's `/auth/v1` issuer and the fixed audience
`"authenticated"`, and requires `sub`/`exp`/`iat`/`iss`/`aud` to be present.
Two claims checks exist specifically because the dashboard toggles in
[the setup guide](supabase-auth-setup.md) are not the actual control: a
token with `is_anonymous: true`, or any `role` other than `"authenticated"`,
is rejected regardless of what "allow anonymous sign-ins" is set to in the
Supabase dashboard — a drive-by anonymous session must never be able to
reach `resolve_supabase_user` and provision a local row. `iat` gets the same
hand-rolled leeway check as `LocalTokenVerifier` (`IAT_LEEWAY_SECONDS`,
shared between both verifiers).

**The `amr` guard (B30, #100) closes the between-restarts window the
first-provider checks above cannot see.** `app_metadata.provider` (checked
above) and `create_app`'s startup provider-policy gate
([Startup bootstrap](#startup-bootstrap), below) both pin the identity's
**first** provider — the provider that originally created the account —
which is a config-level guarantee, correct as of the last restart. Neither
one inspects the **session's own** authentication method, so an identity
that started out email/password but is later reachable through a
since-enabled OAuth/SSO/magiclink provider would mint a session those two
checks cannot distinguish from an ordinary email/password login, for as
long as the process keeps running. `verify()` adds a third, per-request
check on top: GoTrue's `amr` claim (`[{"method": "password"|"otp", ...}, ...]`,
minted fresh for every session this app's own flows produce — the
password grant and the recovery/invite `verify_otp` call — and carried
through unchanged by a refresh) must be present and every method in it must
be one of `{"password", "otp"}`; anything else (oauth, sso/saml, magiclink,
or a token with no `amr` at all — a session no flow of this app could have
minted) is rejected, `InvalidToken("session method is not an email flow")`,
regardless of `app_metadata.provider`. This is the check that actually
covers the gap between one restart and the next; the first-provider checks
remain in place as the reason a brand-new OAuth-origin identity can never
reach `resolve_supabase_user` in the first place.
`VerifiedToken.methods` (a `frozenset[str]`, new in B30) carries the
verified session's own `amr` methods forward past `verify()` — it is what
lets `reset_confirm`'s retry leg (below) additionally require
`methods == frozenset({"otp"})`, on top of this guard, before accepting a
token as a rotation credential.

`resolve_supabase_user(store, *, subject, email)` maps a verified Supabase
subject UUID to the local `users` row, in a fixed order that matters:
**external_id first** (the common case — an already-linked account),
**then adopt-by-email** (a pre-Supabase local account signing in through
Supabase for the first time links by matching email), **then JIT-create**
(an invited user's first successful login creates the local row on the
spot). An email already owned by a row linked to a *different* subject
fails closed (`InvalidToken`) rather than silently re-linking — one local
account never serves two Supabase identities. `SupabaseTokenVerifier.verify`
always returns `VerifiedToken(..., epoch=None)` — it has no epoch concept at
all, which is what routes `get_current_user` (`app/api/deps.py`, above) to
its `password_changed_at` fallback instead of the epoch-equality check
local tokens use.

### `app/services/supabase_gateway.py` — the Supabase gateway

`SupabaseAuthGateway` wraps the `supabase_auth` (GoTrue) client library and
is the only code in this backend that talks to Supabase over the network.
Every method builds its **own** short-lived `httpx.AsyncClient` and GoTrue
client around it, rather than holding one pooled client on `app.state`: auth
operations are rare enough that the per-call handshake cost is irrelevant
next to bcrypt, and `seed_admin` drives the gateway from its own
`asyncio.run()` event loop at startup (before uvicorn's loop exists), so no
connection pool may outlive a single operation or get reused across loops.
Two client kinds, built by two private context managers:

- `_user_client()` — authenticates with the **publishable** key, for
  operations a signed-in (or signing-in) user performs themselves:
  `sign_in`, `refresh`, `send_reset_email`, `verify_token_hash`.
  `verify_token_hash` is deliberately **only** the `verify_otp` half of
  confirmation — it burns the one-time link and returns the verified
  session, nothing more. B29 (#97) split what used to be a single
  confirm-and-update call in two: the password update is the caller's own,
  separately retryable step (`app/api/auth.py#reset_confirm`, below), so a
  failure updating the password never stands a chance of stranding an
  already-confirmed identity behind a link that is by then already spent.
- `_admin_client()` — authenticates with the **secret** key, for operations
  only an admin session or the backend itself may perform: `sign_out`,
  `global_sign_out`, `change_password`, `create_user`, `invite_user`,
  `get_user_id_by_email`.

`sign_out` and `global_sign_out` are the same GoTrue call
(`admin.sign_out(access_token, scope)`) with a different `scope` string —
`"local"` revokes only the session tied to that one access token (ordinary
logout); `"global"` revokes every session for that user, which is what a
password change (`_change_password_supabase`, `reset_confirm`) calls after
updating the credential, as the second eviction layer alongside the local
`password_changed_at` backdate (see the table below). Every GoTrue error is
mapped to exactly two backend-facing exception types, in an order that
matters (`AuthRetryableError` is itself an `AuthError`, so it must be caught
first): `SupabaseAuthError` (bad credentials, expired/invalid link — a
`401`/`422` to the caller) and `SupabaseUnavailableError` (network failure,
5xx, timeout, or a retryable GoTrue error — a `503`).

### Two-leg reset-confirm (`app/api/auth.py#reset_confirm`, B29 #97 + B30 #100)

`POST /api/auth/reset-confirm` serves both password-reset and invite
acceptance (`ResetConfirm`'s `type: "recovery" | "invite"`), and accepts
**exactly one** of two request shapes — enforced by a pydantic
`model_validator`, not left to the handler to sort out:

- **The link leg** — `token_hash` + `type`, straight from the emailed URL
  fragment. `gateway.verify_token_hash` burns the one-time link (GoTrue's
  `verify_otp`) and returns the verified session; the route then routes
  that session's access token through `token_verifier.verify()` (the same
  claim guards login/refresh apply — never resolved directly), for the
  invite case this is the actual JIT-materialization point for the local
  row.
- **The retry leg** — `retry_token` alone, no `token_hash`/`type`. Reached
  only after the link leg (or an earlier retry) already burned its link and
  handed back a `retry_token` in a failure envelope (below). The route
  verifies the retry token through `token_verifier.verify()` too, but with
  one **additional** guard beyond the ordinary `amr` check: it requires
  `verified.methods == frozenset({"otp"})` exactly — a password-grant
  session (even a perfectly valid, current one) is rejected here, because
  accepting it would let a stolen ordinary bearer token rotate a password
  with no current-password proof at all, the exact check
  `_change_password_supabase` performs by re-`sign_in`-ing. Only a session
  this app's own confirm flow minted may drive this leg.

Once identity is settled (either leg), the actual password write goes
through one shared helper, `_update_password_or_retry_envelope`, and **any**
failure there — weak/breached password, or a transient GoTrue/network
error — hands back a **retry envelope** instead of a bare error, because by
this point the one-time link is already spent and retrying is the only
useful direction left:

| Failure | Status | Envelope |
|---|---|---|
| `SupabaseWeakPasswordError` | 422 | `{"code": "password_weak", "reasons": [...], "retry_token": <token>}` |
| `SupabaseAuthError` / `SupabaseUnavailableError` | 503 | `{"code": "update_failed", "retry_token": <token>}` |

The `retry_token` in both envelopes is the **access token of the session
that just proved identity** — the link leg's freshly `verify_otp`-minted
session, or (on a second failed retry) the same retry token handed back
again. The frontend's `ResetPasswordForm` (`docs/frontend-architecture.md`)
stores it and resubmits through the retry leg rather than re-showing the
original link, which the server no longer accepts a second time.

**The retry-token lifecycle, stated honestly — this is the B14 residual,
not new exposure.** A retry token is a live otp-session bearer from the
moment it is minted until its own **natural TTL** (the Supabase
access-token lifetime, §9 of the setup guide, default 1 hour) — nothing
about the retry flow shortens that. `_finish_confirmed_rotation` runs after
every **successful** rotation and backdates `password_changed_at` by
`IAT_LEEWAY_SECONDS` (60s), same as every other password change in this
app, but a retry token minted inside that 60-second leeway window is, by
construction, *inside* the window the backdate is built to spare — see
[Revocation and eviction](#revocation-and-eviction-across-auth-modes)
below for why that's deliberate, not a gap. So: replaying a **successful**
retry token rotates the password again, and keeps succeeding, for as long
as the token itself remains valid — the stateless JWT verifier has no way
to revoke one specific token early, only to reject everything issued before
a given instant. That is bounded exposure, not unbounded: reachable only by
whoever already holds a session this app's own confirm flow minted (never
by a stolen ordinary password-grant bearer — the `methods ==
{"otp"}` guard above is exactly what rules that out), and dead the moment
its natural TTL passes. What rotation **does** kill outright, on every
successful confirm, is the session's **refresh** token, via
`global_sign_out` — so even a replayed retry token can never be *extended*
past its original TTL by minting a fresh one from a refresh call. Put
together, the route's guarantees are: **the route itself never returns a
session** to the caller (no auto-login — see the frontend doc for why),
and **only an otp-minted session** — never an ordinary bearer, stolen or
otherwise — can ever drive the retry leg at all.

### Admin invites (`app/api/admin.py`, supabase mode)

`POST /api/admin/users` with no `password` field only makes sense in
supabase mode — local mode has no way to authenticate an account with no
credential, so it 422s (`password_required`) there instead. In supabase
mode, an admin creating a user with no password calls
`gateway.invite_user(email)` (GoTrue's `invite_user_by_email`), links the
returned Supabase subject UUID to a new local row via `external_id`, and
returns `AdminUserCreated(..., invited=True)` — `invited` is an event of
that one API call, never durable user state, so it is a response-only field
that never appears on `User` itself or leaks into `GET /api/admin/users`.
The invited user's local row exists from that moment (with no password of
its own — Supabase owns the credential), but the account only becomes
usable once the invite email's link is followed: `POST
/api/auth/reset-confirm` with `type: "invite"` is the invite-acceptance
step, and it is the point where `resolve_supabase_user`'s JIT path would
also apply, though in the invite case the local row already exists from the
`invite_user` call above, so it resolves by `external_id` on the first hit
instead of creating a fresh row.

**Resending an invitation** (`POST /api/admin/users/{id}/resend-invite`, B28
#96) re-issues one already-linked (`external_id is not None`) user's invite
through the very same `gateway.invite_user` call the create route uses —
there is no local "pending" tracking at all; **GoTrue is the sole authority**
on whether an identity is still pending. Calling `invite_user_by_email`
again on a pending identity re-sends the mail and invalidates whatever link
was previously outstanding (a Supabase behavior, not something this backend
implements); calling it on an identity that has already accepted its
invite is the **one** GoTrue rejection this route maps to
`422 already_active` — `SupabaseEmailExistsError`, the sole error code that
honestly means "this account is no longer pending." Every other
`SupabaseAuthError` (a rate limit, a malformed address, a misconfigured
project) maps to a generic `503`, deliberately never to `already_active`:
conflating a real GoTrue rejection with "already accepted" would tell the
admin something false about the invitee's own state, not about the
request. The route is admin-gated (`require_admin` on the router) and
mode-guarded the same way every other supabase-only auth route is
(`404` outside `auth.mode: supabase`); it costs an `EmailLocks` slot (below)
just like the create route, to keep a resend from interleaving with a
concurrent create/reconcile on the same email.

### Admin password reset (`app/api/admin.py`, supabase mode)

`PATCH /api/admin/users/{id}` with a `password` field mode-dispatches the
same way `create_user` already did: in local mode it stays the
threadpooled `set_password` bcrypt write it always was; in supabase mode it
calls `gateway.change_password(existing.external_id, body.password)` (the
same admin API call `_change_password_supabase` uses) followed by
`store.mark_password_changed(user_id)` — **never** `store.set_password`,
same invariant as `create_user`'s supabase branch: Supabase owns the
credential, so no local hash is ever written for a supabase-mode row.
`SupabaseAuthError`/`SupabaseUnavailableError` map to `422`/`503`, matching
`create_user`'s error mapping. Unlike the self-service change-password
route, there is no separate `global_sign_out` call here: an admin
resetting someone else's password has no bearer token for that target to
hand `/logout`, and none is needed — `change_password` already revokes
every outstanding session/refresh token for that user server-side as part
of the same admin API call (see the eviction table below).

### `app/core/email_locks.py` — serializing admin user-creation flows (B31, #101)

Both admin routes that touch a Supabase identity by email (`create_user`'s
invite/create-with-password branches, `resend_invite`) run a
**pre-check → remote call (create/invite/reconcile, plus a possible
credential rotation) → local link** sequence. Two concurrent admin requests
for the **same email** can interleave those steps — the sharpest case: one
request's `201` response reports a password the other request's rotation
has already overwritten remotely — so each route wraps the contended part
in `EmailLocks.acquire(email)`, an async context manager handing out one
`asyncio.Lock` per **normalized** (`.strip().lower()`) email. `create_user`
holds it across the whole pre-check → remote call → local-link sequence;
`resend_invite` wraps only its remote call (`gateway.invite_user`) — the
lookup, guard checks, and audit write sit outside the lock, since none of
them touch shared remote state.

Two bounded-map hygiene rules, and one exception to the second: entries
expire after 900s (`_ENTRY_TTL_SECONDS`) and the table caps at 1024
(`_MAX_ENTRIES`), mirroring `LoginThrottle`'s own TTL/cap shape —
`_prune` skips any `lock.locked()` entry in both the TTL sweep and the
cap eviction, so a lock genuinely held while `_prune` runs survives. That
check is a snapshot, not a guarantee: in the release-to-reacquire window
(`lock.locked()` momentarily False while a queued waiter has not yet
resumed), a cap-pressure prune (>1024 live entries) can still delete the
entry out from under that waiter, and a third request then mints a fresh
`Lock` for the same email, running unserialized with the waiter. This
residual is reachable only above the cap; the practical bound is the
number of requests actually in flight for that one email, which is small.

**Two stacked scope assumptions, not one.** Like `LoginThrottle`, this is
in-process state — a **single-process** deployment assumption, out of scope
to change (spec §4). On top of that, `asyncio.Lock` itself binds to the
event loop that first contends it and raises `RuntimeError` if a later
contender comes from a **different** loop — a **single-event-loop**
assumption `LoginThrottle`'s plain `threading.Lock` never had to make.
Production uvicorn runs exactly one loop, so this holds in deployment by
construction; it is the reason any test exercising real contention between
two requests must drive both from inside **one** loop (`httpx.AsyncClient`
+ `ASGITransport`, or a shared `TestClient` portal) rather than, say, two
separate `asyncio.run()` calls, which would each get their own loop and
trip the `RuntimeError` the moment the second one touches a lock the first
already holds.

### Revocation and eviction across auth modes

Both modes end up needing to invalidate outstanding tokens without a
blocklist, but the mechanism differs because a local mode token carries a
server-issued `epoch` claim and a Supabase token does not:

| Trigger | Local mode | Supabase mode |
|---|---|---|
| Deactivation / de-admin | `get_current_user` re-reads the user row every request; takes effect immediately, no token action needed | same |
| Password change (self-service or admin reset) | `set_password` bumps `users.token_epoch`; every outstanding token carries the old epoch and fails `get_current_user`'s equality check | `mark_password_changed` backdates `users.password_changed_at` by `IAT_LEEWAY_SECONDS` (below) **and** `token_epoch += 1`; `get_current_user` falls back to the `password_changed_at` comparison since `epoch=None`; the gateway's `change_password` (self-service and admin reset both call it) revokes the target's refresh tokens/sessions at Supabase's layer as part of the same admin API call — access tokens are not affected (see below) |
| Comparison used | Exact equality (`epoch == token_epoch`) — no clock coupling | `issued_at < password_changed_at` — clock-coupled, second granularity |

The `IAT_LEEWAY_SECONDS` backdate on `mark_password_changed` is not
cosmetic: `password_changed_at` is compared against `iat` values from
**Supabase's** clock, not this server's, so without the allowance a
trailing Supabase clock would reject the fresh session minted moments after
the change — specifically the frontend's own silent re-login
(`docs/frontend-architecture.md`'s reset/invite flow). `global_sign_out`
does **not** close the residual gap this backdate leaves open: GoTrue's
`/logout?scope=global` revokes sessions and refresh tokens, but access
tokens are stateless JWTs this backend verifies locally against JWKS —
Supabase is never consulted per request, so it cannot revoke one already
issued. The honest residual is narrower than "revoked, immediately" but
real: a token issued in the final `IAT_LEEWAY_SECONDS` window before the
change stays valid at this backend's own layer for the rest of its natural
lifetime, bounded by the Supabase access-token TTL (§9 of the setup guide,
default 1 hour) — with no way to mint a replacement, since its refresh
token is already dead.

### Startup bootstrap

`app/services/seed_admin.py#seed_admin` creates the first admin from
`FW_ADMIN_EMAIL`/`FW_ADMIN_PASSWORD` **only while `users` is empty**
(`store.count() > 0` short-circuits). There is deliberately no API endpoint
for this — an unauthenticated bootstrap endpoint either stays open forever
or depends on someone remembering to close it — so once any user exists, the
two env vars are inert: they can never serve as a standing password reset.
In supabase mode, `seed_admin` is passed a `SupabaseAuthGateway` and creates
the admin **in Supabase** (`gateway.create_user`, falling back to
`get_user_by_email` if the email is already registered — a re-run against
an existing project links instead of failing, but only if that identity's
`app_metadata.provider` is `"email"`; an OAuth-origin identity at the
bootstrap email fails closed instead of minting an admin row that could
never authenticate) before writing the local row with that `external_id`;
in local mode it writes the password hash locally, unchanged from before
this milestone.

`create_app()` (`app/main.py`) wires all of this by dispatching once on
`settings.auth.mode`: for `"supabase"`, it calls
`resolve_supabase_credentials` (fail-closed on missing config/env, above),
builds the `SupabaseAuthGateway` and `SupabaseTokenVerifier`; for `"local"`
(the default), it resolves the signing secret (`resolve_auth_secret`,
fail-closed as before) and builds the `LocalTokenVerifier`. Both branches
build a `UserStore` and, in either case, only then does `seed_admin` run —
migrations before bootstrap, in both modes. Between building the gateway
and the `UserStore`, the supabase branch also calls
`_enforce_email_only_providers`, which reads GoTrue's own provider
configuration and fails startup closed if anything other than `"email"` is
enabled there (logging a warning and continuing instead on a transient
`SupabaseUnavailableError`, so a Supabase outage cannot brick every
restart). **`auth.mode: supabase` no longer raises `AuthConfigError` by
itself** — it only does so when the supabase config or secrets are actually
missing (`resolve_supabase_credentials`), the same fail-closed shape local
mode has always had for a missing `FW_AUTH_SECRET`. Startup fails closed on
any of: a missing/short `FW_AUTH_SECRET` in local mode (unless
`ephemeral_secret` is on), a missing `auth.supabase.url`/
`FW_SUPABASE_PUBLISHABLE_KEY`/`FW_SUPABASE_SECRET_KEY` in supabase mode, an
OAuth/SSO or phone provider enabled in the Supabase project, a
missing/short bootstrap email/password while `users` is empty, or
(supabase mode only) a bootstrap call to Supabase itself failing.

One deviation from the eager-singleton pattern the rest of `main.py` uses:
the module-level `app` that `uvicorn app.main:app` needs used to be built
eagerly (`app = create_app()` at import time), but that ran `create_app()` —
and its fail-closed auth/admin bootstrap — as a side effect of merely
*importing* `app.main`, including via `from app.main import create_app` in
test files, which fired during pytest collection before test fixtures had
set a test secret and bootstrap credentials. `app.main` now defines a PEP
562 module-level `__getattr__` that builds and caches the app lazily, on
first access to the `app` attribute — `uvicorn app.main:app` is unaffected
(uvicorn accesses that attribute to obtain the ASGI app); only a bare
`import app.main` no longer has the side effect.

### `app/manage.py` — operator CLI

`python -m app.manage <command>` handles password and access recovery
without a working web session: `list-users`, `set-password`, `make-admin`,
`revoke-admin`, `deactivate`, `activate`. It requires shell access to the
host, which already implies control of the database, so it adds no new
attack surface. Passwords are **never** accepted as `argv` arguments —
always prompted (`getpass`) or read from stdin — since an argv value is
visible in shell history and to every other process via `ps`. A custom
`_SilentArgumentParser` overrides argparse's `error()` so a mistyped
subcommand or a stray extra token never echoes the offending value back
(argparse's default messages interpolate the bad token directly, which could
put a mistyped password on stderr). Every mutation is audited with
`actor_id=None`, marking it as taken out-of-band rather than through the web
API. `revoke-admin`/`deactivate` warn — but don't refuse — if the action
would leave no active admin: freezing all admin access during an incident
and minting a fresh one afterward is exactly what this tool is for.

## Ownership

Milestone 3 scopes every per-user resource to the caller who created it. Two shapes
cover everything:

- **Owner-scoped, no global rows** (`documents`, `folders`, and the in-memory
  `jobs` registry — see [The check flow](#the-check-flow) above for jobs):
  `owner_id` is `NOT NULL`; every store method takes `owner_id` and every query filters
  by it (`WHERE owner_id = ?`, or for `JobManager`, an equality check after an in-memory
  lookup). A foreign id — another owner's document, folder, or job — is indistinguishable
  from a nonexistent one: **404, never 403**. This matters for the same reason it always
  does in multi-tenant systems: a 403 on a foreign id would confirm the id *exists*,
  leaking that some other account owns something at that address; a uniform 404 reveals
  nothing about ids you can't see.
- **Owner-scoped with global rows** (`profiles`, `domains`): `owner_id` is nullable.
  `NULL` means **global** — seeded built-ins (the Standard profile per language, the
  example Marketing/Technical Documentation/Blog profiles, the "Product docs" example
  terminology domain) and nothing else: both create endpoints always write
  `owner_id=user.id`, even for an admin caller, so a startup seeder is the only path to
  a global row. A global row
  is visible to every caller (`WHERE owner_id IS NULL OR owner_id = ?`) but mutable only
  by an admin: any store's `update_*`/`delete_*` (and, for domains, `create_term` on a
  global domain) raises `GlobalReadOnlyError` (`app/services/ownership.py`) when a
  non-admin caller reaches a row with `owner_id IS NULL`. Every API router maps that one
  exception to **403** ("Only admins can change built-in items") — the single shared
  error shape for "you may see this, but not touch it," independent of *which* store or
  endpoint raised it. `Profile.is_global`/`Domain.is_global` are `computed_field`
  properties (`owner_id is None`) — the frontend never sees the raw `owner_id`, only the
  derived boolean it actually needs (see `docs/frontend-architecture.md`'s `is_global`
  affordances).

  The Standard profile additionally carries a **second**, narrower rule on top of the
  general global-row guard: it can never be renamed, deleted, or (for anything but
  itself) reset, regardless of caller. Because that Standard-specific 409 and the
  general non-admin 403 can both apply to the same request, the router checks the 403
  first (see [Checking profiles](#checking-profiles) above) — an authorization refusal
  must never be shaped by a business rule the caller was never going to reach anyway.

**Two guarded table rebuilds** were needed because SQLite cannot drop an inline
`UNIQUE`/`DEFAULT` constraint without recreating the table: `profiles` (dropping the
legacy `UNIQUE(language, name)`, wrong once names are meaningful per-owner) and
`folders` (dropping both the legacy `UNIQUE(name)` and `owner_id`'s `DEFAULT 1`). Both
follow the same shape — detect the stale DDL via `sqlite_master`, create a
`<table>_new` from the current `_SCHEMA`, copy every row across by an explicit column
list, drop the old table, rename the new one in — but the replacement index differs by
table, because only `profiles` (and `domains`, below) has global rows. `profiles`
replaces its dropped constraint with **two partial unique indexes** (one `WHERE
owner_id IS NOT NULL`, scoped per-owner; one `WHERE owner_id IS NULL`, scoped
globally) rather than one composite index, because SQLite treats every `NULL` as
distinct from every other `NULL` — a single index spanning both partitions would never
actually enforce global-name uniqueness. `folders`' `owner_id` is `NOT NULL` (folders
have no global concept), so it replaces its dropped constraint with a single composite
index instead, `idx_folders_owner_name` on `(owner_id, name COLLATE NOCASE)`. `domains`
needed no table rebuild (it never had a `UNIQUE` constraint to drop) but gained the same
two-partial-index pair as `profiles`. All three tables' index creation is preceded by a
duplicate pre-scan of its own scope; a scope with a pre-existing case-insensitive
collision has its index **skipped**, with a warning logged, rather than crashing
startup — a live legacy database is not guaranteed to be collision-free, and refusing to
start is a worse failure mode than temporarily running without that one uniqueness
guarantee. [Terminology](#terminology) above documents why `domains` — never
uniqueness-constrained pre-M3 — is the table most likely to actually need a skip on real
data, even though this repo's own live-DB rehearsal needed none.

**One-shot ownership backfills**, each run exactly once (guarded by the same
`"owner_id" not in columns` check that adds the column) when a pre-M3 database is first
opened: `documents.owner_id` already existed pre-M3 (see [Documents](#documents)) and
needed no backfill logic — every existing row was already `1`. For `folders`, the
existing `DEFAULT 1` already meant every row's `owner_id` was already `1`, so nothing
extra ran either — only the DDL rebuild above. For `profiles`, every `is_standard=1` row
and every seed-example-named row (matched against `SEED_EXAMPLE_NAMES` and a
`profile_seed_markers` entry for its language, since there is no per-row seed marker)
keeps `owner_id NULL`; every other row becomes `owner_id = 1`. For `domains`, the single
row matching the seed domain's name keeps `owner_id NULL`; every other row becomes
`owner_id = 1`. In every case, "every other row" means **the pre-existing single-owner
data becomes user id 1's** — not, as an earlier draft of this doc claimed, because
`create_app()`'s wiring guarantees an already-bootstrapped admin by backfill time: the
store constructors that run these backfills (`app/main.py:110-128`) execute *before*
`seed_admin()`, not after. The decision instead relies on the historical id-1
convention — a pre-M3, single-user database's sole real user was always id 1 — and
`seed_admin()` separately assigning the admin role to id 1 is what makes "becomes id
1's" read as "becomes the admin's" in practice.

**Seeders write global rows, not admin rows.** `seed_terminology`/`seed_profiles`
(`app/services/seed.py`, `app/services/seed_profiles.py`) call `create_domain`/
`create_profile` with `owner_id=None` — a fresh installation's example content is global
from the start, visible to every account that ever signs up, not owned by whichever
account happens to trigger the first `create_app()` run. `seed_terminology`'s
`has_global_domains()` check (rather than "any domain exists") is what makes this
correct on a legacy migration too: a database with only a user's own private domains
(no global one yet, because the old schema had no concept of global) legitimately gets
the global example domain seeded on top, rather than the presence of *any* domain
suppressing it forever (spec §5.2's global-only presence check — this is a deliberate
reversal from pre-M3 behavior, not an oversight, and is exactly the shape of "legitimate
bootstrap addition" a migration rehearsal must classify rather than treat as row-count
drift).

**Deploy-time consequence**: pre-M3 tokens carry no `epoch` claim (see
[`app/core/auth.py`](#appcoreauthpy--secrets-passwords-tokens) above), and
`LocalTokenVerifier.verify`'s `required` claims list now includes `epoch` — so every
session outstanding at the moment of an upgrade is signed out exactly once. Users simply
log in again; the 24-hour token TTL means this is a one-time event per session, not a
recurring one.

## Tiers and LLM policy

Milestone 4 adds a **user-tier** access model on top of the four **quality
tiers** (`quality|balanced|cheap|local`, `TIERS` in `app/core/config.py`)
that already governed check routing. The two are different vocabularies:
a quality tier is *what a check can run with*; a user tier (config key
under `tiers:`, e.g. `basic`/`premium`) is *what an account is allowed to
select* — a per-deployment policy name, not a fixed enum. With no `tiers:`
block configured, M4 is inert by design: every caller gets the unrestricted
policy and behavior is byte-identical to pre-M4.

### `tiers:` config

`Settings.tiers: dict[str, TierSettings]` (`app/core/config.py`) maps a user
tier name to its policy. Every model on this path sets `extra="forbid"`
(`TierSettings`, `TierLLMSettings`, `TierLimitsSettings`, and `Settings`
itself) — a misspelled key is a config-load error, not a silently-ignored
extra, because access policy must not fail open on a typo:

- **`llm`** (`TierLLMSettings`): `tiers`, `providers`, and `models` each
  default to the literal string `"all"` (unrestricted for that dimension);
  when overridden, `tiers` is checked against the fixed quality-tier ladder
  and `providers`/`models` are checked against `known_provider_names()`
  (the five built-ins plus configured `extra_providers`) by a
  `Settings`-level `model_validator`, since only `Settings` knows the
  configured extras.
- **`limits`** (`TierLimitsSettings`, **required** on every configured tier
  as of M5): `max_llm_document_chars`, `concurrent_llm_runs`, each a
  required positive field, plus the four optional per-tier credit-window
  budgets `credits_per_hour`/`credits_per_day`/`credits_per_week`/
  `credits_per_month` (B6: `llm_checks_per_day` was replaced by these — at
  least one is required — see
  [LLM usage metering](#llm-usage-metering) below). `TierSettings.limits`
  carries no default, so a `tiers:` entry with a missing or incomplete
  `limits:` block fails `Settings` validation and aborts startup: a
  `limits:` block still carrying `llm_checks_per_day` trips
  `TierLimitsSettings`'s `extra="forbid"`, and a `limits:` block configuring
  none of the four `credits_per_*` windows trips `_at_least_one_window` —
  a partially-specified or missing block can no longer be allowed to fail
  open now that M5's `reserve_llm_run` (below) enforces these numbers for
  real.
- **`features`** (`list[str]`, default `[]`): must be a subset of
  `KNOWN_FEATURES` (`app/core/config.py`, currently `("custom_profiles",
  "custom_domains")`) — a closed set, so a typo cannot silently withhold or
  silently grant a capability.

### `app/core/permissions.py` — policy vocabulary and resolution

Pure module, no I/O: `LLMPolicy` (`tiers`, `providers`, `models`, each
`None` meaning unrestricted) is what `policy_for(tier, is_admin, settings)`
builds from a `TierSettings.llm` block; `features_for(tier, is_admin,
settings)` does the same for the feature set. Both share `_tier_config`,
which looks the caller's tier name up in `settings.tiers` and, on a miss,
**warns once per unknown tier name** (not once per request — policy
resolution runs on every check) before falling back to the fail-closed
`NO_LLM_POLICY` (`tiers=(), providers=(), models=None` — the §6.2 floor).
Two bypass cases return `FULL_POLICY` (every dimension `None`): an admin
caller, and a deployment with `settings.tiers` empty (no config at all).

`resolve_llm_selection(policy, requested, language, *, settings) ->
EffectiveSelection` (`RequestedLLM` in, `EffectiveSelection` out — both
frozen dataclasses) is the graceful-degradation ladder (spec §6.2):

1. A tier-mode request (`requested.tier` set) whose tier is in
   `policy.tiers` (or `policy.tiers is None`) resolves as-is.
2. Otherwise it walks the fixed `TIERS` ladder **down** first (cheaper
   quality tiers), then, if none of those are allowed, **up** from the
   original tier — always the *nearest* allowed tier in that search order,
   never an arbitrary allowed one.
3. A direct-mode request (`requested.provider` set, tier `None`) whose
   provider is off-policy falls back to tier routing at the best (highest
   quality) allowed quality tier, if the policy's tier list isn't empty.
4. An empty `policy.tiers` (direct-only policy) resolves through
   `_direct_fallback`: the policy's first allowed provider (config order —
   `providers` keeps the list order specifically so the first entry can
   serve as the degradation substitute) with its first allowlisted or
   default model; both `providers` and `tiers` empty is the floor —
   `EffectiveSelection(provider=None, skipped="llm_unavailable")`.
5. A granted tier with no routing-table entry for the caller's language
   still resolves to `skipped="llm_unavailable"` rather than being silently
   rerouted — a granted-but-unconfigured tier behaves exactly like today's
   pre-M4 missing-routing-entry case.

**Fail-closed unknown-tier rule**: a user row whose `tier` doesn't match
any configured `tiers:` key (a typo, a renamed tier, or simply no `tiers:`
block with a non-empty `tier` column value) gets `NO_LLM_POLICY` — the LLM
phase is skipped with a visible degradation note, never a 500 and never
silently unrestricted.

`EffectiveSelection.degraded` is `True` whenever the caller got something
other than exactly what they asked for; `skipped` (`"llm_unavailable"` from
M4; `"document_too_large"` and `"quota_exhausted"` added by M5 — see [LLM
usage metering](#llm-usage-metering) below) means the LLM phase does not run
at all. Degradation is always visible to the caller (spec §6.2) — see
`effective_llm` below.

### The single gate: `app/api/llm_gate.py`

`get_effective_provider(app, user, requested, language)` is the **only**
place any endpoint may turn a caller's LLM request into a constructed
`LLMProvider`. It 422s only for an unknown *direct* provider name (a
tier-mode request's `provider`/`model` fields are ignored by contract, so
they must never 422); otherwise it resolves the policy via `policy_for` +
`resolve_llm_selection` and constructs the provider through
`app.state.provider_factory`. A `ValueError` from the factory (the routing
table can reference an optional extra provider this server hasn't
configured — that's "not configured," not a server error) downgrades the
selection to `skipped="llm_unavailable"` rather than raising. **No route
touches `app.state.provider_factory` directly** — checks, suggestions, and
document auto-naming all resolve through this one gate, so tier policy
cannot be bypassed by a new call site forgetting to check it. M5 extended
this same gate with the size cap and the quota/concurrency reservation; the
full order is **422 (unknown direct provider) → size cap
(`"document_too_large"`) → `resolve_llm_selection` → provider construction →
reservation** (see [LLM usage metering](#llm-usage-metering) below) — never
reorder, since a run that cannot even be constructed must never consume
quota.

`effective_llm_report(requested, effective)` builds the wire shape
(`EffectiveLlmReport`/`LlmSelectionInfo`, `app/core/models.py`): requested
vs. effective tier/provider/model, `degraded`, `skipped`.

### `effective_llm` on checks

`POST /api/checks`'s response, `GET /api/checks/{id}`, and the SSE stream
all carry `effective_llm: EffectiveLlmReport | None` (`CheckJob.effective_llm`
in `app/services/jobs.py`) — set once the LLM phase's selection is resolved,
and emitted as its own SSE event (`effective_llm`) so a streaming client
learns about degradation without waiting for `done`. `POST
/api/suggestions` reports the same shape inline (`skipped` on the response)
rather than as an event, since it has no stream. Document auto-naming
(`generate_name`, see [Documents](#documents)) hard-selects the `cheap`
quality tier and runs through the same gate, but — matching its existing
silent-fallback contract — never surfaces `effective_llm` to the caller; a
skip there just falls through to the fallback name.

### The `/me` policy payload

`GET /api/auth/me` (`MeResponse.policy: PolicyPayload`, `app/api/auth.py`)
carries `llm: LlmPolicyPayload` (`tiers`/`providers`/`models`, each `null`
meaning unrestricted — the wire encoding of `LLMPolicy`'s `None`) and
`features: list[str]` (a `KNOWN_FEATURES`-ordered subset, so the payload is
deterministic). This is the M4 half of `/api/auth/me`'s cross-milestone
promise (M1: identity; M4: this; M5: `usage`/`limits`, see [LLM usage
metering](#llm-usage-metering) below) — see the roadmap's Cross-milestone
interfaces. The frontend's single gating
source, `auth/policy.ts`, is built entirely on top of this payload (see
`docs/frontend-architecture.md`).

### `allowed` flag semantics (spec §7.2)

Both `GET /api/routing` and `GET /api/providers` annotate their entries
with a per-entry `allowed: boolean`, and the two mean **different things**:

- **`/api/routing`**'s `allowed` (`app/api/routing.py`) is per
  *quality tier*: `policy.tiers is None or tier in policy.tiers` — can this
  caller select this quality tier at all, whether directly or as a check's
  routed choice.
- **`/api/providers`**'s `allowed` (`app/api/providers.py`) is per
  *provider*, and means allowed for **direct selection** specifically:
  `policy.providers is None or entry.name in policy.providers`. A provider
  outside `policy.providers` can still serve a routed quality-tier run
  (§6.2 rule 3) — direct pinning and tier routing are independent axes of
  the same policy, so a provider being off-limits to pin directly does not
  make it unreachable through tier routing, and vice versa.

Both flags are advisory for the UI only — `resolve_llm_selection` is what
actually enforces the policy server-side regardless of what a client sends.

### Feature gates are creation-only

`custom_profiles`/`custom_domains` (checked via `features_for`) gate
**creating** a private profile or domain/term — `POST /api/profiles`
(`app/api/profiles.py`), `POST /api/domains` and `POST
/api/domains/{id}/terms` (`app/api/terminology.py`). They do **not** gate
reading, editing, or deleting anything a caller already owns or any global
row: a tier that loses `custom_profiles` after a user has already created
private profiles does not retroactively lock them out of those profiles —
only new creation is refused (403, the same shape as every other
feature/ownership refusal). This mirrors the frontend's create-affordance
gating (`docs/frontend-architecture.md`): hiding the "+" button, never
disabling existing rows.

### Admin tier-name validation source

`app/api/admin.py#_validate_tier_name` validates a tier name assigned via
`POST`/`PATCH /api/admin/users` against the set `_known_tiers` returns:
`tuple(request.app.state.settings.tiers) or ("basic", "premium")` — the
configured `tiers:` keys when any exist, falling back to the two names spec
§5.1 reserves as defaults only when no `tiers:` block is configured at all
(a state where policy is unrestricted for everyone regardless of the name
assigned, so the fallback names are inert placeholders, not a hardcoded
enum). `GET /api/admin/tiers` exposes the same set to the admin UI as its
select options. An unrecognized name 422s with the actual known set in the
message.

## LLM usage metering

Milestone 5 turns the M4 gate into an enforcement point: every LLM-invoking
run is recorded, and a caller's daily quota and concurrency are checked
before a provider ever runs. With the shipped defaults (below) this is
inert for existing usage — M5's job is to make the ceiling real, not to
lower it.

### The `llm_usage` ledger (`app/services/usage.py`)

One SQLite table, one row per LLM-invoking run (the same three call sites
the M4 gate already served: `checks.py`'s `_run_llm`, suggestions, document
naming):

```sql
CREATE TABLE llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, day TEXT NOT NULL, created_at TEXT NOT NULL,
    status TEXT NOT NULL,               -- started|completed|failed|cancelled|abandoned (CHECK)
    llm_tier, provider, model,           -- effective selection
    requested_tier, requested_provider, requested_model,
    text_chars INTEGER NOT NULL, input_tokens, output_tokens,
    credits INTEGER,                    -- admission estimate while 'started'; settled at 'finish'
    source TEXT NOT NULL, run_id TEXT NOT NULL,
    fail_stage TEXT, fail_detail TEXT    -- failed-path only (CHECK); see below
);
```

Three indexes: `idx_llm_usage_user_day (user_id, day)` backs per-day credit
sums; `idx_llm_usage_inflight` is a **partial** index on `(status, created_at)
WHERE status = 'started'` — without it the server-wide in-flight count would
degrade to a full table scan inside the transaction that serializes every
reservation; `idx_llm_usage_user_created (user_id, created_at)` backs the
per-window credit-window queries that enforce calendar-aligned UTC budgets
(hour→day→week→month, see [Credit windows](#credit-windows) below).

`input_tokens`/`output_tokens` carry the provider's own reported counts
(`TokenUsage`, below) whenever the provider returned them; `NULL` means "not
reported," not zero. The checks path (`_run_llm`) additionally falls back to
the SSE progress approximation for `output_tokens` when the provider
reported none — suggestions and naming have no such fallback since they
never stream progress.

**`credits` (B6)** — integer cost of the run, settled at `finish_run` via
`services/credits.py`. While `status = 'started'` (admission phase), credits
hold the **admission estimate**: `ceil(source_weight × factor ×
(estimated_input + output_weight × estimated_output))` where estimates come
from `text_chars` divided by 4, then output = input / 4. When the run
completes (`status = 'completed'`), credits are **settled** to the actual cost:
`ceil(source_weight × factor × (input_tokens + output_weight × output_tokens))`,
or the estimate stands if no tokens were reported. On `'failed'` status,
credits are settled to actual cost if any tokens were reported; if **both**
`input_tokens` and `output_tokens` are `NULL` (request-stage failures never
reached the provider), credits are settled to **0** (no actual cost). On
`'cancelled'` and `'abandoned'`, the estimate stands unchanged. Pre-B6 rows are
`NULL` and count as 0 in quota calculations. The factor/weight lookup chain
(`services/credits.py#run_cost`) is: exact model in provider block → provider
default factor → global default factor; output weight is similarly per-provider
or global default.

`fail_stage`/`fail_detail` are written only on the `'failed'` path — every
other terminal status (`completed`, `cancelled`, `abandoned`) leaves both
`NULL` (`UsageStore.finish_run` nulls them in code even if a caller passes
values, since only a `'failed'` row's classification is meaningful).
`fail_stage` is one of `request` (never reached the provider: missing API
key, connection/timeout, 401/403), `provider` (an in-flight run raised —
the default for anything unrecognized), or `response` (the provider replied
but the payload was unusable). An exception raised anywhere in the pipeline
is mapped to `(fail_stage, fail_detail)` by `classify_failure`
(`app/api/llm_gate.py`), which recognizes `UnparseableResponseError` and
`json.JSONDecodeError` as `response`-stage; suggestions' "no JSON array" and
naming's "no usable title" are not exceptions at all — a value the caller
recognizes as unusable without the provider raising — so those two set
`fail_stage = "response"` directly instead of going through
`classify_failure`.
`fail_detail` is metadata only — exception class name, HTTP status if
available, and up to 200 whitespace-collapsed characters of the message
(`_fail_detail`) — **never** the document text or the response body; an
`UnparseableResponseError`'s message in particular carries only the
response's character count, not its content. Migrated (pre-M5/pre-B5)
databases gain both columns via `migrate_columns` at startup with no
`CHECK`; `finish_run` re-enforces the `fail_stage` enum in code for exactly
that reason — a typo'd stage on a migrated table would otherwise pass
silently.

### Credit windows (B6)

**Per-tier budgets** (`app/core/config.py`, `TierLimitsSettings`): budgets
live on each tier's `limits` block (and on `limits.admin`), not on
`credit_cost` — they are per-tier, not global. Four calendar-aligned UTC
windows, each with an optional budget: `credits_per_hour`,
`credits_per_day`, `credits_per_week`, `credits_per_month`. At least one is
required per configured tier (`_at_least_one_window`, or that tier is
refused at startup). A `NULL` budget (or omitted key) means "no limit for
that window." The enforcement path (`reserve_llm_run`) checks all of the
caller's configured windows in order and rolls back if any window's
`SUM(COALESCE(credits, 0))` exceeds its budget; overshoot is bounded by the
user's in-flight runs (`≤ concurrent_llm_runs`).

**`credit_cost` config block** (`app/core/config.py`, `CreditCostSettings`)
is pricing only, not budgets — it has no `credits_per_*` fields
(`extra="forbid"` rejects them). **Per-provider and per-model factors**
(`credit_cost.providers`): the `default_factor` and per-model `models:
{model_name: factor}` override the global `default_factor`, and
`output_weight` overrides the global `default_output_weight` (weighting of
output tokens in cost calculations). **`name` source is free by default:**
runs via the naming provider carry `source="name"`, and
`credit_cost.source_weights` defaults `name` to `0.0` (merged over defaults
— an omitted key stays free; set it explicitly to re-enable cost). Weighted
sources (e.g. `check`, `suggestion`) multiply into the factor chain.

### The reservation transaction

`UsageStore.reserve_llm_run(user, limits, server_limits, requested,
effective, text_chars, source, run_id, *, now=None) -> QuotaDecision` runs
on a raw `sqlite3` connection (`_raw_connect()`) with explicit
commit/rollback on every branch — the only `UsageStore` method that does
not go through `_sqlite.connect`'s auto-committing context manager, since
two of its three exit paths need to roll back. `user` is typed as
`MeteredUser`, a two-property `Protocol` (`id`, `is_admin`) satisfied
structurally by `app.api.deps.CurrentUser` without this service importing
from `app.api`; `now` is keyword-only and test-only (defaults to
`datetime.now(UTC)`).

One transaction, in order:

1. **Staleness sweep**: `UPDATE llm_usage SET status = 'abandoned' WHERE
   status = 'started' AND created_at < cutoff` (`cutoff` = `now` minus
   `llm_run_max_age` seconds, measured on `created_at`, never `day`) — the
   counts below are then already clean, so no separate scheduler is needed.
2. **Insert first**: the new row is inserted as `status = 'started'` before
   any count runs. This is what makes the check TOCTOU-safe on a plain
   SQLite file — the INSERT takes the write lock before any `COUNT`, so
   concurrent reservations serialize on it. Never reorder into
   count-then-insert.
3. **Per-window budget check (B6)**: for each configured window (hour, day,
   week, month), `SUM(COALESCE(credits, 0))` where `created_at` falls within
   the window — roll back and return `QuotaDecision(kind="quota_exhausted",
   exhausted_window=window)` if any window exceeds its budget. In-flight
   `started` rows (this run included, inserted just above) DO count toward
   every window sum, at their admission estimate — that is exactly what
   bounds the overshoot below. "Between runs" refers only to there being no
   mid-run cutoff (a run once admitted is never interrupted partway
   through), not to concurrency being exempt from the sum. Overshoot is
   bounded by the user's in-flight runs (`≤ concurrent_llm_runs`). An admin
   hitting their own ceiling logs a WARNING.

4. **Concurrency checks**: per-user in-flight (`status = 'started'`) `>
   limits.concurrent_llm_runs` → roll back, `concurrency_rejected(server_wide=False)`;
   server-wide in-flight `> server_limits.max_concurrent_llm_runs` → roll
   back, `concurrency_rejected(server_wide=True)`. Windows are checked
   before concurrency — an exhausted window must never register as a
   concurrency rejection. Only if all windows and concurrency checks pass
   does the transaction commit, returning `QuotaDecision(kind="admitted",
   reservation_id=cursor.lastrowid)`.

`finish_run(reservation_id, status, *, input_tokens=None,
output_tokens=None, fail_stage=None, fail_detail=None)` is the terminal
write, conditional on the row's status still being `'started'` — a row
either sweep already reclaimed logs a warning and is left alone, never
resurrected. Every gate call site runs this in a `finally` block
(`LlmReservation.finish`, `app/api/llm_gate.py`) so success, failure, and
`asyncio.CancelledError` all reach it with their own terminal status; each
of the three call sites (`checks.py`'s `_run_llm`, suggestions, document
naming) tracks its own `usage: TokenUsage` and `fail_stage`/`fail_detail`
locals through a `try`/`except`/`finally` and settles them here regardless
of which branch was taken.

**Both sweeps** mark `'started'` rows `'abandoned'`: the per-reservation
staleness sweep above (age-based, inside the transaction) and
`sweep_all_started()` at startup (unconditional — in this single-process
deployment, no `'started'` row can belong to a still-live run once the
process that owned it is gone).

### The gate's M5 order (`app/api/llm_gate.py`)

`get_effective_provider(app, user, requested, language, *, text_chars,
source, run_id) -> (EffectiveSelection, LLMProvider | None, LlmReservation |
None)` — a 3-tuple, extended from M4's pair. The order, never to be
reordered:

1. **422** for an unknown *direct* provider name (tier-mode requests ignore
   `provider`/`model` by contract, so those fields never 422).
2. **Size cap** — `text_chars > limits.max_llm_document_chars` skips with
   `"document_too_large"` before any resolution or spend; characters are
   the pre-spend token proxy.
3. **Resolve** — `resolve_llm_selection` (M4); a floor result skips with
   `"llm_unavailable"`.
4. **Construct** — `app.state.provider_factory(...)`; a `ValueError`
   (routing table points at a provider this server hasn't configured) skips
   with `"llm_unavailable"`. Construction happens **before** reservation on
   purpose: a run that cannot even start must never consume quota.
5. **Reserve** — `usage_store.reserve_llm_run(...)`. `quota_exhausted`
   degrades to a skip (never a 429 — an exhausted daily allowance isn't
   retryable until tomorrow); `concurrency_rejected` raises the 429 below.

Three skip codes exist on `EffectiveSelection.skipped`/`effective_llm`:
`llm_unavailable` (M4) and `document_too_large`/`quota_exhausted` (M5, both
from the gate above).

### 429 / backpressure (spec §6.6)

A concurrency rejection raises `HTTPException(429, ..., headers={"Retry-
After": str(decision.retry_after)})` (`retry_after` defaults to
`RETRY_AFTER_SECONDS = 5`) — **never a skip**, since the caller should
retry, not treat this run as done. Three rules:

- **Non-blocking**: the pause before raising is `await
  asyncio.sleep(settings.limits.concurrency_reject_delay)` (config-bounded
  to `[0, 2]` seconds) — it yields the event loop rather than holding the
  connection open synchronously.
- **Post-rollback**: the pause runs after `reserve_llm_run`'s transaction
  has already rolled back and returned — the slot was never actually held
  during the pause.
- **Per-user only**: the pause fires only when `decision.server_wide` is
  `False`. A server-wide rejection answers immediately with no pause —
  holding the connection longer would add to exactly the load pressure that
  cap exists to relieve.

### The byte-budget middleware (`app/api/request_size.py`)

`byte_budget(max_document_chars) = max(5 MiB, 4 × max_document_chars + 1
MiB)` — a UTF-8-worst-case-plus-JSON-overhead byte ceiling derived from the
char cap, so raising `max_document_chars` can never strand a legal payload
behind a stale fixed byte limit. `RequestSizeLimitMiddleware` is pure ASGI
(not `BaseHTTPMiddleware`, whose response buffering would fight the SSE
stream) and enforces the budget two ways:

- **`Content-Length` pre-check**: a declared length over budget is answered
  immediately with a hand-built ASGI 413 (`_send_413`) before any body is
  read.
- **Chunked bodies** (no usable `Content-Length`): the wrapped `receive`
  counts bytes as they actually arrive and, once the running total exceeds
  budget, raises `fastapi.HTTPException(413, "Request body too large")` —
  deliberately an `HTTPException`, not a bespoke exception, because this
  raise happens mid-body-read, deep inside FastAPI's own request-parsing
  call: a bespoke exception there gets caught by FastAPI's generic
  body-parsing `except` clause and turned into its own 400 ("There was an
  error parsing the body"), whereas FastAPI special-cases `HTTPException`
  and re-raises it untouched — the shape that actually reaches Starlette's
  `ExceptionMiddleware` (and, one layer further out, CORS) as a real,
  CORS-visible 413.

**Ordering constraint relative to CORS**: `create_app()` registers
`RequestSizeLimitMiddleware` **before** `CORSMiddleware`. Starlette makes
the *last-added* middleware outermost, so CORS ends up wrapping the size
limiter, not the other way around — deliberately, since CORS must stay
outermost for a 413 raised inside the size limiter to still pass back out
through CORS and carry the right headers, making it readable by the
browser instead of opaque as a CORS-blocked response.

The middleware's byte budget is the outer, transport-level net; three
endpoints additionally enforce `settings.limits.max_document_chars` itself
as a character count and 413 explicitly: `POST /api/checks`
(`app/api/checks.py`), and document create/save via the shared
`_enforce_document_cap` helper (`app/api/documents.py`). An **already
saved** oversized document (from before the cap existed, or before it was
lowered) stays loadable and editable — only a new save that would exceed
the cap is refused.

### `/me`'s usage, limits, and admin-ceiling mirror

`GET /api/auth/me` (`MeResponse`, `app/api/auth.py`) carries, alongside the
M4 policy payload:

- **`usage: UsagePayload` (B6)** — `label` (`label_for`: an admin always gets
  `"Admin"`; otherwise `TierSettings.label` — a field on the tier block
  itself, sibling of `limits`, not inside it — if the tier sets one, else the
  tier name capitalized) and `windows: list[WindowUsage]`,
  each with `window` (hour|day|week|month) and `used_percent` (ceil of
  `used_credits * 100 / budget`, capped at 100, where `used_credits =
  SUM(COALESCE(credits, 0))` over all rows in the window regardless of
  status, and `budget` is the configured limit for that window). No absolute
  credit numbers are reported — only the tightest window's label and used
  percent are shown in the UI. Replaces M5's `used_today`/`limit` pair.
- `limits: LimitsPayload` — `max_document_chars` (the server-wide byte-budget
  source), `max_llm_document_chars`, and `concurrent_llm_runs` (the latter
  two are the caller's own per-tier numbers from `limits_for`).
- `allow_additional_admins: bool` — a read-only mirror of the config-only
  switch (spec §7.1); no endpoint accepts it as input, so reporting it does
  not weaken the config-only guarantee.

This is the frontend's only source for quota/limit *numbers* — the
`effective_llm` report on checks/suggestions carries the skip *code* only
(a documented deviation from spec §6.4/§6.5, recorded in the roadmap's
Cross-milestone interfaces).

### `limits_for`'s fallback rule (`app/core/permissions.py`)

`limits_for(*, tier, is_admin, settings) -> TierLimitsSettings` returns, in
order: `settings.limits.admin` for an admin caller (the ceiling **replaces**
the tier's own block, spec §6.4) or when no `tiers:` block is configured at
all (inert mode, identical to M4); the tier's own required `limits` block
when the tier is configured; `settings.limits.admin` again as the fallback
for an unknown tier name — a case that can only ever reach `/me`'s display
and the gate's size-cap pre-check, since an unknown tier's `policy_for`
result is `NO_LLM_POLICY`, so `resolve_llm_selection` always floors out to
`"llm_unavailable"` before a reservation is ever attempted.

### Defaults (inert by design)

**`credit_cost` defaults (B6)** (`CreditCostSettings`, pricing only — no
budgets here): global `default_factor=1.0`, `default_output_weight=4.0`,
`source_weights` defaults to `{check: 1.0, suggestion: 1.0, name: 0.0}`
(`_DEFAULT_SOURCE_WEIGHTS`, merged over any partial override), `providers`
empty (so per-provider overrides are skipped). The budget default lives
elsewhere: `_default_admin_limits()` sets `credits_per_day=5_000_000`
(effectively unlimited) for the admin ceiling / inert-mode fallback. A
deployment without `credit_cost:` in config only gets default pricing
(factor 1.0, output weight 4.0, the default source weights) — runs are
still costed, windows still enforce, and `/me` still reports percentages.
Omitting `credit_cost:` is not the same as being unmetered: even the
admin ceiling / no-`tiers:` fallback (`credits_per_day=5_000_000`) is a
real, if generous, budget that a high-volume caller can still exhaust.

Shipped defaults (`LimitsSettings`, `_default_admin_limits`):
`max_llm_document_chars=200000`, `concurrent_llm_runs=5`,
`credits_per_day=5_000_000` (the admin ceiling, also what every caller gets
in inert mode), `max_concurrent_llm_runs=20` (server-wide),
`llm_run_max_age=900` (seconds), `concurrency_reject_delay=0.25` (seconds).
(B6: `llm_checks_per_day` removed — replaced by the per-tier
`credits_per_{hour,day,week,month}` budgets on `TierLimitsSettings`.)
Deliberately generous enough that an existing single-admin deployment
never notices metering exists until `tiers:`/`limits:` are configured tighter.

## API surface

Every endpoint below requires a valid `Authorization: Bearer <token>` caller **except**
`GET /api/health` and `POST /api/auth/login` — see
[Enforcement](#enforcement-router-level-auth) for how that is wired and tested.

| Endpoint | Purpose |
|---|---|
| `POST /api/checks` → `GET /api/checks/{id}[/events]` | run a check; poll or stream results |
| `POST /api/suggestions` | on-demand LLM fix (span) or sentence rewrite |
| `GET /api/rules`, `POST /api/rules/reload` | rule catalog + validation errors; hot reload |
| `GET/POST/PUT/DELETE /api/domains`, `/api/domains/{id}/terms`, `/api/terms/{id}` | terminology CRUD |
| `GET/POST/PUT/DELETE /api/profiles`, `POST /api/profiles/{id}/reset` | profile CRUD |
| `GET/POST/PUT/DELETE /api/documents`, `POST /api/documents/{id}/generate-name` | revision-guarded document CRUD + auto-titling (see [Documents](#documents)) |
| `GET/POST/PUT/DELETE /api/folders` | folder CRUD, lossless delete, read-time defaults pruning (see [Folders](#folders)) |
| `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/password` | local login/session/password-change; `/login` is public, `/me` and `/password` require a caller, `/me` carries the M4 policy/feature payload and B6 usage payload (see [Authentication](#authentication-and-user-accounts), [Tiers and LLM policy](#tiers-and-llm-policy), [LLM usage metering](#llm-usage-metering)) |
| `GET/POST/PATCH /api/admin/users` | admin user management, `require_admin` at router level (see [Authentication](#authentication-and-user-accounts)) |
| `GET /api/admin/tiers` | admin-only; returns the configured tier names (`_known_tiers`) for the admin UI's select options (added in M6) |
| `PUT /api/folders/{id}/defaults` | full-replace a folder's per-folder defaults; 422 matrix + 404 (see [Per-folder defaults](#per-folder-defaults)) |
| `POST /api/documents/{id}/move` | revision-free move of a document into/out of a folder |
| `GET /api/providers` | provider availability + model discovery; per-provider `allowed` (direct-selection policy, see [Tiers and LLM policy](#tiers-and-llm-policy)) |
| `GET /api/routing` | tier routing table with per-tier availability + reason + `allowed` (quality-tier policy) |
| `GET /api/languages` | languages + NLP model status |
| `GET /api/health` | liveness |

FastAPI serves the OpenAPI schema at `/docs` — that is the contract for any future
non-browser client. `/docs`, `/redoc`, and `/openapi.json` are FastAPI-internal
routes, not `APIRoute`s registered through the routers above, so they sit outside
both the enforcement loop in `create_app()` and the route-tree walk in
`test_auth_enforcement.py`. They are anonymously reachable **only in the `dev`
environment** (see `environment` above): outside dev, `create_app()` passes
`docs_url=None, redoc_url=None, openapi_url=None` to `FastAPI(...)`, so the routes
are never registered and all three 404 for every caller, authenticated or not.
In `dev`, Swagger's **Authorize** button works: `get_current_user`
(`app/api/deps.py`) declares an `HTTPBearer(auto_error=False, ...)` dependency
purely so the OpenAPI document carries a bearer `securityScheme` — the actual
header parsing and verification are unchanged. `auto_error=False` is
deliberate: the default `auto_error=True` mode answers a missing header with
403, but every route here must answer 401. To use it, `POST /api/auth/login`
with an email and password, then paste the response's `token` into Authorize.



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

**Suite performance.** `uv run pytest -q` runs parallel by default
(`pytest-xdist`, `-n auto --dist load` via `addopts`); pass `-n0`
for serial runs when debugging (`--pdb`) or bisecting a suspected
parallelism issue. Per-test isolation is structural — every app is
built on a test-unique `tmp_path` — which is what makes any distribution
mode safe, so the finer `load` mode (dynamic work-stealing across all
workers, rather than pinning a whole file to one worker) is used. Two
test-only accelerators keep the fixed cost per test low:
`tests/conftest.py` runs bcrypt at cost 4 inside the test process
(production stays at 12; deliberately not a config knob), and the
`document_clock` fixture replaces real sleeps for second-precision
timestamp ordering.

### Offline supabase e2e suite (B27)

`uv run pytest` above never touches a real Supabase stack — every supabase-mode
unit test drives `create_app()` through `TestClient` with a `FakeSupabaseGateway`.
That structurally cannot see bugs that only exist under a real server boot: `B14`
shipped with `seed_admin`'s supabase bootstrap calling `asyncio.run()` unconditionally,
which crashed every real `uv run uvicorn app.main:app` deployment because uvicorn
imports the app from *inside* `Server.serve()`'s already-running event loop
(`import_from_string`), not before it as the removed comment assumed — no
`TestClient`-based test constructs its app inside a running loop, so none could
have caught it. The offline e2e suite (`backend/tests_e2e/`) is integration truth
for the whole B14 surface for exactly this reason: it boots the real app as a
uvicorn subprocess against a real local Supabase stack.

Three layers: the stack definition (`supabase/config.toml` and
`supabase/templates/`, a `supabase start`-able local stack with Studio, Realtime,
Storage, Analytics, and the edge runtime disabled — only `api`, `db`, `auth`,
and Mailpit's `local_smtp` run); the wrapper (`scripts/e2e-supabase.sh`, which starts the stack
if it is down, exports the env contract below, and execs `pytest tests_e2e -q -n0`
from `backend/`); and the suite itself (`backend/tests_e2e/`, five flow files —
boot/login, refresh rotation, password change, invite acceptance, password
reset — driving the app over HTTP with no mocking).

**Env contract**, sourced by the wrapper from `supabase status -o env` and
consumed by `tests_e2e/conftest.py`'s `stack` fixture: `FW_SUPABASE_E2E_API_URL`
and `FW_SUPABASE_E2E_MAILPIT_URL` (the stack's REST and Mailpit endpoints);
`FW_SUPABASE_PUBLISHABLE_KEY`, the `sb_publishable_…` key used for user-flow
headers; and `FW_SUPABASE_SECRET_KEY`, which maps to the CLI's legacy
`SERVICE_ROLE_KEY` JWT rather than its `sb_secret_…` opaque key — local GoTrue
rejects `sb_secret_…` as a Bearer admin credential (`bad_jwt`; the hosted
platform's gateway translates it, local Kong does not).

**Isolation model.** The stack is reused across runs for fast iteration
(`scripts/e2e-supabase.sh --down` stops it explicitly) — but a running stack
keeps its boot-time config, so edits to `supabase/config.toml` or
`supabase/templates/` require `--down` first before a fresh `start` will pick
them up. Within a run, every identity is `<role>-<runid>@e2e.local` with an
8-hex-char run id, so repeated runs against the same reused stack never
collide (a second *concurrent* run is instead refused outright by the
port-8001 guard in `app_url`). The scratch app gets a fresh tempfile SQLite
database per run (`tmp_path_factory`), with its `FW_CONFIG_FILE` YAML also
generated fresh per run by `conftest.py` — which is why no static e2e config
file is committed. A session-scoped, best-effort fixture deletes that run's
GoTrue users at teardown — correctness never depends on this cleanup, only
tidiness does.

**What is deliberately not asserted.** The local iat-based access-token
eviction on password change backdates `password_changed_at` by a 60 s
clock-skew leeway, so an access token minted seconds before the change
survives that check by design; asserting it would need a real wall-clock
wait, so the e2e suite only pins the eviction guarantees it *can* observe
without waiting — every outstanding refresh token dies and the old password
stops working — and leaves the iat cutoff itself to the unit suite's
controlled clocks. Similarly, the password-reset throttle blocks silently
(always 204, no observable signal) by design, so the e2e suite exercises the
happy path and defers the throttle's blocking semantics to the unit suite,
which owns the bulk of adversarial token cases (malformed, expired,
wrong-type) that it can construct directly but the e2e suite would have to
wait or forge for; the e2e suite keeps only two zero-cost smoke cases
(garbage bearer, stale `token_hash`). Refresh-token reuse is a related case,
but with an inverted shape: GoTrue honors the *immediate* parent refresh token as retry
tolerance regardless of `refresh_token_reuse_interval` (0 included) — the
reuse response carries the identical child refresh token rather than a 401 or
a forked session — so a 401-on-reuse assertion is unachievable against real
GoTrue. `test_sessions.py` pins the property that actually holds instead:
reuse cannot fork a second session family.

**Operational limits.** GoTrue's default email rate limit (30 mails/hour) is
not configurable on this Mailpit-backed local stack — the CLI only exports
`GOTRUE_RATE_LIMIT_EMAIL_SENT` when a real SMTP config is present. At two
mails per run (invite + reset), that budget is exhausted after roughly 15
runs in an hour, after which the Mailpit client's `wait_for_message` times
out waiting for mail that GoTrue silently declined to send; the remedy is
`scripts/e2e-supabase.sh --down` followed by a fresh `start`, not a retry
loop. Separately, `[auth.rate_limit]` widens `sign_in_sign_ups`,
`token_verifications`, and `token_refresh` well past GoTrue's human-sized
defaults, because one run alone issues on the order of 16 password grants.

**Environment caveats.** colima only shares `$HOME` into its VM; bind-mounting
from outside it (e.g. `/private/tmp`) silently yields empty root-owned
directories in the container, so the checkout must stay under `$HOME` for the
stack's containers to see the repo. And `config.toml`'s path-valued keys do
not share a base: `signing_keys_path` resolves relative to the `supabase/`
directory, while `content_path` on the email templates resolves relative to
the project root — both verified against CLI 2.114.0, not documented
behavior. That signing-key file also cannot be produced by simple shell
redirection: once `signing_keys_path` is declared, `supabase gen signing-key`
reads the declared file before writing and hard-errors if it is absent, so
the wrapper pre-seeds an empty JSON array and lets the CLI write the file
itself with `--yes`.

## Container deployment (B17)

Design source: `docs/superpowers/specs/2026-08-02-single-container-design.md`. The
container image bundles the built frontend and the backend behind a single origin,
with a wizard owning the persisted config volume.

**Config resolution.** `load_settings()` (`app/core/config.py`) resolves the config
file in a fixed order: an explicit `config_file` argument first (used by tests and
one-off scripts), then the `FW_CONFIG_FILE` environment variable, then the
repo-relative `backend/config.yaml` default. The container entrypoint sets
`FW_CONFIG_FILE=/config/config.yaml`, so the wizard-generated file on the mounted
`/config` volume wins over the baked-in default without either side having to know
about the other.

**Env file and trusted proxies (B21, #78 / B26, #86).** `FW_ENV_FILE` (default:
`fabulous.env` next to the config file, i.e. `dirname(FW_CONFIG_FILE)`) is applied by
the entrypoint only for variables not already set in the real environment — real env
vars always win. A malformed line (no `=`, or not a valid shell identifier) is fatal:
`exit 78` naming the file and line number only, never the key or value, so a
mis-pasted secret never reaches the logs; CRLF line endings are tolerated.
`FW_TRUSTED_PROXIES` is opt-in: when set, the entrypoint adds `--proxy-headers
--forwarded-allow-ips "$FW_TRUSTED_PROXIES"` to the `uvicorn` invocation, so
`request.client.host` — and the login-throttle key derived from it — sees the real
client IP behind a reverse proxy instead of collapsing to the proxy's own address;
unset, uvicorn's default trust list applies — loopback only, or the standard
`FORWARDED_ALLOW_IPS` env var — so forwarded headers from external peers are still
rejected. `FW_CONFIG_FILE` and
`FW_SETUP_CONFIG_DIR` are independent knobs: relocating the config file does not
relocate the wizard's output directory, so a deployment that moves one must move the
other too, or set `FW_ENV_FILE` explicitly.

**`fabulous.sh serve`.** The wrapper pre-checks the target host port with `nc`
(skipped if unavailable) and exits 75 on a squatted port — some Docker backends
(colima) accept publishing an already-bound host port without failing, so the
container would otherwise silently lose the port to whatever's already listening. It
then `docker pull`s the image, falling back to the cached local image with a warning
when offline, prints the image's `org.opencontainers.image.version` label if present,
and only then runs the container.

**Single-origin serving.** When `frontend.dist_dir` is set, `create_app()` mounts the
built Vite assets at `/assets` and registers a `GET /{full_path:path}` catch-all that
serves `index.html` for any unmatched path (the SPA's client-side router takes it from
there), except paths starting with `api` — those stay a JSON 404 instead of falling
back to HTML. Rather than resolving the requested path against `dist_dir` at request
time, the catch-all is structurally taint-free: at mount time it walks `dist_dir` once
into a `{relative_path: absolute_path}` map, and the route body only ever does a dict
lookup against that map (falling back to `index.html` on a miss) — no request-derived
path is joined onto the filesystem, so there is no path for a traversal segment to
escape through. This route is registered last, after every `/api` router, so FastAPI's
registration-order route matching always gives real API routes priority over the
catch-all.

**The wizard.** `app/setup_wizard.py` owns the `/config` directory end to end: each
run regenerates both `fabulous.env` (secrets, written with `0o600` permissions) and
`config.yaml` (non-secret config, layered onto the baked-in template) completely,
rather than patching them in place, so a re-run that switches providers can never
leave a stale key behind. `run_wizard()` takes its config/template directories as
arguments and accepts injectable `input_fn`/`getpass_fn`/`fetch_models` callables
(defaulting to `input`, `getpass.getpass`, and `fetch_ollama_models`, a `/api/tags`
fetch — `check_ollama` no longer exists), which is what lets the test suite drive
the wizard's prompts without a real terminal or network access. The wizard also
generates the full `routing.languages` table for the chosen provider (B24, #81):
for a commercial provider, the quality/balanced/cheap tier columns come from a
verified per-provider model mapping while the local tier runs on Ollama; the config
carries `providers.ollama_base_url` pointing at the host (`host.docker.internal`),
hand-edits preserved on re-runs, so the local tier reports available once host Ollama
is reachable from the container (B25, #84); for Ollama itself, the strong and fast
models picked from the live `/api/tags` list cover quality/balanced and cheap/local
respectively. Like the rest of the config, this table is regenerated whole on
every run, never patched.

**Version reporting.** `GET /api/health` reports `version` from the `FW_APP_VERSION`
environment variable (falling back to `"dev"` when unset). The Dockerfile sets it from
the `APP_VERSION` build arg, and the release workflow passes the pushed git tag as
that arg — the tag is the single source of truth for the version string an operator
sees, not a version pinned anywhere in source.

**Image layer ordering.** The Dockerfile orders its layers by change frequency to
maximize registry build-cache hits: OS packages, then Hunspell dictionaries, then
Python dependencies synced from the lockfile alone, then the spaCy/GiNZA models
(installed via the locked `models` dependency group so their transitive dependencies
can't drift between builds), and only then the application code. Editing app code
therefore busts just the final layer, leaving the multi-gigabyte model layer cached.
