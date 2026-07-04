# Ollama model choice for LLM checking, suggestions, and rewrites

Status: research notes, 2026-07-04. No decision implemented yet — the default model in
`backend/config.yaml` / `ProviderSettings` is unchanged. Next step: local benchmark
(see below).

## Why

Measured on the development machine (Apple Silicon, Ollama with MLX backend):

| Task | Model | Latency |
|---|---|---|
| Full-text check (~1 paragraph) | gemma4:12b (warm) | ~30–70 s |
| Sentence rewrite (`scope=sentence`) | gemma4:12b (warm) | ~90 s (first attempt exceeded the old 120 s timeout) |
| Full-text check | qwen3.5:2b-mlx (cold) | ~79 s (mostly model load) |

The suggestion/rewrite endpoints are much simpler tasks than full-text review, so a
smaller/faster model is attractive. Both `/api/checks` and `/api/suggestions` accept a
per-request `llm_model`, so different tasks can use different models without code
changes.

## Findings

### Gemma 4 family ([ollama library](https://www.ollama.com/library/gemma4))

| Variant | Parameters | Notes |
|---|---|---|
| e2b | 2.3 B effective | phone/edge class |
| e4b | 4.5 B effective (~3 GB quantized) | designed for fast local inference |
| 12b | 12 B dense | our current default; all 12 B active per token |
| 26b | 25.2 B total, **3.8 B active** (MoE) | installed locally as `gemma4:26b-mlx` |
| 31b | 30.7 B dense | workstation class |

Key insight: **`gemma4:26b-mlx` (already installed) should generate tokens roughly
3× faster than `gemma4:12b`** — MoE activates only ~3.8 B parameters per token vs 12 B
dense — while [size comparisons](https://botmonster.com/ai/run-gemma-4-locally-ollama-all-model-sizes-compared/)
report quality close to the 31 B dense model. Faster *and* better, zero download.

Gemma 4 claims [140+ language support](https://aurigait.com/blog/gemma-4-features-benchmarks-guide/),
relevant for our English+German requirement.

### Small models and German

A [multilingual grammatical-error-correction study (arXiv 2505.06004)](https://arxiv.org/pdf/2505.06004)
found that ~2 B models frequently fail *language adherence* — e.g. Gemma-2 2B produced
German output only 42 % of the time, drifting into English. A rewrite that comes back in
English is useless for us, so **the 2 B class (including installed `qwen3.5:2b-mlx`) is
ruled out for German**. `qwen3.5:2b` is also multimodal-oriented rather than
writing-tuned ([DataCamp tutorial](https://www.datacamp.com/tutorial/qwen-3-5-small-models-tutorial)).

### Last-generation alternatives

"Best Ollama models" listicles ([DeployBase](https://deploybase.ai/articles/best-ollama-models),
[Local AI Master](https://localaimaster.com/blog/best-ollama-models)) still recommend
Llama 3.x 8B, Mistral 7B, and Qwen 2.5 7B for structured JSON output. Solid, but no
apparent reason to prefer them over the newer Gemma 4 generation already in use.

## Recommendations

1. **First choice: switch to `gemma4:26b-mlx`** (already installed) for all LLM tasks —
   expected faster than `gemma4:12b` at equal or better quality.
2. **Small-download option: `gemma4:e4b`** (~3 GB) for the suggestion/rewrite endpoints
   if 26 B MoE's prompt-processing or memory footprint disappoints; stays in the Gemma
   family for German quality.
3. **Avoid 2 B-class models** for anything German.
4. Consider a per-task default (fast model for suggestions/rewrites, larger for full
   checks) — would need a small config extension (e.g. `providers.suggestion_model`).

## Caveats / next step

Vendor claims and blog benchmarks only — not yet measured on our hardware with our
prompts. Before changing defaults, benchmark `gemma4:12b` vs `gemma4:26b-mlx` vs
`gemma4:e4b` on the real `/api/suggestions` rewrite prompt (EN + DE), measuring latency
and checking German output stays German.

## All sources

- https://www.ollama.com/library/gemma4
- https://www.gemma4.wiki/guide/gemma-4-model-sizes-parameters-vram-requirements-ollama
- https://botmonster.com/ai/run-gemma-4-locally-ollama-all-model-sizes-compared/
- https://aurigait.com/blog/gemma-4-features-benchmarks-guide/
- https://gemma4all.com/blog/run-gemma-4-with-ollama
- https://arxiv.org/pdf/2505.06004
- https://www.datacamp.com/tutorial/qwen-3-5-small-models-tutorial
- https://deploybase.ai/articles/best-ollama-models
- https://localaimaster.com/blog/best-ollama-models
