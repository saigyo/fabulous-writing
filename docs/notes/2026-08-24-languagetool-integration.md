# LanguageTool integration — research findings

Date: 2026-08-24. Scope: backlog research only, no implementation. Repo license
is MIT (`LICENSE`, project root).

## 1. LanguageTool HTTP server (sidecar idea)

### `/v2/check` REST API

Official docs: https://languagetool.org/http-api/ and the interactive spec at
https://languagetool.org/http-api/swagger-ui/#!/default/post_check (the swagger
page did not render its JS payload for automated fetching, but the parameter
set below is corroborated by the pyLanguagetool client's own request builder,
see §2).

Request parameters (`POST /v2/check`, form-encoded):
- `text` — the text to check (or `data` for pre-annotated markup input).
- `language` — a language code, or `"auto"` to request LT's own
  language-detection (`preferredVariants` narrows which variant auto-detect
  may pick, e.g. `en-US` vs `en-GB`).
- `enabledOnly` — when `true`, restricts checking to `enabledRules`/
  `enabledCategories` only, instead of running the full default rule set.
- `level` — `"default"` or `"picky"`; picky turns on additional, more
  aggressive style rules.
- `disabledRules`, `enabledRules`, `disabledCategories`, `enabledCategories` —
  comma-separated rule/category id lists.

Response shape: a JSON object with a `matches` array. Each match carries
`offset` and `length` (character span into the submitted text), `message` and
`shortMessage`, a `replacements` array of suggested fixes, and a `rule` object
with `id`, `subId`, `description`, `category` (itself `{id, name}`), and
`issueType` (a normalized error-type string, e.g. `misspelling`,
`grammar`, `style`).

### Self-hosting

