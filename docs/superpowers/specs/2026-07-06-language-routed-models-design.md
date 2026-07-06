# Language-Routed Model Configuration — Design

Date: 2026-07-06
Status: approved in brainstorming session with Markus
Origin: design sketch in `docs/model-recommendations.md` § 5

## Purpose

Today one concrete provider+model pair is active at a time, chosen in the
header or pinned per profile. Two problems:

1. **The provider list is closed.** Five slots are hardcoded
   (`ollama`, `claude`, `openai`, `mistral`, `bedrock`); vendors like
   DeepSeek, Qwen, Gemini, or OpenRouter can only be used by repointing one
   of the two OpenAI-compatible slots.
2. **Model choice is too technical for the average writer.** Which vendor is
   good at which language (Mistral for DE/FR, DeepSeek/Qwen for ZH/JA, …) is
   model expertise that shouldn't be every user's problem — and today it has
   to be re-encoded in every profile as a concrete pair.

The feature splits into two phases:

- **Phase 1 — provider registry:** additional OpenAI-compatible providers
  become first-class named entries defined in `config.yaml`; no new provider
  code, no UI concept changes.
- **Phase 2 — quality tiers with language routing:** a routing table maps
  *language × tier* (`quality | balanced | cheap | local`) to a concrete
  `{provider, model}`. Writers pick a tier; profiles store a tier; pinning a
  concrete provider+model remains as an advanced escape hatch. The header
  mirrors this design.

## Decisions (settled with Markus)

| Topic | Decision |
|---|---|
| Division of responsibility | **The routing table owns model expertise; profiles own editorial intent.** Profiles (and the header) select a *tier* by default; the routing config decides what that tier means per language. |
| Tier vs. pin in profiles | **Both, tier-first.** A profile may select a tier *or* pin a concrete provider+model. The pin lives in a collapsed "Advanced" panel; a set pin wins over the tier. |
| Header | **Mirrors the profile design.** The provider/model dropdowns are replaced by a tier selector showing the resolved model; the concrete dropdowns move into a collapsed advanced panel and act as an ephemeral pin override, exactly like today's header overrides. |
| Degradation | **Never silent.** Unavailable tiers are shown greyed out with the reason. If the selected tier's provider is unavailable, the LLM check does not run and the status line says why. No automatic fallback down the tier ladder. |
| Tier set | **Fixed four:** `quality`, `balanced`, `cheap`, `local` (internal ids). UI labels are writer-friendly and localized (EN: *Best quality / Balanced / Fast & economical / Private (local)*). No user-defined tiers. |
| Resolution location | **Client-side**, consistent with the existing philosophy: the check API stays profile- and tier-agnostic (`llm_provider` + `llm_model` per request). The frontend fetches the routing table and resolves tier → pair when building requests. |
| Registry scope | Built-in five stay as they are (they encode special auth/discovery behavior). Config adds **`extra_providers`**, a map of OpenAI-compatible entries only — the one type that needs no new code. |
| API keys | Environment-only, unchanged. Extras derive their env variable from the entry name: `deepseek` → `DEEPSEEK_API_KEY`. Never a key or key reference in config. |
| Routing defaults | **Shipped in code**, taken from `docs/model-recommendations.md` § 3–5. Default entries may reference providers that aren't configured (e.g. `deepseek`); those tiers simply report as unavailable with reason "provider not configured" — this doubles as configuration guidance. |
| Failover (OpenRouter) | **Out of scope** (the sketch's phase 3). The tier selector already gives users a manual fallback; automatic re-dispatch would touch `_run_llm`/SSE error handling and contradicts the no-silent-degradation decision unless carefully surfaced. Not designed here. |
| Local tier | Plain routing entries pointing at `ollama` per language. The sketch's `local_models` presets and `min_ram_gb` metadata are dropped (YAGNI — hardware detection is not the app's job). |

---

## Phase 1 — Provider registry

### Configuration

`ProviderSettings` (backend `app/core/config.py`) gains:

```yaml
# backend/config.yaml
providers:
  # ... existing flat keys unchanged ...
  extra_providers:
    deepseek:
      base_url: https://api.deepseek.com/v1
      default_model: deepseek-v4-pro
    qwen:
      base_url: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
      default_model: qwen3.7-max
    openrouter:
      base_url: https://openrouter.ai/api/v1
      default_model: anthropic/claude-sonnet-5
      exclude_model_fragments: [embedding]   # optional, default []
```

- Entry names must match `^[a-z][a-z0-9_]*$` (they derive the env variable:
  `<NAME upper-cased>_API_KEY`) and must not collide with the built-in five.
  Violations fail config loading with a clear error — config is local, fail
  fast.
- `base_url` and `default_model` are required; `exclude_model_fragments`
  (same mechanism as `OPENAI_EXCLUDED_MODEL_FRAGMENTS`) is optional.

