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
updated. Follow-up `d0f95c9`: the pin action became a stylized
icon-button (matching the save/reset icons) with "Pin this model" as hover
text.

## 2026-07-07 — Fix: profile cards mirror the header's resolved-model display

Commit: `cafd9c4`

Markus spotted that the header showed the tier's resolved model but the
ProfilesView cards did not (and their Advanced panels showed blank selects
for tier-mode profiles). New pure helper `resolveProfileModel` in
`profiles/profile.ts` (pin > tier > no-opinion, resolved per the profile's
language; 4 tests): the card now shows the same resolved caption as the
header, its Advanced panel displays the resolved pair, model changes pin
the displayed provider, and the pin icon-button adopts the displayed pair
into the profile (card writes are immediate profile saves, unlike the
header's ephemeral override — intentional). Frontend 132 tests, lint/build
clean; architecture doc updated.

## 2026-07-07 — Header layout: aligned LLM selector, gear-icon advanced toggle

Commit: `8b30928`

Markus flagged the untidy header: the LLM selector's caption and Advanced
label made it taller than its siblings, and the pin icon floated
misaligned. Now the LLM select sits on the same row as the other selectors
with a gear icon-button to its right (hover "Advanced model selection",
localized in seven locales) opening the advanced popover; the resolved
caption is absolutely positioned below the select — the header reserves
bottom padding for it, so the selector never moves when it appears; pin
and selects are bottom-aligned in both advanced panels. Verified with
Playwright screenshots against a production preview build (dev-server
transforms were stale again — its file watcher is unreliable). Frontend
132 tests, lint/build clean. Follow-up `29b17a6`: pin/gear icons flex-centered
on their neighboring selects with the popover's 8px gap (screenshot-verified). Follow-up `1701c87`: the caption padding had decentered
branding/tabs/Check — back to symmetric padding with min-height 68px, so
everything centers and the caption still fits (screenshot-verified).

## 2026-07-07 — README screenshots refreshed for the tier-first UI

Commit: `cfdf9ac`

Regenerated all four README screenshots against the restarted dev servers:
the header now shows the tier selector with gear icon and resolved caption;
the profiles shot captures both modes (Standard on the Balanced tier,
Marketing pinned with the pinned-note); the editor shot shows LLM findings
alongside rule findings post-dedup-fix.

## 2026-07-07 — Header controls aligned on one center line

Commit: `16da706`

Close inspection of the screenshots showed the header controls drifting off
a shared center line: the labeled selector columns were centered as blocks
(dropping the selects ~6px below the unlabeled auto checkbox and Check
button), and the domain toggle — a styled `<button>` — came out shorter
than the native selects, more so in Chromium than WebKit. All header
controls now share an explicit `--control-h: 26px` and the row is
bottom-aligned, so equal bottoms give identical center lines regardless of
engine; the gear/pin icon boxes and the Check button adopt the same height.
The whole block is lifted 6px so the control row sits optically on the
tab-button line and the resolved-model caption clears the header divider.
Verified numerically via Playwright bounding boxes (all controls at
center y=33.3 vs tabs 33.5) and visually against a production preview;
README screenshots regenerated.

## 2026-07-07 — Rule examples backfilled and made mandatory

Commit: `9660c81`

Backfilled `examples:` (bad/good sentences) into the 48 rule files that
lacked them — `en/style/weasel-words.yml` already had one, so all 49 rules
now self-document with trigger/clean sentence pairs. Ran
`tests/test_rule_examples.py` against the full catalog (99 tests: 49 rules
x bad/good + the catalog-loads check) — every proven sentence from
`test_starter_rules.py` worked first try, no adjustments needed. Then
flipped `RuleSpec.examples` from `RuleExamples | None = None` to a required
field in `app/checkers/rules/loader.py` (also moved the field declaration
up next to `pack`, before the pack-slug validator, per review), so a rule
file without an `examples:` block now fails to load with a reported
`RuleError` instead of loading silently. `test_rule_examples.py` no longer
filters `RULES` by `spec.examples is not None` — it's just
`ENGINE.list_rules()` now. Inline rule YAML snippets in
`test_rule_engine.py` (and the `_engine_with_two_rules` helper, which wrote
files directly rather than through `write_rule`) get an auto-appended stub
`examples:` block when they don't already have one, so unit tests for the
engine mechanics don't need to invent sentences that don't relate to what
they're testing. Added `test_rule_without_examples_is_reported` as a
regression test for the new required-field behavior. Full suite: 368
passed.

## 2026-07-07 — Rules API exposes pack, examples, and discovered packs

Commit: `40d6497`

Task 4 of the use-case-packs plan. `RuleInfo` (`backend/app/api/rules.py`) gained
`pack: str | None` and `examples: dict[str, list[str]]`, populated in `_rule_info`
from `rule.spec.pack` and `rule.spec.examples.model_dump()`. `_payload` now also
returns a top-level `packs` key: `sorted({rule.spec.pack for rule in rules if
rule.spec.pack})`, computed from the same (possibly language-filtered) rule list
used for `rules`, so `GET /api/rules?language=en` and the unfiltered endpoint each
report only the packs actually present in their result. All shipped rules still
have `pack=None`, so `packs` is `[]` today — EN pack rules land in a later task.
Added `test_rules_carry_pack_examples_and_packs_index` to
`backend/tests/test_rules_api.py` (TDD: confirmed it failed with `KeyError: 'pack'`
before the implementation). Full suite: 369 passed.

## 2026-07-07 — Profiles carry packs_on

Commit: `df0729b`

Task 5 of the use-case-packs plan. Added a `packs_on TEXT NOT NULL DEFAULT '[]'`
column to `backend/app/services/profiles.py` (`_SCHEMA`, `_migrate` guard mirroring
`llm_tier`, `Profile.packs_on`, `create_profile`/`update_profile` plumbing), exposed
it on `ProfileCreate`/`ProfileUpdate` in `backend/app/api/profiles.py`, and added it
to `standard_defaults` in `backend/app/services/seed_profiles.py`. The check API
already passed `RuleConfig.packs_on` through untouched, so
`test_check_accepts_packs_on` only pins that contract. Full suite: 373 passed.

## 2026-07-07 — Seed Marketing/TechDoc profiles with packs_on, add Blog for EN/DE

Commit: `30ae4df`

Task 6 of the use-case-packs plan. `seed_profiles.py` now sets `packs_on=
["marketing"]` / `["techdocs"]` on the seeded Marketing / Technical Documentation
examples, and seeds a new "Blog" example (`packs_on=["blog"]`) for EN/DE only
(`BLOG_LANGUAGES`), backed by new `demos/en-blog.txt` / `de-blog.txt`. Appended
one extra sentence each to the EN/DE marketing and techdoc demo files so the
still-unwritten pack rules will have something to trigger on later — packs with
no rules yet are a no-op, so this ships safely ahead of the rules themselves.
Adapted `test_create_update_delete_profile` in `test_profiles_api.py`, which
previously created a profile named "Blog" for EN and now collides with the
seeded example; renamed it to "Notes". Full suite: 374 passed.

## 2026-07-07 — 18 new English rules + greedy LONGEST matching

Commit: `3c9140a`

Task 7 of the use-case-packs plan. Added a TDD regression
(`test_quantified_pattern_yields_longest_match_only` in
`backend/tests/test_nlp_rules.py`) proving a `{4,}`-quantified `token_pattern`
produced three overlapping spans instead of one; fixed by registering the
spaCy `Matcher` with `greedy="LONGEST"` in
`backend/app/checkers/rules/checks/token_pattern.py`. Added 18 EN rule files:
4 grammar + 3 style + 2 clarity general rules, plus 9 pack rules (4
`marketing`, 4 `techdocs`, 1 `blog`) under `backend/rules/en/`. All 58
parametrized `test_rule_examples.py` cases (29 EN rules x bad/good) passed
without needing any pattern/example adjustment. Strengthened
`test_rules_carry_pack_examples_and_packs_index` in `test_rules_api.py` to
assert `payload["packs"] == ["blog", "marketing", "techdocs"]` now that real
pack rules exist. Full suite: 411 passed.

## 2026-07-07 — Task 7 review fixes: could-of lookahead guard, noun-string limitation note

Commit: `39c8c85`

Review follow-up to Task 7. `grammar/could-of.yml` swap keys now carry
`(?!\s+(?:course|necessity))` so "could of course" / "must of necessity" no
longer trigger the ERROR-level autofix (lookahead verified to survive the
engine's `\b(?:KEY)\b` wrapping; pinned by two new good examples). For
`clarity/noun-string.yml`, a dependency-informed candidate (`{DEP: compound,
OP: "{3,}"}` + head noun) was probed against the engine and did not remove the
"The user profile stores preferences." false positive — the "stores" NOUN
mistag cascades into the parse as `compound` — so the POS-based pattern stays,
with the limitation documented in the file comment and good examples left
honest. Full suite: 411 passed.

## 2026-07-07 — 17 new German rules (general + marketing/techdocs/blog packs)

Commit: `9676c34`

Task 8 of the use-case-packs plan. Added 17 DE rule files under
`backend/rules/de/`: 5 grammar (`das-dass`, `seit-seid`, `wie-als`,
`deppenapostroph`, `beliebte-fehler`), 5 general style/clarity
(`funktionsverbgefuege`, `amtsdeutsch`, `doppelmoppel`, `genitivkette`,
`verbklammer`), plus 7 pack rules (2 `marketing`: `superlativ-inflation`,
`hype-anglizismen`; 4 `techdocs`: `man-konstruktion`,
`futur-in-anleitungen`, `bitte-in-anleitungen`, `e-mail-schreibung`; 1
`blog`: `floskel-einstieg`). All 50 parametrized `test_rule_examples.py`
cases (25 DE rules x bad/good) passed with no pattern or example
adjustments needed — parses were checked against `de_core_news_sm` for the
flagged trouble spots (das-dass's `hoffe`→`hoffen` lemma on the
ungrammatical sentence, `wie-als`'s `Degree=Cmp` on `schneller`,
`funktionsverbgefuege`'s `erfolgt`→`erfolgen`, `verbklammer`'s 13-token gap
to the `PTKVZ` "vor", `futur-in-anleitungen`'s `Mood=Ind|Tense=Pres` on
`wird`) and all matched as designed. Two false-positive guards ("Wir
führen die Änderungen jetzt durch." and "Die Zeitung erschien gestern.")
produced no findings through the real engine with all packs on. Full
suite: 445 passed (the plan's "~461" was an estimate of the pre-existing
count, which was actually 395, not 411).

## 2026-07-07 — Task 8 review fixes: seit-seid/deppenapostroph precision, das-dass leak

Commit: `cc44ee8`

Review follow-up to Task 8. `grammar/seit-seid.yml` dropped the always-wrong
`wir` alternation and added a capitalized-noun lookahead guard against the
possessive reading („Seit ihr Vertrag läuft …?" now clean, verified through
the engine). `grammar/deppenapostroph.yml` now requires a capitalized stem
and stoplists common verb contractions (geht's/war's/Gibt's clean; Anna's
and Peter's still fire; McDonald's remains a documented residual FP).
`grammar/das-dass.yml` stoplists indefinite pronouns („das eine/alles") that
POS=PRON let leak. Comment-only notes added to `clarity/genitivkette.yml`
(deliberate strictness) and `style/funktionsverbgefuege.yml` (literal
„treffen" FP); `style/e-mail-schreibung.yml` message switched from Duzen to
Siezen. All 12 review probes matched expectations; catalog 50 passed, full
suite 445 passed.

## 2026-07-07 — Deppenapostroph stoplist extended (reviewer follow-up)

Commit: `443e9f2`

Added Stimmt/Klappt/Passt and the conjunctions Wenn/Ob/Sobald/Solang/Weil to
the `grammar/deppenapostroph.yml` contraction stoplist; „Stimmt's?",
„Klappt's morgen?" and „Wenn's regnet …" verified clean through the engine
while „Anna's Laden" still fires. Catalog 50 passed, full suite 445 passed.

## 2026-07-07 — Task 9: frontend carries packs_on (types, activation, save payloads)

Commit: `ac6768a`

TDD per the implementation plan. `types.ts`: `RuleInfo` gained `pack: string
| null` and `examples: { bad, good }`; `Profile` gained `packs_on: string[]`.
`api/client.ts`: `RuleConfig` gained `packs_on`, `RulesResponse` gained
`packs: string[]`. `profiles/profile.ts`: `effectiveRuleConfig` now forwards
`packs_on`; `isRuleActive` takes a mandatory 4th `pack: string | null` arg and
gates the XOR on `packs_on.includes(pack)` when the rule belongs to a pack
(mirrors the backend's `(pack in packs_on AND category on) XOR exception`).
Every PUT/POST sender updated to carry `packs_on`: `ProfilesView.tsx`
(`create()` and `save()`), `header/ProfileSelector.tsx` (`saveOverrides()`),
`rules/RulesView.tsx` (`saveRuleSelection()`, plus its `isRuleActive` call
site now passes `rule.pack`). `rules/catalog.test.ts`'s `RuleInfo` test
fixture (not named in the plan, but caught by `tsc`) got `pack: null` and
`examples: { bad: [], good: [] }` defaults. Added the plan's
`pack-aware rule activation` describe block to `profile.test.ts` plus
`packs_on` fixture defaults in the existing `profile()`/`base` helpers.
`npx vitest run`: 17 files / 137 tests green. `npm run build` (the real type
gate) clean; `npm run lint` only pre-existing `react-hooks/exhaustive-deps`
warnings, unrelated to this change.

## 2026-07-07 — Task 10: rules view — pack sections + example rendering

Commit: `92711ec`

TDD per the implementation plan. `rules/catalog.ts` gained `splitByPack`
(and exported `PackSection`), separating general (non-packed) rules —
grouped by category as before — from one sorted section per pack, packs
themselves sorted alphabetically; `rules/catalog.test.ts` got the plan's
`splitByPack` describe block, adapted to the file's existing
`rule(overrides: Partial<RuleInfo>)` fixture builder rather than the
positional `rule(id, category, pack)` sketched in the plan. `types.ts`:
extracted the inline examples shape into exported `RuleExamples { bad:
string[]; good: string[] }`, used by `RuleInfo.examples`. `i18n/messages.ts`
gained `rulePacks`, `packName`, `packToggleTitle`, `exampleFlagged`,
`exampleNotFlagged`; all 7 locales implement them (title-casing fallback for
unknown pack slugs, curated names for marketing/techdocs/blog).
`rules/RulesView.tsx`: renders `splitByPack(response.rules).general`
exactly like the old category loop, then a `.rules-pack` section per pack
with a heading checkbox writing `packs_on` (via new `togglePack`, which
clears that pack's rules from `rule_exceptions` on toggle — same
fresh-start semantics as `toggleCategory`); `RuleCard` now renders
`rule.examples.bad`/`good` as "✗ Flags …" / "✓ Doesn't flag …" lines under
the existing detail summary. `App.css` gained `.rule-examples`,
`.rule-example(.bad/.good)`, `.rule-example-mark`, `.rule-badge.pack`
matching the existing `--text-dim`/`--accent-soft` idioms. `npx vitest run`:
17 files / 138 tests green (i18n completeness test included). `npm run
build` clean; `npm run lint` only the same pre-existing
`react-hooks/exhaustive-deps` warnings. Visual verification skipped per
plan (a later task captures screenshots).

## 2026-07-07 — Task 11: profile card — rule-pack chips

Commit: `55f873d`

`profiles/ProfilesView.tsx`: the top-level `ProfilesView` now fetches
`getRules(language).packs` into a `packs` state (re-fetched on language
change, empty on error) and passes it down as a new `packs` prop on
`ProfileCard`. `ProfileCard` renders a `.profile-card-packs` chip row —
reusing the `.tier-options`/`.tier-option` idiom from the LLM tier
selector but with `aria-pressed` (independent multi-select toggles, not a
radio group) — right after the LLM `<details>` advanced block, still
inside `.profile-card-llm` so it stays in the right-hand grid column and
doesn't disturb the row-1/row-2 alignment the surrounding grid comments
call out. Each chip toggles its slug in/out of `profile.packs_on` via the
existing `onSave` patch flow. The row only renders when `packs.length >
0`, so languages with no discovered packs show nothing extra.
`App.css`: added `.profile-card-packs` (margin-top 0.5rem) and
`.profile-card-packs .field-label` (block, margin-bottom 4px) next to the
existing profile-card rules. `npx vitest run`: 17 files / 138 tests green
(unchanged — no new test surface, this is pure UI wiring reusing already-
tested `packs_on`/`getRules` plumbing). `npm run build` clean.

## 2026-07-07 — Task 12: rule packs + self-documenting examples, feature capstone

Commits: `b6ac354`..`75d4c3e` (31 commits)

Feature complete: use-case **rule packs** and mandatory **self-documenting rule
examples**, across 11 implementation tasks plus this documentation pass.

**What shipped.** Rules can carry an optional `pack: <slug>` marking them as
use-case rules — off by default, active only for a profile with that pack
enabled. Activation for a pack rule is `(category on AND pack in packs_on) XOR
exception`; for a general rule (no pack) it stays the original `(category on)
XOR exception`. Pack slugs are free-form and discovered from whatever `pack:`
values appear in the rule files — `GET /api/rules?language=…` returns the
sorted set as a top-level `packs` key, so a new pack needs a YAML file, not a
code change. `RuleConfig.packs_on` is threaded through the engine, the
`profiles` table (its own JSON column, migrated in-place via `PRAGMA
table_info` + `ALTER TABLE`), the profiles API, and the frontend (types,
`isRuleActive`, every profile-saving `PUT`/`POST` sender). A consequential
semantic change: `RuleEngine.check(..., config=None)` now means *general rules
only* (an empty `packs_on` excludes every pack rule), not *every rule* as
before packs existed.

Every rule file now **requires** an `examples: {bad, good}` block — enforced
by the loader (a rule without one fails to load) and exercised by a
catalog-wide parametrized test (`backend/tests/test_rule_examples.py`): each
`bad` sentence must trigger the rule's own id, each `good` sentence must not.
The same examples render on the rule's card in the Rules view, so the catalog
documents and tests itself from one source of truth. `RuleInfo.examples` is
the typed `RuleExamples` pydantic model in the API, not a loose dict.

The catalog grew by 35 rules: 18 English (`negative-phrasing`, `noun-string`,
`based-off`, `could-of`, `dangling-participle`, `fewer-less`, `condescension`,
`double-negative`, `future-tense-instruction`, `hedging`, `hype-words`,
`latin-abbreviations`, `shouting-caps`, `third-person-user`,
`throat-clearing`, `unverifiable-claims`, `very-unique`, `weak-verb-adverb`)
and 17 German (`genitivkette`, `verbklammer`, `beliebte-fehler`, `das-dass`,
`deppenapostroph`, `seit-seid`, `wie-als`, `amtsdeutsch`,
`bitte-in-anleitungen`, `doppelmoppel`, `e-mail-schreibung`,
`floskel-einstieg`, `funktionsverbgefuege`, `futur-in-anleitungen`,
`hype-anglizismen`, `man-konstruktion`, `superlativ-inflation`), split across
three packs (`marketing`, `techdocs`, `blog`) plus general grammar/style/clarity
rules. `noun-string`'s `{POS: NOUN, OP: "{4,}"}` needed the `token_pattern`
`Matcher` switched to `greedy="LONGEST"` so a long noun run reports one
longest match instead of every overlapping sub-match — every other
`token_pattern` rule benefits from the same fix.

Seeding: the Marketing/Technical Documentation example profiles (EN/DE/JA)
now enable their matching packs (`packs_on: ["marketing"]` /
`["techdocs"]`), and EN/DE additionally seed a new **Blog** example profile
with the `blog` pack enabled.

Frontend: `rules/catalog.ts`'s `splitByPack` partitions the catalog into
general (category-grouped, as before) and per-pack sections; `RulesView.tsx`
renders a `.rules-pack` section per pack with its own toggle, and every
`RuleCard` renders its `bad`/`good` examples as "✗ Flags …" / "✓ Doesn't
flag …" lines. `ProfilesView.tsx`'s profile cards grew a row of pack chips,
discovered per language via `GET /api/rules?language=…` and labeled through
`packName()` (a curated map for known slugs, title-case fallback for new
ones).

**Documentation pass (this task).** `backend/rules/README.md`: intro now
explains the mandatory-examples/self-testing catalog and the free-form
`pack:` mechanism; EN/DE tables gained a Pack column and all 35 new rows with
filled-in *Demonstrates* entries; a new "Known heuristic limitations" section
records the deliberate false-positive/negative trade-offs in `noun-string`,
`dangling-participle`, `double-negative`, `weak-verb-adverb`,
`future-tense-instruction`, `shouting-caps`, `deppenapostroph`, and
`das-dass`. `docs/backend-architecture.md` and `docs/frontend-architecture.md`
were largely already up to date from the per-task notes; this pass
consolidated them and fixed one imprecision (the `_engine_with_two_rules` test
fixture appends its examples stub by hand, not via `write_rule()`), and made
explicit the `config=None` semantic change, the `packs_on` migration
mechanism, and the profile-card pack-chip/`packName` details that hadn't been
written down yet. The main `README.md` gained rule packs and self-documenting
examples to the Checking-profiles and Rule-catalog sections, updated the
Writing-rules walkthrough (mandatory `examples:`, optional `pack:`, `greedy`
LONGEST, six check types instead of the stale four-in-the-intro framing), and
noted the new Blog seed profile. `docs/superpowers/specs/2026-07-07-rule-packs-en-de-design.md`
gained an "Implementation notes (phase 1)" section recording ten deviations
from the original sketch (das-dass's verb-lemma gate, seit-seid's
question-form narrowing, could-of's course/necessity lookahead,
deppenapostroph's capitalized-stem + contraction stoplist, packs_on as its
own column, the flat packs index, the config=None semantic flip, greedy
LONGEST, superlativ-inflation's raw-stem approach, and the typed
`RuleExamples` API model).

**Verification.** `cd backend && uv run pytest -q` → 445 passed.
`cd frontend && npx vitest run` → 138 passed; `npm run build` clean; `npm run
lint` clean (only pre-existing `react-hooks/exhaustive-deps` warnings,
unrelated to this feature).

## 2026-07-07 — Task 1: CJK edge-aware boundary helper (`bounded_pattern`)

**Commits:** `eb3c8cd`, `f32b4e6`

**Why.** The upcoming Japanese rules were blocked: both the existence
(`tokens:`) and substitution checks wrap keys in `\b…\b`, and `\b` never
fires between two word characters — kana/kanji count as `\w` in Python's
`re`, so `\b一番最初\b` silently never matched mid-sentence
(「彼は一番最初に確認した。」 produced no finding).

**What.** Added `bounded_pattern(fragment)` to
`backend/app/checkers/rules/text.py`: it drops the `\b` on any side whose
edge character is CJK (Han incl. ext. A + compatibility, Hiragana,
Katakana, CJK punctuation, full-width forms via `_CJK_CHAR`) and keeps it
on Latin-edged sides, so existing EN/DE rules compile to byte-for-byte
identical patterns. Existence and substitution checks now use the helper;
`raw:` entries stay unwrapped as before. Review follow-up (`f32b4e6`):
empty tokens/swap keys previously passed load validation and then crashed
`bounded_pattern` with IndexError at check time, wiping all findings for
the document — the loader's `check_required_fields` now rejects empty
existence tokens/raw entries and empty substitution keys as RuleErrors at
load time. The metachar-edge limitation (a key like `(行か|読ま)せる`
literally starts with `(`, keeps its `\b`, and won't match after kana —
use `raw:` for such patterns) is documented in the helper's docstring
rather than special-cased.

**Verification.** TDD both rounds: 3 new CJK tests failed before the
helper (empty findings / ImportError), 2 empty-key tests failed before
the loader fix; all pass after. Full suite `cd backend && uv run pytest
tests/ -q` → 451 passed. `grep -rn '\\b(?:' app/` confirms no hardcoded
boundary wrapping remains outside the helper.


## 2026-07-07 — Task 8: Japanese rules + consistency check type, feature capstone

**Commits:** `eb3c8cd..62d06df` (12 commits on `main`)

**Spec/plan.** `docs/superpowers/specs/2026-07-07-ja-rules-consistency-design.md`,
`docs/superpowers/plans/2026-07-07-ja-rules-consistency.md`.

**What shipped, end to end.**

- **CJK edge-aware boundaries** (`bounded_pattern`, `backend/app/checkers/rules/text.py`):
  its own entry already exists above (Task 1: CJK edge-aware boundary helper,
  commits `eb3c8cd`/`f32b4e6`) — this task built the 17 new JA rules and the
  `consistency` check type on top of it rather than duplicating the writeup.
- **New `consistency` check type** (7th type, `backend/app/checkers/rules/checks/consistency.py`,
  schema in `loader.py`'s `VariantSpec`): document-scoped sentence classification
  into named `variants:` (pattern variants via spaCy `Matcher`, tried in
  declaration order as priority/tie-break, plus one optional `default: true`
  variant claiming predicate-ending sentences no pattern matched); `anchor: end`
  requires a match to end within 3 tokens of the sentence end after stripping
  trailing punctuation/symbols/particles; every sentence in a non-majority
  variant is flagged. Tests in `backend/tests/test_consistency.py`.
- **17 new JA rules** under `backend/rules/ja/`: grammar (`ranuki`, `ranuki-split`,
  `sa-ire`, `nijuu-keigo`, `nijuu-keigo-honorific`), clarity (`no-renzoku`),
  style (`wo-okonau`, `juufuku-hyougen`, `redundant-phrases`, `desu-masu` —
  the `consistency` reference example), and three use-case packs: `marketing`
  (`hype-words`, `unverifiable-claims`, `exclamation-inflation`), `techdocs`
  (`i-nuki`, `hedging`, `casual-contractions`), `blog` (`kotatsu-cliche`).
  JA now has 22 rules total (5 pre-existing + 17 new) across all three packs.
- **JA Blog profile** seeded (`BLOG_LANGUAGES` extended, JA seed instructions,
  `backend/demos/ja-blog.txt`); pack-triggering fodder appended to the
  `ja-marketing`/`ja-technical-documentation` demo texts.

**Review-driven precision fixes** (one line each, all already committed during
the feature, this task only documents them):
- `nijuu-keigo` is a curated `raw` list, not a token pattern, because the bare
  なる+られる shape also matches 「社長になられました」, a legitimate single 尊敬語.
- `juufuku-hyougen`'s まだ未定 key is narrowed to require a で/だ continuation so
  it can never fire inside 未定義 ("undefined").
- `unverifiable-claims` uses `raw` with negative lookaheads (`世界一(?![周流律時])`
  etc.) to dodge 世界一周/初期費用-style compound collisions.
- `desu-masu` matches surface forms, not lemmas, so plain-register 「くださった」
  (honorific past) doesn't get misread as the request-form ください polite marker.

**Documentation this task.** `backend/rules/README.md`: added a "Check type:
consistency" cookbook section (variant semantics, `anchor: end` window, default
variant, minority flagging, multi-sentence `bad:` requirement, standalone-quote
limitation) using `ja/style/desu-masu.yml` as the worked example; extended the
intro with the CJK-edge-awareness/metachar-limitation note (pointing at
`sa-ire.yml`'s alternation as the case that needs `raw:`); grew the JA catalog
table from 5 to 22 rows with a new Pack column; added a JA "Known heuristic
limitations" section (curated-list recall for ら抜き/さ入れ/二重敬語 and why ら抜き
needs two sibling rules, `desu-masu`'s standalone-quote register limitation,
hype/claim lists being precision-first and extendable, the まだ未定 で/だ
narrowing). `docs/backend-architecture.md`: added a `consistency` row and
paragraph to the check-type table (now seven types); verified the existing
CJK-boundary paragraph from the Task-1 review round (commits `dbe6586`,
`a0610fc`) is still accurate as written — no changes needed there. Fixed a
pre-existing typo a Task-7 reviewer flagged: `backend/demos/ja-technical-documentation.txt`
had どこかにに (double に) instead of どこかに; re-verified the demo still fires
its three techdocs rules (`style.i-nuki`, `style.hedging`,
`style.casual-contractions`) via the engine harness after the fix.

**Verification.** `cd backend && uv run pytest tests/ -q` → 503 passed.
Engine sanity: `RuleEngine(Path('rules')).errors` → `[]`; JA rule count → 22;
JA packs → `['blog', 'marketing', 'techdocs']`.

## 2026-07-07 — Task 1 (phase 3): French rules to parity with EN/DE/JA
Commit: `9cece7d`

Task 1 of a 6-task plan bringing FR/ES/IT/ZH up to the same rule-catalog depth
as EN/DE/JA. This task covers French only: 10 new rules, three pack demo
texts, fodder in the general FR demo, and a slimmer test file pinning
consistency-voting behavior.

**What shipped.**

- **10 new `rules/fr/` rules.** Grammar: `pleonasmes` (substitution swap map
  over fixed pléonasme strings — « au jour d'aujourd'hui », « voire même »,
  « comme par exemple », « puis ensuite », etc. — recall limited to those
  invariant forms since conjugated variants like « il est monté en haut »
  don't match a literal-string swap); `pallier-a` (token_pattern, bare
  `LEMMA: pallier` immediately before à/au/aux, no `POS` gate because
  `fr_core_news_sm` mistags the infinitive `ADJ` in « il faut pallier à … »
  while keeping the correct lemma — the homograph « palier », single l, has
  its own lemma and can't collide); `apres-que-subjonctif` (token_pattern,
  `MORPH: {IS_SUPERSET: [Mood=Sub]}` within an `{0,3}` wildcard of « après
  que/qu' », both apostrophe variants listed since the tokenizer keeps `qu'`
  fused either way); `tutoiement-vouvoiement` (the second `consistency`-type
  rule in the catalog, after JA's `desu-masu` — tu/te/toi/ton/ta/tes vs.
  vous/votre/vos, POS-gated to `{PRON, DET}` so the noun « ton » (tone)
  and other homographs don't misvote; informal declared first so it wins a
  tie). Style, three new packs: `marketing` (`hype-mots`,
  `affirmations-inverifiables` — framed around legal/challengeable-claim
  risk, `inflation-exclamation` via `raw: ["!{2,}"]`), `techdocs` (`hedging`,
  `langage-familier`), `blog` (`cliches-ouverture`).
- **Three FR demo texts** (`demos/fr-marketing.txt`, `fr-technical-documentation.txt`,
  `fr-blog.txt`), each engineered to trip its pack's rules plus at least one
  general grammar rule (`pallier-a` in both marketing and techdocs;
  `apres-que-subjonctif` in techdocs; `pleonasmes` in marketing and blog).
  The blog demo mixes register 2-vs-1 (two `tu` sentences, one `vous`
  sentence) so `tutoiement-vouvoiement` fires exactly once, on the minority
  `vous` sentence — verified live via the engine, not just by the catalog
  tests. Marketing and techdocs stay all-`vous`/no-`tu` so the consistency
  rule doesn't have two variants to vote and stays silent, confirmed the
  same way.
- **Fodder** appended to `demos/fr.txt`: one sentence exercising `pleonasmes`
  (three swap keys at once) and `pallier-a`; `tests/test_demo_texts.py`
  `EXPECTED[Language.FR]` grew by those two rule ids (the consistency rule
  is deliberately not added there, since a single fodder sentence can't
  produce two voting sentences).
- **`tests/test_register_consistency.py`** (new file): pins voting behavior
  the one-bad/one-good catalog example can't — minority-formal and
  minority-informal each flagged exactly once, a single vote staying silent
  (need ≥2 voting sentences), and a uniform-register document staying
  silent. Plus the two straightforward subjunctive-fires/indicative-clean
  cases for `apres-que-subjonctif`.
- **`rules/README.md`**: added a Pack column and 10 rows to the French
  catalog table, plus a "Known heuristic limitations" section mirroring the
  JA one (pléonasme literal-string recall, pallier-a's missing POS gate and
  why, the apres-que morphology window, tutoiement-vouvoiement's blindness
  to impersonal/plural vous).

No engine code touched — this was pure YAML + demos + tests, per the task's
binding constraint. `docs/backend-architecture.md` needed no changes (no new
check type; `consistency` was already documented from the JA task).

**Verification.** `cd backend && uv run pytest -q` → 529 passed (up from 503:
+16 catalog examples across 10 new rules with `bad`+`good` cases, +6 in
`test_register_consistency.py`, +2 `test_demo_texts.py`/`test_rule_examples.py`
net from the fodder and new demo assertions — exact split not individually
recomputed). Engine sanity via a live harness dump: `fr-marketing.txt` trips
`style.hype-mots`, `style.affirmations-inverifiables`,
`style.inflation-exclamation`, `grammar.pleonasmes`, `grammar.pallier-a`;
`fr-technical-documentation.txt` trips `style.hedging`,
`style.langage-familier`, `grammar.pallier-a`, `grammar.apres-que-subjonctif`
(plus incidental `style.voix-passive` hits from existing passive-voice
rule); `fr-blog.txt` trips `style.cliches-ouverture`, `grammar.pleonasmes`,
and `grammar.tutoiement-vouvoiement` exactly once on the `vous` sentence.
`grammar.tutoiement-vouvoiement` confirmed silent on `demos/fr.txt` and on
the marketing/techdocs demos.

**Review-driven precision fix** (commit `dd3179d`): the bare
`numéro 1`/`n° 1` tokens in `style.affirmations-inverifiables` over-fired on
ordinary French at warning level (addresses « au numéro 1 de la rue … »,
magazine issues, bus lines, « priorité numéro 1 »); replaced with the
qualified market-claim forms « numéro 1/n° 1 du marché » and « … mondial » —
the same qualification strategy as EN's `number one`/`#1` and JA's 業界No.1.
Added « Notre priorité numéro 1 est la sécurité. » as a good example, noted
the passé simple « pallia » recall gap in `pallier-a` (fr_core_news_sm does
not lemmatize it to « pallier » — accepted), and mirrored both in the README
limitations section. Verified all four FP probe sentences clean, the demo's
« est le numéro 1 du marché » still fires, and the full suite stays at 529
passed.

## 2026-07-07 — Task 2 (phase 3): Spanish rules to parity with EN/DE/FR/JA
Commit: `7c67242`

Task 2 of the 6-task phase-3 plan (Task 1, French, already merged). This task
covers Spanish only: 10 new rules, three pack demo texts, fodder in the
general ES demo, and ES cases appended to the shared consistency test file.

**What shipped.**

- **10 new `rules/es/` rules.** Grammar: `queismo` (substitution swap map —
  « me di cuenta que », « a pesar que », « estoy segur[oa] que », « no cabe
  duda que » — deliberately narrow so bare « seguro que », legitimate
  colloquial Spanish, never fires; complements the existing `dequeismo`,
  the opposite error). `haber-impersonal` (token_pattern, NLP: existential
  « habían muchos » is impersonal Spanish for « había muchos »; a `POS`
  gate on the following token — `DET`/`NUM`/`NOUN`, verified live against
  `es_core_news_sm` — keeps the auxiliary reading « habían comido » (next
  token `VERB`) from firing). `tuteo-ustedeo` (consistency, NLP: tú/te/tu/tus
  vs usted/ustedes register mixing, POS-gated `PRON`/`DET` variants; « su/sus »
  deliberately excluded from the formal vote as third-person-ambiguous).
  Style: `en-base-a` (RAE-recommended-form swap, « en base a » → « con base
  en » — coexists with the pre-existing `clarity.circunloquios`, which
  flags the same phrase as a circumlocution suggesting « según »; both fire
  together by design, different concerns). Packs: `marketing`
  (`palabras-hype`, `afirmaciones-inverificables` with market-claim-qualified
  digit forms so addresses/issue-numbers/« prioridad número 1 » stay clean —
  same precision decision as the FR sibling rule — and
  `inflacion-exclamacion` via `raw: ["[!¡]{2,}"]` catching both `!!` and
  `¡¡…!!`), `techdocs` (`hedging`, `coloquialismos`), `blog`
  (`cliches-apertura`).
- **Three ES demo texts** (`demos/es-marketing.txt`,
  `es-technical-documentation.txt`, `es-blog.txt`), each engineered to trip
  its pack's rules plus at least one general grammar rule (`queismo` in both
  marketing and techdocs; `haber-impersonal` in techdocs). The blog demo
  mixes register 2-vs-1 (two tú/te sentences, one usted sentence) so
  `tuteo-ustedeo` fires exactly once, on the minority usted sentence —
  verified live via the engine, not just by the catalog tests. Marketing and
  techdocs stay all-tú/no-usted so the consistency rule doesn't have two
  variants to vote and stays silent, confirmed the same way. One test-text
  gotcha found live: `es_core_news_sm` tags « Usted » as `PROPN` (not `PRON`)
  in some sentence positions (e.g. before « decide »), which silently drops
  the formal vote — worked around by picking verbs (« debe revisar »,
  « controla ») that keep « Usted » tagged `PRON`, confirmed with a live
  token dump rather than guessing.
- **Fodder** appended to `demos/es.txt`: one sentence exercising `queismo`,
  `haber-impersonal`, and `en-base-a` at once; `tests/test_demo_texts.py`
  `EXPECTED[Language.ES]` grew by those three rule ids (the consistency rule
  is deliberately not added there, since a single fodder sentence can't
  produce two voting sentences).
- **`tests/test_register_consistency.py`** (existing file from Task 1):
  appended `TestTuteoUstedeo` (minority-formal and minority-informal each
  flagged exactly once, single vote staying silent) and `TestHaberImpersonal`
  (existential plural fires, auxiliary reading stays clean) — no
  restructuring of the FR classes already there.
- **`rules/README.md`**: added a Pack column and 10 rows to the Spanish
  catalog table, plus a "Known heuristic limitations" section mirroring the
  French one (queísmo's deliberately narrow key list, haber-impersonal's
  POS gate and its verified live behavior, tuteo-ustedeo's blindness to
  ustedes-as-plural-tú and its su/sus exclusion, afirmaciones-inverificables'
  qualified digit forms, and the intentional double-coverage of « en base
  a » by two different rules).

No engine code touched — this was pure YAML + demos + tests, per the task's
binding constraint.

**Verification.** `cd backend && uv run pytest -q` → 554 passed. Engine
sanity via a live harness dump: `es-marketing.txt` trips `style.palabras-hype`,
`style.afirmaciones-inverificables`, `style.inflacion-exclamacion`,
`clarity.circunloquios`, `style.en-base-a`, `grammar.queismo`;
`es-technical-documentation.txt` trips `style.hedging`,
`style.coloquialismos`, `grammar.haber-impersonal`, `grammar.queismo`;
`es-blog.txt` trips `style.cliches-apertura` (×4) and
`grammar.tuteo-ustedeo` exactly once, on the usted sentence.
`grammar.tuteo-ustedeo` confirmed silent on `demos/es.txt` and on the
marketing/techdocs demos.

## 2026-07-07 — Task 3 (phase 3): Italian rules to parity with EN/DE/FR/ES/JA
Commit: `757a2f9`

Task 3 of the 6-task phase-3 plan (Tasks 1–2, French and Spanish, already
merged). This task covers Italian only: 10 new rules, three pack demo texts,
fodder in the general IT demo, and IT cases appended to the shared
consistency test file. `rules/it/` already held 7 pre-existing rules from an
earlier phase; this task added 10 more on top, bringing it to parity.

**What shipped.**

- **10 new `rules/it/` rules.** Grammar: `a-me-mi` (token_pattern, NLP —
  fixed 3-token `LOWER` match for pleonastic clitic doubling « a me mi
  piace »); `apostrofo-errato` (substitution — « qual'è »/« qual'era » never
  take an apostrophe, troncamento not elisione; « un pò » → « un po' »,
  elisione of « poco »; both straight `'` and typographic `’` apostrophes
  keyed since substitution matches raw text); `pleonasmi` (substitution swap
  map over fixed infinitive/3rd-person forms « entrare dentro », « uscire
  fuori », etc. — conjugated variants escape, an accepted recall limitation
  same as the FR/ES pleonasm rules); `tu-lei` (consistency, NLP: tu/ti/tuo…
  vs Lei/Le/La register mixing, informal variant POS-gated `PRON`/`DET`,
  formal variant gated on literal `TEXT: {IN: [Lei, Le, La]}` with
  `POS: {IN: [PRON, PROPN]}` — verified live against `it_core_news_sm`
  that « La ringrazio » tags La/PRON while « La casa » tags La/DET,
  correctly excluding the article; PROPN admitted per the ES precedent
  since small models occasionally mistag courtesy pronouns in mixed-register
  contexts, loss-free because of the literal TEXT gate). Packs: `marketing`
  (`parole-hype`, `affermazioni-inverificabili` with market-claim-qualified
  digit forms so addresses/issue-numbers/« priorità numero 1 » stay clean —
  same precision decision as the FR/ES sibling rules — and
  `inflazione-esclamativi` via `raw: ["!{2,}"]`), `techdocs` (`hedging`,
  `colloquialismi`), `blog` (`cliches-apertura`, with both apostrophe
  variants keyed in the « al giorno d['’]oggi » / « nell['’]era digitale »
  tokens).
- **Three IT demo texts** (`demos/it-marketing.txt`,
  `it-technical-documentation.txt`, `it-blog.txt`), each engineered to trip
  its pack's rules plus at least one general grammar rule
  (`apostrofo-errato` and `pleonasmi` in both marketing and techdocs). The
  blog demo mixes register 2-vs-1 (two tu/ti sentences, one Lei sentence) so
  `tu-lei` fires exactly once, on the minority Lei sentence — verified live
  via the engine, not just by the catalog tests. Marketing and techdocs stay
  all-informal/no-Lei so the consistency rule never gets two variants to vote
  and stays silent, confirmed the same way.
- **Fodder** appended to `demos/it.txt`: one sentence exercising `a-me-mi`,
  `apostrofo-errato`, and `pleonasmi` at once; `tests/test_demo_texts.py`
  `EXPECTED[Language.IT]` grew by those three rule ids (the consistency rule
  is deliberately not added there, since a single fodder sentence can't
  produce two voting sentences).
- **`tests/test_register_consistency.py`** (existing file from Task 1):
  appended `TestTuLei` (minority-formal and minority-informal each flagged
  exactly once, an article-only sentence pair not voting at all, and a
  single vote staying silent) — no restructuring of the FR/ES classes
  already there. All four passed against the live model on the first
  attempt; no test-text rework was needed.
- **`rules/README.md`**: added a Pack column to the pre-existing Italian
  table (the 7 legacy rows had none) and 10 new rows, plus a "Known
  heuristic limitations" section mirroring the French/Spanish ones
  (apostrofo-errato's dual-glyph keys, pleonasmi's fixed-form recall
  limitation, tu-lei's documented false-formal and enclitic blind spots,
  affermazioni-inverificabili's qualified digit forms).

No engine code touched — this was pure YAML + demos + tests, per the task's
binding constraint.

**Verification.** `cd backend && uv run pytest -q` → 578 passed. Engine
sanity via a live harness dump: `it-marketing.txt` trips `style.parole-hype`,
`style.inflazione-esclamativi`, `style.affermazioni-inverificabili`,
`grammar.apostrofo-errato`, `grammar.pleonasmi`;
`it-technical-documentation.txt` trips `style.hedging`,
`style.colloquialismi`, `grammar.apostrofo-errato`, `grammar.pleonasmi`;
`it-blog.txt` trips `style.cliches-apertura` (×3), `grammar.a-me-mi`, and
`grammar.tu-lei` exactly once, on the Lei sentence. `grammar.tu-lei`
confirmed silent on `demos/it.txt` and on the marketing/techdocs demos.

## 2026-07-07 — Task 4 (phase 3): Chinese rules to parity with EN/DE/FR/ES/IT/JA
Commit: `eb770a5`

Task 4 of the 6-task phase-3 plan (Tasks 1–3 — French, Spanish, Italian —
already merged). This task covers Chinese only: 10 new rules, three pack
demo texts, fodder in the general ZH demo, and ZH cases appended to the
shared consistency test file. `rules/zh/` already held 4 pre-existing rules
from an earlier phase; this task added 10 more on top, bringing it to
parity.

**What shipped.**

- **10 new `rules/zh/` rules.** Grammar: `de-di-de` (token_pattern, NLP —
  deliberately narrow `ADV + 的(TAG=DEV) + VERB` pattern, leaning on
  `zh_core_web_sm`'s own fine-grained tagging to distinguish adverbial 的
  (misused for 地, tag DEV) from adjectival 的 (tag DEC, never matches) —
  verified live: 慢慢的走过来了 → 慢慢/ADV 的/DEV 走/VERB fires; 美丽的花园
  → 的/DEC does not); `ni-nin` (consistency, NLP: 你/你们 vs 您 register
  mixing — plain `TEXT` matches, no POS gate, unlike the FR/ES/IT sibling
  rules which must disambiguate homographs; documented low-frequency edge
  case: 迷你 can be mis-segmented in some contexts into a standalone 你
  token, casting a spurious informal vote). Style: `dayue-zuoyou`
  (existence, `raw`
  regex catching doubled approximation « 大约/大概 … 左右 » within a
  10-char same-clause gap that excludes 。！？，；, and deliberately
  omitting bare 约 since it occurs inside 预约/合约/条约); `rongyu`
  (substitution swap map for redundant modifier+verb pairs like
  免费赠送→赠送, 涉及到→涉及). Packs: `marketing` (`xuanchuan-ci` empty
  hype words, `wufa-zhengshi` unverifiable superlatives framed around
  广告法 legal risk, `gantanhao-fanlan` via `raw: ["[！!]{2,}"]`),
  `techdocs` (`hedging` — word list plus a `可能(?!性)` lookahead so the
  legitimate noun 可能性 doesn't collide with the hedge 可能; `yuqi-ci` —
  casual sentence-final particles 啦/哦/呗/嘛 anchored to trailing
  punctuation via lookahead, with a lookbehind excluding 干嘛 and
  onomatopoeia 哗啦/呼啦), `blog` (`taoban-kaitou` boilerplate-opener
  phrase list).
- **Three ZH demo texts** (`demos/zh-marketing.txt`,
  `zh-technical-documentation.txt`, `zh-blog.txt`), each engineered to trip
  its pack's rules plus at least one general grammar/style rule. The
  techdocs demo mixes register 2-vs-1 (two 你-sentences, one 您-sentence)
  so `ni-nin` fires exactly once, on the minority 您-sentence — verified
  live via the engine, not just by the catalog tests. Marketing and blog
  stay single-register (no 你/您 mixing) so the consistency rule never
  gets two variants to vote and stays silent, confirmed the same way. The
  blog demo's original 悄悄的告诉大家 draft was swapped to 悄悄的说一句
  ahead of any live-model surprise, since 说 is unambiguously tagged VERB;
  in the event both `de-di-de` catalog examples and both blog-demo
  instances (慢慢的读, 悄悄的说) fired on the first attempt with no
  fallback needed.
- **Fodder** appended to `demos/zh.txt`: one sentence exercising
  `dayue-zuoyou` and `rongyu` at once; `tests/test_demo_texts.py`
  `EXPECTED[Language.ZH]` grew by those two rule ids (the consistency rule
  and `de-di-de` are deliberately not added there — a single fodder
  sentence can't produce two voting sentences, and the de-di-de fodder
  lives in zh-blog instead, per the task spec).
- **`tests/test_register_consistency.py`** (existing file from Task 1):
  appended `TestNiNin` (minority-formal and minority-informal each flagged
  exactly once, a 1-vs-1 tie resolving to the first-declared variant
  `informal` so 您 is flagged, and a single vote staying silent) — no
  restructuring of the FR/ES/IT classes already there. All four passed
  against the live model on the first attempt; no test-text rework was
  needed.
- **`rules/README.md`**: added a Pack column to the pre-existing Chinese
  table (the 4 legacy rows had none) and 10 new rows, plus a "Known
  heuristic limitations" section mirroring the French/Spanish/Italian ones
  (de-di-de's TAG-based precision subcase, ni-nin's simpler no-POS-gate
  design, dayue-zuoyou's bare-约 exclusion, hedging's 可能性 lookahead,
  yuqi-ci's punctuation-anchored lookbehind guards).

No engine code touched — this was pure YAML + demos + tests, per the task's
binding constraint.

**Verification.** `cd backend && uv run pytest -q` → 602 passed. Engine
sanity via a live harness dump: `zh-marketing.txt` trips `style.xuanchuan-ci`
(×4: 极致/颠覆/震撼/尖端), `style.wufa-zhengshi` (×2: 全网第一/史上最),
`style.gantanhao-fanlan` (×2), `style.rongyu` (×2: 免费赠送/提前预约),
`style.dayue-zuoyou`; `zh-technical-documentation.txt` trips `style.hedging`
(可能/大概/我觉得), `style.yuqi-ci` (啦/哦), `style.rongyu` (涉及到), and
`grammar.ni-nin` exactly once, on the 您-sentence; `zh-blog.txt` trips
`style.taoban-kaitou` (×3), `grammar.de-di-de` (×2: 慢慢的读/悄悄的说), and
`style.dayue-zuoyou`. `grammar.ni-nin` confirmed silent on `demos/zh.txt`
and on the marketing/blog demos.

## 2026-07-07 — Task 4 review fixes: 史上最/左右/可能 lookarounds, ni-nin edge-case docs
Commit: `5232db8`

Reviewer follow-up on the Chinese phase-3 rules (2 Important, 2 Minor), all
precision guards for raw-text collisions:

- **`style.wufa-zhengshi`**: 史上最 moved from `tokens` to
  `raw: ["(?<!历)史上最"]` — the bare token fired inside 历史上最… in
  ordinary factual historical prose (历史上最长的河流是尼罗河), which is
  not an advertising claim. New good example pins the fix. The marketing
  demo's 「是史上最受欢迎」 still fires (preceded by 是, not 历).
- **`style.dayue-zuoyou`**: trailing lookahead `左右(?![了着])` excludes
  the verb readings 左右了/左右着 ("influenced/sways"), which the
  approximation pattern hit after 大概 (大概是这些因素左右了结果). Residual
  bare-verb collision (左右大局) accepted and documented. The blog demo's
  「大约读两遍左右就能…」 still fires (左右 followed by 就).
- **`style.hedging`**: `可能(?!性)` widened to `(?<![不尽])可能(?!性)` —
  不可能 is an assertion and 尽可能 an intensifier, neither a hedge; 大概
  moved from `tokens` to `raw: ["大概(?![率念])"]` so 大概率 ("high
  probability", different morphology) no longer fires. Good examples added
  for both; the original bad example still fires on all three hedges.
- **Docs**: softened the "你/您 are unambiguous" claim in the README ZH
  limitations and the LOGBOOK Task 4 entry — 迷你 ("mini") can be
  mis-segmented in some contexts into a standalone 你 token
  (这款迷你相机), casting a spurious informal vote. Documented as a
  low-frequency edge case; the rule itself is unchanged.

**Verification.** `cd backend && uv run pytest -q` → 602 passed. Live
engine re-run confirmed all three pack demos unchanged in behavior:
zh-marketing still trips `wufa-zhengshi` ×2 (全网第一, 史上最) and
`dayue-zuoyou`; zh-blog still trips `dayue-zuoyou` on 「大约读两遍左右」;
zh-technical-documentation still trips `hedging` ×3 (可能/大概/我觉得) and
`ni-nin` exactly once.

## 2026-07-07 — Task 5: seed Marketing/TechDoc/Blog examples for all seven languages

`app/services/seed_profiles.py`'s `EXAMPLE_LANGUAGES` and `BLOG_LANGUAGES`
previously restricted the three example profiles (Marketing, Technical
Documentation, Blog) to EN/DE/JA even though the Phase 3 packs, rules, and
demo files for FR/ES/IT/ZH (Tasks 1-4) had already landed. Both constants
are now `set(Language)`, and `_MARKETING_INSTRUCTIONS`,
`_TECHDOC_INSTRUCTIONS`, `_BLOG_INSTRUCTIONS` gained FR/ES/IT/ZH entries
(one short audience/style-guidance sentence per language, matching the
existing EN/DE/JA tone). `example_text` for the new languages comes from
the existing `demos/{fr,es,it,zh}-{marketing,technical-documentation,blog}.txt`
files — no new demo content was needed.

TDD: extended `test_seed_pack_profiles` in `tests/test_profiles.py` with a
loop over FR/ES/IT/ZH asserting `packs_on`, non-empty `llm_instructions`,
and non-empty `example_text` for all three example profiles; confirmed it
failed with `KeyError: 'Marketing'` before the implementation change.

**Verification.** `cd backend && uv run pytest -q` → 602 passed.

## 2026-07-07 — Phase 3 complete: FR/ES/IT/ZH rule parity + consistency generalization

**Commits:** `9cece7d..a62ecb9` (13 commits on `main`)

**Spec/plan.** `docs/superpowers/specs/2026-07-07-fr-es-it-zh-rules-design.md`.

**What shipped, end to end.**

- **40 new rules**, 10 each across `rules/{fr,es,it,zh}/`: 3 general rules +
  1 address-register `consistency` rule (reusing the JA-introduced check
  type — `fr/grammar/tutoiement-vouvoiement.yml` tu/vous,
  `es/grammar/tuteo-ustedeo.yml` tú/usted, `it/grammar/tu-lei.yml` tu/Lei,
  `zh/grammar/ni-nin.yml` 你/您) + 3 marketing + 2 techdocs + 1 blog pack
  rule, per language. FR/ES/IT/ZH now sit at the same rule-catalog depth
  as EN/DE/JA, each shipping all three use-case packs.
- **12 new demo files** (`demos/{fr,es,it,zh}-{marketing,technical-documentation,blog}.txt`),
  each engineered to trip its pack's rules plus at least one general rule,
  and each pack demo's register mix verified live via the engine harness
  (blog demos mix 2-vs-1 so the new consistency rule fires exactly once on
  the minority sentence; marketing/techdocs stay single-register so it
  stays silent). Fodder sentences appended to the four standard demos
  (`demos/{fr,es,it,zh}.txt`) exercising the new general rules, with
  `tests/test_demo_texts.py` `EXPECTED` grown to match.
- **`tests/test_register_consistency.py`** (new): pins voting behavior for
  all four new consistency rules — minority-formal/minority-informal each
  flagged exactly once, a single vote staying silent, ties resolving to the
  first-declared variant (ZH).
- **Marketing/TechDoc/Blog example profiles seeded for all seven
  languages** (`app/services/seed_profiles.py`): `EXAMPLE_LANGUAGES` and
  `BLOG_LANGUAGES` were still hardcoded to EN/DE/JA after Tasks 1–4 landed
  the FR/ES/IT/ZH packs and demos; both are now `set(Language)`, with
  per-language marketing/techdoc/blog LLM instructions added for the four
  new languages.
- No engine code touched anywhere in Tasks 1–4 — pure YAML + demos + tests,
  per the plan's binding constraint; only Task 5 (profile seeding) touched
  Python.

**Review-driven precision fixes** (headline catches, all already committed
during the feature, this entry only consolidates them):
- **FR** (`dd3179d`): bare « numéro 1 »/« n° 1 » over-fired on ordinary
  French (addresses, magazine issues, « priorité numéro 1 »); qualified to
  the market-claim forms « … du marché »/« … mondial » only, mirroring EN's
  `number one`/`#1` and JA's 業界No.1 precedent.
- **ES** (`2fab113`): `tuteo-ustedeo`'s formal variant hardened to admit
  `PROPN` alongside `PRON` — `es_core_news_sm` occasionally mistags
  « Usted » as `PROPN` in exactly the mixed-register documents the rule
  targets, and the `LOWER` gate (usted/ustedes only) makes the addition
  loss-free; `clarity.circunloquios`'s message template had its `%s` slots
  inverted (labeled the replacement as the circumlocution) and was
  corrected to match the substitution convention; `es-blog.txt` gained a
  second general-rule trigger (queísmo) without disturbing the vote tally.
- **ZH** (`5232db8`): three raw-text collision guards added — `wufa-zhengshi`'s
  史上最 moved to a lookbehind `(?<!历)史上最` so it stops firing inside
  历史上最… historical prose; `dayue-zuoyou` gained a `左右(?![了着])`
  lookahead excluding the verb readings 左右了/左右着; `hedging`'s
  `可能`/`大概` entries gained `(?<![不尽])可能(?!性)` and `大概(?![率念])`
  lookarounds excluding 可能性/不可能/尽可能/大概率. Plus documentation of a
  low-frequency `ni-nin` edge case: 迷你 ("mini") can mis-segment into a
  standalone 你 token and cast a spurious informal vote.

**Documentation this phase.** `docs/backend-architecture.md`: the seeding
paragraph now says every language gets Marketing/TechDoc/Blog example
profiles (was EN/DE/JA-only); the `consistency` check-type paragraph now
notes it backs five rules across two script families (JA desu-masu plus
the four address-register rules); the pack-count sentence now says every
language ships three packs (was EN/DE-only). `backend/rules/README.md`:
French/Spanish/Italian/Chinese sections added (Pack column, catalog rows,
"Known heuristic limitations" sections matching the JA structure); the
pack-count and consistency-check-type intro sentences updated the same way
as the architecture doc; spot-checked ~8 rows against the final rule YAMLs
(ZH lookarounds, FR/ES qualified claim tokens, ES PROPN gate) — no
contradictions found.

**Verification.** `cd backend && uv run pytest -q` → 602 passed (final
count for the phase; individual tasks landed at 529/554/578/602 as
FR/ES/IT/ZH landed in turn, Task 5 added no new tests beyond extending
`test_seed_pack_profiles`).

## 2026-07-07 — UI: stable chip position while LLM status wraps
Commits: `a8398c2`

The LLM status label ("LLM checking… (12s · ↓ 76 tokens)") wraps to two lines
as it grows, and because it was a flex child of the findings header it pushed
the severity/source chips down and up again. Per the owner's choice, the label
is now absolutely positioned (right-aligned, max-width 65%, pointer-events
none) so the header height comes from the heading alone and a wrapped second
line visually overlays the chip row — an accepted, rare collision — instead of
moving it. CSS-only change; verified via frontend build.

## 2026-07-07 — Findings survive tab switches; Vite watcher polling
Commits: see below

Switching from the editor to another view (rules, terminology, profiles) and
back discarded all findings and re-ran the fast check — LLM findings, which
cost time and money, were simply lost. Root cause: `App.tsx` unmounted the
workspace on view switch, and findings live in the CodeMirror `StateField`
(the store's `tracked` is only a mirror), so they died with the editor
instance; an in-flight LLM check could no longer deliver either. Fix: the
workspace stays mounted and is hidden via the `hidden` attribute (plus a
`.workspace[hidden]` CSS rule, since `display: flex` would override it).
This preserves rule *and* LLM findings, scroll position, undo history, and
lets an in-flight LLM check land while the user reads another view.

Verified end-to-end with headless Chrome (playwright-core) against the live
dev servers: 4 findings before switch, workspace `hidden` on the rules view,
4 findings immediately after return, **0 new POST /api/checks** triggered by
the round trip, editor remeasured correctly (screenshot checked).

While verifying, the Vite dev server turned out to be serving stale
transforms (file edits invisible even after `touch` — the previously parked
staleness issue recurring). Added `server.watch.usePolling: true` to
`vite.config.ts` and restarted the dev server.

## 2026-07-07 — Auto-LLM checkbox replaced by ✳ toggle button
Commits: see below

The "auto" checkbox was the only bare checkbox in the header. It is now a
two-state icon button (like the terminology Aa case toggle): a ✳ sparkle —
deliberately the same glyph as the "✳ LLM checking…" status — that shows
accent color + soft fill when auto-checking is on and dim gray when off,
with the existing localized hover title. The unused `autoLabel` i18n key was
removed from all seven locales. Verified in headless Chrome: aria-pressed
toggles per click, both visual states screenshot-checked.
Follow-up: glyph enlarged (1.1rem) and flex-centered in the button.

## 2026-07-07 — Terminology: terms editable in place, domains renamable
Commits: `24a50f8`…`0e1af84` + docs commit

Terms previously supported only create/delete; fixing a typo meant delete +
re-enter. Following the usual spec → plan → execution flow (spec
`2026-07-07-editable-terms-design.md`, plan `2026-07-07-editable-terms.md`,
executed inline): a ✎ per row now swaps it into edit mode using the same
widgets as the add-term row via a shared `TermFieldCells` component driven by
a `TermDraft`; ✓/Enter saves through the (pre-existing) `PUT /api/terms/{id}`,
✕/Escape cancels. The add row moved onto the same draft object and gained
Enter-to-add. Domains rename inline (✎ or double-click, Enter saves via new
`updateDomain` client call, blur/Escape cancels, empty names refused).
Draft/parse helpers (`parseVariants`, `termToDraft`, `draftToTermPayload`)
live in `termTable.ts`, written test-first (6 new tests; suite 144).

E2E with headless Chrome against the live dev servers on a scratch domain:
edit-save round-trip verified in UI and via GET (preferred, variants,
case-sensitivity), Escape discards, rename lands, empty rename refused,
scratch domain cleaned up. One e2e-script pitfall worth remembering: a
Playwright `hasText` row filter stops matching once the name span becomes an
input (values aren't text content).
Follow-up: the add-domain input gets min-width: 0 so the localized
"Hinzufügen" button fits inside the fixed-width domain list.

## 2026-07-07 — Terminology toolbar aligned with table columns
The language filter and term search moved from a free-floating toolbar into
a first thead row (`term-controls-row`), so the selector sits exactly above
and as wide as the language column and the search field matches the
Preferred column — alignment holds in all locales automatically because the
table does the sizing. Verified geometrically and by screenshot (de, en).
Follow-up: the terminology table now shows language endonyms ("Deutsch",
"日本語") instead of raw ISO codes — rows, filter, and add/edit selects —
via a new `languageName(code, languages)` helper (test-first), matching
the header's language selector. Codes remain the stored/API value.
Follow-up: the Preferred column now visually leads each row — semibold,
full text color — while the supporting columns (language, do-not-use,
definition) recede to the dim text color; add/edit widgets unaffected.
