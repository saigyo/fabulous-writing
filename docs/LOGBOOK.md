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

## 2026-07-05 — UI localized into all seven languages
Commit: `0da09fa`

Homemade typed i18n instead of react-i18next: each locale is a TypeScript
object implementing a shared `Messages` interface (~75 keys), and every
parameterized message is a *function*, which handles what template DSLs
fight with — German plural forms, French gendered "Aucune erreur / Aucun
avertissement", Japanese counters (エラー 3件), per-locale number
formatting (1,200 / 1.200 / １２００…), and CJK word order in rule
summaries. TypeScript enforces catalog completeness at compile time; a
runtime test double-checks key parity. Display language = persisted
`uiLocale` ?? browser locale (primary-subtag match over
navigator.languages, English fallback); a compact 🌐 selector sits at the
right end of the header. Sentences with embedded `<code>` (the rules
hint) go through an `interpolate()` placeholder-splitter so translations
control the word order around the nodes. Non-React code (suggest
handlers) uses `currentMessages()`. Deliberate boundaries: rule messages
from rule files, language names, and the English welcome document are
content, not chrome — untranslated. Verified live with Playwright
contexts: de-DE browser → German UI (2 Fehler | 8 Warnungen |
10 Vorschläge), switch to ja → instant 検出結果, reload keeps ja despite
the de-DE browser, French rules hint interpolates correctly, da-DK falls
back to English. 91 frontend tests green.

## 2026-07-05 — Header redesign: stacked labels, fixed 50px height
Commit: `b4fe7d9`

Localization made the header overflow (Spanish didn't fit even at
1280px). Markus's idea, implemented: selector labels sit *above* their
selects in small uppercase type, so each control costs only its select's
width — and the header height stays exactly 50px (min-height pin,
slimmer padding). Probing per locale × width found a second bug the
screenshots had hinted at: CJK button labels wrap between characters, so
编辑器 became a 56px column and silently grew the header to 66px —
white-space: nowrap on all header buttons. Selects cap at
min(10.5rem, 12vw) so a long Ollama model name can't blow up the layout
(the dropdown still shows full values). Two graceful tiers below that:
<1200px tightens type/gaps, <1080px drops the wordmark. Result, measured
headless: every locale fits at 1024px with zero overflow and constant
50px height; the practical floor is ~960px (Spanish). README screenshots
refreshed — the hero now shows the stacked header plus live token
counter. Follow-up `204faf5`: label left edges aligned with the text
*inside* the selects (label padding = select text inset, negative margin
keeps the select in place) — verified with pixel guide lines at 4× scale.

## 2026-07-05 — Header rearranged: locale by wordmark, Example into editor
Commit: `7e8be3f`

Usability review by Markus: the 🌐 locale selector next to the Check
button read as the *check*-language selector (the real one being far
left), and auto belonged beside Check. Three alternatives were mocked up
(locale by the wordmark / divider-isolated at far right / Example
demoted to the editor pane); Markus picked the third, the cleanest cut:
app-level chrome (wordmark, icon-only 🌐, view tabs) lives on the left,
check settings and the ☑ auto + Check action pair on the right — and
Example leaves the header entirely, becoming a localized ghost button
floating over the editor's top-right corner, discoverable exactly where
it acts. The icon-only switcher overlays a transparent select on the
globe so a click opens the native dropdown (aria-label + title keep it
accessible). Known trade-off, accepted in review: the example loader is
no longer reachable from the Rules/Terminology views. Verified live:
switcher works from its new spot, demo text loads via the ghost button
(11 findings), header still 50px with zero overflow down to 1024px in
Spanish. Message key `example` renamed to `loadExample` across all seven
catalogs; README screenshots refreshed.

## 2026-07-05 — OpenAI, Mistral, and AWS Bedrock providers
Commit: `cfef3e4`