### Provider factory

`make_provider_factory` (`app/main.py`): after the existing five branches,
look the name up in `extra_providers` and construct an `OpenAICompatProvider`
with `api_key=os.environ.get(f"{name.upper()}_API_KEY")`. Unknown names still
raise `ValueError`.

### Discovery

`GET /api/providers` (`app/api/providers.py`): after the five built-in
entries, one `_openai_compat_entry`-style entry per extra provider (same
availability rule: key present → available; live model discovery with the
existing 5 s timeout, falling back to `[default_model]`). Response shape is
unchanged — extras appear as ordinary entries, so the current frontend shows
them with zero changes.

### Phase 1 deliverable

Stands alone: DeepSeek/Qwen/Gemini/OpenRouter usable as named providers in
the header and pinnable in profiles, instead of squatting in the two
OpenAI-compatible slots. No schema, UI, or check-API changes.

---

## Phase 2 — Quality tiers with language routing

### Routing configuration

New top-level `routing` section in `config.yaml`, with code-shipped defaults
built from the recommendations doc:

```yaml
routing:
  default_tier: balanced
  languages:
    de:
      quality:  { provider: claude,   model: claude-opus-4-8 }
      balanced: { provider: mistral,  model: mistral-large-latest }
      cheap:    { provider: mistral,  model: mistral-small-latest }
      local:    { provider: ollama,   model: mistral-nemo:12b-instruct-2407-q6_K }
    zh:
      quality:  { provider: deepseek, model: deepseek-v4-pro }
      # ...
```

- A user-supplied `languages.<lang>` entry replaces that language's whole
  tier map (no per-tier merging — simpler to reason about).
