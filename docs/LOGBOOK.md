# Development log book

Session summaries with commit pointers, written by the coding assistant as work
lands. Newest entries at the bottom; each entry names the commits it covers.
Commit messages record the *what*; this file keeps the *why*, the verification
evidence, and the observations that didn't fit a commit message.

---

## 2026-07-03 — Initial build: editor, rule engine, terminology, LLM checking
Commits: `a775dab`…`9beda95`

Fabulous Writing scaffolded end to end: FastAPI backend with a Vale-style YAML
rule engine (existence, substitution, occurrence, repetition), SQLite-backed
terminology domains/terms, and pluggable LLM providers (local Ollama, Claude
API). React/CodeMirror frontend with continuous checking (rules ~1s after
typing pauses, LLM on longer pause), category-grouped findings sidebar,
click-to-highlight, one-click suggestions. Key design decision: the LLM must
quote each problem verbatim; quotes are re-anchored deterministically (exact →
whitespace-tolerant → fuzzy) and unanchorable findings are discarded — the
deterministic gate over non-deterministic output. Findings survive edits via a
CodeMirror StateField; stale LLM results are discarded when the text changed.
Notable fix found in E2E: the UI displayed the first installed Ollama model but
sent null, so the backend fell back to an uninstalled default — fixed on both
sides.

## 2026-07-03 — On-demand LLM suggestions and sentence rewrites
Commits: `72483a3`…`3dc2820`

Style-class findings had no ready-made fix, so a "Suggest fix" button asks the
LLM for drop-in replacements on demand (cached per finding, single-flight), and
"Rewrite sentence" — available on all findings — rewrites the whole containing
sentence, with splitting allowed. Rewrites are never applied by stale offsets:
the fetched original text is re-located in the current document and must
overlap the finding. Increased the Ollama timeout to 300s after a silent
ReadTimeout with an empty error message; all LLM errors now fall back to the
exception type name.

## 2026-07-04 — Ollama model research notes
Commit: `617131f`

Web research on smaller/faster local models for suggestion/rewrite tasks,
recorded in `docs/notes/2026-07-04-ollama-model-research.md`. Recommendation:
gemma4:26b-mlx (MoE, 3.8B active) as best quality/speed trade-off; 2B-class
models ruled out for German language adherence. Parked idea: per-task model
config (`providers.suggestion_model`).

## 2026-07-04 — spaCy NLP layer, M1 (EN/DE)
Commits: `48e8a82`…`c0119a5`

Design spec + implementation of the NLP core: lazy, thread-safe `NlpRegistry`
(one spaCy pipeline per language, NER excluded), two new rule types in the same
YAML formalism — `token_pattern` (Matcher) and `dependency` (DependencyMatcher)
with load-time pattern validation against a blank vocab — spaCy-backed sentence
splitting with a CJK-aware regex fallback, and graceful degradation: missing
model → NLP rules skipped and reported in `skipped_rules`, regex rules
unaffected. The EN passive-voice regex was replaced by a dependency rule; its
old false positives ("was tired") became regression tests. Python pinned to
3.13 (spaCy had no cp314 wheels). Verified live: EN first check 0.13s including
model load, ~4ms steady state.

## 2026-07-04 — MIT license
Commit: `62f1ac0`

MIT LICENSE at the root, license fields in backend/frontend manifests, README
section.

## 2026-07-04 — Seven languages, M2
Commits: `c5d3657`…`7cd6a0e`

Language enum expanded to en/de/fr/es/it/ja/zh across backend, LLM prompts, and
frontend. New `GET /api/languages` reports per-language NLP availability
without loading models (installed-package check) and drives the header/
terminology selectors with a "basic checks only" hint. CJK terminology matching
switched from meaningless `\b` regexes to spaCy PhraseMatcher over tokens, with
substring fallback. `occurrence` rules gained `count: tokens` (doc-dependent,
skip-reported like NLP rules). Starter rules for the five new languages.
Real-world hitch handled: GiNZA 5.2 is spaCy-3.8-compatible but its pipeline
config is rejected by newer confection (`split_mode: None`); the registry
transparently retries with the documented default mode C. GiNZA's actual lemmas
(する, できる) differed from the Sudachi normalized forms planned on paper —
patterns use the verified ones. Verified live incl. Japanese demo text with
exact offsets and a browser pass over all seven languages.

## 2026-07-04 — FR/ES/IT models installed; illustrative rule cookbook
Commits: `c81088d`, `7421786`