Three new LLM providers behind the existing protocol; the frontend needed
zero changes because it renders whatever `/api/providers` returns. OpenAI
and Mistral are a single httpx-based `OpenAICompatProvider` (same
chat-completions protocol) — no new SDKs; SSE streaming with
chunk-counted progress, corrected by the final `usage` chunk where the
server sends one (kept opt-in per provider since Mistral's tolerance for
`stream_options` was unverified — chunk counting is the shared floor).
Bedrock rides boto3's Converse API, one request shape across model
families; boto3 is sync, so generation runs in a worker thread and
progress crosses back via `call_soon_threadsafe`. Keys stay env-only
(OPENAI_API_KEY / MISTRAL_API_KEY / AWS chain). `/api/providers` now
gathers five entries concurrently (~190ms with live Ollama+network
checks); model discovery per provider: `/models` for the compat pair
(OpenAI's list filtered of embeddings/whisper/dall-e/…), foundation
models + inference profiles for Bedrock, falling back to configured
`bedrock_models` without list permissions. Verified against real AWS with
the `bedrock` profile: credentials resolve, discovery correctly denied
(IAM), and `us.anthropic.claude-haiku-4-5` streamed a live response
through the thread bridge. Field notes from probing: profile ids are
region-family-bound (`eu.` ids are invalid in us-east-1, so the config
default is `us.` with a comment), and Bedrock's
`claude-3-5-sonnet-20240620` now returns "reached end of life" — static
model lists rot, which justifies the discovery-with-fallback design.
193 backend tests.

## 2026-07-05 — README restructure
Commit: `cceebdd`

Reordered the README along the reader's journey instead of its growth
history: first a user-facing tour ("What it does" — editor, checking
phases, rule catalog, terminology, languages) with each screenshot
captioned in its own section, then "Setup and running" (quick start,
provider table, configuration, optional spaCy models and Hunspell
dictionaries), and only then "Development" (repo structure, tests/CI,
rule authoring, terminology internals, API, contributing). Content
survived nearly verbatim; what moved was implementation detail that had
accreted into the intro — the Hunspell install instructions, GiNZA
version caveats, and the vetting benchmark now live in the setup and
developer sections. Cross-references use GitHub heading anchors
(quick-start, writing-rules, the spaCy-models section).

## 2026-07-05 — Terminology case sensitivity
Commits: `9b67051`, `138233d`, `2d82eea`, `45c391a` (spec/plan: `a7887c3`)

The `case_sensitive` flag on terms now means "casing matters" in full:
forbidden variants keep matching exact-case, and wrong casing of the
*preferred* term is flagged too, with the correct form as the one-click
fix ("github" → "GitHub"). Previously the preferred term was never
checked, and it couldn't be emulated with variants — a case-insensitive
"github" variant would flag the correct "GitHub" as well. A
sentence-start heuristic (text start, sentence punctuation + whitespace,
newline + markdown markers) permits conventional capitalization of
lowercase terms ("Sign in to…" passes, mid-sentence "Sign In" doesn't);
casing findings overlapping a variant finding are dropped (variants
win). All three matching paths covered: regex, CJK PhraseMatcher (a
LOWER-attr pass catches Latin terms embedded in ja/zh text; pure CJK is
case-free so lowercasing is identity), and the substring fallback.
UI: the cryptic wrap-prone checkbox in the add row became a match-case
"Aa" toggle button (aria-pressed + accent styling) sitting next to the
forbidden-variants input it governs, and existing rows show an "Aa"
badge — the flag was write-only before. No new i18n keys (the localized
tooltip serves both), no API/DB changes. Verified live: API check
flagged github/GITHUB/mid-sentence Sign In and allowed sentence-start
"Sign in"; headless browser confirmed toggle state, badge, and one-line
layout at 900px. 205 backend tests, 91 frontend tests.

## 2026-07-05 — Sidebar reveals the selected finding
Commit: `8951161`

Markus noticed that clicking flagged text in the editor expands the
finding in the sidebar but doesn't scroll it into view when it sits
below the fold. Fixing that surfaced two sibling holes with the same
root cause (selection state and row visibility were independent): a
collapsed category or an active severity filter could hide the selected
row entirely. The Sidebar now reacts to a *new* selection (guarded by a
ref against re-triggering on re-renders) by clearing a hiding severity
filter and un-collapsing the finding's category, and the row itself
scrolls into view via `scrollIntoView({block: 'nearest', behavior:
'smooth'})` on selection — 'nearest' keeps sidebar-originated clicks
from jumping. Verified headlessly by driving the real editor: clicking
the last finding's text scrolled its row into view, and both the
collapsed-category and severity-filter variants recovered too (the
first probe clicked mid-line and deselected — CodeMirror decorations
split text nodes, so the click must hit the decorated span).

## 2026-07-05 — Model recommendations integrated into docs
Commit: `58a0d45`

Markus researched per-language model recommendations (API and Ollama)
in a separate session; the resulting document was checked against the
implementation, polished, and added as `docs/model-recommendations.md`,
linked from the README's LLM-providers section. Corrections from the
implementation check: the app's providers are ollama/claude/openai/
mistral/bedrock (Google/DeepSeek/Qwen/OpenRouter are not built in, but
reachable by repointing the configurable `openai_base_url`/
`mistral_base_url` slots — the slot determines the env key variable);
API keys stay environment-only, so the sketch's `api_key: env:…` lines
were dropped; `claude-sonnet-4-6` corrected to the real `claude-sonnet-5`
(the app's default); Bedrock with `bedrock_region: eu-central-1` named
as the existing EU-residency path for Claude. The language-routed
routing YAML is explicitly framed as a design sketch (not read by the
app), noting that `OpenAICompatProvider` already covers every
`openai_compatible` entry. Cross-linked with the earlier Ollama latency
research note (2026-07-04).

## 2026-07-05 — Sidebar header: count badge no longer wraps
Commit: `f0408ab`

When the check-status label in the sidebar header grows long (e.g.
"LLM-Prüfung… (13s · ↓ 276 Tokens)"), it wraps to a second line —
acceptable — but it also squeezed the heading, pushing the findings
count badge onto its own line below "Ergebnisse". The header h2 now
has `flex-shrink: 0; white-space: nowrap` (plus a small header gap),
so only the status label wraps and the badge stays beside the heading.
Verified with Playwright by injecting the long wrapped label and
measuring that the badge stays on the heading's line.

## 2026-07-05 — Sidebar header: wrapped status label vs. severity chips
Commit: `9ca9c5c`

Follow-up to `f0408ab`: with the badge fixed in place, a wrapping
check-status label now overlapped the severity chips, because the gap
before the chips came from the h2's own bottom margin — a two-line
status label is taller than the h2 and spilled into that margin. The
bottom spacing moved from the h2 to the `.sidebar-header` row (so it
sits below the row's tallest child), the status label is right-aligned
per Markus' suggestion, and `.severity-filter` lost its -0.3rem top
margin for a little more vertical air. Playwright-verified: wrapped
label right-aligned with a 12px gap above the chips; settled state
unchanged. Note: Vite's file watcher missed the CSS edit and served a
stale transform until the file was touched — worth remembering when a
verified CSS change seems to have no effect.

## 2026-07-05 — Source filter chips: rule-based vs. LLM findings
Commit: `03e67ed`

New second chips row in the sidebar below the severity chips, counting
findings by source group: "rule-based" (rule engine + terminology —
both deterministic) vs. "LLM". Each chip toggles a filter independent
of the severity filter; the two combine, so "rule-based errors" or
"LLM suggestions" are each one click. Chips render in neutral grey
(`var(--text-dim)`) until Markus picks dedicated colors. New
`findings/source.ts` mirrors `severity.ts` (TDD, 6 tests); the
severity-specific empty-state message became a generic `noFilterMatch`
across all seven locales (dropping the now-unused `sevNone` tables in
fr/es/it); reveal-on-select clears whichever filters hide the clicked
finding. 98 frontend tests green, build clean, Playwright-verified
live: chip geometry/color, exclusive toggling within the row,
combined severity+source filtering (20 findings → 2 rule-based
errors), rule+LLM counts summing to the total, and the empty-state
message for "0 LLM".

## 2026-07-05 — Check API: domain_ids, rule_config, llm_instructions (Task 7)
Commit: `d21fab3`

The check API is now profile-agnostic-but-capable: `CheckRequest`
replaces `domain_id` with `domain_ids` (terminology findings are the
union across selected domains, deduped with `drop_overlapping` so two
domains forbidding the same variant on the same span yield one finding
— first selected domain wins), and gains `rule_config` (None = all
rules) and `llm_instructions` passthroughs to the rule engine and
LLMChecker respectively. `_run_llm` threads `instructions` into
`checker.check(...)`. The per-language demo endpoint
(`GET /api/languages/{code}/demo`) is gone — profiles carry example
texts now — though the demo `.txt` files stay as the seed source and
`test_demo_texts.py` keeps them honest. README's curl list now points
at `GET /api/profiles?language=en` instead.

TDD throughout: union, dedup, rule_config (strengthened after review —
"The cat cat sat." ensures a non-style grammar finding survives, so the
`all()` can't pass vacuously), and a `RecordingProvider` capturing the
system prompt to prove instructions reach the LLM, synchronized via the
existing SSE `_read_sse_events` pattern. Full backend suite: 235
passed. Known follow-up: `frontend/src/api/client.ts` still calls the
removed demo endpoint and needs to switch to profile example texts.

## 2026-07-05 — Profile state, dirty helpers, and check request fields (Task 9)
Commit: `58a12e3`

Frontend counterpart to Task 7's API change: new `profiles/profile.ts`
with pure helpers — `applyProfileToHeader` (profile → header selector
values, falling back to the current provider when the profile records
none), `isProfileDirty` (set-based domain comparison so order never
matters; a null profile provider means "no preference recorded" and is
never dirty), `effectiveRuleConfig` (profile → RuleConfig payload), and
`activeProfile` (shared profileId lookup, added on review to head off
three upcoming duplications). The zustand store swaps
`domainId: number | null` for `domainIds: number[]`, gains `profiles`,
`profileId`, and persisted `lastProfileByLanguage`, plus `setProfiles`
and `selectProfile(profile, apply)` where apply=true copies the
profile's values into the header. `runCheck` now sends `domain_ids`,
`rule_config`, and `llm_instructions`; suggestion/rewrite requests
carry `llm_instructions` too (single shared request builder, one edit).
App.tsx got only the mechanical rename (single-select domain dropdown
mapped onto the array; example-button domain defaulting) — its
getDemoText build error stays for Task 11.

TDD for the helpers (8 tests). Review round added a mutation-verified
test: deleting the `a.size !== b.size` guard in `isProfileDirty`
passed all original tests, so a "header has extra domains" case was
added and confirmed to kill exactly that mutant before restoring the
guard. 106 frontend tests green; `tsc -b` shows only the two known
App.tsx errors reserved for Task 11. Old persisted `domainId` localStorage
key is silently dropped (accepted one-time loss).

## 2026-07-05 — Profiles management view (Task 12)
Commit: `eb0ee2f`

New `profiles/ProfilesView.tsx` behind a fourth `Profiles` tab
(`ActiveView` gains `'profiles'`): a create bar plus one card per
profile (domain multi-select, LLM/model selects, instructions and
example-text areas), all fields saving on blur/change via the existing
client functions (`createProfile`/`updateProfile`/`deleteProfile`/
`resetProfile`). The Standard card shows a reset (↺) button instead of
delete (✕); deleting the active profile falls back to Standard (or the
first remaining profile).

Stale-props risk: each card keeps local draft state for the three text
fields so typing doesn't round-trip the store on every keystroke, but
that draft needs to reflect server-driven changes — chiefly Reset —
that don't originate from the card's own onBlur. Fixed with a
composite `key={profile.id}:${profile.name}:${profile.llm_instructions}
:${profile.example_text}` on `ProfileCard` from the parent: unrelated
prop changes (e.g. another card's edit, domain list refresh) don't
touch this key, typing doesn't touch it either (the prop only updates
after blur, by which point local state already matches), and a Reset
does change it, forcing a remount with fresh drafts. Verified live via
a scratchpad Playwright script: renamed a freshly created profile,
blurred, and confirmed the input kept "Blog Posts" after the
save-and-refresh round trip rather than reverting.

`.profiles-view` follows the `.rules-view` scroll-container pattern
(`flex: 1; overflow-y: auto`) so the view scrolls correctly inside the
100vh flex app root — the plan's CSS block omitted `flex: 1`, which
would have made a tall card grid extend past the viewport.

107 vitest tests green, `tsc -b --noEmit` clean, `npm run build` clean.
Live check: 3 EN cards render (Standard/Marketing/Technical
Documentation) plus header PROFILE select showing the same set;
created "Blog", it appeared and became selected; renamed to
"Blog Posts" (survived blur); deleted it back to 3 cards; Standard
confirmed to show ↺ not ✕. Screenshots in the scratchpad
(`profiles-01-initial.png` … `profiles-04-after-delete.png`).

## 2026-07-05 — Rules page becomes the profile rule-selection editor (Task 13)
Commit: `a0bd0b3`

`rules/RulesView.tsx` now doubles as the editor for the selected
profile's rule selection instead of a read-only catalog dump. Added
pure helper `isRuleActive(profile, category, ruleId)` in
`profiles/profile.ts`, mirroring the backend's XOR: a rule is active
iff `(category not in categories_off) XOR (ruleId in
rule_exceptions)`. TDD'd first — appended the failing test to
`profile.test.ts` (9th test), confirmed the `TypeError: isRuleActive
is not a function` failure, then implemented.

RulesView now reads `profiles`/`profileId` from the store, shows a
`m.editingRulesFor(name, language)` banner under the header when a
profile is selected, adds a checkbox to each category `<h3>` that
toggles `categories_off` for the whole category *and clears that
category's exceptions* (fresh start on re-toggle, per spec), and a
per-rule switch on each `RuleCard` that flips `rule_exceptions`
membership. Both write through immediately via `updateProfile` (full
payload, all profile fields carried over unchanged except the one
being patched) and update the store via `setProfiles`. Inactive rule
cards get `.rule-inactive` (`opacity: 0.45`); no profile selected ⇒
checkboxes disabled and all rules render as active (matches the
"Standard fallback" UX elsewhere).

108 vitest tests green (added 1), `tsc -b --noEmit` clean, `npm run
build` clean. Live check via scratchpad Playwright script against the
running dev servers: opened Rules with EN/Standard, saw the banner
"Editing rules for: Standard (English)"; unchecked the `style`
category → all 5 style cards dimmed and `GET /api/profiles?language=en`
showed `categories_off: ["style"]`; re-checked one style rule's own
switch → that card undimmed alone and `rule_exceptions:
["style.exclamations"]` appeared (XOR: off + exception = active);
re-checked the category → exceptions cleared and all style cards
active again. Confirmed the Standard profile ended back at
`categories_off: []`, `rule_exceptions: []` (its original clean
state). One snag during verification: Playwright's `.check()`/
`.uncheck()` assert the DOM `checked` attribute flips synchronously
after the click, but here it only flips once the PUT round-trip
resolves and the store re-renders — switched to plain `.click()` with
an explicit wait. Screenshot of the dimmed state in the scratchpad
(`task13-02-style-off-dimmed.png`).

## 2026-07-05 — Checking profiles: feature complete
Commits: `909d18c`..`bbcfe58` (26 commits, spec `6f97627`+amendments, plan `96c0a95`+syncs)

Language-specific checking profiles landed end to end, executed via
subagent-driven development (fresh implementer per plan task, two-stage
spec + quality review each, fix loops on findings). A profile bundles
rule selection (category toggles XOR per-rule exceptions), terminology
domains (multi-select, union at check time with cross-domain overlap
dedup), LLM provider/model, extra LLM instructions (injected after the
JSON contract in check/suggest/rewrite prompts), and a per-profile
example text. Standard profiles are seeded per language (editable, not
deletable, resettable); Marketing and Technical Documentation examples
are seeded for EN/DE/JA behind `seed_example_profiles` with a marker
table so deletions stick. The check API stays profile-agnostic
(`domain_ids`, `rule_config`, `llm_instructions`); the frontend resolves
profile + ephemeral header overrides (computed dirty ✱ with save/reset).
The rules page is the profile's rule editor (write-through); the new
Profiles view manages the rest. The per-language demo endpoint is gone —
the Load-example button reads the selected profile.

Review loops caught and fixed: a seeding crash loop on name collisions,
missing cross-domain finding dedup, a vacuous rule_config test, an
isProfileDirty superset-mutation test gap, a React-StrictMode bug that
silently overwrote persisted header settings on every dev reload, and
error-handling gaps in both editing views. Backend 235 / frontend 108
tests green; full Playwright e2e pass (8/8) with state restoration.

Known follow-ups (non-blocking): profile/selector changes don't trigger
an auto re-check (pre-existing behavior — click Check or type);
DomainMultiSelect a11y polish (aria-expanded, Esc); possible future
migration of the store into slices.

## 2026-07-05 — Domain multi-select menu restyled
Commit: `ed1212c`

The dropdown's rows inherited the header label styling (uppercase,
letter-spacing, stacked column) through the CSS cascade — the checkbox
floated above ALL-CAPS text. The menu rows now explicitly reset to a
classic list-box: checkbox left, normal-case text, accent hover/checked
highlight. Verified live (computed styles + screenshot). Search and
select-all from the reference design were deliberately skipped — domain
lists here have two or three entries.

## 2026-07-05 — Profile dirty actions: SVG icons, stable alignment
Commit: `cf02ca2`

The 💾/↩ emoji buttons rendered as flex children of the header's column
label, wrapping under the profile select and knocking it out of line
with the other selectors. Replaced with stroke-outline SVG icons
(feather-style floppy and rotate-ccw) absolutely positioned to the
LEFT of the select — out of the flow, so the selector stays put when
the dirty state appears. One subtlety: the select carries a negative
margin-left from the header label-alignment trick, so the icon anchor
mirrors that offset (right: calc(100% + 0.3rem + 4px)). Playwright-
verified: select position identical clean vs. dirty (dx=0), icons left
of and centered on the select, reset restores the clean state.

## 2026-07-05 — Domain toggle: header label alignment
Commit: `1ddcdfa`

The multi-select toggle (a button, not a select) missed the header's
label-alignment trick — selects are pulled left by 0.3rem + 4px so the
label text aligns with the control's inner text. The toggle now gets
the same negative margin, padding matching the select inset, and
min-width: calc(100% + offset) with align-self: stretch on its wrapper,
so it is always at least as wide as its label regardless of locale.
Playwright-verified in en-US and de-DE: label offsets identical to the
language select (0.0px delta), toggle wider than the label in both.

## 2026-07-05 — Header selector gaps equalized
Commit: `4ca4e42`

Follow-up to the domain-toggle alignment: its min-width of
calc(100% + offset) double-counted the label-alignment offset, because
cross-axis stretch already widens the wrapper by the negative margin —
the toggle overflowed 8.8px into the gap before the LLM selector.
min-width: 100% is exactly right. Playwright-measured: all four
selector gaps equal at 8.8px (spread 0.0) with a wide domain selection
in de-DE.

## 2026-07-05 — Profiles view: stacked cards, two-column interior
Commit: `e4bb327`

Per Markus's design: the profile boxes leave the auto-fill grid for a
strict one-per-row stack. Inside each card a two-column grid: the name
field spans only the first column (delete/reset beside it); domains and
the example text fill the left column, the LLM provider/model/
instructions the right — starting below the title row. Textareas grew
to 0.95rem with more rows; below 900px the card collapses to one
column. Playwright-verified geometry (stacking, half-width title,
right column below the title line, columns side by side) + screenshot.

## 2026-07-05 — Profile cards: bold labels, aligned text boxes
Commit: `f489818`

The two per-column stacks couldn't guarantee the example/instructions
boxes start at the same height, so the card interior became one shared
2x2 grid (domain | LLM+model, example | instructions) — grid rows make
the alignment structural rather than tuned. Labels are bold with an
explicit weight reset on selects/textareas (they inherit); the domain
listbox stretches to fill row one. Playwright-measured: label and
textarea-top y-deltas 0.0, weights 600/400.

## 2026-07-05 — README: profiles section + refreshed screenshots
Commit: `97b3e4d`

All four README screenshots regenerated via the extended capture script
(now also persists the Product docs domain into the EN Standard profile
before the editor shot — the Example button no longer auto-selects a
domain — and captures the new Profiles tab). Added a "Checking
profiles" section between the checking-phases and rule-catalog
sections; updated the editor blurb (example text comes from the
profile), the rules section (profile rule editing), the config
highlights, and config.example.yaml (seed_example_profiles).

## 2026-07-06 — Developer documentation: architecture docs
Commit: `72bc000`

Two comprehensive developer documents written from a fresh read of the
code: docs/backend-architecture.md (module map, the Finding contract,
app assembly via create_app/app.state, the check-job flow with SSE
replay semantics, the YAML rule engine incl. RuleConfig XOR, the NLP
registry, terminology matching incl. CJK paths, the LLM provider layer
with the anchoring and vetting gates, checking profiles, API surface,
testing conventions) and docs/frontend-architecture.md (store slices
and cache migration, the CodeMirror findingsField as source of truth
for spans, the debounce/staleness/supersede checking lifecycle, finding
equivalence across checks, profile apply/dirty semantics, i18n, API
client, testing). The README Development section gained an
"Architecture" subsection introducing the shared Finding contract and
linking both documents.

## 2026-07-06 — Design: language-routed model configuration

Commit: `9c90b4d`

Turned the design sketch in `docs/model-recommendations.md` § 5 into an
approved spec (`docs/superpowers/specs/2026-07-06-language-routed-models-design.md`),
settled with Markus:

- **Phase 1 — provider registry:** `extra_providers` map in `config.yaml`
  for OpenAI-compatible vendors (DeepSeek, Qwen, OpenRouter, …); env key
  derived from the entry name; factory + discovery generalized; no UI change.
- **Phase 2 — quality tiers:** routing table (language × tier → provider,
  model) with code-shipped defaults from the recommendations doc; new
  `GET /api/routing` with per-tier availability; profiles and the header
  become tier-first, with a pinned provider+model escape hatch in a
  collapsed "Advanced" panel (pin wins over tier; both-null keeps today's
  "no opinion" semantics, so existing rows behave identically).
- Explicitly no silent degradation (unavailable tiers greyed out with
  reason; LLM check skipped with an explanatory status), no OpenRouter
  failover (out of scope), fixed four-tier set.
- Check API unchanged; the frontend resolves tier → concrete pair
  (new `checking/routing.ts`), consistent with client-side profile
  resolution.

## 2026-07-06 — Provider registry (phase 1 of language-routed models)

Commits: `62b3597` (config), `84d7055` (factory), `d4708bb` (providers API),
`b9ac3f4` + `7528e1c` (docs)

Implemented phase 1 of
`docs/superpowers/specs/2026-07-06-language-routed-models-design.md` via
subagent-driven development (per-task spec + quality reviews, final
whole-feature review): `providers.extra_providers` in `config.yaml` defines
additional OpenAI-compatible providers (DeepSeek, Qwen, OpenRouter, …) as
first-class named entries — validated names (env key `<NAME>_API_KEY` derived
from the entry name, no collisions with built-ins, fail-fast on load),
constructed generically by the provider factory, listed by
`GET /api/providers` with live model discovery. Zero frontend changes: extras
render generically in the header dropdown. E2E-verified both availability
paths (no key → unavailable with default model; key + live OpenAI-compat
endpoint → available with discovered models). Docs updated:
`config.example.yaml`, `backend-architecture.md`, README provider table,
`model-recommendations.md` § 1/§ 3 (the "repoint a slot" workaround is
replaced by the registry). Full suite: 245 passed.

## 2026-07-06 — Fix: duplicate model ids from OpenAI-compat discovery

Commit: `6af041b`

Mistral's `/v1/models` returns some ids twice (72 entries, 61 unique);
`OpenAICompatProvider.list_models` passed them through, and the duplicate
React keys broke the model dropdown's reconciliation — stale `<option>`s
accumulated across provider switches, so selecting `claude` showed piles of
mistral models. Fixed at the source: `list_models` now dedupes (set before
sort) for openai/mistral/extras alike, with a regression test. E2E-verified
against the live Mistral API (61 unique). Also relevant for operators:
Gemini discovery prefixes ids with `models/`, so a configured
`default_model` must use that prefix or it is replaced by the first
discovered model; `exclude_model_fragments` tames Gemini/Qwen non-chat
listings.

## 2026-07-06 — Claude live model discovery

Commit: `c610cd4`

The `claude` provider entry was the only one without live discovery (static
`[anthropic_model]`). `ClaudeProvider.list_models()` now queries Anthropic
`GET /v1/models` via the SDK (newest-first order preserved so the best
default surfaces on top), and `_claude_entry` discovers with the shared 5 s
timeout, falling back to the configured model on failure — same semantics as
openai/mistral/extras. TDD (stub-client unit test + two API tests with
patched discovery); E2E-verified against the live API: 10 models, configured
default `claude-sonnet-5` preserved. Docs updated (backend-architecture
discovery paragraph, README provider table, model-recommendations § 1).

## 2026-07-06 — Fix: LLM findings swallowed by overlap dedup

Commit: `1dc3d99`

Markus reported no LLM findings on the example texts for any
language/model. Stage-by-stage instrumentation showed the pipeline healthy
(FR/claude: 9 candidates parsed, 9/9 anchored, 9/9 vetted) — then
`drop_overlapping` discarded all of them: any overlap with any fast finding
counted as a duplicate, so whole-sentence rule spans (`clarity.phrase-longue`
etc.) shadowed every LLM finding inside them, and the example texts are
rule-saturated by design. Replaced with `drop_duplicates`: drop only on
overlap with a same-category finding, or when both flag substantially the
same span (overlap ≥ half the combined extent) in any category. Terminology
cross-domain dedup (same category throughout) is unaffected. Before/after on
the Standard example texts — FR/claude: 0 → 3, EN/claude: 2 → 5,
EN/ollama(mistral-nemo): 2 → 3 LLM findings; genuine duplicates (e.g. LLM
re-flagging `Malgré que`, clichés, weasel words) still dropped.

## 2026-07-06 — Fix: click-to-select shadowed by whole-sentence findings

Commit: `7259158`

Clicking any short finding inside a sentence flagged by
`clarity.phrase-longue` always jumped the sidebar to the sentence-length
card: the editor click handler took the *first* array hit containing the
position. New pure helper `findingIdAt` in `editor/findings.ts` (TDD, 4
tests): the smallest finding under the click wins, and when the currently
selected finding is part of the stack the next-larger one is chosen — so
repeated clicks cycle outward and the sentence finding remains reachable.
Frontend suite 112 passed; lint/build clean. Architecture doc updated.

## 2026-07-06 — Quality tiers with language routing (phase 2)

Commits: `4388010` (routing config), `81d682e`+`b38d0cf` (routing API),
`cdbb543` (profile llm_tier), `9ec568a` (store), `8ed8ac8` (i18n),
`745f43c` (resolution), `d629979`+`f025219` (header), `0bb383e`
(profile semantics/UI + PUT tightening), `19aa8f4`+`fef19d9` (docs)

Implemented phase 2 of
`docs/superpowers/specs/2026-07-06-language-routed-models-design.md` via
subagent-driven development (per-task spec + quality reviews with four fix
loops, final whole-feature review): a `routing` config section with
code-shipped per-language defaults (per-language override, fail-fast
validation), `GET /api/routing` with bounded per-tier availability checks
and human-readable reasons, a nullable `llm_tier` profile column
(pin > tier > no-opinion; idempotent migration; existing rows unchanged;
fresh seeds tier=balanced), client-side `resolveModel` (the check API is
untouched), the tier-first header `LlmSelector` and ProfilesView tier chips
with collapsed Advanced pin panels, mode-aware apply/dirty/save semantics,
seven-locale i18n, a persisted-store v0→v1 migration keeping pre-tier users
pinned, and `ProfileUpdate.llm_tier` made required once all senders carried
it. No silent degradation: unavailable tiers grey out with the reason and
an unresolvable tier skips the LLM check explicitly while fast checkers
still run. E2E-verified: fresh-DB seeding/validation, the live routing
table fully available with real keys, and a DE check through the
tier-resolved mistral pair (10 rule + 4 LLM findings). Suites: backend 265,
frontend 127, build clean.

## 2026-07-06 — Fix: header Advanced panel closes on outside click

Commit: `80eb747`

Markus found the header's Advanced popover (LlmSelector) stayed open on
outside clicks — native `<details>` behavior that reads as broken for an
overlay. Converted to the controlled popover pattern DomainMultiSelect
already uses (useState + outside-mousedown listener + toggle button with
aria-expanded); the ProfilesView card keeps its inline `<details>` (static
layout). Frontend suite 127 passed, lint/build clean.

## 2026-07-07 — Fix: Advanced panel shows the resolved pair, one-click pin

Commit: `bce40da`

Markus found that in tier mode the header's Advanced panel displayed the
stale last-pinned provider/model instead of the tier's resolved pair, with
no way to pin the displayed values (native selects fire no change event
for re-choosing the shown option). The panel now displays what a check
would actually use; changing the model pins the displayed provider (new
atomic `setPinned` store action, tested); a localized "Pin this model"
button adopts the displayed pair and closes the panel; a resolved model
missing from the discovered model list is prepended to keep the controlled
select honest. Frontend 128 tests, lint/build clean; architecture doc
updated.