- Entries may reference any registry name (built-in or extra). Referencing a
  name that exists nowhere is **not** a startup error; the tier reports as
  unavailable ("provider not configured"). A tier missing from a language's
  map is simply absent (selector shows it disabled, "not configured for
  <language>").
- Default routing for all seven languages ships in code
  (`default_factory`), using built-in providers where possible and
  `deepseek`/`qwen` extras for ZH/JA quality/cheap tiers.

### Routing API

New endpoint `GET /api/routing`:

```json
{
  "default_tier": "balanced",
  "tiers": ["quality", "balanced", "cheap", "local"],
  "languages": {
    "de": {
      "quality":  { "provider": "claude",  "model": "claude-opus-4-8",
                    "available": true,  "reason": null },
      "balanced": { "provider": "mistral", "model": "mistral-large-latest",
                    "available": false, "reason": "missing MISTRAL_API_KEY" },
      "local":    { "provider": "ollama",  "model": "mistral-nemo:12b-instruct-2407-q6_K",
                    "available": false, "reason": "ollama unreachable" }
    }
  }
}
```

Availability reuses the same computation as `/api/providers` (extract a
shared helper): env key present for API providers, reachability for Ollama,
credential chain for Bedrock, "provider not configured" for unknown names.
No per-model validation — the model slug is taken on faith (routing config
is admin-editable; slug drift is an accepted maintenance task, see
`model-recommendations.md` § 6).

The check API (`POST /api/checks`, `POST /api/suggestions`) is **unchanged**:
it keeps taking concrete `llm_provider`/`llm_model`. The frontend resolves.

### Profile data model

`profiles` gains one nullable column (idempotent `ALTER TABLE … ADD COLUMN`
guarded by a `pragma table_info` check, same startup path that creates the
table):

```sql
llm_tier TEXT   -- 'quality' | 'balanced' | 'cheap' | 'local' | NULL
```

Precedence when a profile is applied: **pin wins over tier wins over "no
opinion"**:

| `llm_provider` | `llm_tier` | Meaning |
|---|---|---|
| set | any | pinned to `llm_provider`/`llm_model` (tier ignored) |
| NULL | set | tier mode |
| NULL | NULL | no opinion — header LLM settings stay as they are (today's null-provider semantics, so **existing rows keep behaving identically; no data migration**) |

API (`ProfileIn`/`ProfileOut` and `PUT /api/profiles/{id}`): `llm_tier`
validated against the four ids (422 otherwise). Both fields may be stored
simultaneously; the precedence rule is the contract.

Seeding changes (fresh installs / new languages only): Standard, Marketing,
and Technical Documentation profiles seed with `llm_tier = 'balanced'` and
`llm_provider = llm_model = NULL`. The Standard-reset endpoint's factory
defaults change accordingly. Existing databases are untouched (their
Standard rows keep the concrete pinned provider captured at seed time).

### Frontend: state and resolution

- `types.ts` / `api/client.ts`: `Tier` union, `RoutingTable` types,
  `fetchRouting()`; `Profile` gains `llm_tier`.
- Store: new persisted field `tier: Tier | null` beside `provider`/`model`.
  **`tier !== null` means tier mode; `tier === null` means pinned mode**
  (provider/model are authoritative). `provider`/`model` keep their last
  values in tier mode so the advanced panel can prefill. Routing table is
  fetched at startup alongside providers and kept in the store (ephemeral).
- New pure module `checking/routing.ts`:
  `resolveModel(state, routing): { provider, model } | { error: reason }` —
  pinned mode returns the pair (a null model falls back to the provider's
  default, today's `effectiveModel` behavior); tier mode looks up
  `routing.languages[language][tier]`, returning the annotated
  unavailability reason when the entry is missing or unavailable.
- `runCheck` (controller) and `suggest.ts` build requests through
  `resolveModel`. On an error result the LLM part is skipped and the reason
  goes to the status line / vet message (fast checkers still run) — the
  explicit-failure behavior, matching an unavailable pinned provider today.

### Frontend: header (mirrors the profile design)

In `App.tsx`, the LLM and model `<select>`s are replaced by one control
group:

- **Tier selector** — the four tiers with localized labels; beneath it, the
  resolved pair as small text ("→ mistral-large-latest (mistral)").
  Unavailable tiers are disabled with the reason as tooltip/title. In pinned
  mode the selector shows a distinct "Pinned" state.
- **Advanced panel** — collapsed by default (disclosure); contains today's
  provider and model dropdowns. Touching them pins (sets `tier = null`).
  Selecting a tier clears the pin (one click back to tier mode).

Header changes remain ephemeral overrides with the computed dirty marker,
exactly as today.

### Frontend: profile semantics

`profiles/profile.ts`:

- `HeaderSettings` gains `tier: Tier | null`.
- `applyProfileToHeader`: pinned profile → `{ tier: null, provider, model }`;
  tier profile → `{ tier, provider/model unchanged }`; both-null → LLM
  fields unchanged (today's semantics).
- `isProfileDirty` becomes mode-aware:
  - profile pinned: dirty iff header is in tier mode or the pair differs
    (today's comparison);
  - profile tier: dirty iff header is pinned or the tier differs;
  - both null: LLM fields never dirty (unchanged).
- Saving a dirty header into the profile writes the header's mode: tier mode
  → `llm_tier` set, pin cleared; pinned mode → pair set, `llm_tier` cleared.

`ProfilesView.tsx`: each card gets the same tier selector + collapsed
Advanced panel as the header. Selecting a tier clears the pin; when a pin is
set, the tier control shows the "pinned model overrides tiers" state.

### i18n

New keys in all seven catalogs: the four tier labels, "Advanced", "Pinned",
unavailability reasons ("requires {env}", "Ollama not running", "provider
not configured", "not configured for this language"), and the resolved-model
caption. The keys-equality CI test enforces completeness.

---

## Testing

- **Backend:** config parsing/validation of `extra_providers` (name rules,
  collisions, required fields); factory construction for an extra entry;
  `/api/providers` including extras (key present/absent); `/api/routing`
  shape, availability annotation, unknown-provider and missing-tier cases,
  per-language config override; profile CRUD with `llm_tier` (validation,
  precedence untouched by store); seeding/reset with tier defaults; the
  `ALTER TABLE` guard is idempotent across restarts.
- **Frontend (vitest, plain modules):** `resolveModel` (pinned, tier hit,
  tier unavailable, tier missing, language missing); mode-aware
  `isProfileDirty` and `applyProfileToHeader`; store save-header-to-profile
  mapping; i18n key equality (existing test covers the new keys).
- **Manual E2E:** fresh DB → Standard is Balanced; DE balanced resolves to
  Mistral and greys out without `MISTRAL_API_KEY`; pin via advanced panel →
  dirty marker → save → pin persists; clear pin → tier restored; check with
  unavailable tier → fast findings appear, status line explains the skipped
  LLM check.

## Documentation impact (definition of done)

- `docs/backend-architecture.md`: configuration section (registry +
  routing), API surface table (`GET /api/routing`), profiles section
  (tier column, precedence), provider table (extras row).
- `docs/frontend-architecture.md`: module map (`checking/routing.ts`), store
  slice (`tier`), header description, profile semantics.
- `docs/model-recommendations.md`: § 1 table gains extras; § 5 re-titled
  from "not implemented" to describing the shipped mechanism, sketch YAML
  replaced by/aligned with the real config format.
- `README.md`: configuration example for `extra_providers`; screenshots
  refresh (header changed).

## Open items

- Verify default-routing model slugs against current vendor docs before
  shipping the defaults (`deepseek-v4-pro`, `qwen3.7-max`,
  `mistral-large-latest`, …) — `model-recommendations.md` § 6 applies.
- Tier label copy in the six non-EN locales (translation quality pass).
- Whether `/api/routing` and `/api/providers` should later merge into one
  response to avoid double discovery cost — decide at implementation time;
  the shared availability helper keeps either option cheap.