Starting the standalone server:
```
java -cp languagetool-server.jar org.languagetool.server.HTTPServer \
  --config server.properties --port 8081 --allow-origin
```
(https://dev.languagetool.org/http-server). The installed CLI package also
exposes `languagetool --http --config server.properties --port 8081`.

Memory/JVM footprint: LT's own troubleshooting material (LanguageTool GitHub
issue #902, "OutOfMemoryError: Minimum server requirements for HTTP Server",
https://github.com/languagetool-org/languagetool/issues/902, and the
LanguageTool forum thread "RAM consumption",
https://forum.languagetool.org/t/ram-consumption/7946) does not give one
official number; guidance is "increase `-Xmx` until the OOM stops," with
`-Xmx500m` cited as a floor sufficient for n-gram-enabled English checking in
one forum report. In practice, the most-used community Docker image
(`erikvl87/languagetool`, https://github.com/Erikvl87/docker-languagetool,
https://hub.docker.com/r/erikvl87/languagetool) defaults to
`Java_Xms=256m` / `Java_Xmx=512m` and documents users running `Xmx=1g`–`2g`
comfortably for interactive multi-language use. No official LanguageTool
Docker image exists; the LT GitHub repo's own README instead points users at
community images, of which `erikvl87/docker-languagetool` is the most
actively maintained and widely used (n-gram and fastText wiring built in,
regularly rebuilt against new LT releases).

Optional add-ons:
- **n-gram data** (confusion-pair rules like *their/there*): ~8 GB download,
  currently available only for English, German, French, and Spanish; LT's own
  docs warn it needs an SSD or checking becomes "much slower"
  (https://dev.languagetool.org/finding-errors-using-n-gram-data).
- **fastText** language-identification model: improves auto-detect accuracy
  over LT's built-in detector; not available on Windows builds; exact model
  size wasn't stated on the fetched page (https://dev.languagetool.org/http-server).

### Language coverage vs. our locales

Our app's locales, read from `frontend/src/languages.ts`
(`FALLBACK_LANGUAGES`) and confirmed against `backend/app/core/models.py`
(`class Language`): **en, de, fr, es, it, ja, zh**.

LT supports all seven (https://dev.languagetool.org/languages), but rule-count
tiers vary enormously — the same page states rule counts are "a very rough
indication of how well a language is supported":

| Locale | LT XML rule count |
|---|---|
| fr | 6,984 |
| en | 6,074–6,150 |
| de | 5,224 |
| zh | 1,863 |
| es | 1,644 |
| ja | 735 |
| it | 141 |

So our two best-covered locales in our own rule catalog (en, de — see §5) are
also LT's strongest tiers, but **Italian is LT's thinnest supported language
by a wide margin** (141 rules vs. thousands for the top three), and Japanese
sits far below Chinese despite both being CJK. A sidecar would give
wildly uneven added value per locale.

### Public API limits

Per https://dev.languagetool.org/public-http-api.html (mirrored at
https://github.com/languagetool-org/languagetool-org.github.io/blob/master/public-http-api.md):
20 requests per IP per minute (stated as a peak, not a sustained rate — "don't
constantly send this many requests or we would have to block you"), 20 KB of
text per request, 75 KB of text per IP per minute on the free tier. The docs
explicitly tell automated/production users to self-host instead of hammering
the public endpoint. This rules the public API out for our production check
path; it's only viable for manual spot-checks. (Premium/Enterprise raises the
per-request cap to 60 KB and per-minute to 300 KB, per
https://help.languagetool.org — not relevant unless we'd pay for it.)

## 2. pyLanguagetool client library

Repo: https://github.com/Findus23/pyLanguagetool.

- **License**: MIT, confirmed via the GitHub API (`license.spdx_id: "MIT"`) —
  permissive, no obligation issue for depending on it.
- **Maintenance**: last push `2025-04-13` (GitHub API `pushed_at`) — about 16
  months stale relative to today (2026-08-24), not archived, but clearly a
  low-activity project (issue #41,
  https://github.com/Findus23/pyLanguagetool/issues/41, is an open, unresolved
  API-parameter gap report).
- **Sync vs. async**: sync-only. `pylanguagetool/api.py`
  (https://github.com/Findus23/pyLanguagetool/blob/master/pylanguagetool/api.py)
  builds its HTTP calls on the `requests` library, not `httpx`/`aiohttp`.
  Because our backend is async FastAPI, wrapping this library would mean
  running it in a thread pool executor to avoid blocking the event loop — an
  extra layer of indirection for little gain.
- **What it adds beyond a thin POST wrapper**: a `get_languages()` helper, a
  `check()` function that assembles the same form parameters described in
  §1, validation that premium `username`/`apiKey` are supplied together and
  restricted to languagetool.org's own endpoint, and client-side filtering of
  matches against a personal word list (PWL). It also ships a CLI
  (`pylanguagetool/cli.py`) with file/stdin/clipboard input and multiple
  output formats (txt/html/md/rst/ipynb/json/xliff) — none of which we'd use
  as a library consumer.

**Verdict**: given (a) sync-only, (b) thin — the `/v2/check` POST + JSON
parse is maybe 20 lines of `httpx` code — and (c) stale maintenance, calling
the LT REST API directly via `httpx.AsyncClient` in our own backend is
preferable to taking on the dependency.

## 3. License analysis (LGPL-2.1+)

Confirmed directly from the LanguageTool repo's `COPYING.txt`
(https://github.com/languagetool-org/languagetool/blob/master/COPYING.txt):
first lines read "GNU LESSER GENERAL PUBLIC LICENSE / Version 2.1, February
1999," and the LT README states "The LanguageTool core (this repo) is freely
available under the LGPL 2.1 or later."

### Sidecar-over-HTTP: safe

Running the unmodified `languagetool-server.jar` (or the `erikvl87` container
built from it) as a separate OS process/container and talking to it only over
HTTP creates **no derivative-work obligation on our codebase**. LGPL-2.1's
copyleft attaches to the LT *binary/source distribution itself* — if we
redistribute the server (e.g. bundle its jar or a derived Docker image in our
own release artifacts or `docs/`/`compose.yml`), we'd need to keep its license
notices and, if we modified LT's own source, offer those modifications under
LGPL too. Calling it as an arm's-length network service is the textbook case
LGPL was designed to permit without "tainting" the calling application —
equivalent to linking against an LGPL shared library at the process boundary,
except here the boundary is a socket, which is even further removed. This is
the standard, uncontroversial reading of LGPL-2.1 §5/§6 (dynamic linking /
independent works); no LT-specific FAQ states otherwise, and this is the
integration mode LT's own commercial customers use routinely.

### The adventurous idea: translating `grammar.xml` rules

The rule catalogs under
`languagetool-language-modules/*/src/main/resources/org/languagetool/rules/*/grammar.xml`
are part of the same LGPL-2.1+ distribution (confirmed: the `en/grammar.xml`
file header itself carries a GNU LGPL notice, and additionally discloses that
"portions of rules are converted from After The Deadline grammar checker...
licensed under GNU GPL" — an extra wrinkle meaning *some* of LT's own rule
content is GPL-derived, not just LGPL, inside the same file). These XML files
are **data under license**, not just format documentation.

Soberly, two distinct paths exist, with different legal outcomes:

(a) **Vendoring translated rules into our repo — unsafe.** If we read LT's
`grammar.xml`, mechanically or by hand translate the patterns into our own
YAML rule formalism (`backend/app/checkers/rules/`), and commit those
translated files into `backend/rules/`, the translated files are a derivative
work of LGPL-2.1 (and in the After The Deadline-derived cases, GPL) licensed
data. Translation into another formalism does not launder the license — the
*semantic content* (word lists, patterns, POS conditions) is what's
copyrighted and reused, not the XML syntax. Shipping those translated rules
in our repo would obligate us to license that part of our repo under
LGPL-2.1+ (and possibly GPL for the After The Deadline-derived subset) —
**directly violating the owner's hard constraint of no code copied from LT
into our repo.** This path is closed.

(b) **On-the-fly translation at deploy time, never vendored — safe, narrow.**
If a translator tool (that we write from scratch, referencing only LT's
publicly documented rule-format grammar — see §4 — not copying rule content)
runs at *the deployer's own runtime*, fetching *the deployer's own* copy of
LT's grammar.xml files (e.g. from their own LT install or a pip/apt package
they installed) and emitting translated rules that live only in that
deployment's runtime state — never committed to our repository — we are not
distributing LT's rule data at all. The deployer is exercising their own
rights under LGPL to use/adapt LT data they legitimately obtained; our
translator code (the tool itself) is ours and can be MIT-licensed, since the
tool's logic is not LT-derived even though its *output*, when run, is.

**Constraint to flag explicitly for any future issue on this**: even path
(b) requires that we never commit a translator's *output* (translated rule
files) into `backend/rules/`, only the translator *code*, and any example/test
fixtures used to validate the translator must be original sentences we write,
not lifted from LT's `<example>` elements (those examples are part of the
same licensed file).

LT's rule-format is documented separately from the rule data itself: e.g.
https://dev.languagetool.org/tips-and-tricks and
https://dev.languagetool.org/developing-robust-rules, which describe pattern
syntax, antipatterns, and unification without being the rule catalog itself.
**Writing our own translator against that documentation is unproblematic —
it's the equivalent of implementing a file-format parser from a spec.** The
licensing risk is entirely about the *data* (the rule catalogs), not the
*format documentation*.

## 4. Rule-format mapping feasibility

### LT's `grammar.xml` rule format

Per https://dev.languagetool.org/tips-and-tricks and the shape confirmed by
direct inspection of
https://github.com/languagetool-org/languagetool/blob/master/languagetool-language-modules/en/src/main/resources/org/languagetool/rules/en/grammar.xml:

- `<rule>`/`<rulegroup>` wrap one or more `<pattern>` blocks made of `<token>`
  elements, each optionally carrying `regexp="yes"`, `case_sensitive`,
  `postag` (POS-tag matching, itself regexable), `skip="-1"` (unbounded gap),
  and `min`/`max` occurrence counts.
- `<antipattern>` blocks declare token sequences that, if matched, suppress
  the rule even though the main `<pattern>` also matched — used heavily to
  hand-carve exceptions (LT's tips-and-tricks doc specifically discusses
  debugging which antipattern silently ate a match).
- `<unify>` groups tokens that must share a grammatical feature (e.g. gender,
  number) resolved via LT's POS/morphology tagger — used for agreement
  checks.
- `<suggestion>`/`<message>` hold the fix text, with placeholder
  back-references to matched tokens; `<example>` gives correct/incorrect
  sentence pairs (these are the license-encumbered data mentioned in §3).

### Our own rule engine's expressiveness

`backend/app/checkers/rules/loader.py` defines `RuleSpec` with 7
`CheckType`s: `existence`, `substitution`, `occurrence`, `repetition` (all
four are plain regex/string matching over raw text, wrapped by CJK-aware word
boundaries in `backend/app/checkers/rules/text.py`), and `token_pattern`,
`dependency`, `consistency` (all three run on spaCy `Matcher`/
`DependencyMatcher` patterns over a spaCy/GiNZA-produced doc — token
attributes like `LEMMA`, `POS`, `TAG`, `MORPH`, `DEP`, with `OP` quantifiers
for gaps). `backend/app/checkers/rules/engine.py`'s `RuleEngine.check()`
dispatches per rule to its `CHECKS[extends]` handler and returns `Finding`s.
`backend/rules/README.md` documents all of this plus a `consistency` type
(document-scoped majority-style voting — has no LT analogue at all).

Mapping surface, concretely:

- **Clean fit**: LT's plain literal/regex `<token>` patterns (no `postag`, no
  `regexp` referencing morphology) map fairly directly to our `existence` /
  `substitution` / `raw` regex rules — both are ultimately string/regex
  matching.
- **Partial fit, needs a tagger**: LT `<token postag="...">` patterns
  (POS-gated) map to our `token_pattern`/`dependency` types *only* where a
  spaCy model exists for that language and its tagset lines up closely enough
  with LT's postag scheme — these are two independently-designed tagsets
  (LT's own vs. Universal Dependencies/spaCy's), so a 1:1 mapping of tag
  values is itself nontrivial, not just plumbing.
- **Out of reach**: `<unify>` (feature agreement/disambiguation) has no
  counterpart in our engine at all — our `dependency`/`token_pattern` types
  match structure, not cross-token feature unification, and building that
  would mean writing a new check type and a morphological-agreement resolver,
  not a translator.
- **Top 3 concrete obstacles**:
  1. **POS-tag vocabulary mismatch** — LT's `postag` values are LT's own
     tagset per language, not spaCy/UD tags our rules use; every translated
     `postag` condition needs a hand-verified mapping table per language, and
     some LT distinctions (finer morphological features) don't exist in the
     spaCy small models we currently load.
  2. **`<unify>` / disambiguation** — genuinely unsupported: our engine has no
     unification primitive, so any LT rule using it cannot translate at all
     without new engine work, not just a translator.
  3. **`<antipattern>` semantics** — our engine has no "matched, but
     suppressed by a second independent pattern" concept; the closest
     approximation (folding antipattern conditions into negative lookaheads
     inside a single regex, as our own rules already do by hand — e.g.
     `de/grammar/deppenapostroph.yml`'s negative-lookahead contraction
     stoplist) works for simple cases but breaks down for LT rules whose
     antipatterns span multiple independent tokens/positions.

## 5. Integration surface in our backend

Backend finding shape (`backend/app/core/models.py`):
```python
class Finding(BaseModel):
    id: str
    category: Category   # spelling|grammar|style|clarity|vividness|correctness|terminology
    severity: Severity    # error|warning|suggestion
    source: Source         # llm|rule|terminology
    rule_id: str | None
    message: str
    span: Span              # start, end, text
    suggestions: list[str]
    advice: list[str]
```
Frontend mirrors this in `frontend/src/types.ts` (`Finding` with `severity:
Severity`, consumed by `frontend/src/findings/severity.ts`'s
`countBySeverity`/`filterBySeverity`).

Mapping an LT match onto our `Finding`:
- `offset`/`length` → `Span.start`/`start+length` (`Span.text` sliced from
  the source text, same as our own checkers already do).
- `message` → `Finding.message`; LT's `replacements[].value` list → our
  `suggestions: list[str]`.
- `rule.category`/`rule.issueType` → our `Category` — this needs a mapping
  table, since LT's category ids (`GRAMMAR`, `TYPOS`, `STYLE`,
  `CONFUSED_WORDS`, `PUNCTUATION`, …) and `issueType` values
  (`misspelling`, `grammar`, `style`, `typographical`, …) don't line up 1:1
  with our seven-value `Category` enum; a new `Source.LANGUAGETOOL` value
  (alongside existing `llm`/`rule`/`terminology`) would be the natural way to
  tag these findings distinctly from our own rule engine's hits.
- `rule.id` → `Finding.rule_id`, namespaced (e.g. `lt.<rule-id>`) to avoid
  collision with our own `rule_id`s, which are dotted `<category>.<name>`
  paths from `backend/app/checkers/rules/loader.py`'s `load_rules()`.
- Severity: LT's API has no direct error/warning/suggestion field — `issueType`
  is the nearest signal (`misspelling`/`grammar` typically map to `error`,
  `style` to `suggestion`) and would need a deploy-side mapping table, not
  something LT hands us directly.

**Dedup/overlap**: `backend/app/checkers/pipeline.py` already implements
overlap-based dedup (`drop_duplicates`), comparing `Span` overlap ratio
(`_same_target`, ≥50% union/overlap) and `Category` match, used today to let
deterministic rule/terminology findings take precedence over LLM findings
covering the same span. An LT sidecar's findings would plug into this same
mechanism as a third candidate source — likely wanting the same precedence
LT: sit either alongside or above our own `rule`-sourced findings (since LT is
also deterministic, span-precise, non-LLM) and below/deduped-against our own
rule engine where both flag the same span, since our own rules are more
precisely tuned to this app's target audience (marketing/techdocs/blog packs)
than LT's general-purpose catalog.

## Recommendation sketch

**Sidecar first.** Standing up `erikvl87/docker-languagetool` as a
self-hosted process behind our backend and calling `/v2/check` via a
plain `httpx.AsyncClient` POST is low-risk, LGPL-clean (§3), and gives
immediate value for en/de/fr (LT's strongest tiers) with essentially no
license exposure since nothing from LT is vendored into our repo — only a
running container we operate. Skip pyLanguagetool (§2): it's sync, thin, and
stale enough that hand-rolling the two HTTP calls we need is less code and
less risk than adding the dependency. Start with `enabledOnly=false`,
default level, and hold off on n-gram/fastText add-ons (multi-GB, SSD-bound)
until there's a concrete need. Expect uneven payoff across locales — Italian
(141 LT rules) and Japanese (735) will add much less than English/German/
French; that unevenness itself is a good reason to scope the first spike to
en/de/fr and measure before rolling out to the other four locales.

**Rule translation as a separate, later spike — legally narrower than it
sounds.** Only the on-the-fly, never-vendored translation path (§3b) is safe
against the owner's "no code copied from LT" constraint, which immediately
rules out the simplest implementation (translate once, commit the YAML). A
real spike would need to design a deploy-time fetch-and-translate step whose
*output* never enters version control, which is a meaningfully different
(and more awkward to operate/test) system than "add YAML files." Combined
with the mapping obstacles in §4 — POS tagset mismatch, no `<unify>` support,
no multi-token antipattern support — the realistic ceiling is translating a
minority of LT's simplest literal/regex rules, which is exactly the subset
we can already write by hand in our own catalog. Recommend treating this as
a low-priority research spike, not a roadmap item, unless the sidecar
experience reveals a specific high-value LT rule family worth chasing.
