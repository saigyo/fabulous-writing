# Provider-Aligned Routing (B24, #81) — Design

**Item:** [#81](https://github.com/saigyo/fabulous-writing/issues/81).
Found during the v0.1.0 acceptance test: a wizard-configured
single-provider instance keeps the multi-provider default routing table,
so most language×tier combinations point at providers the instance does
not have — LLM checks fail with an error next to the LLM selector, and
the out-of-the-box experience is broken for every language but English.

**Root cause (settled by the audit, not the issue's initial framing):**
the seeded profiles are innocent — the standard profile stores
`llm_tier: "balanced"` with `llm_provider`/`llm_model` unset, so it
resolves through `routing.languages`. The broken layer is that table:
`Settings.routing.languages` defaults to the multi-provider matrix from
`docs/model-recommendations.md` (Mistral for de/fr/es/it balanced,
Gemini cheap, DeepSeek/Qwen for zh/ja). `GET /api/routing`
(`backend/app/api/routing.py`) reports per-provider availability, and
the frontend selector shows the unavailable reason — correctly, for a
table that is wrong for this instance.

**Scope decisions (settled with Markus, 2026-08-02):**

- **The wizard writes the routing table.** No profile/DB re-seeding, no
  startup env-sniffing. The setup wizard generates a complete
  provider-appropriate `routing.languages` table into the
  `/config/config.yaml` it already regenerates whole on every run.
  A full 7-language × 4-tier table is mandatory: `RoutingSettings` has
  a before-validator that overlays the built-in multi-provider defaults
  for every language the config does not mention — a partial table
  would silently resurrect exactly the stale entries this feature
  removes.
- **`local` tier stays Ollama** under a commercial provider: it keeps
  the Ollama defaults and shows honestly unavailable ("Ollama not
  running") — truthful, and it doubles as discoverability for users who
  later start Ollama. (Matches the existing
  unavailable-as-configuration-guidance pattern.)
- **Ollama gets a strong + fast model split** chosen from the user's
  installed models (the wizard's existing `/api/tags` probe): quality +
  balanced → strong, cheap + local → fast; the fast pick is optional
  (Enter = strong everywhere).
- **Model lineups researched 2026-08-02 and approved by Markus** (see
  tables below). Anthropic confirmed current by Markus; OpenAI and
  Mistral verified via web research; the implementation verifies each
  ID against the provider's live models endpoint before shipping.

## The change

One component changes: `backend/app/setup_wizard.py`. Everything else —
profiles, seeding, DB, `GET /api/routing`, the frontend — is untouched
and self-corrects because the selector reads the table from settings.
User customizations made in the profile admin screen live in the DB and
are never touched by the wizard.

### Per-provider tier tables (same models for all 7 languages)

Language-specialized routing is a multi-provider luxury; a
single-provider instance uses one column of models across en, de, fr,
es, it, ja, zh. `local` always keeps `{provider: ollama, model:
<providers.ollama_model>}`.

| Tier | claude (Anthropic) | openai | mistral |
|---|---|---|---|
| quality | `claude-opus-5` | `gpt-5.6-sol` | `mistral-medium-latest` |
| balanced | `claude-sonnet-5` | `gpt-5.6-terra` | `mistral-large-latest` |
| cheap | `claude-haiku-4-5` | `gpt-5.6-luna` | `mistral-small-latest` |

Notes pinned by the 2026-08-02 research:

- OpenAI's GPT-5.6 family (launched 2026-07-09) tiers cleanly: Sol
  (frontier, alias `gpt-5.6`), Terra (balanced production), Luna
  (volume). The pinned IDs are used, not the alias. `gpt-5.5-pro` is
  deliberately excluded (6× Sol's price; not tier material).
- Mistral's naming is inverted relative to capability: **Medium 3.5**
  (`mistral-medium-latest` → `medium-2604`) is currently their
  strongest general model; **Large 3** (`large-2512`) is the fast,
  cheaper multimodal. Quality therefore maps to *medium*, balanced to
  *large* — the generated config carries a one-line comment saying this
  is deliberate, so nobody "fixes" it by name intuition.
- Mistral entries use `-latest` aliases (Mistral moves them with
  releases; the instance tracks). Anthropic/OpenAI entries are pinned
  IDs (their alias story is sparser). The implementer must verify every
  ID against the provider's live models endpoint (`/v1/models` or
  equivalent) during implementation and correct the table + this spec
  if a name has moved.

### Wizard flow changes

- **Commercial provider chosen:** no new prompts. After the existing
  key prompt, the wizard emits the provider's table (28 entries) under
  `routing.languages` in the generated config.
- **Ollama chosen, probe succeeds:** the wizard lists the installed
  models by name, numbered.
  Prompts: "Strong model (for quality/balanced)" — pick a number or
  type a name; then "Fast model (for cheap/local) [Enter = same]".
  Both entered names are validated against the tag list (the existing
  exact-or-basename match); a name not in the list re-prompts.
  `providers.ollama_model` is set to the strong model (keeps direct
  provider selection and the legacy single-model path consistent).
  Table: quality+balanced → strong, cheap+local → fast, all languages.
- **Ollama chosen, probe fails:** today's free-text single-model prompt
  remains (setup must work before Ollama is started); the table maps
  all four tiers to that model. The existing warning + networking hints
  are unchanged.
- **Re-run:** pre-fill as everywhere else — the wizard reads the
  existing config's table, recognizes the strong/fast pair (or the
  commercial provider) and offers current values as defaults. Because
  the config is regenerated whole, a provider switch rewrites the whole
  table; no stale entries can survive (same invariant as the env file).

### Generated config shape

```yaml
providers:
  default_provider: claude
routing:
  languages:
    en:
      quality:  { provider: claude, model: claude-opus-5 }
      balanced: { provider: claude, model: claude-sonnet-5 }
      cheap:    { provider: claude, model: claude-haiku-4-5 }
      local:    { provider: ollama, model: llama3.1 }
    de:
      # ... identical per language, all 7
```

`routing.default_tier` is not written (stays `balanced` by default).
The table is generated by code, not stored as a template — the
`docker/config.container.yaml` template stays as-is and the wizard
appends the routing section during generation.

## Verification

- Wizard unit tests (injected IO, no network, tmp_path only):
  - each commercial provider produces exactly the expected 28-entry
    table (full-table equality against a literal expectation, not
    spot checks);
  - Ollama strong+fast, fast-skipped (strong everywhere), and
    probe-failure fallback paths;
  - re-run pre-fill and provider-switch table rewrite
    (mutation-verified: simulate a merge that keeps old entries → the
    switch test fails);
  - every generated config variant validates through
    `Settings.model_validate` (extend the existing `TestImageContract`
    pattern) — `extra="forbid"` guards the shape.
- Existing wizard tests keep passing (the new prompts only appear on
  the Ollama-probe-success path, which existing tests stub as needed).
- Backend gates: `uv run pytest -q` green, zero warnings.
- E2e (scratch container, port 8001, `fwscratch` prefixes): configure
  Anthropic via the wizard non-interactively, start serve, call
  `GET /api/routing` authenticated, assert every non-local tier of
  every language reports `available: true` and the expected model IDs;
  assert `local` reports unavailable with the Ollama reason.
- Live model-ID verification during implementation: each Anthropic /
  OpenAI / Mistral ID checked against the provider's models endpoint
  where an API key is available in the dev environment
  (`backend/api-keys.sh`); for providers without a key, verified
  against the provider's official model documentation instead. Either
  way, the evidence (endpoint output or doc URL) goes in the task
  report.

## Out of scope

- Startup-derived routing for non-wizard deployments (dev setups edit
  `backend/config.yaml` directly, as today).
- Changes to `docs/model-recommendations.md`'s multi-provider table —
  it remains the default for key-rich setups. (A short pointer note
  about the single-provider wizard behavior is in scope for that doc.)
- Profile/DB migrations, the tier-availability UI, per-language model
  differentiation for single-provider setups, Bedrock and
  extra-provider (OpenAI-compatible) wizard support.

## Sequencing

Directly after B17 (#58, v0.1.0) while fresh; before B16 (#57) so the
fly.io demo experience is smooth. Usual shape: planning PR (this spec +
plan, squash-merged), then one implementation PR (`Closes #81.`),
verified against a locally built image.
