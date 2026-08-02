# Local Tier Host-Ollama URL (B25, #84) — Design

**Item:** [#84](https://github.com/saigyo/fabulous-writing/issues/84),
follow-up from B24's final review. When the wizard configures a
commercial provider, the generated config omits
`providers.ollama_base_url`, so the `ProviderSettings` default
`http://localhost:11434` applies — inside the container, that is the
container itself. The `local` tier is therefore permanently "Ollama not
running" even when host Ollama runs, and the spec'd discoverability
("the tier lights up when the user starts Ollama") is a dead end.

**Approved design (Markus, 2026-08-02):** in `run_wizard`'s config
generation, when the provider is commercial, also write
`providers.ollama_base_url` as
`existing_providers.get("ollama_base_url") or DEFAULT_OLLAMA_URL` — the
prefill-style read (not the bare constant) so a hand-edited custom URL
(LAN Ollama host) survives re-runs, and the last prompted URL survives
an Ollama→commercial provider switch. `GET /api/routing`'s Ollama ping
then probes the host, and the local tier lights up once host Ollama is
*reachable from the container* — which, in addition to the Linux
`--add-host` mapping, requires Ollama to listen beyond its default
`127.0.0.1` bind (`OLLAMA_HOST=0.0.0.0`); the README troubleshooting
gains that caveat for all platforms. No new prompts; the Ollama path
(which prompts for the URL) is unchanged. Null-robustness rider: the
`existing_providers` read uses `or {}` / `or DEFAULT_OLLAMA_URL` forms
so a hand-edited bare `providers:` or explicit null URL cannot crash a
run or emit an invalid config.

**Behavior change to an existing guarantee:** B24's
`test_switch_away_from_ollama_drops_ollama_config` asserted
`ollama_base_url` absent after an Ollama→commercial switch. Under B25
that value is deliberately KEPT (it is the local tier's pointer and the
last known Ollama location); `ollama_model` remains dropped — the
generated local-tier entries keep `DEFAULT_LOCAL_MODEL`. The test is
updated accordingly.

**Known cost:** on hosts that drop (rather than refuse) packets to
11434, `GET /api/routing`'s Ollama ping now waits its bounded 3-second
timeout instead of failing instantly on loopback — accepted; the ping
runs concurrently with the other provider checks.

**Out of scope:** carrying the user's previously chosen Ollama *model*
into the commercial local tier (the table keeps `llama3.1`); any probe
or prompt on the commercial path; UI changes; B21's hardening items.

**Verification:** wizard tests — commercial first run writes the
default URL; re-run preserves a hand-edited URL; Ollama→commercial
switch preserves the prompted URL; the updated switch test; all
mutation-verified (drop the new line → tests fail). Full suite zero
warnings. E2e expectations unchanged: the scratch container cannot
reach host Ollama (its default `127.0.0.1` bind refuses non-local
connections even when it runs), so local stays unavailable; the URL's
presence is asserted in the generated config instead.

**Release framing:** ships with B24 in `v0.2.0` — "LLM tiers work out
of the box, and the local tier finds host Ollama once it is reachable
from the container (`OLLAMA_HOST` beyond 127.0.0.1; Linux additionally
`--add-host`)."

**Process note:** deliberately a single PR (spec + plan + code,
`Closes #84.`) given the one-line production change; squash-merge
material.
