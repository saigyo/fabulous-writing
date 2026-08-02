# Language Model Recommendations

Last updated: August 2026, checked against the implementation as of 2026-08-02.
Based on research into API and Ollama models for the seven languages supported
by the app (EN, DE, FR, IT, ES, ZH, JA).

> The per-language multi-provider table below remains the default for
> key-rich setups. Wizard-configured single-provider instances get a
> generated single-provider routing table instead (`app/setup_wizard.py`,
> B24/#81) — same model across all languages per tier, including the
> deliberate Mistral quality=medium mapping (Medium 3.5 is Mistral's
> current strongest general model, ahead of the confusingly-named Large 3).

This document serves two purposes:

1. **Documentation:** Prose recommendations that explain model choice per language.
2. **Source of truth for the shipped tier routing:** § 5 describes the language-routed
   quality-tier configuration (`routing` in `config.yaml`) that ships in code, built
   from the recommendations below — see § 5 for the actual config format and
   `backend/config.example.yaml` for the annotated keys.

---

## 1. How this maps to Fabulous Writing today

In the header, writers normally pick a **quality tier** (Best quality / Balanced /
Fast & economical / Private (local)); a per-language routing table resolves the tier
to a concrete provider and model (§ 5). The header's Advanced panel and checking
profiles can still pin an exact provider+model instead, bypassing routing entirely.
Underneath both, the app ships five built-in LLM providers, selected directly when
pinning, or per request via the check API:

| Provider  | Reaches | Model selection |
|-----------|---------|-----------------|
| `ollama`  | local [Ollama](https://ollama.com) | discovered live from the Ollama instance |
| `claude`  | Claude API | discovered live from the Anthropic models API (default `providers.anthropic_model`, `claude-sonnet-5`) |
| `openai`  | OpenAI — or any OpenAI-compatible endpoint via `providers.openai_base_url` | discovered live |
| `mistral` | Mistral — or any OpenAI-compatible endpoint via `providers.mistral_base_url` | discovered live |
| `bedrock` | AWS Bedrock (Claude et al.; EU regions available) | discovered live with `bedrock:List*` permissions, or pinned via `bedrock_models` |

API keys are read from the environment only (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `MISTRAL_API_KEY`; the AWS credential chain for Bedrock) and
are never stored in configuration. Defaults live in `backend/config.yaml`
(see `backend/config.example.yaml`).

**Using providers not built in (DeepSeek, Qwen, Gemini, OpenRouter):** all of
them speak the OpenAI chat-completions protocol and can be added as named
entries under `providers.extra_providers` in `backend/config.yaml`, e.g.:

```yaml
providers:
  extra_providers:
    deepseek:
      base_url: https://api.deepseek.com/v1
      default_model: deepseek-v4-pro
```

with the key in the environment variable derived from the entry name
(`DEEPSEEK_API_KEY`). The entry appears in the header dropdown with live model
discovery, and profiles can pin it. The same works for Qwen/DashScope
(`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`), Google
(`https://generativelanguage.googleapis.com/v1beta/openai`), and OpenRouter
(`https://openrouter.ai/api/v1`). The tiered per-language routing table that can
reference these entries is described in § 5.

**EU residency for Claude:** the built-in `bedrock` provider with
`bedrock_region: eu-central-1` (and an `eu.`-prefixed inference-profile id)
keeps traffic in EU regions — no extra configuration path needed.

---

## 2. Guiding principles

Across all seven languages, three model families stand out:

- **European languages (EN/DE/FR/IT/ES):** Mistral is explicitly trained on
  FR/ES/DE/IT and delivers very natural results among the open-weight options for
  European language pairs. For the highest stylistic quality, Claude (Opus/Sonnet,
  particularly strong for FR/DE) and GPT-5.x lead. Mistral is weaker on Asian
  languages than DeepSeek/Qwen/GPT/Claude.
- **Chinese (ZH):** DeepSeek V4 is the strongest option and, thanks to its
  Chinese-optimized tokenizer, also cost-effective. Qwen likewise dominates on CJK.
- **Japanese (JA):** The Qwen and DeepSeek families lead. Important caveat:
  proprietary frontier models sometimes underperform specialized or Asian-focused
  models on JA. Always benchmark JA against your own text samples — rankings vary
  significantly by text type (literary vs. technical).

Cost note: CJK consumes 1.5–3× more tokens per word than English. Factor this into
API cost estimates for ZH/JA.

---

## 3. API models (subscription or pay-per-use)

| Language | Premium quality             | EU residency / price-performance | Cheap, high volume            |
|----------|-----------------------------|----------------------------------|-------------------------------|
| EN       | GPT-5.5, Claude Opus/Sonnet | Mistral Large                    | Gemini Flash, GPT-nano        |
| DE       | Claude Opus/Sonnet, GPT-5.x | **Mistral Large** (EU)           | Gemini Flash                  |
| FR       | Claude Opus/Sonnet          | **Mistral Large** (EU)           | Gemini Flash                  |
| IT       | GPT-5.x, Claude             | **Mistral Large** (EU)           | Gemini Flash                  |
| ES       | Claude, GPT-5.x             | **Mistral Large** (EU)           | Gemini Flash                  |
| ZH       | **DeepSeek V4**             | Qwen3.7 Max                      | DeepSeek V4 Flash             |
| JA       | Qwen3.7 Max / Qwen-MT       | Qwen3.6 Plus                     | Qwen3 (small), DeepSeek V4 Flash |

**Indicative pricing** (as of June/July 2026, input/output per million tokens):

| Model            | Input     | Output    | Note                             |
|------------------|-----------|-----------|----------------------------------|
| GPT-5.5          | $5.00     | $30.00    | Premium generalist               |
| Claude Sonnet 5  | $3.00     | $15.00    | Strong on style / EU languages; the app's default `claude` model |
| Mistral Large    | cheaper than GPT/Claude for EU languages | | EU deployment / self-hosting possible |
| Qwen3.7 Max      | $1.25     | $3.75     | Proprietary flagship             |
| Qwen3.6 Plus     | $0.50     | $3.00     | Price-performance for CJK        |
| DeepSeek V4 Pro  | $0.435    | $0.87     | Best ZH↔EN quality               |
| DeepSeek V4 Flash| $0.14     | $0.28     | Cheapest high-volume option      |

For users who want a *single* provider with access to all models: OpenRouter
offers OpenAI-compatible single-key access to many models (small markup, ideal for
evaluation and failover) — usable today as a `providers.extra_providers` entry
(section 1).

---

## 4. Local models (Ollama)

The lower bound for "smallest usable model" is language-dependent: European
languages are well covered even by very small models, while CJK requires more
parameters.

| Purpose                          | Model           | Pull                          | Size    | Min. RAM     |
|----------------------------------|-----------------|-------------------------------|---------|--------------|
| Smallest all-round multilingual  | Qwen3 4B        | `ollama pull qwen3:4b`        | ~2.5 GB | 8 GB         |
| EU languages only, very small    | Gemma 3 4B      | `ollama pull gemma3:4b`       | 3.3 GB  | 8 GB         |
| CJK + EU together, usable        | Qwen3 8B        | `ollama pull qwen3:8b`        | ~4.7 GB | 8 GB (tight) |
| All 7 languages in one           | Mistral Nemo 12B| `ollama pull mistral-nemo`    | ~7 GB   | 16 GB        |

In the app, pulled models appear in the header's model dropdown automatically
(live discovery); the startup default is `providers.ollama_model` in
`backend/config.yaml`.

**Mistral Nemo 12B** is the only smaller model that covers all seven of the app's
languages in one (natively trained on EN/FR/DE/ES/IT/PT/ZH/JA/KO/AR/HI), with
function calling. Native context window: **128K** (Ollama incorrectly displays
"1000K").

See also [`notes/2026-07-04-ollama-model-research.md`](notes/2026-07-04-ollama-model-research.md)
for latency measurements on the development machine and notes on the Gemma 4
family (including the MoE `gemma4:26b` variant), which complements the
size-focused table above.

### Quantization recommendation (Mistral Nemo)

Never choose `q4_0`/`q4_1` (legacy) when the same-size `_K_M` variant is available —
K-quants distribute the bits more intelligently at the same file size.

| Hardware class | Recommended tag | Size    | Rationale                                   |
|----------------|-----------------|---------|---------------------------------------------|
| ≥16 GB RAM     | `q4_K_M`        | 7.5 GB  | General sweet spot                          |
| ≥32 GB RAM     | `q6_K`          | 10 GB   | Near-lossless; ideal for text checking      |
| 8 GB RAM       | — (not recommended) | —   | Use Qwen3 4B / Gemma 3 4B instead           |

**For Apple Silicon with plenty of RAM (e.g. an M4 Pro with 48 GB):** `q6_K`.
RAM is not a bottleneck; `q8_0`/`fp16` no longer yield a perceptible quality
gain but cost throughput. Text checking (fine grammatical/stylistic
discrimination) is more sensitive to quantization loss than chat — so don't
economize here.

```bash
# Recommendation for 32 GB+ machines
ollama pull mistral-nemo:12b-instruct-2407-q6_K
# Alternative, if RAM should stay free for parallel models / large context
ollama pull mistral-nemo:12b-instruct-2407-q5_K_M
```

Such machines can also run dense 30B/32B models or Qwen3-30B-A3B (MoE, 32B-class
quality at 3–4B speed) as a local reference ceiling.

**Quantization rule of thumb:** `q4_K_M` as the default for ≥16 GB devices,
`q6_K` for ≥32 GB. Smaller quants (`q3_K_M`, `q2_K`) only as a last resort — on
8 GB machines, a smaller, less-quantized model (Qwen3 4B / Gemma 3 4B) is almost
always better than a heavily quantized 12B.

---

## 5. Language-routed configuration (implemented 2026-07: provider registry + tier routing)

This section used to sketch a possible future extension; it now describes the
shipped mechanism. Per language, a **quality tier** (`quality | balanced | cheap |
local`) resolves to a concrete `{provider, model}` pair via a routing table; writers
pick a tier in the header (or a checking profile), and the concrete pair is resolved
client-side. Pinning an exact provider+model remains available as an advanced escape
hatch, bypassing routing entirely (§ 1). The building blocks needed no new provider
code: the `LLMProvider` protocol and the generic `OpenAICompatProvider` already cover
every extra vendor as a `providers.extra_providers` entry (§ 1); tier routing adds a
lookup table on top plus a `GET /api/routing` endpoint that annotates each tier with
availability.

The shipped config format is documented in `backend/config.example.yaml`:
`providers.extra_providers` (named OpenAI-compatible endpoints) and `routing`
(`default_tier` plus a per-language tier → `{provider, model}` map, with code-shipped
defaults built from § 2–4 below). See
`docs/superpowers/specs/2026-07-06-language-routed-models-design.md` for the full
design and decision log.

The original sketch's `local_models` presets (hardware-tiered Ollama picks with
`min_ram_gb` metadata) and OpenRouter failover were deliberately **not** built —
hardware detection isn't the app's job (YAGNI), and automatic failover conflicts with
the no-silent-degradation rule unless carefully surfaced; see the design spec's
decision table for both calls.

---

## 6. Open items

- **Verify model slugs:** Check the exact API model names (e.g. `deepseek-v4-pro`,
  `qwen3.7-max`, `mistral-large-latest`, `gemini-flash`) against each provider's
  current documentation — names change frequently. (`claude-sonnet-5` and
  `claude-opus-4-8` are current Anthropic slugs.)
- **JA/ZH evaluation:** Benchmark against real app text samples before relying on
  the rankings; consider a specialized model for JA if needed. The per-request
  `llm_model` parameter of `/api/checks` makes A/B comparisons easy.
- **EU compliance:** Where required, run Qwen/DeepSeek via an EU-hosted inference
  provider or self-hosted, rather than through the default Chinese endpoints.
- **Tokenizer costs:** Account for the 1.5–3× token overhead for ZH/JA in cost
  estimates and rate limits.
