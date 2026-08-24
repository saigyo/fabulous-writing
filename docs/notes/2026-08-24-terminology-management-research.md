# Terminology management — research findings

Date: 2026-08-24. Scope: backlog research only, no implementation. Framing
from the owner: our terminology component is currently a shallow word-list
checker; professional terminology-management systems (TMS) are far more
comprehensive, and growing toward one could be a distinguishing feature
versus LanguageTool/Grammarly, neither of which has a terminology-management
component at all (see `docs/notes/2026-08-24-languagetool-integration.md`
§1, which confirms LT's rule catalog has no term-list/glossary concept).

## 1. Our current state (gap-analysis baseline)

### Data model

`backend/app/services/terminology.py` defines two SQLite-backed models:

```python
class Domain(BaseModel):
    id: int
    name: str
    description: str = ""
    owner_id: int | None   # None = global/built-in, else per-user

class Term(BaseModel):
    id: int
    domain_id: int
    language: Language          # one of en/de/fr/es/it/ja/zh
    preferred: str
    forbidden_variants: list[str] = []
    definition: str = ""
    case_sensitive: bool = False
```

A `Domain` is a flat named bucket ("Product docs" is the seeded global one,
`backend/app/services/seed.py`); a `Term` belongs to exactly one domain and
one language, and holds exactly one preferred spelling plus a list of
forbidden string variants. There is no concept layer above the term — two
terms in different languages that mean the same thing are two independent,
unlinked rows. There is no usage-status field beyond the implicit binary
preferred (one string) vs. forbidden (`forbidden_variants`, a flat list with
no per-variant metadata of its own — no per-variant "why is this forbidden"
or severity). There is no part-of-speech, subject-field-beyond-domain-name,
context/example-sentence, source/citation, or cross-reference
(synonym/antonym/related-term/homograph) field anywhere in the schema.

### Matching approach

`backend/app/checkers/terminology.py`'s `TerminologyChecker` runs per
`(text, language, domain_id)`:
- **Latin-script languages**: `\b`-bounded regex, case-insensitive unless
  `term.case_sensitive`, one pattern per `forbidden_variants` entry
  (`_check_regex`). A separate casing pass (`_casing_regex`) flags a
  case-sensitive preferred term used with the wrong capitalization, with a
  sentence-start exception for a conventionally-capitalized first word.
- **CJK (`ja`, `zh`)**: no word boundaries exist, so matching goes through
  spaCy's `PhraseMatcher` on a tokenizer-only `Doc` when a pipeline is loaded
  (`backend/app/nlp/registry.py`'s `NlpRegistry`, GiNZA for Japanese), with a
  raw-substring fallback (`_check_substring`) when the model isn't
  installed — degraded but functional.
- Matching is **exact-string** in both paths (or exact-token via
  `PhraseMatcher`) — there is no stemming/lemmatization, no inflected-form
  matching (a German compound built on a forbidden root, or an English
  plural of a singular forbidden term, is invisible unless someone typed the
  exact string into `forbidden_variants`), and no multi-word-term-boundary
  awareness beyond what `\b`/tokenization already gives for free.
- No context-dependent scoping below the domain level: a term is
  forbidden/preferred for its whole `(domain_id, language)`, not
  conditionally by finer-grained context.

### Scoping and management surface

Domains are the only scoping axis: `owner_id: None` = global/built-in
(admin-only to edit, `GlobalReadOnlyError` in
`backend/app/services/ownership.py`-style checks), else owned by one user.
A `Profile` (`backend/app/services/profiles.py`) references a list of
`domain_ids`, so a writing-check run scopes terminology by which domains are
attached to the active profile — this is the closest thing to
domain/subject-field scoping today, but it's per-profile term-list
inclusion, not a subject-field classification carried on the term itself.
Creating a custom domain is gated by the `custom_domains` feature flag
(`backend/app/api/terminology.py`); within an owned domain, any owner can
CRUD their own terms and domains, admins can additionally edit global ones.
There's no proposal/review workflow — writes are immediate and
unconditional (no draft/pending state, no approver role, no audit trail
beyond whatever the DB itself retains).

### Frontend management UI

`frontend/src/terminology/TerminologyView.tsx` is a two-pane CRUD screen:
a domain list (create/rename/delete) and, for the selected domain, a term
table (`termTable.ts` — filter/sort helpers) with create/edit/delete per
term. No bulk import/export (no TBX/CSV upload or download path found
anywhere under `frontend/src` or `backend/app/api`), no term-proposal or
approval UI, no search-across-domains, no history/audit view.

**Net read**: what exists today is a solid, correctly-scoped
find/highlight/suggest checker with per-user and per-domain visibility
rules — but the term itself is a flat (preferred, forbidden-variants,
definition, case-sensitivity) tuple, not a concept-oriented entry with
metadata, workflow, or interchange support. That gap is the whole subject of
§§2–5 below.

## 2. Standards — what "professional grade" formally means

### ISO 704 — Terminology work: Principles and methods

Establishes the links between objects, concepts, definitions and
designations, and general principles for term formation and definition
writing (ISO catalogue: https://www.iso.org/standard/79077.html, 2022
edition; https://www.iso.org/standard/38109.html for the 2009 edition; full
text paywalled, catalogue abstract only). Terminology work itself is
defined, via the companion vocabulary standard ISO 1087:2019, as "the
systematic collection, description, processing and presentation of concepts
and their designations" (cited in ISO's own online browsing platform,
https://www.iso.org/obp/ui/#iso:std:iso:704:ed-3:v1:en). The two principles
the owner specifically named:
- **Concept orientation** — the concept (not the word) is the unit of
  analysis; terms in every language attach to a shared concept, so a
  "term" is a label on a concept rather than a standalone lexical entry.
  This is exactly the layer our current `Term` model lacks (§1): our terms
  are per-language rows with no concept anchor linking, say, an English
  and a German term that denote the same thing.
- **Term autonomy** — a language's terminology is developed on its own
  conceptual footing, not defined purely as a translation of another
  language's term; two "equivalent" terms in different languages may carve
  the underlying concept slightly differently. This matters directly for
  us given our 7-locale scope: a naive 1:1 EN→DE term mapping would violate
  this principle if the German market actually uses the concept
  differently.

### ISO 30042 — TBX (TermBase eXchange), and its lighter dialects

TBX is the XML-based ISO standard for terminology-data interchange,
originally developed by LISA (Localization Industry Standards Association)
and now maintained under ISO 30042
(https://www.tbxinfo.net/tbx-about/ — tbxinfo.net is the canonical TBX
documentation site, successor to LISA's OSCAR standards group). Two public,
lighter-weight dialects exist for practical adoption, maintained by
TerminOrgs (LISA/OSCAR's successor body):
- **TBX-Basic** — "the primary dialect for terminology exchange," designed
  to store large quantities of mono-, bi-, or multilingual glossaries in a
  straightforward XML format, and requires only two mandatory data
  categories (term, language) — everything else is optional
  (https://www.tbxinfo.net/tbx-dialects/, https://www.terminorgs.net/TBX-Basic.html,
  full spec: https://www.terminorgs.net/downloads/TBX-Basic-V4.pdf).
- **TBX-Min** — "designed for simple and straightforward storage of
  bilingual or monolingual glossaries," aimed at the lightest use case:
  handing a glossary to a translator, or a translator submitting their own
  candidate list (https://www.tbxinfo.net/tbx-dialects/). Both dialects are
  approved/maintained by the TBX Council, and default data categories for
  use in either dialect come from the "TBX Master List," falling back to
  DatCatInfo.net for anything not already in that list
  (https://www.tbxinfo.net/tbx-modules/).
- **Recommendation**: target **TBX-Basic** as our export/import dialect if
  we build interchange. It's the dialect actually used across the
  professional tools researched in §3 (MultiTerm, TermWeb, Quickterm,
  Microsoft's downloadable collection) and has enough headroom (definition,
  context, source, part-of-speech, usage status, subject field are all
  standard TBX-Basic data categories) to represent everything in the
  feature-tier sketch below, without TBX-Min's glossary-only ceiling.

### ISO 12620 / DatCatInfo — the Data Category Registry

ISO 12620 defines a **Data Category Registry**: a controlled vocabulary of
standardized terminology/linguistic data categories (usage status, part of
speech, subject field, definition, context, source, term type, etc.), with
mappings between different systems that use the same underlying concepts
(https://en.wikipedia.org/wiki/ISO_12620, corroborating the ISO catalogue
listing at https://www.iso.org/standard/37243.html). The registry itself
moved several times and is now hosted as **DatCatInfo**
(https://datcatinfo.net/, replacing the earlier ISOcat), described as "the
Data Category Repository (DCR) ... developed according to the ISO 12620
series of standards." The specific usage-status data category most relevant
to us — Preferred / Admitted / Deprecated / Obsolete — recurs across every
professional tool in §3; **Admitted** in particular is a genuinely useful
status our binary preferred/forbidden model has no room for: "a term that
does not meet the requirements to be a preferred term, but is not
deprecated" — i.e. an acceptable-but-not-recommended synonym, distinct from
an actively-forbidden one. (Definitions corroborated by search-engine
summarization against NISO/DatCatInfo-aligned sources; if this becomes
load-bearing for schema design, re-verify the exact status list directly
against https://datcatinfo.net/ rather than this summary.)

### ISO 26162 — Design, implementation and maintenance of terminology management systems

Specifies criteria for designing, implementing, and maintaining a TMS: the
rationale for using one, user types and needs, steps in designing/
implementing it, tasks for organizing and managing a "terminological data
collection," and guidance for selecting/using data categories in different
environments — aimed at terminologists and software developers alike
(https://www.iso.org/standard/43427.html, 2012 edition; catalogue abstract
only, full text paywalled). The standard was later split into
ISO 26162-1 (terminology database design) and ISO 26162-2 (software)
(https://www.iso.org/obp/ui/#iso:std:iso:26162:-2:en). The headline
takeaway usable without buying the standard: a "real" TMS is explicitly
expected to separate **database design** (the concept/term/entry data
model) from **system/software design** (the application built on top of
it) as two distinct, individually-specified concerns — which is a useful
frame for scoping any redesign of our own `TerminologyStore`.

### TerminOrgs "Terminology Starter Guide" — practitioner-consensus feature list

TerminOrgs (terminorgs.net) publishes a practitioner-written starter guide
for organizations standing up a terminology function
(https://www.terminorgs.net/Terminology-Starter-Guide.html, PDF at
https://www.terminorgs.net/downloads/TerminOrgs_StarterGuide_V2.pdf). Its
recommendations, distilled:
- **Organizational**: a terminology team with clear ownership, defined
  roles (terminology specialists, subject-matter experts, system
  administrators), and a coordinator responsible for cross-organization
  consistency.
- **Workflow**: a "systematic approach to identifying, defining, and
  managing terms," with review-and-approval gates before a term enters
  production use, plus periodic audits of the existing collection.
- **Essential term-entry fields**: preferred term, definition,
  context/subject-field, part of speech, equivalent terms (synonyms,
  variants, deprecated forms), status indicators (approved/candidate/
  obsolete), source documentation, created/modified dates — this list maps
  almost one-to-one onto the ISO 12620 data-category set in §2's DatCatInfo
  paragraph, and is the most directly actionable feature checklist found in
  this research.
- **System/tooling**: a centralized, stakeholder-accessible database;
  version control for term changes; search/retrieval; export for
  translation/documentation-tool integration; multilingual support.

## 3. What the professional tools actually offer

Full vendor-by-vendor findings (RWS/SDL MultiTerm, memoQ qTerm, Acrolinx/
markup.ai, Kalcium Quickterm, TermWeb, IATE, Microsoft Terminology
Collection) were gathered from primary vendor docs, ISO/TerminOrgs sources,
and public termbase documentation. Key points, with sources:

- **Concept-oriented entry model** (entry → per-language level → per-term
  level, all fields attachable at any level) is MultiTerm's and IATE's core
  structure (https://docs.rws.com/en-US/sdl-multiterm-online-791804/termbase-layouts-366066,
  https://docs.rws.com/en-US/multiterm-2021-sr2-796827/termbases-348385).
  IATE additionally puts subject-field/domain classification at the
  **concept** (language-independent) level, sourced from the EuroVoc
  thesaurus (21 top-level domains, https://datos.gob.es/en/blog/discover-iate-european-unions-inter-institutional-terminology-bas — secondary-sourced summary, IATE's own field-reference page at
  https://iate.europa.eu/fields-explained did not yield a field table on
  fetch and should be re-checked directly if this becomes load-bearing).
- **Usage-status fields beyond binary preferred/forbidden**: MultiTerm's
  system status field lists Preferred / Admitted / Deprecated / Superseded
  / Forbidden / Draft / In Review / Rejected, with Admitted explicitly
  defined by reference to ISO 12620
  (http://producthelp.sdl.com/WorldServer/10.4.3/GUID-76FC6660-E1F5-46EC-A07D-12E7F432ABCE.html).
  IATE uses a four-value reliability scale (untested / minimal / reliable /
  very reliable) per term, with a documented, honestly-noted weakness: the
  rating is inconsistent across contributing institutions
  (https://datos.gob.es/en/blog/discover-iate-european-unions-inter-institutional-terminology-bas).
- **TBX as the interchange lingua franca, with real-world friction**:
  MultiTerm exports to TBX/XML but does not import raw TBX directly — it
  must be converted first via SDL Convert/Glossary Converter, and
  attachments don't survive the round trip
  (https://docs.rws.com/en-US/sdl-multiterm-2015-791774/tbx-files-351165,
  https://community.rws.com/product-groups/trados-portfolio/trados-studio/f/multiterm/42438/how-do-i-export-or-convert-a-multiterm-termbase-into-tbx-basic).
  A third-party tool exists purely to fix up MultiTerm's non-standard XML
  into valid TBX (https://www.tbxinfo.net/tbx-tools-v2/tbx-v2-convert-multiterm/)
  — evidence that "supports TBX" and "TBX round-trips cleanly" are not the
  same claim, worth remembering if we ever advertise TBX support ourselves.
  TermWeb and Microsoft's downloadable Terminology Collection both offer
  clean TBX + Excel/CSV export
  (https://www.interverbumtech.com/products-services/termweb/,
  https://learn.microsoft.com/en-us/globalization/reference/microsoft-terminology).
- **Forbidden-term enforcement wired into an automated checker** — this is
  the shape closest to our own product. memoQ's qTerm integrates into its
  QA checker: a checkbox opt-in, gated further by whether the active QA
  profile includes terminology checking at all, with forbidden-term status
  round-tripping through Excel export/import as a color convention (red =
  forbidden) (https://docs.memoq.com/current/en/Workspace/edit-qa-settings.html,
  https://blog.memoq.com/terminology-management-in-memoq-8-4). Acrolinx
  (now rebranded **markup.ai**) is even closer to our shape: its current
  public API models a term as exactly `term` / `type` (`preferred` |
  `prohibited`) / `case_sensitive` — essentially the same two-tier model our
  own `Term` already implements
  (https://docs.markup.ai/developer-reference/api-reference/brand-terms/create-term.md).
  This is a genuinely useful finding: **the market-leading terminology
  checker's current data model is not meaningfully richer than ours** — the
  gap to "professional grade" is concentrated in workflow/governance and
  concept-orientation (§§ below), not in the checker's core matching
  primitive.
- **Role-gated proposal/approval workflow** is the single most consistently
  present feature across the dedicated TMS tools and the most consistently
  *absent* from the leaner, checker-first tools (memoQ/Acrolinx). qTerm
  defines four termbase roles — Admin, Review, Modify, Lookup
  (https://docs.memoq.com/web/8/en-US/qterm_settings_permissions.html).
  Kalcium Quickterm names five — end user, initial checker, translator,
  approver, terminologist — with new term suggestions routed through a
  defined approval workflow before entering the live termbase
  (https://kaleidoscope.global/products/quickterm/). TermWeb markets
  "advanced workflow and administration functionality to automate and
  manage your processes" (https://www.interverbumtech.com/products-services/termweb/) but
  granular role documentation wasn't reachable in this pass — flagged as a
  weak source, re-check TermWeb's REST API guide
  (http://docs.termweb.se/restapi/4.0.6/) directly if needed. By contrast,
  our own store (§1) has no draft/pending state and no approver role at
  all — any owner's write is immediate.
- **Cross-references between concepts** (synonym/related/see-also) are a
  documented MultiTerm entry-structure feature (a concept entry holds "at
  least one term and other possible synonyms," per
  https://docs.rws.com/en-US/multiterm-2021-sr2-796827/termbases-348385) and
  implicit in IATE's concept model, but were not independently verified for
  the leaner checker-first tools (Acrolinx/memoQ) — cross-references appear
  to be a dedicated-TMS feature, not a checker feature.
- **Subject-field/domain classification against a controlled vocabulary**:
  IATE's domain field is drawn from EuroVoc, not free text
  (https://datos.gob.es/en/blog/discover-iate-european-unions-inter-institutional-terminology-bas)
  — a meaningfully stricter model than our own `Domain.name`, which is an
  arbitrary user-chosen string with no controlled vocabulary or hierarchy.

## 4. Checker integration — the part that differentiates us

This is where our existing machinery is more capable than the data model
suggests. `backend/app/checkers/terminology.py` already routes CJK
languages through `NlpRegistry.get(language)` (`backend/app/nlp/registry.py`)
to load a spaCy pipeline (GiNZA for Japanese) and uses spaCy's
`PhraseMatcher` for token-aware matching — this is genuine tokenization-
aware infrastructure, not naive substring search, and it already handles
the two languages (ja, zh) where our current regex `\b`-boundary approach
would be *most* wrong. The gap is that this same spaCy pipeline is used
purely for **tokenization**, not **morphology**: `pipeline.make_doc(text)`
explicitly comments "tokenization only" at both call sites
(`terminology.py:144,183`), and matching is still exact-token, not
lemma-aware.

What Acrolinx-class systems add on top of this shape, per §3 and current
vendor documentation (Acrolinx has rebranded to **Markup AI**;
`docs.acrolinx.com`/`support.acrolinx.com` URLs below redirect to
`docs.markup.ai`/`support.markup.ai`, and some pages 404/403 on direct
fetch — those citations were verified via search-result snippet rather than
a direct page load):
- **Morphology-aware matching, confirmed as a real shipping feature**:
  Acrolinx's Terminology Manager has a per-term **"Check Inflections"**
  boolean. Off → "Lexical Analysis Mode: string" (exact string only). On →
  "Lexical Analysis Mode: base form", meaning inflected forms of the word
  are also flagged as the configured term
  (https://docs.acrolinx.com/acrolinxplatform/latest/en/terminology/terminology-manager/manage-your-terms/special-term-settings/check-inflections
  — via search snippet). A term can only be switched to base-form checking
  if it exists in Acrolinx's own dictionary **and** shares that dictionary's
  part-of-speech classification — Acrolinx's inflection-awareness rides on
  a vendor-maintained lexicon/POS tagger, the same architectural shape as
  running a spaCy tagger+lemmatizer over each match (same source). It is
  strictly **opt-in per term**, not an always-on global behavior — worth
  carrying into our own design rather than assuming inflection-matching
  should be a blanket switch.
- **German compounds** specifically are a known hard case for any
  substring/regex approach: a forbidden root can appear anywhere inside an
  arbitrarily long compound noun with no word-internal boundary to anchor
  on. Confirmed absent from spaCy core: the standard `de_core_news_*`
  pipeline's component list (tok2vec, tagger, morphologizer, parser,
  senter, ner, trainable_lemmatizer) has no decompounder
  (https://spacy.io/models/de) — unlike GiNZA's Japanese compound splitter,
  already wired into `backend/app/nlp/registry.py`'s `_GINZA_SPLIT_MODE_FIX`
  for an unrelated purpose, nothing equivalent exists for German in what we
  already load. The practitioner-standard tool for this exact problem is
  **CharSplit** — a small, dependency-light, character-n-gram-frequency
  splitter trained on ~1M German Wikipedia nouns, reporting ~95%
  head-detection accuracy on the GermaNet compound test set
  (https://github.com/dtuggener/CharSplit) — closing this specific gap
  needs one new lightweight dependency, not a green-field NLP effort.
- **Multi-word terms**: already representable in our model today (a
  `preferred`/`forbidden_variants` string can itself be multi-token), and
  the spaCy `PhraseMatcher` path already matches multi-token phrases
  correctly for CJK — no architectural gap there, just no lemma
  normalization within the phrase.
- **Context-dependent rules** (term X forbidden only in domain Y): this
  already exists at the domain-scoping level (`domain_id` + profile
  `domain_ids`, §1) — the gap is finer-grained context (e.g. term X
  forbidden only near term Z, or only in a specific severity tier), which
  none of the researched vendor tools document clearly enough to cite as a
  standard pattern; likely genuinely rare even in professional tools.
- **Severity mapping**: our `Finding.severity` is fixed at `Severity.ERROR`
  for every terminology finding today (`terminology.py:_finding`) — a real
  usage-status model (§2's Preferred/Admitted/Deprecated/Forbidden) would
  naturally map onto our existing `Severity` enum (e.g. Forbidden→error,
  Deprecated→warning, Admitted→suggestion), which is a small, high-leverage
  change once the status field exists.

**Feasibility verdict**: morphology-aware matching is plausible with
machinery already in the backend (spaCy pipelines are already loaded and
already used for tokenization in this exact checker), but it requires
*adding* a lemmatization/morphology step that today is explicitly excluded
(`pipeline.make_doc()` bypasses the tagger/lemmatizer entirely for
performance — see the "tokenization only" comments). The spaCy pipelines
loaded via `spacy.load(model, exclude=["ner"])` in `NlpRegistry.get` still
have their lemmatizer components available (only NER is excluded) — so
running the fuller pipeline (or at least the tagger+lemmatizer) instead of
`make_doc` on the CJK/German path is a real, buildable option, not a
green-field integration; it would trade some of the current approach's
speed for lemma-normalized matching. Since spaCy v3.3, `de_core_news_*`
ships a **trainable** lemmatizer (replacing the older weak lookup
lemmatizer), reporting ~97% accuracy on the TIGER treebank
(https://spacy.io/usage/v3-3), so lemma-based matching for German/English/
French/Spanish/Italian is buildable today with zero new dependencies —
**German compound decompounding is the one sub-problem that genuinely needs
a new dependency** (CharSplit, above), not the lemma-matching work in
general.

## 5. Term extraction/harvesting (nice-to-have tier)

TerminOrgs (the same practitioner body behind §2's Starter Guide and
TBX-Basic) treats extraction as important enough to warrant its own separate
practitioner document, the "Term Extraction Starter Guide" (2022)
(https://www.terminorgs.net/downloads/TerminOrgs_TermExtractionGuide.pdf) —
worth a dedicated read if this tier gets scoped for real.

**Vendor tooling — statistical, not linguistic-morphology-aware**:
- MultiTerm Extract mines term candidates from bilingual documents/
  translation memories via **frequency-based statistical extraction**,
  surfacing a candidate list for human validation
  (https://docs.rws.com/en-US/sdl-multiterm-2015-791774/using-sdl-multiterm-extract-261776).
- memoQ's term extraction is explicitly and only statistical — "based on
  the length and the frequency of the candidates... memoQ doesn't use any
  linguistic intelligence like stemming or parsing"
  (https://docs.memoq.com/current/en/Workspace/extract-candidates.html) —
  a useful, honest data point: even a mainstream CAT tool's extraction
  feature is simpler than one might assume from "professional-grade"
  framing.
- The academically-canonical approach goes further than either shipping
  tool: the **C-value/NC-value method** (Frantzi & Ananiadou) combines
  frequency statistics with **linguistic filters** — part-of-speech tagging
  plus a stop-list restrict candidate strings to plausible term shapes
  (typically noun-phrase patterns), and C-value specifically corrects raw
  frequency counts for nested multi-word terms (a candidate that is itself
  a substring of a longer, more frequent candidate)
  (https://www.jstage.jst.go.jp/article/jnlp1994/6/3/6_3_145/_article/-char/en,
  corroborated by https://link.springer.com/chapter/10.1007/3-540-49653-X_35).

**LLM-based extraction — credible modern substitute, active research area**:
- A 2025 ACL Findings paper demonstrates enhancing automatic term
  extraction with LLMs via syntactic retrieval, explicitly framed against
  the classic statistical/linguistic-filter baseline above
  (https://aclanthology.org/2025.findings-acl.516/, PDF:
  https://arxiv.org/pdf/2506.21222).
- LlamATE proposes in-context-learning prompts with open-source LLMs
  (Llama-2-Chat) specifically to test whether domain-specificity in the
  prompt improves extraction quality
  (https://benjamins.com/catalog/term.00082.tra) — directly relevant to us
  since our domains (§1) are exactly the kind of conditioning signal this
  approach uses.
- A broader 2023 survey of automatic term extraction covers the field's
  trajectory from pure statistical/linguistic methods toward neural and
  LLM-based approaches (https://arxiv.org/pdf/2301.06767).
- **Why an LLM-based approach is credible for us specifically**: we already
  operate LLM infrastructure for the writing-check pipeline
  (`backend/app/checkers/llm/`), so a term-extraction feature could reuse
  that same provider/prompting machinery rather than standing up a new
  statistical-NLP pipeline. An LLM approach can also do in one pass what
  classic extraction needs a second, separate step for: **definition
  generation alongside extraction** — a plain prompt asking for candidate
  terms *and* a one-sentence definition per candidate directly produces
  the `definition` field our `Term` model already has, whereas C-value/
  NC-value-style extraction only ever produces a ranked candidate list with
  no definitions. The trade-off, unverified here: LLM extraction's
  precision/recall against a held-out domain corpus, and cost per document,
  were not benchmarked in this research pass and would need a real spike
  before committing to this over statistical extraction.

## Feature-tier sketch

**Tier 1 — core professional baseline** (concept-oriented model, usage
statuses, metadata, TBX import/export):
- Add a concept layer above `Term`: a `Concept` row per domain that groups
  one `Term` per language, so an EN/DE/FR/etc. term set for "the same
  thing" is explicitly linked rather than three unrelated rows — the
  direct fix for §1's "no concept anchor" gap and the ISO 704 §2 principle.
- Replace the binary preferred/forbidden model with a proper usage-status
  enum (Preferred / Admitted / Deprecated / Forbidden, per §2's ISO 12620
  values) on each per-variant row, not just on the term as a whole —
  `forbidden_variants: list[str]` becomes a list of (variant, status) pairs.
- Add `context` (example sentence) and `source` (citation) fields alongside
  the existing `definition` — both are standard TBX-Basic data categories
  and were named explicitly in the TerminOrgs starter-guide checklist.
- Add a `part_of_speech` field per term — cheap to add to the schema, and
  the spaCy pipelines already loaded for CJK/matching (§4) can populate it
  automatically for most languages rather than requiring manual entry.
- Build TBX-Basic import/export (§2 recommends this dialect specifically)
  on top of the new concept/status/metadata fields — this is the
  single feature every professional tool researched in §3 supports and
  ours entirely lacks, and it's what would let a customer bring an
  existing corporate termbase in, or take ours out.
- Map usage status onto `Finding.severity` in the checker (§4) — Forbidden
  → error, Deprecated → warning, Admitted → suggestion (or no finding,
  configurable) — a small, high-leverage change once status exists.

**Tier 2 — workflow/governance** (proposal, approval, roles, history):
- Add a draft/pending state to `Term`/`Concept` writes, so a non-admin
  contributor can propose a term without it going live immediately — the
  gap §1 and §3 both flag as our starkest deviation from every dedicated
  TMS tool researched (qTerm's 4 roles, Quickterm's 5).
- Add an approver role distinct from "owns the domain" — today any domain
  owner's write is unconditional; a real workflow needs someone who can
  approve *someone else's* proposal within a shared/team domain.
- Add an audit/history table (who changed what, when) — none of our
  current tables carry this, and it's table-stakes in every dedicated TMS
  reviewed (§3's Quickterm/TermWeb "workflow and administration"
  framing).
- Extend the existing `custom_domains` feature-gate model (already present
  in `backend/app/core/permissions.py`-driven `features_for`) with a
  parallel gate for proposal/approval, so this tier can ship as a paid-tier
  differentiator rather than a all-users change.
- Periodic-review/staleness surfacing (TerminOrgs' "review terminology
  periodically for relevance") — a simple "not reviewed since" flag on a
  term, surfaced in the management UI, would satisfy this cheaply.

**Tier 3 — advanced** (morphology-aware enforcement, cross-references,
term extraction):
- Morphology-aware matching for German/other inflecting languages: stop
  excluding the tagger/lemmatizer in `NlpRegistry`'s CJK/matching path
  (§4) and match on lemma rather than exact token where a language's
  pipeline supports it — directly buildable on infrastructure that already
  exists, not a new dependency.
- German compound handling specifically needs one new lightweight
  dependency — **CharSplit** (§4) is the practitioner-standard choice — since
  spaCy's own German pipeline has no decompounder; GiNZA already
  demonstrates the "compound-splitter as a pipeline component" pattern for
  Japanese in our own `NlpRegistry`, but nothing equivalent ships for
  German.
- Cross-references between concepts (synonym/related/see-also, per
  MultiTerm's model in §3) — natural once Tier 1's `Concept` layer exists;
  a `related_concept_ids` field on `Concept` with a typed relation.
- Subject-field classification against a controlled vocabulary rather than
  free-text `Domain.name` (IATE/EuroVoc pattern, §3) — a bigger scope
  question (do we adopt/mirror an existing taxonomy, or define our own?)
  best treated as a separate research spike, not bundled into this tier.
- LLM-based term-candidate extraction from a user's own corpus (§5),
  reusing `backend/app/checkers/llm/` infrastructure rather than building a
  statistical-NLP pipeline from scratch — the most "distinguishing feature"
  candidate of this whole tier, since it would let us extract *and*
  auto-draft definitions in one LLM call, something none of the classic
  vendor extraction tools (MultiTerm Extract, memoQ) do.