All seven languages now have full NLP checking locally (FR/ES/IT models also
became dev dependencies, killing the "uv sync drops them" caveat). Twenty new
rules act as a pattern cookbook: REGEX (EN a/an), TAG+POS+OP (split
infinitive), token-level DEP (expletive openers), MORPH (DE würde-Stil, ES voz
pasiva), dependency via `aux:pass` (FR/IT passive), lemma sets (ES dequeísmo),
optional tokens (ZH 进行+了?+noun), comma-count occurrences (DE/JA/ZH), and
substitutions with one-click fixes. Probing caught three would-be bugs before
they shipped: the ES model doesn't emit `aux:pass`, the ZH model has no lemmas,
and ZH sentence segmentation splits artificial comma lists.

## 2026-07-04 — Rule catalog README
Commit: `87da09a`

`backend/rules/README.md` catalogs all 49 rules per language with links, check
types (NLP-backed marked), what each flags, and a "Demonstrates" column — the
cookbook index. All links and completeness verified programmatically.

## 2026-07-04 — Demo texts with an Example button
Commit: `bedac7c`

Deliberately flawed demo texts per language live in `backend/demos/` and are
served via `GET /api/languages/{code}/demo`; parametrized golden tests assert
each text triggers its language's marquee rules. The header's Example button
fills the editor for the selected language, re-running all checks. Each text
plants LLM bait (misspellings like "recieve"/"Standart", a free-vs-subscription
contradiction, hyperbole); live check with gemma4:e4b returned 9 LLM findings
on the EN text on top of 18 rule findings. Observation: small local models read
past the factual contradiction; larger models catch it as correctness.

## 2026-07-04 — Live rule catalog API + Rules tab
Commit: `dd42179`

`GET /api/rules` gained `?language=`, a `requires_nlp` flag, and type-specific
`detail`; entries serialize via a `RuleInfo` model whose (language, rule_id)
identity is the anchor for future enable/disable, checking profiles, and custom
rules. New Rules tab between Editor and Terminology shows the selected
language's catalog live: category groups, type/NLP/severity badges, human-
readable match summaries, expandable spaCy patterns, and load errors.

## 2026-07-04 — Seeded terminology; demo texts trigger terminology findings
Commit: `eaf46a3`

Fresh installations seed a "Product docs" domain with 2–3 style-guide terms per
language (sign in←login, Anwendung←App, 用户←使用者, the 登录/登陆 homophone
trap, …) — only when no domains exist, opt-out via `seed_terminology: false`.
Demo texts each contain one forbidden variant, enforced by golden tests; the
Example button auto-selects the first domain so terminology participates in the
demo. Also cleaned a stale e2e domain out of the dev DB.

## 2026-07-04 — Suggestion vetting M1: deterministic gate on LLM fixes
Commits: `19bfc53`…`dcaf68c` (+ cleanup `771dbbf`)

Trigger: claude-sonnet-5 suggested archaic Konjunktiv forms („empföhle") for a
würde-Stil finding. LLM findings already passed a deterministic gate
(anchoring); now fixes do too: (1) sanity filters, (2) a spell gate against
pyspellchecker frequency dictionaries with every document word whitelisted
(protects names and German compounds), (3) a rule-engine re-check that splices
the candidate in and rejects fixes that don't decrease the triggering rule's
findings or that introduce new ones. Prompts additionally tell the model the
rule message "is not a transformation recipe". All-rejected responses return
`rejected: n` and the UI says "No reliable suggestion — n candidates failed
local checks." Verified live in both directions: garbage rejected (3/3), good
rewrites pass untouched. Kill switch: `vet_suggestions: false`.

## 2026-07-04 — Suggestion vetting M2: morphology-aware spelling
Commits: `fa580f4`…`dd6c2c9`

Hunspell dictionaries (downloaded on demand from wooorm/dictionaries — own
licenses, gitignored) parsed by spylls form a union gate: frequency-unknown
words are rescued when morphologically valid (affix forms, German compounds).
Lucky break confirmed by probing: igerman98 doesn't contain empföhle/empfähle
either, so the M1 regression holds. Benchmark on the demo texts (empty
whitelist): false rejects ES 12→1, IT 6→1, FR 2→0; every planted error still
caught. The ES frequency list didn't even know "fue" — Spanish was quietly M1's
weakest link.

## 2026-07-04 — README screenshots + capture helper
Commits: `96d0d0f`, `6ce22f4`

Three 2×-scale screenshots (editor with findings + one-click fix, DE rule
catalog with expanded pattern, seeded terminology) embedded in the README,
captured live via Playwright. The capture script is committed as
`npm run screenshots` with dynamic Chromium resolution and documented
prerequisites; verified to reproduce the images byte-identically.

## 2026-07-04 — Severity filter + open card survives checks
Commit: `890f5ac`

Error/warning/suggestion counters under the Findings header double as filter
toggles; counters and filtered groups derive live from tracked findings, so
resolutions and automatic re-checks update them without resetting the filter.
Root cause of the disappearing detail card: every check issues fresh finding
ids — the findings field now re-selects the *equivalent* finding (same
category, rule, quoted text, overlapping span; nearest wins). Caveat noted:
clicking non-finding editor text still deselects by design.

## 2026-07-04 — Fetched suggestions survive checks
Commit: `8051622`

The equivalence matcher moved to a shared module with `mapEquivalentIds`
(injective old→new mapping); `setTracked` migrates the keys of all per-finding
caches (extra suggestions, rewrites, both error maps) instead of pruning them.
Verified live: fetched chips reappear instantly on the migrated finding after a
re-check. Known edge: a fetch completing mid-check writes under the dead id and
is dropped. Lesson from verification: the auto LLM check hogs Ollama's
sequential queue — suggest requests can wait minutes behind a slow full check.

## 2026-07-04 — Sticky sidebar header
Commit: `ba109b9`

The Findings title, counters, and check status stay pinned (position: sticky
inside the scrolling sidebar, own background + separator) while finding rows
scroll underneath. Screenshots refreshed to show the severity filter
(`e484c2c`) — the sticky header incidentally improved the hero shot: counters
and the scrolled-to card now fit one frame.

## 2026-07-04 — Live LLM progress: streaming tokens + animated status
Commits: `9f206a8`, `2129781`, screenshots `04ebdee`

Question answered: real progress info exists — Ollama streams a chunk per
token, the Claude API streams cumulative `output_tokens`; a percentage is
impossible (total unknown), hence a counter, like Claude Code. Providers stream
when given a progress callback (non-streaming paths untouched); the check job
emits `llm_progress` SSE events throttled to every 25 tokens. The sidebar shows
`✳ LLM checking… (12s · ↓ 340 tokens)` with a pulsing sparkle (disabled under
prefers-reduced-motion) and a per-second timer. Verified live: 0s → 16s,
76 → 1,051 tokens. Side benefit: the counter makes it obvious why the e4b
model takes a minute per full check.

## 2026-07-04 — Log book established
This file: session summaries with commit pointers now live in the repository
and are updated whenever a substantial piece of work lands.

## 2026-07-05 — CI workflows, Dependabot, build badges
Commit: `422b2f3`

Separate GitHub Actions workflows for backend and frontend, each
path-filtered to its subtree (plus its own workflow file) and triggered by
pushes to main and PRs. Backend CI gets full coverage because the spaCy
models are dev dependencies (`uv sync --locked` installs them) and the
Hunspell dictionaries install in one script call — all 185 tests ran on the
runner, zero skips, in 45s. Frontend CI runs lint (oxlint, previously not
part of the routine), vitest, and the type-checked build. Dependabot covers
uv, npm, and the workflow actions weekly with grouped PRs per ecosystem;
it validated itself immediately by opening five PRs on push (uvicorn, two
node deps, and newer majors of setup-uv/checkout/setup-node — the workflows
deliberately pin known-good majors and let Dependabot propose bumps); the
setup-uv bump landed on main minutes later (`d3ca9d7`).
README carries the two status badges for main. Verified live: both
workflows green on the trigger push.

## 2026-07-05 — Terminology table: sorting, language filter, live search
Commit: `d7c7ffb`

Table headers Lang/Preferred/Do-not-use are click-to-sort with a
three-state cycle (ascending → descending → off); clicking additional
headers appends secondary criteria, so click order defines priority —
shown as numbered arrows (▲¹ ▲²). A language select narrows the table to
one language and a search field filters across all text fields (language,
preferred, forbidden variants, definition) immediately on each keystroke;
both compose with sorting. The pure logic (toggleSort/sortTerms/
filterTerms) lives in `termTable.ts` — 16 vitest cases, case-insensitive
localeCompare, stable and non-mutating so "off" restores server order.
The add-term row stays visible even when a filter matches nothing (with a
"no terms match" hint). Verified live against the seeded 19-term domain:
sort cycle, ▲¹/▲² multi-sort, de-filter → 3 rows, "app"+de → Anwendung,
"login" → sign in, search+sort combined.
